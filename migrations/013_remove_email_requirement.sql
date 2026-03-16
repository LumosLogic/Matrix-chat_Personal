-- Migration 013: Remove email requirement — app runs without email or phone

-- Make email nullable in enterprise_users
ALTER TABLE enterprise_users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email SET DEFAULT NULL;

-- Make email nullable in registration_invites
ALTER TABLE registration_invites
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN email SET DEFAULT NULL;
