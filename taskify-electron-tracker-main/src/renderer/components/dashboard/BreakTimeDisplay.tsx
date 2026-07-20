import React from 'react';
import { formatMilliseconds } from '../../utils/timeUtils';

interface BreakTimeDisplayProps {
  totalBreakTime: number;
  remainingBreakTime: number;
  maxBreakTime: number;
  currentBreakDuration: number;
  isOnBreak: boolean;
}

function BreakTimeDisplay({
  totalBreakTime,
  remainingBreakTime,
  maxBreakTime,
  currentBreakDuration,
  isOnBreak,
}: BreakTimeDisplayProps): React.ReactElement {
  return (
    <div className="break-time-display">
      <div className="break-time-row">
        <div className="break-time-label">Total Break Time:</div>
        <div className="break-time-value">
          {formatMilliseconds(totalBreakTime)}
        </div>
      </div>
      <div className="break-time-row">
        <div className="break-time-label">Remaining Break Time:</div>
        <div className="break-time-value">
          {formatMilliseconds(remainingBreakTime)}
        </div>
      </div>
      {isOnBreak && (
        <div className="break-time-row">
          <div className="break-time-label">Current Break Duration:</div>
          <div className="break-time-value">
            {formatMilliseconds(currentBreakDuration)}
          </div>
        </div>
      )}
      <div className="break-time-progress">
        <div
          className="break-time-progress-bar"
          style={{
            width: `${maxBreakTime > 0 ? Math.min(100, (totalBreakTime / maxBreakTime) * 100) : 0}%`,
            backgroundColor:
              remainingBreakTime > 0
                ? 'var(--accent-color)'
                : 'var(--danger-color)',
          }}
        />
      </div>
    </div>
  );
}

export default BreakTimeDisplay;
