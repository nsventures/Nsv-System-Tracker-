# Backend Task: Fix Time-Tracker Punching (Clock-In/Out) Issues

## Your role

You are working on the **Laravel backend** for a time & attendance system
(`/api/plugin/timetracker`, admin dashboard at `/timetracker/time-and-attendance`).

An **Electron desktop tracker** is the client. You do **not** have that repo — its
complete wire contract is documented below. Treat it as **fixed and authoritative**:
the client is already deployed on employee machines, so the server must conform to
it. Do not propose changes that require the desktop app to be updated, unless a
section explicitly marks them as "requires coordinated client change".

---

## 1. The client contract (authoritative — do not break)

Base URL: `{apiBaseUrl}` = `http://localhost:8000/api/plugin/timetracker`

### Endpoints the tracker calls

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/login` | Authenticate, returns token + user |
| GET | `/load-config` | Screenshot interval, idle/break thresholds |
| POST | `/log-update` | **Every punch/activity event** |
| POST | `/upload-screenshot` | Periodic screenshot (multipart) |

There are **only these four**. There is no status/poll endpoint.

### Common headers

```
Authorization: Bearer <token>
workspace-id: <workspace_id>
Content-Type: application/json     (except upload-screenshot => multipart/form-data)
Accept: application/json
```

### `POST /log-update` body

```json
{
  "user_id": 123,
  "action": "clock-in",
  "timestamp": "2026-07-22 10:37:39",
  "reason": "default"
}
```

`action` is one of exactly these 8 values:

```
clock-in | clock-out
break-start | break-stop
idle-start | idle-stop
manual-processing-start | manual-processing-stop
```

`reason` is always present. It is `"default"` for most actions, the user's typed
text for `manual-processing-stop`, and `"Forcefully clocked out by administrator"`
or `"Gracefully clocked out on PC shutdown"` for those specific cases.
**Persist this field** — it is currently being dropped.

### `POST /upload-screenshot` body

`multipart/form-data` with fields `screenshot` (PNG file) and `timestamp` (same
string format as above). Sent on an interval driven by `load-config`'s
`screenshotInterval` (currently 60s in testing, 5min default).

### CRITICAL: the `timestamp` format

```
"YYYY-MM-DD HH:MM:SS"    e.g. "2026-07-22 00:30:00"
```

It is a **naive local-time string with NO offset and NO timezone identifier**, and
it is formatted in **the employee's own OS timezone** (the client uses
`Intl.DateTimeFormat().resolvedOptions().timeZone`, not a fixed constant). The
server therefore cannot tell whether a given string is IST, UTC, or anything else.
This is the root cause of most bugs below. See §2.1 for how to handle it.

### Response envelope the client expects

```json
{ "error": false, "message": "...", "data": { }, "token": "...", "code": "..." }
```

- `error` (bool) and `message` (string) are **required on every response**.
- `code` (string) carries machine-readable signals such as `FORCE_CLOCKOUT`.

### Client behavior on HTTP status — read this before choosing status codes

- **401** → the client **immediately clears stored auth and logs the user fully
  out**. Never use 401 for business-logic rejections such as force-clockout.
- **403 + `code: "FORCE_CLOCKOUT"`** → the client stops screenshots, writes a local
  clock-out, notifies the user, and resets the dashboard to clocked-out.
- **Any other non-2xx** → treated as a failed request; the log stays queued locally
  and **is retried forever** on a 60-second sync loop. Never return a permanent
  error for something the client cannot fix by retrying — return `200` with
  `error: false` for no-op / already-applied cases (see §2.6).

### Client sync behavior you must design around

- **Offline queueing.** When offline (or when a request fails), punches are stored
  locally and replayed **later, in chronological order**, once connectivity
  returns. A punch can therefore arrive with a timestamp **hours old**. See §2.4.
- **No idempotency key.** The client does not send a unique event id. If a POST
  succeeds but the response is lost, the client retries and you receive a
  **duplicate**. See §2.5.
- **No heartbeat.** `/log-update` fires **only on state transitions** (clock-in/out,
  break start/stop, idle start/stop, manual start/stop). A user working normally
  sends **zero** `/log-update` calls for long stretches. `/upload-screenshot` is the
  only regular traffic. This is why §2.2 matters.

---

## 2. Bugs to fix

### 2.1 — P0: Timezone. Naive timestamps vs `Carbon::today()` in UTC

**Current code**

```php
$lastLog = TimeTrackerActivityLog::where('user_id', $data['user_id'])
    ->whereDate('timestamp', today())   // today() is UTC
    ->latest()->first();
```

`forceClockout()` has the same problem: for a past date it uses `endOfDay()` in UTC.

**Symptom.** Rows are written as local-time strings (IST on our machines) while day
boundaries are computed in UTC. Between **00:00 and 05:30 IST** the two disagree by
a full calendar day: `whereDate('timestamp', today())` finds nothing, `$lastLog` is
null, and the gate in §2.2 fires **403 FORCE_CLOCKOUT at a user who was never
clocked out**. Anyone starting a shift after midnight IST is kicked on their next
activity call. Separately, `endOfDay()` in UTC = `23:59:59Z` = **05:29 IST the next
morning**, so an admin force-clockout for a past date lands on the wrong day.

**Required fix.** Introduce an explicit workspace timezone and do **all** day-boundary
and "now" math in it. Never mix a UTC `today()` against locally-formatted rows.

```php
$tz = $workspace->timezone ?? config('app.display_timezone', 'Asia/Kolkata');

// interpret the incoming naive string in the workspace zone; store UTC
$ts = Carbon::createFromFormat('Y-m-d H:i:s', $data['timestamp'], $tz)->utc();

// day boundaries in workspace zone, expressed for the UTC-stored column
$dayStart = Carbon::now($tz)->startOfDay()->utc();
$dayEnd   = Carbon::now($tz)->endOfDay()->utc();

$lastLog = TimeTrackerActivityLog::where('user_id', $userId)
    ->whereBetween('timestamp', [$dayStart, $dayEnd])
    ->latest('timestamp')->first();
```

Apply the same treatment to `forceClockout()`'s `now()` / `endOfDay()`.

**Migration decision required.** Existing rows are ambiguous local strings. Either
(a) migrate them (interpret as `Asia/Kolkata`, convert to UTC) in a reversible
migration, or (b) leave them and apply the new logic only to new rows. **Do not
silently mix the two** — it will corrupt attendance reports. State which you chose.

**Acceptance:** a user clocking in at 00:30 IST and taking a break at 00:45 IST is
never rejected; the break is attributed to the correct IST calendar day.

---

### 2.2 — P0: The force-clockout gate is missing on `/upload-screenshot`

**Symptom.** Admin clicks Force Clock-out. The desktop app **keeps capturing and
uploading screenshots indefinitely** and the employee's timer keeps running.
Confirmed in testing: `/upload-screenshot` returned `200` for a user who had already
been force-clocked-out, and the client deleted its local copy as "successfully
synced".

**Root cause.** The gate exists only in `logUpdate()`. But per §1, `/log-update`
fires only on transitions — a user just working sends none, so the gate never runs.
`/upload-screenshot` is the *only* endpoint hit on a regular interval.

**Required fix.** Extract the gate into one shared method and call it from **both**
`logUpdate()` and `uploadScreenshot()`. Screenshots arrive every 60s, so this makes
enforcement kick in within one interval instead of never.

```php
private function isForceClockedOut(int $userId, string $tz, Carbon $at): bool
{
    $lastLog = /* query from §2.1, bounded by $at per §2.4 */;
    return !$lastLog || $lastLog->action === 'clock-out';
}

// in uploadScreenshot(), BEFORE storing the file:
if ($this->isForceClockedOut($userId, $tz, $ts)) {
    return response()->json([
        'error'   => true,
        'code'    => 'FORCE_CLOCKOUT',
        'message' => 'You have been clocked out by an administrator.',
    ], 403);
}
```

**Acceptance:** after a force clock-out, the tracker stops taking screenshots within
one screenshot interval, with no employee interaction.

---

### 2.3 — P0: Error envelope is missing the `error` field

**Current response**

```json
{ "message": "FORCE_CLOCKOUT", "code": "FORCE_CLOCKOUT" }
```

**Symptom.** No `error` key. Clients that check `if (response.error && response.code
=== 'FORCE_CLOCKOUT')` see `undefined`, skip the branch entirely, and — worse —
evaluate `!response.error` as `true`, treating a **403 rejection as a success**.
That marks rejected punches as synced and deletes screenshot files from disk (silent
data loss). The desktop client has been patched to derive `error` from the HTTP
status, but the server must still emit a correct envelope for every other consumer.

**Required fix.** Every response, success and failure, returns the full envelope:

```php
return response()->json([
    'error'   => true,
    'code'    => 'FORCE_CLOCKOUT',
    'message' => 'You have been clocked out by an administrator.',
], 403);   // 403 — NEVER 401, see §1
```

**Acceptance:** every JSON response from all four endpoints contains `error` and
`message`.

---

### 2.4 — P1: Offline replay is falsely rejected as force-clockout

**Symptom.** Employee works offline 2:00–4:00pm. Admin force-clocks-out at 3:00pm.
At 4:00pm the tracker reconnects and replays its queued 2:00pm `break-start`. The
server checks "is the **latest** log a clock-out?" — evaluated against **now** — sees
the 3:00pm clock-out, and returns 403. The client then fires its force-clockout
handler **for a two-hour-old historical event**, and the punch is lost.

**Root cause.** `latest()->first()` is relative to *now*, not to the timestamp of the
punch being submitted.

**Required fix.** Evaluate the gate against the last log **at or before the incoming
punch's timestamp**. Only reject punches timestamped *after* the force clock-out.

```php
$lastLog = TimeTrackerActivityLog::where('user_id', $userId)
    ->where('timestamp', '<=', $ts)          // relative to the punch, not now()
    ->whereBetween('timestamp', [$dayStart, $dayEnd])
    ->latest('timestamp')->first();
```

Backfilled punches that predate the force clock-out must be **accepted and stored**
(they are real historical work), while still leaving the forced clock-out as the
latest state.

**Acceptance:** replaying a queued punch timestamped before a force clock-out stores
it successfully and does **not** return 403.

---

### 2.5 — P1: Duplicate punches

**Symptom.** Real data from the tracker's activity feed:

```
Clocked Out   7/21/2026, 07:21:13 PM
Clocked Out   7/21/2026, 07:21:11 PM
```

Two clock-outs two seconds apart.

**Root causes.** (a) The client sends no idempotency key; if a POST succeeds but the
response is lost, it retries and inserts a second row. (b) The desktop app writes a
graceful-shutdown clock-out that can race a UI clock-out.

**Required fix.** Make replay idempotent at the database level.

```php
$table->unique(['user_id', 'action', 'timestamp']);
```

Then `upsert`/`insertOrIgnore` on write, and return **`200` with `error: false`** for
a duplicate — never an error status, or the client retries forever (§1).

**Acceptance:** POSTing the identical punch twice yields one row and two `200`s.

---

### 2.6 — P1: No state-machine validation

**Symptom.** The server accepts any sequence: `clock-in → clock-in`, `break-start`
with no preceding clock-in, `clock-out → clock-out`. This is what let the double
clock-out in §2.5 persist, and it produces negative/absurd durations in reports.

**Required fix.** Validate transitions against the last log for the day:

| Incoming action | Accept only if last log is |
| --- | --- |
| `clock-in` | none, or `clock-out` |
| `clock-out` | any action other than `clock-out` |
| `break-start` / `idle-start` / `manual-processing-start` | clocked in, and not already in that state |
| `break-stop` / `idle-stop` / `manual-processing-stop` | the matching `*-start` is open |

Reject invalid transitions as a **no-op `200` with `error: false`** and a descriptive
`message` — **not** a 4xx, otherwise the client retries the same invalid punch
forever on its 60s sync loop.

Also make **`forceClockout()` itself a no-op** when the last log is already a
clock-out, so clicking the admin button twice does not write two rows.

**Acceptance:** a duplicate or out-of-order punch returns `200`, writes no row, and
is not retried indefinitely.

---

### 2.7 — P2: Race condition on the gate

Two near-simultaneous requests can both read the same "last log" and both pass.
Wrap the read-check-insert in a transaction with a row lock:

```php
DB::transaction(function () use (...) {
    $lastLog = TimeTrackerActivityLog::where('user_id', $userId)
        ->lockForUpdate()->latest('timestamp')->first();
    // validate + insert
});
```

---

### 2.8 — P2: Open shifts are never closed

If a machine crashes or loses power, no `clock-out` is ever sent and the shift stays
open forever, accumulating hours. Add a scheduled nightly job that closes open shifts
at a configurable cutoff **in the workspace timezone** (§2.1), writing a `clock-out`
with `reason: 'Auto-closed: no clock-out received'`.

---

### 2.9 — P2: Persist `reason`

The client already sends `reason` on **every** `/log-update` (§1) — including the
manual-time justification the employee types, and
`"Forcefully clocked out by administrator"`. Ensure the column exists, is persisted,
and is surfaced in the admin timeline so forced clock-outs are distinguishable from
voluntary ones.

---

## 3. Suggested order of work

1. **§2.1** timezone normalization — nothing else is reliable until day boundaries are correct
2. **§2.2 + §2.3** gate `/upload-screenshot`, fix the envelope — makes force-clockout actually work
3. **§2.4** timestamp-relative gate — stops offline sync being falsely rejected
4. **§2.5 + §2.6** unique index + transition validation — kills duplicate punches
5. **§2.7 – §2.9** locking, auto-close, reason

---

## 4. Test scenarios that must pass

1. Force clock-out an active user → tracker stops screenshots within one interval.
2. Clock in at 00:30 IST, break at 00:45 IST → both accepted, attributed to the
   correct IST day, no spurious `FORCE_CLOCKOUT`.
3. Work offline 2–4pm, force clock-out at 3pm, reconnect at 4pm → the 2pm punch is
   stored, no 403 for the backfilled event.
4. POST the identical punch twice → one row, both responses `200`.
5. `clock-in` twice in a row → one row, second returns `200` no-op, not retried.
6. Force clock-out a user who is already clocked out → no second row written.
7. Every response from all four endpoints contains `error` and `message`.
8. Force-clockout is returned as **403**, never 401.

---

## 5. Open question for the client team

The naive-timestamp problem in §2.1 is solvable server-side by assuming a workspace
timezone, but the durable fix is the tracker sending **ISO-8601 with offset**
(`2026-07-22T00:30:00+05:30`). That is a small, contained change on the desktop side.

If you want it, say so and it will be made — then the server can parse the offset
directly and stop guessing. Until then, implement §2.1 as specified.
