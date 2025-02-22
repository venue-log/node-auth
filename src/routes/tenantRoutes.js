const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const { authenticateHandler } = require('../middleware/auth');

// Tenant management routes
router.post('/', authenticateHandler, tenantController.create);
router.get('/:id', authenticateHandler, tenantController.get);
router.put('/:id', authenticateHandler, tenantController.update);
router.post('/:id/suspend', authenticateHandler, tenantController.suspend);
router.delete('/:id', authenticateHandler, tenantController.delete);

// Tenant user management routes
router.post('/:id/users', authenticateHandler, tenantController.addUser);
router.delete('/:id/users/:userId', authenticateHandler, tenantController.removeUser);
router.put('/:id/users/:userId/roles', authenticateHandler, tenantController.updateUserRoles);

module.exports = router;
