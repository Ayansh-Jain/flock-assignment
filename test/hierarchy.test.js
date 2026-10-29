import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildNetwork,
  collectMeters,
  findMetersMissingFromExport,
  getNode,
  NetworkNodeNotFound,
  pathToRoot,
} from '../src/hierarchy.js';

const LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];

/** A meter whose chain is Z-01 > C-01 > ... > DT-001 unless a level is overridden. */
function meter(meterId, overrides = {}, dtCode = 'DT-001') {
  const defaults = {
    zone: ['Z-01', 'Zone 1'],
    circle: ['C-01', 'Circle 1'],
    division: ['D-01', 'Division 1'],
    subdivision: ['SD-01', 'Subdivision 1'],
    substation: ['SS-01', 'Substation 1'],
    feeder: ['F-001', 'Feeder 1'],
    dt: ['DT-001', 'DT 1'],
  };
  const hierarchy = {};
  for (const level of LEVELS) {
    const override = overrides[level];
    if (override === null) {
      hierarchy[level] = null;
      continue;
    }
    const [code, name] = override ?? defaults[level];
    hierarchy[level] = { code, name };
  }
  return {
    meterId,
    serialNo: `S-${meterId}`,
    make: 'HPL',
    phaseType: 'single',
    installStatus: 'Installed',
    dtCode,
    hierarchy,
  };
}

const TRANSFORMERS = [{ code: 'DT-001', feederCode: 'F-001' }];
const build = (exportMeters, transformers = TRANSFORMERS) =>
  buildNetwork({ exportMeters, transformers });
const issueTypes = (issues) => issues.map((issue) => issue.type);

describe('buildNetwork on clean data', () => {
  test('builds the seven-level chain with meter counts and no issues', () => {
    const { tree, issues } = build([meter('J1'), meter('J2')]);
    assert.deepEqual(issues, []);
    assert.deepEqual(tree.roots, ['Z-01']);
    assert.equal(tree.nodes.size, 7);
    assert.equal(tree.nodes.get('Z-01').meterCount, 2);
    assert.equal(tree.nodes.get('DT-001').meterCount, 2);
    assert.deepEqual(
      pathToRoot(tree, tree.nodes.get('DT-001')).map((node) => node.level),
      LEVELS,
    );
    assert.deepEqual(
      collectMeters(tree, tree.nodes.get('Z-01')).map((m) => m.meterId),
      ['J1', 'J2'],
    );
  });

  test('normalises code case and whitespace, keeping the raw spelling as an alias', () => {
    const { tree, issues } = build([meter('J1'), meter('J2', { zone: [' z-01 ', 'Zone  1'] })]);
    assert.deepEqual(issues, []);
    assert.equal(tree.nodes.size, 7);
    assert.deepEqual(tree.nodes.get('Z-01').aliases, ['z-01']);
    assert.equal(tree.nodes.get('Z-01').meterCount, 2);
  });
});

describe('buildNetwork on messy data', () => {
  test('flags a meter whose dtCode disagrees with its hierarchy, and still places it', () => {
    const { tree, issues } = build([meter('J1', {}, 'DT-999')]);
    assert.deepEqual(issueTypes(issues), ['orphan_meter']);
    assert.equal(issues[0].meterId, 'J1');
    assert.equal(tree.nodes.get('DT-001').meters.length, 1);
  });

  test('flags a code under two parents and keeps the first placement', () => {
    const second = meter('J2', { feeder: ['F-002', 'Feeder 2'], dt: ['DT-001', 'DT 1'] });
    const { tree, issues } = build([meter('J1'), second]);
    assert.deepEqual(issueTypes(issues), ['conflicting_parent']);
    assert.equal(issues[0].code, 'DT-001');
    assert.equal(tree.nodes.get('DT-001').parentCode, 'F-001');
    assert.equal(tree.nodes.get('DT-001').meters.length, 2);
    assert.ok(tree.nodes.has('F-002'));
  });

  test('flags one code with two different names', () => {
    const { tree, issues } = build([meter('J1'), meter('J2', { feeder: ['F-001', 'Other name'] })]);
    assert.deepEqual(issueTypes(issues), ['duplicate_code_name']);
    assert.equal(tree.nodes.get('F-001').name, 'Feeder 1');
  });

  test('a code reused at another level (a would-be cycle) is reported, not followed', () => {
    const cyclic = meter('J2', { circle: ['Z-01', 'Zone 1 again'] });
    const { tree, issues } = build([meter('J1'), cyclic]);
    assert.deepEqual(issueTypes(issues), ['level_conflict', 'orphan_meter']);
    assert.equal(tree.unplaced.length, 1);
    assert.equal(tree.unplaced[0].meterId, 'J2');
    // Walking up from every node still terminates.
    for (const node of tree.nodes.values()) {
      assert.ok(pathToRoot(tree, node).length <= LEVELS.length);
    }
  });

  test('a missing level keeps the meter, placed at the deepest valid level', () => {
    const { tree, issues } = build([meter('J1'), meter('J2', { substation: null })], []);
    assert.equal(tree.unplaced.length, 0);
    assert.equal(tree.nodes.get('Z-01').meterCount, 2, 'both meters are counted in the zone');
    assert.equal(tree.nodes.get('SS-01').meterCount, 1, 'only the complete one reaches below');
    assert.equal(tree.nodes.get('SD-01').meters.length, 1, 'J2 sits at the subdivision');
    assert.deepEqual(
      collectMeters(tree, tree.nodes.get('Z-01')).map((m) => m.meterId),
      ['J1', 'J2'],
    );
    const incomplete = issues.filter((issue) => issue.type === 'incomplete_hierarchy');
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].meterId, 'J2');
    assert.equal(incomplete[0].code, 'SD-01');
    assert.match(incomplete[0].detail, /substation/);
    assert.ok(!issues.some((issue) => issue.type === 'meter_not_in_export'));
  });

  test('a blank code is treated like a missing level', () => {
    const { tree, issues } = build([meter('J1', { circle: ['  ', 'x'] })], []);
    assert.equal(tree.nodes.get('Z-01').meters.length, 1);
    assert.deepEqual(issueTypes(issues), ['incomplete_hierarchy']);
  });

  test('levels below a missing one are not attached to a wrong parent', () => {
    const { tree } = build([meter('J1', { circle: null })], []);
    assert.deepEqual([...tree.nodes.keys()], ['Z-01'], 'nothing below the gap is created');
  });

  test('a missing zone leaves the meter unplaced but listed', () => {
    const { tree, issues } = build([meter('J1', { zone: null })], []);
    assert.equal(tree.unplaced.length, 1);
    assert.deepEqual(issueTypes(issues), ['incomplete_hierarchy']);
    assert.equal(issues[0].code, null);
  });

  test('cross-checks /portal/dts in both directions', () => {
    const { issues } = build(
      [meter('J1')],
      [
        { code: 'DT-001', feederCode: 'F-777' },
        { code: 'DT-050', feederCode: 'F-050' },
      ],
    );
    assert.deepEqual(issueTypes(issues).sort(), ['feeder_mismatch', 'transformer_without_meters']);
    const noTransformers = build([meter('J1')], []);
    assert.deepEqual(issueTypes(noTransformers.issues), ['dt_not_in_transformers']);
  });

  test('every input meter ends up in the tree or in unplaced', () => {
    const inputs = [
      meter('J1'),
      meter('J2', {}, 'DT-999'),
      meter('J3', { circle: ['Z-01', 'x'] }),
      meter('J4', { feeder: ['F-002', 'Feeder 2'] }),
    ];
    const { tree } = build(inputs);
    const placed = collectMeters(tree, tree.nodes.get('Z-01')).length;
    assert.equal(placed + tree.unplaced.length, inputs.length);
  });
});

describe('findMetersMissingFromExport', () => {
  test('reports search-only meters', () => {
    const issues = findMetersMissingFromExport({
      exportMeters: [meter('J1')],
      searchMeterIds: ['J1', 'J2'],
    });
    assert.deepEqual(issues, [
      {
        type: 'meter_not_in_export',
        code: null,
        meterId: 'J2',
        detail: issues[0].detail,
      },
    ]);
  });
});

describe('lookups', () => {
  test('getNode is case-insensitive and throws NetworkNodeNotFound for unknown codes', () => {
    const { tree } = build([meter('J1')]);
    assert.equal(getNode(tree, ' dt-001 ').code, 'DT-001');
    assert.throws(() => getNode(tree, 'NOPE'), NetworkNodeNotFound);
  });
});
