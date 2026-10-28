import { pullExport } from './export-pull.js';
import {
  buildNetwork,
  collectMeters,
  findMetersMissingFromExport,
  getNode,
  pathToRoot,
  toNodeView,
} from './hierarchy.js';
import {
  PortalError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from './portal/errors.js';
import {
  deriveDailyConsumption,
  parseEnergy,
  parseGeo,
  parseMeterList,
  parseTransformers,
} from './portal/parsers.js';

// Observed: both /portal/meters/search and /portal/dts return 20 rows per page.
const UPSTREAM_PAGE_SIZE = 20;
const MAX_LOOKUP_PAGES = 5;
const MAX_SEARCH_PAGES = 25;
const MAX_PAGE_LIMIT = 200;
const EXPORT_MEMO_TTL_MS = 60_000;

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

  /** The portal export as a map by meterId (paging and bad-row handling: src/export-pull.js). */
  async function pullExportIndex() {
    const { meters } = await pullExport({ portalClient, logger });
    return new Map(meters.map((meter) => [meter.meterId, meter]));
  }

  /**
   * Wrap a loader in a one-entry in-process memo of `exportTtlMs`. One entry only (so memory is
   * bounded by the dataset), concurrent callers share one load, and a failed load is never kept.
   * Staleness is therefore at most the TTL; there is no invalidation and no cross-process sharing.
   */
  function memoised(load) {
    /** @type {{ loadedAt: number, promise: Promise<any> } | null} */
    let memo = null;
    return async () => {
      const nowMs = now().getTime();
      if (!memo || nowMs - memo.loadedAt >= exportTtlMs) {
        memo = { loadedAt: nowMs, promise: load() };
      }
      const entry = memo;
      try {
        return await entry.promise;
      } catch (error) {
        if (memo === entry) memo = null;
        throw error;
      }
    };
  }

  // The export is ~230 KB, so meter detail and the network endpoints share one pull.
  const loadExportIndex = memoised(pullExportIndex);

  /** Every transformer, via the same window reader as the public list. */
  async function pullAllTransformers() {
    const { rows, total } = await readWindow({
      limit: MAX_PAGE_LIMIT,
      offset: 0,
      fetchPage: fetchTransformerPage,
    });
    if (rows.length < total) {
      logger.warn({ rows: rows.length, total }, 'transformer list truncated for network checks');
    }
    return rows;
  }

  async function fetchTransformerPage(page) {
    const result = parseTransformers(await portalClient.fetchTransformers({ page }));
    return { rows: result.transformers, total: result.total, pageSize: result.pageSize };
  }

  /** Every meter id the portal search lists, sequentially (polite) and bounded. */
  async function pullSearchIds() {
    const ids = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const result = parseMeterList(await portalClient.fetchMeterList({ q: '', page }));
      ids.push(...result.meters.map((meter) => meter.meterId));
      if (result.meters.length === 0 || page * result.pageSize >= result.total) return ids;
    }
    logger.warn({ ids: ids.length }, 'portal search listing may be incomplete');
    return ids;
  }

  const loadNetwork = memoised(async () => {
    const [index, transformers] = await Promise.all([loadExportIndex(), pullAllTransformers()]);
    const exportMeters = [...index.values()];
    return { exportMeters, ...buildNetwork({ exportMeters, transformers }) };
  });
  const loadSearchIds = memoised(pullSearchIds);

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
      return { data: rows, total, limit, offset, source: 'portal', fetched_at: fetchedAt() };
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
      const { rows, total } = await readWindow({ limit, offset, fetchPage: fetchTransformerPage });
      return { data: rows, total, limit, offset, fetched_at: fetchedAt() };
    },

    /** Top-level nodes (zones) of the network built from the export. */
    async listNetworkRoots() {
      const { tree } = await loadNetwork();
      const data = tree.roots.map((code) => toNodeView(tree.nodes.get(code)));
      return { data, total: data.length, fetched_at: fetchedAt() };
    },

    /** @param {string} nodeCode */
    async getNetworkNode(nodeCode) {
      const { tree } = await loadNetwork();
      const node = getNode(tree, nodeCode);
      return {
        node: toNodeView(node),
        children: node.childCodes.map((code) => toNodeView(tree.nodes.get(code))),
        path: pathToRoot(tree, node).map(toNodeView),
        fetched_at: fetchedAt(),
      };
    },

    /** @param {string} nodeCode @param {{ limit: number, offset: number }} window */
    async listNetworkMeters(nodeCode, { limit, offset }) {
      const { tree } = await loadNetwork();
      const meters = collectMeters(tree, getNode(tree, nodeCode));
      return {
        data: meters.slice(offset, offset + limit),
        total: meters.length,
        limit,
        offset,
        source: 'portal',
        fetched_at: fetchedAt(),
      };
    },

    /**
     * Data-quality findings. Costs one extra bounded search listing (about 21 portal calls,
     * memoised) to find meters the export lacks; the tree endpoints do not pay for it.
     */
    async listNetworkIssues() {
      const [{ exportMeters, issues }, searchMeterIds] = await Promise.all([
        loadNetwork(),
        loadSearchIds(),
      ]);
      const data = [...issues, ...findMetersMissingFromExport({ exportMeters, searchMeterIds })];
      return { data, total: data.length, fetched_at: fetchedAt() };
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
