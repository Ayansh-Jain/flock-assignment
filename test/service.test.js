import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PortalAuthError,
  PortalNotFound,
  PortalParseError,
  PortalUnavailable,
} from '../src/portal/errors.js';
import { createMeterService } from '../src/service.js';
import { createRecordingLogger, fixtureBody } from './helpers.js';

const NOW = new Date('2026-10-28T10:00:00.000Z');
const TOTAL = 45;

const meterRow = (i) => ({
  meterId: `J${100000 + i}`,
  serialNo: `SN${i}`,
  make: 'HPL',
  phaseType: 'single',
  installStatus: 'Installed',
  dtCode: 'DT-001',
});
const ALL_METERS = Array.from({ length: TOTAL }, (_, i) => meterRow(i));

/** A fake portal client over 45 generated meters, recording which upstream pages were asked for. */
async function createFakePortal(overrides = {}) {
  const energy = await fixtureBody('meter-energy');
  const geo = await fixtureBody('meter-geo');
  const exportBody = await fixtureBody('export-page1');
  const calls = { search: [], dts: [], export: [] };
  const page = (rows, number) => ({
    data: rows.slice((number - 1) * 20, number * 20),
    total: rows.length,
    page: number,
    pageSize: 20,
  });
  const transformers = Array.from({ length: 40 }, (_, i) => ({
    code: `DT-${i}`,
    name: `DT ${i}`,
    feederCode: `F-${i}`,
    capacityKva: 100,
  }));
  return {
    calls,
    async fetchMeterList({ q = '', page: number }) {
      calls.search.push(number);
      const rows = q
        ? ALL_METERS.filter((m) => m.meterId.includes(q) || m.serialNo.includes(q))
        : ALL_METERS;
      return page(rows, number);
    },
    async fetchTransformers({ page: number }) {
      calls.dts.push(number);
      return page(transformers, number);
    },
    async fetchGeo() {
      return geo;
    },
    async fetchEnergy() {
      return energy;
    },
    async fetchExport({ page: number }) {
      calls.export.push(number);
      return { ...exportBody, total: 3 };
    },
    async close() {},
    ...overrides,
  };
}

async function setup(overrides, serviceOptions = {}) {
  const portalClient = await createFakePortal(overrides);
  const logger = createRecordingLogger();
  return {
    portalClient,
    logger,
    service: createMeterService({ portalClient, logger, now: () => NOW, ...serviceOptions }),
  };
}

describe('listMeters paging', () => {
  test('maps limit/offset onto 20-row upstream pages and slices exactly', async () => {
    const { service, portalClient } = await setup();
    const result = await service.listMeters({ limit: 10, offset: 15 });
    assert.deepEqual(
      result.data.map((m) => m.meterId),
      ALL_METERS.slice(15, 25).map((m) => m.meterId),
    );
    assert.deepEqual(portalClient.calls.search, [1, 2]);
    assert.equal(result.total, TOTAL);
    assert.equal(result.fetched_at, NOW.toISOString());
  });

  test('a window inside page 1 makes a single upstream call', async () => {
    const { service, portalClient } = await setup();
    const result = await service.listMeters({ limit: 5, offset: 0 });
    assert.equal(result.data.length, 5);
    assert.deepEqual(portalClient.calls.search, [1]);
  });

  test('a large limit is clamped to the real total and fetches each page once', async () => {
    const { service, portalClient } = await setup();
    const result = await service.listMeters({ limit: 200, offset: 0 });
    assert.equal(result.data.length, TOTAL);
    assert.deepEqual(portalClient.calls.search, [1, 2, 3]);
  });

  test('an offset past the end returns an empty page without requesting pages past the end', async () => {
    const { service, portalClient } = await setup();
    const result = await service.listMeters({ limit: 50, offset: 500 });
    assert.deepEqual(result.data, []);
    assert.equal(result.total, TOTAL);
    assert.deepEqual(portalClient.calls.search, [1]);
  });

  test('q is passed upstream', async () => {
    const { service } = await setup();
    const result = await service.listMeters({ q: 'J10004', limit: 50, offset: 0 });
    assert.equal(result.total, 5); // J100040..J100044
  });

  test('a changed upstream page size is an error, not silent garbage', async () => {
    const { service } = await setup({
      async fetchMeterList() {
        return { data: [], total: 0, page: 1, pageSize: 50 };
      },
    });
    await assert.rejects(service.listMeters({ limit: 5, offset: 0 }), PortalParseError);
  });
});

describe('listTransformers', () => {
  test('pages the same way', async () => {
    const { service, portalClient } = await setup();
    const result = await service.listTransformers({ limit: 5, offset: 18 });
    assert.deepEqual(
      result.data.map((t) => t.code),
      ['DT-18', 'DT-19', 'DT-20', 'DT-21', 'DT-22'],
    );
    assert.deepEqual(portalClient.calls.dts, [1, 2]);
    assert.equal(result.total, 40);
  });
});

describe('getMeter', () => {
  test('combines search row, geo and export enrichment', async () => {
    const { service } = await setup({
      async fetchMeterList() {
        const row = meterRow(0);
        return { data: [row], total: 1, page: 1, pageSize: 20 };
      },
    });
    const meter = await service.getMeter('J100000');
    assert.equal(meter.serialNo, 'SN0');
    assert.deepEqual(meter.geo, { latitude: 26.938961002479868, longitude: 75.83095696146852 });
    assert.equal(meter.installType, 'Whole Current');
    assert.equal(meter.build, 'legacy');
    assert.equal(meter.hierarchy.feeder.code, 'F-001');
    assert.equal(meter.fetched_at, NOW.toISOString());
  });

  test('a meter missing from the export gets null hierarchy', async () => {
    const { service } = await setup();
    const meter = await service.getMeter('J100010');
    assert.equal(meter.hierarchy, null);
    assert.equal(meter.installType, null);
    assert.equal(meter.build, null);
    assert.ok(meter.geo);
  });

  test('an unknown meter id is PortalNotFound', async () => {
    const { service } = await setup();
    await assert.rejects(service.getMeter('J999999'), PortalNotFound);
  });

  test('search is a partial match, so only an exact id counts', async () => {
    const { service } = await setup();
    await assert.rejects(service.getMeter('J10001'), PortalNotFound); // matches J100010..19 only
  });

  test('export outage degrades to null hierarchy and logs a warning', async () => {
    const { service, logger } = await setup({
      async fetchExport() {
        throw new PortalUnavailable('export down');
      },
    });
    const meter = await service.getMeter('J100000');
    assert.equal(meter.hierarchy, null);
    assert.ok(logger.lines.some((line) => line.level === 'warn'));
  });

  test('a PortalAuthError from the export is NOT swallowed', async () => {
    const { service } = await setup({
      async fetchExport() {
        throw new PortalAuthError('nope');
      },
    });
    await assert.rejects(service.getMeter('J100000'), PortalAuthError);
  });

  test('a bad export row is skipped and logged without failing the meter', async () => {
    const exportBody = await fixtureBody('export-page1');
    exportBody.data[1].hierarchy = null; // J100001 is malformed
    const { service, logger } = await setup({
      async fetchExport() {
        return { ...exportBody, total: 3 };
      },
    });
    const good = await service.getMeter('J100000');
    assert.equal(good.hierarchy.zone.code, 'Z-01');
    const bad = await service.getMeter('J100001');
    assert.equal(bad.hierarchy, null);
    const warning = logger.lines.find(
      (line) => line.args[1] === 'skipped malformed rows in portal export',
    );
    assert.equal(warning.args[0].skippedCount, 1);
    assert.equal(warning.args[0].samples[0].meterId, 'J100001');
  });

  test('export paging stops on a repeated page instead of looping', async () => {
    const exportBody = await fixtureBody('export-page1'); // total 403 but only 3 rows, forever
    const { service, portalClient, logger } = await setup({
      async fetchExport({ page }) {
        portalClient.calls.export.push(page);
        return exportBody;
      },
    });
    await service.getMeter('J100000');
    assert.deepEqual(portalClient.calls.export, [1, 2]);
    assert.ok(logger.lines.some((line) => line.args[1] === 'portal export may be incomplete'));
  });

  test('export paging is bounded', async () => {
    const exportBody = await fixtureBody('export-page1');
    let pageNumber = 0;
    const { service, portalClient } = await setup({
      async fetchExport({ page }) {
        portalClient.calls.export.push(page);
        pageNumber += 1;
        // Every page has fresh ids, so only the page cap can stop the loop.
        const data = exportBody.data.map((row) => ({
          ...row,
          meterId: `P${pageNumber}-${row.meterId}`,
        }));
        return { ...exportBody, data, total: 1_000_000 };
      },
    });
    await service.getMeter('J100000');
    assert.equal(portalClient.calls.export.length, 10);
  });
});

describe('consumption', () => {
  test('getConsumption returns parsed readings', async () => {
    const { service } = await setup();
    const result = await service.getConsumption('J100000');
    assert.equal(result.meterId, 'J100000');
    assert.equal(result.data.length, 337);
    assert.equal(result.data[0].timestamp, '2026-06-23T23:30:00+05:30');
  });

  test('getDailyConsumption returns 7 days and a skipped count', async () => {
    const { service, logger } = await setup();
    const result = await service.getDailyConsumption('J100000');
    assert.equal(result.data.length, 7);
    assert.equal(result.skippedDays, 0);
    assert.equal(logger.lines.length, 0);
  });

  test('a register reset is skipped, counted and logged', async () => {
    const energy = await fixtureBody('meter-energy');
    // Drop the 26 Jun end-of-day register far below the 25 Jun one.
    const row = energy.data.find((r) => r.timestamp === '26/06/2026 23:30');
    row.kwh = '1.00';
    row.kvah = '1.00';
    const { service, logger } = await setup({
      async fetchEnergy() {
        return energy;
      },
    });
    const result = await service.getDailyConsumption('J100000');
    assert.equal(result.skippedDays, 1);
    assert.deepEqual(result.skipped, [{ date: '2026-06-26', reason: 'register_decreased' }]);
    assert.ok(!result.data.some((d) => d.date === '2026-06-26'));
    assert.ok(logger.lines.some((line) => line.level === 'warn' && line.args[0].skippedDays === 1));
  });

  test('a malformed energy response is strict: PortalParseError', async () => {
    const { service } = await setup({
      async fetchEnergy() {
        return { data: [{ timestamp: 'nonsense', kwh: '1', kvah: '1', voltR: '1' }] };
      },
    });
    await assert.rejects(service.getConsumption('J100000'), PortalParseError);
  });
});

describe('checkPortal', () => {
  test('reachable', async () => {
    const { service } = await setup();
    assert.equal((await service.checkPortal()).portal, 'reachable');
  });

  test('portal errors become "degraded", not exceptions', async () => {
    const { service } = await setup({
      async fetchTransformers() {
        throw new PortalUnavailable('down');
      },
    });
    assert.deepEqual(await service.checkPortal(), {
      status: 'degraded',
      portal: 'unreachable',
      fetched_at: NOW.toISOString(),
    });
  });
});

describe('export index memo', () => {
  test('is reused within the TTL and re-pulled after it', async () => {
    let clock = NOW.getTime();
    const { service, portalClient } = await setup(undefined, { now: () => new Date(clock) });
    await service.getMeter('J100000');
    await service.getMeter('J100000');
    assert.deepEqual(portalClient.calls.export, [1]);

    clock += 59_999;
    await service.getMeter('J100000');
    assert.deepEqual(portalClient.calls.export, [1]);

    clock += 1; // exactly the TTL
    await service.getMeter('J100000');
    assert.deepEqual(portalClient.calls.export, [1, 1]);
  });

  test('concurrent callers share one pull', async () => {
    const { service, portalClient } = await setup();
    await Promise.all([1, 2, 3, 4].map(() => service.getMeter('J100000')));
    assert.deepEqual(portalClient.calls.export, [1]);
  });

  test('a failed pull is not cached', async () => {
    let failing = true;
    const exportBody = await fixtureBody('export-page1');
    const { service, portalClient } = await setup({
      async fetchExport({ page }) {
        portalClient.calls.export.push(page);
        if (failing) throw new PortalUnavailable('export down');
        return { ...exportBody, total: 3 };
      },
    });
    assert.equal((await service.getMeter('J100000')).hierarchy, null);
    failing = false;
    assert.ok((await service.getMeter('J100000')).hierarchy);
    assert.deepEqual(portalClient.calls.export, [1, 1]);
  });
});
