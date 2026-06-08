import { describe, it, expect } from 'vitest';

import { parseTolerantJson, extractJsonBlock } from './tolerant-json.js';
import {
  ConversationSummarizer,
  IntentClassifier,
  SentimentAnalyzer,
  JsonExtractor,
  buildSlmExtensions,
  type InferenceFn,
} from './index.js';

/** Build a mock inference fn that returns a fixed string. */
function mockInfer(text: string, modelId = 'mock-slm'): InferenceFn {
  return async () => ({ text, modelId });
}

/** A mock that throws (simulates an unreachable / broken backend). */
const throwingInfer: InferenceFn = async () => {
  throw new Error('backend down');
};

// --- Tolerant JSON ---

describe('parseTolerantJson', () => {
  it('parses clean JSON without repair', () => {
    const r = parseTolerantJson<{ a: number }>('{"a": 1}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.a).toBe(1);
      expect(r.repaired).toBe(false);
    }
  });

  it('strips ```json fences', () => {
    const r = parseTolerantJson('```json\n{"a": 1}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repaired).toBe(true);
  });

  it('extracts JSON after a preamble', () => {
    const r = parseTolerantJson('Sure! Here is the JSON: {"intent": "query", "confidence": 0.9} hope that helps');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Record<string, unknown>).intent).toBe('query');
  });

  it('repairs trailing commas', () => {
    const r = parseTolerantJson('{"a": 1, "b": 2,}');
    expect(r.ok).toBe(true);
  });

  it('promotes single quotes when no double quotes exist', () => {
    const r = parseTolerantJson("{'a': 'hello'}");
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Record<string, unknown>).a).toBe('hello');
  });

  it('fails cleanly on non-JSON', () => {
    const r = parseTolerantJson('this is just prose with no object');
    expect(r.ok).toBe(false);
  });

  it('fails cleanly on empty input', () => {
    expect(parseTolerantJson('').ok).toBe(false);
  });

  it('extractJsonBlock respects strings containing braces', () => {
    const block = extractJsonBlock('prefix {"text": "a } b"} suffix');
    expect(block).toBe('{"text": "a } b"}');
  });
});

// --- IntentClassifier ---

describe('IntentClassifier', () => {
  it('classifies via SLM with fenced JSON (no fallback)', async () => {
    const c = new IntentClassifier({ slmInfer: mockInfer('```json\n{"intent":"command","confidence":0.8}\n```') });
    const r = await c.classify('delete the file');
    expect(r.ok).toBe(true);
    expect(r.value?.intent).toBe('command');
    expect(r.usedFallback).toBe(false);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('falls back to LLM when the SLM emits garbage', async () => {
    const c = new IntentClassifier({
      slmInfer: mockInfer('I think this is a command, definitely.'),
      llmInfer: mockInfer('{"intent":"command","confidence":0.95}', 'mock-llm'),
    });
    const r = await c.classify('delete the file');
    expect(r.ok).toBe(true);
    expect(r.value?.intent).toBe('command');
    expect(r.usedFallback).toBe(true);
    expect(r.modelId).toBe('mock-llm');
    expect(r.confidence).toBeCloseTo(0.9, 5);
  });

  it('rejects invalid intent labels', async () => {
    const c = new IntentClassifier({ slmInfer: mockInfer('{"intent":"banana","confidence":0.9}') });
    const r = await c.classify('hello');
    expect(r.ok).toBe(false);
  });

  it('returns not-ok for empty input', async () => {
    const c = new IntentClassifier({ slmInfer: mockInfer('{}') });
    const r = await c.classify('   ');
    expect(r.ok).toBe(false);
  });

  it('survives a throwing backend by falling back', async () => {
    const c = new IntentClassifier({
      slmInfer: throwingInfer,
      llmInfer: mockInfer('{"intent":"question","confidence":0.7}'),
    });
    const r = await c.classify('why is the sky blue?');
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
  });
});

// --- SentimentAnalyzer ---

describe('SentimentAnalyzer', () => {
  it('parses and clamps score, derives label from score', async () => {
    const a = new SentimentAnalyzer({ slmInfer: mockInfer('{"score": 1.5}') });
    const r = await a.analyze('I absolutely love this!');
    expect(r.ok).toBe(true);
    expect(r.value?.score).toBe(1); // clamped from 1.5
    expect(r.value?.label).toBe('positive');
  });

  it('handles negative sentiment', async () => {
    const a = new SentimentAnalyzer({ slmInfer: mockInfer('{"score": -0.8, "label": "negative"}') });
    const r = await a.analyze('this is terrible');
    expect(r.value?.label).toBe('negative');
  });

  it('rejects output with no score', async () => {
    const a = new SentimentAnalyzer({ slmInfer: mockInfer('{"label":"positive"}') });
    const r = await a.analyze('meh');
    expect(r.ok).toBe(false);
  });
});

// --- JsonExtractor ---

describe('JsonExtractor', () => {
  const schema = {
    name: { type: 'string' as const, required: true },
    age: { type: 'number' as const, required: false },
  };

  it('extracts and validates against schema', async () => {
    const e = new JsonExtractor({ slmInfer: mockInfer('{"name":"Ada","age":36}') });
    const r = await e.extract('Ada Lovelace, age 36', schema);
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('Ada');
    expect(r.value?.age).toBe(36);
  });

  it('falls back when a required field is missing', async () => {
    const e = new JsonExtractor({
      slmInfer: mockInfer('{"age": 36}'),
      llmInfer: mockInfer('{"name":"Ada","age":36}', 'mock-llm'),
    });
    const r = await e.extract('Ada, 36', schema);
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
    expect(r.value?.name).toBe('Ada');
  });

  it('rejects type mismatches', async () => {
    const e = new JsonExtractor({ slmInfer: mockInfer('{"name": 123}') });
    const r = await e.extract('garbage', schema);
    expect(r.ok).toBe(false);
  });

  it('drops hallucinated extra keys', async () => {
    const e = new JsonExtractor({ slmInfer: mockInfer('{"name":"Ada","age":36,"ssn":"secret"}') });
    const r = await e.extract('Ada, 36', schema);
    expect(r.ok).toBe(true);
    expect(r.value).toBeTruthy();
    expect(Object.keys(r.value as object).sort()).toEqual(['age', 'name']);
  });

  it('returns not-ok for empty schema', async () => {
    const e = new JsonExtractor({ slmInfer: mockInfer('{}') });
    const r = await e.extract('text', {});
    expect(r.ok).toBe(false);
  });
});

// --- ConversationSummarizer ---

describe('ConversationSummarizer', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${i} about the quarterly budget planning`,
  }));

  it('summarizes a multi-message conversation', async () => {
    const s = new ConversationSummarizer({
      slmInfer: mockInfer('The team discussed quarterly budget planning across several messages and agreed to revisit allocations.'),
    });
    const r = await s.summarize(messages);
    expect(r.ok).toBe(true);
    expect(r.value?.messageCount).toBe(20);
    expect(r.value?.summary).toContain('budget');
    expect(r.usedFallback).toBe(false);
  });

  it('falls back when SLM returns an empty summary', async () => {
    const s = new ConversationSummarizer({
      slmInfer: mockInfer(''),
      llmInfer: mockInfer('A concise summary of the budget conversation produced by the larger model.', 'mock-llm'),
    });
    const r = await s.summarize(messages);
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
    expect(r.modelId).toBe('mock-llm');
  });

  it('rejects empty message lists', async () => {
    const s = new ConversationSummarizer({ slmInfer: mockInfer('x') });
    const r = await s.summarize([]);
    expect(r.ok).toBe(false);
  });

  it('accepts plain-string messages', async () => {
    const s = new ConversationSummarizer({ slmInfer: mockInfer('Short faithful summary of the two-line chat.') });
    const r = await s.summarize(['hello there', 'how are you doing today']);
    expect(r.ok).toBe(true);
  });
});

// --- Bundle factory ---

describe('buildSlmExtensions', () => {
  it('wires all four extensions with shared deps', async () => {
    const bundle = buildSlmExtensions(mockInfer('{"intent":"query","confidence":0.9}'));
    expect(bundle.summarizer).toBeInstanceOf(ConversationSummarizer);
    expect(bundle.intent).toBeInstanceOf(IntentClassifier);
    expect(bundle.sentiment).toBeInstanceOf(SentimentAnalyzer);
    expect(bundle.json).toBeInstanceOf(JsonExtractor);

    const r = await bundle.intent.classify('look up the weather');
    expect(r.value?.intent).toBe('query');
  });
});
