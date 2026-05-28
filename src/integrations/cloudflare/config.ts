/**
 * Cloudflare integration configuration.
 *
 * Loaded from environment variables. The integration registers itself
 * unconditionally so that error messages from cloudflare_* tools surface
 * the missing config to the agent, rather than the tool silently not existing.
 */

export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
export const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';

/** Hard cap on per-domain registration cost (USD). User-tunable. */
export const CLOUDFLARE_MAX_DOMAIN_PRICE_USD = Number(
  process.env.CLOUDFLARE_MAX_DOMAIN_PRICE_USD || '50',
);

/** Hard cap on total registration period in years. */
export const CLOUDFLARE_MAX_REGISTRATION_YEARS = Number(
  process.env.CLOUDFLARE_MAX_REGISTRATION_YEARS || '5',
);

export function isCloudflareConfigured(): boolean {
  return Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ACCOUNT_ID);
}
