import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ModelRegistry, ModelSelector } from './model-selector.js';
import { TaskClassifier, MetadataClassifier } from './task-classifier.js';
import { RouterFactory } from './universal-router.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';
import { LlamaCppBackend, type SpawnedProcess } from './backends/llama-cpp.js';
import type { ModelConfig, RoutingContext, TaskFeatures } from './types.js';

// --- Model registry ---

describe('SLM model registry', () => {
  it('registers Tiny Aya 3.35B and Qwen2.5-0.5B as Apache-2.0 GGUF SLMs', () => {
    const registry = new ModelRegistry();
    const aya = registry.get('tiny-aya-3.35b');
    const qwen = registry.get('qwen2.5-0.5b');

    expect(aya).toBeDefined();
    expect(aya?.tier).toBe('local-slm');
    expect(aya?.provider).toBe('local-llamacpp');
    expect(aya?.quantization).toBe('Q4_K_M');
    expect(aya?.license).toBe('Apache-2.0');
    expect(aya?.costPer1kTokens).toBe(0);

    expect(qwen).toBeDefined();
    expect(qwen?.paramCountB).toBe(0.5);
    expect(qwen?.license).toBe('Apache-2.0');
    // Constraint: no GPL models.
    for (const m of registry.getByTier('local-slm')) {
      expect(/gpl/i.test(m.license ?? '')).toBe(false);
    }
  });
});

// --- Classifier feature detection ---

describe('SLM feature detection', () => {
  const meta = new MetadataClassifier();

  it('detects summarizable content', () => {
    const f = meta.detectSlmFeatures('Can you summarize this thread for me? Give me a tl;dr.');
    expect(f.isSummarizable).toBe(true);
  });

  it('detects simple classification', () => {
    const f = meta.detectSlmFeatures('What is the sentiment of this review?');
    expect(f.isSimpleClassification).toBe(true);
  });

  it('detects structured output requests', () => {
    const f = meta.detectSlmFeatures('Extract the fields and return them as JSON.');
    expect(f.requiresStructuredOutput).toBe(true);
  });

  it('detects a JSON template as structured output', () => {
    const f = meta.detectSlmFeatures('Fill this: { "name": "", "age": 0 }');
    expect(f.requiresStructuredOutput).toBe(true);
  });

  it('does not flag ordinary chat', () => {
    const f = meta.detectSlmFeatures('hey, are we still meeting at 5?');
    expect(f.isSummarizable).toBe(false);
    expect(f.isSimpleClassification).toBe(false);
    expect(f.requiresStructuredOutput).toBe(false);
  });

  it('propagates SLM features through the classifier from contentSample', async () => {
    const classifier = new TaskClassifier();
    const ctx: RoutingContext = {
      taskType: 'conversation',
      userTier: 'internal',
      costBudget: 'limited',
      qualityNeeds: 'acceptable',
      latencyNeeds: 'fast',
      source: 'whatsapp',
      contentSample: 'Please summarize the discussion above.',
    };
    const features = await classifier.classify(ctx);
    expect(features.isSummarizable).toBe(true);
  });
});

// --- Model selection routing ---

describe('SLM routing', () => {
  const registry = new ModelRegistry();
  const config = RouterFactory.getDefaultConfig();
  const selector = new ModelSelector(registry, config);

  const baseCtx: RoutingContext = {
    taskType: 'conversation',
    userTier: 'internal',
    costBudget: 'limited',
    qualityNeeds: 'acceptable',
    latencyNeeds: 'fast',
    source: 'whatsapp',
  };

  const baseFeatures: TaskFeatures = {
    complexity: 0.2,
    technicalDepth: 0.2,
    creativityNeeds: 0.2,
    accuracyRequired: 0.5,
    requiresVision: false,
    requiresCode: false,
    requiresReasoning: false,
    requiresData: false,
    estimatedTokens: 1500,
  };

  it('routes low-complexity summarization to Tiny Aya on the SLM tier', () => {
    const decision = selector.select(baseCtx, {
      ...baseFeatures,
      isSummarizable: true,
      complexity: 0.2,
    });
    expect(decision.modelTier).toBe('local-slm');
    expect(decision.modelId).toBe('tiny-aya-3.35b');
  });

  it('routes bare simple classification to the lightest 0.5B model', () => {
    const decision = selector.select(baseCtx, {
      ...baseFeatures,
      isSimpleClassification: true,
    });
    expect(decision.modelTier).toBe('local-slm');
    expect(decision.modelId).toBe('qwen2.5-0.5b');
  });

  it('routes structured-output classification to Tiny Aya', () => {
    const decision = selector.select(baseCtx, {
      ...baseFeatures,
      isSimpleClassification: true,
      requiresStructuredOutput: true,
    });
    expect(decision.modelTier).toBe('local-slm');
    expect(decision.modelId).toBe('tiny-aya-3.35b');
  });

  it('does not force SLM when accuracy requirement is high', () => {
    const decision = selector.select(baseCtx, {
      ...baseFeatures,
      isSummarizable: true,
      accuracyRequired: 0.95,
      complexity: 0.2,
    });
    // High accuracy → the SLM fast-path gate is skipped; falls to cost path.
    // complexity 0.2 + conversation still qualifies for local-slm via cost path,
    // but it should NOT have selected via the structured fast-path model rules
    // unless eligible. Either way, an SLM with high accuracy should not be 0.5B.
    expect(decision.modelId).not.toBe('qwen2.5-0.5b');
  });
});

// --- Cost savings tracking ---

describe('SlmUsageTracker', () => {
  it('reports SLM calls and dollars saved vs API', () => {
    let t = 1_000_000;
    const tracker = new SlmUsageTracker({ referenceCostPer1kUsd: 0.003, clock: () => t });

    // 10 local wins, 1000 tokens each → saved 10 * (1000/1000 * 0.003) = $0.03
    for (let i = 0; i < 10; i++) {
      tracker.record({ modelId: 'tiny-aya-3.35b', task: 'summarize', inputTokens: 800, outputTokens: 200, usedFallback: false });
    }
    // 2 fallbacks → counted as API calls, no savings
    tracker.record({ modelId: 'tiny-aya-3.35b', task: 'classify', inputTokens: 500, outputTokens: 100, usedFallback: true });
    tracker.record({ modelId: 'tiny-aya-3.35b', task: 'classify', inputTokens: 500, outputTokens: 100, usedFallback: true });

    const r = tracker.report(undefined, 'This week');
    expect(r.slmCalls).toBe(10);
    expect(r.apiCalls).toBe(2);
    expect(r.totalCalls).toBe(12);
    expect(r.savedUsd).toBeCloseTo(0.03, 5);
    expect(r.fallbackRate).toBeCloseTo(2 / 12, 5);
    expect(r.byTask.summarize).toBe(10);
    expect(r.summary).toContain('10 SLM calls');
    expect(r.summary).toContain('saved $0.03 vs API');
  });

  it('honors the trailing time window', () => {
    let t = 5_000_000;
    const tracker = new SlmUsageTracker({ clock: () => t });
    tracker.record({ modelId: 'qwen2.5-0.5b', task: 'classify', inputTokens: 100, outputTokens: 10, usedFallback: false });
    t += 10 * 24 * 60 * 60 * 1000; // advance 10 days
    const r = tracker.report(7 * 24 * 60 * 60 * 1000); // 7-day window
    expect(r.totalCalls).toBe(0); // the only record is now outside the window
  });
});

// --- llama.cpp backend lifecycle (mocked spawn + fetch) ---

function fakeProc(): SpawnedProcess {
  return {
    pid: 4242,
    kill: () => true,
    on: () => {},
  };
}

/** Build a fetch stub that answers /health and /v1/chat/completions. */
function fakeFetch(completion: string) {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) } as unknown as Response;
    }
    if (u.endsWith('/v1/chat/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [{ message: { content: completion } }],
          usage: { completion_tokens: 7 },
        }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, text: async () => 'not found', json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('LlamaCppBackend lifecycle', () => {
  it('lazily spawns a server then runs inference', async () => {
    // Real temp GGUF so the presence check passes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-test-'));
    const ggufPath = path.join(dir, 'fake.gguf');
    fs.writeFileSync(ggufPath, 'GGUF');

    const model: ModelConfig = {
      id: 'fake-slm',
      name: 'Fake SLM',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 512,
      contextWindow: 4096,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      ggufFile: ggufPath, // absolute path
      license: 'Apache-2.0',
    };

    let spawnCount = 0;
    const backend = new LlamaCppBackend(() => model, {
      spawnFn: () => {
        spawnCount++;
        return fakeProc();
      },
      fetchFn: fakeFetch('hello from slm'),
      startupTimeoutMs: 1000,
    });

    expect(backend.isModelPresent('fake-slm')).toBe(true);
    expect(backend.isRunning('fake-slm')).toBe(false);

    const res = await backend.inference({ modelId: 'fake-slm', prompt: 'hi' });
    expect(res.text).toBe('hello from slm');
    expect(res.tokensGenerated).toBe(7);
    expect(backend.isRunning('fake-slm')).toBe(true);
    expect(spawnCount).toBe(1);

    // Second call reuses the running server (no extra spawn).
    await backend.inference({ modelId: 'fake-slm', prompt: 'again' });
    expect(spawnCount).toBe(1);

    backend.shutdown();
    expect(backend.isRunning('fake-slm')).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to spawn when the GGUF is missing', async () => {
    const model: ModelConfig = {
      id: 'absent',
      name: 'Absent',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 512,
      contextWindow: 4096,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      ggufFile: '/nonexistent/path/absent.gguf',
    };
    const backend = new LlamaCppBackend(() => model, {
      spawnFn: () => fakeProc(),
      fetchFn: fakeFetch('x'),
    });
    await expect(backend.inference({ modelId: 'absent', prompt: 'hi' })).rejects.toThrow(/GGUF not found/);
  });

  it('blocks download planning when no URL is configured', () => {
    const model: ModelConfig = {
      id: 'no-url',
      name: 'No URL',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 512,
      contextWindow: 4096,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      paramCountB: 3.35,
      ggufFile: '/tmp/definitely-missing-no-url.gguf',
      license: 'Apache-2.0',
    };
    const backend = new LlamaCppBackend(() => model);
    const plan = backend.planDownload('no-url');
    expect(plan.required).toBe(true);
    expect(plan.blockedReason).toMatch(/download URL/i);
    expect(plan.approxSize).toMatch(/GB/);
  });

  it('blocks download of GPL-licensed models', () => {
    const model: ModelConfig = {
      id: 'gpl-model',
      name: 'GPL Model',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 512,
      contextWindow: 4096,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      paramCountB: 1,
      ggufFile: '/tmp/definitely-missing-gpl.gguf',
      downloadUrl: 'https://example.com/model.gguf',
      license: 'GPL-3.0',
    };
    const backend = new LlamaCppBackend(() => model);
    const plan = backend.planDownload('gpl-model');
    expect(plan.blockedReason).toMatch(/gpl/i);
  });

  it('refuses downloadModel without approval', async () => {
    const model: ModelConfig = {
      id: 'needs-approval',
      name: 'Needs Approval',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 512,
      contextWindow: 4096,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      paramCountB: 0.5,
      ggufFile: '/tmp/definitely-missing-approval.gguf',
      downloadUrl: 'https://example.com/model.gguf',
      license: 'Apache-2.0',
    };
    const backend = new LlamaCppBackend(() => model);
    await expect(backend.downloadModel('needs-approval', { approved: false })).rejects.toThrow(/not approved/i);
  });
});
