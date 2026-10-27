import { errorResponses, limitQuery, offsetQuery } from '../schemas.js';

const meterIdParam = {
  type: 'object',
  required: ['meterId'],
  properties: {
    meterId: {
      type: 'string',
      // Assumed from observed ids such as J100001; keeps odd input out of upstream URLs.
      pattern: '^[A-Za-z0-9_-]{1,32}$',
      description: 'Portal meter ID, e.g. J100001.',
    },
  },
};

/** Error statuses every meter-scoped route can return. */
const meterErrors = {
  400: errorResponses[400],
  404: errorResponses[404],
  502: errorResponses[502],
  503: errorResponses[503],
  504: errorResponses[504],
};

/** @param {import('fastify').FastifyInstance} app */
export default async function meterRoutes(app) {
  app.get(
    '/meters',
    {
      schema: {
        summary: 'List meters',
        description:
          "Meters from the portal search, which is the source of truth for the meter list. `q` is a partial match on meter ID or serial number. limit/offset are mapped onto the portal's 20-row pages.",
        tags: ['meters'],
        querystring: {
          type: 'object',
          properties: {
            q: {
              type: 'string',
              maxLength: 64,
              description: 'Partial match on meterId or serialNo.',
            },
            limit: limitQuery,
            offset: offsetQuery,
          },
        },
        response: {
          200: { description: 'A page of meters.', $ref: 'MeterList#' },
          400: errorResponses[400],
          502: errorResponses[502],
          503: errorResponses[503],
          504: errorResponses[504],
        },
      },
    },
    async (request) => app.service.listMeters(request.query),
  );

  app.get(
    '/meters/:meterId',
    {
      schema: {
        summary: 'Meter detail',
        description:
          'Search row plus location. installType, build and hierarchy come from the portal export and are null when the meter is not in it (or the export is unavailable).',
        tags: ['meters'],
        params: meterIdParam,
        response: { 200: { description: 'The meter.', $ref: 'Meter#' }, ...meterErrors },
      },
    },
    async (request) => app.service.getMeter(request.params.meterId),
  );

  app.get(
    '/meters/:meterId/consumption',
    {
      schema: {
        summary: 'Raw 30-minute readings',
        description:
          'About 8 days of 30-minute readings, oldest first. kwh and kvah are cumulative registers (units assumed kWh and kVAh). Timestamps are IST (+05:30), an assumption: the portal sends none.',
        tags: ['consumption'],
        params: meterIdParam,
        response: {
          200: { description: 'Raw readings, oldest first.', $ref: 'ConsumptionSeries#' },
          ...meterErrors,
        },
      },
    },
    async (request) => app.service.getConsumption(request.params.meterId),
  );

  app.get(
    '/meters/:meterId/consumption/daily',
    {
      schema: {
        summary: 'Daily consumption totals',
        description:
          "Per IST day: last register reading of the day minus the previous day's. The first reading is at 23:30, so the first day only anchors the next one and about 7 totals result. Days with a gap, an early end, or a register that went backwards (reset or meter swap) are left out and counted in skippedDays.",
        tags: ['consumption'],
        params: meterIdParam,
        response: {
          200: { description: 'Daily totals and skipped days.', $ref: 'DailyConsumptionSeries#' },
          ...meterErrors,
        },
      },
    },
    async (request) => app.service.getDailyConsumption(request.params.meterId),
  );
}
