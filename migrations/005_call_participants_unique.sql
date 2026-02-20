-- Migration 005: Add unique constraint to call_participants
-- Prevents duplicate participant rows and enables proper ON CONFLICT upserts.
-- Run: psql -U enterprise_user -d enterprise_db -f migrations/005_call_participants_unique.sql

-- Remove any pre-existing duplicate rows (keep the first inserted row per user per call)
DELETE FROM call_participants
WHERE id NOT IN (
  SELECT DISTINCT ON (call_id, matrix_user_id) id
  FROM call_participants
  ORDER BY call_id, matrix_user_id, created_at ASC
);

-- Add the unique constraint
ALTER TABLE call_participants
ADD CONSTRAINT uniq_call_participants_user UNIQUE (call_id, matrix_user_id);
