import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBreaker } from '../src/portal/breaker.js';
import { PortalCircuitOpen, PortalUnavailable } from '../src/portal/errors.js';
import { createMockPortal, mockLogin } from './helpers.js';

const COOLOFF = 30_000;

function setup() {
  const clock = { ms: 1_000_000 };
  const breaker = createBreaker({ threshold: 3, cooloffMs: COOLOFF, now: () => clock.ms });
  return { breaker, clock };
}

const fail = (breaker, times) => {
  for (let i = 0; i < times; i += 1) {
    breaker.beforeRequest();
    breaker.recordFailure();
  }
};

describe('circuit breaker', () => {
  test('stays closed below the threshold, and a success resets the count', () => {
    const { breaker } = setup();
    fail(breaker, 2);
    breaker.beforeRequest();
    breaker.recordSuccess();
    fail(breaker, 2);
    assert.equal(breaker.state(), 'closed');
  });

  test('opens after N consecutive failures and fails fast with a Retry-After', () => {
    const { breaker, clock } = setup();
    fail(breaker, 3);
    assert.equal(breaker.state(), 'open');
    clock.ms += 10_000;
    assert.throws(
      () => breaker.beforeRequest(),
      (error) =>
        error instanceof PortalCircuitOpen &&
        error instanceof PortalUnavailable &&
        error.retryAfterSeconds === 20,
    );
  });

  test('goes half-open after the cool-off and lets exactly one probe through', () => {
    const { breaker, clock } = setup();
    fail(breaker, 3);
    clock.ms += COOLOFF;
    assert.equal(breaker.state(), 'half-open');
    breaker.beforeRequest(); // the probe
    assert.throws(() => breaker.beforeRequest(), PortalCircuitOpen);
  });

  test('a successful probe closes the circuit', () => {
    const { breaker, clock } = setup();
    fail(breaker, 3);
    clock.ms += COOLOFF;
    breaker.beforeRequest();
    breaker.recordSuccess();
    assert.equal(breaker.state(), 'closed');
    breaker.beforeRequest();
  });

  test('a failed probe re-opens it for a full cool-off', () => {
    const { breaker, clock } = setup();
    fail(breaker, 3);
    clock.ms += COOLOFF;
    breaker.beforeRequest();
    breaker.recordFailure();
    assert.equal(breaker.state(), 'open');
    clock.ms += COOLOFF - 1;
    assert.throws(() => breaker.beforeRequest(), PortalCircuitOpen);
    clock.ms += 1;
    assert.equal(breaker.state(), 'half-open');
  });
});

describe('circuit breaker in the portal client', () => {
  test('opens after consecutive exhausted requests, then stops calling the portal', async () => {
    const portal = createMockPortal({ MAX_RETRIES: 0, BREAKER_THRESHOLD: 2 });
    try {
      mockLogin(portal);
      portal.intercept({ path: '/portal/dts?page=1', method: 'GET' }).reply(503, {}).times(2);

      await assert.rejects(portal.client.fetchTransformers(), PortalUnavailable);
      assert.equal(portal.client.circuitState(), 'closed');
      await assert.rejects(portal.client.fetchTransformers(), PortalUnavailable);
      assert.equal(portal.client.circuitState(), 'open');

      // No interceptor is left: if this reached the network, MockAgent would error differently.
      await assert.rejects(portal.client.fetchTransformers(), PortalCircuitOpen);
      portal.assertAllUsed();
    } finally {
      await portal.close();
    }
  });

  test('a portal answer such as 404 does not count as a failure', async () => {
    const portal = createMockPortal({ MAX_RETRIES: 0, BREAKER_THRESHOLD: 2 });
    try {
      mockLogin(portal);
      for (let i = 0; i < 3; i += 1) {
        portal.intercept({ path: `/portal/meters/J${i}/geo`, method: 'GET' }).reply(404, {});
      }
      for (let i = 0; i < 3; i += 1) {
        await assert.rejects(portal.client.fetchGeo(`J${i}`));
      }
      assert.equal(portal.client.circuitState(), 'closed');
    } finally {
      await portal.close();
    }
  });
});
