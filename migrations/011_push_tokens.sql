-- Migration 011: FCM push token storage
-- Stores one FCM token per user per platform.
-- The backend acts as a Matrix Push Gateway:
--   Synapse → POST /api/push/gateway/_matrix/push/v1/notify → FCM

CREATE TABLE IF NOT EXISTS push_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL,                  -- @user:server.com
  platform     TEXT        NOT NULL DEFAULT 'android', -- 'android' | 'ios'
  fcm_token    TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id  ON push_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_fcm_token ON push_tokens (fcm_token);
