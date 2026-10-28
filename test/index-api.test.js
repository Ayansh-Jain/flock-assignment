import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createIndexService } from '../src/index-service.js';
import { finishRun, openIndexDb, startRun, upsertMeters } from '../src/index-store.js';

const SYNCED_AT = '2026-10-28T09:30:00.000Z';
const FETCHED_AT = '2026-10-28T10:00:00.000Z';

const config = loadConfig({
  PORTAL_BASE_URL: 'https://portal.test',
  PORTAL_USERNAME: 'tester',
  PORTAL_PASSWORD: 'secret-test-password',
});

/** A parsed-export-shaped meter. Latitudes are chosen so distances from (25, 75) are hand-checkable. */
function meter(meterId, { zone = 'Z-01', feeder = 'F-001', geo, ...overrides }) {
  const node = (code) => ({ code, name: `Name of ${code}` });
  return {
    meterId,
    serialNo: `SN-${meterId}`,
    make: 'HPL',
    phaseType: 'single',
    installStatus: 'Installed',
    installType: 'Whole Current',
    build: 'legacy',
    dtCode: 'DT-001',
    hierarchy: {
      zone: node(zone),
      circle: node('C-01'),
      division: node('D-01'),
      subdivision: node('SD-01'),
      substation: node('SS-01'),
      feeder: node(feeder),
      dt: node('DT-001'),
    },
    geo,
    ...overrides,
  };
}

// One degree of latitude is 6371 * pi / 180 = 111.195 km; half a degree is 55.597 km.
const METERS = [
  meter('M1', { geo: { latitude: 26, longitude: 75 } }),
  meter('M2', { geo: { latitude: 25.5, longitude: 75 }, make: 'L&T', phaseType: 'three' }),
  meter('M3', {
    geo: { latitude: 10, longitude: 75 },
    zone: 'Z-02',
    feeder: 'F-002',
    installStatus: 'Decommissioned',
  }),
  meter('M4', { geo: { latitude: 25.5, longitude: 75 }, serialNo: 'ZZ-9' }),
];

let dir;
let dbPath;
let app;
let liveCalls;

async function start({ synced = true } = {}) {
  const db = openIndexDb(dbPath);
  if (synced) {
    upsertMeters(db, METERS, SYNCED_AT);
    finishRun(db, startRun(db, SYNCED_AT, '/portal/export'), {
      finishedAt: SYNCED_AT,
      status: 'ok',
      counts: { pages: 1, totalReported: 4, fetched: 4, stored: 4, skipped: 0, duplicates: 0 },
    });
  }
  db.close();
  liveCalls = [];
  const service = {
    async listMeters(query) {
      liveCalls.push(query);
      return { data: [], total: 0, ...query, source: 'portal', fetched_at: FETCHED_AT };
    },
  };
  app = await buildApp({
    config,
    service,
    indexService: createIndexService({ dbPath }),
    logger: false,
  });
  await app.ready();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'urja-index-test-'));
  dbPath = join(dir, 'nested', 'urja.db');
  await mkdir(join(dir, 'nested'));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (url) => app.inject({ method: 'GET', url });
const ids = (response) => response.json().data.map((meter) => meter.meterId);

describe('GET /v1/meters with index filters', () => {
  beforeEach(() => start());

  test('without filters it still goes live to the portal', async () => {
    const body = (await get('/v1/meters?q=J1')).json();
    assert.equal(body.source, 'portal');
    assert.equal(liveCalls.length, 1);
  });

  test('filters by make, case-insensitively, and states its source and age', async () => {
    const response = await get('/v1/meters?make=l%26t');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(ids(response), ['M2']);
    assert.equal(body.source, 'index');
    assert.equal(body.synced_at, SYNCED_AT);
    assert.equal(body.total, 1);
    assert.equal(liveCalls.length, 0, 'an index query must not call the portal');
    assert.deepEqual(Object.keys(body.data[0]).sort(), [
      'dtCode',
      'installStatus',
      'make',
      'meterId',
      'phaseType',
      'serialNo',
    ]);
  });

  test('combines filters with AND, and hierarchy codes are normalised', async () => {
    assert.deepEqual(ids(await get('/v1/meters?zone=z-01&phaseType=single')), ['M1', 'M4']);
    assert.deepEqual(ids(await get('/v1/meters?zone=Z-02&installStatus=Decommissioned')), ['M3']);
    assert.deepEqual(ids(await get('/v1/meters?feeder=f-002')), ['M3']);
    assert.deepEqual(ids(await get('/v1/meters?dtCode=dt-001')), ['M1', 'M2', 'M3', 'M4']);
    assert.deepEqual(ids(await get('/v1/meters?zone=Z-02&make=HPL&phaseType=three')), []);
  });

  test('q narrows an index query by meter id or serial number', async () => {
    assert.deepEqual(ids(await get('/v1/meters?zone=Z-01&q=ZZ-')), ['M4']);
    assert.deepEqual(ids(await get('/v1/meters?make=HPL&q=M1')), ['M1']);
  });

  test('pages with limit and offset and reports the full total', async () => {
    const response = await get('/v1/meters?dtCode=DT-001&limit=2&offset=1');
    assert.deepEqual(ids(response), ['M2', 'M3']);
    assert.equal(response.json().total, 4);
    assert.equal(response.json().limit, 2);
    assert.equal(response.json().offset, 1);
  });

  test('treats hostile filter values as plain data (prepared statements)', async () => {
    const response = await get(`/v1/meters?make=${encodeURIComponent("x' OR '1'='1")}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(ids(response), []);
    assert.equal((await get('/v1/meters?make=HPL')).json().total, 3, 'table intact');
  });

  test('rejects a malformed code filter before touching the database', async () => {
    const response = await get('/v1/meters?zone=bad%20code!');
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
  });
});

describe('GET /v1/meters/near', () => {
  beforeEach(() => start());

  test('returns meters within the radius, nearest first, with hand-checked distances', async () => {
    const response = await get('/v1/meters/near?lat=25&lon=75&radius_km=120');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(
      body.data.map((m) => [m.meterId, m.distance_km]),
      [
        ['M2', 55.597],
        ['M4', 55.597],
        ['M1', 111.195],
      ],
    );
    assert.deepEqual(body.data[0].geo, { latitude: 25.5, longitude: 75 });
    assert.equal(body.total, 3);
    assert.equal(body.source, 'index');
    assert.equal(body.synced_at, SYNCED_AT);
  });

  test('the radius is exact, not just the bounding box', async () => {
    // 60 km: M2 and M4 (55.6) are in; M1 (111.2) is in the box of a larger radius but out here.
    assert.deepEqual(ids(await get('/v1/meters/near?lat=25&lon=75&radius_km=60')), ['M2', 'M4']);
    // 55 km is just short of M2 and M4 (55.597 km), so nothing qualifies.
    assert.deepEqual(ids(await get('/v1/meters/near?lat=25&lon=75&radius_km=55')), []);
  });

  test('an empty radius gives an empty page, not an error', async () => {
    const response = await get('/v1/meters/near?lat=0&lon=0&radius_km=1');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data, []);
    assert.equal(response.json().total, 0);
  });

  test('defaults the radius to 5 km and pages the result', async () => {
    assert.deepEqual(ids(await get('/v1/meters/near?lat=25.5&lon=75')), ['M2', 'M4']);
    const page = await get('/v1/meters/near?lat=25&lon=75&radius_km=120&limit=1&offset=2');
    assert.deepEqual(ids(page), ['M1']);
    assert.equal(page.json().total, 3);
  });

  test('validates lat, lon and radius', async () => {
    for (const query of [
      'lat=91&lon=0',
      'lat=-91&lon=0',
      'lat=0&lon=181',
      'lat=0',
      'lon=0',
      'lat=abc&lon=0',
      'lat=0&lon=0&radius_km=0',
      'lat=0&lon=0&radius_km=-3',
      'lat=0&lon=0&radius_km=501',
    ]) {
      const response = await get(`/v1/meters/near?${query}`);
      assert.equal(response.statusCode, 400, query);
      assert.equal(response.json().error.code, 'invalid_request', query);
    }
  });

  test('/near is not mistaken for a meter id', async () => {
    const response = await get('/v1/meters/near?lat=25&lon=75');
    assert.equal(response.statusCode, 200);
  });
});

describe('GET /v1/sync/status', () => {
  test('reports the last run and the index size', async () => {
    await start();
    const body = (await get('/v1/sync/status')).json();
    assert.equal(body.source, 'index');
    assert.equal(body.meters_indexed, 4);
    assert.equal(body.synced_at, SYNCED_AT);
    assert.equal(body.last_run.status, 'ok');
    assert.equal(body.last_run.rows_stored, 4);
    assert.equal(body.last_run.pages, 1);
    assert.equal(body.last_run.total_reported, 4);
    assert.equal(body.last_run.finished_at, SYNCED_AT);
  });

  test('before any sync: 200 with nulls, and index queries answer 503 index_not_synced', async () => {
    await start({ synced: false });
    const status = await get('/v1/sync/status');
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      source: 'index',
      meters_indexed: 0,
      synced_at: null,
      last_run: null,
    });
    for (const url of ['/v1/meters?make=HPL', '/v1/meters/near?lat=0&lon=0']) {
      const response = await get(url);
      assert.equal(response.statusCode, 503, url);
      assert.equal(response.json().error.code, 'index_not_synced', url);
    }
  });

  test('a failed run alone does not count as synced', async () => {
    await start({ synced: false });
    const db = openIndexDb(dbPath);
    finishRun(db, startRun(db, SYNCED_AT, '/portal/export'), {
      finishedAt: SYNCED_AT,
      status: 'failed',
      error: 'PORTAL_UNAVAILABLE',
    });
    db.close();
    const body = (await get('/v1/sync/status')).json();
    assert.equal(body.synced_at, null);
    assert.equal(body.last_run.status, 'failed');
    assert.equal(body.last_run.error, 'PORTAL_UNAVAILABLE');
    assert.equal((await get('/v1/meters?make=HPL')).statusCode, 503);
  });
});

describe('index service', () => {
  test('creates a missing database directory on first use', async () => {
    await start({ synced: false });
    const service = createIndexService({ dbPath: join(dir, 'a', 'b', 'fresh.db') });
    assert.equal((await service.syncStatus()).meters_indexed, 0);
    await service.close();
  });
});
