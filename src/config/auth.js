const OAuth2Server = require('oauth2-server');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');

// Rate limiting configuration
// Brute force protection for login attempts
const passkeyRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour
  message: 'Too many passkey registration attempts, please try again later',
  handler: async (req, res) => {
    await SecurityAuditLog.create({
      userId: req.user?.id,
      event: 'PASSKEY_REGISTRATION_RATE_LIMIT',
      severity: 'high',
      details: {
        ip: req.ip
      }
    });
    res.status(429).json({ 
      error: 'Too many registration attempts',
      retryAfter: req.rateLimit.resetTime
    });
  },
  keyGenerator: (req) => `${req.user?.id || req.ip}:passkey-registration`
});

const twoFactorFailedAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per IP
  message: 'Too many failed 2FA attempts, please try again later',
  handler: async (req, res) => {
    await SecurityAuditLog.create({
      userId: req.user?.id,
      event: 'TWO_FACTOR_RATE_LIMIT',
      severity: 'high',
      details: {
        ip: req.ip,
        attempts: 5
      }
    });
    res.status(429).json({ 
      error: 'Too many failed attempts',
      retryAfter: req.rateLimit.resetTime
    });
  },
  keyGenerator: (req) => `${req.ip}:2fa-attempts`
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts per window
  message: 'Too many login attempts, please try again later',
  handler: async (req, res, next) => {
    const { email } = req.body;
    if (email) {
      const user = await User.findOne({ where: { email } });
      if (user) {
        const failedAttempts = user.failedLoginAttempts + 1;
        await user.update({ 
          failedLoginAttempts,
          accountLockedUntil: failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
        });
      }
    }
    res.status(429).json({ 
      error: 'Too many login attempts',
      retryAfter: req.rateLimit.resetTime
    });
  },
  store: new RedisStore({
    prefix: 'login_limit:',
    sendCommand: (...args) => manager.getRedisClient().then(client => client.sendCommand(args))
  }),
  keyGenerator: (req) => `${req.body.email || req.ip}:login`
});

// General API rate limiting
const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 attempts per hour
  message: 'Too many password reset attempts, please try again later',
  keyGenerator: (req) => `${req.body.email || req.ip}:password-reset`
});

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    prefix: 'api_limit:',
    sendCommand: (...args) => manager.getRedisClient().then(client => client.sendCommand(args))
  }),
  keyGenerator: (req) => {
    // Include tenant ID in rate limiting key if available
    const tenantId = req.headers['x-tenant'] || 'global';
    return `${tenantId}:${req.ip}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: req.rateLimit.resetTime
    });
  }
});
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const { User, OAuthClient, OAuthToken } = require('../models');

// OAuth2 Server Model
const oauth2Model = {
  // Required for Password Grant
  getClient: async (clientId, clientSecret) => {
    const client = await OAuthClient.findOne({
      where: { clientId }
    });
    
    if (!client || (clientSecret && client.clientSecret !== clientSecret)) {
      return false;
    }
    
    return {
      id: client.id,
      grants: client.grants,
      redirectUris: client.redirectUris
    };
  },

  // Required for Password Grant
  getUser: async (username, password) => {
    const user = await User.findOne({
      where: { email: username }
    });

    if (!user) return false;

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return false;

    return user;
  },

  // Required for Password Grant and Client Credentials
  saveToken: async (token, client, user) => {
    // Get user roles and associated scopes
    const roles = await user.getRoles();
    const scopes = roles.reduce((acc, role) => {
      return [...new Set([...acc, ...role.scopes])];
    }, []);

    const accessToken = await OAuthToken.create({
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      clientId: client.id,
      userId: user ? user.id : null,
      scopes
    });

    return {
      ...accessToken,
      client,
      user,
      scopes
    };
  },

  // Required for Authentication
  getAccessToken: async (accessToken) => {
    const token = await OAuthToken.findOne({
      where: { accessToken },
      include: [
        { model: OAuthClient, as: 'client' },
        { model: User, as: 'user' }
      ]
    });

    if (!token) return false;

    return token;
  },

  // Required for Refresh Token Grant
  getRefreshToken: async (refreshToken) => {
    return await OAuthToken.findOne({
      where: { refreshToken },
      include: [
        { model: OAuthClient, as: 'client' },
        { model: User, as: 'user' }
      ]
    });
  },

  // Required for Refresh Token Grant
  revokeToken: async (token) => {
    await OAuthToken.destroy({
      where: { refreshToken: token.refreshToken }
    });
    return true;
  }
};

// OAuth2 Server Configuration
const oauth2Server = new OAuth2Server({
  model: oauth2Model,
  accessTokenLifetime: 60 * 60, // 1 hour
  refreshTokenLifetime: 60 * 60 * 24 * 14, // 14 days
  allowBearerTokensInQueryString: true,
  requireClientAuthentication: {
    authorization_code: true,
    refresh_token: true
  },
  // Require PKCE for public clients
  requirePKCE: true,
  // Allow both S256 and plain challenges (but prefer S256)
  allowedPKCEMethods: ['S256', 'plain']
});

// Passport Configuration
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// Local Strategy
passport.use(new LocalStrategy(
  { usernameField: 'email' },
  async (email, password, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return done(null, false, { message: 'Invalid credentials' });

      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return done(null, false, { message: 'Invalid credentials' });

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

// Google Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await prisma.user.findFirst({
        where: { 
          OR: [
            { googleId: profile.id },
            { email: profile.emails[0].value }
          ]
        }
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            email: profile.emails[0].value,
            googleId: profile.id,
            name: profile.displayName,
            avatar: profile.photos[0].value
          }
        });
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

module.exports = {
  oauth2Server,
  passport
};
