import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boundingBox, haversineKm } from './geo.js';
import {
  findMeters,
  findMetersInBox,
  IndexNotSynced,
  INDEX_FILTERS,
  openIndexDb,
  readSyncStatus,
} from './index-store.js';

const DISTANCE_DECIMALS = 3;

/** True when the query uses at least one attribute the local index backs. */
export function hasIndexFilters(query) {
  return INDEX_FILTERS.some((name) => query[name] !== undefined);
}

/**
 * Query side of the local index. Opens the database lazily on first use, so an app that never
 * touches an index route (and the OpenAPI export) never creates a file. Every answer states its
 * `source` and `synced_at`, the age of the data.
 *
 * @param {object} options
 * @param {string} options.dbPath
 */
export function createIndexService({ dbPath }) {
  /** @type {Promise<import('node:sqlite').DatabaseSync> | null} */
  let opening = null;

  function getDb() {
    opening ??= (async () => {
      if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
      return openIndexDb(dbPath);
    })();
    return opening;
  }

  /** The open database plus its status; throws IndexNotSynced if no run has stored data. */
  async function ready() {
    const db = await getDb();
    const status = readSyncStatus(db);
    if (status.syncedAt === null) throw new IndexNotSynced();
    return { db, syncedAt: status.syncedAt };
  }

  return {
    /** @param {object} query q, limit, offset and any of the index filters. */
    async searchMeters(query) {
      const { db, syncedAt } = await ready();
      const { rows, total } = findMeters(db, query);
      return {
        data: rows,
        total,
        limit: query.limit,
        offset: query.offset,
        source: 'index',
        synced_at: syncedAt,
      };
    },

    /** @param {{ lat: number, lon: number, radius_km: number, limit: number, offset: number }} query */
    async nearby({ lat, lon, radius_km: radiusKm, limit, offset }) {
      const { db, syncedAt } = await ready();
      const centre = { latitude: lat, longitude: lon };
      const factor = 10 ** DISTANCE_DECIMALS;
      const within = findMetersInBox(db, boundingBox(centre, radiusKm))
        .map((meter) => ({ ...meter, distance_km: haversineKm(centre, meter.geo) }))
        .filter((meter) => meter.distance_km <= radiusKm)
        .sort((a, b) => a.distance_km - b.distance_km || a.meterId.localeCompare(b.meterId))
        .map((meter) => ({
          ...meter,
          distance_km: Math.round(meter.distance_km * factor) / factor,
        }));
      return {
        data: within.slice(offset, offset + limit),
        total: within.length,
        limit,
        offset,
        source: 'index',
        synced_at: syncedAt,
      };
    },

    async syncStatus() {
      const { metersIndexed, syncedAt, lastRun } = readSyncStatus(await getDb());
      return {
        source: 'index',
        meters_indexed: metersIndexed,
        synced_at: syncedAt,
        last_run: lastRun,
      };
    },

    async close() {
      if (!opening) return;
      (await opening).close();
      opening = null;
    },
  };
}
