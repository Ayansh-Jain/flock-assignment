import { errorResponses } from '../schemas.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function syncRoutes(app) {
  app.get(
    '/sync/status',
    {
      schema: {
        summary: 'Local index status',
        description:
          'When the local SQLite index was last synced from the portal export, how many meters it holds, and how the last sync run went. Reads only the local database.',
        tags: ['sync'],
        response: {
          200: { description: 'Index status.', $ref: 'SyncStatus#' },
          503: errorResponses[503],
        },
      },
    },
    async () => app.indexService.syncStatus(),
  );
}
