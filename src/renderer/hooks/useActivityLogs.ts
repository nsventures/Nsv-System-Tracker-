import { useState, useEffect, useCallback } from 'react';
import { ActivityLog } from '../types';
import { databaseService } from '../services';
import { deriveClockState } from '../utils/clockState';

interface UseActivityLogsResult {
  activityLogs: ActivityLog[];
  isClockedIn: boolean;
  isOnBreak: boolean;
  clockInTime: Date | null;
  historyDuration: number; // Duration of completed sessions today in seconds
  unsyncedCount: number;
  refreshLogs: () => Promise<void>;
}

function useActivityLogs(userId: number | undefined): UseActivityLogsResult {
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [isClockedIn, setIsClockedIn] = useState<boolean>(false);
  const [isOnBreak, setIsOnBreak] = useState<boolean>(false);
  const [clockInTime, setClockInTime] = useState<Date | null>(null);
  const [historyDuration, setHistoryDuration] = useState<number>(0);
  const [unsyncedCount, setUnsyncedCount] = useState<number>(0);

  // Function to refresh logs
  const refreshLogs = useCallback(async () => {
    if (!userId) return;

    try {
      // Get all activity logs
      const logs = await databaseService.getActivityLogs();
      console.log(
        `[DEBUG] useActivityLogs: Retrieved ${logs.length} total activity logs`,
      );

      // Filter logs for the current user
      const userLogs = logs.filter((log) => log.user_id === userId);
      console.log(
        `[DEBUG] useActivityLogs: Found ${userLogs.length} logs for user ID: ${userId}`,
      );

      // Set activity logs for display (last 10 in reverse order)
      setActivityLogs(userLogs.slice(-10).reverse());

      // Check if user is clocked in
      const userClockLogs = userLogs
        .filter(
          (log) => log.action === 'clock-in' || log.action === 'clock-out',
        )
        .sort(
          (a, b) =>
            new Date(b.timestamp.replace(/\s/, 'T')).getTime() -
            new Date(a.timestamp.replace(/\s/, 'T')).getTime(),
        );

      console.log(
        `[DEBUG] useActivityLogs: Found ${userClockLogs.length} clock logs for user ID: ${userId}`,
      );

      // Calculate history duration (sum of completed sessions today)
      let calculatedHistoryDuration = 0;
      const todayDateString = new Date().toDateString();

      // Sort chronological to process pairs
      const chronologicalLogs = [...userClockLogs].sort(
        (a, b) =>
          new Date(a.timestamp.replace(/\s/, 'T')).getTime() -
          new Date(b.timestamp.replace(/\s/, 'T')).getTime(),
      );

      for (let i = 0; i < chronologicalLogs.length; i++) {
        const log = chronologicalLogs[i];
        // Parse time carefully
        const logTime = new Date(log.timestamp.replace(/\s/, 'T'));

        // Only count today's logs
        if (logTime.toDateString() !== todayDateString) continue;

        if (log.action === 'clock-in') {
          // Check if next log represents the end of this session
          if (i + 1 < chronologicalLogs.length) {
            const nextLog = chronologicalLogs[i + 1];
            if (nextLog.action === 'clock-out') {
              const outTime = new Date(nextLog.timestamp.replace(/\s/, 'T'));
              calculatedHistoryDuration +=
                outTime.getTime() - logTime.getTime();
              i++; // Skip the clock-out log
            }
          }
        }
      }

      setHistoryDuration(Math.floor(calculatedHistoryDuration / 1000));
      console.log(
        `[DEBUG] useActivityLogs: Calculated history duration: ${calculatedHistoryDuration}ms`,
      );

      // Clock state comes from the shared helper so this hook and the activity
      // service cannot disagree. See utils/clockState.ts.
      const {
        isClockedIn: isCurrentlyClocked,
        clockInTime: derivedClockInTime,
      } = deriveClockState(userLogs, userId);
      console.log(
        `[DEBUG] useActivityLogs: User is ${
          isCurrentlyClocked ? 'clocked in' : 'not clocked in'
        }`,
      );
      setIsClockedIn(isCurrentlyClocked);
      setClockInTime(derivedClockInTime);

      // Check if user is on break
      const userBreakLogs = userLogs
        .filter(
          (log) => log.action === 'break-start' || log.action === 'break-stop',
        )
        .sort(
          (a, b) =>
            new Date(b.timestamp.replace(/\s/, 'T')).getTime() -
            new Date(a.timestamp.replace(/\s/, 'T')).getTime(),
        );

      console.log(
        `[DEBUG] useActivityLogs: Found ${userBreakLogs.length} break logs for user ID: ${userId}`,
      );

      if (userBreakLogs.length > 0) {
        const lastBreakLog = userBreakLogs[0];
        console.log(
          `[DEBUG] useActivityLogs: Last break log: ${JSON.stringify(lastBreakLog)}`,
        );
        let isOnBreakNow = lastBreakLog.action === 'break-start';

        // Mirror the clock-in guard above: a break-start left open from a
        // PREVIOUS day is stale (the break should have closed at day end), so
        // never carry it into today. Without this, an orphaned prior-day
        // break-start keeps the UI stuck showing "End Break" indefinitely — and
        // because activity.ts already ignores it, clicking End Break no-ops.
        const lastBreakTime = new Date(
          lastBreakLog.timestamp.replace(/\s/, 'T'),
        );
        if (isOnBreakNow && lastBreakTime.toDateString() !== todayDateString) {
          console.log(
            '[DEBUG] useActivityLogs: Last break-start is from a previous day. Forcing not-on-break state locally.',
          );
          isOnBreakNow = false;
        }

        console.log(
          `[DEBUG] useActivityLogs: User is ${isOnBreakNow ? 'on break' : 'not on break'}`,
        );
        setIsOnBreak(isOnBreakNow);
      } else {
        console.log(
          '[DEBUG] useActivityLogs: No break logs found for this user, user is not on break',
        );
        setIsOnBreak(false);
      }

      // Count unsynced logs
      const unsynced = await databaseService.getUnsyncedActivityLogs();
      setUnsyncedCount(unsynced.length);
    } catch (error) {
      console.error('[DEBUG] useActivityLogs: Error refreshing logs:', error);
    }
  }, [userId]);

  // Load logs on mount and when userId changes
  useEffect(() => {
    if (userId) {
      refreshLogs();
    }
  }, [userId, refreshLogs]);

  return {
    activityLogs,
    isClockedIn,
    isOnBreak,
    clockInTime,
    historyDuration,
    unsyncedCount,
    refreshLogs,
  };
}

export default useActivityLogs;
