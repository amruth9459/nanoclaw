/**
 * SentimentAnalyzer
 *
 * Scores message sentiment on a -1 (very negative) .. +1 (very positive) scale,
 * with a coarse label. Bounded output (a single integer-ish score + one-word
 * label) keeps prompt inflation in check — per the "bounded memory" finding for
 * small context windows.
 */

import {
  type SlmExtensionDeps,
  type SlmResult,
  type InferenceRequest,
  runJsonWithFallback,
  clamp,
} from './base.js';

export type SentimentLabel = 'positive' | 'neutral' | 'negative';

export interface SentimentResult {
  /** -1.0 .. +1.0 */
  score: number;
  label: SentimentLabel;
}

const SYSTEM_PROMPT =
  'You are a sentiment analyzer. Respond with ONLY a JSON object, no prose.';

function buildPrompt(text: string): string {
  return (
    'Rate the sentiment of the message on a scale from -1 (very negative) to ' +
    '+1 (very positive), where 0 is neutral.\n' +
    'Respond as: {"score": <-1..1>, "label": "positive"|"neutral"|"negative"}\n\n' +
    `Message: ${JSON.stringify(text)}`
  );
}

function labelFromScore(score: number): SentimentLabel {
  if (score > 0.2) return 'positive';
  if (score < -0.2) return 'negative';
  return 'neutral';
}

export class SentimentAnalyzer {
  constructor(private deps: SlmExtensionDeps) {}

  async analyze(text: string): Promise<SlmResult<SentimentResult>> {
    if (!text || text.trim() === '') {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'empty input' };
    }

    const req: InferenceRequest = {
      systemPrompt: SYSTEM_PROMPT,
      prompt: buildPrompt(text),
      maxTokens: 40,
      temperature: 0,
    };

    return runJsonWithFallback<SentimentResult>(this.deps, req, (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      if (obj.score === undefined || obj.score === null) return null;
      const score = clamp(Number(obj.score), -1, 1, NaN);
      if (Number.isNaN(score)) return null;
      // Trust the score; derive label if the model's label is missing/invalid.
      const rawLabel = String(obj.label ?? '').toLowerCase().trim();
      const label: SentimentLabel = (['positive', 'neutral', 'negative'] as const).includes(
        rawLabel as SentimentLabel,
      )
        ? (rawLabel as SentimentLabel)
        : labelFromScore(score);
      return { score, label };
    });
  }
}
