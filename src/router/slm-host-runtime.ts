/**
 * Host-side SLM runtime.
 *
 * Wires the SLM agent extensions to a concrete local-inference backend and
 * exposes process-wide singletons for the IPC handlers (slm_summarize /
 * slm_classify / slm_extract).
 *
 * Inference path resolution:
 *  - Primary (SLM): a small local model. By default we use the already-present
 *    Ollama endpoint (the same one the `ollama_query` IPC handler uses), since
 *    it requires no extra setup. Point NANOCLAW_SLM_MODEL at any small model
 *    (e.g. "qwen2.5:0.5b"). For the GGUF / llama.cpp production path, see
 *    {@link ./backends/llama-cpp.ts} + {@link createSlmInferenceFn}.
 *  - Fallback (LLM): optional larger local/cloud model via NANOCLAW_SLM_FALLBACK_MODEL.
 *
 * Every accepted call is recorded in the shared {@link SlmUsageTracker} so the
 * cost-savings report ("X SLM calls, saved $Y vs API") reflects real traffic.
 */

import {
  buildSlmExtensions,
  type InferenceFn,
  type SlmExtensionBundle,
} from '../agents/slm-extensions/index.js';
import { SlmUsageTracker } from './monitoring/router-metrics.js';
import { SlmDashboard } from './monitoring/slm-dashboard.js';
import { ModelRegistry } from './model-selector.js';
import { LlamaCppBackend, type DownloadPlan } from './backends/llama-cpp.js';
import {
  specialistModelId,
  makeSpecialistModelConfig,
  SLM_TASK_ENV_VARS,
} from './production-wiring.js';
import type { SlmTask } from './heterogeneous-router.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/** An InferenceFn backed by an Ollama (OpenAI-ish /api/chat) model. */
export function ollamaInferenceFn(model: string, baseUrl = OLLAMA_URL): InferenceFn {
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
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return { text: data.message?.content ?? '', modelId: model };
    } finally {
      clearTimeout(timeout);
    }
  };
}

let extensionsSingleton: SlmExtensionBundle | null = null;
let trackerSingleton: SlmUsageTracker | null = null;
let registrySingleton: ModelRegistry | null = null;
let backendSingleton: LlamaCppBackend | null = null;

/** Shared SLM cost-savings tracker. */
export function getSlmUsageTracker(): SlmUsageTracker {
  if (!trackerSingleton) trackerSingleton = new SlmUsageTracker();
  return trackerSingleton;
}

/**
 * Shared model registry for host-side SLM operations. Includes the default
 * GGUF SLMs (qwen2.5-0.5b, tiny-aya-3.35b) plus any fine-tuned specialist
 * models named via the NANOCLAW_SLM_*_MODEL env vars, so the download planner
 * can resolve and presence-check both.
 */
export function getModelRegistry(): ModelRegistry {
  if (registrySingleton) return registrySingleton;
  const registry = new ModelRegistry();
  for (const task of Object.keys(SLM_TASK_ENV_VARS) as SlmTask[]) {
    const p = (process.env[SLM_TASK_ENV_VARS[task]] || '').trim();
    if (p) registry.register(makeSpecialistModelConfig(specialistModelId(task), task, p));
  }
  registrySingleton = registry;
  return registry;
}

/** Shared llama.cpp backend bound to the host model registry. */
export function getLlamaCppBackend(): LlamaCppBackend {
  if (!backendSingleton) {
    const registry = getModelRegistry();
    backendSingleton = new LlamaCppBackend((id) => registry.get(id));
  }
  return backendSingleton;
}

/**
 * Plan (never execute) a model download. Pure inspection: reports whether the
 * GGUF is already present, its approximate size and license, and any blocking
 * reason (no URL, GPL license). Downloads remain HITL-gated — this only produces
 * the approval message. See {@link LlamaCppBackend.planDownload}.
 */
export function planModelDownload(modelId: string): DownloadPlan {
  return getLlamaCppBackend().planDownload(modelId);
}

/** Build an {@link SlmDashboard} over the shared usage tracker. */
export function getSlmDashboard(): SlmDashboard {
  return new SlmDashboard(getSlmUsageTracker());
}

/** Shared, lazily-built SLM extension bundle wired to local inference. */
export function getHostSlmExtensions(): SlmExtensionBundle {
  if (extensionsSingleton) return extensionsSingleton;
  const slmModel = process.env.NANOCLAW_SLM_MODEL || 'qwen2.5:0.5b';
  const fallbackModel = process.env.NANOCLAW_SLM_FALLBACK_MODEL;
  const slmInfer = ollamaInferenceFn(slmModel);
  const llmInfer = fallbackModel ? ollamaInferenceFn(fallbackModel) : undefined;
  extensionsSingleton = buildSlmExtensions(slmInfer, llmInfer);
  return extensionsSingleton;
}

/** Rough token estimate (≈4 chars/token) for cost accounting. */
export function estimateTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / 4);
}

/** Test hook: reset singletons so each test starts clean. */
export function _resetSlmRuntime(): void {
  extensionsSingleton = null;
  trackerSingleton = null;
  registrySingleton = null;
  backendSingleton = null;
}
