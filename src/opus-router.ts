/**
 * Local Router
 * Uses a local Ollama model (qwen2.5-coder) to analyze incoming tasks
 * and route them to the right model (local via Ollama or cloud via container agent).
 * Zero cost — no API calls needed for routing decisions.
 */

import { logger } from './logger.js';
import { MLXBackendFactory } from './router/index.js';

export type RouteTarget =
  | { type: 'local'; model: string; reasoning: string }
  | { type: 'cloud'; reasoning: string };

export interface RoutingResult {
  target: RouteTarget;
  latencyMs: number;
}

const ROUTING_PROMPT = `You are a task router. Analyze the user message and decide which model should handle it.

Available local models (free, fast, on-device via Ollama):
- qwen2.5-coder: Best for code generation, scaffolding, quick edits, boilerplate, tests
- deepseek-coder-v2: Best for debugging, refactoring, code review, error analysis
- llama3: Best for general reasoning, conversation, explanations, summaries

Cloud model (Claude in container — powerful but costs money):
- Use for: complex multi-step tasks, long context, multi-file refactors, tool use (file editing, web search, running commands), tasks requiring high accuracy, anything that needs to read/write files or use the shell

ROUTING RULES:
- Simple questions, greetings, short conversations → local (llama3)
- Code generation, boilerplate, tests, simple scripts → local (qwen2.5-coder)
- Debugging help, error analysis, code review → local (deepseek-coder-v2)
- Tasks needing file access, shell commands, web search, multi-step work → cloud
- Tasks requiring high accuracy, complex reasoning, long context → cloud
- When in doubt → cloud (better to over-deliver than under-deliver)

Respond with ONLY valid JSON, no markdown:
{"type": "local", "model": "qwen2.5-coder", "reasoning": "simple code question"}
or
{"type": "cloud", "reasoning": "needs file access and multi-step work"}`;

/**
 * Use local Ollama model to analyze a message and decide the routing.
 * Falls back to cloud if Ollama is unavailable or returns bad output.
 */
export async function routeWithOpus(userMessage: string): Promise<RoutingResult> {
  const start = Date.now();

  try {
    const ollama = MLXBackendFactory.create();

    // Check if Ollama is reachable
    const available = await ollama.isAvailable();
    if (!available) {
      logger.warn('[Router] Ollama not available, defaulting to cloud');
      return { target: { type: 'cloud', reasoning: 'Ollama unavailable' }, latencyMs: Date.now() - start };
    }

    const response = await ollama.inference({
      modelId: 'qwen2.5-coder',
      systemPrompt: ROUTING_PROMPT,
      prompt: userMessage,
      maxTokens: 150,
      temperature: 0.1,
    });

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      logger.warn({ text: response.text }, '[Router] Non-JSON response, defaulting to cloud');
      return { target: { type: 'cloud', reasoning: 'Router returned non-JSON' }, latencyMs: Date.now() - start };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { type: string; model?: string; reasoning: string };
    const latencyMs = Date.now() - start;

    if (parsed.type === 'local' && parsed.model) {
      logger.info({ model: parsed.model, reasoning: parsed.reasoning, latencyMs }, '[Router] → local');
      return { target: { type: 'local', model: parsed.model, reasoning: parsed.reasoning }, latencyMs };
    }

    logger.info({ reasoning: parsed.reasoning, latencyMs }, '[Router] → cloud');
    return { target: { type: 'cloud', reasoning: parsed.reasoning }, latencyMs };
  } catch (err) {
    logger.error({ err }, '[Router] Routing failed, defaulting to cloud');
    return { target: { type: 'cloud', reasoning: 'Routing error' }, latencyMs: Date.now() - start };
  }
}

/**
 * Execute a prompt against a local Ollama model.
 * Returns the model's response text.
 */
export async function executeLocal(model: string, userMessage: string): Promise<{
  text: string;
  latencyMs: number;
  tokensGenerated: number;
}> {
  const ollama = MLXBackendFactory.create();

  const response = await ollama.inference({
    modelId: model,
    prompt: userMessage,
    maxTokens: 2048,
    temperature: 0.7,
  });

  return {
    text: response.text,
    latencyMs: response.latencyMs,
    tokensGenerated: response.tokensGenerated,
  };
}
