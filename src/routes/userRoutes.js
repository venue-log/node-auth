const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateHandler } = require('../middleware/auth');
const { upload } = require('../middleware/fileUpload');
const { csrfProtection } = require('../middleware/csrf');

// User management routes
router.post('/', 
  authenticateHandler,
  validate(createUserSchema),
  csrfProtection,
  rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10 // 10 requests per hour
  }),
  (req, res, next) => {
    req.route = { scopes: ['users:write'] };
    next();
  },
  userController.create
);
router.get('/', authenticateHandler, userController.list);
router.get('/:id', authenticateHandler, userController.get);
router.put('/:id', authenticateHandler, userController.update);
router.delete('/:id', authenticateHandler, userController.delete);

// User search and filtering
router.get('/search', authenticateHandler, userController.search);

// Bulk operations
router.post('/bulk/update', authenticateHandler, userController.bulkUpdate);

// Status management
router.put('/:id/status', authenticateHandler, userController.updateStatus);

// Role and permission management
router.put('/:id/roles', authenticateHandler, userController.assignRoles);
router.put('/:id/permissions', authenticateHandler, userController.updatePermissions);

// Activity monitoring
router.get('/:id/activity', 
  authenticateHandler,
  (req, res, next) => {
    req.route = { scopes: ['users:activity:read'] };
    next();
  }, 
  userController.getActivity
);

// Account deactivation
router.post('/:id/deactivate', authenticateHandler, userController.deactivate);

// Profile management
router.get('/:id/profile', authenticateHandler, userController.getProfile);
router.put('/:id/profile', 
  authenticateHandler,
  upload.single('avatar'),
  userController.update
);

// Account settings
router.get('/:id/preferences', authenticateHandler, userController.getPreferences);
router.put('/:id/preferences', authenticateHandler, userController.updatePreferences);

// Email preferences
router.get('/:id/email-preferences', authenticateHandler, userController.getEmailPreferences);
router.put('/:id/email-preferences', authenticateHandler, userController.updateEmailPreferences);

// Password management
router.post('/:id/change-password', authenticateHandler, userController.changePassword);
router.post('/:id/reset-password', userController.requestPasswordReset);
router.post('/:id/reset-password/confirm', userController.confirmPasswordReset);

// Activity and audit history
router.get('/:id/activity', authenticateHandler, userController.getActivityHistory);
router.get('/:id/login-history', authenticateHandler, userController.getLoginHistory);
router.get('/:id/audit-history', authenticateHandler, userController.getAuditHistory);

// User's tenants
router.get('/:id/tenants', authenticateHandler, userController.getTenants);

module.exports = router;
