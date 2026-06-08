/**
 * SLM Agent Extensions
 *
 * Cost-reduction primitives that run simple tasks on a small local model instead
 * of a paid API. Each extension takes an {@link SlmExtensionDeps} (a primary SLM
 * inference fn + optional LLM fallback) and returns an {@link SlmResult} with a
 * confidence score and a `usedFallback` flag.
 *
 * Wire them to a real backend with {@link createSlmInferenceFn} /
 * {@link buildSlmExtensions}, or pass mock inference fns directly in tests.
 */

export { parseTolerantJson, extractJsonBlock } from './tolerant-json.js';
export type { TolerantParseResult } from './tolerant-json.js';

export {
  runJsonWithFallback,
  safeInfer,
  clamp,
} from './base.js';
export type {
  InferenceFn,
  InferenceRequest,
  InferenceResult,
  SlmExtensionDeps,
  SlmResult,
} from './base.js';

export { ConversationSummarizer } from './ConversationSummarizer.js';
export type {
  ChatMessage,
  SummarizeOptions,
  ConversationSummary,
} from './ConversationSummarizer.js';

export { IntentClassifier, INTENTS } from './IntentClassifier.js';
export type { Intent, IntentResult } from './IntentClassifier.js';

export { SentimentAnalyzer } from './SentimentAnalyzer.js';
export type { SentimentLabel, SentimentResult } from './SentimentAnalyzer.js';

export { JsonExtractor } from './JsonExtractor.js';
export type { FieldType, FieldSpec, ExtractionSchema } from './JsonExtractor.js';

import type { InferenceFn } from './base.js';
import { ConversationSummarizer } from './ConversationSummarizer.js';
import { IntentClassifier } from './IntentClassifier.js';
import { SentimentAnalyzer } from './SentimentAnalyzer.js';
import { JsonExtractor } from './JsonExtractor.js';
import type { LlamaCppBackend } from '../../router/backends/llama-cpp.js';

/**
 * Adapt a {@link LlamaCppBackend} into an {@link InferenceFn} bound to one model.
 */
export function createSlmInferenceFn(
  backend: LlamaCppBackend,
  modelId: string,
): InferenceFn {
  return async (req) => {
    const res = await backend.inference({
      modelId,
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
    });
    return { text: res.text, modelId: res.modelId };
  };
}

export interface SlmExtensionBundle {
  summarizer: ConversationSummarizer;
  intent: IntentClassifier;
  sentiment: SentimentAnalyzer;
  json: JsonExtractor;
}

/**
 * Build all extensions wired to a primary SLM inference fn and an optional
 * LLM fallback. Pass mock fns in tests; pass {@link createSlmInferenceFn}
 * wrappers in production.
 */
export function buildSlmExtensions(
  slmInfer: InferenceFn,
  llmInfer?: InferenceFn,
): SlmExtensionBundle {
  const deps = { slmInfer, llmInfer };
  return {
    summarizer: new ConversationSummarizer(deps),
    intent: new IntentClassifier(deps),
    sentiment: new SentimentAnalyzer(deps),
    json: new JsonExtractor(deps),
  };
}
