/**
 * Durable-queue retry policy, extracted as pure functions so the sync loop's
 * backoff/dead-letter behaviour can be unit-tested without the network layer.
 *
 * Terminal 4xx rejections are dropped elsewhere; what these govern are transient
 * failures (5xx / network), which we want to keep retrying so a long outage
 * never loses a punch. The cap is therefore a high safety valve for a genuinely
 * poison item, not a quick give-up, and retries are spaced out so a failing item
 * doesn't re-hit the server on every 60s cycle.
 */
export const MAX_SYNC_ATTEMPTS = 50;

export function syncBackoffMs(attempts: number): number {
  // Exponential, capped at 30 min: ~2s, 4s, 8s … then 30m per attempt.
  const safeAttempts = Number.isFinite(attempts) ? Math.max(0, attempts) : 0;
  return Math.min(2 ** Math.min(safeAttempts, 11) * 1000, 30 * 60 * 1000);
}

export function isInBackoff(
  item: { attempts?: number; lastAttemptAt?: number },
  now: number = Date.now(),
): boolean {
  if (!item.attempts || !item.lastAttemptAt) return false;
  return now - item.lastAttemptAt < syncBackoffMs(item.attempts);
}
