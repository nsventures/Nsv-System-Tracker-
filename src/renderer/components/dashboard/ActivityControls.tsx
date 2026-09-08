import React from 'react';

interface ActivityControlsProps {
  isClockedIn: boolean;
  isOnBreak: boolean;
  isOnManualTime: boolean;
  remainingBreakTime: number;
  onClockInOut: () => void;
  onBreak: () => void;
  onManualTime: () => void;
}

function ActivityControls({
  isClockedIn,
  isOnBreak,
  isOnManualTime,
  remainingBreakTime,
  onClockInOut,
  onBreak,
  onManualTime,
}: ActivityControlsProps): React.ReactElement {
  return (
    <div className="activity-controls">
      <button
        onClick={onClockInOut}
        className={`clock-button ${isClockedIn ? 'clocked-in' : ''}`}
        type="button"
      >
        {isClockedIn ? 'Clock Out' : 'Clock In'}
      </button>

      <button
        onClick={onBreak}
        className={`break-button ${isOnBreak ? 'on-break' : ''}`}
        disabled={!isClockedIn || (!isOnBreak && remainingBreakTime <= 0)}
        type="button"
      >
        {isOnBreak ? 'End Break' : 'Start Break'}
      </button>

      <button
        onClick={onManualTime}
        className={`manual-button ${isOnManualTime ? 'on-manual' : ''}`}
        disabled={!isClockedIn}
        type="button"
      >
        {isOnManualTime ? 'End Manual Time' : 'Start Manual Time'}
      </button>
    </div>
  );
}

export default ActivityControls;
