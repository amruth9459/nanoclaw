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

/** Shared SLM cost-savings tracker. */
export function getSlmUsageTracker(): SlmUsageTracker {
  if (!trackerSingleton) trackerSingleton = new SlmUsageTracker();
  return trackerSingleton;
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
}
