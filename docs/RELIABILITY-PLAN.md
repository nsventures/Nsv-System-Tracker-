# Reliability Plan — Making the Tracker "Bulletproof"

Goal: **never lose or corrupt data, never double-count, never falsely clock
in/out, and make every failure visible.**

Honest ceiling: on hardware the employee controls, evasion can be made **loud and
logged** but not impossible — an admin can always kill a process or block a
domain. "Bulletproof" here means no silent data loss, no double-counting, no
false punches, every failure observable — not un-defeatable surveillance.

Split: **client** = this repo; **server** = the Laravel backend (not in this
repo; its wire contract is frozen per `backend-punching-fixes.md`). Items are
tagged accordingly.

**Recommended first slice:** P0 Data Integrity (#1–3) — that is where "tracks
perfectly" actually lives. Capture and lifecycle bugs are more *visible*, but
duplicate/lost punches quietly corrupt attendance reports with no one noticing.

---

## P0 — Data integrity (never lose or duplicate a punch)

1. **Idempotency keys.** No unique event ID today, so any retry after a lost
   response creates a **duplicate punch** (`backend-punching-fixes.md` §2.5).
   *Client:* generate a UUID per event, send and store it. *Server:* dedupe on
   it. → eliminates double-counting. **[client + server]**
2. **Single source of clock-state truth.** Clock-in state is derived **twice,
   independently** — `activity.ts isUserClockedIn()` and `useActivityLogs.ts` —
   which can disagree and drive wrong UI/behaviour. Unify into one authoritative
   function. **[client]**
3. **Durable, ordered offline queue with a dead-letter.** Strict chronological
   replay, exponential backoff, and a dead-letter bucket for permanently-rejected
   events so they stop looping forever and become visible. **[client]**

## P0 — Capture reliability (screenshots are real, idle is accurate)

4. **Screenshot verification.** Reject blank / zero-byte / identical frames
   before saving; log when capture returns nothing. Confirms the Wayland
   `getDisplayMedia` path actually produces images. **[client — needs on-device
   Wayland test]**
5. **Backlog drain confirmation.** Verify the Windows filename fix cleared the
   upload backlog; add capped retry/backoff so a stuck queue can't grow unbounded
   in silence. **[client + observe against backend]**
6. **Idle-detection accuracy.** `getSystemIdleTime()` over-reports on Wayland.
   Cross-check against real input signals; make the threshold sane and
   configurable. **[client]**

## P0 — Time integrity

7. **Timezone correctness.** Move to offset-bearing timestamps so the server
   never guesses — **blocked on the backend** (the last attempt caused spurious
   FORCE_CLOCKOUT; `timeUtils.ts` is pinned to legacy). Coordinated client+server
   change, per `backend-punching-fixes.md` §2.1. **[client + server]**
8. **Clock-tamper detection.** A user can change the system clock to fake hours.
   Compare system time against server time (returned in responses) and a
   monotonic clock; flag large jumps. **[client + small server field]**

## P1 — Session lifecycle (no phantom or overnight sessions)

9. **Crash recovery.** If the app is killed while clocked in, recover cleanly on
   next launch using last-active time (the `session.json` self-heal exists but
   implies mismatches happen — harden it). **[client]**
10. **Accurate clock-out timestamp on shutdown/sleep.** Stamp the clock-out at
    **last-active** time, not the reboot moment, so an idle gap before an
    overnight reboot isn't counted as worked. **[client]**
11. **Single-instance lock.** Prevent two copies running and double-counting.
    **[client]**

## P1 — Resolve the two open mysteries

12. **Manual-time "starts by itself."** Diagnostics are already in place; capture
    the log (`ns-ventures --no-sandbox 2>&1 | tee ~/nsv-debug.log`), find the
    trigger, fix it. **[client — needs the log]**
13. **Force-clockout correctness.** The grace-window heuristics work but are
    fragile; validate against real admin force-clockouts. **[client + server
    behaviour]**

## P2 — Observability & anti-evasion

14. **Structured file logging + crash reporting.** Rolling logs (started with
    `[updater]` / `[lifecycle]`) plus a crash reporter so field crashes in
    main/renderer are captured, not silent. **[client]**
15. **Health heartbeat.** A lightweight periodic "I'm alive" signal so the server
    can tell a dead machine from an idle one — today there is **no heartbeat**, so
    a crashed tracker looks identical to a working-but-quiet one. **[needs a
    server endpoint]**
16. **Tamper signals (best-effort).** Detect app-kill (auto-relaunch via OS
    service), network blocking, VM, clock changes — report rather than prevent.
    Honest ceiling: can't stop an admin. **[client + server]**

## P3 — Confidence

17. **Automated tests.** The `Test` CI workflow is currently **red on every
    commit**. Fix it, then add unit tests for the activity state machine,
    timezone formatting, and offline-replay/dedup logic — the exact areas that
    keep producing field bugs. **[client]**
18. **Cross-platform soak test + QA checklist** before each release. **[process]**

---

## Needs the backend (can't be done in this repo)

Idempotency dedup (#1), timezone normalization (#7), server-time for tamper
detection (#8), the heartbeat endpoint (#15). These map to
`backend-punching-fixes.md`; each can be turned into a precise server task.

## Blocked on input, not code

- Manual-time mystery (#12) — needs `~/nsv-debug.log` from an affected machine.
- Timezone / idempotency dedup (#7, #1) — need the backend.

---

## Suggested sequence

1. **P0 Data Integrity (#1–3)** — stops silent corruption; highest payoff.
2. **P0 Capture Reliability (#4–6)** — closes the Wayland unknowns; most visible.
3. **P1 Lifecycle + mysteries (#9–12)** — kills false/phantom sessions.
4. **P2 Observability (#14–15)** — makes the remaining failures visible.
5. **P3 Tests (#17)** — locks the gains in so they don't regress.
