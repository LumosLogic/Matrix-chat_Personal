-- Migration 012: Role-Based Access Control (RBAC)

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
  ('admin', 'change_role_within_company'),
  ('admin', 'deactivate_company_user'),
  ('admin', 'approve_byod'),
  ('admin', 'manage_folder_permissions'),
  ('admin', 'manage_room_members'),
  ('admin', 'external_sharing'),
  ('admin', 'export_chat'),
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

-- Add role and tenant_id to registration_invites so the invite embeds the target role
ALTER TABLE registration_invites
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS role      TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'agent', 'user'));
-- Note: super_admin cannot be created via invite — only manually by platform operators
