import { deriveClockState } from './clockState';
import { ActivityLog } from '../types';

// Build a minimal activity log; only the fields deriveClockState reads matter.
const log = (
  action: ActivityLog['action'],
  timestamp: string,
  user_id = 1,
): ActivityLog => ({ user_id, action, timestamp, synced: true });

const TODAY = new Date('2026-07-28T12:00:00');

describe('deriveClockState', () => {
  it('reports not-clocked-in when there are no logs', () => {
    const state = deriveClockState([], 1, TODAY);
    expect(state.isClockedIn).toBe(false);
    expect(state.clockInTime).toBeNull();
    expect(state.lastClockLog).toBeNull();
  });

  it('is clocked in when the latest event today is a clock-in', () => {
    const logs = [
      log('clock-in', '2026-07-28 09:00:00'),
      log('clock-out', '2026-07-28 10:00:00'),
      log('clock-in', '2026-07-28 10:30:00'),
    ];
    const state = deriveClockState(logs, 1, TODAY);
    expect(state.isClockedIn).toBe(true);
    expect(state.clockInTime).toEqual(new Date('2026-07-28T10:30:00'));
  });

  it('is clocked out when the latest event is a clock-out', () => {
    const logs = [
      log('clock-in', '2026-07-28 09:00:00'),
      log('clock-out', '2026-07-28 11:00:00'),
    ];
    const state = deriveClockState(logs, 1, TODAY);
    expect(state.isClockedIn).toBe(false);
    expect(state.clockInTime).toBeNull();
  });

  it('does not depend on the input order of the logs', () => {
    const ordered = [
      log('clock-in', '2026-07-28 09:00:00'),
      log('clock-in', '2026-07-28 10:30:00'),
      log('clock-out', '2026-07-28 10:00:00'),
    ];
    // Same set, shuffled — result must be identical (latest wins by timestamp).
    const shuffled = [ordered[2], ordered[0], ordered[1]];
    expect(deriveClockState(ordered, 1, TODAY).isClockedIn).toBe(
      deriveClockState(shuffled, 1, TODAY).isClockedIn,
    );
    expect(deriveClockState(shuffled, 1, TODAY).isClockedIn).toBe(true);
  });

  it('treats a clock-in left open from a previous day as clocked out', () => {
    const logs = [log('clock-in', '2026-07-27 22:00:00')];
    const state = deriveClockState(logs, 1, TODAY);
    expect(state.isClockedIn).toBe(false);
    expect(state.clockInTime).toBeNull();
  });

  it('ignores clock events belonging to a different user', () => {
    const logs = [
      log('clock-in', '2026-07-28 09:00:00', 1),
      log('clock-out', '2026-07-28 11:00:00', 2), // user 2's clock-out
    ];
    // For user 1, only their own clock-in exists → still clocked in.
    expect(deriveClockState(logs, 1, TODAY).isClockedIn).toBe(true);
    // For user 2, only their clock-out exists → clocked out.
    expect(deriveClockState(logs, 2, TODAY).isClockedIn).toBe(false);
  });

  it('ignores non-clock actions when deciding state', () => {
    const logs = [
      log('clock-in', '2026-07-28 09:00:00'),
      log('break-start', '2026-07-28 09:30:00'),
      log('idle-start', '2026-07-28 09:45:00'),
    ];
    const state = deriveClockState(logs, 1, TODAY);
    expect(state.isClockedIn).toBe(true);
    expect(state.lastClockLog?.action).toBe('clock-in');
  });
});
