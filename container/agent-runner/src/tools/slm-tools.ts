/**
 * SLM (Small Language Model) MCP tools.
 *
 * Exposes $0 local-inference primitives to the container agent:
 *   - slm_summarize: compress a conversation / long text into a short summary
 *   - slm_classify:  intent or sentiment classification
 *   - slm_extract:   pull structured JSON from unstructured text against a schema
 *
 * The model runs on the HOST (where the GGUF / llama.cpp lives), so every tool
 * routes through IPC: it writes a request to the messages dir with an embedded
 * responseFile, then polls for the host's reply. The host handler
 * (src/ipc.ts → handleSlm*) runs the SLM agent extensions and writes back.
 *
 * Enable by adding `tools/slm-tools` to NANOCLAW_TOOL_MODULES (host gates this
 * behind NANOCLAW_SLM_TOOLS — see src/container-runner.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface SlmToolsContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

const RESPONSE_TIMEOUT_MS = 30_000;

function asText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

export function registerTools(server: McpServer, ctx: SlmToolsContext): void {
  /** Shared IPC round-trip helper. */
  async function roundTrip(type: string, fields: Record<string, unknown>) {
    const responseFile = `/workspace/ipc/messages/${type}-${Date.now()}.response.json`;
    ctx.writeIpcFile(ctx.MESSAGES_DIR, {
      type,
      ...fields,
      chatJid: ctx.chatJid,
      groupFolder: ctx.groupFolder,
      responseFile,
    });
    const response = await ctx.pollResponse(responseFile, RESPONSE_TIMEOUT_MS);
    if (!response) return asText({ error: `${type} timed out — is the local SLM backend (llama.cpp) running on the host?` });
    return asText(response);
  }

  server.tool(
    'slm_summarize',
    `Summarize a conversation or long text using a local small language model ($0, no API cost).
Best for compressing chat history or documents into a few paragraphs. Falls back to a larger
model on the host automatically if the small model's output is unusable.`,
    {
      messages: z
        .array(z.string())
        .min(1)
        .describe('Lines/messages to summarize, in order (e.g. ["alice: ...", "bob: ..."]).'),
      paragraphs: z.number().int().min(1).max(10).default(3).describe('Target summary length in paragraphs'),
      focus: z.string().optional().describe('Optional focus, e.g. "decisions and action items"'),
    },
    async (args) =>
      roundTrip('slm_summarize', {
        messages: args.messages,
        paragraphs: args.paragraphs ?? 3,
        focus: args.focus,
      }),
  );

  server.tool(
    'slm_classify',
    `Classify text with a local small language model ($0). Supports two kinds:
- kind="intent":    labels as query | command | question | feedback | other
- kind="sentiment": score from -1 (negative) to +1 (positive) with a label
Returns the label plus a confidence score. Falls back to a larger model on parse failure.`,
    {
      text: z.string().min(1).describe('The text to classify'),
      kind: z.enum(['intent', 'sentiment']).default('intent').describe('Classification type'),
    },
    async (args) =>
      roundTrip('slm_classify', {
        text: args.text,
        kind: args.kind ?? 'intent',
      }),
  );

  server.tool(
    'slm_extract',
    `Extract structured JSON from unstructured text using a local small language model ($0).
Provide a schema mapping field names to types. Missing required fields trigger an automatic
fallback to a larger model. Output is validated and projected to exactly the schema keys.`,
    {
      text: z.string().min(1).describe('Unstructured source text'),
      schema: z
        .record(
          z.string(),
          z.object({
            type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
            required: z.boolean().optional(),
            description: z.string().optional(),
          }),
        )
        .describe('Field name → {type, required?, description?}'),
    },
    async (args) =>
      roundTrip('slm_extract', {
        text: args.text,
        schema: args.schema,
      }),
  );
}
