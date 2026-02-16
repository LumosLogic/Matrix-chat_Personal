-- ============================================================
-- Chat between a specific user and AI Bot
--
-- Usage:
--   docker exec synapse-postgres psql -U synapse_user -d synapse_db -v user="'@avan:localhost'" -f /dev/stdin < check-user-chat.sql
--
-- Or replace :user with the Matrix ID directly below.
-- ============================================================

-- Set the target user here (change as needed)
-- If using -v flag, comment out this line:
\set user '''@avan:localhost'''

-- ============================================================
-- 1. Full conversation (chronological)
-- ============================================================
SELECT
    to_char(to_timestamp(e.origin_server_ts / 1000), 'YYYY-MM-DD HH24:MI:SS') AS "Time",
    CASE
        WHEN e.sender = '@ai-bot:localhost' THEN 'AI Bot'
        ELSE e.sender
    END AS "Who",
    LEFT(ej.json::jsonb->'content'->>'body', 300) AS "Message",
    CASE
        WHEN EXISTS (
            SELECT 1 FROM events r
            JOIN event_json rj ON r.event_id = rj.event_id
            WHERE r.type = 'm.room.redaction'
              AND rj.json::jsonb->>'redacts' = e.event_id
        ) THEN '[DELETED]'
        ELSE ''
    END AS "Status"
FROM events e
JOIN event_json ej ON e.event_id = ej.event_id
WHERE e.type = 'm.room.message'
  AND ej.json::jsonb->'content'->>'msgtype' = 'm.text'
  AND e.room_id IN (
      SELECT DISTINCT e1.room_id
      FROM events e1
      WHERE e1.sender = :user
        AND e1.room_id IN (
            SELECT DISTINCT room_id FROM events WHERE sender = '@ai-bot:localhost'
        )
  )
  AND (e.sender = :user OR e.sender = '@ai-bot:localhost')
ORDER BY e.origin_server_ts ASC;

-- ============================================================
-- 2. Summary
-- ============================================================
SELECT
    e.sender AS "User",
    COUNT(*) AS "Total Messages",
    COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM events r
        JOIN event_json rj ON r.event_id = rj.event_id
        WHERE r.type = 'm.room.redaction'
          AND rj.json::jsonb->>'redacts' = e.event_id
    )) AS "Deleted Messages"
FROM events e
JOIN event_json ej ON e.event_id = ej.event_id
WHERE e.type = 'm.room.message'
  AND e.room_id IN (
      SELECT DISTINCT e1.room_id
      FROM events e1
      WHERE e1.sender = :user
        AND e1.room_id IN (
            SELECT DISTINCT room_id FROM events WHERE sender = '@ai-bot:localhost'
        )
  )
  AND (e.sender = :user OR e.sender = '@ai-bot:localhost')
GROUP BY e.sender;
