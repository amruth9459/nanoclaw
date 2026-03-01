/**
 * Lexios Security — Input validation for Lexios messages.
 * Ported from Lexios/backend/services/security.py patterns.
 */

import { logSecurityEvent } from './db.js';
import { logger } from './logger.js';

interface BlockedPattern {
  name: string;
  regex: RegExp;
  type: string;
}

const BLOCKED_PATTERNS: BlockedPattern[] = [
  // Shell injection
  { name: 'cmd_substitution', regex: /\$\(.*\)/, type: 'shell' },
  { name: 'backtick_exec', regex: /`[^`]+`/, type: 'shell' },
  { name: 'pipe_dangerous', regex: /\|\s*(rm|curl|wget|bash|sh|nc|ncat)\b/, type: 'shell' },
  { name: 'semicolon_chain', regex: /;\s*(rm|curl|wget|bash|sh|chmod|chown)\b/, type: 'shell' },
  { name: 'redirect_overwrite', regex: />\s*\//, type: 'shell' },
  { name: 'env_var_set', regex: /\bexport\s+\w+=/, type: 'shell' },

  // SQL injection
  { name: 'sql_drop', regex: /';\s*(DROP|DELETE|UPDATE|INSERT|ALTER)\s/i, type: 'sql' },
  { name: 'sql_union', regex: /UNION\s+(ALL\s+)?SELECT/i, type: 'sql' },
  { name: 'sql_comment', regex: /--\s*$|\/\*.*\*\//m, type: 'sql' },
  { name: 'sql_or_true', regex: /'\s*OR\s+'[^']*'\s*=\s*'[^']*'/i, type: 'sql' },

  // Prompt injection
  { name: 'ignore_instructions', regex: /ignore\s+(previous|all|above|prior)\s+(instructions|prompts|rules)/i, type: 'prompt' },
  { name: 'new_instructions', regex: /new\s+instructions?:/i, type: 'prompt' },
  { name: 'system_prompt', regex: /system\s*prompt\s*:/i, type: 'prompt' },
  { name: 'pretend_to_be', regex: /pretend\s+(you\s+are|to\s+be)\s+/i, type: 'prompt' },
  { name: 'jailbreak', regex: /\b(DAN|jailbreak|do\s+anything\s+now)\b/i, type: 'prompt' },

  // Path traversal
  { name: 'path_traversal', regex: /\.\.\/|\.\.\\/, type: 'path' },
  { name: 'absolute_etc', regex: /\/etc\/(passwd|shadow|hosts)/i, type: 'path' },

  // Data exfiltration
  { name: 'base64_encoded', regex: /eval\s*\(\s*atob\s*\(/, type: 'exfil' },
  { name: 'webhook_url', regex: /https?:\/\/[^\s]*webhook/i, type: 'exfil' },
];

export function validateQuery(text: string): { safe: boolean; reason?: string } {
  if (!text || text.length === 0) return { safe: true };

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.regex.test(text)) {
      return { safe: false, reason: `${pattern.type}:${pattern.name}` };
    }
  }
  return { safe: true };
}

export function validatePhone(phone: string): boolean {
  // Allow digits, +, spaces, hyphens. Must be 7-15 digits.
  const digitsOnly = phone.replace(/[\s\-+()]/g, '');
  return /^\d{7,15}$/.test(digitsOnly);
}

export function sanitizeInput(text: string): string {
  // Strip null bytes and control characters (except newlines/tabs)
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Validate and log a Lexios message. Returns true if safe to process.
 */
export function validateLexiosMessage(
  text: string,
  buildingJid: string | null,
  phone: string | null,
): boolean {
  const result = validateQuery(text);
  if (!result.safe) {
    logger.warn(
      { buildingJid, phone, reason: result.reason },
      'Lexios security: blocked input',
    );
    const [type, name] = (result.reason || 'unknown:unknown').split(':');
    logSecurityEvent(buildingJid, phone, text, type, name);
    return false;
  }
  return true;
}
