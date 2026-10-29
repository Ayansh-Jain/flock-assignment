import { CACHE_STATE, DEFAULT_CACHE_OPTIONS, createCache } from './cache.js';
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
const STATE_RANK = { HIT: 0, MISS: 1, STALE: 2 };

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
 * Build a response body from cache results. The state is the worst of the parts (STALE over MISS
 * over HIT) and `fetched_at` is the age of the oldest part, so a response never looks fresher than
 * its data. The state travels on a symbol so it is not serialised; app.js turns it into `X-Cache`.
 *
 * @param {object} body
 * @param {import('./cache.js').CacheResult[]} parts
 */
function respond(body, parts) {
  let state = 'HIT';
  for (const part of parts) {
    if (STATE_RANK[part.state] > STATE_RANK[state]) state = part.state;
  }
  const fetchedAtMs = Math.min(...parts.map((part) => part.fetchedAtMs));
  const response = { ...body, fetched_at: new Date(fetchedAtMs).toISOString() };
  if (state === 'STALE') response.stale = true;
  response[CACHE_STATE] = state;
  return response;
}

/**
 * The seam between HTTP routes and the portal: wraps the portal client and the parsers and
 * returns objects shaped like src/schemas.js. Typed portal errors propagate to the central
 * error handler. Reads of meter detail, energy, transformers and the export go through a bounded
 * TTL cache (src/cache.js) that coalesces concurrent loads and falls back to a recently expired
 * entry when the portal fails. The live meter list/search is deliberately not cached.
 *
 * @param {object} options
 * @param {import('./portal/client.js').PortalClient} options.portalClient
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {() => Date} [options.now] Clock; injectable for tests.
 * @param {{ maxEntries: number, staleGraceMs: number, ttlMs: Record<'meter' | 'energy' | 'transformers' | 'export', number> }} [options.cacheOptions]
 */
export function createMeterService({
  portalClient,
  logger,
  now = () => new Date(),
  cacheOptions = DEFAULT_CACHE_OPTIONS,
}) {
  const fetchedAt = () => now().toISOString();
  const cache = createCache({
    maxEntries: cacheOptions.maxEntries,
    staleGraceMs: cacheOptions.staleGraceMs,
    // A meter that is genuinely gone (404) must stay a 404; any other portal failure may fall
    // back to the last good copy.
    serveStaleOn: (error) => error instanceof PortalError && !(error instanceof PortalNotFound),
    logger,
    now: () => now().getTime(),
  });
  const cached = (kind, key, loader) => cache.fetch(key, cacheOptions.ttlMs[kind], loader);

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

  // The export is ~230 KB, so meter detail and the network endpoints share one cached copy
  // (paging and bad-row handling: src/export-pull.js).
  const loadExport = () =>
    cached('export', 'export', async () => {
      const { meters } = await pullExport({ portalClient, logger });
      return new Map(meters.map((meter) => [meter.meterId, meter]));
    });

  const loadTransformerPage = (page) =>
    cached('transformers', `dts:${page}`, async () => {
      const result = parseTransformers(await portalClient.fetchTransformers({ page }));
      return { rows: result.transformers, total: result.total, pageSize: result.pageSize };
    });

  /** A limit/offset window of transformers; the cache result of each page is added to `parts`. */
  function readTransformers({ limit, offset }, parts) {
    return readWindow({
      limit,
      offset,
      fetchPage: async (page) => {
        const part = await loadTransformerPage(page);
        parts.push(part);
        return part.value;
      },
    });
  }

  /** Every transformer, via the same window reader as the public list. */
  async function pullAllTransformers(parts) {
    const { rows, total } = await readTransformers({ limit: MAX_PAGE_LIMIT, offset: 0 }, parts);
    if (rows.length < total) {
      logger.warn({ rows: rows.length, total }, 'transformer list truncated for network checks');
    }
    return rows;
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

  /**
   * The network model, rebuilt from the cached export and transformers on every call. That is
   * cheap at this size, and caching the derived tree would keep stale inputs looking fresh.
   */
  async function loadNetwork(parts) {
    const [exportPart, transformers] = await Promise.all([
      loadExport(),
      pullAllTransformers(parts),
    ]);
    parts.push(exportPart);
    const exportMeters = [...exportPart.value.values()];
    return { exportMeters, ...buildNetwork({ exportMeters, transformers }) };
  }

  /** Export enrichment is optional: if the export itself fails, degrade to "not in export". */
  async function findExportRow(meterId, parts) {
    try {
      const part = await loadExport();
      parts.push(part);
      return part.value.get(meterId) ?? null;
    } catch (error) {
      if (error instanceof PortalUnavailable || error instanceof PortalParseError) {
        logger.warn({ err: error, meterId }, 'portal export unavailable; hierarchy left null');
        return null;
      }
      throw error;
    }
  }

  const readSeries = (meterId) =>
    cached('energy', `energy:${meterId}`, async () =>
      parseEnergy(await portalClient.fetchEnergy(meterId)),
    );

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
      const meterPart = await cached('meter', `meter:${meterId}`, async () => {
        const summary = await findMeterSummary(meterId);
        return { summary, geo: parseGeo(await portalClient.fetchGeo(meterId)) };
      });
      const parts = [meterPart];
      const exportRow = await findExportRow(meterId, parts);
      return respond(
        {
          ...meterPart.value.summary,
          installType: exportRow?.installType ?? null,
          build: exportRow?.build ?? null,
          geo: meterPart.value.geo,
          hierarchy: exportRow?.hierarchy ?? null,
        },
        parts,
      );
    },

    /** @param {string} meterId */
    async getConsumption(meterId) {
      const part = await readSeries(meterId);
      return respond({ meterId, data: part.value }, [part]);
    },

    /** @param {string} meterId */
    async getDailyConsumption(meterId) {
      const part = await readSeries(meterId);
      const { days, skipped } = deriveDailyConsumption(part.value);
      if (skipped.length > 0) {
        logger.warn(
          { meterId, skippedDays: skipped.length, skipped },
          'daily consumption days skipped',
        );
      }
      return respond({ meterId, data: days, skippedDays: skipped.length, skipped }, [part]);
    },

    /** @param {{ limit: number, offset: number }} query */
    async listTransformers({ limit, offset }) {
      const parts = [];
      const { rows, total } = await readTransformers({ limit, offset }, parts);
      return respond({ data: rows, total, limit, offset }, parts);
    },

    /** Top-level nodes (zones) of the network built from the export. */
    async listNetworkRoots() {
      const parts = [];
      const { tree } = await loadNetwork(parts);
      const data = tree.roots.map((code) => toNodeView(tree.nodes.get(code)));
      return respond({ data, total: data.length }, parts);
    },

    /** @param {string} nodeCode */
    async getNetworkNode(nodeCode) {
      const parts = [];
      const { tree } = await loadNetwork(parts);
      const node = getNode(tree, nodeCode);
      return respond(
        {
          node: toNodeView(node),
          children: node.childCodes.map((code) => toNodeView(tree.nodes.get(code))),
          path: pathToRoot(tree, node).map(toNodeView),
        },
        parts,
      );
    },

    /** @param {string} nodeCode @param {{ limit: number, offset: number }} window */
    async listNetworkMeters(nodeCode, { limit, offset }) {
      const parts = [];
      const { tree } = await loadNetwork(parts);
      const meters = collectMeters(tree, getNode(tree, nodeCode));
      return respond(
        {
          data: meters.slice(offset, offset + limit),
          total: meters.length,
          limit,
          offset,
          source: 'portal',
        },
        parts,
      );
    },

    /**
     * Data-quality findings. Costs one extra bounded search listing (about 21 portal calls,
     * cached) to find meters the export lacks; the tree endpoints do not pay for it.
     */
    async listNetworkIssues() {
      const parts = [];
      const [{ exportMeters, issues }, idsPart] = await Promise.all([
        loadNetwork(parts),
        cached('meter', 'search-ids', pullSearchIds),
      ]);
      parts.push(idsPart);
      const data = [
        ...issues,
        ...findMetersMissingFromExport({ exportMeters, searchMeterIds: idsPart.value }),
      ];
      return respond({ data, total: data.length }, parts);
    },

    /**
     * Read-only probe used by /health. It always asks the portal (never the cache), so while the
     * circuit is half-open this call is the probe. Never throws for portal problems.
     */
    async checkPortal() {
      let reachable = true;
      try {
        await portalClient.fetchTransformers({ page: 1 });
      } catch (error) {
        if (!(error instanceof PortalError)) throw error;
        logger.warn({ err: error }, 'portal health probe failed');
        reachable = false;
      }
      const circuit = portalClient.circuitState();
      return {
        status: reachable && circuit === 'closed' ? 'ok' : 'degraded',
        portal: reachable ? 'reachable' : 'unreachable',
        circuit,
        cache: cache.stats(),
        fetched_at: fetchedAt(),
      };
    },

    async close() {
      await portalClient.close();
    },
  };
}
