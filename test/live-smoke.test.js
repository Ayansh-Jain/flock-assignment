import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPortalClient } from '../src/portal/client.js';
import { parseMeterList } from '../src/portal/parsers.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// Opt-in only (RUN_LIVE_TESTS=1): one login and one read-only call against the real portal.
test(
  'live portal: first search page parses',
  { skip: process.env.RUN_LIVE_TESTS !== '1' },
  async () => {
    const client = createPortalClient({ config: loadConfig(), logger: silent });
    try {
      const page = parseMeterList(await client.fetchMeterList({ page: 1 }));
      assert.ok(page.total > 0);
      assert.ok(page.meters.length > 0);
    } finally {
      await client.close();
    }
  },
);
