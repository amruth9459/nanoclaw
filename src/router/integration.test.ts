/**
 * Integration tests for the heterogeneous SLM router production wiring.
 *
 * Covers the three properties the task wiring must guarantee:
 *  1. The heterogeneous orchestrator attaches when specialist GGUFs are present.
 *  2. It degrades gracefully to the standard router when models are missing.
 *  3. SLM usage flows into the shared tracker / dashboard for cost accounting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildProductionRouter, SLM_TASK_ENV_VARS, specialistModelId } from './production-wiring.js';
import { HeterogeneousRouter, type Specialist } from './heterogeneous-router.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';
import { SlmDashboard } from './monitoring/slm-dashboard.js';
import { planModelDownload, _resetSlmRuntime } from './slm-host-runtime.js';
import type { RoutingContext } from './types.js';

const SAMPLE_CONTEXT: RoutingContext = {
  taskType: 'conversation',
  userTier: 'internal',
  costBudget: 'zero',
  qualityNeeds: 'good',
  latencyNeeds: 'fast',
  source: 'whatsapp',
};

/** Create a temp dir with fake GGUF files for the given tasks; returns {dir, env}. */
function fakeModelEnv(tasks: Array<keyof typeof SLM_TASK_ENV_VARS>): {
  dir: string;
  env: Record<string, string | undefined>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-int-'));
  const env: Record<string, string | undefined> = {};
  for (const task of tasks) {
    const file = path.join(dir, `${task}.gguf`);
    fs.writeFileSync(file, 'GGUF\0fake-weights');
    env[SLM_TASK_ENV_VARS[task]] = file;
  }
  return { dir, env };
}

describe('buildProductionRouter — heterogeneous attach', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('attaches the orchestrator when every specialist GGUF is present', () => {
    const { dir, env } = fakeModelEnv(['intent', 'sentiment', 'summarize', 'extract']);
    tmpDirs.push(dir);

    const wiring = buildProductionRouter({ env });

    expect(wiring.heterogeneousEnabled).toBe(true);
    expect(wiring.fallbackReason).toBeUndefined();
    expect(wiring.missingModels).toHaveLength(0);
    expect(wiring.wiredSpecialists).toEqual({
      intent: specialistModelId('intent'),
      sentiment: specialistModelId('sentiment'),
      summarize: specialistModelId('summarize'),
      extract: specialistModelId('extract'),
    });

    // The router itself reports SLM-first enabled with an attached orchestrator.
    expect(wiring.router.isSlmFirstEnabled()).toBe(true);
    const het = wiring.router.getHeterogeneous();
    expect(het).toBeDefined();
    expect(het!.specialistsFor('intent')).toHaveLength(1);
    expect(het!.specialistsFor('summarize')[0].modelId).toBe(specialistModelId('summarize'));
  });

  it('wires only the present specialists and skips missing ones', () => {
    const { dir, env } = fakeModelEnv(['intent']);
    tmpDirs.push(dir);
    // Point summarize at a path that does not exist on disk.
    env[SLM_TASK_ENV_VARS.summarize] = path.join(dir, 'does-not-exist.gguf');

    const wiring = buildProductionRouter({ env });

    expect(wiring.heterogeneousEnabled).toBe(true);
    expect(wiring.wiredSpecialists).toEqual({ intent: specialistModelId('intent') });
    expect(wiring.missingModels).toEqual([
      { task: 'summarize', path: path.join(dir, 'does-not-exist.gguf') },
    ]);
    expect(wiring.router.getHeterogeneous()!.specialistsFor('summarize')).toHaveLength(0);
  });
});

describe('buildProductionRouter — graceful fallback', () => {
  it('falls back to the standard router when no model paths are configured', async () => {
    const wiring = buildProductionRouter({ env: {} });

    expect(wiring.heterogeneousEnabled).toBe(false);
    expect(wiring.router.isSlmFirstEnabled()).toBe(false);
    expect(wiring.router.getHeterogeneous()).toBeUndefined();
    expect(wiring.fallbackReason).toMatch(/no fine-tuned slm model paths/i);

    // The fallback router is still fully functional.
    const decision = await wiring.router.route(SAMPLE_CONTEXT);
    expect(decision.modelId).toBeTruthy();
  });

  it('falls back when configured model files are absent on disk', async () => {
    const env = {
      [SLM_TASK_ENV_VARS.intent]: '/nonexistent/intent.gguf',
      [SLM_TASK_ENV_VARS.summarize]: '/nonexistent/summarize.gguf',
    };

    const wiring = buildProductionRouter({ env });

    expect(wiring.heterogeneousEnabled).toBe(false);
    expect(wiring.router.getHeterogeneous()).toBeUndefined();
    expect(wiring.missingModels.map((m) => m.task).sort()).toEqual(['intent', 'summarize']);
    expect(wiring.fallbackReason).toMatch(/not found on disk/i);
    expect(wiring.fallbackReason).toMatch(/slm_download_plan/);

    // Still routes.
    const decision = await wiring.router.route(SAMPLE_CONTEXT);
    expect(decision.modelId).toBeTruthy();
  });

  it('does not throw or spawn a server at wiring time', () => {
    const { dir, env } = fakeModelEnv(['intent']);
    // The fake file is not a real GGUF; wiring must not attempt to load it.
    expect(() => buildProductionRouter({ env })).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SLM metrics tracking through the dashboard', () => {
  let tracker: SlmUsageTracker;

  beforeEach(() => {
    tracker = new SlmUsageTracker({ clock: () => 1_000_000 });
  });

  const intentModel = (id: string, intent: string): Specialist => ({
    modelId: id,
    infer: async () => ({ text: JSON.stringify({ intent, confidence: 0.95 }), modelId: id }),
  });

  it('records a $0 local win and surfaces it in the dashboard', async () => {
    const router = new HeterogeneousRouter({
      specialists: { intent: [intentModel('m1', 'command'), intentModel('m2', 'command')] },
      tracker,
    });
    const r = await router.classifyIntent('delete the file');
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(false);

    const dashboard = new SlmDashboard(tracker, router);
    const data = dashboard.generate();
    expect(data.savings.slmCalls).toBe(1);
    expect(data.savings.apiCalls).toBe(0);
    expect(data.savings.localWinRate).toBe(1);
    expect(data.taskDistribution.find((t) => t.task === 'intent')?.calls).toBe(1);
    expect(data.summary).toMatch(/saved \$/);

    const text = dashboard.textSummary();
    expect(text).toContain('SLM Usage Dashboard');
    expect(text).toContain('Local wins');
  });

  it('records an API fallback when the ensemble escalates', async () => {
    const router = new HeterogeneousRouter({
      specialists: { intent: [intentModel('m1', 'command'), intentModel('m2', 'query')] },
      llmFallback: async () => ({ text: '{"intent":"command","confidence":0.97}', modelId: 'llm' }),
      confidenceThreshold: 0.95,
      tracker,
    });
    await router.classifyIntent('which is it');

    const data = new SlmDashboard(tracker).generate();
    expect(data.savings.apiCalls).toBe(1);
    expect(data.savings.slmCalls).toBe(0);
    expect(data.savings.fallbackRate).toBe(1);
  });

  it('folds the specialist scoreboard into the dashboard when a router is supplied', async () => {
    const router = new HeterogeneousRouter({ specialists: {}, tracker });
    router.recordOutcome('intent', 'm1', true);
    router.recordOutcome('intent', 'm1', false);
    router.recordOutcome('intent', 'm2', true);

    const data = new SlmDashboard(tracker, router).generate();
    expect(data.scoreboard.intent?.[0].modelId).toBe('m2');
    expect(data.scoreboard.intent?.[0].accuracy).toBe(1);
  });

  it('handles an empty tracker without dividing by zero', () => {
    const data = new SlmDashboard(new SlmUsageTracker({ clock: () => 1_000_000 })).generate();
    expect(data.savings.totalCalls).toBe(0);
    expect(data.savings.localWinRate).toBe(0);
    expect(data.savings.fallbackRate).toBe(0);
    expect(data.taskDistribution).toEqual([]);
  });
});

describe('host download planner (slm_download_plan path)', () => {
  // The IPC handler calls planModelDownload, which resolves the shared registry
  // built from process.env. Save/restore the touched keys and reset singletons.
  const savedEnv: Record<string, string | undefined> = {};
  const touchedKeys = [SLM_TASK_ENV_VARS.intent, 'NANOCLAW_MODELS_DIR'];
  let modelsDir: string;
  let intentGguf: string;

  beforeEach(() => {
    for (const k of touchedKeys) savedEnv[k] = process.env[k];
    modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-models-'));
    intentGguf = path.join(modelsDir, 'intent.gguf');
    fs.writeFileSync(intentGguf, 'GGUF fake-weights');
    process.env.NANOCLAW_MODELS_DIR = modelsDir;
    process.env[SLM_TASK_ENV_VARS.intent] = intentGguf;
    _resetSlmRuntime();
  });

  afterEach(() => {
    for (const k of touchedKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    _resetSlmRuntime();
    fs.rmSync(modelsDir, { recursive: true, force: true });
  });

  it('reports a present env-configured specialist as not requiring download', () => {
    const plan = planModelDownload(specialistModelId('intent'));
    expect(plan.required).toBe(false);
    expect(plan.destPath).toBe(intentGguf);
    expect(plan.blockedReason).toBeUndefined();
  });

  it('plans a download for a registered model with a URL (not present, not blocked)', () => {
    // qwen2.5-0.5b ships a real Apache-2.0 GGUF URL; the temp models dir is empty.
    const plan = planModelDownload('qwen2.5-0.5b');
    expect(plan.required).toBe(true);
    expect(plan.url).toBeTruthy();
    expect(plan.blockedReason).toBeUndefined();
  });

  it('blocks an unknown model', () => {
    const plan = planModelDownload('definitely-not-a-model');
    expect(plan.blockedReason).toMatch(/unknown model/i);
  });
});
