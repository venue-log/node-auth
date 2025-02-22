const { Tenant, User, TenantUser } = require('../models');
const { v4: uuidv4 } = require('uuid');

class TenantController {
  // Create a new tenant
  async create(req, res) {
    try {
      const { name, slug = uuidv4(), features = {}, securityPolicy = {} } = req.body;
      
      // Create tenant database
      await manager.createTenantDatabase(slug);

      // Create tenant record
      const tenant = await Tenant.create({
        name,
        slug,
        databaseUrl: `postgres://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${slug}`,
        features,
        securityPolicy,
        onboardingStatus: 'pending'
      });

      // Create admin user relationship
      await TenantUser.create({
        userId: req.user.id,
        tenantId: tenant.id,
        roles: ['admin']
      });

      // Start onboarding process
      await tenantOnboardingService.startOnboarding(tenant.id);

      res.status(201).json({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        onboardingStatus: tenant.onboardingStatus
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Get tenant details
  async get(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id, {
        include: [{
          model: User,
          through: { attributes: ['roles'] }
        }]
      });
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      res.json(tenant);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Update tenant
  async update(req, res) {
    try {
      const { name, features, securityPolicy, status } = req.body;
      const tenant = await Tenant.findByPk(req.params.id);
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      await tenant.update({
        name,
        features,
        securityPolicy,
        status
      });

      res.json(tenant);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Suspend tenant
  async suspend(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      await tenant.update({ status: 'suspended' });
      res.json(tenant);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Delete tenant
  async delete(req, res) {
    try {
      const tenant = await Tenant.findByPk(req.params.id);
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      await tenant.destroy();
      res.status(204).send();
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Add user to tenant
  async addUser(req, res) {
    try {
      const { userId, roles = ['user'] } = req.body;
      const tenant = await Tenant.findByPk(req.params.id);
      
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenantUser = await TenantUser.create({
        userId,
        tenantId: tenant.id,
        roles
      });

      res.status(201).json(tenantUser);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }

  // Remove user from tenant
  async removeUser(req, res) {
    const t = await sequelize.transaction();
    try {
      const { tenantId, userId } = req.params;
      const { confirm = false } = req.body;

      // Get tenant and user details
      const tenant = await Tenant.findByPk(tenantId, { transaction: t });
      const user = await User.findByPk(userId, { transaction: t });
      
      if (!tenant || !user) {
        await t.rollback();
        return res.status(404).json({ error: 'Tenant or user not found' });
      }

      // Check if user is the last admin
      const adminCount = await TenantUser.count({
        where: {
          tenantId,
          roles: { [Op.contains]: ['admin'] }
        },
        transaction: t
      });

      const userRoles = await TenantUser.findOne({
        where: { tenantId, userId },
        transaction: t
      });

      if (!userRoles) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found in tenant' });
      }

      if (userRoles.roles.includes('admin') && adminCount === 1) {
        await t.rollback();
        return res.status(400).json({ 
          error: 'Cannot remove last admin. Assign another admin first.' 
        });
      }

      // Require confirmation
      if (!confirm) {
        await t.rollback();
        return res.status(202).json({
          message: 'Confirmation required',
          user: {
            id: user.id,
            name: user.name,
            email: user.email
          },
          tenant: {
            id: tenant.id,
            name: tenant.name
          }
        });
      }

      // Remove user from tenant
      await TenantUser.destroy({
        where: { tenantId, userId },
        transaction: t
      });

      // Create audit log
      await SecurityAuditLog.create({
        userId: req.user.id,
        event: 'USER_REMOVED_FROM_TENANT',
        details: {
          removedUserId: userId,
          tenantId,
          roles: userRoles.roles
        },
        severity: 'medium'
      }, { transaction: t });

      // Send notification email
      await emailService.sendEmail({
        to: user.email,
        subject: `You've been removed from ${tenant.name}`,
        template: 'user-removed',
        context: {
          name: user.name,
          tenantName: tenant.name,
          removedBy: req.user.name,
          date: new Date().toLocaleDateString()
        }
      });

      await t.commit();
      res.status(204).send();
    } catch (error) {
      await t.rollback();
      res.status(400).json({ error: error.message });
    }
  }

  // Update user roles in tenant
  async updateUserRoles(req, res) {
    try {
      const { roles } = req.body;
      const tenantUser = await TenantUser.findOne({
        where: {
          tenantId: req.params.id,
          userId: req.params.userId
        }
      });

      if (!tenantUser) {
        return res.status(404).json({ error: 'User not found in tenant' });
      }

      await tenantUser.update({ roles });
      res.json(tenantUser);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
}

module.exports = new TenantController();
