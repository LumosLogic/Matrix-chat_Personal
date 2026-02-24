-- Enterprise users table (created on successful registration)
CREATE TABLE IF NOT EXISTS enterprise_users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT        NOT NULL UNIQUE,
  full_name      TEXT        NOT NULL,
  role           TEXT        NOT NULL DEFAULT 'user',
  matrix_user_id TEXT        NOT NULL UNIQUE,
  status         TEXT        NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add used_at column to registration_invites (missing from initial migration)
ALTER TABLE registration_invites ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Add room_id column so backend can notify the chat room after registration
ALTER TABLE registration_invites ADD COLUMN IF NOT EXISTS room_id TEXT;
