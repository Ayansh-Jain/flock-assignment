import { cachedOk, errorResponses, limitQuery, offsetQuery } from '../schemas.js';

const nodeCodeParam = {
  type: 'object',
  required: ['nodeCode'],
  properties: {
    nodeCode: {
      type: 'string',
      // Assumed from observed codes such as Z-01, SD-02, DT-001; keeps odd input out of lookups.
      pattern: '^[A-Za-z0-9_.-]{1,32}$',
      description: 'Network node code, any level, e.g. Z-01 or DT-001. Case-insensitive.',
    },
  },
};

const upstreamErrors = {
  502: errorResponses[502],
  503: errorResponses[503],
  504: errorResponses[504],
};

/** @param {import('fastify').FastifyInstance} app */
export default async function networkRoutes(app) {
  app.get(
    '/network',
    {
      schema: {
        summary: 'Network zones',
        description:
          'Top-level nodes (zones) of the network hierarchy, with child and meter counts. Built from the portal export, so only meters present in the export are counted.',
        tags: ['network'],
        response: {
          200: cachedOk('NetworkNodeList#', 'The zones.'),
          ...upstreamErrors,
        },
      },
    },
    async () => app.service.listNetworkRoots(),
  );

  app.get(
    '/network/issues',
    {
      schema: {
        summary: 'Network data-quality issues',
        description:
          'Inconsistencies found while building the tree: conflicting parents, duplicate codes with different names, orphan meters, disagreements with the transformer list, and meters in portal search that the export lacks. Nothing is dropped; each finding is reported. Slower than the other network routes: it also lists every meter from portal search (cached).',
        tags: ['network'],
        response: {
          200: cachedOk('NetworkIssueList#', 'The findings.'),
          ...upstreamErrors,
        },
      },
    },
    async () => app.service.listNetworkIssues(),
  );

  app.get(
    '/network/:nodeCode',
    {
      schema: {
        summary: 'Network node',
        description: 'A node at any level, its direct children, and its path from the zone.',
        tags: ['network'],
        params: nodeCodeParam,
        response: {
          200: cachedOk('NetworkNodeDetail#', 'The node.'),
          400: errorResponses[400],
          404: errorResponses[404],
          ...upstreamErrors,
        },
      },
    },
    async (request) => app.service.getNetworkNode(request.params.nodeCode),
  );

  app.get(
    '/network/:nodeCode/meters',
    {
      schema: {
        summary: 'Meters under a network node',
        description:
          'All export meters at or below the node, ordered by meterId, paged with limit/offset.',
        tags: ['network'],
        params: nodeCodeParam,
        querystring: {
          type: 'object',
          properties: { limit: limitQuery, offset: offsetQuery },
        },
        response: {
          200: cachedOk('MeterList#', 'A page of meters.'),
          400: errorResponses[400],
          404: errorResponses[404],
          ...upstreamErrors,
        },
      },
    },
    async (request) => app.service.listNetworkMeters(request.params.nodeCode, request.query),
  );
}
