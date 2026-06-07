/**
 * Agent Call Graph — multi-source data extractor.
 *
 * Inspired by Netflix's service-topology pipeline: rather than instrumenting a
 * single source, we fan out across every system that records agent activity and
 * fold them into one directed graph of "who talked to / spawned / led whom".
 *
 * Three stages (Extract → Merge → Analyze):
 *   1. Extract  — pull raw rows from each source independently.
 *   2. Merge    — resolve identities, dedupe edges, accumulate counts + samples.
 *   3. Analyze  — compute per-node degree, instance counts, first/last seen.
 *
 * Sources:
 *   - evidence_chain   (message_sent / agent_spawned) — store/messages.db
 *   - agent_identities (issuer → agent delegation)    — store/messages.db
 *   - teams/team_members (lead → specialist)          — store/nanoclaw.db
 *
 * The teams tables live in a separate DB (the orchestrator's), so we open it
 * read-only on demand and degrade gracefully if it (or its tables) is absent.
 */
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../config.js';
import { getDb, getChatName } from '../db.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeKind = 'agent' | 'destination' | 'root' | 'team';
export type EdgeKind = 'message' | 'delegation' | 'team';

export interface GraphNode {
  /** Stable key: agent_name, destination JID, 'nanoclaw-root', or team agent id. */
  id: string;
  label: string;
  kind: NodeKind;
  /** agent_type from agent_identities, when known. */
  agentType?: string;
  /** Team role (lead/researcher/...) for team-sourced nodes. */
  teamRole?: string;
  /** Distinct agent_id instances sharing this logical agent_name. */
  instanceCount: number;
  /** Sum of outbound edge weights (messages sent / agents spawned / tasks led). */
  outCount: number;
  /** Sum of inbound edge weights. */
  inCount: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Number of underlying events (messages, spawns, assignments). */
  count: number;
  /** First 3 representative intents / content previews for this edge. */
  sampleIntents: string[];
  lastTimestamp?: string;
}

export interface AgentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    window: string;
    since: string | null;
    generatedAt: string;
    sources: { evidence: number; identities: number; teamEdges: number };
    counts: { nodes: number; edges: number };
  };
}

export interface TimeWindow {
  window: string;
  sinceIso: string | null;
  sinceEpoch: number | null;
}

// ---------------------------------------------------------------------------
// Time-window helpers
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Normalize a window string ('24h' | '7d' | '30d' | 'all') into cutoffs. */
export function resolveWindow(window?: string): TimeWindow {
  const w = (window || '7d').toLowerCase();
  if (w === 'all') return { window: 'all', sinceIso: null, sinceEpoch: null };
  const ms = WINDOW_MS[w] ?? WINDOW_MS['7d'];
  const epoch = Date.now() - ms;
  return {
    window: WINDOW_MS[w] ? w : '7d',
    sinceIso: new Date(epoch).toISOString(),
    sinceEpoch: epoch,
  };
}

// ---------------------------------------------------------------------------
// Stage 1: Extract (raw, per-source)
// ---------------------------------------------------------------------------

interface RawEdge {
  source: string;        // logical key (agent_name / issuer / lead id)
  target: string;        // logical key (jid / spawned id / member id)
  kind: EdgeKind;
  intent: string;        // representative description of this single event
  timestamp: string;     // ISO
  /** Optional node hints discovered while extracting. */
  sourceNode?: Partial<GraphNode>;
  targetNode?: Partial<GraphNode>;
}

interface EvidenceRow {
  agent_name: string;
  action_type: string;
  action_details: string;
  intent: string;
  timestamp: string;
}

/** Pull message_sent / agent_spawned events from the evidence chain. */
function extractEvidence(since: string | null): RawEdge[] {
  const db = getDb();
  const rows = (
    since
      ? db.prepare(
          `SELECT agent_name, action_type, action_details, intent, timestamp
           FROM evidence_chain
           WHERE timestamp >= ? AND action_type IN ('message_sent', 'agent_spawned')
           ORDER BY timestamp ASC`,
        ).all(since)
      : db.prepare(
          `SELECT agent_name, action_type, action_details, intent, timestamp
           FROM evidence_chain
           WHERE action_type IN ('message_sent', 'agent_spawned')
           ORDER BY timestamp ASC`,
        ).all()
  ) as EvidenceRow[];

  const edges: RawEdge[] = [];
  for (const row of rows) {
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(row.action_details) as Record<string, unknown>;
    } catch {
      /* malformed details — fall back to empty */
    }

    if (row.action_type === 'message_sent') {
      const target = String(details.target ?? 'unknown');
      const preview = typeof details.content_preview === 'string'
        ? details.content_preview
        : '';
      edges.push({
        source: row.agent_name,
        target,
        kind: 'message',
        intent: preview || row.intent,
        timestamp: row.timestamp,
        sourceNode: { kind: 'agent' },
        targetNode: { kind: 'destination' },
      });
    } else if (row.action_type === 'agent_spawned') {
      const spawnedName = typeof details.spawned_name === 'string'
        ? details.spawned_name
        : String(details.spawned_agent_id ?? 'unknown');
      edges.push({
        source: row.agent_name,
        target: spawnedName,
        kind: 'delegation',
        intent: row.intent,
        timestamp: row.timestamp,
        sourceNode: { kind: 'agent' },
        targetNode: { kind: 'agent' },
      });
    }
  }
  return edges;
}

interface IdentityRow {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  issuer: string;
  issued_at: string;
}

interface IdentityExtract {
  edges: RawEdge[];
  /** agent_id → agent_name, for resolving spawn/team targets. */
  idToName: Map<string, string>;
  /** agent_name → agent_type. */
  nameToType: Map<string, string>;
  /** agent_name → distinct instance count. */
  instances: Map<string, number>;
  rowCount: number;
}

/** Pull agent identities → issuer delegation edges + identity resolution maps. */
function extractIdentities(since: string | null): IdentityExtract {
  const db = getDb();
  const rows = (
    since
      ? db.prepare(
          `SELECT agent_id, agent_name, agent_type, issuer, issued_at
           FROM agent_identities WHERE issued_at >= ? ORDER BY issued_at ASC`,
        ).all(since)
      : db.prepare(
          `SELECT agent_id, agent_name, agent_type, issuer, issued_at
           FROM agent_identities ORDER BY issued_at ASC`,
        ).all()
  ) as IdentityRow[];

  const edges: RawEdge[] = [];
  const idToName = new Map<string, string>();
  const nameToType = new Map<string, string>();
  const instanceIds = new Map<string, Set<string>>();

  for (const row of rows) {
    idToName.set(row.agent_id, row.agent_name);
    nameToType.set(row.agent_name, row.agent_type);
    if (!instanceIds.has(row.agent_name)) instanceIds.set(row.agent_name, new Set());
    instanceIds.get(row.agent_name)!.add(row.agent_id);

    const issuer = row.issuer || 'nanoclaw-root';
    // Skip self-issued / unknown links that would create noise.
    if (issuer === row.agent_name) continue;
    edges.push({
      source: issuer,
      target: row.agent_name,
      kind: 'delegation',
      intent: `Issued identity for ${row.agent_name} (${row.agent_type})`,
      timestamp: row.issued_at,
      sourceNode: { kind: issuer === 'nanoclaw-root' ? 'root' : 'agent' },
      targetNode: { kind: 'agent', agentType: row.agent_type },
    });
  }

  const instances = new Map<string, number>();
  for (const [name, ids] of instanceIds) instances.set(name, ids.size);

  return { edges, idToName, nameToType, instances, rowCount: rows.length };
}

interface TeamMemberRow {
  team_id: string;
  team_name: string;
  lead_agent: string;
  agent_id: string;
  role: string;
  name: string;
  specialty: string;
  created_at: number;
}

/**
 * Pull lead → specialist edges from the orchestrator's teams DB.
 * Opens store/nanoclaw.db read-only; returns [] if unavailable.
 */
function extractTeams(
  sinceEpoch: number | null,
  idToName: Map<string, string>,
): RawEdge[] {
  const teamDbPath = path.join(STORE_DIR, 'nanoclaw.db');
  let teamDb: Database.Database | undefined;
  try {
    teamDb = new Database(teamDbPath, { readonly: true, fileMustExist: true });
  } catch {
    return []; // No teams DB yet — graceful skip.
  }

  try {
    const rows = (
      sinceEpoch !== null
        ? teamDb.prepare(
            `SELECT t.id AS team_id, t.name AS team_name, t.lead_agent, t.created_at,
                    tm.agent_id, tm.role, tm.name, tm.specialty
             FROM teams t JOIN team_members tm ON tm.team_id = t.id
             WHERE t.created_at >= ? ORDER BY t.created_at ASC`,
          ).all(sinceEpoch)
        : teamDb.prepare(
            `SELECT t.id AS team_id, t.name AS team_name, t.lead_agent, t.created_at,
                    tm.agent_id, tm.role, tm.name, tm.specialty
             FROM teams t JOIN team_members tm ON tm.team_id = t.id
             ORDER BY t.created_at ASC`,
          ).all()
    ) as TeamMemberRow[];

    const edges: RawEdge[] = [];
    for (const row of rows) {
      // The lead's own membership row (agent_id === lead_agent) is the node, not an edge.
      if (row.agent_id === row.lead_agent) continue;
      const leadLabel = idToName.get(row.lead_agent) || `${row.team_name} lead`;
      const memberLabel = idToName.get(row.agent_id) || row.name || row.role;
      edges.push({
        source: row.lead_agent,
        target: row.agent_id,
        kind: 'team',
        intent: `${row.role}: ${row.specialty || row.name}`,
        timestamp: new Date(row.created_at).toISOString(),
        sourceNode: { kind: 'team', label: leadLabel, teamRole: 'lead' },
        targetNode: { kind: 'team', label: memberLabel, teamRole: row.role },
      });
    }
    return edges;
  } catch (err) {
    logger.warn({ err }, 'agent-graph: teams extraction skipped (table missing?)');
    return [];
  } finally {
    teamDb.close();
  }
}

// ---------------------------------------------------------------------------
// Stage 2 + 3: Merge & Analyze
// ---------------------------------------------------------------------------

/** Human-friendly label for a node id (resolve group JIDs to chat names). */
function labelFor(id: string, hint: Partial<GraphNode> | undefined): string {
  if (hint?.label) return hint.label;
  if (id === 'nanoclaw-root') return 'nanoclaw-root';
  if (id.includes('@')) {
    const name = getChatName(id);
    if (name) return name;
    // Shorten raw JID: keep the numeric prefix.
    return id.split('@')[0].slice(0, 18) + '…';
  }
  return id;
}

const MAX_SAMPLES = 3;
const SAMPLE_LEN = 100;

/**
 * Run the full Extract → Merge → Analyze pipeline for a time window.
 */
export function extractAgentGraph(window?: string): AgentGraph {
  const tw = resolveWindow(window);

  // Stage 1: Extract from every source independently.
  const ident = extractIdentities(tw.sinceIso);
  const evidence = extractEvidence(tw.sinceIso);
  const teams = extractTeams(tw.sinceEpoch, ident.idToName);
  const rawEdges: RawEdge[] = [...evidence, ...ident.edges, ...teams];

  // Stage 2: Merge — accumulate edges (keyed by source→target:kind) and nodes.
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge & { _samples: Set<string> }>();

  const ensureNode = (id: string, hint?: Partial<GraphNode>): GraphNode => {
    let node = nodeMap.get(id);
    if (!node) {
      const kind = hint?.kind ?? (id.includes('@') ? 'destination' : 'agent');
      node = {
        id,
        label: labelFor(id, hint),
        kind,
        agentType: hint?.agentType ?? ident.nameToType.get(id),
        teamRole: hint?.teamRole,
        instanceCount: ident.instances.get(id) ?? 1,
        outCount: 0,
        inCount: 0,
      };
      nodeMap.set(id, node);
    } else {
      // Enrich an existing node with any newly-discovered metadata.
      if (hint?.label && node.label === node.id) node.label = hint.label;
      if (hint?.agentType && !node.agentType) node.agentType = hint.agentType;
      if (hint?.teamRole && !node.teamRole) node.teamRole = hint.teamRole;
      if (hint?.kind === 'root') node.kind = 'root';
    }
    return node;
  };

  for (const re of rawEdges) {
    ensureNode(re.source, re.sourceNode);
    ensureNode(re.target, re.targetNode);

    const key = `${re.source}->${re.target}:${re.kind}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = {
        id: key,
        source: re.source,
        target: re.target,
        kind: re.kind,
        count: 0,
        sampleIntents: [],
        lastTimestamp: undefined,
        _samples: new Set<string>(),
      };
      edgeMap.set(key, edge);
    }
    edge.count += 1;
    if (!edge.lastTimestamp || re.timestamp > edge.lastTimestamp) {
      edge.lastTimestamp = re.timestamp;
    }
    if (edge._samples.size < MAX_SAMPLES && re.intent) {
      const sample = re.intent.replace(/\s+/g, ' ').trim().slice(0, SAMPLE_LEN);
      if (sample && !edge._samples.has(sample)) {
        edge._samples.add(sample);
        edge.sampleIntents.push(sample);
      }
    }
  }

  // Stage 3: Analyze — fold edge weights into node degrees + seen timestamps.
  const edges: GraphEdge[] = [];
  for (const e of edgeMap.values()) {
    const { _samples, ...edge } = e;
    void _samples;
    edges.push(edge);

    const src = nodeMap.get(edge.source)!;
    const tgt = nodeMap.get(edge.target)!;
    src.outCount += edge.count;
    tgt.inCount += edge.count;
    if (edge.lastTimestamp) {
      if (!src.lastSeen || edge.lastTimestamp > src.lastSeen) src.lastSeen = edge.lastTimestamp;
      if (!tgt.lastSeen || edge.lastTimestamp > tgt.lastSeen) tgt.lastSeen = edge.lastTimestamp;
      if (!src.firstSeen || edge.lastTimestamp < src.firstSeen) src.firstSeen = edge.lastTimestamp;
      if (!tgt.firstSeen || edge.lastTimestamp < tgt.firstSeen) tgt.firstSeen = edge.lastTimestamp;
    }
  }

  const nodes = [...nodeMap.values()].sort(
    (a, b) => (b.outCount + b.inCount) - (a.outCount + a.inCount),
  );
  edges.sort((a, b) => b.count - a.count);

  return {
    nodes,
    edges,
    meta: {
      window: tw.window,
      since: tw.sinceIso,
      generatedAt: new Date().toISOString(),
      sources: {
        evidence: evidence.length,
        identities: ident.rowCount,
        teamEdges: teams.length,
      },
      counts: { nodes: nodes.length, edges: edges.length },
    },
  };
}
