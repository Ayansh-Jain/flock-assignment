import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  PortalAuthError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from '../src/portal/errors.js';
import {
  deriveDailyConsumption,
  parseEnergy,
  parseExport,
  parseGeo,
  parseMeterList,
  parseTransformers,
} from '../src/portal/parsers.js';
import { fixtureBody } from './helpers.js';

const FETCHED_AT = '2026-10-28T10:00:00.000Z';
const KNOWN_ID = 'J100000';
const CACHE_STATS = { entries: 2, hits: 5, misses: 2, stale: 0 };

let fixtures;
before(async () => {
  const exportRow = parseExport(await fixtureBody('export-page1')).meters[0];
  const readings = parseEnergy(await fixtureBody('meter-energy'));
  fixtures = {
    meters: parseMeterList(await fixtureBody('meters-search-page1')).meters,
    exportRow,
    geo: parseGeo(await fixtureBody('meter-geo')),
    readings,
    daily: deriveDailyConsumption(readings),
    transformers: parseTransformers(await fixtureBody('dts-page1')).transformers,
  };
});

/** A fake service backed by fixture data. Override any method per test. */
function createFakeService(overrides = {}) {
  const calls = [];
  const notFound = () => new PortalNotFound('missing');
  return {
    calls,
    async listMeters(query) {
      calls.push(['listMeters', { ...query }]);
      const data = query.offset >= 403 ? [] : fixtures.meters.slice(0, query.limit);
      return { data, total: 403, ...query, source: 'portal', fetched_at: FETCHED_AT };
    },
    async getMeter(meterId) {
      calls.push(['getMeter', meterId]);
      if (meterId !== KNOWN_ID) throw notFound();
      const { installType, build, hierarchy } = fixtures.exportRow;
      return {
        ...fixtures.meters[0],
        installType,
        build,
        geo: fixtures.geo,
        hierarchy,
        fetched_at: FETCHED_AT,
      };
    },
    async getConsumption(meterId) {
      calls.push(['getConsumption', meterId]);
      if (meterId !== KNOWN_ID) throw notFound();
      return { meterId, data: fixtures.readings, fetched_at: FETCHED_AT };
    },
    async getDailyConsumption(meterId) {
      calls.push(['getDailyConsumption', meterId]);
      if (meterId !== KNOWN_ID) throw notFound();
      return {
        meterId,
        data: fixtures.daily.days,
        skippedDays: 0,
        skipped: [],
        fetched_at: FETCHED_AT,
      };
    },
    async listTransformers(query) {
      calls.push(['listTransformers', { ...query }]);
      return {
        data: fixtures.transformers.slice(0, query.limit),
        total: 40,
        ...query,
        fetched_at: FETCHED_AT,
      };
    },
    async checkPortal() {
      return {
        status: 'ok',
        portal: 'reachable',
        circuit: 'closed',
        cache: CACHE_STATS,
        fetched_at: FETCHED_AT,
      };
    },
    ...overrides,
  };
}

const config = loadConfig({
  PORTAL_BASE_URL: 'https://portal.test',
  PORTAL_USERNAME: 'tester',
  PORTAL_PASSWORD: 'secret-test-password',
});

let app;
let service;
async function start(overrides) {
  service = createFakeService(overrides);
  app = await buildApp({ config, service, logger: false });
  await app.ready();
}
const get = (url, headers) => app.inject({ method: 'GET', url, headers });

beforeEach(() => start());
afterEach(() => app.close());

function assertErrorShape(response, status, code) {
  assert.equal(response.statusCode, status);
  const { error } = response.json();
  assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'request_id']);
  assert.equal(error.code, code);
  assert.equal(error.request_id, response.headers['x-request-id']);
  const text = response.body;
  for (const leak of ['/portal/', 'stack', 'node_modules', 'secret-test-password']) {
    assert.ok(!text.includes(leak), `error body must not contain "${leak}"`);
  }
  return error;
}

describe('happy paths', () => {
  test('GET /health', async () => {
    const response = await get('/health');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      portal: 'reachable',
      circuit: 'closed',
      cache: CACHE_STATS,
      fetched_at: FETCHED_AT,
    });
  });

  test('GET /v1/meters uses default limit 50 / offset 0 and returns the list shape', async () => {
    const response = await get('/v1/meters');
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(service.calls[0], ['listMeters', { limit: 50, offset: 0 }]);
    assert.equal(body.total, 403);
    assert.equal(body.limit, 50);
    assert.equal(body.fetched_at, FETCHED_AT);
    assert.deepEqual(body.data[1], {
      meterId: 'J100001',
      serialNo: 'GE84132',
      make: 'L&T',
      phaseType: 'single',
      installStatus: 'Installed',
      dtCode: 'DT-002',
    });
  });

  test('GET /v1/meters passes q, limit and offset through (and coerces numbers)', async () => {
    await get('/v1/meters?q=GE84&limit=5&offset=10');
    assert.deepEqual(service.calls[0], ['listMeters', { q: 'GE84', limit: 5, offset: 10 }]);
  });

  test('GET /v1/meters/:meterId returns geo and hierarchy', async () => {
    const response = await get(`/v1/meters/${KNOWN_ID}`);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.meterId, KNOWN_ID);
    assert.equal(body.installType, 'Whole Current');
    assert.deepEqual(body.geo, { latitude: 26.938961002479868, longitude: 75.83095696146852 });
    assert.deepEqual(Object.keys(body.hierarchy), [
      'zone',
      'circle',
      'division',
      'subdivision',
      'substation',
      'feeder',
      'dt',
    ]);
    assert.equal(body.fetched_at, FETCHED_AT);
  });

  test('a meter outside the export serialises with null hierarchy/installType/build', async () => {
    await app.close();
    await start({
      async getMeter() {
        return {
          ...fixtures.meters[3],
          installType: null,
          build: null,
          geo: fixtures.geo,
          hierarchy: null,
          fetched_at: FETCHED_AT,
        };
      },
    });
    const body = (await get('/v1/meters/J100003')).json();
    assert.equal(body.hierarchy, null);
    assert.equal(body.installType, null);
    assert.equal(body.build, null);
  });

  test('GET /v1/meters/:meterId/consumption returns numeric IST readings', async () => {
    const body = (await get(`/v1/meters/${KNOWN_ID}/consumption`)).json();
    assert.equal(body.data.length, 337);
    assert.deepEqual(body.data[0], {
      timestamp: '2026-06-23T23:30:00+05:30',
      kwh: 48438.74,
      kvah: 52313.84,
      voltR: 226,
    });
    assert.equal(body.fetched_at, FETCHED_AT);
  });

  test('GET /v1/meters/:meterId/consumption/daily includes skippedDays', async () => {
    const body = (await get(`/v1/meters/${KNOWN_ID}/consumption/daily`)).json();
    assert.equal(body.data.length, 7);
    assert.equal(body.data[0].date, '2026-06-24');
    assert.equal(body.skippedDays, 0);
    assert.deepEqual(body.skipped, []);
  });

  test('daily response reports skipped days with their reasons', async () => {
    await app.close();
    await start({
      async getDailyConsumption(meterId) {
        return {
          meterId,
          data: [],
          skippedDays: 1,
          skipped: [{ date: '2026-06-26', reason: 'register_decreased' }],
          fetched_at: FETCHED_AT,
        };
      },
    });
    const body = (await get(`/v1/meters/${KNOWN_ID}/consumption/daily`)).json();
    assert.equal(body.skippedDays, 1);
    assert.deepEqual(body.skipped, [{ date: '2026-06-26', reason: 'register_decreased' }]);
  });

  test('GET /v1/transformers', async () => {
    const body = (await get('/v1/transformers?limit=2')).json();
    assert.equal(body.total, 40);
    assert.deepEqual(body.data[0], {
      code: 'DT-001',
      name: 'Malviya Nagar DT 1',
      feederCode: 'F-001',
      capacityKva: 100,
    });
    assert.equal(body.data.length, 2);
  });

  test('responses drop fields that are not in the schema', async () => {
    await app.close();
    await start({
      async checkPortal() {
        return {
          status: 'ok',
          portal: 'reachable',
          circuit: 'closed',
          cache: CACHE_STATS,
          fetched_at: FETCHED_AT,
          internalToken: 'x',
        };
      },
    });
    assert.ok(!('internalToken' in (await get('/health')).json()));
  });
});

describe('request id', () => {
  test('generates one when absent and echoes a supplied one', async () => {
    const generated = (await get('/health')).headers['x-request-id'];
    assert.match(generated, /^[0-9a-f-]{36}$/);
    const echoed = await get('/health', { 'x-request-id': 'trace-123' });
    assert.equal(echoed.headers['x-request-id'], 'trace-123');
  });
});

describe('validation errors (400)', () => {
  for (const query of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'offset=1.5']) {
    test(`/v1/meters?${query}`, async () => {
      const error = assertErrorShape(await get(`/v1/meters?${query}`), 400, 'invalid_request');
      assert.match(error.message, new RegExp(query.split('=')[0]));
      assert.equal(service.calls.length, 0);
    });
  }

  test('transformers validates limit too', async () => {
    assertErrorShape(await get('/v1/transformers?limit=9999'), 400, 'invalid_request');
  });

  test('q longer than 64 characters', async () => {
    assertErrorShape(await get(`/v1/meters?q=${'x'.repeat(65)}`), 400, 'invalid_request');
  });

  test('malformed meter id never reaches the service', async () => {
    const error = assertErrorShape(await get('/v1/meters/bad%20id!'), 400, 'invalid_request');
    assert.match(error.message, /meterId/);
    assert.equal(service.calls.length, 0);
  });

  test('max limit 200 is accepted and an offset past the end gives an empty page', async () => {
    assert.equal((await get('/v1/meters?limit=200')).statusCode, 200);
    const pastEnd = (await get('/v1/meters?offset=5000')).json();
    assert.deepEqual(pastEnd.data, []);
    assert.equal(pastEnd.total, 403);
  });
});

describe('not found (404)', () => {
  test('unknown meter on every meter route', async () => {
    for (const path of ['', '/consumption', '/consumption/daily']) {
      const error = assertErrorShape(await get(`/v1/meters/NOPE${path}`), 404, 'meter_not_found');
      assert.match(error.message, /NOPE/);
    }
  });

  test('unknown route', async () => {
    assertErrorShape(await get('/v1/nothing-here'), 404, 'route_not_found');
  });
});

describe('portal failures', () => {
  const failWith = (error) => ({
    getMeter: async () => {
      throw error;
    },
  });
  const cases = [
    [
      'unavailable (5xx after retries)',
      () => new PortalUnavailable('x /portal/a', { cause: new Error('HTTP 503') }),
      502,
      'portal_unavailable',
    ],
    [
      'unreadable response',
      () => new PortalParseError('/portal/meters/search', 'data is not an array'),
      502,
      'portal_bad_response',
    ],
    [
      'our credentials rejected',
      () => new PortalAuthError('Portal rejected the configured credentials'),
      503,
      'portal_auth_failed',
    ],
    [
      'timeout',
      () =>
        new PortalUnavailable('x /portal/a', {
          cause: Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
        }),
      504,
      'portal_timeout',
    ],
  ];
  for (const [name, makeError, status, code] of cases) {
    test(`${name} -> ${status} ${code}`, async () => {
      await app.close();
      await start(failWith(makeError()));
      assertErrorShape(await get(`/v1/meters/${KNOWN_ID}`), status, code);
    });
  }

  test('an unexpected bug -> 500 internal_error with no details', async () => {
    await app.close();
    await start(failWith(new Error('boom: secret-test-password in /portal/x')));
    const error = assertErrorShape(await get(`/v1/meters/${KNOWN_ID}`), 500, 'internal_error');
    assert.equal(error.message, 'Internal server error.');
  });
});

describe('close', () => {
  test('closing the app closes the service', async () => {
    let closed = false;
    await app.close();
    await start({
      async close() {
        closed = true;
      },
    });
    await app.close();
    assert.equal(closed, true);
    await start(); // afterEach closes whatever app is current
  });
});
