/**
 * URL Validator — validates URLs in text and documents before delivery.
 * Strips dead links, homepages, and expired listings.
 */

import dns from 'dns';
import net from 'net';

import { logger } from './logger.js';

const URL_REGEX = /https?:\/\/[^\s"')>\]]+/g;

/**
 * SSRF guard. These URLs come from agent output driven by untrusted WhatsApp
 * input; the host must never be tricked into fetching internal endpoints
 * (cloud metadata 169.254.169.254, localhost services, RFC1918, Tailscale CGNAT).
 */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;            // link-local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT / Tailscale
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

async function isBlockedTarget(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    return true;
  }
  if (net.isIP(h)) return isPrivateIp(h);
  try {
    const records = await dns.promises.lookup(h, { all: true });
    return records.some((r) => isPrivateIp(r.address));
  } catch {
    return false; // DNS failure is handled downstream as an unreachable URL
  }
}

// URLs that are informational (government sites, reference docs) — skip validation
const SKIP_DOMAINS = new Set([
  'uscis.gov', 'dhs.gov', 'state.gov', 'irs.gov', 'doi.org',
  'wikipedia.org', 'github.com', 'stackoverflow.com',
]);

// Generic career page patterns — these are homepages, not specific listings
const HOMEPAGE_PATTERNS = [
  /^https?:\/\/[^/]+\/?$/,                          // bare domain
  /\/careers\/?$/i,                                   // /careers
  /\/jobs\/?$/i,                                      // /jobs
  /\/employment\/?$/i,                                // /employment
  /\/career-opportunities\/?$/i,                      // generic careers
  /\/internships-students\/?$/i,                      // generic internships page
];

interface ValidationResult {
  url: string;
  status: number;
  valid: boolean;
  reason?: string;
}

/**
 * Validate a single URL.
 * Returns { valid: true } if the URL is live and points to a specific page.
 */
async function validateUrl(url: string, timeoutMs = 8000): Promise<ValidationResult> {
  try {
    // Skip informational/reference URLs
    const parsed = new URL(url);
    const domain = parsed.hostname.replace(/^www\./, '');
    if (SKIP_DOMAINS.has(domain)) {
      return { url, status: 200, valid: true, reason: 'reference-domain-skipped' };
    }

    // SSRF guard: refuse to fetch internal/private targets.
    if (await isBlockedTarget(parsed.hostname)) {
      logger.warn({ url, hostname: parsed.hostname }, 'URL validation: blocked internal/private target (SSRF guard)');
      return { url, status: 0, valid: false, reason: 'blocked-internal-target' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // redirect: 'manual' — don't auto-follow to an internal target that a public
    // URL 302-redirects to (SSRF bypass). A 3xx just means the link is live.
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }).catch(async () => {
      // HEAD might be blocked, try GET
      return fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
    });

    clearTimeout(timer);

    if (resp.status === 404 || resp.status === 410) {
      return { url, status: resp.status, valid: false, reason: 'not-found' };
    }

    if (resp.status === 403) {
      // Some sites block automated requests — treat as potentially valid but flag
      return { url, status: 403, valid: true, reason: 'access-restricted' };
    }

    if (resp.status >= 400) {
      return { url, status: resp.status, valid: false, reason: `http-${resp.status}` };
    }

    // Check if it's a generic homepage
    const isHomepage = HOMEPAGE_PATTERNS.some(p => p.test(url));
    if (isHomepage) {
      return { url, status: resp.status, valid: false, reason: 'generic-homepage' };
    }

    return { url, status: resp.status, valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { url, status: 0, valid: false, reason: 'timeout' };
    }
    return { url, status: 0, valid: false, reason: `error: ${msg.slice(0, 50)}` };
  }
}

/**
 * Extract all URLs from text, validate each, and return the text with dead URLs
 * annotated or removed.
 */
export async function validateUrlsInText(
  text: string,
  mode: 'strip' | 'annotate' = 'strip',
): Promise<{ text: string; validated: number; stripped: number; results: ValidationResult[] }> {
  const urls = [...new Set(text.match(URL_REGEX) || [])];
  if (urls.length === 0) return { text, validated: 0, stripped: 0, results: [] };

  // Validate all URLs in parallel (with concurrency limit)
  const CONCURRENCY = 5;
  const results: ValidationResult[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(u => validateUrl(u)));
    results.push(...batchResults);
  }

  let stripped = 0;
  let processed = text;

  for (const r of results) {
    if (!r.valid) {
      stripped++;
      if (mode === 'strip') {
        // Remove the dead URL and its surrounding context (the whole line if it's just a link)
        processed = processed.replace(r.url, `[⚠️ link not verified — search "${r.url.split('/').pop()?.replace(/[-_]/g, ' ')}" to find current listing]`);
      } else {
        processed = processed.replace(r.url, `${r.url} ⚠️[${r.reason}]`);
      }
      logger.info({ url: r.url, status: r.status, reason: r.reason }, 'URL validation: dead link flagged');
    }
  }

  // If dead links were found, append a notice at the end
  if (stripped > 0) {
    processed += `\n\n_Note: ${stripped} link(s) could not be verified and have been flagged. Search the organization's website directly to find current listings._`;
    logger.info({ total: urls.length, valid: urls.length - stripped, stripped }, 'URL validation complete');
  }

  return { text: processed, validated: urls.length, stripped, results };
}

/**
 * Validate URLs in a file buffer (reads text content, validates, returns cleaned buffer).
 * Works with: .md, .txt, .html, .csv
 * For .docx: extracts text, validates, but cannot rewrite the docx — returns validation report instead.
 */
export async function validateUrlsInFile(
  filePath: string,
  buffer: Buffer,
): Promise<{ buffer: Buffer; report: string; stripped: number }> {
  const ext = filePath.toLowerCase();

  // For text-based files, validate and clean inline
  if (ext.endsWith('.md') || ext.endsWith('.txt') || ext.endsWith('.html') || ext.endsWith('.csv')) {
    const text = buffer.toString('utf-8');
    const result = await validateUrlsInText(text, 'strip');
    return {
      buffer: Buffer.from(result.text, 'utf-8'),
      report: result.stripped > 0
        ? `Removed ${result.stripped}/${result.validated} dead links`
        : '',
      stripped: result.stripped,
    };
  }

  // For DOCX/binary, extract URLs from raw bytes (URLs are stored as plain text in DOCX XML)
  if (ext.endsWith('.docx')) {
    const text = buffer.toString('utf-8'); // DOCX is ZIP but URLs appear in XML as plain text
    const urls = [...new Set(text.match(URL_REGEX) || [])];
    if (urls.length === 0) return { buffer, report: '', stripped: 0 };

    const CONCURRENCY = 5;
    const results: ValidationResult[] = [];
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(u => validateUrl(u)));
      results.push(...batchResults);
    }

    const dead = results.filter(r => !r.valid);
    if (dead.length > 0) {
      const report = `⚠️ ${dead.length}/${urls.length} links are dead or invalid:\n` +
        dead.map(d => `• ${d.url} — ${d.reason}`).join('\n');
      logger.warn({ dead: dead.length, total: urls.length }, 'DOCX contains dead links');
      return { buffer, report, stripped: dead.length };
    }

    return { buffer, report: '', stripped: 0 };
  }

  // Other file types — no validation
  return { buffer, report: '', stripped: 0 };
}
