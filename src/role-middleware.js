const db = require('./db');
const { hasRoleOrAbove } = require('./roles');

/**
 * requireRole(minimumRole)
 *
 * Must run AFTER requireAuth (which sets req.matrixUserId).
 *
 * - Looks up the enterprise_users row for the authenticated Matrix user
 * - Attaches req.enterpriseUser = { id, role, tenant_id, status }
 * - Returns 403 if role is below minimumRole
 * - Returns 403 if user status is not 'active'
 */
function requireRole(minimumRole) {
  return async (req, res, next) => {
    try {
      const result = await db.query(
        `SELECT id, role, tenant_id, status
           FROM enterprise_users
          WHERE matrix_user_id = $1`,
        [req.matrixUserId]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'User not found in enterprise directory' });
      }

      const user = result.rows[0];

      if (user.status !== 'active') {
        return res.status(403).json({ error: 'Account is inactive' });
      }

      if (!hasRoleOrAbove(user.role, minimumRole)) {
        return res.status(403).json({
          error:    'Insufficient role',
          required: minimumRole,
          actual:   user.role,
        });
      }

      req.enterpriseUser = user; // { id, role, tenant_id, status }
      next();
    } catch (err) {
      console.error('[requireRole] DB error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * requirePermission(permissionName)
 *
 * Fine-grained permission check against the role_permissions table.
 * Must run AFTER requireRole (which sets req.enterpriseUser).
 */
function requirePermission(permissionName) {
  return async (req, res, next) => {
    if (!req.enterpriseUser) {
      return res.status(500).json({ error: 'requireRole must run before requirePermission' });
    }
    try {
      const result = await db.query(
        `SELECT 1 FROM role_permissions WHERE role = $1 AND permission = $2`,
        [req.enterpriseUser.role, permissionName]
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'Permission denied', permission: permissionName });
      }
      next();
    } catch (err) {
      console.error('[requirePermission] DB error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * requireSameTenant
 *
 * Ensures the actor belongs to the same company as the target resource.
 * Super Admin always bypasses this check (platform-wide access).
 *
 * The route must set req.targetTenantId before this middleware runs.
 */
function requireSameTenant(req, res, next) {
  if (req.enterpriseUser.role === 'super_admin') return next();
  if (!req.targetTenantId) {
    return res.status(500).json({ error: 'targetTenantId not set by route handler' });
  }
  if (req.enterpriseUser.tenant_id !== req.targetTenantId) {
    return res.status(403).json({ error: 'Access denied: cross-company action not allowed' });
  }
  next();
}

module.exports = { requireRole, requirePermission, requireSameTenant };
