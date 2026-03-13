/**
 * Host-side Fallback
 * When the container agent fails (Claude outage, rate limit, etc.),
 * generate a basic response using an alternative model directly from the host.
 *
 * Fallback chain: Google Gemini → OpenAI GPT-4o → error message
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface FallbackResult {
  text: string;
  model: string;
  latencyMs: number;
}

/**
 * Detect whether an error is worth attempting a fallback for.
 * OAuth errors are handled separately (token refresh). This is for API outages,
 * rate limits, and other transient failures.
 */
export function isFallbackWorthy(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();

  // API outage / rate limit / overloaded signals
  if (/429|rate.?limit|overloaded|529|503|502|500|capacity|quota/.test(lower)) return true;
  // Connection failures
  if (/econnrefused|econnreset|etimedout|fetch failed|network|dns/.test(lower)) return true;
  // Claude-specific outage signals
  if (/anthropic.*error|api.*unavailable|service.*unavailable/.test(lower)) return true;
  // Container timeout (agent took too long, likely stuck)
  if (/timeout|timed out/.test(lower)) return true;
  // Generic server errors
  if (/internal server error|bad gateway|service unavailable/.test(lower)) return true;

  return false;
}

/**
 * Extract the last user message from a formatted prompt.
 * The prompt format from formatMessages() looks like:
 *   [timestamp] sender: message content
 * We want the last user message content.
 */
function extractUserMessage(prompt: string): string {
  // Try to get the last message line
  const lines = prompt.trim().split('\n');

  // Walk backwards to find the last actual message (skip empty lines, system tags)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Skip system tags and metadata
    if (line.startsWith('[system:') || line.startsWith('BOUNTY_HUNTER_TASK')) continue;

    // Match "[timestamp] sender: content" or just return the line
    const match = line.match(/^\[.*?\]\s*[^:]+:\s*(.+)$/);
    if (match) return match[1];
    return line;
  }

  return prompt.slice(0, 500); // Fallback: use first 500 chars
}

/**
 * Try Google Gemini as fallback.
 */
async function tryGemini(userMessage: string, systemPrompt: string): Promise<FallbackResult | null> {
  const apiKey = readEnvFile(['GOOGLE_API_KEY']).GOOGLE_API_KEY;
  if (!apiKey) {
    logger.debug('No GOOGLE_API_KEY — skipping Gemini fallback');
    return null;
  }

  const start = Date.now();
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent(userMessage);
    const text = result.response.text();

    if (!text) return null;

    return {
      text,
      model: 'gemini-2.0-flash',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    logger.warn({ err }, 'Gemini fallback failed');
    return null;
  }
}

/**
 * Try OpenAI as fallback (raw fetch, no SDK needed).
 */
async function tryOpenAI(userMessage: string, systemPrompt: string): Promise<FallbackResult | null> {
  const apiKey = readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  if (!apiKey) {
    logger.debug('No OPENAI_API_KEY — skipping OpenAI fallback');
    return null;
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 2048,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'OpenAI fallback returned error');
      return null;
    }

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return null;

    return {
      text,
      model: 'gpt-4o-mini',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    logger.warn({ err }, 'OpenAI fallback failed');
    return null;
  }
}

/**
 * Generate a fallback response when the primary container agent fails.
 * Tries Gemini first, then OpenAI. Returns null if all fallbacks fail.
 */
export async function generateFallbackResponse(
  prompt: string,
  groupName: string,
): Promise<FallbackResult | null> {
  const userMessage = extractUserMessage(prompt);

  const systemPrompt =
    `You are Claw, a helpful AI assistant on WhatsApp. ` +
    `Your primary model (Claude) is temporarily unavailable, so you're running on a backup model. ` +
    `Keep responses concise and helpful. If the question requires tools, file access, or complex tasks, ` +
    `let the user know you're running in fallback mode with limited capabilities and suggest they try again shortly. ` +
    `Group: ${groupName}`;

  logger.info({ group: groupName }, 'Attempting host-side fallback response');

  // Try Gemini first (cheapest, fastest)
  const geminiResult = await tryGemini(userMessage, systemPrompt);
  if (geminiResult) {
    logger.info(
      { model: geminiResult.model, latencyMs: geminiResult.latencyMs },
      'Fallback succeeded via Gemini',
    );
    return geminiResult;
  }

  // Try OpenAI
  const openaiResult = await tryOpenAI(userMessage, systemPrompt);
  if (openaiResult) {
    logger.info(
      { model: openaiResult.model, latencyMs: openaiResult.latencyMs },
      'Fallback succeeded via OpenAI',
    );
    return openaiResult;
  }

  logger.error('All fallback models failed — no response generated');
  return null;
}
