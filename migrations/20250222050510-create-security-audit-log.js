'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('SecurityAuditLogs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      event: {
        type: Sequelize.STRING,
        allowNull: false
      },
      details: Sequelize.JSON,
      ipAddress: Sequelize.STRING,
      userAgent: Sequelize.STRING,
      severity: {
        type: Sequelize.ENUM('low', 'medium', 'high', 'critical'),
        defaultValue: 'low'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    await queryInterface.addIndex('SecurityAuditLogs', ['userId']);
    await queryInterface.addIndex('SecurityAuditLogs', ['event']);
    await queryInterface.addIndex('SecurityAuditLogs', ['severity']);
    await queryInterface.addIndex('SecurityAuditLogs', ['createdAt']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('SecurityAuditLogs');
  }
};
