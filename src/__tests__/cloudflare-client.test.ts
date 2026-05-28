import { describe, it, expect, vi } from 'vitest';

import { CloudflareClient, formatCfErrors } from '../integrations/cloudflare/cloudflare-client.js';

function mockFetch(response: { status?: number; body: unknown }) {
  return vi.fn(async () => {
    return new Response(typeof response.body === 'string' ? response.body : JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('CloudflareClient', () => {
  it('throws when constructed without apiToken', () => {
    expect(() => new CloudflareClient({ apiToken: '', accountId: 'acc' })).toThrow(/apiToken/);
  });

  it('throws when constructed without accountId', () => {
    expect(() => new CloudflareClient({ apiToken: 'tok', accountId: '' })).toThrow(/accountId/);
  });

  it('verifyToken hits /user/tokens/verify with bearer auth', async () => {
    const fetchImpl = mockFetch({
      body: { success: true, result: { id: 'tid', status: 'active' } },
    });
    const client = new CloudflareClient({
      apiToken: 'test-token',
      accountId: 'acc-123',
      fetchImpl,
    });
    const result = await client.verifyToken();
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('active');

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-token',
    });
  });

  it('getDomain encodes the domain name', async () => {
    const fetchImpl = mockFetch({ body: { success: true, result: { name: 'example.com' } } });
    const client = new CloudflareClient({
      apiToken: 'tok',
      accountId: 'acc-123',
      fetchImpl,
    });
    await client.getDomain('weird name.com');
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toContain('/accounts/acc-123/registrar/domains/weird%20name.com');
  });

  it('registerDomain sends PUT with correct body shape', async () => {
    const fetchImpl = mockFetch({ body: { success: true, result: { name: 'example.com' } } });
    const client = new CloudflareClient({
      apiToken: 'tok',
      accountId: 'acc-123',
      fetchImpl,
    });
    await client.registerDomain({ domain: 'example.com', years: 2, privacy: true, autoRenew: false });
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body.period).toBe(2);
    expect(body.privacy).toBe(true);
    expect(body.auto_renew).toBe(false);
    expect(body.locked).toBe(true);
  });

  it('returns a CfApiResponse-shaped error for non-JSON responses', async () => {
    const fetchImpl = mockFetch({ status: 500, body: '<html>Internal Error</html>' });
    const client = new CloudflareClient({
      apiToken: 'tok',
      accountId: 'acc',
      fetchImpl,
    });
    const result = await client.verifyToken();
    expect(result.success).toBe(false);
    expect(result.errors?.[0].code).toBe(500);
    expect(result.errors?.[0].message).toContain('Non-JSON');
  });

  it('formatCfErrors handles empty and populated errors', () => {
    expect(formatCfErrors(undefined)).toBe('unknown error');
    expect(formatCfErrors([])).toBe('unknown error');
    expect(formatCfErrors([{ code: 1004, message: 'DNS Validation Error' }])).toBe(
      '[1004] DNS Validation Error',
    );
    expect(
      formatCfErrors([
        { code: 1, message: 'first' },
        { code: 2, message: 'second' },
      ]),
    ).toBe('[1] first; [2] second');
  });
});
