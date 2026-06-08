import { describe, it, expect } from 'vitest';

import type { InferenceFn } from '../agents/slm-extensions/base.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';
import { HeterogeneousRouter, type Specialist } from './heterogeneous-router.js';

/** A specialist that always returns the given intent JSON. */
function intentModel(modelId: string, intent: string, confidence = 0.9): Specialist {
  return {
    modelId,
    infer: async () => ({ text: JSON.stringify({ intent, confidence }), modelId }),
  };
}

/** A specialist whose inference throws (unreachable backend). */
function brokenModel(modelId: string): Specialist {
  return { modelId, infer: (async () => { throw new Error('down'); }) as InferenceFn };
}

describe('HeterogeneousRouter — ensemble voting', () => {
  it('reaches consensus when specialists agree (no fallback)', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        intent: [intentModel('m1', 'command'), intentModel('m2', 'command'), intentModel('m3', 'command')],
      },
      llmFallback: async () => ({ text: '{"intent":"other","confidence":1}', modelId: 'llm' }),
    });
    const r = await router.classifyIntent('delete the file');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('command');
    expect(r.agreement).toBe(1);
    expect(r.usedFallback).toBe(false);
    expect(r.tally.command).toBe(3);
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('takes the majority label when specialists split', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        intent: [intentModel('m1', 'command'), intentModel('m2', 'command'), intentModel('m3', 'query')],
      },
      // High enough agreement (2/3) × confidence(0.9) = 0.6 → meets threshold 0.6.
      confidenceThreshold: 0.6,
    });
    const r = await router.classifyIntent('remove the old logs');
    expect(r.value).toBe('command');
    expect(r.tally.command).toBe(2);
    expect(r.tally.query).toBe(1);
    expect(r.agreement).toBeCloseTo(2 / 3, 5);
  });

  it('escalates to the LLM fallback when confidence is below threshold', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        // Three-way split → agreement 1/3, low confidence → escalate.
        intent: [intentModel('m1', 'command'), intentModel('m2', 'query'), intentModel('m3', 'question')],
      },
      llmFallback: async () => ({ text: '{"intent":"command","confidence":0.95}', modelId: 'llm' }),
      confidenceThreshold: 0.6,
    });
    const r = await router.classifyIntent('hmm not sure what this is');
    expect(r.usedFallback).toBe(true);
    expect(r.modelId).toBe('llm-fallback');
    expect(r.value).toBe('command');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('survives a broken specialist by voting with the rest', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        intent: [intentModel('m1', 'command'), brokenModel('m2'), intentModel('m3', 'command')],
      },
    });
    const r = await router.classifyIntent('restart the server');
    expect(r.value).toBe('command');
    // Only the two valid voters count toward agreement.
    expect(r.agreement).toBe(1);
  });

  it('fails cleanly when all SLMs are low-confidence and no fallback exists', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        intent: [intentModel('m1', 'command'), intentModel('m2', 'query'), intentModel('m3', 'question')],
      },
      confidenceThreshold: 0.9,
    });
    const r = await router.classifyIntent('ambiguous text');
    expect(r.ok).toBe(false);
    expect(r.usedFallback).toBe(false);
  });
});

describe('HeterogeneousRouter — sentiment ensemble', () => {
  it('votes on sentiment labels', async () => {
    const pos = (id: string): Specialist => ({
      modelId: id,
      infer: async () => ({ text: '{"score":0.8,"label":"positive"}', modelId: id }),
    });
    const router = new HeterogeneousRouter({
      specialists: { sentiment: [pos('a'), pos('b')] },
    });
    const r = await router.analyzeSentiment('I love this');
    expect(r.value).toBe('positive');
    expect(r.agreement).toBe(1);
  });
});

describe('HeterogeneousRouter — single-specialist tasks', () => {
  it('summarizes via a specialist with LLM fallback', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        summarize: { modelId: 'sum-1', infer: async () => ({ text: 'A concise faithful summary of the discussion.', modelId: 'sum-1' }) },
      },
    });
    const r = await router.summarize(['hello there friend', 'how are you doing today']);
    expect(r.ok).toBe(true);
    expect(r.value?.summary).toContain('summary');
  });

  it('extracts structured fields via a specialist', async () => {
    const router = new HeterogeneousRouter({
      specialists: {
        extract: { modelId: 'ex-1', infer: async () => ({ text: '{"name":"Ada","age":36}', modelId: 'ex-1' }) },
      },
    });
    const r = await router.extract('Ada, 36', { name: { type: 'string', required: true }, age: { type: 'number' } });
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('Ada');
  });

  it('returns not-ok when no specialist is registered for a task', async () => {
    const router = new HeterogeneousRouter({ specialists: {} });
    const r = await router.extract('x', { a: { type: 'string', required: true } });
    expect(r.ok).toBe(false);
  });
});

describe('HeterogeneousRouter — performance scoreboard', () => {
  it('tracks per-model accuracy and picks the best model for a task', () => {
    const router = new HeterogeneousRouter({ specialists: {} });
    router.recordOutcome('intent', 'm1', true);
    router.recordOutcome('intent', 'm1', true);
    router.recordOutcome('intent', 'm1', false); // 2/3
    router.recordOutcome('intent', 'm2', true);
    router.recordOutcome('intent', 'm2', true); // 2/2

    expect(router.bestModelFor('intent')).toBe('m2');
    const board = router.scoreboard();
    expect(board.intent[0].modelId).toBe('m2');
    expect(board.intent[0].accuracy).toBe(1);
    expect(board.intent.find((r) => r.modelId === 'm1')?.accuracy).toBeCloseTo(2 / 3, 5);
  });

  it('returns null best-model before any outcomes are recorded', () => {
    const router = new HeterogeneousRouter({ specialists: {} });
    expect(router.bestModelFor('summarize')).toBeNull();
  });
});

describe('HeterogeneousRouter — usage tracking', () => {
  it('records a $0 local win when the ensemble is confident', async () => {
    const tracker = new SlmUsageTracker({ clock: () => 1_000_000 });
    const router = new HeterogeneousRouter({
      specialists: { intent: [intentModel('m1', 'command'), intentModel('m2', 'command')] },
      tracker,
    });
    await router.classifyIntent('delete it');
    const r = tracker.report();
    expect(r.slmCalls).toBe(1);
    expect(r.apiCalls).toBe(0);
  });

  it('records an API fallback when the ensemble escalates', async () => {
    const tracker = new SlmUsageTracker({ clock: () => 1_000_000 });
    const router = new HeterogeneousRouter({
      specialists: { intent: [intentModel('m1', 'command'), intentModel('m2', 'query')] },
      llmFallback: async () => ({ text: '{"intent":"command","confidence":0.95}', modelId: 'llm' }),
      confidenceThreshold: 0.95,
      tracker,
    });
    await router.classifyIntent('which is it');
    const r = tracker.report();
    expect(r.apiCalls).toBe(1);
    expect(r.slmCalls).toBe(0);
  });
});
