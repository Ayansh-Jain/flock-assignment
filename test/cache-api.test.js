import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PortalCircuitOpen, PortalUnavailable } from '../src/portal/errors.js';
import { createMeterService } from '../src/service.js';
import { createRecordingLogger, fixtureBody } from './helpers.js';

const START = new Date('2026-10-28T10:00:00.000Z').getTime();
const MIN = 60_000;

const config = loadConfig({
  PORTAL_BASE_URL: 'https://portal.test',
  PORTAL_USERNAME: 'tester',
  PORTAL_PASSWORD: 'secret-test-password',
});

let app;
let clock;
let control;
afterEach(() => app.close());

async function start(portalOverrides = {}) {
  clock = { ms: START };
  control = { failing: false, energyCalls: 0 };
  const energy = await fixtureBody('meter-energy');
  const portalClient = {
    async fetchEnergy() {
      control.energyCalls += 1;
      if (control.failing) throw new PortalUnavailable('portal down');
      return energy;
    },
    async fetchTransformers() {
      return {};
    },
    circuitState: () => 'closed',
    async close() {},
    ...portalOverrides,
  };
  const service = createMeterService({
    portalClient,
    logger: createRecordingLogger(),
    now: () => new Date(clock.ms),
  });
  app = await buildApp({ config, service, logger: false });
  await app.ready();
}

const get = (url) => app.inject({ method: 'GET', url });

describe('X-Cache and stale on cached routes', () => {
  beforeEach(() => start());

  test('MISS, then HIT, then STALE when the portal fails after expiry', async () => {
    const url = '/v1/meters/J100000/consumption';

    const miss = await get(url);
    assert.equal(miss.statusCode, 200);
    assert.equal(miss.headers['x-cache'], 'MISS');
    assert.ok(!('stale' in miss.json()));

    const hit = await get(url);
    assert.equal(hit.headers['x-cache'], 'HIT');
    assert.equal(control.energyCalls, 1);

    control.failing = true;
    clock.ms += 3 * MIN;
    const stale = await get(url);
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.headers['x-cache'], 'STALE');
    const body = stale.json();
    assert.equal(body.stale, true);
    assert.equal(body.fetched_at, new Date(START).toISOString());
    assert.equal(body.data.length, 337);
  });

  test('a hard failure with nothing cached is a normal 502 with no X-Cache header', async () => {
    control.failing = true;
    const response = await get('/v1/meters/J100000/consumption');
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'portal_unavailable');
    assert.equal(response.headers['x-cache'], undefined);
  });

  test('daily consumption reuses the same cached series', async () => {
    await get('/v1/meters/J100000/consumption');
    const daily = await get('/v1/meters/J100000/consumption/daily');
    assert.equal(daily.headers['x-cache'], 'HIT');
    assert.equal(control.energyCalls, 1);
  });

  test('uncached routes carry no X-Cache header', async () => {
    const response = await get('/health');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-cache'], undefined);
  });
});

describe('open circuit', () => {
  test('answers 503 portal_circuit_open with Retry-After and no portal call', async () => {
    await start({
      async fetchEnergy() {
        throw new PortalCircuitOpen('open', { retryAfterSeconds: 17 });
      },
    });
    const response = await get('/v1/meters/J100000/consumption');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '17');
    assert.equal(response.json().error.code, 'portal_circuit_open');
  });

  test('/health reports degraded while the circuit is open', async () => {
    await start({
      circuitState: () => 'open',
      async fetchTransformers() {
        throw new PortalCircuitOpen('open', { retryAfterSeconds: 5 });
      },
    });
    const health = (await get('/health')).json();
    assert.equal(health.status, 'degraded');
    assert.equal(health.portal, 'unreachable');
    assert.equal(health.circuit, 'open');
    assert.deepEqual(Object.keys(health.cache).sort(), ['entries', 'hits', 'misses', 'stale']);
  });
});
