import { cachedOk, errorResponses, limitQuery, offsetQuery } from '../schemas.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function transformerRoutes(app) {
  app.get(
    '/transformers',
    {
      schema: {
        summary: 'List distribution transformers',
        description:
          'Distribution transformers (DTs) from the portal, with their feeder and capacity.',
        tags: ['transformers'],
        querystring: {
          type: 'object',
          properties: { limit: limitQuery, offset: offsetQuery },
        },
        response: {
          200: cachedOk('TransformerList#', 'A page of transformers.'),
          400: errorResponses[400],
          502: errorResponses[502],
          503: errorResponses[503],
          504: errorResponses[504],
        },
      },
    },
    async (request) => app.service.listTransformers(request.query),
  );
}
