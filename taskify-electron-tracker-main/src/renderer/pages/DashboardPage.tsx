import React, { useState } from 'react';
import { useAuth } from '../context';
import { activityService } from '../services';
import ReasonModal from '../components/modals/ReasonModal';
import DateTimeDisplay from '../components/dashboard/DateTimeDisplay';
import TimerDisplay from '../components/dashboard/TimerDisplay';
import BreakTimeDisplay from '../components/dashboard/BreakTimeDisplay';
import ActivityControls from '../components/dashboard/ActivityControls';
import ActivityLogList from '../components/dashboard/ActivityLogList';
import UserHeader from '../components/dashboard/UserHeader';
import useActivityLogs from '../hooks/useActivityLogs';
import useTimeTracking from '../hooks/useTimeTracking';

function DashboardPage(): React.ReactElement | null {
  const { auth, logout } = useAuth();
  const [isOnManualTime, setIsOnManualTime] = useState(false);
  const [isReasonModalOpen, setIsReasonModalOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [theme, setTheme] = useState<string>(
    localStorage.getItem('theme') || 'light',
  );

  const userId = auth?.user?.user_id;

  const {
    activityLogs,
    isClockedIn,
    isOnBreak,
    clockInTime,
    historyDuration,
    refreshLogs,
  } = useActivityLogs(userId);

  const {
    elapsedTime,
    totalBreakTime,
    remainingBreakTime,
    maxBreakTime,
    currentBreakDuration,
    currentDateTime,
  } = useTimeTracking(isClockedIn, clockInTime, isOnBreak, historyDuration);

  const toggleDropdown = () => {
    setIsDropdownOpen(!isDropdownOpen);
  };

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    document.body.classList.toggle('dark-theme');
  };

  // Handle clock in/out
  const handleClockInOut = async () => {
    if (isClockedIn) {
      await activityService.clockOut();
    } else {
      await activityService.clockIn();
    }
    await refreshLogs();
  };

  // Handle break start/stop
  const handleBreak = async () => {
    if (isOnBreak) {
      await activityService.stopBreakManually();
    } else {
      await activityService.startBreakManually();
    }
    await refreshLogs();
  };

  // Handle manual time start/stop
  const handleManualTime = async () => {
    if (isOnManualTime) {
      setIsReasonModalOpen(true);
    } else {
      await activityService.startManualTime();
      setIsOnManualTime(true);
      await refreshLogs();
    }
  };

  // Handle reason submission for manual time stop
  const handleReasonSubmit = async (reason: string) => {
    await activityService.stopManualTime(reason);
    setIsOnManualTime(false);
    setIsReasonModalOpen(false);
    await refreshLogs();
  };

  // Listen for automatic break end event
  React.useEffect(() => {
    const handleBreakEnded = () => {
      // eslint-disable-next-line no-console
      console.log('[Dashboard] Break ended automatically, refreshing logs');
      refreshLogs();
    };

    const handleForceClockout = () => {
      // eslint-disable-next-line no-console
      console.log('[Dashboard] Force clockout event received, refreshing logs');
      refreshLogs();
    };

    window.addEventListener('break-ended', handleBreakEnded);
    window.addEventListener('force-clockout', handleForceClockout);
    return () => {
      window.removeEventListener('break-ended', handleBreakEnded);
      window.removeEventListener('force-clockout', handleForceClockout);
    };
  }, [refreshLogs]);

  if (!auth) {
    return null;
  }

  return (
    <div className="dashboard-container">
      <UserHeader
        user={auth.user}
        theme={theme}
        isDropdownOpen={isDropdownOpen}
        toggleDropdown={toggleDropdown}
        toggleTheme={toggleTheme}
        logout={logout}
      />

      <DateTimeDisplay currentDateTime={currentDateTime} />

      <TimerDisplay elapsedTime={elapsedTime} />

      <BreakTimeDisplay
        totalBreakTime={totalBreakTime}
        remainingBreakTime={remainingBreakTime}
        maxBreakTime={maxBreakTime}
        currentBreakDuration={currentBreakDuration}
        isOnBreak={isOnBreak}
      />

      <ActivityControls
        isClockedIn={isClockedIn}
        isOnBreak={isOnBreak}
        isOnManualTime={isOnManualTime}
        onClockInOut={handleClockInOut}
        onBreak={handleBreak}
        onManualTime={handleManualTime}
      />

      {/* Reason Modal for Manual Time Stop */}
      <ReasonModal
        isOpen={isReasonModalOpen}
        onClose={() => setIsReasonModalOpen(false)}
        onSubmit={handleReasonSubmit}
      />

      <ActivityLogList activityLogs={activityLogs} />
    </div>
  );
}

export default DashboardPage;
