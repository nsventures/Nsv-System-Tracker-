# Fix: server returns a spurious 403 FORCE_CLOCKOUT seconds after every clock-in

You are working on the **Laravel backend** for a time & attendance system
(`/api/plugin/timetracker`, admin dashboard at `/timetracker/time-and-attendance`,
model `TimeTrackerActivityLog`).

The client is an **Electron desktop tracker in a separate repo you do not have**.
Its wire contract is documented in §3 below and is **fixed** — it is deployed on
employee machines. Do not propose changes that require updating the desktop app.

Work through §1 (diagnose), then §2 (fix), then §4 (hardening). Do not skip §1 —
the exact cause is not yet confirmed and §2 depends on what §1 reports.

---

## 1. The live bug — diagnose this first

### Symptom

An employee clicks Clock In. The clock-in succeeds. **~24 seconds later** the
server returns `403 FORCE_CLOCKOUT` on their next request, and the tracker clocks
them out. This repeats on **every** clock-in, **all day** — not just near midnight.

### The gate causing it

In `logUpdate()` (and now also on `uploadScreenshot()`):

```php
if ($data['action'] !== 'clock-in') {
    $lastLog = TimeTrackerActivityLog::where('user_id', $data['user_id'])
        ->whereDate('timestamp', today())
        ->latest()->first();

    if (!$lastLog || $lastLog->action === 'clock-out') {
        return response()->json([
            'message' => 'FORCE_CLOCKOUT',
            'code'    => 'FORCE_CLOCKOUT',
        ], 403);
    }
}
```

### What the evidence already rules out

The admin dashboard shows, for this user, **an open shift**: clock-in `10:37 AM`,
clock-out column `--`, work time accruing, and only 2 shift records total for the
day. Therefore:

- The **clock-in row exists** in the database.
- There is **no clock-out row** — the repeated force-clockouts were client-side
  reactions to your 403s, not admin actions, so nothing was ever written.

So the gate **cannot** be failing on `$lastLog->action === 'clock-out'`.
It must be hitting **`!$lastLog`** — the query is returning **zero rows** for a
user who demonstrably has a clock-in row today.

**The dashboard query finds the shift. The gate query does not. They disagree.
Find out why.**

### Primary hypothesis — verify before fixing

A **write/read timezone asymmetry**. The client sends a naive local-time string
with no offset (§3). If the gate converts that incoming string to UTC while the
stored rows are still naive local (IST / `Asia/Calcutta`), then for a request at
12:12 IST the comparison becomes:

```
'2026-07-22 10:37:39'  <=  '2026-07-22 06:42:00'    -> FALSE
```

→ zero rows → `!$lastLog` → **403**. A 5.5-hour skew in one direction, firing all
day. This fits the symptom exactly.

This is likely a **half-applied** timezone fix: converting on read but not on
write, or vice versa. Check both paths.

### Required diagnostic

Add this inside the gate, trigger **one** real request from a clocked-in user,
and report the output:

```php
Log::info('FORCE_CLOCKOUT gate', [
    'endpoint'       => request()->path(),
    'incoming_raw'   => $data['timestamp'] ?? request('timestamp'),
    'ts_after_parse' => isset($ts) ? (string) $ts : null,
    'day_start'      => isset($dayStart) ? (string) $dayStart : null,
    'day_end'        => isset($dayEnd) ? (string) $dayEnd : null,
    'app_tz'         => config('app.timezone'),
    'carbon_today'   => (string) today(),
    'last_log'       => $lastLog?->only(['id','action','timestamp']),
    'raw_rows'       => TimeTrackerActivityLog::where('user_id', $userId)
                          ->latest('id')->limit(5)
                          ->get(['id','action','timestamp','created_at'])->toArray(),
]);
```

Put `incoming_raw`, `ts_after_parse` and `raw_rows[].timestamp` side by side.
The mismatch will be visible in one line. **Report these values.**

### Immediate unblock (do this first, before the real fix)

Temporarily **disable the force-clockout gate on `/upload-screenshot`**. It is the
endpoint firing every 60 seconds and it is the newest change. This restores normal
operation for employees while you debug. Keep the `/log-update` gate.

---

## 2. Fix the gate

Once §1 confirms the cause, apply all of the following.

### 2.1 Make timestamp handling symmetric

Pick **one** storage convention and apply it on **both** write and read. Recommended:
interpret incoming naive strings in the workspace timezone, store UTC, and compute
all day boundaries in the workspace timezone.

```php
$tz = $workspace->timezone ?? config('app.display_timezone', 'Asia/Kolkata');

// WRITE: interpret the naive string in workspace tz, store UTC
$ts = Carbon::createFromFormat('Y-m-d H:i:s', $data['timestamp'], $tz)->utc();

// READ: day boundaries in workspace tz, expressed for the UTC-stored column
$dayStart = Carbon::now($tz)->startOfDay()->utc();
$dayEnd   = Carbon::now($tz)->endOfDay()->utc();
```

Then audit **every** other query touching `timestamp` — the dashboard, reports, and
`forceClockout()` — so they all use the same convention. The current bug exists
precisely because two queries disagreed.

**Existing rows are ambiguous naive strings.** Decide explicitly: either migrate
them (interpret as `Asia/Kolkata` → UTC) in a reversible migration, or leave them
and apply new logic only to new rows. **Do not silently mix the two.** State which
you chose and why.

Also fix `forceClockout()`: for a past date it uses `endOfDay()` in UTC, which is
`23:59:59Z` = **05:29 IST the next morning**, landing the clock-out on the wrong day.

### 2.2 Evaluate the gate at the punch's own timestamp

The client queues events while offline and replays them later, so a punch can
arrive **hours old** (§3). Checking "is the *latest* log a clock-out?" against
*now* wrongly rejects backfilled events.

```php
$lastLog = TimeTrackerActivityLog::where('user_id', $userId)
    ->where('timestamp', '<=', $ts)          // relative to the punch, not now()
    ->whereBetween('timestamp', [$dayStart, $dayEnd])
    ->latest('timestamp')->first();
```

Punches timestamped **before** a clock-out must be **accepted and stored** — they
are real historical work. Only reject punches timestamped **after** it.

Note `latest()` with no argument orders by `created_at`, which is **not** the punch
time. Always use `latest('timestamp')`.

### 2.3 `/upload-screenshot` must accept historical screenshots

Same rule as 2.2, and it is currently blocking real data: a client has ~15
screenshots captured during a period the user was clocked out. They are legitimate
work product. Gating them on *current* state means they are refused **forever** and
the offline backlog can never drain.

Gate on the **screenshot's own `timestamp`**, and only reject ones timestamped
after the clock-out.

### 2.4 Fix the response envelope

Current body:

```json
{ "message": "FORCE_CLOCKOUT", "code": "FORCE_CLOCKOUT" }
```

It has **no `error` key**. Clients checking `if (response.error && response.code ===
'FORCE_CLOCKOUT')` see `undefined` and skip the branch; worse, `!response.error`
evaluates to `true`, so a **403 rejection reads as success** and rejected data gets
marked synced and deleted. Every response, success and failure, must return:

```php
return response()->json([
    'error'   => true,
    'code'    => 'FORCE_CLOCKOUT',
    'message' => 'You have been clocked out by an administrator.',
], 403);   // 403 — NEVER 401, see §3
```

---

## 3. Client contract — authoritative, do not break

Base URL: `http://localhost:8000/api/plugin/timetracker`

Only four endpoints exist. There is **no** status/polling endpoint.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/login` | auth, returns token + user |
| GET | `/load-config` | screenshot interval, idle/break thresholds |
| POST | `/log-update` | every punch / activity event |
| POST | `/upload-screenshot` | periodic screenshot (multipart) |

Headers: `Authorization: Bearer <token>`, `workspace-id: <id>`, `Accept: application/json`.

`POST /log-update` body:

```json
{ "user_id": 12, "action": "clock-in", "timestamp": "2026-07-22 10:37:39", "reason": "default" }
```

`action` is exactly one of these 8:

```
clock-in | clock-out | break-start | break-stop |
idle-start | idle-stop | manual-processing-start | manual-processing-stop
```

`POST /upload-screenshot`: `multipart/form-data`, fields `screenshot` (PNG) and
`timestamp` (same format).

### The `timestamp` format — central to this bug

```
"YYYY-MM-DD HH:MM:SS"     e.g. "2026-07-22 10:37:39"
```

**Naive. No offset. No timezone identifier.** It is formatted in the *employee's own
OS timezone* (observed: `Asia/Calcutta`). The server cannot infer the zone from the
payload — it must assume the workspace timezone. This is the root ambiguity.

### Client behavior you must design around

- **401** → the client **clears auth and fully logs the user out**. Never use 401
  for business rejections such as force-clockout. Use **403**.
- **Non-2xx** → the item stays queued and is **retried every 60 seconds forever**.
  Never return a permanent 4xx for something the client cannot fix by retrying.
  For no-op cases (duplicate, out-of-order punch) return **`200` with
  `error: false`** and `code: "NOOP"`.
- **Offline queueing** → punches and screenshots are stored locally and replayed
  chronologically on reconnect. Timestamps can be hours old. See 2.2 / 2.3.
- **No idempotency key** → if a response is lost the client retries, so you will
  receive duplicates. See 4.1.
- **No heartbeat** → `/log-update` fires only on state transitions. A user working
  normally sends none. `/upload-screenshot` is the only regular traffic.
- `reason` is sent on **every** punch and must be persisted (see 4.4).

---

## 4. Hardening (after §2 is verified working)

### 4.1 Duplicate punches

Real data from a client shows two clock-outs two seconds apart. The client sends no
idempotency key, so lost responses cause duplicate rows.

```php
$table->unique(['user_id', 'action', 'timestamp']);
```

Use `upsert`/`insertOrIgnore`, and return **`200`** for a duplicate — never an error
status, or the client retries forever.

### 4.2 State-machine validation

The server currently accepts `clock-in → clock-in`, `break-start` with no clock-in,
`clock-out → clock-out`. Validate transitions against the last log for the day:

| Incoming | Accept only if last log is |
| --- | --- |
| `clock-in` | none, or `clock-out` |
| `clock-out` | anything other than `clock-out` |
| `*-start` | clocked in, not already in that state |
| `*-stop` | the matching `*-start` is open |

Reject invalid transitions as a **no-op `200`** with `code: "NOOP"` — not a 4xx.
Also make `forceClockout()` a no-op when the last log is already a clock-out.

### 4.3 Concurrency

Wrap read-check-insert in a transaction with `lockForUpdate()` on the user's latest
row; two near-simultaneous requests can currently both pass the gate.

### 4.4 Persist `reason`

The client sends `reason` on every punch — the employee's typed manual-time
justification, `"Forcefully clocked out by administrator"`, `"Gracefully clocked out
on PC shutdown"`, or `"default"`. Ensure the column exists, is persisted, and is
shown in the admin timeline.

### 4.5 Auto-close open shifts

On crash or power loss no clock-out is ever sent and the shift accrues forever. Add
a nightly job closing open shifts at a configurable cutoff **in the workspace
timezone**, with `reason: 'Auto-closed: no clock-out received'`.

---

## 5. Acceptance tests

1. Clock in → work 5 minutes → **no** spurious FORCE_CLOCKOUT. *(the live bug)*
2. Clock in at 00:30 IST, break at 00:45 IST → both accepted, correct IST day.
3. Offline 2–4pm, admin force-clockout at 3pm, reconnect 4pm → the 2pm punch is
   stored, no 403 for the backfilled event.
4. Upload a screenshot timestamped before a clock-out → accepted, backlog drains.
5. POST the identical punch twice → one row, both `200`.
6. `clock-in` twice → one row, second is `200` + `NOOP`, not retried.
7. Force-clockout an already-clocked-out user → no second row.
8. Every response from all four endpoints contains `error` and `message`.
9. Force-clockout returns **403**, never 401.

---

## 6. Report back

State: (a) the §1 diagnostic values, (b) the actual root cause found, (c) the
migration decision from 2.1, (d) which acceptance tests pass.
