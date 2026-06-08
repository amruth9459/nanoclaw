import { describe, it, expect } from 'vitest';

import {
  heuristicIntent,
  heuristicSummary,
  formatTranscript,
  buildIntentExamples,
  buildSummarizationExamples,
  buildDataset,
  toJsonl,
  toChatRecord,
  datasetStats,
  type Conversation,
} from './slm-training-data.js';

const conversations: Conversation[] = [
  {
    id: 'c1',
    messages: [
      { role: 'user', content: 'look up the latest sales numbers' },
      { role: 'assistant', content: 'Here are the numbers...' },
      { role: 'user', content: 'delete the old report' },
      { role: 'user', content: 'thanks, that was helpful' },
      { role: 'user', content: 'why did revenue drop?' },
    ],
  },
  {
    id: 'c2',
    messages: [
      { role: 'user', content: 'we should plan the offsite' },
      { role: 'assistant', content: 'Sure, when?' },
    ],
  },
];

describe('heuristicIntent', () => {
  it('labels lookups as query', () => {
    expect(heuristicIntent('look up the weather')).toBe('query');
    expect(heuristicIntent('find the report')).toBe('query');
  });
  it('labels imperatives as command', () => {
    expect(heuristicIntent('delete the file')).toBe('command');
    expect(heuristicIntent('please restart the server')).toBe('command');
  });
  it('labels interrogatives as question', () => {
    expect(heuristicIntent('why is the sky blue?')).toBe('question');
    expect(heuristicIntent('how does this work')).toBe('question');
  });
  it('labels praise/complaint as feedback', () => {
    expect(heuristicIntent('thanks, that was helpful')).toBe('feedback');
    expect(heuristicIntent('this is useless and wrong')).toBe('feedback');
  });
  it('falls back to other', () => {
    expect(heuristicIntent('blue umbrella tuesday')).toBe('other');
    expect(heuristicIntent('')).toBe('other');
  });
});

describe('heuristicSummary', () => {
  it('produces a non-empty extractive summary from the longest messages', () => {
    const s = heuristicSummary(conversations[0].messages);
    expect(s.length).toBeGreaterThan(0);
  });
  it('returns empty for empty input', () => {
    expect(heuristicSummary([])).toBe('');
  });
});

describe('formatTranscript', () => {
  it('renders role: content lines', () => {
    const t = formatTranscript([
      { role: 'user', content: 'hi' },
      { sender: 'bob', content: 'hello' },
    ]);
    expect(t).toBe('user: hi\nbob: hello');
  });
});

describe('buildIntentExamples (heuristic)', () => {
  it('labels each user message, skipping assistant turns, and flags needsReview', async () => {
    const ex = await buildIntentExamples(conversations);
    // 4 user msgs in c1 + 1 in c2 = 5 (assistant turns excluded)
    expect(ex.length).toBe(5);
    expect(ex.every((e) => e.task === 'intent')).toBe(true);
    expect(ex.every((e) => e.meta.needsReview)).toBe(true);
    const labels = ex.map((e) => JSON.parse(e.output).intent);
    expect(labels).toContain('query');
    expect(labels).toContain('command');
    expect(labels).toContain('feedback');
    expect(labels).toContain('question');
  });

  it('uses a teacher labeler when provided (no needsReview)', async () => {
    const ex = await buildIntentExamples(conversations, {
      labeler: async () => 'the intent is command',
      maxPerTask: 2,
    });
    expect(ex.length).toBe(2);
    expect(ex.every((e) => !e.meta.needsReview)).toBe(true);
    expect(JSON.parse(ex[0].output).intent).toBe('command'); // normalized from free text
  });
});

describe('buildSummarizationExamples (heuristic)', () => {
  it('only emits examples for conversations above the message threshold', async () => {
    const ex = await buildSummarizationExamples(conversations, { minMessagesForSummary: 4 });
    // c1 has 5 messages (≥4), c2 has 2 (<4) → only c1.
    expect(ex.length).toBe(1);
    expect(ex[0].meta.sourceConversationId).toBe('c1');
    expect(ex[0].meta.needsReview).toBe(true);
  });
});

describe('buildDataset + JSONL export', () => {
  it('builds both task datasets', async () => {
    const ds = await buildDataset(conversations);
    expect(ds.intent.length).toBeGreaterThan(0);
    expect(ds.summarization.length).toBeGreaterThan(0);
  });

  it('toChatRecord yields a 3-message chat record', () => {
    const rec = toChatRecord({
      task: 'intent',
      systemPrompt: 'sys',
      input: 'delete it',
      output: '{"intent":"command"}',
      meta: { needsReview: true },
    });
    expect(rec.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(rec.messages[2].content).toBe('{"intent":"command"}');
  });

  it('toJsonl produces one valid JSON object per line', async () => {
    const ex = await buildIntentExamples(conversations);
    const jsonl = toJsonl(ex);
    const lines = jsonl.trim().split('\n');
    expect(lines.length).toBe(ex.length);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(parsed.messages).toHaveLength(3);
    }
  });

  it('toJsonl returns empty string for no examples', () => {
    expect(toJsonl([])).toBe('');
  });
});

describe('datasetStats', () => {
  it('counts totals, tasks, labels and review flags', async () => {
    const ex = await buildIntentExamples(conversations);
    const stats = datasetStats(ex);
    expect(stats.total).toBe(ex.length);
    expect(stats.byTask.intent).toBe(ex.length);
    expect(stats.needsReview).toBe(ex.length); // all heuristic
    expect(Object.keys(stats.byLabel).length).toBeGreaterThan(0);
  });
});
