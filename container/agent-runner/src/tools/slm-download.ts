/**
 * SLM model download-planning MCP tool.
 *
 * Exposes a single HITL-gated primitive to the container agent:
 *   - slm_download_plan: inspect whether a local SLM model's GGUF is present and
 *     produce an *approval plan* for downloading it. This tool NEVER downloads.
 *
 * Why planning-only: GGUF weights are large and downloading them is an
 * outward-facing, hard-to-reverse action. Per the experiment's critical rule —
 * "NO actual model downloads without HITL approval" — the agent can only ask the
 * host what a download would entail. The host handler (src/ipc.ts →
 * slm_download_plan) calls LlamaCppBackend.planDownload, which blocks GPL-licensed
 * models and any model without a verified URL, and returns the size/license so a
 * human can approve out-of-band. No bytes are fetched here.
 *
 * Enable by adding `tools/slm-download` to NANOCLAW_TOOL_MODULES (host gates this
 * behind NANOCLAW_SLM_TOOLS — see src/container-runner.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface SlmDownloadToolsContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

const RESPONSE_TIMEOUT_MS = 30_000;

function asText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

export function registerTools(server: McpServer, ctx: SlmDownloadToolsContext): void {
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
    if (!response) return asText({ error: `${type} timed out — is the host SLM runtime available?` });
    return asText(response);
  }

  server.tool(
    'slm_download_plan',
    `Plan (do NOT execute) a local SLM model download. Returns whether the model's
GGUF file is already present on the host, its approximate size and license, and
any reason it is blocked (GPL license, or no verified download URL configured).

This tool never downloads anything — it only produces an approval plan. Actual
downloads are gated behind explicit human approval and happen out-of-band. Use
this to check, before relying on a local SLM, whether its weights need fetching.

Common model ids: "qwen2.5-0.5b", "tiny-aya-3.35b", or a configured specialist
id like "slm-intent" / "slm-summarize".`,
    {
      modelId: z
        .string()
        .min(1)
        .describe('Model id to plan a download for (e.g. "qwen2.5-0.5b", "slm-summarize")'),
    },
    async (args) => roundTrip('slm_download_plan', { modelId: args.modelId }),
  );
}
