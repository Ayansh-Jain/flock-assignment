import { readFile } from 'node:fs/promises';
import { MockAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { loadConfig } from '../src/config.js';
import { createPortalClient } from '../src/portal/client.js';

export const BASE_URL = 'https://portal.test';
export const PASSWORD = 'test-password-value';
export const SECRET = 'test-signing-secret';

/** Load the `body` of a captured fixture from test/fixtures/. */
export async function fixtureBody(name) {
  const file = await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(file).body;
}

/** A pino-shaped logger that records everything it is given. */
export function createRecordingLogger() {
  const lines = [];
  const record =
    (level) =>
    (...args) =>
      lines.push({ level, args });
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * Mock portal: unmocked requests fail (disableNetConnect). Use `portal.intercept(...)`.
 * The client gets undici's fetch so it talks to this agent, never the real network.
 */
export function createMockPortal(configOverrides = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const logger = createRecordingLogger();
  const sleeps = [];
  const config = loadConfig({
    PORTAL_BASE_URL: BASE_URL,
    PORTAL_USERNAME: 'tester@example.test',
    PORTAL_PASSWORD: PASSWORD,
    MAX_RETRIES: 3,
    REQUEST_TIMEOUT_MS: 2000,
    ...configOverrides,
  });
  const client = createPortalClient({
    config,
    logger,
    fetchImpl: undiciFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
  });
  const pool = agent.get(BASE_URL);
  return {
    client,
    logger,
    sleeps,
    pool,
    intercept: (options) => pool.intercept(options),
    assertAllUsed: () => agent.assertNoPendingInterceptors(),
    async close() {
      await client.close();
      await agent.close();
    },
  };
}

export const LOGIN_OK = { type: 'redirect', status: 303, location: '/meters' };
export const LOGIN_FAILED = { type: 'failure', status: 401, data: '[]' };
export const UNAUTHORIZED = { error: 'unauthorized', message: 'A valid session is required.' };

/** Register successful logins that set a session cookie. */
export function mockLogin(portal, sessionId = 'sid-1', times = 1) {
  portal
    .intercept({ path: '/login', method: 'POST' })
    .reply(200, LOGIN_OK, { headers: { 'set-cookie': `session=${sessionId}; Path=/; HttpOnly` } })
    .times(times);
}
