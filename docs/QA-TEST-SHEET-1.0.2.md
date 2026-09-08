# NS Ventures Tracker — QA Test Sheet v1.0.2

**Build:** `NS Ventures-1.0.2-win-x64.exe`  
**Path:** `release/build/NS Ventures-1.0.2-win-x64.exe`  
**Date range:** _______________  
**Test lead:** _______________

---

## How to use

1. Open **`QA-TEST-SHEET-1.0.2.csv`** in Excel or Google Sheets (same folder).
2. Fill **Pass/Fail**, **Tester Name**, **Test Date**, **Device/OS**, **Notes** per row.
3. Use **Priority**: P0 = must pass before rollout; P1 = important; P2 = nice to have.
4. Optional: run the SQL at the bottom after idle/break tests.

---

## Test environment log

| Field | Value |
|-------|--------|
| Tester name | |
| Machine name | |
| OS (e.g. Windows 11) | |
| App version | 1.0.2 |
| Network (online/offline/VPN) | |
| Admin idle threshold (minutes) | |
| Admin max daily break (minutes) | |
| Employee user_id tested | |

---

## Summary scorecard

| Category | Total tests | Pass | Fail | Blocked | % Pass |
|----------|-------------|------|------|---------|--------|
| Install & Setup | 3 | | | | |
| Config | 2 | | | | |
| Idle | 7 | | | | |
| Break | 10 | | | | |
| Clock In/Out | 3 | | | | |
| Sync | 2 | | | | |
| Admin Dashboard | 3 | | | | |
| Regression | 3 | | | | |
| **TOTAL** | **33** | | | | |

**Release recommendation:** ☐ Approve rollout  ☐ Fix required  ☐ Retest after patch

---

## P0 critical path (minimum before fleet rollout)

Must all **Pass**:

- INS-01, INS-03  
- IDL-01, IDL-02, IDL-03, IDL-04, IDL-05  
- BRK-02, BRK-03, BRK-04, BRK-05, BRK-06, BRK-07  
- ADM-01, ADM-02  

---

## Detailed test cases

### Install & Setup

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| INS-01 | Fresh install 1.0.2 | Run installer → launch | Version 1.0.2; app opens | | |
| INS-02 | Upgrade from 1.0.1 | Install over old build | No crash; login works | | |
| INS-03 | Login and clock in | Log in → Clock in | Timer starts | | |

### Config

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| CFG-01 | Idle threshold 5 min | 4 min no input → then 5+ min | Idle only after 5 min | | |
| CFG-02 | Offline then online | Start offline → reconnect | 5 min default; config reloads | | |

### Idle

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| IDL-01 | Idle after 5 min only | No input 4 min → 5+ min | No idle at 4 min | | |
| IDL-02 | Idle stops on activity | Idle → move mouse | idle-stop logged | | |
| IDL-03 | No 1-min flicker | Short pauses all day | No 00:01 idle bars | | |
| IDL-04 | Close on app restart | Idle → force close → reopen | idle-stop on startup | | |
| IDL-05 | Close on sleep/wake | Sleep → wake (not on break) | No endless idle | | |
| IDL-06 | No idle during break | On break, no input 10+ min | No idle-start | | |
| IDL-07 | Idle after break ends | End break → no input 5+ min | idle after 5 min | | |

### Break

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| BRK-01 | Start/stop break | Start → wait → End | Both events logged | | |
| BRK-02 | 1 hour cap | Use break until 1 h | Auto-end at 1:00:00 | | |
| BRK-03 | Total never > 1 h | Long break + sleep | UI total ≤ 01:00:00 | | |
| BRK-04 | Remaining = 0 | Full break used | 00:00:00; red bar | | |
| BRK-05 | Start disabled | At cap, click Start Break | Button disabled | | |
| BRK-06 | Cap after sleep | Break → sleep past 1 h → wake | Auto-end at cap | | |
| BRK-07 | Work timer after cap | After auto end | Active timer, not idle | | |
| BRK-08 | Break not idle | On break, no input | Break in admin, not idle | | |
| BRK-09 | Restore after restart | Break → close app → reopen | State + timer OK | | |
| BRK-10 | Clock out closes break | On break → Clock out | break-stop then clock-out | | |

### Clock In/Out

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| CLK-01 | Normal clock out | Clock out | Stops tracking | | |
| CLK-02 | Closes idle/break | Clock out while idle/break | Stops logged first | | |
| CLK-03 | Elapsed excludes break | Break during shift | Work time correct | | |

### Sync & Admin

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| SYNC-01 | Events in DB | Full flow → check admin | All events present | | |
| SYNC-02 | Offline sync | Offline events → online | Queue syncs | | |
| ADM-01 | No orphan idle | After tests | No open idle-start | | |
| ADM-02 | No orphan break | After tests | No open break-start | | |
| ADM-03 | Timeline match | App vs admin | Same times | | |

### Regression

| ID | Test | Steps | Expected | Pass/Fail | Notes |
|----|------|-------|----------|-----------|-------|
| REG-01 | Manual time | Start/stop manual | Events logged | | |
| REG-02 | Screenshots | Work 10+ min | Screenshots upload | | |
| REG-03 | Force clock-out | Admin force out | User notified | | |

---

## Defect log

| Defect # | Test ID | Severity | Description | Steps to reproduce | Screenshot/log | Status |
|----------|---------|----------|-------------|-------------------|----------------|--------|
| | | | | | | |
| | | | | | | |

---

## SQL checks (phpMyAdmin / MariaDB)

**Open orphans today:**

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

**Full day dump for test user:**

```sql
SELECT `timestamp`, action, reason
FROM time_tracker_activity_logs
WHERE user_id = YOUR_USER_ID
  AND DATE(`timestamp`) = CURDATE()
ORDER BY `timestamp`;
```

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| QA / Tester | | | |
| Dev | | | |
| Product / Admin | | | |
