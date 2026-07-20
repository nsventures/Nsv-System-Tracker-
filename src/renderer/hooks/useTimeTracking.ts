import { useState, useEffect } from 'react';
import { activityService } from '../services';

interface UseTimeTrackingResult {
  elapsedTime: number;
  totalBreakTime: number;
  remainingBreakTime: number;
  maxBreakTime: number;
  currentBreakDuration: number;
  currentDateTime: Date;
}

function useTimeTracking(
  isClockedIn: boolean,
  clockInTime: Date | null,
  isOnBreak: boolean,
  historyDuration: number = 0,
): UseTimeTrackingResult {
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [totalBreakTime, setTotalBreakTime] = useState<number>(0);
  const [remainingBreakTime, setRemainingBreakTime] = useState<number>(0);
  const [maxBreakTime, setMaxBreakTime] = useState<number>(0);
  const [currentBreakDuration, setCurrentBreakDuration] = useState<number>(0);
  const [currentDateTime, setCurrentDateTime] = useState<Date>(new Date());

  // Timer effect to update elapsed time every second
  useEffect(() => {
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    const updateTimer = () => {
      // Update current date and time
      setCurrentDateTime(new Date());

      // Calculate total work time
      const breakTimeMs = activityService.getTotalBreakTime();
      let totalRawMs = historyDuration * 1000;

      if (isClockedIn && clockInTime) {
        const now = new Date();
        // Add current session duration
        totalRawMs += now.getTime() - clockInTime.getTime();
      }

      // Subtract break time from total raw time
      const adjustedElapsedMs = Math.max(0, totalRawMs - breakTimeMs);

      // Convert to seconds
      const elapsedSeconds = Math.floor(adjustedElapsedMs / 1000);
      setElapsedTime(elapsedSeconds);

      // Update break time information
      setTotalBreakTime(activityService.getTotalBreakTime());
      setRemainingBreakTime(activityService.getRemainingBreakTime());
      setMaxBreakTime(activityService.getMaxDailyBreakTime());

      // Sync break state with activity service
      const serviceBreakState = activityService.isUserOnBreak();
      if (serviceBreakState !== isOnBreak) {
        console.log(
          `[DEBUG] Timer: Syncing break state from service: ${serviceBreakState}`,
        );
      }

      if (serviceBreakState) {
        setCurrentBreakDuration(activityService.getCurrentBreakDuration());
      } else {
        setCurrentBreakDuration(0);
      }
    };

    // Initial update
    updateTimer();

    // Start interval
    timerInterval = setInterval(updateTimer, 1000);

    return () => {
      if (timerInterval) {
        clearInterval(timerInterval);
      }
    };
  }, [isClockedIn, clockInTime, isOnBreak, historyDuration]);

  return {
    elapsedTime,
    totalBreakTime,
    remainingBreakTime,
    maxBreakTime,
    currentBreakDuration,
    currentDateTime,
  };
}

export default useTimeTracking;
