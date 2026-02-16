-- ============================================================
-- View AI Bot Chat History
-- Run against: synapse_db (Synapse PostgreSQL database)
-- ============================================================

-- ============================================================
-- 1. ALL MESSAGES with the AI Bot (most recent first)
-- ============================================================
SELECT
    to_char(to_timestamp(e.origin_server_ts / 1000), 'YYYY-MM-DD HH24:MI:SS') AS "Time",
    e.sender AS "From",
    CASE
        WHEN ej.json::jsonb->'content'->>'msgtype' = 'm.text'
            THEN LEFT(ej.json::jsonb->'content'->>'body', 200)
        WHEN e.type = 'm.room.encrypted'
            THEN '[Encrypted message]'
        ELSE '[' || (ej.json::jsonb->'content'->>'msgtype') || ']'
    END AS "Message",
    e.room_id AS "Room"
FROM events e
JOIN event_json ej ON e.event_id = ej.event_id
WHERE e.type = 'm.room.message'
  AND e.room_id IN (
      SELECT DISTINCT room_id
      FROM events
      WHERE sender = '@ai-bot:localhost'
        AND type = 'm.room.message'
  )
ORDER BY e.origin_server_ts DESC
LIMIT 50;


-- ============================================================
-- 2. CONVERSATION VIEW (User message → Bot reply pairs)
-- ============================================================
SELECT
    to_char(to_timestamp(e.origin_server_ts / 1000), 'YYYY-MM-DD HH24:MI:SS') AS "Time",
    CASE
        WHEN e.sender = '@ai-bot:localhost' THEN 'AI Bot'
        ELSE e.sender
    END AS "Who",
    LEFT(ej.json::jsonb->'content'->>'body', 300) AS "Message"
FROM events e
JOIN event_json ej ON e.event_id = ej.event_id
WHERE e.type = 'm.room.message'
  AND ej.json::jsonb->'content'->>'msgtype' = 'm.text'
  AND e.room_id IN (
      SELECT DISTINCT room_id
      FROM events
      WHERE sender = '@ai-bot:localhost'
        AND type = 'm.room.message'
  )
ORDER BY e.origin_server_ts ASC;


-- ============================================================
-- 3. CHAT SUMMARY per user (message counts)
-- ============================================================
SELECT
    e.sender AS "User",
    COUNT(*) AS "Messages Sent",
    MIN(to_char(to_timestamp(e.origin_server_ts / 1000), 'YYYY-MM-DD HH24:MI')) AS "First Message",
    MAX(to_char(to_timestamp(e.origin_server_ts / 1000), 'YYYY-MM-DD HH24:MI')) AS "Last Message"
FROM events e
WHERE e.type = 'm.room.message'
  AND e.room_id IN (
      SELECT DISTINCT room_id
      FROM events
      WHERE sender = '@ai-bot:localhost'
        AND type = 'm.room.message'
  )
GROUP BY e.sender
ORDER BY "Messages Sent" DESC;


-- ============================================================
-- 4. ROOMS where AI Bot is active
-- ============================================================
SELECT
    e.room_id AS "Room ID",
    COUNT(*) FILTER (WHERE e.sender = '@ai-bot:localhost') AS "Bot Messages",
    COUNT(*) FILTER (WHERE e.sender != '@ai-bot:localhost') AS "User Messages",
    COUNT(DISTINCT e.sender) - 1 AS "Users (excl. bot)",
    CASE
        WHEN cse.type IS NOT NULL THEN 'Encrypted'
        ELSE 'Unencrypted'
    END AS "Encryption"
FROM events e
LEFT JOIN current_state_events cse
    ON cse.room_id = e.room_id AND cse.type = 'm.room.encryption'
WHERE e.type = 'm.room.message'
  AND e.room_id IN (
      SELECT DISTINCT room_id
      FROM events
      WHERE sender = '@ai-bot:localhost'
  )
GROUP BY e.room_id, cse.type
ORDER BY "Bot Messages" DESC;
