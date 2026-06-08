import { describe, it, expect } from 'vitest';

import type { InferenceFn } from '../agents/slm-extensions/index.js';
import { SlmUsageTracker } from '../router/monitoring/router-metrics.js';
import {
  INTENT_CASES,
  SENTIMENT_CASES,
  EXTRACTION_CASES,
  SUMMARIZATION_CASES,
  apiCostUsd,
  estimateTokens,
  valuesEqual,
  scoreExtraction,
  scoreSummary,
  runArm,
  runExperiment,
  DEFAULT_API_COST_PER_1K,
  type Arm,
} from './slm-integration.js';

/**
 * An "oracle" inference fn that answers every built-in scenario case correctly
 * by detecting which case the extension's prompt embeds. `failIds` forces the
 * model to emit unparseable garbage for specific cases (to exercise fallback).
 */
function oracleInfer(opts: { modelId: string; failIds?: Set<string> } = { modelId: 'oracle' }): InferenceFn {
  const fail = opts.failIds ?? new Set<string>();
  return async (req) => {
    const p = req.prompt;
    for (const c of INTENT_CASES) {
      if (p.includes(c.text)) {
        if (fail.has(c.id)) return { text: 'probably a command, hard to tell', modelId: opts.modelId };
        return { text: JSON.stringify({ intent: c.expected, confidence: 0.9 }), modelId: opts.modelId };
      }
    }
    for (const c of SENTIMENT_CASES) {
      if (p.includes(c.text)) {
        if (fail.has(c.id)) return { text: 'unclear sentiment', modelId: opts.modelId };
        const score = c.expected === 'positive' ? 0.8 : c.expected === 'negative' ? -0.8 : 0;
        return { text: JSON.stringify({ score, label: c.expected }), modelId: opts.modelId };
      }
    }
    for (const c of EXTRACTION_CASES) {
      if (p.includes(c.text)) {
        if (fail.has(c.id)) return { text: 'cannot extract', modelId: opts.modelId };
        return { text: JSON.stringify(c.expected), modelId: opts.modelId };
      }
    }
    for (const c of SUMMARIZATION_CASES) {
      if (c.messages.some((m) => p.includes(m))) {
        if (fail.has(c.id)) return { text: '', modelId: opts.modelId };
        return { text: `The thread discussed ${c.keywords.join(', ')} and next steps.`, modelId: opts.modelId };
      }
    }
    return { text: '{}', modelId: opts.modelId };
  };
}

const SLM_FAILS = new Set(['i2', 's2', 'e2', 'sum2']); // one fallback per scenario

function slmArm(failIds = SLM_FAILS): Arm {
  return {
    label: 'SLM (fine-tuned 0.5B, simulated)',
    deps: { slmInfer: oracleInfer({ modelId: 'sim-slm', failIds }), llmInfer: oracleInfer({ modelId: 'llm-fallback' }) },
    primaryCostPer1k: 0, // local inference is free
    fallbackCostPer1k: DEFAULT_API_COST_PER_1K,
  };
}

function apiArm(): Arm {
  return {
    label: 'API (Claude Sonnet, simulated)',
    deps: { slmInfer: oracleInfer({ modelId: 'api-model' }) }, // no fallback, always answers
    primaryCostPer1k: DEFAULT_API_COST_PER_1K,
    fallbackCostPer1k: DEFAULT_API_COST_PER_1K,
  };
}

// --- Pure helpers -----------------------------------------------------------

describe('cost calculation', () => {
  it('apiCostUsd multiplies (in+out)/1000 by the rate', () => {
    expect(apiCostUsd(1000, 0, 0.003)).toBeCloseTo(0.003, 9);
    expect(apiCostUsd(500, 500, 0.003)).toBeCloseTo(0.003, 9);
    expect(apiCostUsd(2000, 2000, 0.003)).toBeCloseTo(0.012, 9);
  });

  it('treats negative token counts as zero', () => {
    expect(apiCostUsd(-100, -100, 0.003)).toBe(0);
  });

  it('estimateTokens is ~4 chars/token, integer, non-negative', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('scoring', () => {
  it('valuesEqual compares numbers numerically and strings loosely', () => {
    expect(valuesEqual(1250, 1250)).toBe(true);
    expect(valuesEqual('1250', 1250)).toBe(true);
    expect(valuesEqual('Acme Corp', ' acme corp ')).toBe(true);
    expect(valuesEqual('a', 'b')).toBe(false);
  });

  it('scoreExtraction is the fraction of matching fields', () => {
    expect(scoreExtraction({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(1);
    expect(scoreExtraction({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(0.5);
    expect(scoreExtraction({ a: 1 }, null)).toBe(0);
  });

  it('scoreSummary is the fraction of keywords present', () => {
    expect(scoreSummary(['budget', 'quarter'], 'the budget for this quarter')).toBe(1);
    expect(scoreSummary(['budget', 'quarter'], 'only the budget')).toBe(0.5);
    expect(scoreSummary(['x'], null)).toBe(0);
  });
});

// --- Scenario execution -----------------------------------------------------

describe('runArm — all four scenarios', () => {
  it('an all-correct local arm scores 100% accuracy with zero cost and zero fallbacks', async () => {
    const arm: Arm = {
      label: 'perfect-local',
      deps: { slmInfer: oracleInfer({ modelId: 'sim-slm' }) },
      primaryCostPer1k: 0,
      fallbackCostPer1k: DEFAULT_API_COST_PER_1K,
    };
    const report = await runArm(arm);

    expect(report.scenarios.map((s) => s.scenario).sort()).toEqual([
      'extraction',
      'intent',
      'sentiment',
      'summarization',
    ]);
    expect(report.totals.cases).toBe(
      INTENT_CASES.length + SENTIMENT_CASES.length + EXTRACTION_CASES.length + SUMMARIZATION_CASES.length,
    );
    expect(report.totals.accuracy).toBe(1);
    expect(report.totals.fallbackRate).toBe(0);
    expect(report.totals.costUsd).toBe(0); // every case served locally for free
  });

  it('records SLM-clean confidence (0.85) for structured classification', async () => {
    const arm: Arm = {
      label: 'conf',
      deps: { slmInfer: oracleInfer({ modelId: 'sim-slm' }) },
      primaryCostPer1k: 0,
      fallbackCostPer1k: DEFAULT_API_COST_PER_1K,
    };
    const report = await runArm(arm);
    const intent = report.scenarios.find((s) => s.scenario === 'intent')!;
    // base.ts assigns 0.85 to clean, validated SLM JSON.
    for (const o of intent.outcomes) {
      expect(o.confidence).toBeCloseTo(0.85, 5);
      expect(o.usedFallback).toBe(false);
    }
  });
});

describe('fallback behavior', () => {
  it('falls back to the LLM when the SLM emits garbage (accuracy preserved, marked usedFallback)', async () => {
    const report = await runArm(slmArm());
    const intent = report.scenarios.find((s) => s.scenario === 'intent')!;
    const fellBack = intent.outcomes.find((o) => o.id === 'i2')!;
    const clean = intent.outcomes.find((o) => o.id === 'i1')!;

    expect(fellBack.usedFallback).toBe(true);
    expect(fellBack.modelId).toBe('llm-fallback');
    expect(fellBack.correct).toBe(true); // fallback fixed it
    expect(clean.usedFallback).toBe(false);
    // Overall accuracy stays 100% because every fallback case is corrected.
    expect(report.totals.accuracy).toBe(1);
  });

  it('without a fallback, a garbage SLM result is not ok', async () => {
    const arm: Arm = {
      label: 'no-fallback',
      deps: { slmInfer: oracleInfer({ modelId: 'sim-slm', failIds: new Set(['i1']) }) },
      primaryCostPer1k: 0,
      fallbackCostPer1k: DEFAULT_API_COST_PER_1K,
    };
    const report = await runArm(arm);
    const intent = report.scenarios.find((s) => s.scenario === 'intent')!;
    const failed = intent.outcomes.find((o) => o.id === 'i1')!;
    expect(failed.ok).toBe(false);
    expect(failed.correct).toBe(false);
  });
});

describe('cost tracking integration', () => {
  it('records SLM-arm calls into the provided tracker with correct fallback accounting', async () => {
    const tracker = new SlmUsageTracker({ referenceCostPer1kUsd: DEFAULT_API_COST_PER_1K, clock: () => 1_000_000 });
    await runArm(slmArm(), { tracker });
    const r = tracker.report();
    const totalCases =
      INTENT_CASES.length + SENTIMENT_CASES.length + EXTRACTION_CASES.length + SUMMARIZATION_CASES.length;
    expect(r.totalCalls).toBe(totalCases);
    expect(r.apiCalls).toBe(SLM_FAILS.size); // exactly the forced fallbacks
    expect(r.slmCalls).toBe(totalCases - SLM_FAILS.size);
    expect(r.savedUsd).toBeGreaterThan(0);
  });
});

// --- End-to-end comparison --------------------------------------------------

describe('runExperiment — SLM vs API comparison', () => {
  it('reports positive savings, the API baseline costs more, and accuracy is preserved', async () => {
    const report = await runExperiment(slmArm(), apiArm());

    expect(report.api.totals.accuracy).toBe(1);
    expect(report.slm.totals.accuracy).toBe(1); // fallback preserves accuracy
    expect(report.savings.accuracyDelta).toBe(0);

    expect(report.savings.apiCostUsd).toBeGreaterThan(0);
    expect(report.savings.slmCostUsd).toBeGreaterThan(0); // a few fallbacks cost API price
    expect(report.savings.slmCostUsd).toBeLessThan(report.savings.apiCostUsd);
    expect(report.savings.savedUsd).toBeCloseTo(report.savings.apiCostUsd - report.savings.slmCostUsd, 9);
    expect(report.savings.savingsPct).toBeGreaterThan(0);
    expect(report.savings.savingsPct).toBeLessThanOrEqual(100);
  });

  it('the API baseline arm is not recorded into the SLM tracker', async () => {
    const tracker = new SlmUsageTracker({ clock: () => 2_000_000 });
    await runExperiment(slmArm(), apiArm(), { tracker });
    const r = tracker.report();
    const totalCases =
      INTENT_CASES.length + SENTIMENT_CASES.length + EXTRACTION_CASES.length + SUMMARIZATION_CASES.length;
    // Only the SLM arm's calls are tracked, not the API baseline's.
    expect(r.totalCalls).toBe(totalCases);
  });

  it('a fully-local SLM (no fallbacks) yields ~100% savings vs API', async () => {
    const report = await runExperiment(slmArm(new Set()), apiArm());
    expect(report.savings.slmCostUsd).toBe(0);
    expect(report.savings.savingsPct).toBeCloseTo(100, 5);
  });
});
