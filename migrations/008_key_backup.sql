CREATE TABLE IF NOT EXISTS key_backups (
  user_id       TEXT        PRIMARY KEY,
  encrypted_keys TEXT       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
