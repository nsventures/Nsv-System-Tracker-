import { MAX_SYNC_ATTEMPTS, syncBackoffMs, isInBackoff } from './syncBackoff';

describe('syncBackoffMs', () => {
  it('grows exponentially from ~2s', () => {
    expect(syncBackoffMs(1)).toBe(2_000);
    expect(syncBackoffMs(2)).toBe(4_000);
    expect(syncBackoffMs(3)).toBe(8_000);
    expect(syncBackoffMs(4)).toBe(16_000);
  });

  it('caps at 30 minutes so backoff never runs away', () => {
    const cap = 30 * 60 * 1000;
    expect(syncBackoffMs(11)).toBe(cap);
    expect(syncBackoffMs(50)).toBe(cap);
    expect(syncBackoffMs(1000)).toBe(cap);
  });

  it('is monotonic non-decreasing across attempts', () => {
    for (let n = 1; n < 60; n += 1) {
      expect(syncBackoffMs(n + 1)).toBeGreaterThanOrEqual(syncBackoffMs(n));
    }
  });

  it('handles zero and bad input without throwing', () => {
    expect(syncBackoffMs(0)).toBe(1_000);
    expect(syncBackoffMs(-5)).toBe(1_000);
    expect(syncBackoffMs(NaN)).toBe(1_000);
  });
});

describe('isInBackoff', () => {
  const now = 1_000_000_000_000;

  it('is not in backoff for a never-attempted item', () => {
    expect(isInBackoff({}, now)).toBe(false);
    expect(isInBackoff({ attempts: 0 }, now)).toBe(false);
    expect(isInBackoff({ attempts: 3 }, now)).toBe(false); // no lastAttemptAt
  });

  it('is in backoff immediately after an attempt', () => {
    // attempt 3 → 8s window; 1s after the attempt is still inside it.
    const item = { attempts: 3, lastAttemptAt: now - 1_000 };
    expect(isInBackoff(item, now)).toBe(true);
  });

  it('leaves backoff once the window has elapsed', () => {
    // attempt 3 → 8s window; 9s after the attempt is past it.
    const item = { attempts: 3, lastAttemptAt: now - 9_000 };
    expect(isInBackoff(item, now)).toBe(false);
  });

  it('respects the 30-minute cap at high attempt counts', () => {
    const justInside = { attempts: 40, lastAttemptAt: now - (30 * 60 * 1000 - 1) };
    const justOutside = { attempts: 40, lastAttemptAt: now - (30 * 60 * 1000 + 1) };
    expect(isInBackoff(justInside, now)).toBe(true);
    expect(isInBackoff(justOutside, now)).toBe(false);
  });
});

describe('MAX_SYNC_ATTEMPTS', () => {
  it('is a high safety cap, not a quick give-up', () => {
    // Deliberately high so a real outage keeps retrying rather than dropping
    // punches; only a genuinely poison item ever reaches it.
    expect(MAX_SYNC_ATTEMPTS).toBeGreaterThanOrEqual(20);
  });
});
