import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// vi.hoisted block runs before vi.mock hoisting — safe to use in factories
const tmpDir = vi.hoisted(() => {
  const dir = `/tmp/nanoclaw-rag-test-${Date.now()}`;
  // Use Node built-ins only (no import bindings)
  require('fs').mkdirSync(dir, { recursive: true });
  return dir;
});

const mockGenerateContent = vi.hoisted(() => vi.fn());

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('./config.js', () => ({
  STORE_DIR: tmpDir,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: () => ({ GOOGLE_API_KEY: 'test-key' }),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    constructor(_apiKey: string) {}
    getGenerativeModel() {
      return {
        generateContent: mockGenerateContent,
        embedContent: vi.fn(),
      };
    }
  },
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT', RETRIEVAL_QUERY: 'RETRIEVAL_QUERY' },
}));

vi.mock('./semantic-index.js', () => ({
  semanticSearch: vi.fn().mockResolvedValue([]),
  embedText: vi.fn(),
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT' },
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  addTurn,
  getHistory,
  clearHistory,
  enforceWindow,
  pruneOldThreads,
  formatHistory,
} from './conversation-history.js';

import { contextualizeQuery, generateAnswer, ragQuery } from './rag-chain.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanDb() {
  const dbPath = path.join(tmpDir, 'messages.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ok */ }
  }
}

// ── Conversation History Tests ──────────────────────────────────────────────

describe('ConversationHistory', () => {
  beforeEach(cleanDb);

  it('adds and retrieves conversation turns', () => {
    addTurn('thread-1', 'user', 'What is NanoClaw?');
    addTurn('thread-1', 'assistant', 'NanoClaw is a personal Claude assistant.');

    const history = getHistory('thread-1');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What is NanoClaw?');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('NanoClaw is a personal Claude assistant.');
  });

  it('returns empty array for unknown thread', () => {
    const history = getHistory('nonexistent-thread');
    expect(history).toHaveLength(0);
  });

  it('respects maxTurns limit', () => {
    for (let i = 0; i < 20; i++) {
      addTurn('thread-2', i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`);
    }

    const history = getHistory('thread-2', 5);
    expect(history).toHaveLength(5);
    expect(history[0].content).toBe('Message 15');
    expect(history[4].content).toBe('Message 19');
  });

  it('isolates threads', () => {
    addTurn('thread-a', 'user', 'Hello from A');
    addTurn('thread-b', 'user', 'Hello from B');
    addTurn('thread-a', 'assistant', 'Reply to A');

    const historyA = getHistory('thread-a');
    const historyB = getHistory('thread-b');

    expect(historyA).toHaveLength(2);
    expect(historyB).toHaveLength(1);
    expect(historyA[0].content).toBe('Hello from A');
    expect(historyB[0].content).toBe('Hello from B');
  });

  it('clears history for a thread', () => {
    addTurn('thread-c', 'user', 'Message 1');
    addTurn('thread-c', 'assistant', 'Reply 1');

    const deleted = clearHistory('thread-c');
    expect(deleted).toBe(2);
    expect(getHistory('thread-c')).toHaveLength(0);
  });

  it('enforces sliding window', () => {
    for (let i = 0; i < 15; i++) {
      addTurn('thread-d', 'user', `Msg ${i}`);
    }

    const pruned = enforceWindow('thread-d', 5);
    expect(pruned).toBe(10);

    const history = getHistory('thread-d');
    expect(history).toHaveLength(5);
    expect(history[0].content).toBe('Msg 10');
  });

  it('prunes old threads', () => {
    addTurn('old-thread', 'user', 'Ancient message');

    const dbPath = path.join(tmpDir, 'messages.db');
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE conversation_history SET timestamp = '2020-01-01T00:00:00Z' WHERE thread_id = 'old-thread'",
    ).run();
    db.close();

    addTurn('new-thread', 'user', 'Recent message');

    const result = pruneOldThreads(1000);
    expect(result.deleted).toBeGreaterThan(0);
    expect(getHistory('old-thread')).toHaveLength(0);
    expect(getHistory('new-thread')).toHaveLength(1);
  });

  it('formats history correctly', () => {
    const turns = [
      { id: 1, threadId: 't', role: 'user' as const, content: 'Hello', timestamp: '' },
      { id: 2, threadId: 't', role: 'assistant' as const, content: 'Hi!', timestamp: '' },
    ];
    expect(formatHistory(turns)).toBe('Human: Hello\nAssistant: Hi!');
  });
});

// ── RAG Chain Tests ──────────────────────────────────────────────────────────

describe('RAG Chain', () => {
  beforeEach(() => {
    cleanDb();
    mockGenerateContent.mockReset();
  });

  it('contextualizeQuery returns original query when no history', async () => {
    const result = await contextualizeQuery('What is this?', []);
    expect(result).toBe('What is this?');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('contextualizeQuery reformulates with history', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'What are the door specifications in the floor plan?' },
    });

    const history = [
      { id: 1, threadId: 't', role: 'user' as const, content: 'Show me the floor plan', timestamp: '' },
      { id: 2, threadId: 't', role: 'assistant' as const, content: 'Here is the floor plan.', timestamp: '' },
    ];

    const result = await contextualizeQuery('What about the doors?', history);
    expect(result).toBe('What are the door specifications in the floor plan?');
    expect(mockGenerateContent).toHaveBeenCalledOnce();
  });

  it('contextualizeQuery falls back to original on error', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('API error'));

    const history = [
      { id: 1, threadId: 't', role: 'user' as const, content: 'Hello', timestamp: '' },
    ];

    const result = await contextualizeQuery('What about that?', history);
    expect(result).toBe('What about that?');
  });

  it('generateAnswer returns no-results message for empty chunks', async () => {
    const result = await generateAnswer('test query', [], []);
    expect(result).toBe('No relevant documents found to answer this question.');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('generateAnswer calls Gemini with context', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'The door is 3 feet wide. [Source: floor-plan.json]' },
    });

    const chunks = [
      { source: 'floor-plan.json', groupFolder: 'main', chunkIndex: 0, content: 'Door width: 3 feet', distance: 0.1 },
    ];

    const result = await generateAnswer('How wide is the door?', chunks, []);
    expect(result).toContain('3 feet');
    expect(mockGenerateContent).toHaveBeenCalledOnce();
  });

  it('ragQuery works without threadId', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'Answer based on context.' },
    });

    const result = await ragQuery('test question');
    expect(result.answer).toBeDefined();
    expect(result.sources).toEqual([]);
    expect(result.contextualizedQuery).toBeUndefined();
  });

  it('ragQuery saves history when threadId provided', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'The answer is 42.' },
    });

    await ragQuery('What is the answer?', 'test-thread');

    const history = getHistory('test-thread');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What is the answer?');
    expect(history[1].role).toBe('assistant');
  });
});
