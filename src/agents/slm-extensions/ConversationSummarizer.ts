/**
 * ConversationSummarizer
 *
 * Compresses a chat history (e.g. 50 messages) into a short summary
 * (~3 paragraphs). This is the highest-volume SLM win: turning recurring
 * "summarize this thread" API calls into $0 local inference.
 *
 * Summaries are plain text (not JSON), so this extension doesn't use the JSON
 * fallback path — instead it falls back to the LLM when the SLM output is
 * empty/degenerate, and scores confidence from output sanity.
 */

import {
  type SlmExtensionDeps,
  type SlmResult,
  type InferenceRequest,
  safeInfer,
} from './base.js';

export interface ChatMessage {
  role?: string;
  sender?: string;
  content: string;
}

export interface SummarizeOptions {
  /** Target length. Default: 3 paragraphs. */
  paragraphs?: number;
  /** Cap on output tokens. Default: 500. */
  maxTokens?: number;
  /** Optional focus, e.g. "decisions and action items". */
  focus?: string;
}

export interface ConversationSummary {
  summary: string;
  messageCount: number;
}

const SYSTEM_PROMPT =
  'You are a precise conversation summarizer. Produce a faithful, neutral summary. ' +
  'Do not invent facts. Output only the summary text — no preamble, no markdown headers.';

export class ConversationSummarizer {
  constructor(private deps: SlmExtensionDeps) {}

  async summarize(
    messages: Array<ChatMessage | string>,
    opts: SummarizeOptions = {},
  ): Promise<SlmResult<ConversationSummary>> {
    const normalized = messages.map(normalizeMessage).filter((m) => m.content.trim() !== '');
    if (normalized.length === 0) {
      return { ok: false, value: null, confidence: 0, usedFallback: false, error: 'no messages' };
    }

    const paragraphs = opts.paragraphs ?? 3;
    const transcript = normalized
      .map((m) => `${m.role ?? m.sender ?? 'user'}: ${m.content}`)
      .join('\n');

    const focusLine = opts.focus ? ` Focus on: ${opts.focus}.` : '';
    const req: InferenceRequest = {
      systemPrompt: SYSTEM_PROMPT,
      prompt:
        `Summarize the following conversation in ${paragraphs} short paragraph(s).${focusLine}\n\n` +
        `--- CONVERSATION (${normalized.length} messages) ---\n${transcript}\n--- END ---`,
      maxTokens: opts.maxTokens ?? 500,
      temperature: 0.2,
    };

    // Attempt 1: SLM.
    const slm = await safeInfer(this.deps.slmInfer, req);
    const slmText = slm?.text?.trim() ?? '';
    if (isUsableSummary(slmText, transcript)) {
      return {
        ok: true,
        value: { summary: slmText, messageCount: normalized.length },
        confidence: scoreSummary(slmText, normalized.length),
        modelId: slm?.modelId,
        usedFallback: false,
      };
    }

    // Attempt 2: LLM fallback.
    if (this.deps.llmInfer) {
      const llm = await safeInfer(this.deps.llmInfer, req);
      const llmText = llm?.text?.trim() ?? '';
      if (isUsableSummary(llmText, transcript)) {
        return {
          ok: true,
          value: { summary: llmText, messageCount: normalized.length },
          confidence: 0.9,
          modelId: llm?.modelId,
          usedFallback: true,
        };
      }
    }

    return {
      ok: false,
      value: null,
      confidence: 0,
      usedFallback: Boolean(this.deps.llmInfer),
      error: 'no usable summary produced',
    };
  }
}

function normalizeMessage(m: ChatMessage | string): ChatMessage {
  return typeof m === 'string' ? { content: m } : m;
}

/** A summary is usable if it's non-empty, not a near-copy of the input, and bounded. */
function isUsableSummary(text: string, transcript: string): boolean {
  if (!text) return false;
  if (text.length < 10) return false;
  // Guard against the model echoing the transcript verbatim.
  if (text.length > transcript.length * 0.95 && transcript.length > 200) return false;
  return true;
}

/** Confidence: a summary that meaningfully compresses many messages is more trustworthy. */
function scoreSummary(text: string, messageCount: number): number {
  let score = 0.7;
  if (messageCount >= 10) score += 0.1; // real compression
  if (text.length >= 80) score += 0.05; // not a one-liner
  return Math.min(score, 0.85);
}
