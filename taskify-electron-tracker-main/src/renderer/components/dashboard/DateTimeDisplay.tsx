import React from 'react';
import { whiteLabelConfig } from '../../../whiteLabel.config';

interface DateTimeDisplayProps {
  currentDateTime: Date;
}

function DateTimeDisplay({
  currentDateTime,
}: DateTimeDisplayProps): React.ReactElement {
  return (
    <div className="date-time-display">
      <div className="date-time-label">Current Date & Time</div>
      <div className="date-time-value">
        {currentDateTime.toLocaleDateString(
          undefined,
          whiteLabelConfig.timezone.dateFormatOptions,
        )}
      </div>
      <div className="date-time-value time">
        {currentDateTime.toLocaleTimeString(
          undefined,
          whiteLabelConfig.timezone.timeFormatOptions,
        )}
      </div>
    </div>
  );
}

export default DateTimeDisplay;
