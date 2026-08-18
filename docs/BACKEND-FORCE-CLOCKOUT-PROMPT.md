# Backend Fix Request — Users Are Being Auto/Force Clocked-Out While Actively Working

## Context

You own the **Laravel backend** for a time & attendance system
(`/api/plugin/timetracker`, admin dashboard `/timetracker/time-and-attendance`).
An **Electron desktop tracker** is the client — it is **already deployed on
employee machines and cannot be changed for this fix**, so the server must
conform to its contract (below). Treat the client contract as fixed.

## The bug to fix

**Employees who are actively working are being clocked out on their own.**

The desktop app does not self-clock-out during work. It only writes a clock-out
when the server returns **`403` with `code: "FORCE_CLOCKOUT"`** — on that
response the client stops tracking, writes a local clock-out, and notifies the
user ("You have been forcefully clocked out by an administrator"). So a
working user being clocked out means **the server is returning FORCE_CLOCKOUT to
a user who is genuinely clocked in.**

## Root cause: naive local timestamps vs. UTC day boundaries

The client sends timestamps as a **naive local-time string with NO timezone
offset**:

```
"YYYY-MM-DD HH:MM:SS"   e.g. "2026-07-22 10:37:39"
```

formatted in the **employee's own OS timezone** (IST on our machines). The server
decides "is this user clocked out?" by looking up today's last log:

```php
// CURRENT (buggy)
$lastLog = TimeTrackerActivityLog::where('user_id', $data['user_id'])
    ->whereDate('timestamp', today())   // today() is UTC
    ->latest()->first();

$isClockedOut = !$lastLog || $lastLog->action === 'clock-out';
// if $isClockedOut → returns 403 FORCE_CLOCKOUT
```

`today()` is **UTC**, but the rows are **IST wall-clock strings**. IST is UTC+5:30,
so the UTC day and the IST day disagree across the boundary. The query finds **no
clock-in for "today" (UTC)**, `$lastLog` is null, and the server fires
`FORCE_CLOCKOUT` at a user who clocked in normally — most reliably for anyone
whose clock-in falls on the "other" side of the UTC/IST day line (e.g. shifts
around/after midnight IST, or the 00:00–05:30 IST window).

## Required fixes

### 1. Do all day-boundary and "now" math in the workspace timezone; store UTC

Introduce an explicit workspace timezone and never mix a UTC `today()` against
locally-formatted rows.

```php
$tz = $workspace->timezone ?? config('app.display_timezone', 'Asia/Kolkata');

// interpret the incoming naive string in the workspace zone, store as UTC
$ts = Carbon::createFromFormat('Y-m-d H:i:s', $data['timestamp'], $tz)->utc();

// day boundaries computed in the workspace zone, expressed for the UTC column
$dayStart = Carbon::now($tz)->startOfDay()->utc();
$dayEnd   = Carbon::now($tz)->endOfDay()->utc();
```

Apply the same treatment anywhere the code uses `today()`, `now()`, or
`endOfDay()` — including `forceClockout()` (its `endOfDay()` in UTC lands at
05:29 IST the next morning, attributing admin clock-outs to the wrong day).

### 2. Evaluate the force-clockout gate relative to the PUNCH's timestamp, not `now()`

The client replays **offline** punches in chronological order — a punch can
arrive **hours old**. Checking "is the latest log (as of now) a clock-out?"
falsely rejects historical punches. Bound the lookup by the incoming timestamp:

```php
$lastLog = TimeTrackerActivityLog::where('user_id', $userId)
    ->where('timestamp', '<=', $ts)               // relative to the punch, not now()
    ->whereBetween('timestamp', [$dayStart, $dayEnd])
    ->latest('timestamp')->first();

$isForceClockedOut = !$lastLog || $lastLog->action === 'clock-out';
```

A punch timestamped **before** a force clock-out is real historical work — it
must be **accepted and stored**, not rejected.

### 3. Always return the full response envelope; force-clockout is 403, never 401

Every response (success and failure) must include `error` and `message`. Return
force-clockout as **403** — a 401 makes the client log the user out entirely.

```php
return response()->json([
    'error'   => true,
    'code'    => 'FORCE_CLOCKOUT',
    'message' => 'You have been clocked out by an administrator.',
], 403);
```

## Migration decision (state which you chose)

Existing rows are ambiguous naive local strings. Either:
- **(a)** migrate them once — interpret as `Asia/Kolkata`, convert to UTC — in a
  reversible migration, or
- **(b)** leave old rows and apply the new logic only to new rows.

**Do not silently mix the two** — it corrupts attendance reports.

## Acceptance tests (must pass)

1. A user clocks in at **00:30 IST** and takes a break at **00:45 IST** → both
   accepted, attributed to the correct IST day, **no spurious FORCE_CLOCKOUT**.
2. An actively-clocked-in user performing normal activity is **never** returned a
   FORCE_CLOCKOUT unless an admin actually force-clocked them out.
3. Work offline 2:00–4:00pm, admin force-clocks-out at 3:00pm, reconnect at
   4:00pm → the queued **2:00pm** punch is stored, **no 403** for that backfilled
   event; the 3:00pm forced clock-out remains the latest state.
4. Every JSON response from all four endpoints contains `error` and `message`.
5. Force-clockout is returned as **403**, never 401.

## Note

There is a fuller companion document (`backend-punching-fixes.md`) covering
related issues — persisting `reason`, gating `/upload-screenshot`, duplicate
punches, state-machine validation, auto-closing crashed shifts. This prompt is
the **minimum to stop active users being force-clocked-out**; do §2.1 (fix 1
here) first, as nothing else is reliable until day boundaries are correct.

## Optional durable fix (requires a small coordinated client change)

The naive-timestamp guessing goes away entirely if the tracker sends **ISO-8601
with offset** (`2026-07-22T00:30:00+05:30`). The client already has this behind a
flag; it was reverted because it triggered the very FORCE_CLOCKOUT bug above when
the server wasn't ready. Once the server parses offsets correctly, the client can
be switched back and the server can stop assuming a workspace timezone. Say if you
want this and it will be coordinated.
