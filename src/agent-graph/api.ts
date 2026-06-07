/**
 * Agent Call Graph — API layer.
 *
 * Thin, server-agnostic functions that the DashClaw HTTP server (or tests, or a
 * CLI) can call to get graph + blast-radius data. Keeping these decoupled from
 * `http` makes them trivially unit-testable and reusable across surfaces.
 */
import { extractAgentGraph, type AgentGraph, type GraphNode } from './extractor.js';
import {
  computeBlastRadius,
  type BlastDirection,
  type BlastRadiusResult,
} from './blast-radius.js';
import { logger } from '../logger.js';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  agentCount: number;
  destinationCount: number;
  totalMessages: number;
  totalDelegations: number;
  busiestAgents: Array<{ id: string; label: string; outCount: number }>;
  topDestinations: Array<{ id: string; label: string; inCount: number }>;
}

export interface GraphResponse {
  graph: AgentGraph;
  stats: GraphStats;
}

function computeStats(graph: AgentGraph): GraphStats {
  const agents = graph.nodes.filter((n) => n.kind === 'agent' || n.kind === 'team' || n.kind === 'root');
  const destinations = graph.nodes.filter((n) => n.kind === 'destination');

  const totalMessages = graph.edges
    .filter((e) => e.kind === 'message')
    .reduce((sum, e) => sum + e.count, 0);
  const totalDelegations = graph.edges
    .filter((e) => e.kind === 'delegation' || e.kind === 'team')
    .reduce((sum, e) => sum + e.count, 0);

  const byOut = (a: GraphNode, b: GraphNode) => b.outCount - a.outCount;
  const byIn = (a: GraphNode, b: GraphNode) => b.inCount - a.inCount;

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    agentCount: agents.length,
    destinationCount: destinations.length,
    totalMessages,
    totalDelegations,
    busiestAgents: [...agents]
      .sort(byOut)
      .slice(0, 5)
      .map((n) => ({ id: n.id, label: n.label, outCount: n.outCount })),
    topDestinations: [...destinations]
      .sort(byIn)
      .slice(0, 5)
      .map((n) => ({ id: n.id, label: n.label, inCount: n.inCount })),
  };
}

/** Build the agent call graph + summary stats for a time window. */
export function getAgentGraphData(opts: { window?: string } = {}): ApiResult<GraphResponse> {
  try {
    const graph = extractAgentGraph(opts.window);
    return { ok: true, data: { graph, stats: computeStats(graph) } };
  } catch (err) {
    logger.error({ err }, 'agent-graph: failed to build graph');
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export interface BlastResponse {
  graph: AgentGraph;
  stats: GraphStats;
  blastRadius: BlastRadiusResult;
}

/** Build the graph and compute a blast radius rooted at `node`. */
export function getBlastRadiusData(opts: {
  window?: string;
  node: string;
  hops?: number;
  direction?: BlastDirection;
}): ApiResult<BlastResponse> {
  try {
    if (!opts.node) return { ok: false, error: 'Missing required "node" parameter' };
    const graph = extractAgentGraph(opts.window);
    if (!graph.nodes.some((n) => n.id === opts.node)) {
      return { ok: false, error: `Unknown node: ${opts.node}` };
    }
    const blastRadius = computeBlastRadius(graph, opts.node, {
      maxHops: opts.hops,
      direction: opts.direction,
    });
    return { ok: true, data: { graph, stats: computeStats(graph), blastRadius } };
  } catch (err) {
    logger.error({ err, node: opts.node }, 'agent-graph: failed to compute blast radius');
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}
