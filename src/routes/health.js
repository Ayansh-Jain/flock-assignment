/** @param {import('fastify').FastifyInstance} app */
export default async function healthRoutes(app) {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Service and portal health',
        description:
          'Always HTTP 200 while this service is up. Makes one cheap read-only call to the portal, so it reports portal reachability (status degraded when the portal is not).',
        tags: ['health'],
        response: { 200: { description: 'Health status.', $ref: 'Health#' } },
      },
    },
    async () => app.service.checkPortal(),
  );
}
