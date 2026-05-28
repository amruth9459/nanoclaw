import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DomainPurchaseGate } from '../integrations/cloudflare/domain-purchase-gate.js';
import { CloudflareClient } from '../integrations/cloudflare/cloudflare-client.js';

function makeProposal(overrides: Partial<{ domain: string; years: number; price: number }> = {}) {
  const onResult = vi.fn();
  return {
    onResult,
    proposal: {
      domain: overrides.domain ?? 'example.com',
      years: overrides.years ?? 1,
      estimatedPriceUsd: overrides.price ?? 10,
      privacy: true,
      autoRenew: true,
      groupFolder: 'main',
      chatJid: '12345@g.us',
      onResult,
    },
  };
}

function mockClient(responseBody: unknown) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
  return new CloudflareClient({
    apiToken: 'tok',
    accountId: 'acc',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('DomainPurchaseGate', () => {
  let gate: DomainPurchaseGate;
  let clientFactory: ReturnType<typeof vi.fn<() => CloudflareClient | null>>;

  beforeEach(() => {
    clientFactory = vi.fn<() => CloudflareClient | null>(
      () => mockClient({ success: true, result: { name: 'example.com' } }),
    );
    gate = new DomainPurchaseGate(clientFactory);
  });

  it('rejects invalid domain names', () => {
    const { proposal } = makeProposal({ domain: 'not a domain' });
    expect(() => gate.propose(proposal)).toThrow(/Invalid domain/);
  });

  it('rejects registration periods over the cap', () => {
    const { proposal } = makeProposal({ years: 99 });
    expect(() => gate.propose(proposal)).toThrow(/exceeds cap/);
  });

  it('rejects proposals over the price cap', () => {
    const { proposal } = makeProposal({ price: 9999 });
    expect(() => gate.propose(proposal)).toThrow(/exceeds cap/);
  });

  it('returns an 8-char hex token for valid proposals', () => {
    const { proposal } = makeProposal();
    const token = gate.propose(proposal);
    expect(token).toMatch(/^[a-f0-9]{8}$/);
    expect(gate.pendingCount()).toBe(1);
  });

  it('ignores messages that do not match the approval pattern', async () => {
    const notify = vi.fn(async () => {});
    const handled = await gate.tryHandleApproval('hello world', notify);
    expect(handled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('responds to unknown tokens with a warning', async () => {
    const notify = vi.fn(async () => {});
    const handled = await gate.tryHandleApproval('approve-domain deadbeef', notify);
    expect(handled).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No pending'));
  });

  it('approve path calls CloudflareClient.registerDomain and resolves onResult success', async () => {
    const { proposal, onResult } = makeProposal();
    const token = gate.propose(proposal);
    const notify = vi.fn(async () => {});

    const handled = await gate.tryHandleApproval(`approve-domain ${token}`, notify);
    expect(handled).toBe(true);

    expect(clientFactory).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Registering'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Registered'));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(gate.pendingCount()).toBe(0);
  });

  it('reject path skips the API call and resolves onResult with failure', async () => {
    const { proposal, onResult } = makeProposal();
    const token = gate.propose(proposal);
    const notify = vi.fn(async () => {});

    const handled = await gate.tryHandleApproval(`reject-domain ${token}`, notify);
    expect(handled).toBe(true);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringMatching(/rejected/i) }),
    );
  });

  it('reports CF API errors back through onResult', async () => {
    clientFactory.mockReturnValue(
      mockClient({ success: false, errors: [{ code: 1004, message: 'Insufficient funds' }] }),
    );
    const localGate = new DomainPurchaseGate(clientFactory);
    const { proposal, onResult } = makeProposal();
    const token = localGate.propose(proposal);
    const notify = vi.fn(async () => {});

    await localGate.tryHandleApproval(`approve-domain ${token}`, notify);

    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('Insufficient funds'),
      }),
    );
  });

  it('fails gracefully when no Cloudflare client is available', async () => {
    const noClientFactory = vi.fn<() => CloudflareClient | null>(() => null);
    const localGate = new DomainPurchaseGate(noClientFactory);
    const { proposal, onResult } = makeProposal();
    const token = localGate.propose(proposal);
    const notify = vi.fn(async () => {});

    await localGate.tryHandleApproval(`approve-domain ${token}`, notify);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('not configured'),
      }),
    );
  });

  it('proposing a second registration for the same domain replaces the first', () => {
    const a = makeProposal();
    const b = makeProposal();
    gate.propose(a.proposal);
    gate.propose(b.proposal);
    expect(gate.pendingCount()).toBe(1);
  });

  it('formatProposalMessage includes domain, total cost, and the token', () => {
    const { proposal } = makeProposal({ years: 2, price: 12.5 });
    const msg = DomainPurchaseGate.formatProposalMessage(proposal, 'abcd1234');
    expect(msg).toContain('example.com');
    expect(msg).toContain('2 years');
    expect(msg).toContain('$12.50/yr');
    expect(msg).toContain('$25.00');
    expect(msg).toContain('approve-domain abcd1234');
    expect(msg).toContain('reject-domain abcd1234');
  });
});
