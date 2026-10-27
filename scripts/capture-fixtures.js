// Captures ONE redacted sample of each portal response into test/fixtures/.
// Run yourself: node --env-file=.env scripts/capture-fixtures.js
// Read-only: the login POST plus GETs, one request at a time, 1 s apart.
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { CookieJar } from 'tough-cookie';

const BASE_URL = process.env.PORTAL_BASE_URL ?? 'https://urja-ops.flockenergy.tech';
const USERNAME = process.env.PORTAL_USERNAME;
const PASSWORD = process.env.PORTAL_PASSWORD;
const FIXTURE_DIR = new URL('../test/fixtures/', import.meta.url);
const TIMEOUT_MS = 20_000;
const DELAY_MS = 1_000;
const EXPORT_ROWS_KEPT = 3;
const REDACTED = '<REDACTED>';
const SENSITIVE_KEY = /secret|token|password|cookie|signature|csrf|authorization/i;

if (!USERNAME || !PASSWORD) {
  console.error('Missing PORTAL_USERNAME or PORTAL_PASSWORD. Put them in .env (see .env.example).');
  process.exit(1);
}

const jar = new CookieJar();
/** Exact secret strings seen at runtime; used to scrub and then verify every saved file. */
const secrets = new Set([USERNAME, PASSWORD]);

/**
 * One request to the portal: timeout, manual redirects, cookie jar.
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, useJar?: boolean }} [options]
 */
async function portalFetch(path, { method = 'GET', headers = {}, body, useJar = true } = {}) {
  const url = new URL(path, BASE_URL).href;
  const cookie = useJar ? await jar.getCookieString(url) : '';
  const response = await fetch(url, {
    method,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json, text/html', ...(cookie && { cookie }), ...headers },
  });
  if (useJar) {
    for (const setCookie of response.headers.getSetCookie()) {
      await jar.setCookie(setCookie, url);
      secrets.add(setCookie.split(';')[0].split('=').slice(1).join('='));
    }
  }
  return { response, text: await response.text() };
}

/** Replace sensitive values by key name, recursively. */
function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : redactJson(inner),
      ]),
    );
  }
  return value;
}

/** Remove every known secret value and hidden-input/token values from text. */
function scrubText(text) {
  let clean = text;
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join(REDACTED);
  }
  return clean
    .replace(/(<input[^>]*type=["']hidden["'][^>]*value=["'])[^"']*/gi, `$1${REDACTED}`)
    .replace(/(csrf|token)(["'=:\s]+)[A-Za-z0-9._~+/-]{16,}/gi, `$1$2${REDACTED}`);
}

/** Save status, safe headers and body; refuse to write if any secret survived. */
async function saveFixture(name, { response, text }, transformBody = (body) => body) {
  const safeHeaders = {};
  for (const [key, value] of response.headers) {
    if (!SENSITIVE_KEY.test(key)) safeHeaders[key] = value;
  }
  let body;
  try {
    body = transformBody(redactJson(JSON.parse(scrubText(text))));
  } catch {
    body = scrubText(text);
  }
  const serialised = `${JSON.stringify({ status: response.status, headers: safeHeaders, body }, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && serialised.includes(secret)) {
      throw new Error(`Refusing to write ${name}: a secret value is still present.`);
    }
  }
  await writeFile(new URL(`${name}.json`, FIXTURE_DIR), serialised, 'utf8');
  console.log(`saved ${name}.json (HTTP ${response.status})`);
}

/** Fail loudly if a step needed for later steps did not return 2xx. */
function expectOk(step, { response }) {
  if (!response.ok) {
    throw new Error(`${step} failed with HTTP ${response.status}; stopping.`);
  }
}

function parseData(step, { text }) {
  const parsed = JSON.parse(text);
  if (!parsed || !('data' in parsed)) throw new Error(`${step}: unexpected response shape.`);
  return parsed;
}

async function main() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const step = async (fn) => {
    const result = await fn();
    await sleep(DELAY_MS);
    return result;
  };

  console.log('1/9 login page');
  await saveFixture(
    'login-page',
    await step(() => portalFetch('/login', { headers: { accept: 'text/html' } })),
  );

  // [Assumed] SvelteKit form action: urlencoded email/password; the action's JSON reply needs
  // x-sveltekit-action. Verify the field names against DevTools if login fails.
  console.log('2/9 login');
  const login = await step(() =>
    portalFetch('/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-sveltekit-action': 'true',
        origin: BASE_URL,
      },
      body: new URLSearchParams({ email: USERNAME, password: PASSWORD }).toString(),
    }),
  );
  if (JSON.parse(login.text).type !== 'redirect') {
    throw new Error(
      "Login did not succeed (response type is not 'redirect'). Check .env and the form field names.",
    );
  }
  await saveFixture('login-success', login);

  console.log('3/9 meter search, page 1');
  const search = await step(() => portalFetch('/portal/meters/search?q=&page=1'));
  expectOk('search', search);
  await saveFixture('meters-search-page1', search);

  console.log('4/9 transformers, page 1');
  const dts = await step(() => portalFetch('/portal/dts?page=1'));
  expectOk('dts', dts);
  await saveFixture('dts-page1', dts);

  console.log('5/9 signing key (fetched at runtime, never saved)');
  const keys = await step(() => portalFetch('/portal/keys'));
  expectOk('keys', keys);
  const signingSecret = parseData('keys', keys).data.signingSecret;
  if (typeof signingSecret !== 'string' || !signingSecret) {
    throw new Error('keys: signingSecret missing.');
  }
  secrets.add(signingSecret);

  console.log('6/9 export, page 1 (first rows only)');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = ['GET', '/portal/export', 'page=1', timestamp].join('\n');
  const signature = createHmac('sha256', signingSecret).update(message).digest('hex');
  secrets.add(signature);
  const exported = await step(() =>
    portalFetch('/portal/export?page=1', {
      headers: { 'x-signature': signature, 'x-timestamp': timestamp },
    }),
  );
  expectOk('export', exported);
  await saveFixture('export-page1', exported, (body) => ({
    ...body,
    data: body.data.slice(0, EXPORT_ROWS_KEPT),
  }));

  const meterId = parseData('search', search).data[0]?.meterId;
  if (!meterId) throw new Error('search returned no meters; cannot sample a meter.');

  console.log('7/9 geo for first search result');
  const geo = await step(() => portalFetch(`/portal/meters/${encodeURIComponent(meterId)}/geo`));
  expectOk('geo', geo);
  await saveFixture('meter-geo', geo);

  console.log('8/9 energy for the same meter');
  const energy = await step(() =>
    portalFetch(`/portal/meters/${encodeURIComponent(meterId)}/energy`),
  );
  expectOk('energy', energy);
  await saveFixture('meter-energy', energy);

  console.log('9/9 session expired (same read, no cookies sent)');
  await saveFixture(
    'session-expired',
    await portalFetch('/portal/meters/search?q=&page=1', { useJar: false }),
  );

  console.log('Done. Review test/fixtures/ before committing.');
}

try {
  await main();
} catch (error) {
  console.error(`capture failed: ${error.message}`);
  process.exit(1);
}
