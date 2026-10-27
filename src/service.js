import {
  PortalError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from './portal/errors.js';
import {
  deriveDailyConsumption,
  parseEnergy,
  parseExport,
  parseGeo,
  parseMeterList,
  parseTransformers,
} from './portal/parsers.js';

// Observed: both /portal/meters/search and /portal/dts return 20 rows per page.
const UPSTREAM_PAGE_SIZE = 20;
const MAX_LOOKUP_PAGES = 5;
const MAX_EXPORT_PAGES = 10;
const EXPORT_MEMO_TTL_MS = 60_000;
const EXPORT_SKIP_SAMPLE_SIZE = 5;

/**
 * Serve a limit/offset window from a fixed-size paged upstream.
 * Page 1 is always fetched first (it carries `total`), and pages beyond the last one are never
 * requested because the portal's behaviour past the end has not been observed.
 *
 * @param {{ limit: number, offset: number, fetchPage: (page: number) => Promise<{ rows: object[], total: number, pageSize: number }> }} args
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function readWindow({ limit, offset, fetchPage }) {
  const first = await fetchPage(1);
  if (first.pageSize !== UPSTREAM_PAGE_SIZE) {
    throw new PortalParseError(
      'upstream paging',
      `page size is ${first.pageSize}, expected ${UPSTREAM_PAGE_SIZE}`,
    );
  }
  const { total } = first;
  if (offset >= total) return { rows: [], total };

  const startPage = Math.floor(offset / UPSTREAM_PAGE_SIZE) + 1;
  const endPage = Math.floor((Math.min(offset + limit, total) - 1) / UPSTREAM_PAGE_SIZE) + 1;
  const rows = [];
  for (let page = startPage; page <= endPage; page += 1) {
    rows.push(...(page === 1 ? first.rows : (await fetchPage(page)).rows));
  }
  const skip = offset - (startPage - 1) * UPSTREAM_PAGE_SIZE;
  return { rows: rows.slice(skip, skip + limit), total };
}

/**
 * The seam between HTTP routes and the portal: wraps the portal client and the parsers and
 * returns objects shaped like src/schemas.js. Typed portal errors propagate to the central
 * error handler. The only caching is a tiny memo of the export index (see `loadExportIndex`);
 * the general cache is a later extension.
 *
 * @param {object} options
 * @param {import('./portal/client.js').PortalClient} options.portalClient
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {() => Date} [options.now] Clock; injectable for tests.
 * @param {number} [options.exportTtlMs] How long a pulled export index is reused.
 */
export function createMeterService({
  portalClient,
  logger,
  now = () => new Date(),
  exportTtlMs = EXPORT_MEMO_TTL_MS,
}) {
  const fetchedAt = () => now().toISOString();
  /** @type {{ loadedAt: number, promise: Promise<Map<string, object>> } | null} */
  let exportMemo = null;

  /** Find the search row whose meterId matches exactly (search is a partial match). */
  async function findMeterSummary(meterId) {
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page += 1) {
      const result = parseMeterList(await portalClient.fetchMeterList({ q: meterId, page }));
      const match = result.meters.find((meter) => meter.meterId === meterId);
      if (match) return match;
      if (page * result.pageSize >= result.total) break;
    }
    throw new PortalNotFound(`No meter with id ${meterId}`);
  }

  /**
   * Pull the portal export (bounded, defensive about paging) into a map by meterId. Bad rows
   * are skipped and reported in the log, never aborting the pull.
   */
  async function pullExportIndex() {
    const byId = new Map();
    const skipped = { count: 0, samples: [] };
    let rowsSeen = 0;
    let complete = false;
    for (let page = 1; page <= MAX_EXPORT_PAGES; page += 1) {
      const parsed = parseExport(await portalClient.fetchExport({ page }));
      const before = byId.size;
      for (const meter of parsed.meters) byId.set(meter.meterId, meter);
      skipped.count += parsed.skipped.count;
      skipped.samples.push(...parsed.skipped.samples);
      rowsSeen += parsed.meters.length + parsed.skipped.count;
      if (rowsSeen === 0 || rowsSeen >= parsed.total) {
        complete = true;
        break;
      }
      // A repeated page adds nothing new: stop instead of looping to the page cap.
      if (parsed.meters.length > 0 && byId.size === before) break;
    }
    if (!complete) logger.warn({ meters: byId.size }, 'portal export may be incomplete');
    if (skipped.count > 0) {
      logger.warn(
        { skippedCount: skipped.count, samples: skipped.samples.slice(0, EXPORT_SKIP_SAMPLE_SIZE) },
        'skipped malformed rows in portal export',
      );
    }
    return byId;
  }

  /**
   * The export index, memoised in-process for `exportTtlMs` so meter detail does not re-pull
   * ~230 KB per request. One entry only (so memory is bounded by the dataset), concurrent
   * callers share one pull, and a failed pull is never kept. Staleness is therefore at most
   * the TTL; there is no invalidation and no cross-process sharing.
   */
  async function loadExportIndex() {
    const nowMs = now().getTime();
    if (!exportMemo || nowMs - exportMemo.loadedAt >= exportTtlMs) {
      exportMemo = { loadedAt: nowMs, promise: pullExportIndex() };
    }
    const entry = exportMemo;
    try {
      return await entry.promise;
    } catch (error) {
      if (exportMemo === entry) exportMemo = null;
      throw error;
    }
  }

  /** Export enrichment is optional: if the export itself fails, degrade to "not in export". */
  async function findExportRow(meterId) {
    try {
      return (await loadExportIndex()).get(meterId) ?? null;
    } catch (error) {
      if (error instanceof PortalUnavailable || error instanceof PortalParseError) {
        logger.warn({ err: error, meterId }, 'portal export unavailable; hierarchy left null');
        return null;
      }
      throw error;
    }
  }

  async function readSeries(meterId) {
    return parseEnergy(await portalClient.fetchEnergy(meterId));
  }

  return {
    /** @param {{ q?: string, limit: number, offset: number }} query */
    async listMeters({ q = '', limit, offset }) {
      const { rows, total } = await readWindow({
        limit,
        offset,
        fetchPage: async (page) => {
          const result = parseMeterList(await portalClient.fetchMeterList({ q, page }));
          return { rows: result.meters, total: result.total, pageSize: result.pageSize };
        },
      });
      return { data: rows, total, limit, offset, fetched_at: fetchedAt() };
    },

    /** @param {string} meterId */
    async getMeter(meterId) {
      const summary = await findMeterSummary(meterId);
      const [geoBody, exportRow] = await Promise.all([
        portalClient.fetchGeo(meterId),
        findExportRow(meterId),
      ]);
      return {
        ...summary,
        installType: exportRow?.installType ?? null,
        build: exportRow?.build ?? null,
        geo: parseGeo(geoBody),
        hierarchy: exportRow?.hierarchy ?? null,
        fetched_at: fetchedAt(),
      };
    },

    /** @param {string} meterId */
    async getConsumption(meterId) {
      return { meterId, data: await readSeries(meterId), fetched_at: fetchedAt() };
    },

    /** @param {string} meterId */
    async getDailyConsumption(meterId) {
      const { days, skipped } = deriveDailyConsumption(await readSeries(meterId));
      if (skipped.length > 0) {
        logger.warn(
          { meterId, skippedDays: skipped.length, skipped },
          'daily consumption days skipped',
        );
      }
      return {
        meterId,
        data: days,
        skippedDays: skipped.length,
        skipped,
        fetched_at: fetchedAt(),
      };
    },

    /** @param {{ limit: number, offset: number }} query */
    async listTransformers({ limit, offset }) {
      const { rows, total } = await readWindow({
        limit,
        offset,
        fetchPage: async (page) => {
          const result = parseTransformers(await portalClient.fetchTransformers({ page }));
          return { rows: result.transformers, total: result.total, pageSize: result.pageSize };
        },
      });
      return { data: rows, total, limit, offset, fetched_at: fetchedAt() };
    },

    /** Cheap read-only probe used by /health. Never throws for portal problems. */
    async checkPortal() {
      try {
        await portalClient.fetchTransformers({ page: 1 });
        return { status: 'ok', portal: 'reachable', fetched_at: fetchedAt() };
      } catch (error) {
        if (!(error instanceof PortalError)) throw error;
        logger.warn({ err: error }, 'portal health probe failed');
        return { status: 'degraded', portal: 'unreachable', fetched_at: fetchedAt() };
      }
    },

    async close() {
      await portalClient.close();
    },
  };
}
