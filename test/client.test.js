import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { buildSignatureHeaders } from '../src/portal/client.js';
import { PortalAuthError, PortalNotFound, PortalUnavailable } from '../src/portal/errors.js';
import {
  LOGIN_FAILED,
  LOGIN_OK,
  PASSWORD,
  SECRET,
  UNAUTHORIZED,
  createMockPortal,
  fixtureBody,
  mockLogin,
} from './helpers.js';

const SEARCH = { path: '/portal/meters/search?q=&page=1', method: 'GET' };
const EMPTY_PAGE = { data: [], total: 0, page: 1, pageSize: 20 };

let portal;
beforeEach(() => {
  portal = createMockPortal();
});
afterEach(async () => {
  portal.assertAllUsed();
  await portal.close();
});

describe('login', () => {
  test('logs in lazily and reuses the session cookie', async () => {
    mockLogin(portal, 'sid-1');
    portal
      .intercept({ ...SEARCH, headers: { cookie: 'session=sid-1' } })
      .reply(200, EMPTY_PAGE)
      .times(2);

    assert.deepEqual(await portal.client.fetchMeterList(), EMPTY_PAGE);
    assert.deepEqual(await portal.client.fetchMeterList(), EMPTY_PAGE);
  });

  test('sends urlencoded credentials with the SvelteKit action header and Origin', async () => {
    let seen;
    portal.intercept({ path: '/login', method: 'POST' }).reply((options) => {
      seen = options;
      return { statusCode: 200, data: JSON.stringify(LOGIN_OK) };
    });
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE);

    await portal.client.fetchMeterList();

    const params = new URLSearchParams(seen.body);
    assert.equal(params.get('email'), 'tester@example.test');
    assert.equal(params.get('password'), PASSWORD);
    assert.equal(seen.headers['x-sveltekit-action'], 'true');
    assert.equal(seen.headers.origin, 'https://portal.test');
    assert.match(seen.headers['content-type'], /^application\/x-www-form-urlencoded/);
  });

  test('type "failure" becomes PortalAuthError', async () => {
    portal.intercept({ path: '/login', method: 'POST' }).reply(200, LOGIN_FAILED);
    await assert.rejects(portal.client.fetchMeterList(), (error) => {
      assert.ok(error instanceof PortalAuthError);
      assert.equal(error.code, 'PORTAL_AUTH');
      return true;
    });
  });

  test('10 concurrent requests with no session cause exactly ONE login', async () => {
    mockLogin(portal, 'sid-1', 1); // a second login would hit no interceptor and fail
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE).times(10);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => portal.client.fetchMeterList()),
    );
    assert.equal(results.length, 10);
  });
});

describe('expired session', () => {
  test('401 unauthorized -> one re-login -> retry succeeds', async () => {
    mockLogin(portal, 'old');
    portal.intercept({ ...SEARCH, headers: { cookie: 'session=old' } }).reply(401, UNAUTHORIZED);
    mockLogin(portal, 'new');
    portal.intercept({ ...SEARCH, headers: { cookie: 'session=new' } }).reply(200, EMPTY_PAGE);

    assert.deepEqual(await portal.client.fetchMeterList(), EMPTY_PAGE);
  });

  test('still 401 after re-login -> PortalAuthError, no endless loop', async () => {
    mockLogin(portal, 'a');
    portal.intercept(SEARCH).reply(401, UNAUTHORIZED);
    mockLogin(portal, 'b');
    portal.intercept(SEARCH).reply(401, UNAUTHORIZED);

    await assert.rejects(portal.client.fetchMeterList(), PortalAuthError);
  });
});

describe('retries and errors', () => {
  beforeEach(() => mockLogin(portal));

  test('5xx then 200 succeeds after a retry', async () => {
    portal.intercept(SEARCH).reply(503, 'busy');
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE);

    assert.deepEqual(await portal.client.fetchMeterList(), EMPTY_PAGE);
    assert.equal(portal.sleeps.length, 1);
  });

  test('5xx on every attempt -> PortalUnavailable after MAX_RETRIES', async () => {
    portal.intercept(SEARCH).reply(500, 'boom').times(4); // 1 try + 3 retries

    await assert.rejects(portal.client.fetchMeterList(), PortalUnavailable);
    assert.equal(portal.sleeps.length, 3);
  });

  test('repeated timeouts -> PortalUnavailable', async () => {
    await portal.close(); // a short timeout needs its own client config
    portal = createMockPortal({ REQUEST_TIMEOUT_MS: 20, MAX_RETRIES: 1 });
    mockLogin(portal);
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE).delay(300).times(2);

    await assert.rejects(portal.client.fetchMeterList(), PortalUnavailable);
  });

  test('404 -> PortalNotFound and is not retried', async () => {
    portal
      .intercept({ path: '/portal/meters/NOPE/geo', method: 'GET' })
      .reply(404, { error: 'not_found' });

    await assert.rejects(portal.client.fetchGeo('NOPE'), PortalNotFound);
    assert.equal(portal.sleeps.length, 0);
  });

  test('429 with Retry-After waits that long, then retries', async () => {
    portal.intercept(SEARCH).reply(429, 'slow down', { headers: { 'retry-after': '2' } });
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE);

    await portal.client.fetchMeterList();
    assert.deepEqual(portal.sleeps, [2000]);
  });

  test('a huge Retry-After is capped', async () => {
    portal.intercept(SEARCH).reply(429, 'slow down', { headers: { 'retry-after': '99999' } });
    portal.intercept(SEARCH).reply(200, EMPTY_PAGE);

    await portal.client.fetchMeterList();
    assert.deepEqual(portal.sleeps, [30_000]);
  });

  test('other 4xx are not retried', async () => {
    portal.intercept(SEARCH).reply(400, 'bad');
    await assert.rejects(portal.client.fetchMeterList(), { code: 'PORTAL_ERROR' });
    assert.equal(portal.sleeps.length, 0);
  });
});

describe('read endpoints', () => {
  beforeEach(() => mockLogin(portal));

  test('search url-encodes q (serials and makes can contain "&")', async () => {
    portal
      .intercept({ path: '/portal/meters/search?q=L%26T&page=2', method: 'GET' })
      .reply(200, EMPTY_PAGE);
    await portal.client.fetchMeterList({ q: 'L&T', page: 2 });
  });

  test('geo, energy and transformers hit the expected paths', async () => {
    portal
      .intercept({ path: '/portal/meters/J100000/geo', method: 'GET' })
      .reply(200, await fixtureBody('meter-geo'));
    portal
      .intercept({ path: '/portal/meters/J100000/energy', method: 'GET' })
      .reply(200, await fixtureBody('meter-energy'));
    portal
      .intercept({ path: '/portal/dts?page=1', method: 'GET' })
      .reply(200, await fixtureBody('dts-page1'));

    assert.ok((await portal.client.fetchGeo('J100000')).data.latitude);
    assert.equal((await portal.client.fetchEnergy('J100000')).data.length, 337);
    assert.equal((await portal.client.fetchTransformers()).total, 40);
  });

  test('non-JSON body -> PortalParseError', async () => {
    portal.intercept(SEARCH).reply(200, '<html>login</html>');
    await assert.rejects(portal.client.fetchMeterList(), { code: 'PORTAL_PARSE' });
  });
});

describe('invalid input', () => {
  test('rejects an invalid page before touching the portal', async () => {
    await assert.rejects(portal.client.fetchMeterList({ page: 0 }), RangeError);
  });
});

describe('signed export', () => {
  test('signature matches a known HMAC-SHA256 vector', () => {
    assert.deepEqual(
      buildSignatureHeaders({
        secret: 'test-secret',
        path: '/portal/export',
        query: 'page=2',
        timestamp: '1700000000',
      }),
      {
        'x-timestamp': '1700000000',
        'x-signature': '34c078f7c5495b347153ae210b26f17c964dd807cfb1681771906730991a6721',
      },
    );
  });

  test('fetches the key at runtime and signs the request; secret never logged', async () => {
    mockLogin(portal);
    portal
      .intercept({ path: '/portal/keys', method: 'GET' })
      .reply(200, { data: { signingSecret: SECRET } });
    let seen;
    portal.intercept({ path: '/portal/export?page=3', method: 'GET' }).reply((options) => {
      seen = options.headers;
      return { statusCode: 200, data: JSON.stringify({ data: [], total: 0 }) };
    });

    await portal.client.fetchExport({ page: 3 });

    const expected = buildSignatureHeaders({
      secret: SECRET,
      path: '/portal/export',
      query: 'page=3',
      timestamp: '1700000000', // helper clock is fixed at 1_700_000_000_000 ms
    });
    assert.equal(seen['x-timestamp'], expected['x-timestamp']);
    assert.equal(seen['x-signature'], expected['x-signature']);
    assert.match(seen['x-signature'], /^[0-9a-f]{64}$/);

    const logged = JSON.stringify(portal.logger.lines);
    for (const secret of [SECRET, PASSWORD, expected['x-signature'], 'session=']) {
      assert.ok(!logged.includes(secret), 'logs must not contain secrets');
    }
  });

  test('missing signingSecret -> PortalParseError', async () => {
    mockLogin(portal);
    portal.intercept({ path: '/portal/keys', method: 'GET' }).reply(200, { data: {} });
    await assert.rejects(portal.client.fetchExport(), { code: 'PORTAL_PARSE' });
  });
});

describe('close', () => {
  test('requests after close() are refused', async () => {
    await portal.client.close();
    await assert.rejects(portal.client.fetchMeterList(), { code: 'PORTAL_ERROR' });
  });
});
