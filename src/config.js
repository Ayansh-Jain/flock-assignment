import envSchema from 'env-schema';
import { DEFAULT_CACHE_OPTIONS } from './cache.js';

const schema = {
  type: 'object',
  required: ['PORTAL_BASE_URL', 'PORTAL_USERNAME', 'PORTAL_PASSWORD'],
  properties: {
    // env-schema ships no `uri` format, so a pattern enforces an absolute http(s) URL.
    PORTAL_BASE_URL: { type: 'string', pattern: '^https?://\\S+$' },
    PORTAL_USERNAME: { type: 'string', minLength: 1 },
    PORTAL_PASSWORD: { type: 'string', minLength: 1 },
    REQUEST_TIMEOUT_MS: { type: 'integer', minimum: 1, default: 20000 },
    MAX_CONCURRENCY: { type: 'integer', minimum: 1, maximum: 4, default: 3 },
    MAX_RETRIES: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'production', 'test'],
      default: 'production',
    },
    BREAKER_THRESHOLD: { type: 'integer', minimum: 1, default: 5 },
    BREAKER_COOLOFF_MS: { type: 'integer', minimum: 1, default: 30000 },
    CACHE_MAX_ENTRIES: { type: 'integer', minimum: 1, default: DEFAULT_CACHE_OPTIONS.maxEntries },
    CACHE_STALE_GRACE_MS: {
      type: 'integer',
      minimum: 0,
      default: DEFAULT_CACHE_OPTIONS.staleGraceMs,
    },
    CACHE_TTL_METER_MS: { type: 'integer', minimum: 0, default: DEFAULT_CACHE_OPTIONS.ttlMs.meter },
    CACHE_TTL_ENERGY_MS: {
      type: 'integer',
      minimum: 0,
      default: DEFAULT_CACHE_OPTIONS.ttlMs.energy,
    },
    CACHE_TTL_TRANSFORMERS_MS: {
      type: 'integer',
      minimum: 0,
      default: DEFAULT_CACHE_OPTIONS.ttlMs.transformers,
    },
    CACHE_TTL_EXPORT_MS: {
      type: 'integer',
      minimum: 0,
      default: DEFAULT_CACHE_OPTIONS.ttlMs.export,
    },
    DB_PATH: { type: 'string', minLength: 1, default: 'data/urja.db' },
    HOST: { type: 'string', default: '127.0.0.1' },
    PORT: { type: 'integer', minimum: 0, maximum: 65535, default: 3000 },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
    },
  },
};

/** Load `.env` into process.env when the file exists; any other failure is fatal. */
function loadEnvFileIfPresent() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error('Could not read the .env file', { cause: error });
    }
  }
}

/**
 * Read, validate and freeze configuration. Called once at startup.
 * Throws an error naming every missing/invalid variable (never their values).
 *
 * @param {Record<string, string | number> | undefined} [overrides] When given, used instead of
 *   process.env and no `.env` file is read, so tests are isolated from the machine.
 * @returns {Readonly<{
 *   PORTAL_BASE_URL: string, PORTAL_USERNAME: string, PORTAL_PASSWORD: string,
 *   REQUEST_TIMEOUT_MS: number, MAX_CONCURRENCY: number, MAX_RETRIES: number,
 *   BREAKER_THRESHOLD: number, BREAKER_COOLOFF_MS: number, CACHE_MAX_ENTRIES: number,
 *   CACHE_STALE_GRACE_MS: number, CACHE_TTL_METER_MS: number, CACHE_TTL_ENERGY_MS: number,
 *   CACHE_TTL_TRANSFORMERS_MS: number, CACHE_TTL_EXPORT_MS: number,
 *   NODE_ENV: string, DB_PATH: string, HOST: string, PORT: number, LOG_LEVEL: string }>}
 */
export function loadConfig(overrides) {
  if (!overrides) loadEnvFileIfPresent();
  try {
    return Object.freeze(envSchema({ schema, data: { ...(overrides ?? process.env) } }));
  } catch (error) {
    throw new Error(`Invalid configuration: ${error.message}`, { cause: error });
  }
}
