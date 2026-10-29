import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { CACHE_STATE } from './cache.js';
import { registerErrorHandlers } from './error-handler.js';
import { createPortalClient } from './portal/client.js';
import { createIndexService } from './index-service.js';
import healthRoutes from './routes/health.js';
import meterRoutes from './routes/meters.js';
import networkRoutes from './routes/network.js';
import syncRoutes from './routes/sync.js';
import transformerRoutes from './routes/transformers.js';
import { sharedSchemas } from './schemas.js';
import { createMeterService } from './service.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const API_DESCRIPTION = [
  'A clean, read-only JSON API in front of the legacy "Urja Meter Ops" portal.',
  'Most data is fetched from the portal on request (`source: portal`, with `fetched_at`). Filtered meter lists, near-location queries and sync status come from a local SQLite index filled by `npm run sync` (`source: index`, with `synced_at`) and can be stale.',
  'Assumptions: portal timestamps are IST (+05:30); energy registers are kWh / kVAh.',
  'This API has no authentication of its own; run it on a trusted network.',
].join(' ');

/** Pino options: secrets redacted, pretty output only in development. */
function buildLoggerOptions(config) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      censor: '[Redacted]',
    },
    ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
  };
}

function cacheOptionsFrom(config) {
  return {
    maxEntries: config.CACHE_MAX_ENTRIES,
    staleGraceMs: config.CACHE_STALE_GRACE_MS,
    ttlMs: {
      meter: config.CACHE_TTL_METER_MS,
      energy: config.CACHE_TTL_ENERGY_MS,
      transformers: config.CACHE_TTL_TRANSFORMERS_MS,
      export: config.CACHE_TTL_EXPORT_MS,
    },
  };
}

/**
 * Build the Fastify app. Used by the server, the OpenAPI exporter and the tests.
 *
 * @param {object} options
 * @param {Readonly<Record<string, string | number>>} options.config From loadConfig().
 * @param {object} [options.service] Meter service; built from config when omitted (tests inject a fake).
 * @param {object} [options.indexService] Local-index service; built from config.DB_PATH (opened lazily) when omitted.
 * @param {boolean | object} [options.logger] Fastify logger option; defaults to config-based pino.
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ config, service, indexService, logger }) {
  const app = Fastify({
    logger: logger ?? buildLoggerOptions(config),
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  const meterService =
    service ??
    createMeterService({
      portalClient: createPortalClient({ config, logger: app.log }),
      logger: app.log,
      cacheOptions: cacheOptionsFrom(config),
    });
  const localIndex = indexService ?? createIndexService({ dbPath: config.DB_PATH });
  app.decorate('service', meterService);
  app.decorate('indexService', localIndex);
  app.addHook('onClose', async () => {
    await meterService.close?.();
    await localIndex.close();
  });
  // Cached reads carry their state on a symbol (see service.js); expose it as X-Cache.
  app.addHook('preSerialization', async (request, reply, payload) => {
    const cacheState = payload?.[CACHE_STATE];
    if (cacheState) reply.header('x-cache', cacheState);
    return payload;
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  for (const schema of sharedSchemas) app.addSchema(schema);
  registerErrorHandlers(app);

  await app.register(swagger, {
    // Name components after the schema $id instead of the default def-0, def-1, ...
    refResolver: {
      buildLocalReference: (json, baseUri, fragment, index) => json.$id || `def-${index}`,
    },
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Urja Meter API', version, description: API_DESCRIPTION },
      tags: [
        { name: 'meters', description: 'Meter list and detail' },
        { name: 'consumption', description: 'Energy readings and daily totals' },
        { name: 'transformers', description: 'Distribution transformers' },
        { name: 'sync', description: 'Local SQLite index status' },
        { name: 'network', description: 'Network hierarchy tree and its data-quality issues' },
        { name: 'health', description: 'Service health' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(meterRoutes);
      await v1.register(transformerRoutes);
      await v1.register(networkRoutes);
      await v1.register(syncRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
