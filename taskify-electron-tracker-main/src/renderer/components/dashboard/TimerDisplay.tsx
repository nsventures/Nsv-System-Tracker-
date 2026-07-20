import React from 'react';
import { formatElapsedTime } from '../../utils/timeUtils';

interface TimerDisplayProps {
  elapsedTime: number;
}

function TimerDisplay({ elapsedTime }: TimerDisplayProps): React.ReactElement {
  return (
    <div className="timer-display">
      <div className="timer-label">Time Elapsed:</div>
      <div className="timer-value">{formatElapsedTime(elapsedTime)}</div>
    </div>
  );
}

export default TimerDisplay;
