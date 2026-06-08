/**
 * Shared plumbing for SLM agent extensions.
 *
 * Every extension follows the same contract: run a small local model, validate
 * the output, score confidence, and fall back to a larger model (LLM/cloud) on
 * failure. This module factors out the inference-function abstraction and the
 * JSON-with-fallback helper so each extension is a thin, focused wrapper.
 */

import { parseTolerantJson } from './tolerant-json.js';

/** Provider-agnostic inference call. Implementations may wrap llama.cpp, Ollama, or the cloud. */
export type InferenceFn = (req: InferenceRequest) => Promise<InferenceResult>;

export interface InferenceRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface InferenceResult {
  text: string;
  modelId?: string;
}

export interface SlmExtensionDeps {
  /** Primary (small, local, $0) inference path. */
  slmInfer: InferenceFn;
  /** Optional escalation path used when the SLM output fails validation. */
  llmInfer?: InferenceFn;
}

/** Standard result envelope for every extension. */
export interface SlmResult<T> {
  ok: boolean;
  value: T | null;
  /** 0.0–1.0 — how much to trust this result. */
  confidence: number;
  /** Which model produced the accepted result. */
  modelId?: string;
  /** True if the LLM fallback was used because the SLM output was unusable. */
  usedFallback: boolean;
  /** True if the JSON had to be repaired (lowers confidence). */
  repaired?: boolean;
  error?: string;
}

/**
 * Run a JSON-producing prompt against the SLM, then (if needed) the LLM fallback.
 * `validate` turns parsed JSON into a typed value or returns null to reject it.
 *
 * Confidence model:
 *  - SLM, clean JSON, valid           → 0.85
 *  - SLM, repaired JSON, valid        → 0.65
 *  - LLM fallback, valid              → 0.9
 *  - nothing valid                    → 0.0
 */
export async function runJsonWithFallback<T>(
  deps: SlmExtensionDeps,
  req: InferenceRequest,
  validate: (parsed: unknown) => T | null,
): Promise<SlmResult<T>> {
  // Attempt 1: small model.
  const slm = await safeInfer(deps.slmInfer, req);
  if (slm) {
    const parsed = parseTolerantJson(slm.text);
    if (parsed.ok) {
      const value = validate(parsed.value);
      if (value !== null) {
        return {
          ok: true,
          value,
          confidence: parsed.repaired ? 0.65 : 0.85,
          modelId: slm.modelId,
          usedFallback: false,
          repaired: parsed.repaired,
        };
      }
    }
  }

  // Attempt 2: larger model (only if a fallback is wired).
  if (deps.llmInfer) {
    const llm = await safeInfer(deps.llmInfer, req);
    if (llm) {
      const parsed = parseTolerantJson(llm.text);
      if (parsed.ok) {
        const value = validate(parsed.value);
        if (value !== null) {
          return {
            ok: true,
            value,
            confidence: 0.9,
            modelId: llm.modelId,
            usedFallback: true,
            repaired: parsed.repaired,
          };
        }
      }
    }
  }

  return {
    ok: false,
    value: null,
    confidence: 0,
    usedFallback: Boolean(deps.llmInfer),
    error: 'SLM and fallback both failed to produce valid output',
  };
}

/** Call an inference fn, swallowing errors so the orchestrator can fall through. */
export async function safeInfer(
  fn: InferenceFn,
  req: InferenceRequest,
): Promise<InferenceResult | null> {
  try {
    const result = await fn(req);
    if (!result || typeof result.text !== 'string') return null;
    return result;
  } catch {
    return null;
  }
}

/** Clamp a number into [min, max], returning fallback for non-finite input. */
export function clamp(n: number, min: number, max: number, fallback = min): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
