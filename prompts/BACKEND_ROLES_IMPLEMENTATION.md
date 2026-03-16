# Backend Role-Based Access Control (RBAC) — Implementation Prompt

## Context

This is a Node.js + PostgreSQL backend for a **multi-company** secure enterprise chat platform
built on Matrix/Synapse. The codebase lives at `/Users/priyanshupatel/Downloads/matrix-server`.

The platform serves **multiple companies**. Each company is an isolated tenant.
No communication or data leakage between companies is allowed.

Current state:
- `enterprise_users` table has `role TEXT DEFAULT 'user'` column (migration `010_enterprise_users.sql`)
- `requireAdmin` middleware checks a static `ADMIN_API_KEY` header (bot/internal use only)
- `requireAuth` middleware validates a Matrix Bearer token via Synapse `/_matrix/client/v3/account/whoami`
- No role-based route protection exists yet

---

## The Four Roles

```
Super Admin  >  Admin  >  Agent (Trusted User)  >  User
```

| Role constant | DB value | Scope | Who is it |
|---|---|---|---|
| `SUPER_ADMIN` | `'super_admin'` | Platform-wide | Manages ALL companies on the platform |
| `ADMIN` | `'admin'` | Company-level | Full control over their own company only |
| `AGENT` | `'agent'` | Company-level | Trusted User — external sharing privilege (1 per company) |
| `USER` | `'user'` | Company-level | Regular staff members and clients (default role) |

### Role Responsibilities

**Super Admin**
- Owns and operates the entire platform
- Creates and manages companies (tenants)
- Creates the first Admin account for each company
- Can view audit logs across all companies
- Can deactivate any user or company on the platform
- Assigns or changes any user's role across all tenants
- Manages system-level configuration (Synapse, MDM policies)
- Has no restriction to any single company

**Admin** (one or more per company)
- Full access within their own company only — cannot see or touch other companies
- Manages all users in their company (creates, deactivates, promotes anyone to Agent or Admin within the company)
- **Can promote other users to Admin** within their own company (cannot promote to Super Admin)
- Creates invite tokens for new employees and clients
- Views complete audit log for their company
- Manages company settings, folder permissions, BYOD approvals
- Can manage rooms/channels within their company
- **Can share files externally** (WhatsApp, email, etc.) — same as Agent
- **Can export chat history** — same as Agent

**Agent (Trusted User)** (exactly ONE active per company — enforced by DB)
- This is the "Trusted User" defined in the SRS
- Can share files externally (WhatsApp, email, etc.)
- Can export chat history
- Can download files from the company cloud drive
- Can manage members in chat rooms they moderate
- Views their own activity in the audit log
- Cannot manage other users (invite, deactivate, change roles) — that is Admin's job

**User** (staff and clients)
- Default role for every new person added to the company
- Includes both internal staff members and external clients of the company
- Can send and receive messages
- Can upload and view files in folders they have access to
- No admin capabilities, no external sharing, no chat export
- A client User has the same permissions as a staff User at the role level
  (file/room-level restrictions are handled separately at the Matrix room level)

---

## What to Build

### 1. Database Migration — `migrations/012_roles_and_permissions.sql`

```sql
-- Add tenant_id and updated_at to enterprise_users
ALTER TABLE enterprise_users
  ADD COLUMN IF NOT EXISTS tenant_id  TEXT        NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Add CHECK constraint on role
ALTER TABLE enterprise_users
  DROP CONSTRAINT IF EXISTS enterprise_users_role_check;

ALTER TABLE enterprise_users
  ADD CONSTRAINT enterprise_users_role_check
  CHECK (role IN ('super_admin', 'admin', 'agent', 'user'));

-- Migrate any legacy role values
UPDATE enterprise_users
  SET role = 'user'
  WHERE role NOT IN ('super_admin', 'admin', 'agent', 'user');

-- Enforce exactly ONE active Agent (Trusted User) per company
-- SRS rule: "Only one trusted user per company"
CREATE UNIQUE INDEX IF NOT EXISTS one_trusted_user_per_company
  ON enterprise_users (tenant_id)
  WHERE role = 'agent' AND status = 'active';

-- Companies / tenants table
CREATE TABLE IF NOT EXISTS companies (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  tenant_id  TEXT        NOT NULL UNIQUE,
  status     TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role permissions lookup table
CREATE TABLE IF NOT EXISTS role_permissions (
  role        TEXT NOT NULL,
  permission  TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO role_permissions (role, permission) VALUES

  -- Super Admin — full platform control
  ('super_admin', 'manage_companies'),
  ('super_admin', 'manage_all_users'),
  ('super_admin', 'view_all_audit_logs'),
  ('super_admin', 'create_invite'),
  ('super_admin', 'change_any_role'),
  ('super_admin', 'deactivate_any_user'),
  ('super_admin', 'external_sharing'),
  ('super_admin', 'export_chat'),
  ('super_admin', 'manage_mdm_policies'),
  ('super_admin', 'approve_byod'),
  ('super_admin', 'manage_folder_permissions'),
  ('super_admin', 'download_files'),
  ('super_admin', 'upload_files'),
  ('super_admin', 'view_files'),
  ('super_admin', 'send_messages'),

  -- Admin — full company-level control + external sharing (same as Agent)
  ('admin', 'manage_company_users'),
  ('admin', 'view_company_audit_logs'),
  ('admin', 'create_invite'),
  ('admin', 'change_role_within_company'),  -- can promote up to admin, not super_admin
  ('admin', 'deactivate_company_user'),
  ('admin', 'approve_byod'),
  ('admin', 'manage_folder_permissions'),
  ('admin', 'manage_room_members'),
  ('admin', 'external_sharing'),            -- same as Agent
  ('admin', 'export_chat'),                 -- same as Agent
  ('admin', 'download_files'),
  ('admin', 'upload_files'),
  ('admin', 'view_files'),
  ('admin', 'send_messages'),

  -- Agent (Trusted User) — external privilege, no user management
  ('agent', 'external_sharing'),
  ('agent', 'export_chat'),
  ('agent', 'manage_room_members'),
  ('agent', 'download_files'),
  ('agent', 'upload_files'),
  ('agent', 'view_files'),
  ('agent', 'send_messages'),

  -- User — staff and clients baseline
  ('user', 'upload_files'),
  ('user', 'view_files'),
  ('user', 'send_messages')

ON CONFLICT DO NOTHING;

-- Add role column to registration_invites to embed target role in invite token
ALTER TABLE registration_invites
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS role      TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'agent', 'user'));
-- Note: super_admin cannot be created via invite — only manually by platform operators

-- Audit action types reference (no schema change, just documenting):
-- 'INVITE_USED', 'USER_REGISTERED', 'ROLE_CHANGED', 'USER_DEACTIVATED',
-- 'USER_REACTIVATED', 'BYOD_APPROVED', 'EXTERNAL_SHARE', 'COMPANY_CREATED',
-- 'COMPANY_DEACTIVATED'
```

---

### 2. Role Constants — `src/roles.js`

```js
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN:       'admin',
  AGENT:       'agent',
  USER:        'user',
};

// Ordered low → high privilege
const ROLE_HIERARCHY = ['user', 'agent', 'admin', 'super_admin'];

/**
 * Returns true if actorRole is at the same level or above requiredRole.
 */
function hasRoleOrAbove(actorRole, requiredRole) {
  return ROLE_HIERARCHY.indexOf(actorRole) >= ROLE_HIERARCHY.indexOf(requiredRole);
}

module.exports = { ROLES, ROLE_HIERARCHY, hasRoleOrAbove };
```

---

### 3. Auth Middleware — `src/auth-middleware.js`

Extract `requireAuth` and `whoami` from `src/index.js` into this file so all route files can import them cleanly:

```js
const axios       = require('axios');
const SYNAPSE_URL = process.env.SYNAPSE_URL;

async function whoami(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Missing or malformed Authorization header');
    err.status = 401;
    throw err;
  }
  const token = authHeader.slice(7);
  const { data } = await axios.get(
    `${SYNAPSE_URL}/_matrix/client/v3/account/whoami`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return { userId: data.user_id, token };
}

async function requireAuth(req, res, next) {
  try {
    const { userId, token } = await whoami(req.headers.authorization);
    req.matrixUserId = userId;
    req.matrixToken  = token;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

module.exports = { requireAuth, whoami };
```

In `src/index.js`, replace the inline definitions with:
```js
const { requireAuth, whoami } = require('./auth-middleware');
```

---

### 4. Role Middleware — `src/role-middleware.js`

```js
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
 *
 * Usage:
 *   router.patch('/users/:id/role',
 *     requireAuth,
 *     requireRole('admin'),
 *     async (req, res, next) => {
 *       // set req.targetTenantId from the target user's tenant_id
 *       const r = await db.query('SELECT tenant_id FROM enterprise_users WHERE id = $1', [req.params.id]);
 *       req.targetTenantId = r.rows[0].tenant_id;
 *       next();
 *     },
 *     requireSameTenant,
 *     actualHandler
 *   );
 */
function requireSameTenant(req, res, next) {
  if (req.enterpriseUser.role === 'super_admin') return next(); // Super Admin: no restriction
  if (!req.targetTenantId) {
    return res.status(500).json({ error: 'targetTenantId not set by route handler' });
  }
  if (req.enterpriseUser.tenant_id !== req.targetTenantId) {
    return res.status(403).json({ error: 'Access denied: cross-company action not allowed' });
  }
  next();
}

module.exports = { requireRole, requirePermission, requireSameTenant };
```

---

### 5. Company + Role Management Routes — `src/role-routes.js`

```js
const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { requireAuth }                              = require('./auth-middleware');
const { requireRole, requirePermission, requireSameTenant } = require('./role-middleware');
const { ROLES, hasRoleOrAbove }                    = require('./roles');

// ── GET /api/roles/me ─────────────────────────────────────────────────────────
// Every active user can call this to get their own role, tenant, and status.
router.get('/me', requireAuth, requireRole(ROLES.USER), (req, res) => {
  res.json({ user: req.enterpriseUser });
});

// ── GET /api/roles/users ──────────────────────────────────────────────────────
// Super Admin: all users on the platform.
// Admin: all users in their company only.
// Agent/User: not allowed.
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
//
// Rules:
// - Super Admin can change anyone's role (except another super_admin)
// - Admin can only change agent ↔ user within their own company
// - Admin cannot promote to admin or super_admin
// - No one can change their own role
// - Admin cannot touch users in other companies
router.patch('/users/:userId/role',
  requireAuth,
  requireRole(ROLES.ADMIN),
  async (req, res, next) => {
    // Resolve target tenant for requireSameTenant
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
      const target = targetResult.rows[0];

      // Cannot change your own role
      if (target.matrix_user_id === req.matrixUserId) {
        return res.status(403).json({ error: 'Cannot change your own role' });
      }

      // Admin cannot assign super_admin (can assign up to admin within own company)
      if (actor.role === ROLES.ADMIN && new_role === ROLES.SUPER_ADMIN) {
        return res.status(403).json({ error: 'Admin cannot assign super_admin role' });
      }

      // Admin cannot touch someone who is already a super_admin
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
      if (err.code === '23505' && err.constraint === 'one_trusted_user_per_company') {
        return res.status(409).json({
          error: 'This company already has an active Agent (Trusted User). Deactivate the current Agent first.',
        });
      }
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
      const target = targetResult.rows[0];

      // Admin cannot deactivate a super_admin (can deactivate other admins within own company)
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
// User: not allowed.
router.get('/audit-logs', requireAuth, requireRole(ROLES.AGENT), async (req, res) => {
  try {
    let result;
    if (req.enterpriseUser.role === ROLES.SUPER_ADMIN) {
      result = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500`);
    } else if (req.enterpriseUser.role === ROLES.ADMIN) {
      // Fetch logs for all users in this company
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

// ── GET /api/companies ────────────────────────────────────────────────────────
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

// ── POST /api/companies ───────────────────────────────────────────────────────
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

// ── PATCH /api/companies/:tenantId/status ─────────────────────────────────────
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
```

---

### 6. Update `/invites` to Embed Role and Tenant

In `POST /invites` (currently in `src/index.js`), accept:
```json
{
  "email": "newuser@company.com",
  "tenant_id": "company_abc",
  "role": "user"
}
```

- Super Admin can create invites for any tenant and any role (except super_admin)
- Admin can only create invites for their own `tenant_id` and only for `agent` or `user` roles
- Store `tenant_id` and `role` in the `registration_invites` table
- On `POST /register`, read `role` and `tenant_id` from the invite row — never trust the client to send these

Replace old `requireAdmin` (API key) with:
```js
router.post('/invites', requireAuth, requireRole(ROLES.ADMIN), requirePermission('create_invite'), async (req, res) => {
  const { email, tenant_id, role = 'user' } = req.body;
  const actor = req.enterpriseUser;

  // Admin can only invite into their own company
  const targetTenant = actor.role === ROLES.SUPER_ADMIN ? tenant_id : actor.tenant_id;

  // Admin cannot invite someone as super_admin (can invite as admin, agent, or user)
  if (actor.role === ROLES.ADMIN && role === ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Admin cannot create an invite for super_admin role' });
  }

  // ... rest of invite creation logic (token generation, expiry, email)
});
```

---

### 7. Register the Router in `src/index.js`

```js
const roleRoutes = require('./role-routes');
app.use('/api/roles', roleRoutes);
// Note: /api/companies is also served under the roleRoutes router
```

---

## Complete API Surface After Implementation

| Method | Path | Min Role | Description |
|---|---|---|---|
| GET | `/api/roles/me` | user | Own role, tenant, status |
| GET | `/api/roles/users` | admin | All users (Super Admin: all tenants; Admin: own company) |
| PATCH | `/api/roles/users/:id/role` | admin | Change a user's role |
| PATCH | `/api/roles/users/:id/status` | admin | Activate / deactivate user |
| GET | `/api/roles/audit-logs` | agent | Audit log (scoped by role) |
| GET | `/api/roles/companies` | super_admin | List all companies |
| POST | `/api/roles/companies` | super_admin | Create a new company |
| PATCH | `/api/roles/companies/:tenantId/status` | super_admin | Activate / deactivate company |
| POST | `/invites` | admin | Create invite token |
| GET | `/invites/:id` | admin | Check invite status |
| POST | `/api/location/session/create` | admin | Start location sharing session |

---

## Role Access Matrix

| Action | Super Admin | Admin | Agent | User |
|---|:---:|:---:|:---:|:---:|
| Send messages | ✅ | ✅ | ✅ | ✅ |
| Upload / view files | ✅ | ✅ | ✅ | ✅ |
| Download files | ✅ | ✅ | ✅ | ❌ |
| Manage room members | ✅ | ✅ | ✅ | ❌ |
| View own audit log | ✅ | ✅ | ✅ | ❌ |
| **External file sharing** | ✅ | ✅ | ✅ | ❌ |
| **Export chat history** | ✅ | ✅ | ✅ | ❌ |
| View full company audit log | ✅ | ✅ | ❌ | ❌ |
| Invite new users | ✅ | ✅ | ❌ | ❌ |
| Manage / deactivate users | ✅ | ✅ (not super_admin) | ❌ | ❌ |
| Change user roles (up to admin) | ✅ | ✅ (not super_admin) | ❌ | ❌ |
| Approve BYOD devices | ✅ | ✅ | ❌ | ❌ |
| Manage folder permissions | ✅ | ✅ | ❌ | ❌ |
| Assign admin role within company | ✅ | ✅ | ❌ | ❌ |
| Assign super_admin role | ✅ | ❌ | ❌ | ❌ |
| Manage MDM / system config | ✅ | ❌ | ❌ | ❌ |
| View all companies | ✅ | ❌ | ❌ | ❌ |
| Create / deactivate company | ✅ | ❌ | ❌ | ❌ |
| View all tenants' audit logs | ✅ | ❌ | ❌ | ❌ |

---

## Implementation Order

1. Run migration `012_roles_and_permissions.sql`
2. Create `src/roles.js`
3. Create `src/auth-middleware.js` (extract from `index.js`)
4. Create `src/role-middleware.js`
5. Create `src/role-routes.js`
6. Update `src/index.js` — register role router, update `/invites` and `/register` to use role middleware
7. Test with Postman (one user per role):
   - Verify Super Admin can create companies
   - Verify Admin can manage users but not cross-company
   - Verify Agent gets 403 on user management endpoints
   - Verify unique Agent constraint fires on second Agent in same company
   - Verify User gets 403 on all admin endpoints

---

## Environment Variables (no changes needed)

The role system uses the existing Matrix Bearer token via `requireAuth`.
No new env vars required. `ADMIN_API_KEY` stays for bot/internal server-to-server calls only.
