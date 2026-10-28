import { setTimeout as delay } from 'node:timers/promises';
import { pullExport } from './export-pull.js';
import { buildNetwork } from './hierarchy.js';
import { finishRun, startRun, upsertMeters } from './index-store.js';

const SOURCE = '/portal/export';
const BATCH_SIZE = 100;
const PAGE_DELAY_MS = 500;

/** Cross-checks against /portal/dts are skipped here (no extra portal calls); see /v1/network/issues. */
const SKIPPED_CHECKS = new Set(['dt_not_in_transformers']);

function countByType(issues) {
  const counts = {};
  for (const { type } of issues) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/**
 * Pull the full signed export and upsert it into the index.
 *
 * Read-only against the portal (the existing signed client does the requests, one page at a
 * time with a pause between pages). Writes go in batches, one transaction each, so a crash
 * leaves earlier batches stored; the run row records how it ended. Rows are never deleted: a
 * meter that vanishes from the portal stays in the index until the file is removed (see README).
 *
 * @param {object} options
 * @param {{ fetchExport: Function }} options.portalClient
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {() => Date} [options.now]
 * @param {number} [options.batchSize]
 * @param {number} [options.pageDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{ status: 'ok' | 'incomplete', pages: number, fetched: number, stored: number,
 *   skipped: number, duplicates: number, total: number | null }>}
 */
export async function runSync({
  portalClient,
  db,
  logger,
  now = () => new Date(),
  batchSize = BATCH_SIZE,
  pageDelayMs = PAGE_DELAY_MS,
  sleep = delay,
}) {
  const startedAt = now().toISOString();
  const runId = startRun(db, startedAt, SOURCE);
  try {
    const pulled = await pullExport({ portalClient, logger, delayMs: pageDelayMs, sleep });
    let stored = 0;
    for (let i = 0; i < pulled.meters.length; i += batchSize) {
      stored += upsertMeters(db, pulled.meters.slice(i, i + batchSize), startedAt);
    }

    const issues = buildNetwork({ exportMeters: pulled.meters, transformers: [] }).issues.filter(
      (issue) => !SKIPPED_CHECKS.has(issue.type),
    );
    logger.info(
      {
        rejectedRows: pulled.skipped.count,
        duplicateRows: pulled.duplicates,
        hierarchyIssues: countByType(issues),
      },
      'sync data-quality summary',
    );

    const result = {
      status: pulled.complete ? 'ok' : 'incomplete',
      pages: pulled.pages,
      fetched: pulled.rowsSeen,
      stored,
      skipped: pulled.skipped.count,
      duplicates: pulled.duplicates,
      total: pulled.total,
    };
    finishRun(db, runId, {
      finishedAt: now().toISOString(),
      status: result.status,
      counts: { ...result, totalReported: pulled.total },
    });
    return result;
  } catch (error) {
    finishRun(db, runId, {
      finishedAt: now().toISOString(),
      status: 'failed',
      error: String(error.code ?? error.name),
    });
    throw error;
  }
}
