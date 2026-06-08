/**
 * Production wiring for the heterogeneous SLM router.
 *
 * This is the glue the SLM Integration Experiment validates: it reads the
 * fine-tuned specialist model paths from the environment, checks that the GGUF
 * files are actually present on disk, and — only if at least one is — attaches a
 * {@link HeterogeneousRouter} to the production {@link UniversalRouter} so the
 * eligible fast-paths (intent / sentiment / summarize / extract) run on local
 * $0 SLMs with confidence-gated LLM fallback.
 *
 * Graceful degradation is the headline property: if the operator hasn't set the
 * model-path env vars, or the files aren't downloaded yet (downloads are HITL-
 * gated — see {@link ./backends/llama-cpp.ts}.planDownload and the
 * `slm_download_plan` tool), this falls back to the standard production router.
 * Nothing here ever triggers a model download or spawns a server at wiring time;
 * `llama-server` is spawned lazily on the first real inference.
 *
 * Kept free of host dependencies (no logger import) so it stays unit-testable
 * and portable — callers log the returned {@link ProductionRouterWiring} summary.
 */

import { ModelRegistry } from './model-selector.js';
import {
  RouterFactory,
  type UniversalRouter,
} from './universal-router.js';
import {
  HeterogeneousRouter,
  type Specialist,
  type SlmTask,
} from './heterogeneous-router.js';
import {
  LlamaCppBackend,
  type LlamaCppBackendConfig,
} from './backends/llama-cpp.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';
import { createSlmInferenceFn } from '../agents/slm-extensions/index.js';
import type { InferenceFn } from '../agents/slm-extensions/base.js';
import type { ModelConfig, RouterConfig } from './types.js';

/** task → environment variable holding that specialist's fine-tuned GGUF path. */
export const SLM_TASK_ENV_VARS: Record<SlmTask, string> = {
  intent: 'NANOCLAW_SLM_INTENT_MODEL',
  sentiment: 'NANOCLAW_SLM_SENTIMENT_MODEL',
  summarize: 'NANOCLAW_SLM_SUMMARIZE_MODEL',
  extract: 'NANOCLAW_SLM_EXTRACT_MODEL',
};

const SLM_TASKS: SlmTask[] = ['intent', 'sentiment', 'summarize', 'extract'];

/** Synthetic model id used for a task's fine-tuned specialist. */
export function specialistModelId(task: SlmTask): string {
  return `slm-${task}`;
}

export interface ProductionRouterWiring {
  /** The router to use in production — heterogeneous-attached or standard. */
  router: UniversalRouter;
  /** True when at least one specialist was wired and the orchestrator attached. */
  heterogeneousEnabled: boolean;
  /** task → resolved model id, for every specialist actually wired (file present). */
  wiredSpecialists: Partial<Record<SlmTask, string>>;
  /** Models named via env whose GGUF file was not found on disk (skipped). */
  missingModels: Array<{ task: SlmTask; path: string }>;
  /** Set when we fell back to the standard router; explains why. */
  fallbackReason?: string;
  /** Shared usage tracker recording $0 local wins vs paid fallbacks. */
  tracker: SlmUsageTracker;
  /** One-line, log-friendly summary of what was wired. */
  summary: string;
}

export interface BuildProductionRouterOptions {
  /** Environment to read model paths from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Shared SLM usage tracker. A fresh one is created if omitted. */
  tracker?: SlmUsageTracker;
  /** Optional escalation inference fn used when SLMs are low-confidence. */
  llmFallback?: InferenceFn;
  /** Extra config merged into the router. */
  config?: Partial<RouterConfig>;
  /** llama.cpp backend config (modelsDir, injectable spawn/fetch for tests). */
  backendConfig?: LlamaCppBackendConfig;
  /** Pre-built registry (tests). A default registry is used otherwise. */
  registry?: ModelRegistry;
}

/**
 * Build the production router, attaching the heterogeneous SLM orchestrator when
 * the fine-tuned specialist models are present on disk. Falls back gracefully to
 * the standard production router otherwise. Never downloads or spawns anything.
 */
export function buildProductionRouter(
  opts: BuildProductionRouterOptions = {},
): ProductionRouterWiring {
  const env = opts.env ?? process.env;
  const tracker = opts.tracker ?? new SlmUsageTracker();
  const registry = opts.registry ?? new ModelRegistry();

  // Register a synthetic local-llamacpp model per task that has a path set, so
  // the backend can resolve and presence-check it.
  const requested: Array<{ task: SlmTask; modelId: string; path: string }> = [];
  for (const task of SLM_TASKS) {
    const p = (env[SLM_TASK_ENV_VARS[task]] || '').trim();
    if (!p) continue;
    const modelId = specialistModelId(task);
    registry.register(makeSpecialistModelConfig(modelId, task, p));
    requested.push({ task, modelId, path: p });
  }

  if (requested.length === 0) {
    return standardFallback(
      tracker,
      opts.config,
      'No fine-tuned SLM model paths configured ' +
        `(${SLM_TASKS.map((t) => SLM_TASK_ENV_VARS[t]).join(', ')} all unset)`,
    );
  }

  // Presence check — downloads are HITL-gated, so a missing file is expected and
  // must degrade gracefully rather than throw at boot.
  const backend = new LlamaCppBackend((id) => registry.get(id), opts.backendConfig);
  const wiredSpecialists: Partial<Record<SlmTask, string>> = {};
  const missingModels: Array<{ task: SlmTask; path: string }> = [];
  const specialists: Partial<Record<SlmTask, Specialist>> = {};

  for (const { task, modelId, path } of requested) {
    if (backend.isModelPresent(modelId)) {
      specialists[task] = { modelId, infer: createSlmInferenceFn(backend, modelId), tasks: [task] };
      wiredSpecialists[task] = modelId;
    } else {
      missingModels.push({ task, path });
    }
  }

  if (Object.keys(specialists).length === 0) {
    return {
      ...standardFallback(
        tracker,
        opts.config,
        `Configured SLM model file(s) not found on disk (${missingModels
          .map((m) => `${m.task}:${m.path}`)
          .join(', ')}) — run slm_download_plan to fetch them`,
      ),
      missingModels,
    };
  }

  const llmFallback = opts.llmFallback ?? resolveLlmFallback(env);
  const router = RouterFactory.createWithHeterogeneous(
    ({ confidenceThreshold }) =>
      new HeterogeneousRouter({
        specialists,
        confidenceThreshold,
        llmFallback,
        tracker,
      }),
    opts.config,
  );

  const wiredList = Object.entries(wiredSpecialists)
    .map(([t, id]) => `${t}→${id}`)
    .join(', ');
  const missingNote = missingModels.length
    ? ` (skipped missing: ${missingModels.map((m) => m.task).join(', ')})`
    : '';

  return {
    router,
    heterogeneousEnabled: true,
    wiredSpecialists,
    missingModels,
    tracker,
    summary: `Heterogeneous SLM router attached: ${wiredList}${missingNote}`,
  };
}

/** Build the standard production router with no SLM orchestrator attached. */
function standardFallback(
  tracker: SlmUsageTracker,
  config: Partial<RouterConfig> | undefined,
  reason: string,
): ProductionRouterWiring {
  const router = RouterFactory.createProduction();
  if (config) router.updateConfig(config);
  return {
    router,
    heterogeneousEnabled: false,
    wiredSpecialists: {},
    missingModels: [],
    fallbackReason: reason,
    tracker,
    summary: `Standard production router (SLM-first disabled): ${reason}`,
  };
}

/** ModelConfig for a fine-tuned specialist served from an on-disk GGUF path. */
export function makeSpecialistModelConfig(modelId: string, task: SlmTask, ggufPath: string): ModelConfig {
  return {
    id: modelId,
    name: `Fine-tuned SLM specialist (${task})`,
    tier: 'local-slm',
    provider: 'local-llamacpp',
    supportsVision: false,
    maxTokens: 2048,
    contextWindow: 8192,
    avgLatencyMs: 120,
    costPer1kTokens: 0,
    requiresGpu: false,
    memoryGb: 4,
    quantization: 'Q4_K_M',
    // Absolute path → LlamaCppBackend.ggufPath returns it verbatim; relative →
    // resolved against the backend's models dir.
    ggufFile: ggufPath,
    license: 'Apache-2.0',
  };
}

/**
 * Resolve an optional LLM escalation path. Uses the Ollama-backed fallback model
 * when NANOCLAW_SLM_FALLBACK_MODEL is set; otherwise undefined (the ensemble then
 * fails closed on low confidence rather than escalating).
 */
function resolveLlmFallback(env: Record<string, string | undefined>): InferenceFn | undefined {
  const fallbackModel = (env.NANOCLAW_SLM_FALLBACK_MODEL || '').trim();
  if (!fallbackModel) return undefined;
  // Construct the closure only; the actual /api/chat call happens lazily on the
  // first low-confidence escalation. Kept inline (rather than importing from
  // slm-host-runtime) so this module stays dependency-light and cycle-free.
  return ollamaInferenceFn(fallbackModel, env.OLLAMA_URL);
}

/** Minimal Ollama-backed InferenceFn (OpenAI-ish /api/chat). */
function ollamaInferenceFn(model: string, baseUrl = 'http://127.0.0.1:11434'): InferenceFn {
  return async (req) => {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
    messages.push({ role: 'user', content: req.prompt });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: { temperature: req.temperature ?? 0.2, num_predict: req.maxTokens ?? 512 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return { text: data.message?.content ?? '', modelId: model };
    } finally {
      clearTimeout(timeout);
    }
  };
}
