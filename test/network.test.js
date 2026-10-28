import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMeterService } from '../src/service.js';
import { createRecordingLogger, fixtureBody } from './helpers.js';

const FETCHED_AT = '2026-10-28T10:00:00.000Z';
const NOW = new Date(FETCHED_AT);
const SEARCH_ONLY_ID = 'J100999';

const config = loadConfig({
  PORTAL_BASE_URL: 'https://portal.test',
  PORTAL_USERNAME: 'tester',
  PORTAL_PASSWORD: 'secret-test-password',
});

let exportBody;
let dtsBody;
let exportIds;
before(async () => {
  const fixture = await fixtureBody('export-page1');
  const [first, second, third] = fixture.data;
  // Five meters share the first chain (so paging has something to page); two others sit elsewhere.
  const clones = [1, 2, 3, 4].map((i) => ({ ...first, meterId: `J1001${i}0` }));
  const data = [first, ...clones, second, third];
  exportBody = { ...fixture, data, total: data.length };
  exportIds = data.map((row) => row.meterId);
  dtsBody = await fixtureBody('dts-page1');
});

/** A real service over a fake portal: the export and DT list come from fixtures. */
function createFakePortal() {
  const calls = { export: 0, dts: 0, search: 0 };
  return {
    calls,
    async fetchExport() {
      calls.export += 1;
      return exportBody;
    },
    async fetchTransformers({ page }) {
      calls.dts += 1;
      return page === 1 ? dtsBody : { ...dtsBody, data: [], page };
    },
    async fetchMeterList() {
      calls.search += 1;
      const data = [...exportIds, SEARCH_ONLY_ID].map((meterId) => ({
        meterId,
        serialNo: `S-${meterId}`,
        make: 'HPL',
        phaseType: 'single',
        installStatus: 'Installed',
        dtCode: 'DT-001',
      }));
      return { data, total: data.length, page: 1, pageSize: 20 };
    },
    async close() {},
  };
}

let app;
let portal;
beforeEach(async () => {
  portal = createFakePortal();
  const service = createMeterService({
    portalClient: portal,
    logger: createRecordingLogger(),
    now: () => NOW,
  });
  app = await buildApp({ config, service, logger: false });
  await app.ready();
});
afterEach(() => app.close());

const get = (url) => app.inject({ method: 'GET', url });

describe('GET /v1/network', () => {
  test('lists zones with child and meter counts', async () => {
    const response = await get('/v1/network');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.total, 3);
    assert.equal(body.fetched_at, FETCHED_AT);
    assert.deepEqual(body.data[0], {
      code: 'Z-01',
      name: 'Jaipur Zone 1',
      level: 'zone',
      parentCode: null,
      aliases: [],
      childCount: 1,
      meterCount: 5,
    });
    assert.deepEqual(
      body.data.map((zone) => zone.meterCount),
      [5, 1, 1],
    );
  });

  test('does not list portal search (only /issues pays for that)', async () => {
    await get('/v1/network');
    await get('/v1/network/Z-01');
    assert.equal(portal.calls.search, 0);
    assert.equal(portal.calls.export, 1, 'the export is pulled once and shared');
  });
});

describe('GET /v1/network/:nodeCode', () => {
  test('returns the node, its children and the path to the zone', async () => {
    const body = (await get('/v1/network/dt-001')).json();
    assert.equal(body.node.code, 'DT-001');
    assert.equal(body.node.level, 'dt');
    assert.equal(body.node.meterCount, 5);
    assert.deepEqual(body.children, []);
    assert.deepEqual(
      body.path.map((node) => node.level),
      ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'],
    );
    assert.equal(body.path[0].code, 'Z-01');
  });

  test('a zone lists its direct children only', async () => {
    const body = (await get('/v1/network/Z-01')).json();
    assert.deepEqual(
      body.children.map((child) => child.code),
      ['C-01'],
    );
    assert.deepEqual(
      body.path.map((node) => node.code),
      ['Z-01'],
    );
  });
});

describe('GET /v1/network/:nodeCode/meters', () => {
  test('pages meters under a node, ordered by meterId', async () => {
    const all = (await get('/v1/network/Z-01/meters?limit=200')).json();
    assert.equal(all.total, 5);
    const ids = all.data.map((meter) => meter.meterId);
    assert.deepEqual(ids, [...ids].sort());

    const page = (await get('/v1/network/Z-01/meters?limit=2&offset=2')).json();
    assert.deepEqual(
      page.data.map((meter) => meter.meterId),
      ids.slice(2, 4),
    );
    assert.equal(page.total, 5);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 2);
    assert.deepEqual(Object.keys(page.data[0]).sort(), [
      'dtCode',
      'installStatus',
      'make',
      'meterId',
      'phaseType',
      'serialNo',
    ]);
  });

  test('an offset past the end is an empty page', async () => {
    const body = (await get('/v1/network/Z-01/meters?offset=50')).json();
    assert.deepEqual(body.data, []);
    assert.equal(body.total, 5);
  });
});

describe('GET /v1/network/issues', () => {
  test('reports search-only meters and DT-list disagreements, and nothing else here', async () => {
    const body = (await get('/v1/network/issues')).json();
    assert.equal(body.total, body.data.length);
    const missing = body.data.filter((issue) => issue.type === 'meter_not_in_export');
    assert.deepEqual(
      missing.map((issue) => issue.meterId),
      [SEARCH_ONLY_ID],
    );
    // The fixture's 20 transformers include 17 with no export meter under them.
    const idle = body.data.filter((issue) => issue.type === 'transformer_without_meters');
    assert.equal(idle.length, 17);
    assert.equal(body.data.length, 18);
    assert.ok(portal.calls.search > 0);
  });

  test('is not swallowed by the :nodeCode route', async () => {
    const response = await get('/v1/network/issues');
    assert.ok(Array.isArray(response.json().data));
  });
});

describe('errors', () => {
  test('unknown node -> 404 in the standard shape', async () => {
    for (const path of ['/v1/network/NOPE', '/v1/network/NOPE/meters']) {
      const response = await get(path);
      assert.equal(response.statusCode, 404);
      const { error } = response.json();
      assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'request_id']);
      assert.equal(error.code, 'network_node_not_found');
      assert.match(error.message, /NOPE/);
    }
  });

  test('a malformed node code is a 400 and never reaches the portal', async () => {
    const response = await get('/v1/network/bad%20code!');
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
    assert.equal(portal.calls.export, 0);
  });
});
