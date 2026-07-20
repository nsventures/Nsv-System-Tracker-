export const formatElapsedTime = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    remainingSeconds.toString().padStart(2, '0'),
  ].join(':');
};

export const formatMilliseconds = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return formatElapsedTime(seconds);
};

export const getActionText = (action: string): string => {
  switch (action) {
    case 'clock-in':
      return 'Clocked In';
    case 'clock-out':
      return 'Clocked Out';
    case 'idle-start':
      return 'Idle Started';
    case 'idle-stop':
      return 'Idle Stopped';
    case 'break-start':
      return 'Break Started';
    case 'break-stop':
      return 'Break Stopped';
    case 'manual-processing-start':
      return 'Manual Time Started';
    case 'manual-processing-stop':
      return 'Manual Time Stopped';
    default:
      return action;
  }
};
