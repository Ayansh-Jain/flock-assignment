// Pulls the full signed portal export into the local SQLite index. Run: npm run sync
// Read-only against the portal: one login, then signed GETs one page at a time, 0.5 s apart.
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openIndexDb } from '../src/index-store.js';
import { createPortalClient } from '../src/portal/client.js';
import { runSync } from '../src/sync.js';

const print = (level) => (fields, message) =>
  console.log(JSON.stringify({ level, msg: message ?? fields, ...(message && fields) }));
const logger = {
  debug: () => {}, // per-request portal chatter; not useful in a progress printout
  info: print('info'),
  warn: print('warn'),
  error: print('error'),
};

let portalClient;
let db;
let exitCode = 0;
try {
  const config = loadConfig();
  await mkdir(dirname(config.DB_PATH), { recursive: true });
  db = openIndexDb(config.DB_PATH);
  portalClient = createPortalClient({ config, logger });
  const result = await runSync({ portalClient, db, logger });
  console.log(`Sync ${result.status}: stored ${result.stored} meters into ${config.DB_PATH}`);
  if (result.status !== 'ok') exitCode = 2;
} catch (error) {
  console.error(`Sync failed: ${error.message}`);
  exitCode = 1;
} finally {
  await portalClient?.close();
  db?.close();
}
process.exit(exitCode);
