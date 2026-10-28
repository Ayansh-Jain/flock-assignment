import { setTimeout as delay } from 'node:timers/promises';
import { parseExport } from './portal/parsers.js';

const MAX_EXPORT_PAGES = 10;
const SKIP_SAMPLE_SIZE = 5;

/**
 * Pull the whole portal export through the signed client, one page at a time. Shared by the
 * request-path memo (src/service.js) and the bulk sync (src/sync.js) so both page the same way.
 *
 * Defensive because the export's real page size and past-the-end behaviour were never observed:
 * the loop is bounded, stops once `total` rows were seen, stops on an empty page, and stops on a
 * repeated page that adds no new meter. Malformed rows are skipped and logged, never fatal.
 *
 * @param {object} options
 * @param {{ fetchExport: (args: { page: number }) => Promise<unknown> }} options.portalClient
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {number} [options.maxPages]
 * @param {number} [options.delayMs] Pause between pages (politeness); none before the first.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injectable for tests.
 * @returns {Promise<{
 *   meters: object[], pages: number, total: number | null, rowsSeen: number, duplicates: number,
 *   skipped: { count: number, samples: object[] }, complete: boolean
 * }>}
 */
export async function pullExport({
  portalClient,
  logger,
  maxPages = MAX_EXPORT_PAGES,
  delayMs = 0,
  sleep = delay,
}) {
  const byId = new Map();
  const skipped = { count: 0, samples: [] };
  let rowsSeen = 0;
  let parsedRows = 0;
  let total = null;
  let pages = 0;
  let complete = false;
  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1 && delayMs > 0) await sleep(delayMs);
    const parsed = parseExport(await portalClient.fetchExport({ page }));
    pages = page;
    total = parsed.total;
    const before = byId.size;
    for (const meter of parsed.meters) byId.set(meter.meterId, meter);
    parsedRows += parsed.meters.length;
    skipped.count += parsed.skipped.count;
    skipped.samples.push(...parsed.skipped.samples);
    rowsSeen += parsed.meters.length + parsed.skipped.count;
    logger.info({ page, rows: parsed.meters.length, rowsSeen, total }, 'portal export page read');
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
      { skippedCount: skipped.count, samples: skipped.samples.slice(0, SKIP_SAMPLE_SIZE) },
      'skipped malformed rows in portal export',
    );
  }
  return {
    meters: [...byId.values()],
    pages,
    total,
    rowsSeen,
    duplicates: parsedRows - byId.size,
    skipped: { count: skipped.count, samples: skipped.samples.slice(0, SKIP_SAMPLE_SIZE) },
    complete,
  };
}
