/**
 * Cloudflare IPC handlers.
 *
 * The container side handles read/deploy operations directly via the
 * Cloudflare API (it has the token via env). The HOST is only involved in
 * domain registration, which routes through the HITL approval flow.
 *
 * Flow for cloudflare_register_domain:
 *   1. Container writes IPC: { type: "cloudflare_register_domain", domain, years, ... , responseFile }
 *   2. Host calls domainPurchaseGate.propose() — gets a token, sends WhatsApp prompt.
 *   3. Container polls responseFile (long timeout — up to 10 min).
 *   4. User replies "approve-domain <token>" or "reject-domain <token>" in WhatsApp.
 *   5. domainPurchaseGate.tryHandleApproval() executes the registration.
 *   6. On result, the gate's onResult callback writes the IPC response.
 */
import { logger } from '../../logger.js';
import { writeIpcResponse, toHostIpcPath } from '../../ipc.js';
import { domainPurchaseGate, DomainPurchaseGate } from './domain-purchase-gate.js';
import type { IpcHandlerContext } from '../../integration-types.js';

export const CLOUDFLARE_IPC_TYPES = new Set([
  'cloudflare_register_domain',
]);

export async function handleIpcMessage(
  data: Record<string, unknown>,
  groupFolder: string,
  ctx: IpcHandlerContext,
): Promise<void> {
  const rawResponseFile = data.responseFile as string | undefined;
  const responseFile = rawResponseFile ? toHostIpcPath(rawResponseFile, groupFolder) : undefined;
  const chatJid = data.chatJid as string;

  switch (data.type) {
    case 'cloudflare_register_domain': {
      const domain = String(data.domain || '');
      const years = Number(data.years || 1);
      const estimatedPriceUsd = Number(data.estimated_price_usd || 0);
      const privacy = data.privacy !== false;
      const autoRenew = data.auto_renew !== false;

      try {
        const token = domainPurchaseGate.propose({
          domain,
          years,
          estimatedPriceUsd,
          privacy,
          autoRenew,
          groupFolder,
          chatJid,
          onResult: (result) => {
            if (responseFile) writeIpcResponse(responseFile, result);
          },
        });

        // Send the WhatsApp prompt to the chat the agent is currently in.
        const message = DomainPurchaseGate.formatProposalMessage(
          {
            domain,
            years,
            estimatedPriceUsd,
            privacy,
            autoRenew,
            groupFolder,
            chatJid,
            onResult: () => {},
          },
          token,
        );
        try {
          await ctx.sendMessage(chatJid, message);
        } catch (sendErr) {
          logger.error({ sendErr, chatJid }, 'Cloudflare: failed to send approval prompt');
        }

        // Note: we deliberately do NOT writeIpcResponse here. The container
        // will keep polling until tryHandleApproval fires the onResult callback
        // (which writes the response), or until its own poll timeout elapses.
        logger.info({ token, domain, years, groupFolder }, 'Cloudflare: domain proposal registered, awaiting user approval');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, domain, groupFolder }, 'Cloudflare: domain proposal rejected by gate');
        if (responseFile) writeIpcResponse(responseFile, { success: false, error: errMsg });
      }
      break;
    }

    default:
      logger.warn({ type: data.type, groupFolder }, 'Unknown Cloudflare IPC type');
  }
}
