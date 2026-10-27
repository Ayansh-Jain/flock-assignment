// Pure functions: raw portal JSON -> clean plain objects. No I/O, no logging.
// Anything not shaped as observed (notes/protocol-notes.md) throws PortalParseError
// instead of producing half-garbage. Errors name the response and field, never the raw body.
import { PortalParseError } from './errors.js';

const HIERARCHY_LEVELS = [
  'zone',
  'circle',
  'division',
  'subdivision',
  'substation',
  'feeder',
  'dt',
];
// WHY: the portal's timestamps carry no zone; we treat them as IST (an assumption, see notes).
const IST_OFFSET = '+05:30';
const TIMESTAMP_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
// WHY: Number('') is 0 and Number('1e3') is 1000; accept only plain decimals so blanks fail loudly.
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
// Register readings carry 2 decimals; rounding hides float noise such as 0.4300000000001.
const REGISTER_DECIMALS = 100;
const LAST_SLOT_OF_DAY = '23:30';
const EXPORT_SKIP_SAMPLE_SIZE = 5;

function fail(label, reason) {
  throw new PortalParseError(label, reason);
}

function expectObject(label, value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, `${what} is not an object`);
  }
  return value;
}

function expectArray(label, value, what) {
  if (!Array.isArray(value)) fail(label, `${what} is not an array`);
  return value;
}

/** Strings are trimmed; the portal sends none we need verbatim with edge whitespace. */
function expectString(label, value, field) {
  if (typeof value !== 'string') fail(label, `${field} is not a string`);
  return value.trim();
}

function expectNonEmptyString(label, value, field) {
  const text = expectString(label, value, field);
  if (text === '') fail(label, `${field} is empty`);
  return text;
}

function expectInteger(label, value, field) {
  if (!Number.isInteger(value) || value < 0) fail(label, `${field} is not a non-negative integer`);
  return value;
}

/** WHY: the portal sends kwh, kvah, voltR and latitude/longitude as strings, but numbers elsewhere. */
function toNumber(label, value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value.trim())) {
    fail(label, `${field} is not a number`);
  }
  return Number(value.trim());
}

function expectCoordinates(label, latitude, longitude) {
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    fail(label, 'coordinates are out of range');
  }
  return { latitude, longitude };
}

/** "DD/MM/YYYY HH:mm" (no zone, assumed IST) -> ISO-8601 with +05:30. */
function toIsoIst(label, value) {
  const match = TIMESTAMP_PATTERN.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) fail(label, 'timestamp is not DD/MM/YYYY HH:mm');
  const [, day, month, year, hour, minute] = match;
  const check = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute));
  if (
    check.getUTCFullYear() !== +year ||
    check.getUTCMonth() !== +month - 1 ||
    check.getUTCDate() !== +day ||
    check.getUTCHours() !== +hour ||
    check.getUTCMinutes() !== +minute
  ) {
    fail(label, 'timestamp is not a real calendar time');
  }
  return `${year}-${month}-${day}T${hour}:${minute}:00${IST_OFFSET}`;
}

function parseMeterBasics(label, row) {
  return {
    meterId: expectNonEmptyString(label, row.meterId, 'meterId'),
    // WHY: serials may contain "&" (e.g. "L&84997") and their prefix is unrelated to `make`;
    // they are opaque strings, passed through untouched.
    serialNo: expectString(label, row.serialNo, 'serialNo'),
    make: expectString(label, row.make, 'make'),
    phaseType: expectString(label, row.phaseType, 'phaseType'),
    installStatus: expectString(label, row.installStatus, 'installStatus'),
    dtCode: expectString(label, row.dtCode, 'dtCode'),
  };
}

/**
 * Parse /portal/meters/search.
 * @param {unknown} body
 * @returns {{ meters: object[], total: number, page: number, pageSize: number }}
 */
export function parseMeterList(body) {
  const label = '/portal/meters/search';
  const root = expectObject(label, body, 'response');
  return {
    meters: expectArray(label, root.data, 'data').map((row) =>
      parseMeterBasics(label, expectObject(label, row, 'meter row')),
    ),
    total: expectInteger(label, root.total, 'total'),
    page: expectInteger(label, root.page, 'page'),
    pageSize: expectInteger(label, root.pageSize, 'pageSize'),
  };
}

/**
 * Parse /portal/meters/{id}/geo. WHY: latitude/longitude arrive as strings.
 * @param {unknown} body
 * @returns {{ latitude: number, longitude: number }}
 */
export function parseGeo(body) {
  const label = '/portal/meters/{id}/geo';
  const data = expectObject(label, expectObject(label, body, 'response').data, 'data');
  return expectCoordinates(
    label,
    toNumber(label, data.latitude, 'latitude'),
    toNumber(label, data.longitude, 'longitude'),
  );
}

/**
 * Parse /portal/meters/{id}/energy into 30-minute readings in time order.
 * kwh/kvah are cumulative registers (not per-interval), unit assumed kWh/kVAh.
 * @param {unknown} body
 * @returns {{ timestamp: string, kwh: number, kvah: number, voltR: number }[]}
 */
export function parseEnergy(body) {
  const label = '/portal/meters/{id}/energy';
  const rows = expectArray(label, expectObject(label, body, 'response').data, 'data').map((raw) => {
    const row = expectObject(label, raw, 'reading');
    return {
      timestamp: toIsoIst(label, row.timestamp),
      kwh: toNumber(label, row.kwh, 'kwh'),
      kvah: toNumber(label, row.kvah, 'kvah'),
      voltR: toNumber(label, row.voltR, 'voltR'),
    };
  });
  // WHY: a single offset means ISO strings sort chronologically; daily derivation needs order.
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function previousDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function round(value) {
  return Math.round(value * REGISTER_DECIMALS) / REGISTER_DECIMALS;
}

/**
 * Derive daily consumption from cumulative readings (decision 4 in notes/decisions.md).
 *
 * Day D = last reading of D minus last reading of D-1, per IST calendar day. The last slot of
 * a day is 23:30, which is why the series starts at 23:30 on its first day: that reading only
 * anchors the next day and is never reported as a day itself. Days are skipped, not guessed.
 *
 * Expected edges are skipped silently: the first date (it is the anchor) and a final date that
 * stops before 23:30 (a first date that stops early is equally expected). Any other skipped day is an anomaly and is returned in `skipped` so the
 * caller can show it: `incomplete_day`, `missing_previous_day` (gap in the series), or
 * `register_decreased` (a reset or meter swap would give a negative figure).
 *
 * @param {{ timestamp: string, kwh: number, kvah: number }[]} readings Output of parseEnergy.
 * @returns {{
 *   days: { date: string, kwh: number, kvah: number }[],
 *   skipped: { date: string, reason: 'incomplete_day' | 'missing_previous_day' | 'register_decreased' }[]
 * }} `date` is the IST calendar day.
 */
export function deriveDailyConsumption(readings) {
  const lastByDate = new Map();
  for (const reading of readings) {
    // WHY: timestamps are already +05:30, so the leading date is the IST calendar day.
    lastByDate.set(reading.timestamp.slice(0, 10), reading); // readings are in time order
  }
  const complete = (reading) => reading?.timestamp.slice(11, 16) === LAST_SLOT_OF_DAY;
  const days = [];
  const skipped = [];
  const dates = [...lastByDate.keys()];
  dates.forEach((date, index) => {
    const last = lastByDate.get(date);
    const previous = lastByDate.get(previousDate(date));
    if (!complete(last)) {
      if (index !== 0 && index !== dates.length - 1)
        skipped.push({ date, reason: 'incomplete_day' });
      return;
    }
    if (index === 0) return;
    if (!complete(previous)) {
      skipped.push({ date, reason: 'missing_previous_day' });
      return;
    }
    const kwh = round(last.kwh - previous.kwh);
    const kvah = round(last.kvah - previous.kvah);
    if (kwh < 0 || kvah < 0) {
      skipped.push({ date, reason: 'register_decreased' });
      return;
    }
    days.push({ date, kwh, kvah });
  });
  return { days, skipped };
}

/**
 * Parse /portal/dts.
 * @param {unknown} body
 * @returns {{ transformers: object[], total: number, page: number, pageSize: number }}
 */
export function parseTransformers(body) {
  const label = '/portal/dts';
  const root = expectObject(label, body, 'response');
  return {
    transformers: expectArray(label, root.data, 'data').map((raw) => {
      const row = expectObject(label, raw, 'transformer row');
      return {
        code: expectNonEmptyString(label, row.code, 'code'),
        name: expectString(label, row.name, 'name'),
        feederCode: expectString(label, row.feederCode, 'feederCode'),
        // WHY: unlike most numbers from the portal, capacityKva is a real number already.
        capacityKva: toNumber(label, row.capacityKva, 'capacityKva'),
      };
    }),
    total: expectInteger(label, root.total, 'total'),
    page: expectInteger(label, root.page, 'page'),
    pageSize: expectInteger(label, root.pageSize, 'pageSize'),
  };
}

function parseHierarchy(label, raw) {
  const hierarchy = expectObject(label, raw, 'hierarchy');
  return Object.fromEntries(
    HIERARCHY_LEVELS.map((level) => {
      const node = expectObject(label, hierarchy[level], `hierarchy.${level}`);
      return [
        level,
        {
          name: expectString(label, node.name, `hierarchy.${level}.name`),
          code: expectNonEmptyString(label, node.code, `hierarchy.${level}.code`),
        },
      ];
    }),
  );
}

/**
 * Parse /portal/export: the richer meter rows (adds installType, build, hierarchy, geo).
 * WHY: export `geo` is {lat, lng} as numbers, unlike the /geo endpoint's string lat/long;
 * we normalise both to {latitude, longitude}.
 *
 * Unlike the single-meter parsers this one is deliberately lenient per ROW (decision in
 * notes/decisions.md): a malformed row is skipped and reported in `skipped` (count plus a
 * small sample) so one bad meter cannot sink a bulk pull. A malformed ENVELOPE (not an object,
 * `data` not an array, bad `total`) still throws PortalParseError.
 *
 * @param {unknown} body
 * @returns {{
 *   meters: object[],
 *   total: number,
 *   skipped: { count: number, samples: { index: number, meterId: string | null, reason: string }[] }
 * }}
 */
export function parseExport(body) {
  const label = '/portal/export';
  const root = expectObject(label, body, 'response');
  const rows = expectArray(label, root.data, 'data');
  const total = expectInteger(label, root.total, 'total');
  const meters = [];
  const skipped = { count: 0, samples: [] };
  rows.forEach((raw, index) => {
    try {
      meters.push(parseExportRow(label, raw));
    } catch (error) {
      if (!(error instanceof PortalParseError)) throw error;
      skipped.count += 1;
      if (skipped.samples.length < EXPORT_SKIP_SAMPLE_SIZE) {
        skipped.samples.push({
          index,
          meterId: typeof raw?.meterId === 'string' ? raw.meterId : null,
          reason: error.message,
        });
      }
    }
  });
  return { meters, total, skipped };
}

function parseExportRow(label, raw) {
  const row = expectObject(label, raw, 'meter row');
  const geo = expectObject(label, row.geo, 'geo');
  return {
    ...parseMeterBasics(label, row),
    installType: expectString(label, row.installType, 'installType'),
    build: expectString(label, row.build, 'build'),
    hierarchy: parseHierarchy(label, row.hierarchy),
    geo: expectCoordinates(
      label,
      toNumber(label, geo.lat, 'geo.lat'),
      toNumber(label, geo.lng, 'geo.lng'),
    ),
  };
}
