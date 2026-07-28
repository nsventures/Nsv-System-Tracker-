import { ActivityLog } from '../types';

/**
 * The single source of truth for "is this user currently clocked in?".
 *
 * Clock state was previously derived independently in two places
 * (activity.ts `isUserClockedIn` and the useActivityLogs hook). Any drift
 * between those two implementations produced a UI that disagreed with the
 * service — e.g. the dashboard showing clocked-out while the service kept
 * capturing. Both now call this one function so they cannot diverge.
 */
export interface ClockState {
  isClockedIn: boolean;
  clockInTime: Date | null;
  lastClockLog: ActivityLog | null;
}

// Timestamps are stored as "YYYY-MM-DD HH:MM:SS" (naive local). Replacing the
// space with 'T' lets Date parse them consistently across engines.
const parseTimestamp = (timestamp: string): number =>
  new Date(timestamp.replace(/\s/, 'T')).getTime();

export function deriveClockState(
  logs: ActivityLog[],
  userId: number,
  now: Date = new Date(),
): ClockState {
  const clockLogs = logs
    .filter(
      (log) =>
        log.user_id === userId &&
        (log.action === 'clock-in' || log.action === 'clock-out'),
    )
    .sort((a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp));

  if (clockLogs.length === 0) {
    return { isClockedIn: false, clockInTime: null, lastClockLog: null };
  }

  const lastClockLog = clockLogs[0];
  let isClockedIn = lastClockLog.action === 'clock-in';
  const lastClockTime = new Date(lastClockLog.timestamp.replace(/\s/, 'T'));

  // A clock-in left open from a previous calendar day is treated as closed
  // locally — the server closes the day at its own boundary, and counting it as
  // still-open would inflate hours across midnight.
  if (isClockedIn && lastClockTime.toDateString() !== now.toDateString()) {
    isClockedIn = false;
  }

  return {
    isClockedIn,
    clockInTime: isClockedIn ? lastClockTime : null,
    lastClockLog,
  };
}

export default deriveClockState;
