const { User, Tenant, TenantUser } = require('../models');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3 } = require('../middleware/fileUpload');
const bcrypt = require('bcrypt');
const { AppError } = require('../middleware/errorHandler');
const validate = require('../middleware/validate');
const { 
  createUserSchema, 
  updateUserSchema, 
  changePasswordSchema 
} = require('../validations/userValidations');

class UserController {
  static async getValidations(tenantId) {
    return {
      create: validate(await createUserSchema(tenantId)),
      update: validate(updateUserSchema),
      changePassword: validate(await changePasswordSchema(tenantId)),
      search: validate(searchUserSchema),
      bulkUpdate: validate(bulkUpdateSchema)
    };
  }

  async _sanitizeUserInput(input) {
    const { email, password, name, avatar } = input;
    return {
      email: validator.escape(email.trim()),
      password,
      name: validator.escape(name.trim()),
      avatar: avatar ? validator.escape(avatar.trim()) : null
    };
  }

  async _createUserRecord(input, transaction) {
    const { email, password, name, avatar } = input;
    
    const existingUser = await User.findOne({ 
      where: { email },
      transaction 
    });
    
    if (existingUser) {
      throw new AppError('User already exists', 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    return User.create({
      email,
      password: hashedPassword,
      name,
      avatar,
      profile: {
        timezone: 'UTC',
        language: 'en'
      },
      preferences: {
        theme: 'light',
        notifications: {
          email: true,
          push: true,
          sms: false
        }
      }
    }, { transaction });
  }

  async _generateVerificationToken(user, transaction) {
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    await user.update({
      verificationToken,
      verificationTokenExpires: verificationExpires
    }, { transaction });

    return verificationToken;
  }

  async _createAuditLog(user, requestUser, transaction) {
    await SecurityAuditLog.create({
      userId: user.id,
      event: 'USER_CREATED',
      details: {
        createdBy: requestUser?.id || 'system',
        method: 'manual'
      },
      severity: 'medium'
    }, { transaction });
  }

  async _sendNotifications(user) {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${user.verificationToken}`;
    
    return Promise.all([
      emailService.sendVerificationEmail(user.email, user.name, verificationUrl),
      emailService.sendWelcomeEmail(user.email, user.name),
      slackService.sendMessage({
        channel: '#user-activity',
        text: `New user created: ${user.email}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*New User Created*\nEmail: ${user.email}\nName: ${user.name}`
            }
          }
        ]
      })
    ]);
  }

  _formatUserResponse(user, impersonator) {
    const response = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      status: user.status
    };

    if (impersonator) {
      response.isImpersonated = true;
      response.impersonator = {
        id: impersonator.id,
        email: impersonator.email,
        name: impersonator.name
      };
    }

    return response;
  }

  // Search users with filtering
  async list(req, res) {
    try {
      const { 
        page = 1,
        limit = 20,
        sortBy = 'createdAt',
        sortOrder = 'DESC',
        status,
        role,
        search
      } = req.query;

      const where = {};
      
      if (status) {
        where.status = status;
      }

      if (search) {
        where[Op.or] = [
          { email: { [Op.iLike]: `%${search}%` } },
          { name: { [Op.iLike]: `%${search}%` } }
        ];
      }

      const include = [];
      if (role) {
        include.push({
          model: Role,
          where: { name: role },
          through: { attributes: [] }
        });
      }

      const users = await User.findAndCountAll({
        where,
        include,
        order: [[sortBy, sortOrder]],
        limit: parseInt(limit),
        offset: (page - 1) * limit,
        attributes: { 
          exclude: ['password', 'resetToken', 'verificationToken']
        }
      });

      // Generate signed URLs for avatars
      const usersWithSignedUrls = await Promise.all(users.rows.map(async (user) => {
        const userData = user.toJSON();
        if (userData.avatar) {
          userData.avatarUrl = await getSignedUrl(s3, new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: userData.avatar
          }), { expiresIn: 24 * 60 * 60 });
        }
        return userData;
      }));

      res.json({
        users: usersWithSignedUrls,
        total: users.count,
        page: parseInt(page),
        totalPages: Math.ceil(users.count / limit)
      });
    } catch (error) {
      logger.error('User listing failed:', error);
      next(new AppError(error.message, 400));
    }
  }

  async search(req, res) {
    try {
      const { 
        query, 
        status, 
        role, 
        tenant,
        lastLoginStart,
        lastLoginEnd,
        page = 1,
        limit = 20,
        sortBy = 'createdAt',
        sortOrder = 'DESC'
      } = req.query;

      const where = {};
      
      if (query) {
        where[Op.or] = [
          { email: { [Op.iLike]: `%${query}%` } },
          { name: { [Op.iLike]: `%${query}%` } }
        ];
      }
      
      if (status) where.status = status;
      if (tenant) where.tenantId = tenant;
      
      if (lastLoginStart || lastLoginEnd) {
        where.lastLoginAt = {};
        if (lastLoginStart) where.lastLoginAt[Op.gte] = new Date(lastLoginStart);
        if (lastLoginEnd) where.lastLoginAt[Op.lte] = new Date(lastLoginEnd);
      }

      const users = await User.findAndCountAll({
        where,
        include: [{
          model: Role,
          where: role ? { name: role } : undefined,
          required: !!role
        }],
        order: [[sortBy, sortOrder]],
        limit,
        offset: (page - 1) * limit,
        attributes: { exclude: ['password'] }
      });

      // Generate signed URLs for avatars
      const usersWithSignedUrls = await Promise.all(users.rows.map(async (user) => {
        const userData = user.toJSON();
        if (userData.avatar) {
          userData.avatarUrl = await getSignedUrl(s3, new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: userData.avatar
          }), { expiresIn: 24 * 60 * 60 });
        }
        return userData;
      }));

      res.json({
        users: usersWithSignedUrls,
        total: users.count,
        page,
        totalPages: Math.ceil(users.count / limit)
      });
    } catch (error) {
      next(new AppError(error.message, 400));
    }
  }

  // Bulk operations
  async bulkUpdate(req, res) {
    const { userIds, updates } = req.body;
    const t = await sequelize.transaction();

    try {
      const users = await User.update(updates, {
        where: { id: userIds },
        transaction: t
      });

      await ActivityLog.bulkCreate(userIds.map(userId => ({
        userId,
        action: 'BULK_UPDATE',
        details: updates
      })), { transaction: t });

      await t.commit();
      res.json({ updated: users[0] });
    } catch (error) {
      await t.rollback();
      next(new AppError(error.message, 400));
    }
  }

  // Status management
  async updateStatus(req, res) {
    const { userId } = req.params;
    const { status, reason } = req.body;

    try {
      const user = await User.findByPk(userId);
      if (!user) throw new AppError('User not found', 404);

      await user.update({ 
        status,
        statusReason: reason,
        statusChangedAt: new Date(),
        statusChangedBy: req.user.id
      });

      await ActivityLog.create({
        userId,
        action: 'STATUS_CHANGE',
        details: { status, reason }
      });

      res.json(user);
    } catch (error) {
      next(new AppError(error.message, 400));
    }
  }

  // Role assignment
  async assignRoles(req, res) {
    try {
      const { userId } = req.params;
      const { roleIds } = req.body;

      const roles = await roleService.assignRolesToUser(
        userId, 
        roleIds,
        req.user.id
      );

      res.json({ 
        message: 'Roles assigned successfully',
        roles: roles.map(r => ({
          id: r.id,
          name: r.name,
          scopes: r.scopes
        }))
      });
    } catch (error) {
      await t.rollback();
      next(new AppError(error.message, 400));
    }
  }

  // Permission management
  async updatePermissions(req, res) {
    const { userId } = req.params;
    const { permissions } = req.body;
    const t = await sequelize.transaction();

    try {
      const user = await User.findByPk(userId);
      if (!user) throw new AppError('User not found', 404);

      await UserPermission.destroy({ 
        where: { userId },
        transaction: t
      });

      await UserPermission.bulkCreate(
        permissions.map(permissionId => ({ userId, permissionId })),
        { transaction: t }
      );

      await ActivityLog.create({
        userId,
        action: 'PERMISSION_UPDATE',
        details: { permissions }
      }, { transaction: t });

      await t.commit();
      res.json({ message: 'Permissions updated successfully' });
    } catch (error) {
      await t.rollback();
      next(new AppError(error.message, 400));
    }
  }

  // Activity monitoring
  async getAuditHistory(req, res) {
    try {
      const { 
        startDate, 
        endDate, 
        severity,
        event,
        page,
        limit,
        sortOrder 
      } = req.query;

      const auditHistory = await securityAuditService.getUserAuditHistory(
        req.params.id,
        {
          startDate,
          endDate,
          severity,
          event,
          page: parseInt(page),
          limit: parseInt(limit),
          sortOrder
        }
      );

      res.json(auditHistory);
    } catch (error) {
      logger.error('Audit history retrieval failed:', error);
      next(new AppError(error.message, 400));
    }
  }

  async getLoginHistory(req, res) {
    try {
      const { 
        startDate, 
        endDate, 
        status,
        page = 1, 
        limit = 20,
        sortOrder = 'DESC'
      } = req.query;

      const where = { userId: req.params.id };
      
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt[Op.gte] = new Date(startDate);
        if (endDate) where.createdAt[Op.lte] = new Date(endDate);
      }

      if (status) where.status = status;

      const loginHistory = await LoginHistory.findAndCountAll({
        where,
        order: [['createdAt', sortOrder]],
        limit: parseInt(limit),
        offset: (page - 1) * limit
      });

      res.json({
        history: loginHistory.rows,
        total: loginHistory.count,
        page: parseInt(page),
        totalPages: Math.ceil(loginHistory.count / limit)
      });
    } catch (error) {
      logger.error('Login history retrieval failed:', error);
      next(new AppError(error.message, 400));
    }
  }

  async getActivity(req, res) {
    const { userId } = req.params;
    const { startDate, endDate, type, page = 1, limit = 20 } = req.query;

    try {
      const where = { userId };
      
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt[Op.gte] = new Date(startDate);
        if (endDate) where.createdAt[Op.lte] = new Date(endDate);
      }
      
      if (type) where.action = type;

      const logs = await ActivityLog.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit,
        offset: (page - 1) * limit
      });

      res.json({
        logs: logs.rows,
        total: logs.count,
        page,
        totalPages: Math.ceil(logs.count / limit)
      });
    } catch (error) {
      next(new AppError(error.message, 400));
    }
  }

  // Account deactivation
  async deactivate(req, res) {
    const { userId } = req.params;
    const { reason } = req.body;
    const t = await sequelize.transaction();

    try {
      const user = await User.findByPk(userId);
      if (!user) throw new AppError('User not found', 404);

      await user.update({
        status: 'inactive',
        deactivatedAt: new Date(),
        deactivatedBy: req.user.id,
        deactivationReason: reason
      }, { transaction: t });

      // Revoke all sessions
      await OAuthToken.destroy({
        where: { userId },
        transaction: t
      });

      await ActivityLog.create({
        userId,
        action: 'ACCOUNT_DEACTIVATED',
        details: { reason }
      }, { transaction: t });

      await t.commit();
      res.json({ message: 'Account deactivated successfully' });
    } catch (error) {
      await t.rollback();
      next(new AppError(error.message, 400));
    }
  }
  // Create a new user
  async create(req, res) {
    const t = await sequelize.transaction();
    try {
      const sanitizedInput = this._sanitizeUserInput(req.body);
      const user = await this._createUserRecord(sanitizedInput, t);
      await this._generateVerificationToken(user, t);
      await this._createAuditLog(user, req.user, t);
      await this._sendNotifications(user);
      
      await t.commit();
      res.status(201).json(this._formatUserResponse(user, req.impersonator));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Get user details with profile and activity
  async get(req, res) {
    try {
      const user = await User.findByPk(req.params.id, {
        include: [{
          model: Tenant,
          through: { attributes: ['roles'] }
        }, {
          model: LoginHistory,
          limit: 5,
          order: [['createdAt', 'DESC']]
        }, {
          model: ActivityLog,
          limit: 10,
          order: [['createdAt', 'DESC']]
        }],
        attributes: { 
          exclude: ['password'],
          include: [
            'profile',
            'preferences',
            'emailPreferences',
            'lastActivity'
          ]
        }
      });
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Generate fresh signed URL if avatar exists
      if (user.avatar) {
        user.avatarUrl = await getSignedUrl(s3, new GetObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: user.avatar
        }), { expiresIn: 24 * 60 * 60 });
      }

      res.json(user);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Update user
  async update(req, res) {
    try {
      const { name } = req.body;
      const user = await User.findByPk(req.params.id);
      
      const updates = { name };

      // Handle avatar upload if present
      if (req.file) {
        const { key, signedUrl } = await uploadToS3(req.file, 'avatars', 24 * 60 * 60); // 24 hour signed URL
        updates.avatar = key;
        updates.avatarUrl = signedUrl;
      }
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await user.update(updates);

      const updatedUser = await User.findByPk(user.id, {
        attributes: { exclude: ['password'] }
      });

      // Generate fresh signed URL if avatar exists
      if (updatedUser.avatar) {
        updatedUser.avatarUrl = await getSignedUrl(s3, new GetObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: updatedUser.avatar
        }), { expiresIn: 24 * 60 * 60 });
      }

      res.json(updatedUser);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Delete user
  async delete(req, res) {
    const t = await sequelize.transaction();
    try {
      const userId = req.params.id;
      const deleterId = req.user.id;
      
      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if user is last admin in any tenants
      const tenantAdmins = await TenantUser.findAll({
        where: {
          userId,
          roles: { [Op.contains]: ['admin'] }
        },
        include: [Tenant],
        transaction: t
      });

      for (const tenantAdmin of tenantAdmins) {
        const adminCount = await TenantUser.count({
          where: {
            tenantId: tenantAdmin.tenantId,
            roles: { [Op.contains]: ['admin'] }
          },
          transaction: t
        });

        if (adminCount === 1) {
          await t.rollback();
          return res.status(400).json({ 
            error: `Cannot delete user - they are the last admin for tenant ${tenantAdmin.Tenant.name}`
          });
        }
      }

      // Soft delete user
      await user.update({
        status: 'deleted',
        deletedAt: new Date(),
        deletedBy: deleterId
      }, { transaction: t });

      // Revoke all active sessions
      await OAuthToken.update(
        { revoked: true },
        { where: { userId } },
        { transaction: t }
      );

      // Create audit log
      await SecurityAuditLog.create({
        userId: deleterId,
        event: 'USER_DELETED',
        details: {
          deletedUserId: userId,
          email: user.email,
          tenants: tenantAdmins.map(t => t.tenantId)
        },
        severity: 'high'
      }, { transaction: t });

      // Notify tenant admins
      const tenantIds = tenantAdmins.map(t => t.tenantId);
      const tenantAdminsToNotify = await TenantUser.findAll({
        where: {
          tenantId: { [Op.in]: tenantIds },
          roles: { [Op.contains]: ['admin'] }
        },
        include: [User],
        transaction: t
      });

      await Promise.all(tenantAdminsToNotify.map(admin => 
        notificationService.sendEmail({
          to: admin.User.email,
          subject: `User ${user.email} deleted`,
          template: 'user-deleted',
          context: {
            name: admin.User.name,
            deletedUser: user.email,
            deletedBy: req.user.email,
            date: new Date().toLocaleDateString()
          }
        })
      ));

      await t.commit();
      res.status(204).send();
    } catch (error) {
      await t.rollback();
      res.status(400).json({ error: error.message });
    }
  }

  // Change password
  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;
      const user = await User.findByPk(req.params.id);
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const validPassword = await bcrypt.compare(currentPassword, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid current password' });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await user.update({ password: hashedPassword });

      res.status(200).json({ message: 'Password updated successfully' });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Get user's tenants
  async getTenants(req, res) {
    try {
      const user = await User.findByPk(req.params.id, {
        include: [{
          model: Tenant,
          through: { attributes: ['roles'] }
        }]
      });
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(user.Tenants);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
}

module.exports = new UserController();
