/**
 * SLM Integration Experiment — comparison framework
 *
 * A reproducible harness that runs the same task suite through two arms — a
 * local SLM arm (small fine-tuned model + LLM fallback) and an all-API baseline
 * — and reports accuracy, confidence, fallback rate, latency, and cost for each.
 * The headline output is **how much an SLM-first router saves vs always calling
 * the API, and at what accuracy cost.**
 *
 * It validates the "small-language-models-production" thesis operationally:
 *  - Four task shapes a fine-tuned <4B model is competitive on:
 *    summarization, intent classification, sentiment, structured extraction.
 *  - Confidence scoring + a tolerant-JSON + LLM fallback keep reliability high
 *    even when the small model occasionally fails format.
 *  - Cost is the SlmUsageTracker model: a local win is $0; a fallback costs the
 *    API price. Savings = all-API cost − (SLM arm's fallback-only cost).
 *
 * The harness is backend-agnostic: it drives the real {@link SlmExtensionBundle}
 * built from whatever {@link InferenceFn}s you pass — mocks in tests, a
 * deterministic simulator in the runner, or live Ollama/llama.cpp in production.
 */

import type { InferenceFn, SlmExtensionDeps } from '../agents/slm-extensions/base.js';
import { buildSlmExtensions, type SlmExtensionBundle } from '../agents/slm-extensions/index.js';
import type { Intent } from '../agents/slm-extensions/IntentClassifier.js';
import type { SentimentLabel } from '../agents/slm-extensions/SentimentAnalyzer.js';
import type { ExtractionSchema } from '../agents/slm-extensions/JsonExtractor.js';
import { SlmUsageTracker } from '../router/monitoring/router-metrics.js';

// --- Cost model -------------------------------------------------------------

/** Reference API price we compare against (Claude Sonnet input, $/1K tokens). */
export const DEFAULT_API_COST_PER_1K = 0.003;

/** ~4 chars/token integer estimate. */
export function estimateTokens(s: string): number {
  return Math.max(0, Math.ceil((s?.length ?? 0) / 4));
}

/** USD cost for a number of input+output tokens at a given $/1K rate. */
export function apiCostUsd(inputTokens: number, outputTokens: number, per1k: number = DEFAULT_API_COST_PER_1K): number {
  return ((Math.max(0, inputTokens) + Math.max(0, outputTokens)) / 1000) * per1k;
}

// --- Scenario case definitions ---------------------------------------------

export interface IntentCase {
  id: string;
  text: string;
  expected: Intent;
}
export interface SentimentCase {
  id: string;
  text: string;
  expected: SentimentLabel;
}
export interface ExtractionCase {
  id: string;
  text: string;
  schema: ExtractionSchema;
  expected: Record<string, unknown>;
}
export interface SummarizationCase {
  id: string;
  messages: string[];
  /** Keywords a faithful summary must mention; graded accuracy = fraction present. */
  keywords: string[];
}

/** Build a chatty multi-message thread on a topic, for the summarization arm. */
function thread(topic: string, lines: string[]): string[] {
  return lines.map((l, i) => `${i % 2 === 0 ? 'user' : 'assistant'}: ${l}`);
}

export const INTENT_CASES: IntentCase[] = [
  { id: 'i1', text: 'look up the weather in Tokyo for tomorrow', expected: 'query' },
  { id: 'i2', text: 'delete the old backup files from last month', expected: 'command' },
  { id: 'i3', text: 'why does the sky appear blue during the day?', expected: 'question' },
  { id: 'i4', text: 'thanks, that summary was genuinely helpful', expected: 'feedback' },
  { id: 'i5', text: 'schedule a reminder for 6pm today', expected: 'command' },
  { id: 'i6', text: 'find the latest quarterly sales report', expected: 'query' },
  { id: 'i7', text: 'the assistant keeps misunderstanding my requests', expected: 'feedback' },
  { id: 'i8', text: 'restart the staging server right now', expected: 'command' },
];

export const SENTIMENT_CASES: SentimentCase[] = [
  { id: 's1', text: 'I absolutely love this, fantastic work!', expected: 'positive' },
  { id: 's2', text: 'this is terrible and it broke everything', expected: 'negative' },
  { id: 's3', text: 'the meeting is at 3pm in room two', expected: 'neutral' },
  { id: 's4', text: 'pretty happy with how the launch turned out', expected: 'positive' },
  { id: 's5', text: 'I am frustrated and deeply disappointed by this', expected: 'negative' },
  { id: 's6', text: 'please send over the file when you get a chance', expected: 'neutral' },
];

export const EXTRACTION_CASES: ExtractionCase[] = [
  {
    id: 'e1',
    text: 'Invoice 4471 from Acme Corp for 1250 dollars, due 2026-07-01.',
    schema: {
      invoiceNumber: { type: 'string', required: true },
      vendor: { type: 'string', required: true },
      amount: { type: 'number', required: true },
    },
    expected: { invoiceNumber: '4471', vendor: 'Acme Corp', amount: 1250 },
  },
  {
    id: 'e2',
    text: 'Contact: Ada Lovelace, email ada@calc.org, phone 202-555-0143.',
    schema: {
      name: { type: 'string', required: true },
      email: { type: 'string', required: true },
    },
    expected: { name: 'Ada Lovelace', email: 'ada@calc.org' },
  },
  {
    id: 'e3',
    text: 'Order shipped: 3 units of Widget-X to Berlin.',
    schema: {
      quantity: { type: 'number', required: true },
      product: { type: 'string', required: true },
      destination: { type: 'string', required: true },
    },
    expected: { quantity: 3, product: 'Widget-X', destination: 'Berlin' },
  },
  {
    id: 'e4',
    text: 'Booking confirmed for John Smith, a table for 4 at 7:30pm.',
    schema: {
      name: { type: 'string', required: true },
      partySize: { type: 'number', required: true },
    },
    expected: { name: 'John Smith', partySize: 4 },
  },
];

export const SUMMARIZATION_CASES: SummarizationCase[] = [
  {
    id: 'sum1',
    messages: thread('budget', [
      'we need to lock the Q3 budget by Friday',
      'agreed, what is the allocation for marketing?',
      'marketing gets 40 percent, engineering 35',
      'can we revisit the allocation if revenue grows?',
      'yes, we will reopen the budget mid-quarter',
    ]),
    keywords: ['budget', 'allocation', 'quarter'],
  },
  {
    id: 'sum2',
    messages: thread('bug', [
      'customers report the checkout page is failing',
      'is it a payment bug or a UI issue?',
      'the payment call times out intermittently',
      'we should add a retry and a fallback processor',
      'I will open a bug and patch the checkout flow tonight',
    ]),
    keywords: ['checkout', 'payment', 'bug'],
  },
  {
    id: 'sum3',
    messages: thread('trip', [
      'lets plan the team offsite trip to Lisbon',
      'should we book the flight before the hotel?',
      'book the flight first, the hotel rate is flexible',
      'I found a hotel near the venue for a good rate',
      'great, I will confirm the flight and hotel today',
    ]),
    keywords: ['trip', 'flight', 'hotel'],
  },
];

// --- Scoring ----------------------------------------------------------------

function normStr(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Loose value equality for extraction: numbers compared numerically, strings case/space-insensitively. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) === Number(b);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return normStr(a) === normStr(b);
}

export function scoreExtraction(expected: Record<string, unknown>, got: Record<string, unknown> | null): number {
  const keys = Object.keys(expected);
  if (keys.length === 0) return 1;
  if (!got) return 0;
  let hits = 0;
  for (const k of keys) if (valuesEqual(got[k], expected[k])) hits++;
  return hits / keys.length;
}

export function scoreSummary(keywords: string[], summary: string | null): number {
  if (keywords.length === 0) return 1;
  if (!summary) return 0;
  const lower = summary.toLowerCase();
  let hits = 0;
  for (const k of keywords) if (lower.includes(k.toLowerCase())) hits++;
  return hits / keywords.length;
}

// --- Run model --------------------------------------------------------------

/** One arm under test: a primary inference path plus an optional fallback and a cost model. */
export interface Arm {
  label: string;
  deps: SlmExtensionDeps;
  /** $/1K for the primary path. 0 for a local SLM; >0 for an all-API arm. */
  primaryCostPer1k: number;
  /** $/1K charged when the fallback (API) path runs. */
  fallbackCostPer1k: number;
}

export interface RunOptions {
  /** Records the SLM arm's calls so {@link SlmUsageTracker.report} matches this run. */
  tracker?: SlmUsageTracker;
  /** Injectable clock for latency timing (default Date.now). */
  clock?: () => number;
  /** Graded score at/above which a case counts as "correct". Default 0.6. */
  correctnessThreshold?: number;
}

export interface CaseOutcome {
  id: string;
  ok: boolean;
  /** Graded accuracy in [0,1]. */
  score: number;
  /** True when score ≥ correctnessThreshold. */
  correct: boolean;
  confidence: number;
  usedFallback: boolean;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
}

export interface ScenarioReport {
  scenario: string;
  task: string;
  cases: number;
  accuracy: number;
  avgScore: number;
  avgConfidence: number;
  fallbackRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costUsd: number;
  outcomes: CaseOutcome[];
}

interface ScenarioCtx {
  bundle: SlmExtensionBundle;
  primaryCostPer1k: number;
  fallbackCostPer1k: number;
  tracker?: SlmUsageTracker;
  clock: () => number;
  correctnessThreshold: number;
}

/** Time an async call with the injected clock; latency is never negative. */
async function timed<T>(ctx: ScenarioCtx, fn: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const t0 = ctx.clock();
  const value = await fn();
  return { value, latencyMs: Math.max(0, ctx.clock() - t0) };
}

function buildOutcome(
  ctx: ScenarioCtx,
  args: {
    id: string;
    ok: boolean;
    score: number;
    confidence: number;
    usedFallback: boolean;
    modelId?: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    task: string;
  },
): CaseOutcome {
  const per1k = args.usedFallback ? ctx.fallbackCostPer1k : ctx.primaryCostPer1k;
  const costUsd = apiCostUsd(args.inputTokens, args.outputTokens, per1k);
  if (ctx.tracker && args.ok) {
    ctx.tracker.record({
      modelId: args.modelId ?? 'slm',
      task: args.task,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      usedFallback: args.usedFallback,
    });
  }
  return {
    id: args.id,
    ok: args.ok,
    score: args.score,
    correct: args.score >= ctx.correctnessThreshold,
    confidence: args.confidence,
    usedFallback: args.usedFallback,
    modelId: args.modelId,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    latencyMs: args.latencyMs,
    costUsd,
  };
}

function aggregate(scenario: string, task: string, outcomes: CaseOutcome[]): ScenarioReport {
  const n = outcomes.length || 1;
  const sum = (f: (o: CaseOutcome) => number) => outcomes.reduce((s, o) => s + f(o), 0);
  return {
    scenario,
    task,
    cases: outcomes.length,
    accuracy: sum((o) => (o.correct ? 1 : 0)) / n,
    avgScore: sum((o) => o.score) / n,
    avgConfidence: sum((o) => o.confidence) / n,
    fallbackRate: sum((o) => (o.usedFallback ? 1 : 0)) / n,
    avgLatencyMs: sum((o) => o.latencyMs) / n,
    totalInputTokens: sum((o) => o.inputTokens),
    totalOutputTokens: sum((o) => o.outputTokens),
    costUsd: sum((o) => o.costUsd),
    outcomes,
  };
}

// --- Per-scenario runners ---------------------------------------------------

export async function runIntentScenario(ctx: ScenarioCtx): Promise<ScenarioReport> {
  const outcomes: CaseOutcome[] = [];
  for (const c of INTENT_CASES) {
    const { value: r, latencyMs } = await timed(ctx, () => ctx.bundle.intent.classify(c.text));
    const score = r.value?.intent === c.expected ? 1 : 0;
    outcomes.push(
      buildOutcome(ctx, {
        id: c.id,
        ok: r.ok,
        score,
        confidence: r.confidence,
        usedFallback: r.usedFallback,
        modelId: r.modelId,
        inputTokens: estimateTokens(c.text),
        outputTokens: 20,
        latencyMs,
        task: 'classify:intent',
      }),
    );
  }
  return aggregate('intent', 'classify:intent', outcomes);
}

export async function runSentimentScenario(ctx: ScenarioCtx): Promise<ScenarioReport> {
  const outcomes: CaseOutcome[] = [];
  for (const c of SENTIMENT_CASES) {
    const { value: r, latencyMs } = await timed(ctx, () => ctx.bundle.sentiment.analyze(c.text));
    const score = r.value?.label === c.expected ? 1 : 0;
    outcomes.push(
      buildOutcome(ctx, {
        id: c.id,
        ok: r.ok,
        score,
        confidence: r.confidence,
        usedFallback: r.usedFallback,
        modelId: r.modelId,
        inputTokens: estimateTokens(c.text),
        outputTokens: 20,
        latencyMs,
        task: 'classify:sentiment',
      }),
    );
  }
  return aggregate('sentiment', 'classify:sentiment', outcomes);
}

export async function runExtractionScenario(ctx: ScenarioCtx): Promise<ScenarioReport> {
  const outcomes: CaseOutcome[] = [];
  for (const c of EXTRACTION_CASES) {
    const { value: r, latencyMs } = await timed(ctx, () => ctx.bundle.json.extract(c.text, c.schema));
    const score = scoreExtraction(c.expected, r.value);
    outcomes.push(
      buildOutcome(ctx, {
        id: c.id,
        ok: r.ok,
        score,
        confidence: r.confidence,
        usedFallback: r.usedFallback,
        modelId: r.modelId,
        inputTokens: estimateTokens(c.text),
        outputTokens: estimateTokens(JSON.stringify(r.value ?? {})),
        latencyMs,
        task: 'extract',
      }),
    );
  }
  return aggregate('extraction', 'extract', outcomes);
}

export async function runSummarizationScenario(ctx: ScenarioCtx): Promise<ScenarioReport> {
  const outcomes: CaseOutcome[] = [];
  for (const c of SUMMARIZATION_CASES) {
    const { value: r, latencyMs } = await timed(ctx, () => ctx.bundle.summarizer.summarize(c.messages));
    const score = scoreSummary(c.keywords, r.value?.summary ?? null);
    outcomes.push(
      buildOutcome(ctx, {
        id: c.id,
        ok: r.ok,
        score,
        confidence: r.confidence,
        usedFallback: r.usedFallback,
        modelId: r.modelId,
        inputTokens: estimateTokens(c.messages.join('\n')),
        outputTokens: estimateTokens(r.value?.summary ?? ''),
        latencyMs,
        task: 'summarize',
      }),
    );
  }
  return aggregate('summarization', 'summarize', outcomes);
}

// --- Arm + comparison -------------------------------------------------------

export interface ArmTotals {
  cases: number;
  accuracy: number;
  avgConfidence: number;
  fallbackRate: number;
  avgLatencyMs: number;
  costUsd: number;
}

export interface ArmReport {
  arm: string;
  scenarios: ScenarioReport[];
  totals: ArmTotals;
}

export interface ComparisonReport {
  /** ISO timestamp, stamped by the caller (the framework itself never reads the clock for this). */
  generatedAtIso?: string;
  slm: ArmReport;
  api: ArmReport;
  savings: {
    slmCostUsd: number;
    apiCostUsd: number;
    savedUsd: number;
    savingsPct: number;
    /** slm.accuracy − api.accuracy (negative = SLM slightly less accurate). */
    accuracyDelta: number;
    /** api.avgLatencyMs / slm.avgLatencyMs (guarded; 1 if either is 0). */
    latencySpeedup: number;
  };
}

function totals(scenarios: ScenarioReport[]): ArmTotals {
  const cases = scenarios.reduce((s, r) => s + r.cases, 0) || 1;
  const wAccuracy = scenarios.reduce((s, r) => s + r.accuracy * r.cases, 0) / cases;
  const wConfidence = scenarios.reduce((s, r) => s + r.avgConfidence * r.cases, 0) / cases;
  const wFallback = scenarios.reduce((s, r) => s + r.fallbackRate * r.cases, 0) / cases;
  const wLatency = scenarios.reduce((s, r) => s + r.avgLatencyMs * r.cases, 0) / cases;
  const cost = scenarios.reduce((s, r) => s + r.costUsd, 0);
  return {
    cases: scenarios.reduce((s, r) => s + r.cases, 0),
    accuracy: wAccuracy,
    avgConfidence: wConfidence,
    fallbackRate: wFallback,
    avgLatencyMs: wLatency,
    costUsd: cost,
  };
}

/** Run all four scenarios for a single arm. */
export async function runArm(arm: Arm, opts: RunOptions = {}): Promise<ArmReport> {
  const ctx: ScenarioCtx = {
    bundle: buildSlmExtensions(arm.deps.slmInfer, arm.deps.llmInfer),
    primaryCostPer1k: arm.primaryCostPer1k,
    fallbackCostPer1k: arm.fallbackCostPer1k,
    tracker: opts.tracker,
    clock: opts.clock ?? (() => Date.now()),
    correctnessThreshold: opts.correctnessThreshold ?? 0.6,
  };
  const scenarios = [
    await runSummarizationScenario(ctx),
    await runIntentScenario(ctx),
    await runSentimentScenario(ctx),
    await runExtractionScenario(ctx),
  ];
  return { arm: arm.label, scenarios, totals: totals(scenarios) };
}

/**
 * Run the SLM arm and the API arm over the identical suite and diff them.
 * Only the SLM arm is recorded into `opts.tracker` (the API arm is the baseline).
 */
export async function runExperiment(slmArm: Arm, apiArm: Arm, opts: RunOptions = {}): Promise<ComparisonReport> {
  const slm = await runArm(slmArm, opts);
  // API baseline must not pollute the SLM cost-savings tracker.
  const api = await runArm(apiArm, { ...opts, tracker: undefined });

  const slmCostUsd = slm.totals.costUsd;
  const apiCostUsd = api.totals.costUsd;
  const savedUsd = apiCostUsd - slmCostUsd;
  const savingsPct = apiCostUsd > 0 ? (savedUsd / apiCostUsd) * 100 : 0;
  const latencySpeedup =
    slm.totals.avgLatencyMs > 0 && api.totals.avgLatencyMs > 0
      ? api.totals.avgLatencyMs / slm.totals.avgLatencyMs
      : 1;

  return {
    slm,
    api,
    savings: {
      slmCostUsd,
      apiCostUsd,
      savedUsd,
      savingsPct,
      accuracyDelta: slm.totals.accuracy - api.totals.accuracy,
      latencySpeedup,
    },
  };
}
