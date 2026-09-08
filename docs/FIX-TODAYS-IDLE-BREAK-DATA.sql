-- =============================================================================
-- NS Ventures Time Tracker — Fix TODAY's bad idle/break rows (MariaDB / MySQL)
-- =============================================================================
--
-- USE CASE
--   Clean up after 1.0.1 bugs: many 1-minute idle flickers, orphaned idle-start
--   (no idle-stop), orphaned break-start, break totals past daily cap display.
--
-- BEFORE RUNNING
--   1. BACK UP the table (see §0 below).
--   2. Run all §1 PREVIEW queries — check row counts look reasonable.
--   3. Run §2 FIX inside a transaction; COMMIT only if preview OK.
--   4. Re-run §1 previews — should return 0 rows for problems.
--
-- ADJUST
--   @fix_date     — default CURDATE() (today). Set explicitly if needed:
--                  SET @fix_date = '2026-08-18';
--   @idle_min_sec — idle shorter than this is treated as bad (default 300 = 5 min)
--   @max_break_sec — cap break segment length when closing orphans (default 3600)
--
-- =============================================================================

SET @fix_date       = CURDATE();
SET @idle_min_sec   = 300;    -- match admin idle threshold (5 minutes)
SET @max_break_sec  = 3600;   -- 1 hour daily break cap in seconds


-- =============================================================================
-- §0 BACKUP (run once — creates a dated copy)
-- =============================================================================
-- CREATE TABLE time_tracker_activity_logs_backup_20260818 AS
-- SELECT * FROM time_tracker_activity_logs
-- WHERE DATE(`timestamp`) = @fix_date;


-- =============================================================================
-- §1 PREVIEW — run these first (read-only)
-- =============================================================================

-- 1a) Short idle pairs today (< 5 min) — the "1 minute flicker" problem
SELECT
  a.user_id,
  a.id   AS idle_start_id,
  b.id   AS idle_stop_id,
  a.`timestamp` AS idle_start,
  b.`timestamp` AS idle_stop,
  TIMESTAMPDIFF(SECOND, a.`timestamp`, b.`timestamp`) AS idle_sec
FROM time_tracker_activity_logs a
INNER JOIN time_tracker_activity_logs b
  ON b.user_id = a.user_id
 AND b.action = 'idle-stop'
 AND b.`timestamp` = (
   SELECT MIN(c.`timestamp`)
   FROM time_tracker_activity_logs c
   WHERE c.user_id = a.user_id
     AND c.action = 'idle-stop'
     AND c.`timestamp` >= a.`timestamp`
     AND DATE(c.`timestamp`) = DATE(a.`timestamp`)
 )
WHERE a.action = 'idle-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND TIMESTAMPDIFF(SECOND, a.`timestamp`, b.`timestamp`) < @idle_min_sec
ORDER BY a.user_id, a.`timestamp`;


-- 1b) Orphan idle-start today (no idle-stop) — growing yellow bar
SELECT
  a.user_id,
  a.id,
  a.`timestamp` AS idle_start,
  TIMESTAMPDIFF(MINUTE, a.`timestamp`, NOW()) AS open_minutes
FROM time_tracker_activity_logs a
WHERE a.action = 'idle-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND NOT EXISTS (
    SELECT 1
    FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id
      AND b.action = 'idle-stop'
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  )
ORDER BY open_minutes DESC;


-- 1c) Orphan break-start today (no break-stop)
SELECT
  a.user_id,
  a.id,
  a.`timestamp` AS break_start,
  TIMESTAMPDIFF(MINUTE, a.`timestamp`, NOW()) AS open_minutes
FROM time_tracker_activity_logs a
WHERE a.action = 'break-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND NOT EXISTS (
    SELECT 1
    FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id
      AND b.action = 'break-stop'
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  )
ORDER BY open_minutes DESC;


-- 1d) Count affected rows per user today (summary)
SELECT
  user_id,
  SUM(action = 'idle-start')  AS idle_starts,
  SUM(action = 'idle-stop')   AS idle_stops,
  SUM(action = 'break-start') AS break_starts,
  SUM(action = 'break-stop')  AS break_stops
FROM time_tracker_activity_logs
WHERE DATE(`timestamp`) = @fix_date
GROUP BY user_id
HAVING idle_starts <> idle_stops
    OR break_starts <> break_stops
ORDER BY user_id;


-- =============================================================================
-- §2 FIX — run in a transaction
-- =============================================================================

START TRANSACTION;

-- -----------------------------------------------------------------------------
-- STEP A — DELETE short idle pairs (< @idle_min_sec)
-- Removes BOTH idle-start and idle-stop for bogus 1–2 minute flicker rows.
-- -----------------------------------------------------------------------------
DELETE FROM time_tracker_activity_logs
WHERE id IN (
  SELECT id FROM (
    SELECT a.id AS id
    FROM time_tracker_activity_logs a
    INNER JOIN time_tracker_activity_logs b
      ON b.user_id = a.user_id
     AND b.action = 'idle-stop'
     AND b.`timestamp` = (
       SELECT MIN(c.`timestamp`)
       FROM time_tracker_activity_logs c
       WHERE c.user_id = a.user_id
         AND c.action = 'idle-stop'
         AND c.`timestamp` >= a.`timestamp`
         AND DATE(c.`timestamp`) = DATE(a.`timestamp`)
     )
    WHERE a.action = 'idle-start'
      AND DATE(a.`timestamp`) = @fix_date
      AND TIMESTAMPDIFF(SECOND, a.`timestamp`, b.`timestamp`) < @idle_min_sec

    UNION

    SELECT b.id AS id
    FROM time_tracker_activity_logs a
    INNER JOIN time_tracker_activity_logs b
      ON b.user_id = a.user_id
     AND b.action = 'idle-stop'
     AND b.`timestamp` = (
       SELECT MIN(c.`timestamp`)
       FROM time_tracker_activity_logs c
       WHERE c.user_id = a.user_id
         AND c.action = 'idle-stop'
         AND c.`timestamp` >= a.`timestamp`
         AND DATE(c.`timestamp`) = DATE(a.`timestamp`)
     )
    WHERE a.action = 'idle-start'
      AND DATE(a.`timestamp`) = @fix_date
      AND TIMESTAMPDIFF(SECOND, a.`timestamp`, b.`timestamp`) < @idle_min_sec
  ) AS rows_to_delete
);

-- Check how many rows Step A removed:
-- SELECT ROW_COUNT() AS deleted_short_idle_rows;


-- -----------------------------------------------------------------------------
-- STEP B — CLOSE orphan idle-start (insert synthetic idle-stop)
-- Stop time = earliest of: next activity row, end of day, idle_start + 5 min
-- (does NOT extend idle to NOW — caps phantom open bars)
-- -----------------------------------------------------------------------------
INSERT INTO time_tracker_activity_logs (user_id, action, `timestamp`, reason)
SELECT
  o.user_id,
  'idle-stop',
  LEAST(
    COALESCE(o.next_event_at, o.day_end),
    DATE_ADD(o.idle_start, INTERVAL @idle_min_sec SECOND),
    o.day_end
  ) AS stop_at,
  'Auto-closed: no idle-stop received (data fix)'
FROM (
  SELECT
    a.user_id,
    a.`timestamp` AS idle_start,
    (
      SELECT MIN(n.`timestamp`)
      FROM time_tracker_activity_logs n
      WHERE n.user_id = a.user_id
        AND n.`timestamp` > a.`timestamp`
        AND DATE(n.`timestamp`) = DATE(a.`timestamp`)
        AND n.action IN (
          'clock-out', 'break-start', 'idle-start',
          'manual-processing-start', 'clock-in'
        )
    ) AS next_event_at,
    TIMESTAMP(DATE(a.`timestamp`), '23:59:59') AS day_end
  FROM time_tracker_activity_logs a
  WHERE a.action = 'idle-start'
    AND DATE(a.`timestamp`) = @fix_date
    AND NOT EXISTS (
      SELECT 1
      FROM time_tracker_activity_logs b
      WHERE b.user_id = a.user_id
        AND b.action = 'idle-stop'
        AND b.`timestamp` >= a.`timestamp`
        AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
    )
) o;

-- If INSERT fails, run: SHOW COLUMNS FROM time_tracker_activity_logs;
-- and add any NOT NULL columns (e.g. workspace_id) to the INSERT list.


-- -----------------------------------------------------------------------------
-- STEP C — CLOSE orphan break-start (insert synthetic break-stop)
-- Stop time capped at break_start + @max_break_sec (1 hour segment max)
-- -----------------------------------------------------------------------------
INSERT INTO time_tracker_activity_logs (user_id, action, `timestamp`, reason)
SELECT
  o.user_id,
  'break-stop',
  LEAST(
    COALESCE(o.next_event_at, o.day_end),
    DATE_ADD(o.break_start, INTERVAL @max_break_sec SECOND),
    o.day_end
  ) AS stop_at,
  'Auto-closed: no break-stop received (data fix)'
FROM (
  SELECT
    a.user_id,
    a.`timestamp` AS break_start,
    (
      SELECT MIN(n.`timestamp`)
      FROM time_tracker_activity_logs n
      WHERE n.user_id = a.user_id
        AND n.`timestamp` > a.`timestamp`
        AND DATE(n.`timestamp`) = DATE(a.`timestamp`)
        AND n.action IN ('clock-out', 'idle-start', 'break-start', 'clock-in')
    ) AS next_event_at,
    TIMESTAMP(DATE(a.`timestamp`), '23:59:59') AS day_end
  FROM time_tracker_activity_logs a
  WHERE a.action = 'break-start'
    AND DATE(a.`timestamp`) = @fix_date
    AND NOT EXISTS (
      SELECT 1
      FROM time_tracker_activity_logs b
      WHERE b.user_id = a.user_id
        AND b.action = 'break-stop'
        AND b.`timestamp` >= a.`timestamp`
        AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
    )
) o;


-- Review before commit — re-run §1 previews in another tab, then:
COMMIT;
-- ROLLBACK;   -- use this instead if anything looks wrong


-- =============================================================================
-- §3 VERIFY — after COMMIT
-- =============================================================================

-- Should return 0 rows:
SELECT 'short_idle_remaining' AS check_name, COUNT(*) AS cnt
FROM time_tracker_activity_logs a
INNER JOIN time_tracker_activity_logs b
  ON b.user_id = a.user_id AND b.action = 'idle-stop'
 AND b.`timestamp` = (
   SELECT MIN(c.`timestamp`) FROM time_tracker_activity_logs c
   WHERE c.user_id = a.user_id AND c.action = 'idle-stop'
     AND c.`timestamp` >= a.`timestamp`
     AND DATE(c.`timestamp`) = DATE(a.`timestamp`)
 )
WHERE a.action = 'idle-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND TIMESTAMPDIFF(SECOND, a.`timestamp`, b.`timestamp`) < @idle_min_sec

UNION ALL

SELECT 'orphan_idle_remaining', COUNT(*)
FROM time_tracker_activity_logs a
WHERE a.action = 'idle-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND NOT EXISTS (
    SELECT 1 FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id AND b.action = 'idle-stop'
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  )

UNION ALL

SELECT 'orphan_break_remaining', COUNT(*)
FROM time_tracker_activity_logs a
WHERE a.action = 'break-start'
  AND DATE(a.`timestamp`) = @fix_date
  AND NOT EXISTS (
    SELECT 1 FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id AND b.action = 'break-stop'
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  );


-- =============================================================================
-- §4 OPTIONAL — delete ALL idle rows for today for specific users (nuclear)
-- Only if you want to wipe idle completely for a user and re-test from scratch.
-- =============================================================================
-- DELETE FROM time_tracker_activity_logs
-- WHERE user_id IN (33, 15)   -- <-- set user IDs
--   AND DATE(`timestamp`) = @fix_date
--   AND action IN ('idle-start', 'idle-stop');
