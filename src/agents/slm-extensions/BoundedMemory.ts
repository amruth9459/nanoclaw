/**
 * BoundedMemory
 *
 * A memory primitive sized for small models with small context windows.
 *
 * The "small-language-models-production" finding's bounded-memory principle:
 * an SLM's context is a scarce, fixed budget, so the agent's memory must be
 * *bounded by construction* — never an ever-growing transcript that inflates
 * the prompt until quality collapses. This class enforces three rules:
 *
 *  1. **One-line summaries** — every stored fact is collapsed to a single line
 *     and hard-capped at `maxSummaryChars`. No multi-paragraph entries can leak
 *     into the prompt and blow the window.
 *  2. **Integer-only metrics** — confidence and token counts are stored as
 *     integers (confidence as 0–100, not 0.0–1.0). Integers serialize compactly,
 *     compare exactly, and never drift the way floats do across model swaps.
 *  3. **Top-N retention** — only the `maxItems` highest-scored entries are kept;
 *     adding past the cap evicts the lowest-scored entry. Footprint is bounded.
 *
 * It has no I/O and no model dependency — it is pure, synchronous, and trivially
 * testable, so it can run inside the container agent or the host.
 */

/** Default one-line summary cap (characters). Keeps a single entry well under a line. */
export const DEFAULT_MAX_SUMMARY_CHARS = 120;
/** Default context-window retention (number of entries). */
export const DEFAULT_MAX_ITEMS = 8;

export interface BoundedMemoryOptions {
  /** Hard cap on each summary's length, in characters. Default 120. */
  maxSummaryChars?: number;
  /** Top-N entries to retain. Default 8. */
  maxItems?: number;
}

/** One bounded memory entry. All numeric fields are non-negative integers. */
export interface MemoryItem {
  id: string;
  /** One-line, length-capped summary. */
  summary: string;
  /** Importance/confidence as an integer 0..100 (drives Top-N eviction). */
  score: number;
  /** Integer token estimate for this entry. */
  tokens: number;
}

/** Input accepted by {@link BoundedMemory.add}. `tokens` is estimated if omitted. */
export interface MemoryInput {
  id: string;
  summary: string;
  /** Accepts either a 0..1 float (confidence) or a 0..100 integer; normalized to int 0..100. */
  score?: number;
  tokens?: number;
}

/**
 * Collapse arbitrary text into a single line and cap its length.
 * Newlines and runs of whitespace become single spaces — this is what prevents
 * a stored "summary" from silently expanding the prompt across many lines.
 */
export function toOneLine(text: string, maxChars: number = DEFAULT_MAX_SUMMARY_CHARS): string {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = Math.max(1, Math.trunc(maxChars));
  if (collapsed.length <= cap) return collapsed;
  // Reserve one char for an ellipsis so truncation is visible.
  return collapsed.slice(0, Math.max(0, cap - 1)).trimEnd() + '…';
}

/**
 * Normalize a score to an integer in [0, 100].
 * A value in [0, 1] is treated as a float confidence and scaled by 100; a value
 * already > 1 is treated as an integer percentage. Non-finite input → 0.
 */
export function toIntScore(score: number | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  const scaled = score > 0 && score <= 1 ? score * 100 : score;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/** Integer token estimate (~4 chars/token), never negative. */
export function estimateTokensInt(text: string): number {
  return Math.max(0, Math.ceil((String(text ?? '').length) / 4));
}

/**
 * Return the top `n` items by an integer key, highest first. Stable for ties
 * (earlier items win), so retention is deterministic across runs.
 */
export function topN<T>(items: readonly T[], n: number, key: (item: T) => number): T[] {
  const cap = Math.max(0, Math.trunc(n));
  return items
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((a, b) => (b.k - a.k) || (a.index - b.index))
    .slice(0, cap)
    .map((e) => e.item);
}

/**
 * A bounded, integer-keyed memory store. Insertion-friendly, eviction-safe,
 * and always serializable to a compact context block.
 */
export class BoundedMemory {
  private readonly maxSummaryChars: number;
  private readonly maxItems: number;
  private items: MemoryItem[] = [];

  constructor(opts: BoundedMemoryOptions = {}) {
    this.maxSummaryChars = Math.max(1, Math.trunc(opts.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS));
    this.maxItems = Math.max(1, Math.trunc(opts.maxItems ?? DEFAULT_MAX_ITEMS));
  }

  /**
   * Add (or replace, by id) a memory entry. The summary is forced to one line
   * and capped; the score becomes an integer 0..100; tokens are estimated when
   * omitted. After insertion the store is pruned to the Top-N by score.
   */
  add(input: MemoryInput): MemoryItem {
    const summary = toOneLine(input.summary, this.maxSummaryChars);
    const item: MemoryItem = {
      id: input.id,
      summary,
      score: toIntScore(input.score),
      tokens:
        typeof input.tokens === 'number' && Number.isFinite(input.tokens)
          ? Math.max(0, Math.trunc(input.tokens))
          : estimateTokensInt(summary),
    };

    const existingIndex = this.items.findIndex((i) => i.id === item.id);
    if (existingIndex >= 0) {
      this.items[existingIndex] = item;
    } else {
      this.items.push(item);
    }

    // Enforce the bound: keep only the Top-N by score.
    this.items = topN(this.items, this.maxItems, (i) => i.score);
    return item;
  }

  get(id: string): MemoryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Current entries, highest-scored first. */
  all(): MemoryItem[] {
    return topN(this.items, this.items.length, (i) => i.score);
  }

  size(): number {
    return this.items.length;
  }

  /** Integer sum of stored token estimates — the memory's prompt cost. */
  totalTokens(): number {
    return this.items.reduce((sum, i) => sum + i.tokens, 0);
  }

  /** Total character footprint of all summaries — bounded by maxItems × maxSummaryChars. */
  footprintChars(): number {
    return this.items.reduce((sum, i) => sum + i.summary.length, 0);
  }

  /** Upper bound on the footprint, regardless of what has been added. */
  maxFootprintChars(): number {
    return this.maxItems * this.maxSummaryChars;
  }

  /**
   * Render the memory as a compact, prompt-ready context block: one bullet per
   * entry, highest-scored first. Guaranteed to be at most `maxItems` lines.
   */
  toContext(): string {
    return this.all()
      .map((i) => `- (${i.score}) ${i.summary}`)
      .join('\n');
  }

  clear(): void {
    this.items = [];
  }
}
