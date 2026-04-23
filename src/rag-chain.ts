/**
 * RAG (Retrieval-Augmented Generation) query chain.
 *
 * Two-stage process:
 * 1. Contextualize the user's query using chat history (Gemini Flash)
 * 2. Retrieve relevant chunks via semantic search, then generate an
 *    answer with source citations (Gemini Flash)
 *
 * Uses NanoClaw's existing Gemini + sqlite-vec infrastructure.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { semanticSearch, SearchResult } from './semantic-index.js';
import {
  addTurn,
  enforceWindow,
  formatHistory,
  getHistory,
  ConversationTurn,
} from './conversation-history.js';

// ── Gemini client ────────────────────────────────────────────────────────────

let _genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (_genAI) return _genAI;
  const apiKey = readEnvFile(['GOOGLE_API_KEY']).GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY required for RAG chain');
  _genAI = new GoogleGenerativeAI(apiKey);
  return _genAI;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const CONTEXTUALIZE_PROMPT = `Given the following conversation history and a follow-up question, reformulate the question as a standalone question that can be understood without the conversation history. If the question is already standalone, return it unchanged. Return ONLY the reformulated question, nothing else.`;

const ANSWER_PROMPT = `You are a helpful assistant that answers questions using ONLY the provided context. Follow these rules strictly:
- Answer based solely on the context provided below
- If the context doesn't contain enough information to answer, say so clearly
- Cite your sources using [Source: filename] format after relevant statements
- Keep answers concise and factual
- Do not make up information not present in the context`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface RagSource {
  source: string;
  content: string;
  distance: number;
}

export interface RagResult {
  answer: string;
  sources: RagSource[];
  contextualizedQuery?: string;
}

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Contextualize a query using conversation history.
 * If no history exists, returns the query unchanged.
 */
export async function contextualizeQuery(
  query: string,
  history: ConversationTurn[],
): Promise<string> {
  if (history.length === 0) return query;

  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const historyText = formatHistory(history);
  const prompt = `${CONTEXTUALIZE_PROMPT}\n\nConversation history:\n${historyText}\n\nFollow-up question: ${query}\n\nStandalone question:`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text()?.trim();
    if (text) return text;
  } catch (err) {
    logger.warn({ err }, 'Query contextualization failed, using original query');
  }

  return query;
}

/**
 * Generate an answer from retrieved context chunks.
 */
export async function generateAnswer(
  query: string,
  chunks: SearchResult[],
  history: ConversationTurn[],
): Promise<string> {
  if (chunks.length === 0) {
    return 'No relevant documents found to answer this question.';
  }

  const genAI = getGenAI();
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: ANSWER_PROMPT,
  });

  const contextText = chunks
    .map((c, i) => `[${i + 1}] Source: ${c.source}\n${c.content}`)
    .join('\n\n---\n\n');

  const historyText = history.length > 0
    ? `\nConversation history:\n${formatHistory(history)}\n`
    : '';

  const prompt = `${historyText}\nContext:\n${contextText}\n\nQuestion: ${query}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text()?.trim();
    if (text) return text;
  } catch (err) {
    logger.warn({ err, query }, 'Answer generation failed');
  }

  return 'Failed to generate an answer. Please try again.';
}

/**
 * Full RAG query pipeline:
 * 1. Load conversation history (if threadId provided)
 * 2. Contextualize the query with history
 * 3. Semantic search for relevant chunks
 * 4. Generate answer with citations
 * 5. Save the turn to conversation history
 */
export async function ragQuery(
  query: string,
  threadId?: string,
  topK = 5,
  groupFolder?: string,
): Promise<RagResult> {
  const startTime = Date.now();

  // 1. Get conversation history
  const history = threadId ? getHistory(threadId) : [];

  // 2. Contextualize the query
  const contextualizedQuery = await contextualizeQuery(query, history);
  const queryChanged = contextualizedQuery !== query;

  // 3. Semantic search with contextualized query
  let searchResults: SearchResult[];
  try {
    searchResults = await semanticSearch(contextualizedQuery, topK, groupFolder);
  } catch (err) {
    logger.warn({ err, query: contextualizedQuery }, 'RAG semantic search failed');
    searchResults = [];
  }

  // 4. Generate answer
  const answer = await generateAnswer(contextualizedQuery, searchResults, history);

  // 5. Update conversation history
  if (threadId) {
    addTurn(threadId, 'user', query);
    addTurn(threadId, 'assistant', answer);
    enforceWindow(threadId, 10);
  }

  const sources: RagSource[] = searchResults.map(r => ({
    source: r.source,
    content: r.content,
    distance: r.distance,
  }));

  logger.info({
    query: query.slice(0, 100),
    threadId,
    contextChanged: queryChanged,
    chunksFound: searchResults.length,
    durationMs: Date.now() - startTime,
  }, 'RAG query completed');

  return {
    answer,
    sources,
    contextualizedQuery: queryChanged ? contextualizedQuery : undefined,
  };
}
