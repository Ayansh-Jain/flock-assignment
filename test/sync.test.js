import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openIndexDb, readSyncStatus } from '../src/index-store.js';
import { PortalUnavailable } from '../src/portal/errors.js';
import { runSync } from '../src/sync.js';
import {
  SECRET,
  createMockPortal,
  createRecordingLogger,
  fixtureBody,
  mockLogin,
} from './helpers.js';

const NOW = new Date('2026-10-28T10:00:00.000Z');

let template;
beforeEach(async () => {
  [template] = (await fixtureBody('export-page1')).data;
});

const exportRow = (i) => ({ ...template, meterId: `J2${String(i).padStart(5, '0')}` });
const rows = (from, to) => Array.from({ length: to - from }, (_, i) => exportRow(from + i));

/** A fake client whose export pages come from a list; records requested pages. */
function fakeClient(pages, total) {
  const requested = [];
  return {
    requested,
    async fetchExport({ page }) {
      requested.push(page);
      return { data: pages[Math.min(page, pages.length) - 1], total };
    },
  };
}

function setup() {
  const db = openIndexDb(':memory:');
  const logger = createRecordingLogger();
  const sleeps = [];
  const sync = (portalClient, options = {}) =>
    runSync({
      portalClient,
      db,
      logger,
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...options,
    });
  return { db, logger, sleeps, sync };
}

describe('runSync against a mocked portal', () => {
  let portal;
  beforeEach(() => {
    portal = createMockPortal();
  });
  afterEach(async () => {
    portal.assertAllUsed();
    await portal.close();
  });

  test('pulls every signed page, pausing between pages, and records the run', async () => {
    mockLogin(portal);
    portal
      .intercept({ path: '/portal/keys', method: 'GET' })
      .reply(200, { data: { signingSecret: SECRET } })
      .times(2);
    for (const [page, data] of [
      [1, rows(0, 3)],
      [2, rows(3, 5)],
    ]) {
      portal
        .intercept({ path: `/portal/export?page=${page}`, method: 'GET' })
        .reply(200, { data, total: 5 });
    }
    const { db, sleeps, sync } = setup();

    const result = await sync(portal.client, { pageDelayMs: 250 });

    assert.deepEqual(result, {
      status: 'ok',
      pages: 2,
      fetched: 5,
      stored: 5,
      skipped: 0,
      duplicates: 0,
      total: 5,
    });
    assert.deepEqual(sleeps, [250], 'one pause, between page 1 and page 2');
    const status = readSyncStatus(db);
    assert.equal(status.metersIndexed, 5);
    assert.equal(status.lastRun.status, 'ok');
    assert.equal(status.lastRun.rows_stored, 5);
    assert.equal(status.syncedAt, NOW.toISOString());
  });

  test('skips and logs a malformed row without failing the run', async () => {
    mockLogin(portal);
    portal
      .intercept({ path: '/portal/keys', method: 'GET' })
      .reply(200, { data: { signingSecret: SECRET } });
    const data = rows(0, 3);
    data[1] = { ...data[1], hierarchy: null };
    portal
      .intercept({ path: '/portal/export?page=1', method: 'GET' })
      .reply(200, { data, total: 3 });
    const { db, logger, sync } = setup();

    const result = await sync(portal.client);

    assert.equal(result.stored, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.status, 'ok');
    assert.equal(readSyncStatus(db).lastRun.rows_skipped, 1);
    assert.ok(
      logger.lines.some((line) => line.args[1] === 'skipped malformed rows in portal export'),
    );
    assert.ok(logger.lines.some((line) => line.args[1] === 'sync data-quality summary'));
  });
});

describe('runSync paging and storage', () => {
  test('is idempotent: a second run updates rows instead of duplicating them', async () => {
    const { db, sync } = setup();
    const client = fakeClient([rows(0, 4)], 4);
    await sync(client);
    const second = await sync(client, { now: () => new Date('2026-10-28T11:00:00.000Z') });

    assert.equal(second.stored, 4);
    const status = readSyncStatus(db);
    assert.equal(status.metersIndexed, 4);
    assert.equal(status.syncedAt, '2026-10-28T11:00:00.000Z');
    const runs = db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get();
    assert.equal(runs.n, 2);
  });

  test('stores changed values on re-run', async () => {
    const { db, sync } = setup();
    await sync(fakeClient([rows(0, 1)], 1));
    const changed = [{ ...exportRow(0), make: 'Renamed' }];
    await sync(fakeClient([changed], 1));
    assert.equal(db.prepare('SELECT make FROM meters').get().make, 'Renamed');
  });

  test('counts duplicate meter ids within one pull', async () => {
    const { sync } = setup();
    const result = await sync(fakeClient([[...rows(0, 2), exportRow(0)]], 3));
    assert.equal(result.stored, 2);
    assert.equal(result.duplicates, 1);
  });

  test('stops on a repeated page and reports the run as incomplete', async () => {
    const { db, logger, sync } = setup();
    const client = fakeClient([rows(0, 3)], 100); // total 100, but page 2 repeats page 1
    const result = await sync(client);

    assert.deepEqual(client.requested, [1, 2]);
    assert.equal(result.status, 'incomplete');
    assert.equal(readSyncStatus(db).lastRun.status, 'incomplete');
    assert.ok(logger.lines.some((line) => line.args[1] === 'portal export may be incomplete'));
  });

  test('stops at the page cap even if the portal keeps returning new rows', async () => {
    const { sync } = setup();
    const requested = [];
    const client = {
      async fetchExport({ page }) {
        requested.push(page);
        return { data: rows(page * 10, page * 10 + 2), total: 1_000_000 };
      },
    };
    const result = await sync(client);
    assert.equal(requested.length, 10);
    assert.equal(result.status, 'incomplete');
  });

  test('stops on an empty page', async () => {
    const { sync } = setup();
    const client = fakeClient([[]], 0);
    const result = await sync(client);
    assert.deepEqual(client.requested, [1]);
    assert.equal(result.stored, 0);
  });

  test('writes in batches', async () => {
    const { db, sync } = setup();
    await sync(fakeClient([rows(0, 7)], 7), { batchSize: 3 });
    assert.equal(readSyncStatus(db).metersIndexed, 7);
  });

  test('a portal failure is recorded as a failed run and rethrown', async () => {
    const { db, sync } = setup();
    const client = {
      async fetchExport() {
        throw new PortalUnavailable('export down');
      },
    };
    await assert.rejects(sync(client), PortalUnavailable);
    const { lastRun, syncedAt } = readSyncStatus(db);
    assert.equal(lastRun.status, 'failed');
    assert.equal(lastRun.error, 'PORTAL_UNAVAILABLE');
    assert.equal(syncedAt, null, 'a failed run is not a successful sync');
  });
});
