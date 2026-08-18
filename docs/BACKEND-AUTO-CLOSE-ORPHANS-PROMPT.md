# Backend Fix Request — Auto-Close Orphaned Idle/Break Events

## Context

You own the **Laravel backend** for the time & attendance system
(`/api/plugin/timetracker`, admin dashboard `/timetracker/time-and-attendance`).

The **Electron desktop tracker** (v1.0.2+) now closes idle/break on resume,
startup, and clock-out. **Historical rows and any machine still on an older
build can still leave orphaned events in the database.** The admin timeline
treats an open `idle-start` or `break-start` as **ongoing until “now”**, which
inflates reports (e.g. 1h+ idle from a single missing `idle-stop`, or break
past `maxDailyBreakTime`).

**Prerequisite:** implement timezone-correct day boundaries from
`docs/BACKEND-FORCE-CLOCKOUT-PROMPT.md` §1 first. Auto-close at “day end” is
wrong if `today()` is UTC and rows are IST wall-clock strings.

---

## The bug

Activity events are **paired state transitions**:

| Start | Stop |
| --- | --- |
| `idle-start` | `idle-stop` |
| `break-start` | `break-stop` |
| `clock-in` | `clock-out` |
| `manual-processing-start` | `manual-processing-stop` |

When a **start** exists with **no matching stop** on the same calendar day,
the admin UI draws a bar from the start timestamp **to the current time** (or
shift end), even if the employee returned to work hours ago.

### Symptoms in production

1. **Idle:** one long yellow block (e.g. `01:22` idle, shift still ONGOING) —
   `idle-start` around 10:50, no `idle-stop`.
2. **Break:** red break bar grows past admin `maxDailyBreakTime` — `break-start`
   with no `break-stop` (crash, sleep, force clock-out, or unsynced stop).
3. **Detection query** (MariaDB) — any row here is a defect:

```sql
SELECT user_id, DATE(`timestamp`) AS day, action AS open_action, `timestamp` AS opened_at
FROM time_tracker_activity_logs a
WHERE a.action IN ('idle-start', 'break-start')
  AND NOT EXISTS (
    SELECT 1
    FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id
      AND b.action = CASE a.action
          WHEN 'idle-start'  THEN 'idle-stop'
          WHEN 'break-start' THEN 'break-stop'
        END
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  )
ORDER BY opened_at DESC;
```

---

## Root cause (server-side gap)

- There is **no job** that closes open idle/break at day boundary.
- Timeline math assumes **every start eventually gets a stop**; it does not cap
  duration or infer stop from the next unrelated event.
- Client v1.0.1 had bugs (1-minute idle default, no resume handler, force
  clock-out skipped stops). v1.0.2 fixes the client; **the server must heal
  existing and future orphans** so reports stay trustworthy.

---

## Required fix

### 1. Nightly (or hourly) scheduled job: `CloseOrphanedActivityEvents`

Run **once per workspace timezone** after local day end (recommended:
**00:15** workspace local time, or **every hour** for same-day safety on
ongoing shifts — see §4).

For each workspace `W` with timezone `$tz`:

1. Determine **yesterday’s** local date (or “today” if running hourly — §4).
2. For each user who has activity rows on that date, load rows ordered by
   `timestamp` ascending.
3. Find **unclosed starts** using a stack / pairing pass (not just “last row”):

```php
// Pseudocode — same calendar day in workspace TZ
$opens = []; // action => start timestamp
foreach ($logs as $row) {
    match ($row->action) {
        'idle-start'  => $opens['idle'] = $row,
        'idle-stop'   => unset($opens['idle']),
        'break-start' => $opens['break'] = $row,
        'break-stop'  => unset($opens['break']),
        'clock-out'   => unset($opens['idle'], $opens['break']), // shift ended
        default => null,
    };
}
// Whatever remains in $opens at end of day is orphaned for that day
```

4. For each orphan, **insert a synthetic stop row** via the same persistence
   path as `/log-update` (so validation, indexes, and audit stay consistent).

### 2. Timestamp for the synthetic stop

Use the **earliest defensible close time**, in workspace timezone:

| Orphan | Stop timestamp | Rule |
| --- | --- | --- |
| `idle-start` | `min(next_activity_at, day_end, now)` | Next row after start that proves activity: `idle-stop`, `break-start`, `clock-out`, or end of local day |
| `break-start` | `min(next_activity_at, day_end, break_start + remaining_daily_break)` | Also cap at `maxDailyBreakTime` for that user/day |

Where:

- `day_end` = last second of that calendar day in `$tz` (e.g. `23:59:59`).
- `next_activity_at` = timestamp of the **next** log for that user after the
  start (any action). If the next row is `clock-out`, use the clock-out time
  as the stop (employee left; idle/break should not extend past it).
- Do **not** use `now()` for **past** days — use `day_end` only.

**Reason column** (must persist — see `backend-punching-fixes.md` §2.9):

```text
Auto-closed: no idle-stop received
Auto-closed: no break-stop received
```

### 3. Cap break at `maxDailyBreakTime`

Load per-workspace (or per-user) `maxDailyBreakTime` from the same config
`/load-config` exposes (milliseconds). For each user/day:

1. Sum completed `break-start` → `break-stop` pairs.
2. For an orphan `break-start`, set stop at:

```php
$stopAt = min(
    $inferredStop,                                    // next event / day end
    $breakStart->copy()->addMilliseconds($remaining)  // remaining daily allowance
);
```

If `$remaining <= 0` at break start, set `$stopAt = $breakStart` (zero-length
close) or reject the orphan start as invalid — **prefer inserting stop at
start + 0s** so the timeline does not grow forever.

### 4. Same-day ongoing shifts (optional but recommended)

Nightly-only healing leaves **today’s** orphans visible until midnight. Add
either:

- **Hourly job** (lighter): for **today only**, close idle/break orphans where
  `opened_at` is older than `max(idleTimeThreshold, 2 hours)` and there is a
  newer `clock-in` or any user activity row after the start; or
- **On read** in the attendance API: when building the timeline, never extend
  an open idle/break beyond the next known event or workspace max.

Minimum for this prompt: **nightly close for completed days** + **timeline
renderer must not extend open idle/break past `day_end` for past dates**.

### 5. Idempotency

- Before inserting a synthetic stop, check one does not already exist for that
  start (same user, same day, stop after start).
- Use the same unique constraint as §2.5 in `backend-punching-fixes.md`:
  `unique(user_id, action, timestamp)` with `insertOrIgnore` / upsert.
- Re-running the job must be a **no-op** for already-healed days.

### 6. Do not break the client contract

Synthetic rows are **server-generated**; the desktop app did not send them.
That is fine — they are marked via `reason`:

- Admin timeline should show auto-closed segments differently (badge or tooltip).
- Do **not** return `403 FORCE_CLOCKOUT` when inserting heals.
- Do **not** reject a later legitimate client `idle-stop` / `break-stop` if it
  arrives after heal — treat duplicate/out-of-order as **200 no-op** (§2.6).

---

## Suggested implementation (Laravel)

```php
// app/Console/Kernel.php — after timezone fix is live
$schedule->command('timetracker:close-orphaned-events')
    ->dailyAt('00:15')
    ->timezone('Asia/Kolkata'); // or per-workspace loop

// Command outline
class CloseOrphanedActivityEvents extends Command
{
    public function handle()
    {
        foreach (Workspace::with('timezone')->cursor() as $workspace) {
            $tz = $workspace->timezone ?? 'Asia/Kolkata';
            $day = Carbon::yesterday($tz); // completed local day
            $this->closeForWorkspaceDay($workspace, $day, $tz);
        }
    }
}
```

Core service method:

```php
public function closeOrphansForUserDay(int $userId, Carbon $day, string $tz): int
{
    $dayStart = $day->copy()->timezone($tz)->startOfDay();
    $dayEnd   = $day->copy()->timezone($tz)->endOfDay();

    $logs = TimeTrackerActivityLog::where('user_id', $userId)
        ->whereBetween('timestamp', [$dayStart, $dayEnd])
        ->orderBy('timestamp')
        ->get();

    $closed = 0;
    foreach ($this->findOrphanedStarts($logs) as $orphan) {
        $stopAt = $this->inferStopTimestamp($orphan, $logs, $dayEnd, $tz);
        $this->insertSyntheticStop($userId, $orphan->action, $stopAt, $tz);
        $closed++;
    }
    return $closed;
}
```

---

## Timeline API hardening (same PR if possible)

When computing shift segments for the admin dashboard:

1. Pair starts/stops in order; **never** extend an open start beyond:
   - next stop,
   - next `clock-out`,
   - local `day_end` for that date,
   - `break-start + remainingDailyBreak` for break rows.
2. Ignore idle segments shorter than workspace `idleTimeThreshold` **only for
   display** (optional; heals visual noise from old 1-minute client bug).

---

## Acceptance tests

1. User has `idle-start` at 10:50, no stop, same day — job runs at 00:15 next
   day → one `idle-stop` inserted at `23:59:59` (or at next `clock-out` if
   that row exists), `reason` set, timeline idle no longer grows on refresh.
2. User has `break-start` at 13:00, no stop, `maxDailyBreakTime` = 1 hour,
   already used 0 — synthetic stop at **14:00** (not open-ended to midnight).
3. User has `break-start` + later `clock-out` at 15:00, no `break-stop` —
   synthetic stop at **15:00**, not `23:59:59`.
4. Job run twice on same day → **no duplicate** stop rows.
5. Client later sends a real `idle-stop` for the same window → **200 no-op**,
   no duplicate row (unique index + state machine).
6. All day-boundary tests from `BACKEND-FORCE-CLOCKOUT-PROMPT.md` still pass
   after this change.
7. Auto-closed rows appear in admin with distinguishable `reason`.

---

## Detection & monitoring (run in prod)

**Open orphans today** (alert if count > 0 by end of day):

```sql
SELECT user_id, action, `timestamp`
FROM time_tracker_activity_logs a
WHERE DATE(`timestamp`) = CURDATE()
  AND a.action IN ('idle-start', 'break-start')
  AND NOT EXISTS (
    SELECT 1 FROM time_tracker_activity_logs b
    WHERE b.user_id = a.user_id
      AND b.action = IF(a.action = 'idle-start', 'idle-stop', 'break-stop')
      AND b.`timestamp` >= a.`timestamp`
      AND DATE(b.`timestamp`) = DATE(a.`timestamp`)
  );
```

Log `{ workspace_id, user_id, action, opened_at, inferred_stop_at }` for each
heal. Optional: Slack/email if orphans closed > N per day (signals client fleet
not fully on 1.0.2).

---

## Coordination with desktop client

| Client version | Behavior |
| --- | --- |
| ≤ 1.0.1 | Can still create orphans; **server job is required** |
| ≥ 1.0.2 | Closes idle on resume/startup, break/idle before clock-out; orphans should **decrease** over time |

Deploy **backend job first or with 1.0.2 rollout**. Backend heals history and
any stragglers; client stops creating new orphans.

---

## Suggested order of work

1. **Timezone fix** (`BACKEND-FORCE-CLOCKOUT-PROMPT.md` §1) — mandatory
2. **Persist `reason`** on all rows — mandatory for audit
3. **Nightly `CloseOrphanedActivityEvents` command** — this prompt
4. **Timeline API caps** — same PR if feasible
5. **Hourly same-day heal** — optional follow-up
6. **State machine no-op rules** (`backend-punching-fixes.md` §2.6) — prevents
   client retry loops when heal + client stop collide

---

## Out of scope (separate tickets)

- Auto-close **open `clock-in`** (shift) — see `backend-punching-fixes.md` §2.8
- Migrating legacy naive timestamps to UTC — see force-clockout prompt migration note
- Rebuilding past admin reports after heal (may need one-time backfill command)
