/**
 * Login throttle. Two keys are counted separately and both must be clear: the client
 * address (stops one machine walking a dictionary) and the account (stops a botnet walking
 * the same one). Failures escalate the lockout; a success clears both counters.
 *
 * In memory on purpose: this is a single-process, single-owner service, and a restart
 * clearing the counters is a worse outcome for an attacker than for the owner, who has the
 * password. Nothing here ever holds an email or a password, only their hashes.
 */

/** Failures tolerated before the first lockout. */
export const FREE_ATTEMPTS = 5;
const FIRST_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** A quiet stretch this long forgets the failures entirely. */
const WINDOW_MS = 15 * 60_000;

interface Counter {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export class LoginThrottle {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Seconds the caller must wait, or 0 when any of these keys is free to try. */
  retryAfter(keys: string[]): number {
    const t = this.now().getTime();
    let wait = 0;
    for (const key of keys) {
      const counter = this.counters.get(key);
      if (!counter) continue;
      if (t - counter.lastFailureAt > WINDOW_MS) {
        this.counters.delete(key);
        continue;
      }
      if (counter.lockedUntil > t)
        wait = Math.max(wait, Math.ceil((counter.lockedUntil - t) / 1000));
    }
    return wait;
  }

  /** Records a failure against every key and returns the new wait in seconds. */
  fail(keys: string[]): number {
    const t = this.now().getTime();
    let wait = 0;
    for (const key of keys) {
      const previous = this.counters.get(key);
      const stale = previous !== undefined && t - previous.lastFailureAt > WINDOW_MS;
      const failures = (stale || !previous ? 0 : previous.failures) + 1;
      const over = failures - FREE_ATTEMPTS;
      const lockMs = over >= 0 ? Math.min(FIRST_LOCK_MS * 2 ** over, MAX_LOCK_MS) : 0;
      this.counters.set(key, { failures, lockedUntil: t + lockMs, lastFailureAt: t });
      if (lockMs > 0) wait = Math.max(wait, Math.ceil(lockMs / 1000));
    }
    return wait;
  }

  /** A correct password clears the slate for this address and this account. */
  succeed(keys: string[]): void {
    for (const key of keys) this.counters.delete(key);
  }
}
