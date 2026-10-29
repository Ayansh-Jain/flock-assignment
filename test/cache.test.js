import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCache } from '../src/cache.js';
import { createRecordingLogger } from './helpers.js';

const TTL = 1000;
const GRACE = 5000;

function setup(options = {}) {
  const clock = { ms: 0 };
  const logger = createRecordingLogger();
  const cache = createCache({
    maxEntries: 3,
    staleGraceMs: GRACE,
    serveStaleOn: () => true,
    logger,
    now: () => clock.ms,
    ...options,
  });
  return { cache, clock, logger };
}

/** A loader that counts calls and returns `value-<n>`. */
function counter() {
  const state = { calls: 0 };
  state.load = async () => {
    state.calls += 1;
    return `value-${state.calls}`;
  };
  return state;
}

describe('TTL', () => {
  test('MISS, then HIT until the TTL, then MISS again', async () => {
    const { cache, clock } = setup();
    const loader = counter();
    assert.equal((await cache.fetch('a', TTL, loader.load)).state, 'MISS');
    clock.ms = TTL - 1;
    const hit = await cache.fetch('a', TTL, loader.load);
    assert.deepEqual([hit.state, hit.value, hit.fetchedAtMs], ['HIT', 'value-1', 0]);
    clock.ms = TTL;
    const refreshed = await cache.fetch('a', TTL, loader.load);
    assert.deepEqual(
      [refreshed.state, refreshed.value, refreshed.fetchedAtMs],
      ['MISS', 'value-2', TTL],
    );
    assert.equal(loader.calls, 2);
  });

  test('the TTL is chosen per call, so kinds can differ for the same cache', async () => {
    const { cache, clock } = setup();
    const loader = counter();
    await cache.fetch('short', 100, loader.load);
    await cache.fetch('long', 10_000, loader.load);
    clock.ms = 500;
    assert.equal((await cache.fetch('short', 100, loader.load)).state, 'MISS');
    assert.equal((await cache.fetch('long', 10_000, loader.load)).state, 'HIT');
  });

  test('a TTL of 0 never stores', async () => {
    const { cache } = setup();
    const loader = counter();
    await cache.fetch('a', 0, loader.load);
    await cache.fetch('a', 0, loader.load);
    assert.equal(loader.calls, 2);
    assert.equal(cache.stats().entries, 0);
  });

  test('a failed load is not cached', async () => {
    const { cache } = setup();
    await assert.rejects(
      cache.fetch('a', TTL, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(cache.stats().entries, 0);
    assert.equal((await cache.fetch('a', TTL, async () => 'ok')).value, 'ok');
  });
});

describe('LRU bound', () => {
  test('evicts the least recently used entry at maxEntries', async () => {
    const { cache } = setup(); // maxEntries 3
    const loader = counter();
    for (const key of ['a', 'b', 'c']) await cache.fetch(key, TTL, loader.load);
    await cache.fetch('a', TTL, loader.load); // a is now the most recently used; b is the oldest
    await cache.fetch('d', TTL, loader.load); // evicts b
    assert.equal(cache.stats().entries, 3);
    const calls = loader.calls;
    for (const key of ['a', 'c', 'd']) {
      assert.equal((await cache.fetch(key, TTL, loader.load)).state, 'HIT', key);
    }
    assert.equal(loader.calls, calls);
    assert.equal((await cache.fetch('b', TTL, loader.load)).state, 'MISS');
  });

  test('never exceeds the bound however many keys are used', async () => {
    const { cache } = setup();
    for (let i = 0; i < 50; i += 1) await cache.fetch(`k${i}`, TTL, async () => i);
    assert.equal(cache.stats().entries, 3);
  });
});

describe('coalescing', () => {
  test('concurrent callers for one key share a single load', async () => {
    const { cache } = setup();
    let release;
    let calls = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      await gate;
      return 'shared';
    };
    const pending = Array.from({ length: 10 }, () => cache.fetch('a', TTL, loader));
    release();
    const results = await Promise.all(pending);
    assert.equal(calls, 1);
    assert.ok(results.every((result) => result.value === 'shared' && result.state === 'MISS'));
  });

  test('concurrent callers all see the failure, and the next call retries', async () => {
    const { cache } = setup();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('boom');
    };
    const outcomes = await Promise.allSettled([
      cache.fetch('a', TTL, failing),
      cache.fetch('a', TTL, failing),
      cache.fetch('a', TTL, failing),
    ]);
    assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
    assert.equal(calls, 1);
    assert.equal((await cache.fetch('a', TTL, async () => 'recovered')).value, 'recovered');
  });

  test('different keys load independently', async () => {
    const { cache } = setup();
    const loader = counter();
    await Promise.all([cache.fetch('a', TTL, loader.load), cache.fetch('b', TTL, loader.load)]);
    assert.equal(loader.calls, 2);
  });

  test('a loader that throws synchronously does not leave a stuck flight', async () => {
    const { cache } = setup();
    const broken = () => {
      throw new Error('sync boom');
    };
    await assert.rejects(cache.fetch('a', TTL, broken), /sync boom/);
    assert.equal((await cache.fetch('a', TTL, async () => 'fine')).value, 'fine');
  });
});

describe('stale on error', () => {
  async function primed(options) {
    const ctx = setup(options);
    await ctx.cache.fetch('a', TTL, async () => 'old');
    return ctx;
  }
  const failing = async () => {
    throw new Error('portal down');
  };

  test('serves the expired entry as STALE with its original timestamp', async () => {
    const { cache, clock, logger } = await primed();
    clock.ms = TTL + 10;
    const result = await cache.fetch('a', TTL, failing);
    assert.deepEqual([result.state, result.value, result.fetchedAtMs], ['STALE', 'old', 0]);
    assert.equal(cache.stats().stale, 1);
    assert.ok(logger.lines.some((line) => line.level === 'warn'));
  });

  test('does not serve it beyond TTL + grace', async () => {
    const { cache, clock } = await primed();
    clock.ms = TTL + GRACE;
    await assert.rejects(cache.fetch('a', TTL, failing), /portal down/);
  });

  test('errors the predicate rejects are rethrown even with a stale entry', async () => {
    const { cache, clock } = await primed({ serveStaleOn: (error) => error.message !== 'gone' });
    clock.ms = TTL + 10;
    await assert.rejects(
      cache.fetch('a', TTL, async () => {
        throw new Error('gone');
      }),
      /gone/,
    );
  });

  test('no entry at all: the error propagates', async () => {
    const { cache } = setup();
    await assert.rejects(cache.fetch('never-seen', TTL, failing), /portal down/);
  });

  test('a later success replaces the stale entry', async () => {
    const { cache, clock } = await primed();
    clock.ms = TTL + 10;
    assert.equal((await cache.fetch('a', TTL, failing)).state, 'STALE');
    const fresh = await cache.fetch('a', TTL, async () => 'new');
    assert.deepEqual([fresh.state, fresh.value], ['MISS', 'new']);
    assert.equal((await cache.fetch('a', TTL, failing)).state, 'HIT');
  });
});

describe('cache faults never break a request', () => {
  /** A store whose operations throw. */
  const brokenStore = () => ({
    get size() {
      return 0;
    },
    get() {
      throw new Error('store read broke');
    },
    set() {
      throw new Error('store write broke');
    },
    delete() {
      throw new Error('store delete broke');
    },
    keys() {
      throw new Error('store keys broke');
    },
  });

  test('a broken store degrades to loading every time, and logs', async () => {
    const { cache, logger } = setup({ store: brokenStore() });
    const loader = counter();
    assert.equal((await cache.fetch('a', TTL, loader.load)).value, 'value-1');
    assert.equal((await cache.fetch('a', TTL, loader.load)).value, 'value-2');
    assert.ok(logger.lines.some((line) => line.args[1].includes('cache read failed')));
    assert.ok(logger.lines.some((line) => line.args[1].includes('cache write failed')));
  });
});

describe('stats', () => {
  test('count hits, misses and stale serves', async () => {
    const { cache, clock } = setup();
    await cache.fetch('a', TTL, async () => 1);
    await cache.fetch('a', TTL, async () => 1);
    clock.ms = TTL + 1;
    await cache.fetch('a', TTL, async () => {
      throw new Error('down');
    });
    assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 1, stale: 1 });
  });
});
