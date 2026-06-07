/**
 * Agent Call Graph — blast-radius analyzer.
 *
 * "If agent X fails, who is affected?" — answered by multi-hop traversal of the
 * directed agent graph. This is the accountability counterpart to Netflix's
 * dependency blast-radius view: pick a node, walk the delegation/message edges,
 * and surface every downstream (or upstream) agent reachable within N hops.
 *
 *   downstream — nodes X talks to / spawned / leads (who X's failure impacts).
 *   upstream   — nodes that talk to / spawned / lead X (who depends on X).
 *   both       — union of the two.
 */
import type { AgentGraph, GraphEdge } from './extractor.js';

export type BlastDirection = 'downstream' | 'upstream' | 'both';

export interface BlastRadiusResult {
  root: string;
  rootLabel: string;
  direction: BlastDirection;
  maxHops: number;
  /** Reachable node ids grouped by hop distance from the root (excludes root). */
  levels: Array<{ hop: number; nodes: string[] }>;
  /** All affected node ids (excludes root), nearest-first. */
  affectedNodes: string[];
  /** Edges traversed while computing the radius. */
  affectedEdges: GraphEdge[];
  /** Representative delegation/message chains starting at the root. */
  chains: string[][];
  totalReach: number;
  summary: string;
}

interface Adjacency {
  /** node id → outgoing edges (downstream). */
  out: Map<string, GraphEdge[]>;
  /** node id → incoming edges (upstream). */
  in: Map<string, GraphEdge[]>;
}

function buildAdjacency(graph: AgentGraph): Adjacency {
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e);
    if (!inn.has(e.target)) inn.set(e.target, []);
    inn.get(e.target)!.push(e);
  }
  return { out, in: inn };
}

/** Neighbours of `node` in the requested direction, paired with the edge used. */
function neighbours(
  adj: Adjacency,
  node: string,
  direction: BlastDirection,
): Array<{ next: string; edge: GraphEdge }> {
  const result: Array<{ next: string; edge: GraphEdge }> = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const e of adj.out.get(node) || []) result.push({ next: e.target, edge: e });
  }
  if (direction === 'upstream' || direction === 'both') {
    for (const e of adj.in.get(node) || []) result.push({ next: e.source, edge: e });
  }
  return result;
}

const DEFAULT_MAX_HOPS = 4;
const MAX_CHAINS = 12;
const MAX_CHAIN_DEPTH = 6;

/**
 * Compute the blast radius for `rootId` over `graph`.
 * Returns hop-levelled reachable nodes, traversed edges, and sample chains.
 */
export function computeBlastRadius(
  graph: AgentGraph,
  rootId: string,
  opts: { maxHops?: number; direction?: BlastDirection } = {},
): BlastRadiusResult {
  const direction = opts.direction ?? 'downstream';
  const maxHops = Math.max(1, Math.min(opts.maxHops ?? DEFAULT_MAX_HOPS, 12));
  const adj = buildAdjacency(graph);

  const rootLabel = graph.nodes.find((n) => n.id === rootId)?.label ?? rootId;

  // BFS, recording the hop at which each node is first reached.
  const hopOf = new Map<string, number>([[rootId, 0]]);
  const affectedEdges = new Map<string, GraphEdge>();
  let frontier = [rootId];

  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const { next, edge } of neighbours(adj, node, direction)) {
        affectedEdges.set(edge.id, edge);
        if (!hopOf.has(next)) {
          hopOf.set(next, hop);
          nextFrontier.push(next);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Group affected nodes (excluding the root) by hop distance.
  const levelsMap = new Map<number, string[]>();
  for (const [node, hop] of hopOf) {
    if (hop === 0) continue;
    if (!levelsMap.has(hop)) levelsMap.set(hop, []);
    levelsMap.get(hop)!.push(node);
  }
  const levels = [...levelsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hop, nodes]) => ({ hop, nodes }));

  const affectedNodes = levels.flatMap((l) => l.nodes);

  return {
    root: rootId,
    rootLabel,
    direction,
    maxHops,
    levels,
    affectedNodes,
    affectedEdges: [...affectedEdges.values()],
    chains: buildChains(adj, rootId, direction, maxHops),
    totalReach: affectedNodes.length,
    summary: buildSummary(rootLabel, direction, affectedNodes.length, levels.length),
  };
}

/** Depth-first enumeration of representative paths out of the root. */
function buildChains(
  adj: Adjacency,
  rootId: string,
  direction: BlastDirection,
  maxHops: number,
): string[][] {
  const chains: string[][] = [];
  const depthCap = Math.min(maxHops, MAX_CHAIN_DEPTH);

  const walk = (node: string, path: string[], visited: Set<string>): void => {
    if (chains.length >= MAX_CHAINS) return;
    const nexts = neighbours(adj, node, direction).filter((n) => !visited.has(n.next));
    if (path.length - 1 >= depthCap || nexts.length === 0) {
      if (path.length > 1) chains.push([...path]);
      return;
    }
    for (const { next } of nexts) {
      if (chains.length >= MAX_CHAINS) return;
      visited.add(next);
      walk(next, [...path, next], visited);
      visited.delete(next);
    }
  };

  walk(rootId, [rootId], new Set([rootId]));
  return chains;
}

function buildSummary(
  rootLabel: string,
  direction: BlastDirection,
  reach: number,
  depth: number,
): string {
  if (reach === 0) {
    return direction === 'upstream'
      ? `No agents depend on ${rootLabel} in this window.`
      : `${rootLabel} has no downstream impact in this window.`;
  }
  const verb = direction === 'upstream' ? 'depend on' : 'are affected if';
  const subject = direction === 'upstream' ? rootLabel : `${rootLabel} fails`;
  return `${reach} node${reach === 1 ? '' : 's'} across ${depth} hop${depth === 1 ? '' : 's'} ${verb} ${subject}.`;
}
