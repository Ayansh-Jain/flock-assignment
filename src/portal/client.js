import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pLimit from 'p-limit';
import { CookieJar } from 'tough-cookie';
import {
  PortalAuthError,
  PortalError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from './errors.js';

const USER_AGENT = 'urja-meter-api/0.1 (read-only API wrapper)';
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Headers the portal requires on /portal/export (see notes/protocol-notes.md, Bulk path).
 * message = METHOD \n path \n query \n timestamp ; signature = lowercase hex HMAC-SHA256.
 *
 * @param {{ secret: string, path: string, query: string, timestamp: string, method?: string }} input
 * @returns {{ 'x-timestamp': string, 'x-signature': string }}
 */
export function buildSignatureHeaders({ secret, path, query, timestamp, method = 'GET' }) {
  const message = [method, path, query, timestamp].join('\n');
  return {
    'x-timestamp': timestamp,
    'x-signature': createHmac('sha256', secret).update(message).digest('hex'),
  };
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to milliseconds, or null. */
function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Parse JSON, returning undefined instead of throwing (used only for classification). */
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Timeouts and low-level network failures are worth retrying; programming errors are not. */
function isTransientNetworkError(error) {
  return (
    error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError
  );
}

/**
 * @typedef {object} PortalClient
 * @property {(args?: { q?: string, page?: number }) => Promise<unknown>} fetchMeterList
 * @property {(meterId: string) => Promise<unknown>} fetchGeo
 * @property {(meterId: string) => Promise<unknown>} fetchEnergy
 * @property {(args?: { page?: number }) => Promise<unknown>} fetchTransformers
 * @property {(args?: { page?: number }) => Promise<unknown>} fetchExport
 * @property {() => Promise<void>} close
 */

/**
 * Create a client for the Urja Meter Ops portal. Logs in lazily, shares one login between
 * concurrent callers, re-logs-in once when the session expires, retries transient failures,
 * and caps concurrency. It only performs the login POST and read-only GETs.
 *
 * @param {object} options
 * @param {Readonly<Record<string, string | number>>} options.config From loadConfig().
 * @param {{ debug: Function, info: Function, warn: Function }} options.logger pino-compatible.
 * @param {typeof fetch} [options.fetchImpl] Defaults to the built-in fetch.
 * @param {(ms: number) => Promise<unknown>} [options.sleep] Backoff sleep; injectable for tests.
 * @param {() => number} [options.now] Clock in epoch ms; injectable for tests.
 * @returns {PortalClient}
 */
export function createPortalClient({
  config,
  logger,
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
}) {
  const baseUrl = config.PORTAL_BASE_URL;
  const jar = new CookieJar();
  const limit = pLimit(config.MAX_CONCURRENCY);
  let authenticated = false;
  let generation = 0; // bumped on every successful login so only one caller resets a stale session
  let loginPromise = null;
  let closed = false;

  function backoffMs(attempt) {
    // Full jitter: random wait up to an exponentially growing ceiling.
    return Math.random() * Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  }

  /** One HTTP attempt: cookies in, Set-Cookie stored, timeout enforced. */
  async function send(method, path, { headers = {}, body, sign } = {}) {
    const url = new URL(path, baseUrl);
    const cookie = await jar.getCookieString(url.href);
    const response = await fetchImpl(url, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        ...(cookie && { cookie }),
        ...headers,
        ...sign?.(),
      },
    });
    const text = await response.text();
    for (const setCookie of response.headers.getSetCookie()) {
      await jar.setCookie(setCookie, url.href);
    }
    return { status: response.status, headers: response.headers, text };
  }

  /** send() plus retries for timeouts, network errors, 5xx and 429. Logs without secrets. */
  async function sendWithRetry(method, path, options) {
    let lastCause;
    for (let attempt = 0; attempt <= config.MAX_RETRIES; attempt += 1) {
      const started = performance.now();
      let result;
      try {
        result = await send(method, path, options);
      } catch (error) {
        if (!isTransientNetworkError(error)) {
          throw new PortalError(`Request to ${path} failed unexpectedly`, { cause: error });
        }
        lastCause = error;
        logger.warn(
          {
            method,
            path,
            attempt,
            error: error.name,
            durationMs: Math.round(performance.now() - started),
          },
          'portal request failed',
        );
        if (attempt < config.MAX_RETRIES) await sleep(backoffMs(attempt));
        continue;
      }
      logger.debug(
        {
          method,
          path,
          status: result.status,
          attempt,
          durationMs: Math.round(performance.now() - started),
        },
        'portal request',
      );
      const rateLimited = result.status === 429;
      if (!rateLimited && result.status < 500) return result;
      lastCause = new Error(`HTTP ${result.status}`);
      if (attempt < config.MAX_RETRIES) {
        const retryAfter = rateLimited
          ? parseRetryAfter(result.headers.get('retry-after'), now())
          : null;
        await sleep(
          retryAfter === null ? backoffMs(attempt) : Math.min(retryAfter, RETRY_AFTER_CAP_MS),
        );
      }
    }
    throw new PortalUnavailable(`Portal unavailable for ${path}`, { cause: lastCause });
  }

  /** POST /login (SvelteKit form action). Success is body type "redirect", decided from the body. */
  async function login() {
    const result = await sendWithRetry('POST', '/login', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-sveltekit-action': 'true',
        origin: new URL(baseUrl).origin,
      },
      body: new URLSearchParams({
        email: config.PORTAL_USERNAME,
        password: config.PORTAL_PASSWORD,
      }).toString(),
    });
    const body = tryParseJson(result.text);
    if (body === undefined) {
      throw new PortalParseError('/login', 'response is not valid JSON');
    }
    // The failure body echoes the email, so it is deliberately not put in the error message.
    if (body.type !== 'redirect') {
      throw new PortalAuthError('Portal rejected the configured credentials');
    }
  }

  async function performLogin() {
    try {
      await login();
      authenticated = true;
      generation += 1;
    } finally {
      loginPromise = null;
    }
  }

  /** Single-flight: concurrent callers share one in-flight login. Returns the session generation. */
  async function ensureSession() {
    if (!authenticated) {
      loginPromise ??= performLogin();
      await loginPromise;
    }
    return generation;
  }

  async function invalidateSession(seenGeneration) {
    if (seenGeneration !== generation || !authenticated) return; // someone already handled it
    authenticated = false;
    await jar.removeAllCookies();
  }

  /** The portal signals an expired session with 401 {"error":"unauthorized"} on /portal/*. */
  function isSessionExpired(path, result) {
    return (
      result.status === 401 &&
      path.startsWith('/portal/') &&
      tryParseJson(result.text)?.error === 'unauthorized'
    );
  }

  async function authenticatedGet(path, options) {
    const attempt = async () => {
      const seenGeneration = await ensureSession();
      return { seenGeneration, result: await sendWithRetry('GET', path, options) };
    };
    const first = await attempt();
    if (!isSessionExpired(path, first.result)) return first.result;
    logger.info({ path }, 'portal session expired; logging in again');
    await invalidateSession(first.seenGeneration);
    const second = await attempt();
    if (isSessionExpired(path, second.result)) {
      throw new PortalAuthError('Portal rejected the session again after a fresh login');
    }
    return second.result;
  }

  /** Map the final HTTP result to parsed JSON or a typed error. */
  function interpret(path, { status, text }) {
    if (status === 404) throw new PortalNotFound(`Portal has no resource at ${path}`);
    if (status === 401 || status === 403) {
      throw new PortalAuthError(`Portal refused access to ${path} (HTTP ${status})`);
    }
    if (status < 200 || status >= 300) {
      throw new PortalError(`Portal returned unexpected HTTP ${status} for ${path}`);
    }
    const body = tryParseJson(text);
    if (body === undefined) throw new PortalParseError(path, 'response is not valid JSON');
    return body;
  }

  async function getJson(path, options) {
    if (closed) throw new PortalError('Portal client is closed');
    return limit(async () => interpret(path, await authenticatedGet(path, options)));
  }

  function assertPage(page) {
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError('page must be a positive integer');
    }
  }

  async function fetchExport({ page = 1 } = {}) {
    assertPage(page);
    const keys = await getJson('/portal/keys');
    const secret = keys?.data?.signingSecret;
    if (typeof secret !== 'string' || secret === '') {
      throw new PortalParseError('/portal/keys', 'signingSecret missing');
    }
    const query = `page=${page}`;
    return getJson(`/portal/export?${query}`, {
      // Signed per attempt so a retry after backoff carries a fresh timestamp.
      sign: () =>
        buildSignatureHeaders({
          secret,
          path: '/portal/export',
          query,
          timestamp: String(Math.floor(now() / 1000)),
        }),
    });
  }

  return {
    async fetchMeterList({ q = '', page = 1 } = {}) {
      assertPage(page);
      return getJson(`/portal/meters/search?${new URLSearchParams({ q, page })}`);
    },
    fetchGeo: (meterId) => getJson(`/portal/meters/${encodeURIComponent(meterId)}/geo`),
    fetchEnergy: (meterId) => getJson(`/portal/meters/${encodeURIComponent(meterId)}/energy`),
    async fetchTransformers({ page = 1 } = {}) {
      assertPage(page);
      return getJson(`/portal/dts?${new URLSearchParams({ page })}`);
    },
    fetchExport,
    async close() {
      closed = true;
      limit.clearQueue();
      await jar.removeAllCookies();
    },
  };
}
