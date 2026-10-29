import { PortalCircuitOpen } from './errors.js';

/**
 * Circuit breaker for the shared portal. After `threshold` consecutive failed requests it opens:
 * calls fail fast for `cooloffMs`, then one probe request is let through (half-open). A probe that
 * succeeds closes the circuit; one that fails re-opens it for another cool-off.
 *
 * @param {object} options
 * @param {number} options.threshold Consecutive failures that open the circuit.
 * @param {number} options.cooloffMs How long to fail fast before probing.
 * @param {() => number} [options.now] Clock in epoch ms; injectable for tests.
 */
export function createBreaker({ threshold, cooloffMs, now = Date.now }) {
  let failures = 0;
  let openedAt = null;
  let probing = false;

  const state = () => {
    if (openedAt === null) return 'closed';
    return now() - openedAt < cooloffMs ? 'open' : 'half-open';
  };

  return {
    /** @returns {'closed' | 'open' | 'half-open'} */
    state,

    /** Call before each request. Throws PortalCircuitOpen unless it may go ahead. */
    beforeRequest() {
      const current = state();
      if (current === 'closed') return;
      if (current === 'open' || probing) {
        const remainingMs = Math.max(0, cooloffMs - (now() - openedAt));
        throw new PortalCircuitOpen('Portal circuit is open', {
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        });
      }
      probing = true;
    },

    recordSuccess() {
      failures = 0;
      openedAt = null;
      probing = false;
    },

    recordFailure() {
      failures += 1;
      probing = false;
      if (failures >= threshold) openedAt = now();
    },
  };
}
