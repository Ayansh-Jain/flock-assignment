import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PortalParseError } from '../src/portal/errors.js';
import {
  deriveDailyConsumption,
  parseEnergy,
  parseExport,
  parseGeo,
  parseMeterList,
  parseTransformers,
} from '../src/portal/parsers.js';
import { fixtureBody } from './helpers.js';

const reading = (timestamp, kwh) => ({
  timestamp,
  kwh: String(kwh),
  kvah: String(kwh),
  voltR: '230',
});

describe('parseMeterList', () => {
  test('parses the search fixture', async () => {
    const result = parseMeterList(await fixtureBody('meters-search-page1'));
    assert.equal(result.total, 403);
    assert.equal(result.pageSize, 20);
    assert.equal(result.meters.length, 20);
    assert.deepEqual(result.meters[1], {
      meterId: 'J100001',
      serialNo: 'GE84132',
      make: 'L&T',
      phaseType: 'single',
      installStatus: 'Installed',
      dtCode: 'DT-002',
    });
  });

  test('keeps "&" in serials and trims whitespace', () => {
    const body = {
      data: [
        {
          meterId: ' J1 ',
          serialNo: 'L&84997',
          make: 'L&T',
          phaseType: 'single',
          installStatus: 'Installed',
          dtCode: 'DT-1',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const [meter] = parseMeterList(body).meters;
    assert.equal(meter.meterId, 'J1');
    assert.equal(meter.serialNo, 'L&84997');
  });

  test('rejects a wrong shape with PortalParseError', () => {
    assert.throws(() => parseMeterList({ data: 'nope' }), PortalParseError);
    assert.throws(() => parseMeterList(null), PortalParseError);
    assert.throws(
      () => parseMeterList({ data: [{ meterId: '' }], total: 1, page: 1, pageSize: 20 }),
      PortalParseError,
    );
  });
});

describe('parseGeo', () => {
  test('converts string coordinates to numbers', async () => {
    const geo = parseGeo(await fixtureBody('meter-geo'));
    assert.equal(typeof geo.latitude, 'number');
    assert.equal(geo.latitude, 26.938961002479868);
    assert.equal(geo.longitude, 75.83095696146852);
  });

  test('rejects NaN, blank and out-of-range values', () => {
    assert.throws(() => parseGeo({ data: { latitude: 'abc', longitude: '75' } }), PortalParseError);
    assert.throws(() => parseGeo({ data: { latitude: '', longitude: '75' } }), PortalParseError);
    assert.throws(() => parseGeo({ data: { latitude: '91', longitude: '75' } }), PortalParseError);
  });
});

describe('parseEnergy', () => {
  test('parses the fixture: numbers, IST ISO timestamps, 23:30 first reading', async () => {
    const readings = parseEnergy(await fixtureBody('meter-energy'));
    assert.equal(readings.length, 337);
    assert.deepEqual(readings[0], {
      timestamp: '2026-06-23T23:30:00+05:30',
      kwh: 48438.74,
      kvah: 52313.84,
      voltR: 226,
    });
    assert.equal(readings.at(-1).timestamp, '2026-06-30T23:30:00+05:30');
    assert.ok(readings.every((r) => typeof r.kwh === 'number' && typeof r.voltR === 'number'));
  });

  test('sorts out-of-order input chronologically', () => {
    const readings = parseEnergy({
      data: [reading('02/01/2026 00:00', 2), reading('01/01/2026 23:30', 1)],
    });
    assert.deepEqual(
      readings.map((r) => r.kwh),
      [1, 2],
    );
  });

  test('rejects bad numbers and impossible timestamps', () => {
    for (const [timestamp, kwh] of [
      ['01/01/2026 00:00', ''],
      ['01/01/2026 00:00', 'x1'],
      ['31/02/2026 00:00', 1],
      ['2026-01-01 00:00', 1],
      ['01/01/2026 10:75', 1],
    ]) {
      assert.throws(() => parseEnergy({ data: [reading(timestamp, kwh)] }), PortalParseError);
    }
  });
});

describe('deriveDailyConsumption', () => {
  test('fixture: 7 complete days (24-30 Jun), nothing anomalous skipped', async () => {
    const readings = parseEnergy(await fixtureBody('meter-energy'));
    const { days, skipped } = deriveDailyConsumption(readings);
    assert.deepEqual(
      days.map((d) => d.date),
      [
        '2026-06-24',
        '2026-06-25',
        '2026-06-26',
        '2026-06-27',
        '2026-06-28',
        '2026-06-29',
        '2026-06-30',
      ],
    );
    assert.deepEqual(skipped, []); // the 23/06 anchor day is an expected edge, not an anomaly
    const at = (ts) => readings.find((r) => r.timestamp === ts).kwh;
    const expected =
      Math.round((at('2026-06-30T23:30:00+05:30') - at('2026-06-29T23:30:00+05:30')) * 100) / 100;
    assert.equal(days.at(-1).kwh, expected);
  });

  test('first (anchor) day and an incomplete final day are skipped silently', () => {
    const readings = parseEnergy({
      data: [
        reading('01/01/2026 12:00', 100), // first day does not end at 23:30: never reported
        reading('01/01/2026 23:30', 110),
        reading('02/01/2026 00:00', 111),
        reading('02/01/2026 23:30', 120),
        reading('03/01/2026 00:00', 121), // third day ends early (incomplete)
        reading('03/01/2026 10:00', 125),
      ],
    });
    assert.deepEqual(deriveDailyConsumption(readings), {
      days: [{ date: '2026-01-02', kwh: 10, kvah: 10 }],
      skipped: [],
    });
  });

  test('reports a day whose previous day is missing', () => {
    const readings = parseEnergy({
      data: [reading('01/01/2026 23:30', 10), reading('03/01/2026 23:30', 30)],
    });
    assert.deepEqual(deriveDailyConsumption(readings), {
      days: [],
      skipped: [{ date: '2026-01-03', reason: 'missing_previous_day' }],
    });
  });

  test('reports an incomplete interior day', () => {
    const readings = parseEnergy({
      data: [
        reading('01/01/2026 23:30', 10),
        reading('02/01/2026 12:00', 15), // interior day stops early
        reading('03/01/2026 23:30', 30),
      ],
    });
    const { days, skipped } = deriveDailyConsumption(readings);
    assert.deepEqual(days, []);
    assert.deepEqual(skipped, [
      { date: '2026-01-02', reason: 'incomplete_day' },
      { date: '2026-01-03', reason: 'missing_previous_day' },
    ]);
  });

  test('skips and reports a day where the register went backwards', () => {
    const readings = parseEnergy({
      data: [
        reading('01/01/2026 23:30', 500),
        reading('02/01/2026 23:30', 5), // reset / meter swap
        reading('03/01/2026 23:30', 12),
      ],
    });
    assert.deepEqual(deriveDailyConsumption(readings), {
      days: [{ date: '2026-01-03', kwh: 7, kvah: 7 }],
      skipped: [{ date: '2026-01-02', reason: 'register_decreased' }],
    });
  });

  test('rounds away float noise', () => {
    const readings = parseEnergy({
      data: [reading('01/01/2026 23:30', 0.1), reading('02/01/2026 23:30', 0.3)],
    });
    assert.equal(deriveDailyConsumption(readings).days[0].kwh, 0.2);
  });
});

describe('parseTransformers', () => {
  test('parses the fixture and keeps capacityKva numeric', async () => {
    const result = parseTransformers(await fixtureBody('dts-page1'));
    assert.equal(result.total, 40);
    assert.equal(result.transformers.length, 20);
    assert.deepEqual(result.transformers[0], {
      code: 'DT-001',
      name: 'Malviya Nagar DT 1',
      feederCode: 'F-001',
      capacityKva: 100,
    });
  });

  test('rejects a non-numeric capacity', () => {
    const body = {
      data: [{ code: 'DT-1', name: 'x', feederCode: 'F-1', capacityKva: 'big' }],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    assert.throws(() => parseTransformers(body), PortalParseError);
  });
});

describe('parseExport', () => {
  test('parses rich rows with a 7-level hierarchy and normalised geo', async () => {
    const result = parseExport(await fixtureBody('export-page1'));
    assert.equal(result.total, 403);
    assert.equal(result.meters.length, 3);
    const [first] = result.meters;
    assert.equal(first.installType, 'Whole Current');
    assert.equal(first.build, 'legacy');
    assert.deepEqual(Object.keys(first.hierarchy), [
      'zone',
      'circle',
      'division',
      'subdivision',
      'substation',
      'feeder',
      'dt',
    ]);
    assert.deepEqual(first.hierarchy.feeder, { name: 'Feeder 1', code: 'F-001' });
    assert.deepEqual(first.geo, { latitude: 26.938961002479868, longitude: 75.83095696146852 });
  });

  test('has no skipped rows for the clean fixture', async () => {
    const { skipped } = parseExport(await fixtureBody('export-page1'));
    assert.deepEqual(skipped, { count: 0, samples: [] });
  });

  test('skips a bad row, keeps the rest, and reports it', async () => {
    const body = await fixtureBody('export-page1');
    delete body.data[0].hierarchy.substation;
    const { meters, total, skipped } = parseExport(body);
    assert.equal(total, 403);
    assert.deepEqual(
      meters.map((m) => m.meterId),
      ['J100001', 'J100002'],
    );
    assert.equal(skipped.count, 1);
    assert.equal(skipped.samples[0].index, 0);
    assert.equal(skipped.samples[0].meterId, 'J100000');
    assert.match(skipped.samples[0].reason, /^\/portal\/export: .*hierarchy\.substation/);
  });

  test('counts every skipped row but keeps only a small sample', async () => {
    const body = await fixtureBody('export-page1');
    const good = body.data[0];
    body.data = Array.from({ length: 8 }, (_, i) => ({ ...good, meterId: `BAD${i}`, geo: null }));
    const { meters, skipped } = parseExport(body);
    assert.equal(meters.length, 0);
    assert.equal(skipped.count, 8);
    assert.equal(skipped.samples.length, 5);
  });

  test('a non-object row is skipped with a null meterId', () => {
    const { skipped } = parseExport({ data: [null, 'junk'], total: 2 });
    assert.equal(skipped.count, 2);
    assert.equal(skipped.samples[0].meterId, null);
  });

  test('skip reasons carry the path and field but not the raw value', () => {
    const { skipped } = parseExport({
      data: [{ meterId: 'M1', geo: { lat: 'SECRET-LOOKING-VALUE', lng: 1 } }],
      total: 1,
    });
    assert.equal(skipped.count, 1);
    assert.ok(!skipped.samples[0].reason.includes('SECRET-LOOKING-VALUE'));
  });

  test('a malformed envelope still throws', () => {
    assert.throws(() => parseExport({ data: 'nope', total: 1 }), PortalParseError);
    assert.throws(() => parseExport({ data: [] }), PortalParseError);
    assert.throws(() => parseExport(null), PortalParseError);
  });
});
