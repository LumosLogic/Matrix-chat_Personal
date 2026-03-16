const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { requireAuth }                                       = require('./auth-middleware');
const { requireRole, requirePermission, requireSameTenant } = require('./role-middleware');
const { ROLES, hasRoleOrAbove }                             = require('./roles');

// ── GET /api/roles/me ─────────────────────────────────────────────────────────
// Every active user can call this to get their own role, tenant, and status.
router.get('/me', requireAuth, requireRole(ROLES.USER), (req, res) => {
  res.json({ user: req.enterpriseUser });
});

// ── GET /api/roles/users ──────────────────────────────────────────────────────
// Super Admin: all users on the platform.
// Admin: all users in their company only.
router.get('/users', requireAuth, requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    let result;
    if (req.enterpriseUser.role === ROLES.SUPER_ADMIN) {
      result = await db.query(
        `SELECT id, email, full_name, role, tenant_id, status, created_at
           FROM enterprise_users
          ORDER BY tenant_id, created_at DESC`
      );
    } else {
      result = await db.query(
        `SELECT id, email, full_name, role, tenant_id, status, created_at
           FROM enterprise_users
          WHERE tenant_id = $1
          ORDER BY created_at DESC`,
        [req.enterpriseUser.tenant_id]
      );
    }
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/roles/users/:userId/role ───────────────────────────────────────
// Change a user's role.
// Rules:
// - Super Admin can change anyone's role (except another super_admin)
// - Admin can only change agent ↔ user within their own company
// - Admin cannot promote to super_admin
// - No one can change their own role
router.patch('/users/:userId/role',
  requireAuth,
  requireRole(ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const r = await db.query(
        `SELECT tenant_id FROM enterprise_users WHERE id = $1`,
        [req.params.userId]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      req.targetTenantId = r.rows[0].tenant_id;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
  requireSameTenant,
  async (req, res) => {
    const { userId }   = req.params;
    const { new_role } = req.body;
    const actor        = req.enterpriseUser;

    if (!Object.values(ROLES).includes(new_role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${Object.values(ROLES).join(', ')}` });
    }

    try {
      const targetResult = await db.query(
        `SELECT id, matrix_user_id, role FROM enterprise_users WHERE id = $1`,
        [userId]
      );
      if (targetResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const target = targetResult.rows[0];

      // Cannot change your own role
      if (target.matrix_user_id === req.matrixUserId) {
        return res.status(403).json({ error: 'Cannot change your own role' });
      }

      // Admin cannot assign super_admin
      if (actor.role === ROLES.ADMIN && new_role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Admin cannot assign super_admin role' });
      }

      // Admin cannot touch a super_admin
      if (actor.role === ROLES.ADMIN && target.role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Admin cannot modify a Super Admin' });
      }

      // Super Admin cannot change another super_admin
      if (actor.role === ROLES.SUPER_ADMIN && target.role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Cannot change the role of another Super Admin' });
      }

      await db.query(
        `UPDATE enterprise_users SET role = $1, updated_at = NOW() WHERE id = $2`,
        [new_role, userId]
      );

      await db.query(
        `INSERT INTO audit_logs (action, actor, target) VALUES ('ROLE_CHANGED', $1, $2)`,
        [req.matrixUserId, `${target.matrix_user_id}: ${target.role} → ${new_role}`]
      );

      res.json({ success: true, user_id: userId, new_role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PATCH /api/roles/users/:userId/status ─────────────────────────────────────
// Activate or deactivate a user.
// Super Admin: anyone except another super_admin.
// Admin: agents and users within their own company only.
router.patch('/users/:userId/status',
  requireAuth,
  requireRole(ROLES.ADMIN),
  async (req, res, next) => {
    try {
      const r = await db.query(
        `SELECT tenant_id FROM enterprise_users WHERE id = $1`,
        [req.params.userId]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      req.targetTenantId = r.rows[0].tenant_id;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
  requireSameTenant,
  async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;
    const actor      = req.enterpriseUser;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'status must be "active" or "inactive"' });
    }

    try {
      const targetResult = await db.query(
        `SELECT id, matrix_user_id, role FROM enterprise_users WHERE id = $1`,
        [userId]
      );
      if (targetResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const target = targetResult.rows[0];

      if (actor.role === ROLES.ADMIN && target.role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Admin cannot deactivate a Super Admin' });
      }

      if (actor.role === ROLES.SUPER_ADMIN && target.role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Cannot deactivate another Super Admin' });
      }

      await db.query(
        `UPDATE enterprise_users SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, userId]
      );

      const action = status === 'inactive' ? 'USER_DEACTIVATED' : 'USER_REACTIVATED';
      await db.query(
        `INSERT INTO audit_logs (action, actor, target) VALUES ($1, $2, $3)`,
        [action, req.matrixUserId, target.matrix_user_id]
      );

      res.json({ success: true, user_id: userId, status });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/roles/audit-logs ─────────────────────────────────────────────────
// Super Admin: all logs across all companies.
// Admin: all logs for their company.
// Agent: their own actions only.
router.get('/audit-logs', requireAuth, requireRole(ROLES.AGENT), async (req, res) => {
  try {
    let result;
    if (req.enterpriseUser.role === ROLES.SUPER_ADMIN) {
      result = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500`);
    } else if (req.enterpriseUser.role === ROLES.ADMIN) {
      result = await db.query(
        `SELECT al.*
           FROM audit_logs al
           JOIN enterprise_users eu ON al.actor = eu.matrix_user_id
          WHERE eu.tenant_id = $1
          ORDER BY al.created_at DESC LIMIT 200`,
        [req.enterpriseUser.tenant_id]
      );
    } else {
      // Agent: own actions only
      result = await db.query(
        `SELECT * FROM audit_logs WHERE actor = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.matrixUserId]
      );
    }
    res.json({ logs: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/roles/companies ──────────────────────────────────────────────────
// Super Admin only — list all companies on the platform.
router.get('/companies', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, COUNT(eu.id) AS user_count
         FROM companies c
         LEFT JOIN enterprise_users eu ON eu.tenant_id = c.tenant_id
        GROUP BY c.id
        ORDER BY c.created_at DESC`
    );
    res.json({ companies: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/roles/companies ─────────────────────────────────────────────────
// Super Admin only — create a new company/tenant.
router.post('/companies', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  const { name, tenant_id } = req.body;
  if (!name || !tenant_id) {
    return res.status(400).json({ error: 'name and tenant_id are required' });
  }
  try {
    const result = await db.query(
      `INSERT INTO companies (name, tenant_id) VALUES ($1, $2) RETURNING *`,
      [name, tenant_id]
    );
    await db.query(
      `INSERT INTO audit_logs (action, actor, target) VALUES ('COMPANY_CREATED', $1, $2)`,
      [req.matrixUserId, tenant_id]
    );
    res.status(201).json({ company: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A company with this tenant_id already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/roles/companies/:tenantId/status ───────────────────────────────
// Super Admin only — activate or deactivate an entire company.
router.patch('/companies/:tenantId/status', requireAuth, requireRole(ROLES.SUPER_ADMIN), async (req, res) => {
  const { tenantId } = req.params;
  const { status }   = req.body;

  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "inactive"' });
  }

  try {
    await db.query(
      `UPDATE companies SET status = $1, updated_at = NOW() WHERE tenant_id = $2`,
      [status, tenantId]
    );
    await db.query(
      `INSERT INTO audit_logs (action, actor, target) VALUES ($1, $2, $3)`,
      [status === 'inactive' ? 'COMPANY_DEACTIVATED' : 'COMPANY_REACTIVATED', req.matrixUserId, tenantId]
    );
    res.json({ success: true, tenant_id: tenantId, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
