/**
 * SLM fine-tuning dataset generator
 *
 * Turns NanoClaw conversation history into labeled, JSONL training data for
 * fine-tuning a small model on the two highest-volume SLM tasks: conversation
 * summarization and intent classification.
 *
 * Per the "small-language-models-production" finding, a fine-tuned 0.5B beats an
 * untrained 3B on structured tasks — but only with *good labels*. This module is
 * pure (no I/O, no model, no DB) and offers two labeling strategies:
 *
 *  - **Heuristic** (default): deterministic, rule-based weak labels. Cheap and
 *    reproducible; good enough to bootstrap and to unit-test the pipeline. Every
 *    heuristic example is flagged `needsReview: true` so it is never mistaken for
 *    gold data.
 *  - **Teacher** (optional): pass an async `labeler` (e.g. wrapping the existing
 *    LLM / a strong API model) to distill high-quality labels. This is the
 *    production path — the small model learns to imitate the teacher.
 *
 * Output is OpenAI-style chat JSONL (`{"messages":[...]}` per line), the de-facto
 * fine-tuning format, so the same file feeds most trainers unchanged.
 */

import type { Intent } from '../agents/slm-extensions/IntentClassifier.js';
import { INTENTS } from '../agents/slm-extensions/IntentClassifier.js';

// --- Inputs -----------------------------------------------------------------

export interface RawMessage {
  role?: string;
  sender?: string;
  content: string;
  ts?: number;
}

export interface Conversation {
  id: string;
  groupId?: string;
  messages: RawMessage[];
}

// --- Training examples ------------------------------------------------------

export type TrainingTask = 'summarize' | 'intent';

export interface TrainingExample {
  task: TrainingTask;
  systemPrompt: string;
  /** User-turn content (the prompt). */
  input: string;
  /** Assistant-turn content (the label / target completion). */
  output: string;
  meta: {
    sourceConversationId?: string;
    /** True when the label was produced heuristically and should be reviewed. */
    needsReview: boolean;
    /** For intent examples, the label class. */
    label?: string;
  };
}

const SUMMARY_SYSTEM =
  'You are a precise conversation summarizer. Produce a faithful, neutral one-paragraph summary. Do not invent facts.';
const INTENT_SYSTEM =
  'You are an intent classifier. Respond with ONLY a JSON object: {"intent": "<query|command|question|feedback|other>"}.';

/** Optional async teacher that maps an input to a gold label. */
export type Labeler = (input: string, task: TrainingTask) => Promise<string>;

export interface BuildOptions {
  /** Min messages a conversation needs before it yields a summarization example. Default 4. */
  minMessagesForSummary?: number;
  /** Optional teacher labeler; when omitted, heuristic labels are used. */
  labeler?: Labeler;
  /** Cap on examples per task (keeps datasets balanced). Default: no cap. */
  maxPerTask?: number;
}

// --- Heuristic labelers (deterministic, testable) ---------------------------

/**
 * Rule-based intent label. Mirrors the IntentClassifier's taxonomy using cheap
 * lexical cues — imperatives → command, interrogatives → question, lookups →
 * query, praise/complaint → feedback, else other.
 */
export function heuristicIntent(text: string): Intent {
  const t = text.trim().toLowerCase();
  if (t === '') return 'other';

  // Feedback: praise / complaint / correction about the assistant.
  if (/\b(thanks|thank you|great job|well done|helpful|love (it|this)|awful|useless|wrong|terrible|disappointed|frustrat)/.test(t)) {
    return 'feedback';
  }
  // Query: retrieval / lookup verbs.
  if (/\b(look up|search|find|fetch|get me|show me|what(?:'s| is) the (?:latest|current|status))\b/.test(t)) {
    return 'query';
  }
  // Command: imperative action verbs at/near the start.
  if (/^(please\s+)?(delete|remove|restart|run|build|deploy|schedule|send|create|update|stop|start|cancel|set|add|open|close|fix)\b/.test(t)) {
    return 'command';
  }
  // Question: interrogative.
  if (/\?\s*$/.test(text) || /^(who|what|when|where|why|how|is|are|can|do|does|should|could|would)\b/.test(t)) {
    return 'question';
  }
  return 'other';
}

/**
 * Extractive one-paragraph summary heuristic: the longest informative messages,
 * concatenated. A weak label — flagged needsReview — but a real, reproducible
 * baseline that a teacher labeler later replaces.
 */
export function heuristicSummary(messages: RawMessage[]): string {
  const contents = messages
    .map((m) => m.content.trim())
    .filter((c) => c.length > 0);
  if (contents.length === 0) return '';
  const ranked = [...contents]
    .map((c, index) => ({ c, index, len: c.length }))
    .sort((a, b) => b.len - a.len || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((e) => e.c);
  return ranked.join(' ');
}

// --- Transcript formatting --------------------------------------------------

export function formatTranscript(messages: RawMessage[]): string {
  return messages
    .map((m) => `${m.role ?? m.sender ?? 'user'}: ${m.content.trim()}`)
    .filter((l) => l.trim() !== '')
    .join('\n');
}

/** Messages worth labeling for intent: user turns with real content. */
function intentCandidates(conv: Conversation): RawMessage[] {
  return conv.messages.filter((m) => {
    const role = (m.role ?? m.sender ?? 'user').toLowerCase();
    const isAssistant = role === 'assistant' || role === 'bot' || role === 'claw';
    return !isAssistant && m.content.trim().length > 0;
  });
}

// --- Builders ---------------------------------------------------------------

export async function buildSummarizationExamples(
  conversations: Conversation[],
  opts: BuildOptions = {},
): Promise<TrainingExample[]> {
  const minMsgs = opts.minMessagesForSummary ?? 4;
  const out: TrainingExample[] = [];
  for (const conv of conversations) {
    const usable = conv.messages.filter((m) => m.content.trim() !== '');
    if (usable.length < minMsgs) continue;
    const input = formatTranscript(usable);
    let output: string;
    let needsReview: boolean;
    if (opts.labeler) {
      output = (await opts.labeler(input, 'summarize')).trim();
      needsReview = false;
    } else {
      output = heuristicSummary(usable);
      needsReview = true;
    }
    if (output === '') continue;
    out.push({
      task: 'summarize',
      systemPrompt: SUMMARY_SYSTEM,
      input,
      output,
      meta: { sourceConversationId: conv.id, needsReview },
    });
    if (opts.maxPerTask && out.length >= opts.maxPerTask) break;
  }
  return out;
}

export async function buildIntentExamples(
  conversations: Conversation[],
  opts: BuildOptions = {},
): Promise<TrainingExample[]> {
  const out: TrainingExample[] = [];
  for (const conv of conversations) {
    for (const msg of intentCandidates(conv)) {
      const input = msg.content.trim();
      let label: string;
      let needsReview: boolean;
      if (opts.labeler) {
        label = normalizeIntentLabel(await opts.labeler(input, 'intent'));
        needsReview = false;
      } else {
        label = heuristicIntent(input);
        needsReview = true;
      }
      out.push({
        task: 'intent',
        systemPrompt: INTENT_SYSTEM,
        input,
        output: JSON.stringify({ intent: label }),
        meta: { sourceConversationId: conv.id, needsReview, label },
      });
      if (opts.maxPerTask && out.length >= opts.maxPerTask) return out;
    }
  }
  return out;
}

/** Coerce a teacher's free-form intent answer into the fixed taxonomy. */
function normalizeIntentLabel(raw: string): Intent {
  const lowered = raw.toLowerCase();
  for (const intent of INTENTS) {
    if (lowered.includes(intent)) return intent;
  }
  return 'other';
}

export interface Dataset {
  summarization: TrainingExample[];
  intent: TrainingExample[];
}

/** Build both task datasets in one pass. */
export async function buildDataset(conversations: Conversation[], opts: BuildOptions = {}): Promise<Dataset> {
  const [summarization, intent] = await Promise.all([
    buildSummarizationExamples(conversations, opts),
    buildIntentExamples(conversations, opts),
  ]);
  return { summarization, intent };
}

// --- JSONL export -----------------------------------------------------------

/** One example → an OpenAI-style chat record. */
export function toChatRecord(ex: TrainingExample): { messages: Array<{ role: string; content: string }> } {
  return {
    messages: [
      { role: 'system', content: ex.systemPrompt },
      { role: 'user', content: ex.input },
      { role: 'assistant', content: ex.output },
    ],
  };
}

/** Serialize examples to JSONL (one JSON object per line, trailing newline). */
export function toJsonl(examples: TrainingExample[]): string {
  if (examples.length === 0) return '';
  return examples.map((ex) => JSON.stringify(toChatRecord(ex))).join('\n') + '\n';
}

// --- Stats ------------------------------------------------------------------

export interface DatasetStats {
  total: number;
  byTask: Record<string, number>;
  byLabel: Record<string, number>;
  needsReview: number;
}

export function datasetStats(examples: TrainingExample[]): DatasetStats {
  const byTask: Record<string, number> = {};
  const byLabel: Record<string, number> = {};
  let needsReview = 0;
  for (const ex of examples) {
    byTask[ex.task] = (byTask[ex.task] ?? 0) + 1;
    if (ex.meta.label) byLabel[ex.meta.label] = (byLabel[ex.meta.label] ?? 0) + 1;
    if (ex.meta.needsReview) needsReview++;
  }
  return { total: examples.length, byTask, byLabel, needsReview };
}
