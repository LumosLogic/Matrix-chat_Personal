-- Location Sharing Feature Tables
-- Run: psql -U enterprise_user -d enterprise_db -f migrations/003_location_sharing.sql

CREATE TABLE IF NOT EXISTS location_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_token VARCHAR(64) NOT NULL UNIQUE,
    matrix_user_id VARCHAR(255) NOT NULL,
    room_id VARCHAR(255) NOT NULL,
    mode VARCHAR(10) NOT NULL DEFAULT 'static',
    duration_ms BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    matrix_access_token TEXT,
    beacon_event_id VARCHAR(255),
    last_lat DOUBLE PRECISION,
    last_lng DOUBLE PRECISION,
    last_accuracy DOUBLE PRECISION,
    last_update_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS location_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES location_sessions(id),
    action VARCHAR(50) NOT NULL,
    matrix_user_id VARCHAR(255) NOT NULL,
    room_id VARCHAR(255) NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_sessions_token ON location_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_location_sessions_status ON location_sessions(status);
CREATE INDEX IF NOT EXISTS idx_location_sessions_expires ON location_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_location_audit_session ON location_audit_log(session_id);
