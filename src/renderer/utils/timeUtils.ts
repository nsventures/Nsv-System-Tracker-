import { whiteLabelConfig } from '../../whiteLabel.config';

/**
 * Wire format for timestamps sent to the API.
 *
 * 'legacy' -> "2026-07-22 10:37:39"        naive; server assumes workspace tz
 * 'iso'    -> "2026-07-22T10:37:39+05:30"  explicit UTC offset, no guessing
 *
 * TEMPORARILY on 'legacy'. Switching to 'iso' coincided with the server
 * returning a spurious 403 FORCE_CLOCKOUT immediately after every clock-in,
 * so the wire format is pinned back to the form the server has always accepted
 * in order to isolate the variable. Flip to 'iso' only once the backend has
 * confirmed it stores and queries offset-bearing timestamps correctly
 * (see backend-punching-fixes.md §2.1).
 */
const API_TIMESTAMP_FORMAT: 'legacy' | 'iso' = 'legacy';

/**
 * Format a Date as the API timestamp, per API_TIMESTAMP_FORMAT above.
 */
export const formatApiTimestamp = (
  date: Date = new Date(),
  timeZone: string = whiteLabelConfig.timezone.default,
): string => {
  if (API_TIMESTAMP_FORMAT === 'legacy') {
    return date
      .toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone,
      })
      .replace(/(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/, '$3-$1-$2 $4:$5:$6');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 guarantees 00-23; h24 would render midnight as "24" and shift the day
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // 'longOffset' renders as "GMT+05:30", or bare "GMT" at zero offset
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
};

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
