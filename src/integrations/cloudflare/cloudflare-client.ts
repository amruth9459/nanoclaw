/**
 * Thin, testable Cloudflare REST API client used by the host-side integration.
 *
 * The container-side MCP tools call Cloudflare directly (no host roundtrip)
 * for read/deploy operations. This client is only used by the HOST for the
 * one operation that *must* run on the host: actually executing a domain
 * registration after the user has approved it via HITL.
 *
 * Kept dependency-free (uses Node 18+ global fetch) and side-effect free so
 * it can be unit-tested with a stubbed fetch.
 */

export interface CfErrorEntry {
  code: number;
  message: string;
}

export interface CfApiResponse<T = unknown> {
  success: boolean;
  errors?: CfErrorEntry[];
  messages?: unknown[];
  result?: T;
}

export interface CloudflareClientOptions {
  apiToken: string;
  accountId: string;
  /** Override for tests. Defaults to the real Cloudflare endpoint. */
  baseUrl?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface DomainRegistrationRequest {
  domain: string;
  years: number;
  privacy: boolean;
  autoRenew: boolean;
}

export class CloudflareClient {
  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareClientOptions) {
    if (!opts.apiToken) throw new Error('CloudflareClient: apiToken is required');
    if (!opts.accountId) throw new Error('CloudflareClient: accountId is required');
    this.apiToken = opts.apiToken;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl || 'https://api.cloudflare.com/client/v4';
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  async verifyToken(): Promise<CfApiResponse<{ id: string; status: string }>> {
    return this.request('/user/tokens/verify');
  }

  async getDomain(domain: string): Promise<CfApiResponse<Record<string, unknown>>> {
    return this.request(`/accounts/${this.accountId}/registrar/domains/${encodeURIComponent(domain)}`);
  }

  /**
   * Submit a domain registration via the Registrar API.
   *
   * NOTE: Cloudflare's Registrar API uses PUT to update / register a domain.
   * The exact request body depends on whether the domain is being newly
   * registered, transferred, or already owned. We use the documented shape
   * for new registrations.
   *
   * This will CHARGE the account's payment method. Callers must enforce HITL
   * approval before invoking this method.
   */
  async registerDomain(req: DomainRegistrationRequest): Promise<CfApiResponse<Record<string, unknown>>> {
    return this.request(
      `/accounts/${this.accountId}/registrar/domains/${encodeURIComponent(req.domain)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name_servers: undefined, // Use Cloudflare defaults
          auto_renew: req.autoRenew,
          privacy: req.privacy,
          locked: true,
          // The actual registration period and pricing are confirmed server-side.
          period: req.years,
        }),
      },
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<CfApiResponse<T> | CfApiResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    };
    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await resp.text();
    try {
      return JSON.parse(text) as CfApiResponse<T>;
    } catch {
      return {
        success: false,
        errors: [{ code: resp.status, message: `Non-JSON response: ${text.slice(0, 200)}` }],
      };
    }
  }
}

export function formatCfErrors(errors: CfErrorEntry[] | undefined): string {
  if (!errors || errors.length === 0) return 'unknown error';
  return errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
}
