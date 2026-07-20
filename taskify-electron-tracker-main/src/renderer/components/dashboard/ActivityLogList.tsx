import React from 'react';
import { ActivityLog } from '../../types';
import { getActionText } from '../../utils/timeUtils';
import { whiteLabelConfig } from '../../../whiteLabel.config';

interface ActivityLogListProps {
  activityLogs: ActivityLog[];
}

function ActivityLogList({
  activityLogs,
}: ActivityLogListProps): React.ReactElement {
  // Format timestamp for display with consistent timezone
  const formatTimestamp = (timestamp: string): string => {
    const date = new Date(timestamp);
    return date.toLocaleString(
      undefined,
      whiteLabelConfig.timezone.dateTimeFormatOptions,
    );
  };

  return (
    <div className="activity-log">
      <h2>Recent Activity</h2>
      {activityLogs.length === 0 ? (
        <p>No activity recorded yet.</p>
      ) : (
        <ul className="log-list">
          {activityLogs.map((log) => (
            <li
              key={log.id}
              className={`log-item ${!log.synced ? 'unsynced' : ''}`}
              data-action={log.action}
            >
              <div className="log-action">{getActionText(log.action)}</div>
              <div className="log-time">{formatTimestamp(log.timestamp)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ActivityLogList;
