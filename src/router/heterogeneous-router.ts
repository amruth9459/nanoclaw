/**
 * Heterogeneous Model Orchestrator
 *
 * Routes each SLM task to one or more *specialist* small models and, for
 * classification tasks, fuses their answers with ensemble voting. Falls back to
 * a larger LLM only when the specialists are low-confidence or disagree.
 *
 * Why "heterogeneous": per the "small-language-models-production" finding, the
 * useful diversity between small models comes from *different post-training*
 * (different fine-tunes / instruction data), not from raw scale. Three models
 * fine-tuned on different data give genuinely independent votes; three copies of
 * the same base do not. This orchestrator treats each specialist as an opaque
 * {@link InferenceFn} so a model is swapped by changing one config entry — the
 * tolerant-JSON layer in the agent extensions makes the output contract stable
 * across swaps.
 *
 * Design rules honored here:
 *  - **Information-asymmetry firewall**: only the user-visible text is ever sent
 *    to a model. The per-model performance scoreboard is hidden routing state and
 *    is never serialized into a prompt.
 *  - **Confidence-gated escalation**: SLM-first; the paid LLM runs only when the
 *    ensemble's agreement-weighted confidence is below threshold.
 */

import type { InferenceFn, SlmResult } from '../agents/slm-extensions/base.js';
import {
  IntentClassifier,
  type Intent,
} from '../agents/slm-extensions/IntentClassifier.js';
import {
  SentimentAnalyzer,
  type SentimentLabel,
} from '../agents/slm-extensions/SentimentAnalyzer.js';
import {
  ConversationSummarizer,
  type ChatMessage,
  type ConversationSummary,
  type SummarizeOptions,
} from '../agents/slm-extensions/ConversationSummarizer.js';
import {
  JsonExtractor,
  type ExtractionSchema,
} from '../agents/slm-extensions/JsonExtractor.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';

/** The SLM task families this orchestrator routes. */
export type SlmTask = 'intent' | 'sentiment' | 'summarize' | 'extract';

/** A single fine-tuned specialist model, wrapped as an opaque inference fn. */
export interface Specialist {
  modelId: string;
  infer: InferenceFn;
  /** Informational: which task(s) this model was post-trained for. */
  tasks?: SlmTask[];
}

export interface HeterogeneousRouterOptions {
  /**
   * Specialist SLM(s) per task. Provide an array to enable ensemble voting on
   * the classification tasks (intent / sentiment).
   */
  specialists: Partial<Record<SlmTask, Specialist | Specialist[]>>;
  /** Escalation model used when the SLMs are low-confidence or disagree. */
  llmFallback?: InferenceFn;
  /** Min agreement-weighted confidence below which we escalate. Default 0.6. */
  confidenceThreshold?: number;
  /** Optional shared usage tracker (records $0 local wins vs paid fallbacks). */
  tracker?: SlmUsageTracker;
}

/** One specialist's vote in an ensemble. */
export interface EnsembleVote<T> {
  modelId: string;
  value: T | null;
  /** The specialist's own confidence, 0..1. */
  confidence: number;
}

/** Result of an ensemble classification. */
export interface EnsembleResult<T> {
  ok: boolean;
  value: T | null;
  /** Agreement-weighted confidence, 0..1. */
  confidence: number;
  /** Fraction of *voting* specialists that backed the winner, 0..1. */
  agreement: number;
  votes: EnsembleVote<T>[];
  /** label → vote count among specialists. */
  tally: Record<string, number>;
  usedFallback: boolean;
  /** Model credited with the accepted answer. */
  modelId?: string;
  error?: string;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/** ~4 chars/token integer estimate, for cost accounting. */
function estimateTokens(s: string): number {
  return Math.max(0, Math.ceil((s?.length ?? 0) / 4));
}

interface ScoreCell {
  correct: number;
  total: number;
}

export interface ScoreboardRow {
  modelId: string;
  correct: number;
  total: number;
  accuracy: number;
}

export class HeterogeneousRouter {
  private readonly threshold: number;
  private readonly tracker?: SlmUsageTracker;
  private readonly llmFallback?: InferenceFn;
  private readonly specialists: Partial<Record<SlmTask, Specialist[]>>;
  /** task → modelId → {correct,total}. Hidden routing state — never enters a prompt. */
  private readonly scores = new Map<SlmTask, Map<string, ScoreCell>>();

  constructor(opts: HeterogeneousRouterOptions) {
    this.threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.tracker = opts.tracker;
    this.llmFallback = opts.llmFallback;
    this.specialists = {};
    for (const task of ['intent', 'sentiment', 'summarize', 'extract'] as SlmTask[]) {
      const entry = opts.specialists[task];
      if (entry) this.specialists[task] = Array.isArray(entry) ? entry : [entry];
    }
  }

  /** All specialists registered for a task (may be empty). */
  specialistsFor(task: SlmTask): Specialist[] {
    return this.specialists[task] ?? [];
  }

  // --- Ensemble classification ---------------------------------------------

  /** Classify intent by majority vote across the intent specialists. */
  async classifyIntent(text: string): Promise<EnsembleResult<Intent>> {
    return this.ensembleClassify<Intent>('intent', text, (infer) =>
      new IntentClassifier({ slmInfer: infer })
        .classify(text)
        .then((r) => ({ value: r.value?.intent ?? null, confidence: r.value?.modelConfidence ?? r.confidence })),
    );
  }

  /** Classify sentiment label by majority vote across the sentiment specialists. */
  async analyzeSentiment(text: string): Promise<EnsembleResult<SentimentLabel>> {
    return this.ensembleClassify<SentimentLabel>('sentiment', text, (infer) =>
      new SentimentAnalyzer({ slmInfer: infer })
        .analyze(text)
        .then((r) => ({ value: r.value?.label ?? null, confidence: r.confidence })),
    );
  }

  /**
   * Shared ensemble logic: run each specialist, tally string-valued labels,
   * pick the winner, weight confidence by agreement, and escalate to the LLM
   * fallback when confidence is below threshold (or nobody voted).
   */
  private async ensembleClassify<T extends string>(
    task: SlmTask,
    text: string,
    runOne: (infer: InferenceFn) => Promise<{ value: T | null; confidence: number }>,
  ): Promise<EnsembleResult<T>> {
    if (!text || text.trim() === '') {
      return { ok: false, value: null, confidence: 0, agreement: 0, votes: [], tally: {}, usedFallback: false, error: 'empty input' };
    }

    const specialists = this.specialistsFor(task);
    const votes: EnsembleVote<T>[] = await Promise.all(
      specialists.map(async (s) => {
        try {
          const { value, confidence } = await runOne(s.infer);
          return { modelId: s.modelId, value, confidence };
        } catch {
          return { modelId: s.modelId, value: null, confidence: 0 };
        }
      }),
    );

    const valid = votes.filter((v) => v.value !== null);
    const tally: Record<string, number> = {};
    for (const v of valid) tally[v.value as string] = (tally[v.value as string] ?? 0) + 1;

    let winner: T | null = null;
    let winnerCount = 0;
    for (const [label, count] of Object.entries(tally)) {
      if (count > winnerCount) {
        winner = label as T;
        winnerCount = count;
      }
    }

    const agreement = valid.length > 0 ? winnerCount / valid.length : 0;
    const agreeingVotes = valid.filter((v) => v.value === winner);
    const winnerConfidence =
      agreeingVotes.length > 0
        ? agreeingVotes.reduce((s, v) => s + v.confidence, 0) / agreeingVotes.length
        : 0;
    // Agreement-weighted confidence: full agreement at high model-confidence ⇒ high.
    const ensembleConfidence = clamp01(agreement * winnerConfidence);

    const winningModelId = agreeingVotes[0]?.modelId;

    if (winner !== null && ensembleConfidence >= this.threshold) {
      this.recordUsage(task, winningModelId ?? 'ensemble', text, false);
      return {
        ok: true,
        value: winner,
        confidence: ensembleConfidence,
        agreement,
        votes,
        tally,
        usedFallback: false,
        modelId: winningModelId,
      };
    }

    // Escalate: low confidence / disagreement / no votes.
    if (this.llmFallback) {
      try {
        const { value, confidence } = await runOne(this.llmFallback);
        if (value !== null) {
          this.recordUsage(task, 'llm-fallback', text, true);
          return {
            ok: true,
            value,
            confidence: Math.max(confidence, 0.9),
            agreement,
            votes,
            tally,
            usedFallback: true,
            modelId: 'llm-fallback',
          };
        }
      } catch {
        /* fall through to failure */
      }
    }

    return {
      ok: false,
      value: winner,
      confidence: ensembleConfidence,
      agreement,
      votes,
      tally,
      usedFallback: Boolean(this.llmFallback),
      error: 'low-confidence ensemble and no usable fallback',
    };
  }

  // --- Single-specialist tasks (free text / structured) --------------------

  /**
   * Summarize via the best-performing 'summarize' specialist (per the
   * scoreboard), with the LLM as the safety fallback. Ensemble voting is not
   * meaningful for free-form text, so we route to one model.
   */
  async summarize(
    messages: Array<ChatMessage | string>,
    opts?: SummarizeOptions,
  ): Promise<SlmResult<ConversationSummary>> {
    const specialist = this.pickSpecialist('summarize');
    if (!specialist) {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'no summarize specialist' };
    }
    const summarizer = new ConversationSummarizer({ slmInfer: specialist.infer, llmInfer: this.llmFallback });
    const r = await summarizer.summarize(messages, opts);
    if (r.ok) {
      const inText = messages.map((m) => (typeof m === 'string' ? m : m.content)).join('\n');
      this.recordUsageTokens('summarize', r.modelId ?? specialist.modelId, estimateTokens(inText), estimateTokens(r.value?.summary ?? ''), r.usedFallback);
    }
    return r;
  }

  /** Extract structured fields via the best 'extract' specialist, LLM fallback on failure. */
  async extract(text: string, schema: ExtractionSchema): Promise<SlmResult<Record<string, unknown>>> {
    const specialist = this.pickSpecialist('extract');
    if (!specialist) {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'no extract specialist' };
    }
    const extractor = new JsonExtractor({ slmInfer: specialist.infer, llmInfer: this.llmFallback });
    const r = await extractor.extract(text, schema);
    if (r.ok) {
      this.recordUsageTokens('extract', r.modelId ?? specialist.modelId, estimateTokens(text), estimateTokens(JSON.stringify(r.value ?? {})), r.usedFallback);
    }
    return r;
  }

  /** Choose the best specialist for a task by scoreboard accuracy, else the first registered. */
  private pickSpecialist(task: SlmTask): Specialist | undefined {
    const list = this.specialistsFor(task);
    if (list.length === 0) return undefined;
    const best = this.bestModelFor(task);
    return (best && list.find((s) => s.modelId === best)) || list[0];
  }

  // --- Performance scoreboard (hidden routing state) -----------------------

  /**
   * Record a ground-truth outcome for a (task, model) pair. Callers that know
   * the correct label (evals, user feedback, a teacher model) feed results here
   * so {@link bestModelFor} can learn which model wins which task over time.
   */
  recordOutcome(task: SlmTask, modelId: string, correct: boolean): void {
    let perModel = this.scores.get(task);
    if (!perModel) {
      perModel = new Map();
      this.scores.set(task, perModel);
    }
    const cell = perModel.get(modelId) ?? { correct: 0, total: 0 };
    cell.total += 1;
    if (correct) cell.correct += 1;
    perModel.set(modelId, cell);
  }

  /** Highest-accuracy model for a task (min 1 sample), tie-broken by sample size. */
  bestModelFor(task: SlmTask): string | null {
    const perModel = this.scores.get(task);
    if (!perModel || perModel.size === 0) return null;
    let bestId: string | null = null;
    let bestAcc = -1;
    let bestTotal = -1;
    for (const [modelId, cell] of perModel) {
      if (cell.total === 0) continue;
      const acc = cell.correct / cell.total;
      if (acc > bestAcc || (acc === bestAcc && cell.total > bestTotal)) {
        bestId = modelId;
        bestAcc = acc;
        bestTotal = cell.total;
      }
    }
    return bestId;
  }

  /** Full per-task scoreboard, accuracy-sorted. */
  scoreboard(): Record<string, ScoreboardRow[]> {
    const out: Record<string, ScoreboardRow[]> = {};
    for (const [task, perModel] of this.scores) {
      out[task] = Array.from(perModel.entries())
        .map(([modelId, c]) => ({ modelId, correct: c.correct, total: c.total, accuracy: c.total ? c.correct / c.total : 0 }))
        .sort((a, b) => b.accuracy - a.accuracy || b.total - a.total);
    }
    return out;
  }

  // --- Usage tracking ------------------------------------------------------

  private recordUsage(task: SlmTask, modelId: string, inText: string, usedFallback: boolean): void {
    this.recordUsageTokens(task, modelId, estimateTokens(inText), 20, usedFallback);
  }

  private recordUsageTokens(task: SlmTask, modelId: string, inputTokens: number, outputTokens: number, usedFallback: boolean): void {
    this.tracker?.record({ modelId, task, inputTokens, outputTokens, usedFallback });
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
