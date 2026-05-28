/**
 * Cloudflare MCP tools — registered for groups owned by the cloudflare integration
 * (plus the main group). Uses the Cloudflare REST API directly via fetch.
 *
 * Tools:
 *   cloudflare_whoami         — verify API token, return account & permissions
 *   cloudflare_check_domain   — check availability / transfer eligibility
 *   cloudflare_register_domain — HITL-gated registration request (proposes via IPC)
 *   cloudflare_list_zones     — list zones (domains) under the account
 *   cloudflare_add_zone       — add a new zone for a domain you already own
 *   cloudflare_add_dns_record — create A / AAAA / CNAME / TXT records
 *   cloudflare_deploy_pages   — create / upload a Pages project deployment
 *   cloudflare_deploy_worker  — upload a Worker script
 *   cloudflare_setup_tunnel   — create a named cloudflared tunnel
 *
 * Limitations (documented at runtime via cloudflare_whoami):
 *   - Account creation is NOT available via the public Cloudflare API. The user
 *     must sign up at dash.cloudflare.com once. After that, the API token is
 *     scoped per account and all other tools work programmatically.
 *   - New domain registration via the Registrar API is currently only available
 *     for accounts already onboarded with billing. We surface availability +
 *     pricing and gate the actual PUT through the HITL approval flow on the host.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface CloudflareToolsContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

function getApiToken(): string | null {
  return process.env.CLOUDFLARE_API_TOKEN || null;
}

function getAccountId(): string | null {
  return process.env.CLOUDFLARE_ACCOUNT_ID || null;
}

interface CfResult<T = unknown> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: unknown[];
  result?: T;
  result_info?: unknown;
}

async function cfFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<CfResult<T> | { error: string }> {
  const token = getApiToken();
  if (!token) {
    return { error: 'CLOUDFLARE_API_TOKEN not configured on host (.env).' };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  try {
    const resp = await fetch(`${CF_API_BASE}${path}`, { ...init, headers });
    const text = await resp.text();
    let json: CfResult<T>;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `Non-JSON response from Cloudflare (${resp.status}): ${text.slice(0, 200)}` };
    }
    return json;
  } catch (err) {
    return { error: `Cloudflare request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function asToolResult(payload: unknown, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function cfErrorsToString(result: CfResult): string {
  if (!result.errors || result.errors.length === 0) return 'unknown error';
  return result.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
}

export function registerTools(server: McpServer, ctx: CloudflareToolsContext): void {
  // ── 1. Identity & capability check ──────────────────────────────────────
  server.tool(
    'cloudflare_whoami',
    `Verify the configured Cloudflare API token and return account context.
Returns: account_id, token scopes, and a notes block documenting what is / isn't
possible via the API (account creation must still happen via dash.cloudflare.com).
Use this first when troubleshooting cloudflare_* tools.`,
    {},
    async () => {
      const token = getApiToken();
      if (!token) {
        return asToolResult({
          error: 'CLOUDFLARE_API_TOKEN not configured.',
          how_to_fix: 'Add CLOUDFLARE_API_TOKEN to ~/nanoclaw/.env, then restart the container.',
          where_to_get_token:
            'https://dash.cloudflare.com/profile/api-tokens — use the "Edit Cloudflare Workers" template, or create a custom token with Zone:Edit, Worker:Edit, Pages:Edit, Tunnel:Edit, Registrar:Read.',
        }, true);
      }
      const verify = await cfFetch<{ id: string; status: string }>('/user/tokens/verify');
      if ('error' in verify) return asToolResult(verify, true);
      if (!verify.success) return asToolResult({ error: cfErrorsToString(verify) }, true);

      const accountId = getAccountId();
      return asToolResult({
        success: true,
        token_status: verify.result?.status,
        token_id: verify.result?.id,
        account_id: accountId,
        notes: {
          account_creation:
            'Not available via API. Sign up once at https://dash.cloudflare.com/sign-up — afterwards all other tools work.',
          domain_registration:
            'Requires billing onboarding on the dashboard. cloudflare_register_domain proposes via HITL and the host validates account state.',
          deploy_pages: 'Fully supported via API + direct upload.',
          deploy_worker: 'Fully supported via API + script upload.',
          setup_tunnel:
            'Tunnel creation supported via API. The cloudflared daemon must be installed separately on the host that runs the tunnel.',
        },
      });
    },
  );

  // ── 2. Domain availability / transfer eligibility ──────────────────────
  server.tool(
    'cloudflare_check_domain',
    `Check whether a domain is available for registration or eligible for transfer
to Cloudflare Registrar. Does NOT purchase anything. Returns availability,
estimated price (USD/year), and transfer eligibility.`,
    {
      domain: z.string().min(3).describe('Domain name to check, e.g. "example.com"'),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) {
        return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);
      }
      // Availability endpoint (Registrar): GET /accounts/{id}/registrar/domains/{name}
      const result = await cfFetch<Record<string, unknown>>(
        `/accounts/${accountId}/registrar/domains/${encodeURIComponent(args.domain)}`,
      );
      if ('error' in result) return asToolResult(result, true);

      // Registrar returns 404-style for unregistered names — surface as available
      const errStr = result.errors?.map((e) => e.message).join(';') || '';
      const looksMissing = /not found|does not exist/i.test(errStr);
      if (!result.success && looksMissing) {
        return asToolResult({
          domain: args.domain,
          available: true,
          note: 'Domain appears available. Use cloudflare_register_domain to propose a purchase (HITL gated).',
        });
      }
      if (!result.success) return asToolResult({ error: cfErrorsToString(result) }, true);

      return asToolResult({
        domain: args.domain,
        available: false,
        registered_to_account: true,
        details: result.result,
      });
    },
  );

  // ── 3. Domain registration — HITL gated via host ─────────────────────────
  server.tool(
    'cloudflare_register_domain',
    `Propose a domain registration/transfer for user approval via WhatsApp.
This does NOT charge or register immediately — the host stores the proposal,
prompts the user, and only executes after they reply "approve-domain <token>".
Use cloudflare_check_domain first to confirm availability and pricing.`,
    {
      domain: z.string().min(3).describe('Domain name to register, e.g. "example.com"'),
      years: z.number().int().min(1).max(10).default(1).describe('Registration period in years'),
      estimated_price_usd: z
        .number()
        .min(0)
        .describe('Estimated price in USD (from cloudflare_check_domain) — shown to the user for confirmation'),
      privacy: z.boolean().default(true).describe('Enable WHOIS privacy (free on Cloudflare Registrar)'),
      auto_renew: z.boolean().default(true).describe('Enable auto-renewal'),
    },
    async (args) => {
      const responseFile = `/workspace/ipc/messages/cf-register-${Date.now()}.response.json`;
      ctx.writeIpcFile(ctx.MESSAGES_DIR, {
        type: 'cloudflare_register_domain',
        domain: args.domain,
        years: args.years,
        estimated_price_usd: args.estimated_price_usd,
        privacy: args.privacy,
        auto_renew: args.auto_renew,
        chatJid: ctx.chatJid,
        groupFolder: ctx.groupFolder,
        responseFile,
      });

      // Generous timeout — user may take a few minutes to approve via WhatsApp.
      // 10 min = 600_000 ms (gate itself expires in 30 min, so this is a soft polling cap).
      const response = await ctx.pollResponse(responseFile, 600_000);
      if (!response) {
        return asToolResult(
          { error: 'No response from host within 10 minutes. Approval may still be pending — check with the user.' },
          true,
        );
      }
      return asToolResult(response, Boolean(response.error));
    },
  );

  // ── 4. Zone listing ─────────────────────────────────────────────────────
  server.tool(
    'cloudflare_list_zones',
    `List all zones (domains) registered under the configured Cloudflare account.
Returns zone IDs, names, status, name servers, and plan.`,
    {
      name: z.string().optional().describe('Filter by domain name (exact match)'),
      per_page: z.number().int().min(1).max(50).default(20).describe('Page size'),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);

      const params = new URLSearchParams({
        'account.id': accountId,
        per_page: String(args.per_page),
      });
      if (args.name) params.set('name', args.name);

      const result = await cfFetch<Array<Record<string, unknown>>>(`/zones?${params.toString()}`);
      if ('error' in result) return asToolResult(result, true);
      if (!result.success) return asToolResult({ error: cfErrorsToString(result) }, true);

      return asToolResult({
        zones: (result.result || []).map((z) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          name_servers: z.name_servers,
          plan: (z.plan as Record<string, unknown>)?.name,
        })),
        count: (result.result || []).length,
      });
    },
  );

  // ── 5. Add zone (DNS-only, for externally-registered domains) ───────────
  server.tool(
    'cloudflare_add_zone',
    `Add a zone for a domain you registered elsewhere so Cloudflare can manage DNS.
You'll need to update the domain's nameservers at the existing registrar afterwards
(this tool returns the Cloudflare nameservers to use).`,
    {
      name: z.string().min(3).describe('Domain name, e.g. "example.com"'),
      type: z.enum(['full', 'partial']).default('full').describe('"full" for new setup, "partial" for CNAME-only'),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);

      const body = {
        name: args.name,
        account: { id: accountId },
        type: args.type,
      };
      const result = await cfFetch<Record<string, unknown>>('/zones', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if ('error' in result) return asToolResult(result, true);
      if (!result.success) return asToolResult({ error: cfErrorsToString(result) }, true);

      return asToolResult({
        success: true,
        zone_id: result.result?.id,
        name: result.result?.name,
        name_servers: result.result?.name_servers,
        next_step:
          'Update the domain nameservers at your existing registrar to the values above. Propagation may take up to 24 hours.',
      });
    },
  );

  // ── 6. DNS record creation ──────────────────────────────────────────────
  server.tool(
    'cloudflare_add_dns_record',
    `Create a DNS record in an existing Cloudflare zone. Get the zone_id from cloudflare_list_zones.`,
    {
      zone_id: z.string().describe('Cloudflare zone ID (from cloudflare_list_zones)'),
      type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX']).describe('DNS record type'),
      name: z.string().describe('Record name, e.g. "@" for apex or "www"'),
      content: z.string().describe('Record content, e.g. IP for A, hostname for CNAME'),
      ttl: z.number().int().min(60).max(86400).default(3600).describe('TTL in seconds (60-86400)'),
      proxied: z.boolean().default(false).describe('Proxy through Cloudflare (orange-cloud)'),
      priority: z.number().int().optional().describe('Priority (required for MX records)'),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        type: args.type,
        name: args.name,
        content: args.content,
        ttl: args.ttl,
        proxied: args.proxied,
      };
      if (args.type === 'MX') {
        if (args.priority === undefined) {
          return asToolResult({ error: 'priority is required for MX records' }, true);
        }
        body.priority = args.priority;
      }

      const result = await cfFetch<Record<string, unknown>>(
        `/zones/${encodeURIComponent(args.zone_id)}/dns_records`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      if ('error' in result) return asToolResult(result, true);
      if (!result.success) return asToolResult({ error: cfErrorsToString(result) }, true);

      return asToolResult({
        success: true,
        record_id: result.result?.id,
        type: result.result?.type,
        name: result.result?.name,
        content: result.result?.content,
        proxied: result.result?.proxied,
      });
    },
  );

  // ── 7. Cloudflare Pages deployment ──────────────────────────────────────
  server.tool(
    'cloudflare_deploy_pages',
    `Create a Cloudflare Pages project (idempotent — reuses an existing project by name).
Returns the project URL. For uploading actual files, follow up with wrangler CLI
or the Direct Upload API — this tool only manages the project metadata.`,
    {
      project_name: z.string().min(1).max(58).describe('Pages project name (lowercase, hyphens)'),
      production_branch: z.string().default('main').describe('Production branch name'),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);

      // Check if project exists
      const existing = await cfFetch<Record<string, unknown>>(
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(args.project_name)}`,
      );
      if ('error' in existing) return asToolResult(existing, true);
      if (existing.success && existing.result) {
        return asToolResult({
          success: true,
          existed: true,
          project_name: existing.result.name,
          subdomain: existing.result.subdomain,
          domains: existing.result.domains,
          next_step: 'Use wrangler pages deploy <dir> --project-name=' + args.project_name,
        });
      }

      const create = await cfFetch<Record<string, unknown>>(
        `/accounts/${accountId}/pages/projects`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: args.project_name,
            production_branch: args.production_branch,
          }),
        },
      );
      if ('error' in create) return asToolResult(create, true);
      if (!create.success) return asToolResult({ error: cfErrorsToString(create) }, true);

      return asToolResult({
        success: true,
        existed: false,
        project_name: create.result?.name,
        subdomain: create.result?.subdomain,
        next_step: 'Use wrangler pages deploy <dir> --project-name=' + args.project_name,
      });
    },
  );

  // ── 8. Cloudflare Workers deployment ────────────────────────────────────
  server.tool(
    'cloudflare_deploy_worker',
    `Upload a Cloudflare Worker script. The script_content is the JS/TS source code.
Returns the worker name and *.workers.dev URL (if the subdomain is enabled).`,
    {
      script_name: z.string().min(1).max(63).describe('Worker script name'),
      script_content: z.string().min(1).describe('Worker source code (module syntax recommended)'),
      compatibility_date: z
        .string()
        .default('2026-01-01')
        .describe('Worker runtime compatibility date (YYYY-MM-DD)'),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);

      // Workers deployment requires multipart/form-data with a metadata part + the script.
      const boundary = `----nanoclaw${Date.now()}`;
      const metadata = JSON.stringify({
        main_module: 'worker.js',
        compatibility_date: args.compatibility_date,
      });
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n` +
        `Content-Type: application/javascript+module\r\n\r\n` +
        `${args.script_content}\r\n` +
        `--${boundary}--\r\n`;

      const token = getApiToken();
      if (!token) return asToolResult({ error: 'CLOUDFLARE_API_TOKEN not configured.' }, true);

      let resp: Response;
      try {
        resp = await fetch(
          `${CF_API_BASE}/accounts/${accountId}/workers/scripts/${encodeURIComponent(args.script_name)}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body,
          },
        );
      } catch (err) {
        return asToolResult({ error: `Worker upload failed: ${err instanceof Error ? err.message : String(err)}` }, true);
      }
      const text = await resp.text();
      let parsed: CfResult<Record<string, unknown>>;
      try {
        parsed = JSON.parse(text);
      } catch {
        return asToolResult({ error: `Non-JSON response (${resp.status}): ${text.slice(0, 200)}` }, true);
      }
      if (!parsed.success) return asToolResult({ error: cfErrorsToString(parsed) }, true);

      return asToolResult({
        success: true,
        script_name: args.script_name,
        deployed_at: new Date().toISOString(),
        next_step: `Visit https://${args.script_name}.<your-subdomain>.workers.dev (enable subdomain in dash if needed) or bind to a route.`,
      });
    },
  );

  // ── 9. Named cloudflared tunnel creation ────────────────────────────────
  server.tool(
    'cloudflare_setup_tunnel',
    `Create a named cloudflared tunnel under the account. Returns the tunnel ID
and a credentials token. You still need to install and run cloudflared on the
host where the tunnel originates — this tool only registers the tunnel with Cloudflare.`,
    {
      name: z.string().min(1).max(63).describe('Tunnel name (unique within the account)'),
      tunnel_secret: z
        .string()
        .min(32)
        .describe(
          'Base64-encoded 32-byte random secret for the tunnel (generate with: openssl rand -base64 32)',
        ),
    },
    async (args) => {
      const accountId = getAccountId();
      if (!accountId) return asToolResult({ error: 'CLOUDFLARE_ACCOUNT_ID not configured.' }, true);

      const result = await cfFetch<Record<string, unknown>>(
        `/accounts/${accountId}/cfd_tunnel`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: args.name,
            tunnel_secret: args.tunnel_secret,
            config_src: 'cloudflare',
          }),
        },
      );
      if ('error' in result) return asToolResult(result, true);
      if (!result.success) return asToolResult({ error: cfErrorsToString(result) }, true);

      return asToolResult({
        success: true,
        tunnel_id: result.result?.id,
        name: result.result?.name,
        next_steps: [
          'Install cloudflared: brew install cloudflared',
          `Run: cloudflared tunnel run --token <token from dash> ${result.result?.id}`,
          'Add a public hostname → DNS routing via cloudflare_add_dns_record (CNAME → <tunnel_id>.cfargotunnel.com, proxied)',
        ],
      });
    },
  );
}
