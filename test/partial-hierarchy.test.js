import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openIndexDb, readSyncStatus } from '../src/index-store.js';
import { createMeterService } from '../src/service.js';
import { runSync } from '../src/sync.js';
import { createRecordingLogger, fixtureBody } from './helpers.js';

// A real-shaped export (seen live): some rows have an empty code at one hierarchy level. Those
// meters must be kept everywhere, with that level null, and never be called "not in the export".

const NOW = new Date('2026-10-28T10:00:00.000Z');
const config = loadConfig({
  PORTAL_BASE_URL: 'https://portal.test',
  PORTAL_USERNAME: 'tester',
  PORTAL_PASSWORD: 'secret-test-password',
});

let exportBody;
let dtsBody;
beforeEach(async () => {
  const fixture = await fixtureBody('export-page1');
  const [first, second, third] = fixture.data;
  // J2 has an empty circle code; J3 has an empty feeder code. J1 is complete.
  const broken = structuredClone(second);
  broken.hierarchy.circle.code = '';
  const brokenFeeder = structuredClone(third);
  brokenFeeder.hierarchy.feeder.code = '';
  const data = [first, broken, brokenFeeder];
  exportBody = { ...fixture, data, total: data.length };
  dtsBody = await fixtureBody('dts-page1');
});

describe('network tree and issues with incomplete rows', () => {
  let app;
  beforeEach(async () => {
    const portal = {
      async fetchExport() {
        return exportBody;
      },
      async fetchTransformers({ page }) {
        return page === 1 ? dtsBody : { ...dtsBody, data: [], page };
      },
      async fetchGeo() {
        return { data: { latitude: '26.9', longitude: '75.8' } };
      },
      async fetchMeterList() {
        const data = exportBody.data.map((row) => ({
          meterId: row.meterId,
          serialNo: row.serialNo,
          make: row.make,
          phaseType: row.phaseType,
          installStatus: row.installStatus,
          dtCode: row.dtCode,
        }));
        return { data, total: data.length, page: 1, pageSize: 20 };
      },
      async close() {},
    };
    const service = createMeterService({
      portalClient: portal,
      logger: createRecordingLogger(),
      now: () => NOW,
    });
    app = await buildApp({ config, service, logger: false });
    await app.ready();
  });
  afterEach(() => app.close());

  const get = async (url) => (await app.inject({ method: 'GET', url })).json();

  test('every export meter is counted in the tree', async () => {
    const zones = (await get('/v1/network')).data;
    const counted = zones.reduce((sum, zone) => sum + zone.meterCount, 0);
    assert.equal(counted, exportBody.data.length);
  });

  test('the incomplete meters are still listed under their zone', async () => {
    const zone = exportBody.data[1].hierarchy.zone.code;
    const listed = (await get(`/v1/network/${zone}/meters`)).data.map((m) => m.meterId);
    assert.ok(listed.includes(exportBody.data[1].meterId));
  });

  test('issues say incomplete_hierarchy, not meter_not_in_export', async () => {
    const { data } = await get('/v1/network/issues');
    const incomplete = data.filter((issue) => issue.type === 'incomplete_hierarchy');
    assert.deepEqual(incomplete.map((issue) => issue.meterId).sort(), [
      exportBody.data[1].meterId,
      exportBody.data[2].meterId,
    ]);
    assert.match(incomplete.find((i) => i.meterId === exportBody.data[1].meterId).detail, /circle/);
    assert.ok(!data.some((issue) => issue.type === 'meter_not_in_export'));
  });

  test('meter detail returns the partial hierarchy with null levels', async () => {
    const meter = await get(`/v1/meters/${exportBody.data[1].meterId}`);
    assert.equal(meter.hierarchy.circle, null);
    assert.equal(meter.hierarchy.zone.code, exportBody.data[1].hierarchy.zone.code);
    assert.equal(meter.hierarchy.dt.code, exportBody.data[1].hierarchy.dt.code);
  });
});

describe('sync and index with incomplete rows', () => {
  const syncOnce = async (db) => {
    const client = {
      async fetchExport() {
        return exportBody;
      },
    };
    return runSync({
      portalClient: client,
      db,
      logger: createRecordingLogger(),
      now: () => NOW,
      pageDelayMs: 0,
    });
  };

  test('stores every row (none rejected) and the index counts them all', async () => {
    const db = openIndexDb(':memory:');
    const result = await syncOnce(db);
    assert.equal(result.stored, 3);
    assert.equal(result.skipped, 0);
    assert.equal(readSyncStatus(db).metersIndexed, 3);
    const nulls = db
      .prepare('SELECT meter_id, circle_code, circle_name, feeder_code FROM meters ORDER BY 1')
      .all();
    assert.equal(nulls[1].circle_code, null);
    assert.equal(nulls[1].circle_name, null);
    assert.equal(nulls[2].feeder_code, null);
    assert.ok(nulls[0].circle_code, 'a complete row keeps its codes');
    db.close();
  });

  test('an old index file that required every level is emptied so the next sync refills it', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const dir = await mkdtemp(join(tmpdir(), 'urja-migrate-'));
    const path = join(dir, 'old.db');
    let db;
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE meters (meter_id TEXT PRIMARY KEY, zone_code TEXT NOT NULL);
        CREATE TABLE sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
          status TEXT NOT NULL, source TEXT NOT NULL, pages INTEGER, total_reported INTEGER,
          rows_fetched INTEGER, rows_stored INTEGER, rows_skipped INTEGER, rows_duplicate INTEGER,
          error TEXT);
        INSERT INTO meters VALUES ('OLD', 'Z-01');
        INSERT INTO sync_runs (started_at, finished_at, status, source) VALUES ('x', 'y', 'ok', 's');`);
      old.close();

      db = openIndexDb(path);
      assert.equal(readSyncStatus(db).metersIndexed, 0);
      assert.equal(readSyncStatus(db).syncedAt, null, 'status honestly says never synced');
      assert.equal((await syncOnce(db)).stored, 3);
    } finally {
      db?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
