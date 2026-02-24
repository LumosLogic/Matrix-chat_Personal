-- Registration invite tokens (used by the invite bot and web registration flow)
CREATE TABLE IF NOT EXISTS registration_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL,
  token       TEXT        NOT NULL UNIQUE,
  invited_by  TEXT        NOT NULL DEFAULT 'admin',
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS registration_invites_token_idx ON registration_invites (token);
CREATE INDEX IF NOT EXISTS registration_invites_email_idx ON registration_invites (email);

-- Audit log for invite/registration events
CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT        NOT NULL,
  actor      TEXT,
  target     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
