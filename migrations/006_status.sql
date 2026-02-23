-- Migration 006: Status / Stories feature
-- Run with: psql -U enterprise_user -d enterprise_db -f migrations/006_status.sql

-- Status items (stories)
CREATE TABLE IF NOT EXISTS status_items (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           VARCHAR(255) NOT NULL,          -- @alice:example.com
  mxc_url           TEXT        NOT NULL DEFAULT '', -- empty for text-only
  mime_type         VARCHAR(100) NOT NULL,
  caption           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,            -- always created_at + 24h
  video_duration_ms INT,
  width             INT,
  height            INT,
  background_color  VARCHAR(20),
  text_color        VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_status_user   ON status_items (user_id);
CREATE INDEX IF NOT EXISTS idx_status_expiry ON status_items (expires_at);

-- View receipts
CREATE TABLE IF NOT EXISTS status_views (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID        NOT NULL REFERENCES status_items(id) ON DELETE CASCADE,
  viewer_id   VARCHAR(255) NOT NULL,                -- @bob:example.com
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, viewer_id)                       -- one row per (item, viewer)
);

CREATE INDEX IF NOT EXISTS idx_views_item   ON status_views (item_id);
CREATE INDEX IF NOT EXISTS idx_views_viewer ON status_views (viewer_id);