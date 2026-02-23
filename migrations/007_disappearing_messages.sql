-- Migration 007: Disappearing messages – secure per-room purge tracking
-- Run with: psql -U enterprise_user -d enterprise_db -f migrations/007_disappearing_messages.sql
--
-- Purpose: track the strictest retention policy ever active per room, and the
-- last timestamp up to which Synapse events have been permanently purged.
-- This prevents messages from "coming back" when the room policy is relaxed or
-- turned off – the purge cutoff is monotonically increasing (never goes back).

CREATE TABLE IF NOT EXISTS room_disappearing_config (
  room_id           TEXT        PRIMARY KEY,

  -- The STRICTEST (smallest) max_lifetime ever seen for this room (ms).
  -- Once set, it only decreases (gets more restrictive).
  -- Used to keep advancing the purge even after the policy is relaxed.
  min_max_lifetime  BIGINT      NOT NULL,

  -- The current max_lifetime from the most recent m.room.retention event (ms).
  -- NULL if the room no longer has a retention policy.
  current_max_lifetime BIGINT,

  -- Epoch timestamp (ms) up to which Synapse has purged events.
  -- Monotonically increasing – never decreases.
  last_purge_cutoff BIGINT      NOT NULL DEFAULT 0,

  -- Wall-clock time of the last successful purge for this room.
  last_purge_at     TIMESTAMPTZ,

  -- When we first saw a retention policy for this room.
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rdm_last_purge ON room_disappearing_config (last_purge_at);
