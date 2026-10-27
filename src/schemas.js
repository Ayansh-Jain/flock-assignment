// JSON Schemas for OUR API. One definition drives request validation, response serialisation
// and the generated OpenAPI document. Field names match what src/portal/parsers.js returns;
// only fields actually observed on the portal are exposed.

const METER_ID_EXAMPLE = 'J100001';

const fetchedAt = {
  type: 'string',
  format: 'date-time',
  description: 'When this service fetched the data from the portal (UTC, ISO 8601).',
};

const summaryProperties = {
  meterId: { type: 'string', description: 'Portal meter ID.', examples: [METER_ID_EXAMPLE] },
  serialNo: {
    type: 'string',
    description:
      'Manufacturer serial number. Opaque; may contain "&". Its prefix is unrelated to make.',
  },
  make: { type: 'string', description: 'Meter manufacturer as the portal spells it.' },
  phaseType: {
    type: 'string',
    description: 'Phase type as the portal reports it, e.g. single, three.',
  },
  installStatus: {
    type: 'string',
    description: 'Install status as the portal reports it, e.g. Installed, Decommissioned, Faulty.',
  },
  dtCode: {
    type: 'string',
    description: 'Code of the distribution transformer (DT) the meter hangs off.',
  },
};
const summaryRequired = Object.keys(summaryProperties);

const hierarchyLevels = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];

const paginationProperties = {
  total: { type: 'integer', minimum: 0, description: 'Total matching records upstream.' },
  limit: { type: 'integer', description: 'Page size requested (echoed).' },
  offset: { type: 'integer', description: 'Zero-based offset requested (echoed).' },
  fetched_at: fetchedAt,
};

/** Schemas registered once with app.addSchema() and referenced as { $ref: '<$id>#' }. */
export const sharedSchemas = [
  {
    $id: 'MeterSummary',
    type: 'object',
    additionalProperties: false,
    required: summaryRequired,
    properties: summaryProperties,
  },
  {
    $id: 'Geo',
    type: 'object',
    additionalProperties: false,
    required: ['latitude', 'longitude'],
    properties: {
      latitude: {
        type: 'number',
        minimum: -90,
        maximum: 90,
        description: 'Degrees, WGS84 (assumed).',
      },
      longitude: {
        type: 'number',
        minimum: -180,
        maximum: 180,
        description: 'Degrees, WGS84 (assumed).',
      },
    },
  },
  {
    $id: 'HierarchyNode',
    type: 'object',
    additionalProperties: false,
    required: ['name', 'code'],
    properties: { name: { type: 'string' }, code: { type: 'string' } },
  },
  {
    $id: 'Hierarchy',
    type: 'object',
    nullable: true,
    description:
      'Position in the network, top to bottom. null when the meter is not in the portal export.',
    additionalProperties: false,
    required: hierarchyLevels,
    properties: Object.fromEntries(
      hierarchyLevels.map((level) => [level, { $ref: 'HierarchyNode#' }]),
    ),
  },
  {
    $id: 'Meter',
    type: 'object',
    additionalProperties: false,
    required: [...summaryRequired, 'installType', 'build', 'geo', 'hierarchy', 'fetched_at'],
    properties: {
      ...summaryProperties,
      installType: {
        type: 'string',
        nullable: true,
        description:
          'e.g. "Whole Current", "CT Operated". null when the meter is not in the export.',
      },
      build: {
        type: 'string',
        nullable: true,
        description: 'Meter build, e.g. "legacy". null when the meter is not in the export.',
      },
      geo: { $ref: 'Geo#' },
      hierarchy: { $ref: 'Hierarchy#' },
      fetched_at: fetchedAt,
    },
  },
  {
    $id: 'MeterList',
    type: 'object',
    additionalProperties: false,
    required: ['data', 'total', 'limit', 'offset', 'fetched_at'],
    properties: {
      data: { type: 'array', items: { $ref: 'MeterSummary#' } },
      ...paginationProperties,
    },
  },
  {
    $id: 'ConsumptionReading',
    type: 'object',
    additionalProperties: false,
    required: ['timestamp', 'kwh', 'kvah', 'voltR'],
    properties: {
      timestamp: {
        type: 'string',
        format: 'date-time',
        description:
          '30-minute reading time, ISO 8601 with +05:30. The portal sends no zone; IST is assumed.',
      },
      kwh: {
        type: 'number',
        description: 'Cumulative active energy register. Unit assumed kWh (the portal gives none).',
      },
      kvah: {
        type: 'number',
        description:
          'Cumulative apparent energy register. Unit assumed kVAh (the portal gives none).',
      },
      voltR: { type: 'number', description: 'R-phase voltage. Only this phase is available.' },
    },
  },
  {
    $id: 'ConsumptionSeries',
    type: 'object',
    additionalProperties: false,
    required: ['meterId', 'data', 'fetched_at'],
    properties: {
      meterId: { type: 'string' },
      data: { type: 'array', items: { $ref: 'ConsumptionReading#' } },
      fetched_at: fetchedAt,
    },
  },
  {
    $id: 'DailyConsumption',
    type: 'object',
    additionalProperties: false,
    required: ['date', 'kwh', 'kvah'],
    properties: {
      date: { type: 'string', format: 'date', description: 'IST calendar day.' },
      kwh: {
        type: 'number',
        description: "Last kWh register of the day minus the previous day's. Unit assumed kWh.",
      },
      kvah: { type: 'number', description: 'Same for the kVAh register. Unit assumed kVAh.' },
    },
  },
  {
    $id: 'SkippedDay',
    type: 'object',
    additionalProperties: false,
    required: ['date', 'reason'],
    properties: {
      date: { type: 'string', format: 'date' },
      reason: {
        type: 'string',
        enum: ['incomplete_day', 'missing_previous_day', 'register_decreased'],
        description:
          'Why no total was reported. register_decreased means the cumulative register went backwards (reset or meter swap).',
      },
    },
  },
  {
    $id: 'DailyConsumptionSeries',
    type: 'object',
    additionalProperties: false,
    required: ['meterId', 'data', 'skippedDays', 'skipped', 'fetched_at'],
    properties: {
      meterId: { type: 'string' },
      data: { type: 'array', items: { $ref: 'DailyConsumption#' } },
      skippedDays: {
        type: 'integer',
        minimum: 0,
        description:
          'Number of anomalous days left out (see skipped). The first day, which only anchors the next, and a final day that ends before 23:30 are expected and not counted.',
      },
      skipped: { type: 'array', items: { $ref: 'SkippedDay#' } },
      fetched_at: fetchedAt,
    },
  },
  {
    $id: 'Transformer',
    type: 'object',
    additionalProperties: false,
    required: ['code', 'name', 'feederCode', 'capacityKva'],
    properties: {
      code: { type: 'string', examples: ['DT-001'] },
      name: { type: 'string' },
      feederCode: { type: 'string' },
      capacityKva: { type: 'number', description: 'Rated capacity in kVA.' },
    },
  },
  {
    $id: 'TransformerList',
    type: 'object',
    additionalProperties: false,
    required: ['data', 'total', 'limit', 'offset', 'fetched_at'],
    properties: {
      data: { type: 'array', items: { $ref: 'Transformer#' } },
      ...paginationProperties,
    },
  },
  {
    $id: 'Health',
    type: 'object',
    additionalProperties: false,
    required: ['status', 'portal', 'fetched_at'],
    properties: {
      status: {
        type: 'string',
        enum: ['ok', 'degraded'],
        description: 'degraded = this service is up but the portal is not.',
      },
      portal: { type: 'string', enum: ['reachable', 'unreachable'] },
      fetched_at: fetchedAt,
    },
  },
  {
    $id: 'ErrorDetail',
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message', 'request_id'],
    properties: {
      code: { type: 'string', description: 'Stable machine-readable code, e.g. meter_not_found.' },
      message: {
        type: 'string',
        description: 'Human-readable explanation. Never contains upstream bodies.',
      },
      request_id: { type: 'string', description: 'Matches the X-Request-ID response header.' },
    },
  },
];

const errorResponse = (description) => ({
  description,
  type: 'object',
  required: ['error'],
  properties: { error: { $ref: 'ErrorDetail#' } },
});

/** Response entries shared by routes: error statuses, all in the single error shape. */
export const errorResponses = {
  400: errorResponse('Invalid request (code invalid_request).'),
  404: errorResponse('Unknown meter or route (meter_not_found, route_not_found).'),
  502: errorResponse(
    'The portal failed or returned something unreadable (portal_unavailable, portal_bad_response).',
  ),
  503: errorResponse('This service could not log in to the portal (portal_auth_failed).'),
  504: errorResponse('The portal timed out (portal_timeout).'),
};

export const limitQuery = {
  type: 'integer',
  minimum: 1,
  maximum: 200,
  default: 50,
  description: 'Maximum records to return.',
};

export const offsetQuery = {
  type: 'integer',
  minimum: 0,
  default: 0,
  description: 'Zero-based index of the first record to return.',
};
