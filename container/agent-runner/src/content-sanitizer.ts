/**
 * Content Sanitizer — AI Agent Trap Defenses
 *
 * Based on Google DeepMind 2026 paper on indirect prompt injection attacks.
 * Defends against:
 *   1. Content injection via WebFetch/agent-browser (89% success rate in paper)
 *   2. RAG poisoning through untrusted sources
 *   3. Memory poisoning via external content
 *   4. Sub-agent spawning without HITL from web content
 *
 * All functions are pure (no side effects) — logging/alerting happens in the hooks layer.
 */

import crypto from 'crypto';

// ── Injection pattern definitions ──────────────────────────────────────────────

interface InjectionPattern {
  pattern: RegExp;
  label: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  // Instruction override attempts
  { pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|context)\b/gi, label: 'instruction-override' },
  { pattern: /\b(?:do\s+not\s+follow|override|bypass)\s+(?:your|the|any|all)\s+(?:instructions?|rules?|guidelines?|constraints?)\b/gi, label: 'instruction-override' },

  // Role manipulation
  { pattern: /\byou\s+are\s+now\s+(?:a|an)\s+/gi, label: 'role-manipulation' },
  { pattern: /\bact\s+as\s+(?:a|an|if\s+you\s+(?:are|were))\s+/gi, label: 'role-manipulation' },
  { pattern: /\bpretend\s+(?:to\s+be|you\s+are)\s+/gi, label: 'role-manipulation' },
  { pattern: /\byou\s+(?:must|should|will)\s+(?:now\s+)?(?:act|behave|respond)\s+(?:as|like)\s+/gi, label: 'role-manipulation' },

  // System/admin tag injection
  { pattern: /\[(?:SYSTEM|ADMIN|OVERRIDE|ROOT|SUDO|INTERNAL)\]/gi, label: 'tag-injection' },
  { pattern: /\[\/(?:SYSTEM|ADMIN|OVERRIDE|ROOT|SUDO|INTERNAL)\]/gi, label: 'tag-injection' },

  // Chat ML delimiter injection
  { pattern: /<\|im_start\|>/gi, label: 'delimiter-injection' },
  { pattern: /<\|im_end\|>/gi, label: 'delimiter-injection' },
  { pattern: /<\|(?:system|user|assistant|endoftext)\|>/gi, label: 'delimiter-injection' },

  // Jailbreak mode triggers
  { pattern: /\bDAN\s+mode\b/gi, label: 'jailbreak-mode' },
  { pattern: /\bdeveloper\s+mode\b/gi, label: 'jailbreak-mode' },
  { pattern: /\bgod\s+mode\b/gi, label: 'jailbreak-mode' },
  { pattern: /\bjailbreak(?:ed)?\s+mode\b/gi, label: 'jailbreak-mode' },
  { pattern: /\bunrestricted\s+mode\b/gi, label: 'jailbreak-mode' },
];

// Zero-width / invisible characters used to smuggle content past filters
const INVISIBLE_CHAR_PATTERN = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064]/g;

// ── Spawn trigger detection ────────────────────────────────────────────────────

const SPAWN_TRIGGERS: RegExp[] = [
  // Direct tool invocation patterns
  /\b(?:use|call|invoke|run|execute)\s+(?:the\s+)?(?:Agent|Bash|Write|Edit)\s+tool\b/i,
  /\b(?:spawn|create|start|launch)\s+(?:a\s+)?(?:new\s+)?(?:agent|subprocess|process|shell|container)\b/i,
  // Code execution instructions
  /\b(?:run|execute|eval)\s+(?:this|the\s+following)\s+(?:code|script|command)\b/i,
  // File write instructions targeting sensitive paths
  /\b(?:write|create|modify|append)\s+(?:to\s+)?(?:\/workspace|\/tmp|~\/)\S+/i,
];

// ── Trust scoring ──────────────────────────────────────────────────────────────

interface TrustScore {
  score: number;        // 0–100
  tier: 'high' | 'medium' | 'low';
  domain: string;
}

const HIGH_TRUST_DOMAINS = [
  /\.gov$/i,
  /\.edu$/i,
  /^github\.com$/i,
  /^raw\.githubusercontent\.com$/i,
  /^arxiv\.org$/i,
  /^docs\.python\.org$/i,
  /^developer\.mozilla\.org$/i,
  /^registry\.npmjs\.org$/i,
  /^pypi\.org$/i,
];

const MEDIUM_TRUST_DOMAINS = [
  /^(?:en\.)?wikipedia\.org$/i,
  /^stackoverflow\.com$/i,
  /^stackexchange\.com$/i,
  /^medium\.com$/i,
  /^dev\.to$/i,
  /^(?:www\.)?npmjs\.com$/i,
  /^docs\.rs$/i,
  /^crates\.io$/i,
];

// ── Memory integrity ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  content: string;
  source: string;
  timestamp: string;
  hash: string;
  trustScore: number;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface SanitizeResult {
  sanitized: string;
  patternsFound: string[];
  invisibleCharsStripped: number;
  wasSanitized: boolean;
}

/**
 * Strip injection patterns and invisible characters from external content.
 * Returns sanitized text with a report of what was found.
 */
export function sanitizeContent(raw: string): SanitizeResult {
  const patternsFound: string[] = [];
  let text = raw;

  // Strip invisible characters first
  const invisibleMatches = text.match(INVISIBLE_CHAR_PATTERN);
  const invisibleCharsStripped = invisibleMatches ? invisibleMatches.length : 0;
  if (invisibleCharsStripped > 0) {
    text = text.replace(INVISIBLE_CHAR_PATTERN, '');
    patternsFound.push('invisible-chars');
  }

  // Detect and neutralize injection patterns
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      if (!patternsFound.includes(label)) {
        patternsFound.push(label);
      }
      // Neutralize by wrapping matched text in visible markers
      text = text.replace(pattern, (match) => `[NEUTRALIZED: ${match}]`);
    }
  }

  return {
    sanitized: text,
    patternsFound,
    invisibleCharsStripped,
    wasSanitized: patternsFound.length > 0,
  };
}

/**
 * Calculate a trust score for a given URL based on its domain.
 * Returns score (0–100) and tier classification.
 */
export function calculateTrustScore(url: string): TrustScore {
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    return { score: 10, tier: 'low', domain: url };
  }

  for (const re of HIGH_TRUST_DOMAINS) {
    if (re.test(domain)) {
      return { score: 90, tier: 'high', domain };
    }
  }

  for (const re of MEDIUM_TRUST_DOMAINS) {
    if (re.test(domain)) {
      return { score: 60, tier: 'medium', domain };
    }
  }

  return { score: 30, tier: 'low', domain };
}

/**
 * Validate a RAG source URL against the trust threshold.
 * Rejects sources below the given minimum score (default: 50 = medium tier).
 */
export function validateRAGSource(url: string, minScore = 50): { allowed: boolean; trust: TrustScore; reason: string } {
  const trust = calculateTrustScore(url);
  if (trust.score >= minScore) {
    return { allowed: true, trust, reason: 'Source meets trust threshold' };
  }
  return {
    allowed: false,
    trust,
    reason: `Source ${trust.domain} scored ${trust.score}/100 (${trust.tier}), below threshold ${minScore}`,
  };
}

/**
 * Detect spawn/execution triggers embedded in external content.
 * Returns list of matched trigger descriptions.
 */
export function detectSpawnTriggers(content: string): string[] {
  const triggers: string[] = [];
  for (const re of SPAWN_TRIGGERS) {
    const match = content.match(re);
    if (match) {
      triggers.push(match[0]);
    }
  }
  return triggers;
}

/**
 * Verify that a memory entry hasn't been tampered with.
 * Recomputes the SHA-256 hash and compares against the stored hash.
 */
export function verifyMemoryIntegrity(entry: MemoryEntry): boolean {
  const expected = computeMemoryHash(entry.content, entry.source, entry.timestamp);
  return entry.hash === expected;
}

/**
 * Create a new integrity-checked memory entry.
 * The hash covers content + source + timestamp so any mutation is detectable.
 */
export function createMemoryEntry(content: string, source: string, trustScore: number): MemoryEntry {
  const timestamp = new Date().toISOString();
  const hash = computeMemoryHash(content, source, timestamp);
  return { content, source, timestamp, hash, trustScore };
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function computeMemoryHash(content: string, source: string, timestamp: string): string {
  return crypto
    .createHash('sha256')
    .update(`${content}\0${source}\0${timestamp}`)
    .digest('hex');
}
