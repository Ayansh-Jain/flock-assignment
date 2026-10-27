import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { registerErrorHandlers } from './error-handler.js';
import { createPortalClient } from './portal/client.js';
import healthRoutes from './routes/health.js';
import meterRoutes from './routes/meters.js';
import transformerRoutes from './routes/transformers.js';
import { sharedSchemas } from './schemas.js';
import { createMeterService } from './service.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const API_DESCRIPTION = [
  'A clean, read-only JSON API in front of the legacy "Urja Meter Ops" portal.',
  'Data is fetched from the portal on request (no caching yet); every response carries `fetched_at`.',
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

/**
 * Build the Fastify app. Used by the server, the OpenAPI exporter and the tests.
 *
 * @param {object} options
 * @param {Readonly<Record<string, string | number>>} options.config From loadConfig().
 * @param {object} [options.service] Meter service; built from config when omitted (tests inject a fake).
 * @param {boolean | object} [options.logger] Fastify logger option; defaults to config-based pino.
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ config, service, logger }) {
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
    });
  app.decorate('service', meterService);
  app.addHook('onClose', async () => {
    await meterService.close?.();
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
    },
    { prefix: '/v1' },
  );

  return app;
}
