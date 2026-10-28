// The network hierarchy as a tree, built from the portal export. Pure: no I/O, no clock.
//
// Every export row states a full zone > circle > ... > dt chain, so the tree is the union of
// those chains. Nodes are keyed by normalised code alone (the API addresses a node by code), which
// means a code can only live at one level and under one parent. Rows that disagree are never
// dropped: the first-seen placement wins and the disagreement is reported as an issue.

import { HIERARCHY_LEVELS } from './portal/parsers.js';

const MAX_PATH_DEPTH = HIERARCHY_LEVELS.length;

/** Thrown by lookups for a node code that is not in the tree. */
export class NetworkNodeNotFound extends Error {
  /** @param {string} nodeCode */
  constructor(nodeCode) {
    super(`No network node with code ${nodeCode}`);
    this.name = 'NetworkNodeNotFound';
    this.code = 'NETWORK_NODE_NOT_FOUND';
    this.nodeCode = nodeCode;
  }
}

/** Codes are compared trimmed and upper-cased; the raw spelling is kept as an alias. */
export function normaliseCode(code) {
  return String(code).trim().toUpperCase();
}

function normaliseName(name) {
  return String(name).trim().replace(/\s+/g, ' ');
}

/**
 * @typedef {object} NetworkNode
 * @property {string} code Normalised code.
 * @property {string} name First-seen name, whitespace-trimmed.
 * @property {string} level One of HIERARCHY_LEVELS.
 * @property {string | null} parentCode
 * @property {string[]} aliases Raw spellings of the code that differ from `code`.
 * @property {string[]} childCodes
 * @property {number} meterCount Meters placed at or below this node.
 * @property {object[]} meters Meter summaries; only filled on `dt` nodes.
 *
 * @typedef {{ type: string, code: string | null, meterId: string | null, detail: string }} NetworkIssue
 */

function summarise(meter) {
  const { meterId, serialNo, make, phaseType, installStatus, dtCode } = meter;
  return { meterId, serialNo, make, phaseType, installStatus, dtCode };
}

/**
 * Build the tree and collect every inconsistency found on the way.
 *
 * @param {object} input
 * @param {object[]} input.exportMeters Rows from parseExport (hierarchy, dtCode, meter fields).
 * @param {{ code: string, feederCode: string }[]} input.transformers Rows from parseTransformers.
 * @returns {{
 *   tree: { nodes: Map<string, NetworkNode>, roots: string[], unplaced: object[] },
 *   issues: NetworkIssue[]
 * }}
 */
export function buildNetwork({ exportMeters, transformers }) {
  /** @type {Map<string, NetworkNode>} */
  const nodes = new Map();
  const roots = [];
  const unplaced = [];
  const issues = [];
  const seenIssues = new Set();
  const nameKeys = new Map();

  const report = (type, { code = null, meterId = null, detail }) => {
    const key = [type, code, meterId, detail].join('|');
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push({ type, code, meterId, detail });
  };

  /** Place one chain level; returns the node, or null when this row cannot use the code here. */
  function placeLevel(level, rawCode, rawName, parent) {
    const code = normaliseCode(rawCode);
    const name = normaliseName(rawName);
    if (code === '') {
      report('orphan_meter', { detail: `blank ${level} code in the export` });
      return null;
    }
    let node = nodes.get(code);
    if (!node) {
      node = {
        code,
        name,
        level,
        parentCode: parent?.code ?? null,
        aliases: [],
        childCodes: [],
        meterCount: 0,
        meters: [],
      };
      nodes.set(code, node);
      nameKeys.set(code, name.toLowerCase());
      if (parent) parent.childCodes.push(code);
      else roots.push(code);
    } else if (node.level !== level) {
      report('level_conflict', {
        code,
        detail: `code is a ${node.level} in one row and a ${level} in another; the later use was ignored`,
      });
      return null;
    } else if (node.parentCode !== (parent?.code ?? null)) {
      report('conflicting_parent', {
        code,
        detail: `${level} sits under ${node.parentCode ?? 'no parent'} in one row and under ${parent?.code ?? 'no parent'} in another; kept the first`,
      });
    }
    if (nameKeys.get(code) !== name.toLowerCase()) {
      report('duplicate_code_name', {
        code,
        detail: `code is named "${node.name}" in one row and "${name}" in another; kept the first`,
      });
    }
    const rawTrimmed = String(rawCode).trim();
    if (rawTrimmed !== code && !node.aliases.includes(rawTrimmed)) node.aliases.push(rawTrimmed);
    return node;
  }

  for (const meter of exportMeters) {
    let parent = null;
    for (const level of HIERARCHY_LEVELS) {
      const { code, name } = meter.hierarchy[level];
      parent = placeLevel(level, code, name, parent);
      if (!parent) break;
    }
    if (!parent) {
      unplaced.push(summarise(meter));
      report('orphan_meter', {
        meterId: meter.meterId,
        detail: 'its hierarchy chain conflicts with the rest of the export, so it is in no node',
      });
      continue;
    }
    parent.meters.push(summarise(meter));
    // Walk up to count the meter at every ancestor; the depth bound is the cycle guard.
    const visited = new Set();
    for (let node = parent; node && !visited.has(node.code); node = nodes.get(node.parentCode)) {
      visited.add(node.code);
      node.meterCount += 1;
    }
    if (normaliseCode(meter.dtCode) !== parent.code) {
      report('orphan_meter', {
        meterId: meter.meterId,
        detail: `dtCode ${meter.dtCode} does not match the DT its hierarchy places it under (${parent.code}); placed by hierarchy`,
      });
    }
  }

  for (const node of nodes.values()) node.childCodes.sort();
  checkTransformers({ nodes, transformers, report });
  return { tree: { nodes, roots: roots.toSorted(), unplaced }, issues };
}

/** Cross-check the export tree against /portal/dts, in both directions. */
function checkTransformers({ nodes, transformers, report }) {
  const known = new Set();
  for (const transformer of transformers) {
    const code = normaliseCode(transformer.code);
    known.add(code);
    const node = nodes.get(code);
    if (!node || node.level !== 'dt') {
      report('transformer_without_meters', {
        code,
        detail: 'listed by /portal/dts but no export row places a meter under it',
      });
    } else if (nodes.get(node.parentCode)?.code !== normaliseCode(transformer.feederCode)) {
      report('feeder_mismatch', {
        code,
        detail: `/portal/dts says feeder ${transformer.feederCode}; the export puts it under ${node.parentCode}`,
      });
    }
  }
  for (const node of nodes.values()) {
    if (node.level === 'dt' && !known.has(node.code)) {
      report('dt_not_in_transformers', {
        code: node.code,
        detail: 'in the export hierarchy but not listed by /portal/dts',
      });
    }
  }
}

/**
 * Meters the portal search lists that the export does not: their hierarchy is unknown.
 *
 * @param {object} input
 * @param {object[]} input.exportMeters
 * @param {string[]} input.searchMeterIds
 * @returns {NetworkIssue[]}
 */
export function findMetersMissingFromExport({ exportMeters, searchMeterIds }) {
  const inExport = new Set(exportMeters.map((meter) => meter.meterId));
  return searchMeterIds
    .filter((meterId) => !inExport.has(meterId))
    .map((meterId) => ({
      type: 'meter_not_in_export',
      code: null,
      meterId,
      detail: 'listed by portal search but absent from the export, so it has no place in the tree',
    }));
}

/**
 * @param {{ nodes: Map<string, NetworkNode> }} tree
 * @param {string} nodeCode Any spelling; normalised here.
 * @returns {NetworkNode}
 * @throws {NetworkNodeNotFound}
 */
export function getNode(tree, nodeCode) {
  const node = tree.nodes.get(normaliseCode(nodeCode));
  if (!node) throw new NetworkNodeNotFound(nodeCode);
  return node;
}

/** The node and its ancestors, root first. Bounded by the number of levels. */
export function pathToRoot(tree, node) {
  const path = [];
  const visited = new Set();
  for (
    let current = node;
    current && !visited.has(current.code) && path.length < MAX_PATH_DEPTH;
    current = tree.nodes.get(current.parentCode)
  ) {
    visited.add(current.code);
    path.unshift(current);
  }
  return path;
}

/** Meters at or below a node, ordered by meterId so offset paging is stable. */
export function collectMeters(tree, node) {
  const meters = [];
  const visited = new Set();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current.code)) continue;
    visited.add(current.code);
    meters.push(...current.meters);
    for (const childCode of current.childCodes) stack.push(tree.nodes.get(childCode));
  }
  return meters.toSorted((a, b) => a.meterId.localeCompare(b.meterId));
}

/** The API view of a node: counts instead of member lists. */
export function toNodeView(node) {
  const { code, name, level, parentCode, aliases, childCodes, meterCount } = node;
  return { code, name, level, parentCode, aliases, childCount: childCodes.length, meterCount };
}
