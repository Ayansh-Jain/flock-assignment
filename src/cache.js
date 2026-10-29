/** Property on a response body carrying its cache state; the app turns it into `X-Cache`. */
export const CACHE_STATE = Symbol('cacheState');

/**
 * Defaults for the live-read cache. The TTL reasons are in the README ("Caching & freshness");
 * config.js takes its defaults from here so there is one source of truth.
 */
export const DEFAULT_CACHE_OPTIONS = Object.freeze({
  maxEntries: 500,
  staleGraceMs: 15 * 60_000,
  ttlMs: Object.freeze({
    meter: 5 * 60_000,
    energy: 2 * 60_000,
    transformers: 30 * 60_000,
    export: 10 * 60_000,
  }),
});

/**
 * @typedef {'HIT' | 'MISS' | 'STALE'} CacheState
 * @typedef {{ value: any, state: CacheState, fetchedAtMs: number }} CacheResult
 */

/**
 * A small bounded TTL + LRU cache with request coalescing and a stale-on-error fallback, for
 * LIVE portal reads only (the SQLite index has its own freshness: `synced_at`).
 *
 * - TTL is chosen per call, so one cache serves every kind of data.
 * - At `maxEntries` the least recently used entry is dropped (a Map keeps insertion order, and a
 *   hit re-inserts the key).
 * - Concurrent misses for one key share a single load.
 * - If a load fails with an error `serveStaleOn` accepts, and an entry expired less than
 *   `staleGraceMs` ago is held, that entry is returned as STALE instead of the error.
 * - A fault in the store itself is logged and treated as a miss; it never fails a request.
 * - Values are shared between callers: treat them as read-only.
 *
 * @param {object} options
 * @param {number} options.maxEntries
 * @param {number} options.staleGraceMs How long past its TTL an entry may still be served on error.
 * @param {(error: unknown) => boolean} options.serveStaleOn Which load failures may fall back to stale data.
 * @param {{ warn: Function }} options.logger
 * @param {() => number} [options.now] Clock in epoch ms; injectable for tests.
 * @param {Map<string, { value: any, storedAt: number }>} [options.store] Injectable for tests.
 */
export function createCache({
  maxEntries,
  staleGraceMs,
  serveStaleOn,
  logger,
  now = Date.now,
  store = new Map(),
}) {
  /** @type {Map<string, Promise<CacheResult>>} */
  const inflight = new Map();
  const counts = { hits: 0, misses: 0, stale: 0 };

  function read(key) {
    try {
      const entry = store.get(key);
      if (entry) {
        store.delete(key);
        store.set(key, entry); // most recently used goes last
      }
      return entry;
    } catch (error) {
      logger.warn({ err: error }, 'cache read failed; treating as a miss');
      return undefined;
    }
  }

  function write(key, entry) {
    try {
      store.delete(key);
      store.set(key, entry);
      while (store.size > maxEntries) store.delete(store.keys().next().value);
    } catch (error) {
      logger.warn({ err: error }, 'cache write failed; continuing without caching');
    }
  }

  async function load(key, ttlMs, expired, loader) {
    try {
      const value = await loader();
      const storedAt = now();
      if (ttlMs > 0) write(key, { value, storedAt });
      counts.misses += 1;
      return { value, state: 'MISS', fetchedAtMs: storedAt };
    } catch (error) {
      if (expired && serveStaleOn(error) && now() - expired.storedAt < ttlMs + staleGraceMs) {
        counts.stale += 1;
        logger.warn({ err: error, key }, 'serving stale cache entry after a failed refresh');
        return { value: expired.value, state: 'STALE', fetchedAtMs: expired.storedAt };
      }
      throw error;
    }
  }

  return {
    /**
     * Return the cached value for `key` if younger than `ttlMs`, else load it (once, however many
     * callers are waiting). A `ttlMs` of 0 disables storing for that call.
     *
     * @param {string} key
     * @param {number} ttlMs
     * @param {() => Promise<any>} loader
     * @returns {Promise<CacheResult>}
     */
    async fetch(key, ttlMs, loader) {
      const entry = read(key);
      if (entry && now() - entry.storedAt < ttlMs) {
        counts.hits += 1;
        return { value: entry.value, state: 'HIT', fetchedAtMs: entry.storedAt };
      }
      let flight = inflight.get(key);
      if (!flight) {
        flight = load(key, ttlMs, entry, loader);
        inflight.set(key, flight);
      }
      try {
        return await flight;
      } finally {
        // Every waiter clears it (idempotent), so it is removed even if `loader` threw synchronously.
        if (inflight.get(key) === flight) inflight.delete(key);
      }
    },

    /** Counters and size, for /health. */
    stats() {
      return { entries: store.size, ...counts };
    },
  };
}
