/**
 * IntentClassifier
 *
 * Classifies a user message into a coarse intent: query, command, question, or
 * feedback (falling back to "other"). Structured JSON output + tolerant parsing
 * + LLM fallback — the canonical "simple classification" SLM task.
 */

import {
  type SlmExtensionDeps,
  type SlmResult,
  type InferenceRequest,
  runJsonWithFallback,
  clamp,
} from './base.js';

export type Intent = 'query' | 'command' | 'question' | 'feedback' | 'other';

export const INTENTS: readonly Intent[] = ['query', 'command', 'question', 'feedback', 'other'];

export interface IntentResult {
  intent: Intent;
  /** Model's own confidence in the label, 0–1. */
  modelConfidence: number;
}

const SYSTEM_PROMPT =
  'You are an intent classifier. Respond with ONLY a JSON object, no prose.';

function buildPrompt(text: string): string {
  return (
    'Classify the user message into exactly one intent:\n' +
    '- "query": asking the assistant to retrieve/look up information\n' +
    '- "command": instructing the assistant to perform an action\n' +
    '- "question": a general question seeking explanation\n' +
    '- "feedback": praise, complaint, or correction about the assistant\n' +
    '- "other": none of the above\n\n' +
    'Respond as: {"intent": "<one of the above>", "confidence": <0..1>}\n\n' +
    `Message: ${JSON.stringify(text)}`
  );
}

export class IntentClassifier {
  constructor(private deps: SlmExtensionDeps) {}

  async classify(text: string): Promise<SlmResult<IntentResult>> {
    if (!text || text.trim() === '') {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'empty input' };
    }

    const req: InferenceRequest = {
      systemPrompt: SYSTEM_PROMPT,
      prompt: buildPrompt(text),
      maxTokens: 60,
      temperature: 0,
    };

    return runJsonWithFallback<IntentResult>(this.deps, req, (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      const raw = String(obj.intent ?? '').toLowerCase().trim();
      const intent = (INTENTS as readonly string[]).includes(raw) ? (raw as Intent) : null;
      if (!intent) return null;
      const modelConfidence = clamp(Number(obj.confidence), 0, 1, 0.5);
      return { intent, modelConfidence };
    });
  }
}
