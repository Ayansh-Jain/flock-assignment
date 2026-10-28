// The local SQLite index of the portal export. All values go through prepared-statement
// parameters; the only SQL assembled from strings is built from the constant fragments below.

import { DatabaseSync } from 'node:sqlite';
import { normaliseCode } from './hierarchy.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meters (
  meter_id TEXT PRIMARY KEY,
  serial_no TEXT NOT NULL,
  make TEXT NOT NULL,
  phase_type TEXT NOT NULL,
  install_status TEXT NOT NULL,
  install_type TEXT NOT NULL,
  build TEXT NOT NULL,
  dt_code TEXT NOT NULL,
  zone_code TEXT NOT NULL, zone_name TEXT NOT NULL,
  circle_code TEXT NOT NULL, circle_name TEXT NOT NULL,
  division_code TEXT NOT NULL, division_name TEXT NOT NULL,
  subdivision_code TEXT NOT NULL, subdivision_name TEXT NOT NULL,
  substation_code TEXT NOT NULL, substation_name TEXT NOT NULL,
  feeder_code TEXT NOT NULL, feeder_name TEXT NOT NULL,
  dt_node_code TEXT NOT NULL, dt_node_name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meters_make ON meters (make);
CREATE INDEX IF NOT EXISTS idx_meters_phase_type ON meters (phase_type);
CREATE INDEX IF NOT EXISTS idx_meters_install_status ON meters (install_status);
CREATE INDEX IF NOT EXISTS idx_meters_dt_code ON meters (dt_code);
CREATE INDEX IF NOT EXISTS idx_meters_zone_code ON meters (zone_code);
CREATE INDEX IF NOT EXISTS idx_meters_feeder_code ON meters (feeder_code);
CREATE INDEX IF NOT EXISTS idx_meters_geo ON meters (latitude, longitude);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  pages INTEGER,
  total_reported INTEGER,
  rows_fetched INTEGER,
  rows_stored INTEGER,
  rows_skipped INTEGER,
  rows_duplicate INTEGER,
  error TEXT
);
`;

const UPSERT_METER = `
INSERT INTO meters (
  meter_id, serial_no, make, phase_type, install_status, install_type, build, dt_code,
  zone_code, zone_name, circle_code, circle_name, division_code, division_name,
  subdivision_code, subdivision_name, substation_code, substation_name,
  feeder_code, feeder_name, dt_node_code, dt_node_name, latitude, longitude, synced_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT (meter_id) DO UPDATE SET
  serial_no = excluded.serial_no, make = excluded.make, phase_type = excluded.phase_type,
  install_status = excluded.install_status, install_type = excluded.install_type,
  build = excluded.build, dt_code = excluded.dt_code,
  zone_code = excluded.zone_code, zone_name = excluded.zone_name,
  circle_code = excluded.circle_code, circle_name = excluded.circle_name,
  division_code = excluded.division_code, division_name = excluded.division_name,
  subdivision_code = excluded.subdivision_code, subdivision_name = excluded.subdivision_name,
  substation_code = excluded.substation_code, substation_name = excluded.substation_name,
  feeder_code = excluded.feeder_code, feeder_name = excluded.feeder_name,
  dt_node_code = excluded.dt_node_code, dt_node_name = excluded.dt_node_name,
  latitude = excluded.latitude, longitude = excluded.longitude, synced_at = excluded.synced_at
`;

/** Filter name -> constant WHERE fragment (one `?` each). Values are always bound parameters. */
const FILTER_SQL = {
  make: 'make = ? COLLATE NOCASE',
  phaseType: 'phase_type = ? COLLATE NOCASE',
  installStatus: 'install_status = ? COLLATE NOCASE',
  installType: 'install_type = ? COLLATE NOCASE',
  build: 'build = ? COLLATE NOCASE',
  dtCode: 'dt_code = ?',
  zone: 'zone_code = ?',
  feeder: 'feeder_code = ?',
};
const CODE_FILTERS = new Set(['dtCode', 'zone', 'feeder']);

/** Names of the query filters the index can back. */
export const INDEX_FILTERS = Object.keys(FILTER_SQL);

const SUMMARY_COLUMNS =
  'meter_id, serial_no, make, phase_type, install_status, dt_code, latitude, longitude';

/** Thrown when an index query is made before any sync has stored data. */
export class IndexNotSynced extends Error {
  constructor() {
    super('The local index has not been synced yet. Run `npm run sync`.');
    this.name = 'IndexNotSynced';
    this.code = 'INDEX_NOT_SYNCED';
  }
}

/**
 * Open (creating if needed) the index database. WAL lets the server read while `npm run sync`
 * writes from another process.
 *
 * @param {string} path File path, or ':memory:'.
 * @returns {DatabaseSync}
 */
export function openIndexDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function toRow(meter, syncedAt) {
  const { hierarchy: h, geo } = meter;
  const code = (level) => normaliseCode(h[level].code);
  return [
    meter.meterId,
    meter.serialNo,
    meter.make,
    meter.phaseType,
    meter.installStatus,
    meter.installType,
    meter.build,
    normaliseCode(meter.dtCode),
    code('zone'),
    h.zone.name,
    code('circle'),
    h.circle.name,
    code('division'),
    h.division.name,
    code('subdivision'),
    h.subdivision.name,
    code('substation'),
    h.substation.name,
    code('feeder'),
    h.feeder.name,
    code('dt'),
    h.dt.name,
    geo.latitude,
    geo.longitude,
    syncedAt,
  ];
}

/**
 * Upsert one batch of parsed export meters in a single transaction (idempotent: re-running
 * with the same rows changes nothing but `synced_at`).
 *
 * @param {DatabaseSync} db
 * @param {object[]} meters Rows from parseExport.
 * @param {string} syncedAt ISO timestamp.
 * @returns {number} Rows written.
 */
export function upsertMeters(db, meters, syncedAt) {
  const statement = db.prepare(UPSERT_METER);
  db.exec('BEGIN');
  try {
    for (const meter of meters) statement.run(...toRow(meter, syncedAt));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return meters.length;
}

/**
 * @param {DatabaseSync} db
 * @param {string} startedAt
 * @param {string} source
 * @returns {number} The new run's id.
 */
export function startRun(db, startedAt, source) {
  const result = db
    .prepare("INSERT INTO sync_runs (started_at, status, source) VALUES (?, 'running', ?)")
    .run(startedAt, source);
  return Number(result.lastInsertRowid);
}

/**
 * @param {DatabaseSync} db
 * @param {number} id
 * @param {object} outcome
 * @param {string} outcome.finishedAt
 * @param {'ok' | 'incomplete' | 'failed'} outcome.status
 * @param {{ pages?: number, totalReported?: number | null, fetched?: number, stored?: number,
 *   skipped?: number, duplicates?: number }} [outcome.counts]
 * @param {string | null} [outcome.error] A short code, never an upstream body.
 */
export function finishRun(db, id, { finishedAt, status, counts = {}, error = null }) {
  db.prepare(
    `UPDATE sync_runs SET finished_at = ?, status = ?, pages = ?, total_reported = ?,
       rows_fetched = ?, rows_stored = ?, rows_skipped = ?, rows_duplicate = ?, error = ?
     WHERE id = ?`,
  ).run(
    finishedAt,
    status,
    counts.pages ?? null,
    counts.totalReported ?? null,
    counts.fetched ?? null,
    counts.stored ?? null,
    counts.skipped ?? null,
    counts.duplicates ?? null,
    error,
    id,
  );
}

function runView(row) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    started_at: row.started_at,
    finished_at: row.finished_at,
    pages: row.pages,
    total_reported: row.total_reported,
    rows_fetched: row.rows_fetched,
    rows_stored: row.rows_stored,
    rows_skipped: row.rows_skipped,
    rows_duplicate: row.rows_duplicate,
    error: row.error,
  };
}

/**
 * @param {DatabaseSync} db
 * @returns {{ metersIndexed: number, syncedAt: string | null, lastRun: object | null }}
 *   `syncedAt` is when the last run that stored data (ok or incomplete) finished.
 */
export function readSyncStatus(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM meters').get();
  const last = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  const stored = db
    .prepare(
      "SELECT finished_at FROM sync_runs WHERE status IN ('ok', 'incomplete') ORDER BY id DESC LIMIT 1",
    )
    .get();
  return {
    metersIndexed: count,
    syncedAt: stored?.finished_at ?? null,
    lastRun: last ? runView(last) : null,
  };
}

function summaryOf(row) {
  return {
    meterId: row.meter_id,
    serialNo: row.serial_no,
    make: row.make,
    phaseType: row.phase_type,
    installStatus: row.install_status,
    dtCode: row.dt_code,
  };
}

/**
 * Filter and page the indexed meters. Every filter is an exact, case-insensitive match (codes
 * are normalised like the network tree's); `q` is a case-sensitive substring of meter id or
 * serial number, like the live search.
 *
 * @param {DatabaseSync} db
 * @param {{ q?: string, limit: number, offset: number } & Record<string, string | number | undefined>} query
 * @returns {{ rows: object[], total: number }}
 */
export function findMeters(db, { q, limit, offset, ...filters }) {
  const clauses = [];
  const params = [];
  if (q) {
    clauses.push('(instr(meter_id, ?) > 0 OR instr(serial_no, ?) > 0)');
    params.push(q, q);
  }
  for (const [name, fragment] of Object.entries(FILTER_SQL)) {
    if (filters[name] === undefined) continue;
    clauses.push(fragment);
    params.push(CODE_FILTERS.has(name) ? normaliseCode(filters[name]) : filters[name]);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM meters ${where}`).get(...params);
  const rows = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM meters ${where} ORDER BY meter_id LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows: rows.map(summaryOf), total: count };
}

/**
 * Meters inside a latitude/longitude box (the SQL prefilter for the near query).
 *
 * @param {DatabaseSync} db
 * @param {{ minLat: number, maxLat: number, lonRanges: [[number, number], [number, number]] }} box
 * @returns {object[]} Summaries plus `geo`.
 */
export function findMetersInBox(db, { minLat, maxLat, lonRanges }) {
  const [first, second] = lonRanges;
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM meters
       WHERE latitude BETWEEN ? AND ?
         AND ((longitude BETWEEN ? AND ?) OR (longitude BETWEEN ? AND ?))
       ORDER BY meter_id`,
    )
    .all(minLat, maxLat, first[0], first[1], second[0], second[1])
    .map((row) => ({
      ...summaryOf(row),
      geo: { latitude: row.latitude, longitude: row.longitude },
    }));
}
