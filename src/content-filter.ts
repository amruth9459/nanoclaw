/**
 * Content Sanitization Layer - Defense against AI Agent Traps
 *
 * Protects against content injection attacks via:
 * - HTML/CSS obfuscation detection
 * - Invisible text stripping
 * - Hidden command detection
 * - Dynamic cloaking pattern detection
 * - Markdown/LaTeX syntactic masking removal
 * - Steganographic payload detection
 *
 * Based on Google DeepMind research: "AI Agent Traps"
 */

import { logger } from './logger.js';

export interface SanitizationResult {
  sanitized: string;
  original: string;
  threatsDetected: ThreatDetection[];
  riskScore: number; // 0-100, higher = more suspicious
  safe: boolean; // false if riskScore > threshold
}

export interface ThreatDetection {
  type: ThreatType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location?: string;
  pattern?: string;
}

export type ThreatType =
  | 'html_obfuscation'
  | 'css_hidden_text'
  | 'invisible_chars'
  | 'command_injection'
  | 'dynamic_cloaking'
  | 'markdown_masking'
  | 'latex_obfuscation'
  | 'steganography'
  | 'zero_width_chars'
  | 'homoglyph_attack'
  | 'excessive_whitespace'
  | 'base64_payload';

const RISK_THRESHOLD = 60; // Block if riskScore > 60

/**
 * Sanitize web content before presenting to agent.
 * Strips attack vectors while preserving legitimate content.
 */
export function sanitizeWebContent(
  content: string,
  options: { strictMode?: boolean; sourceUrl?: string } = {},
): SanitizationResult {
  const threats: ThreatDetection[] = [];
  let sanitized = content;
  let riskScore = 0;

  // 1. Strip HTML/CSS obfuscation
  const htmlThreats = detectHtmlObfuscation(sanitized);
  threats.push(...htmlThreats);
  riskScore += htmlThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);
  sanitized = stripHtmlTags(sanitized);

  // 2. Remove invisible Unicode characters
  const invisibleThreats = detectInvisibleChars(sanitized);
  threats.push(...invisibleThreats);
  riskScore += invisibleThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);
  sanitized = stripInvisibleChars(sanitized);

  // 3. Detect command injection attempts
  const commandThreats = detectCommandInjection(sanitized);
  threats.push(...commandThreats);
  riskScore += commandThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  // 4. Strip Markdown/LaTeX masking
  const syntaxThreats = detectSyntaxMasking(sanitized);
  threats.push(...syntaxThreats);
  riskScore += syntaxThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);
  sanitized = stripSyntaxMasking(sanitized);

  // 5. Detect steganography indicators
  const stegoThreats = detectSteganography(sanitized);
  threats.push(...stegoThreats);
  riskScore += stegoThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  // 6. Detect homoglyph attacks (look-alike characters)
  const homoglyphThreats = detectHomoglyphs(sanitized);
  threats.push(...homoglyphThreats);
  riskScore += homoglyphThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  // 7. Normalize excessive whitespace
  const whitespaceThreats = detectExcessiveWhitespace(sanitized);
  threats.push(...whitespaceThreats);
  riskScore += whitespaceThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);
  sanitized = normalizeWhitespace(sanitized);

  // 8. Detect suspicious base64 payloads
  const base64Threats = detectBase64Payloads(sanitized);
  threats.push(...base64Threats);
  riskScore += base64Threats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  const safe = riskScore <= RISK_THRESHOLD;

  if (!safe || threats.length > 0) {
    logger.warn({
      sourceUrl: options.sourceUrl,
      riskScore,
      threatCount: threats.length,
      threats: threats.map(t => ({ type: t.type, severity: t.severity })),
    }, 'Content sanitization detected threats');
  }

  return {
    sanitized,
    original: content,
    threatsDetected: threats,
    riskScore,
    safe,
  };
}

/**
 * Lightweight check for prompt injection in text content.
 * Used for memory writes and IPC messages where full HTML sanitization is overkill.
 */
export function detectPromptInjection(text: string): { safe: boolean; riskScore: number; threats: ThreatDetection[] } {
  const threats: ThreatDetection[] = [];
  let riskScore = 0;

  const commandThreats = detectCommandInjection(text);
  threats.push(...commandThreats);
  riskScore += commandThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  const invisibleThreats = detectInvisibleChars(text);
  threats.push(...invisibleThreats);
  riskScore += invisibleThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  const homoglyphThreats = detectHomoglyphs(text);
  threats.push(...homoglyphThreats);
  riskScore += homoglyphThreats.reduce((sum, t) => sum + getSeverityScore(t.severity), 0);

  return { safe: riskScore <= RISK_THRESHOLD, riskScore, threats };
}

// ── Detection Functions ────────────────────────────────────────────────────

function detectHtmlObfuscation(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Hidden via CSS (display:none, visibility:hidden, opacity:0)
  const hiddenPatterns: Array<[RegExp, string]> = [
    [/display\s*:\s*none/gi, 'display:none'],
    [/visibility\s*:\s*hidden/gi, 'visibility:hidden'],
    [/opacity\s*:\s*0(?![.\d])/gi, 'opacity:0'],
    [/font-size\s*:\s*0(?:px|em|rem|%)?(?:\s|;|$)/gi, 'font-size:0'],
    [/color\s*:\s*transparent/gi, 'color:transparent'],
  ];

  for (const [pattern, desc] of hiddenPatterns) {
    if (pattern.test(content)) {
      threats.push({
        type: 'css_hidden_text',
        severity: 'high',
        description: `CSS hiding technique detected: ${desc}`,
        pattern: pattern.source,
      });
    }
  }

  // Position manipulation (position:absolute with negative coords)
  if (/position\s*:\s*absolute.*?left\s*:\s*-\d+/i.test(content)) {
    threats.push({
      type: 'html_obfuscation',
      severity: 'medium',
      description: 'Off-screen positioning detected',
    });
  }

  return threats;
}

function detectInvisibleChars(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Zero-width characters
  const zeroWidthChars = [
    '\u200B', // ZERO WIDTH SPACE
    '\u200C', // ZERO WIDTH NON-JOINER
    '\u200D', // ZERO WIDTH JOINER
    '\uFEFF', // ZERO WIDTH NO-BREAK SPACE
    '\u2060', // WORD JOINER
  ];

  let totalZeroWidth = 0;
  for (const char of zeroWidthChars) {
    const count = (content.match(new RegExp(char, 'g')) || []).length;
    totalZeroWidth += count;
  }

  if (totalZeroWidth > 5) { // Allow some legitimate use
    threats.push({
      type: 'zero_width_chars',
      severity: totalZeroWidth > 20 ? 'high' : 'medium',
      description: `${totalZeroWidth} zero-width characters detected`,
    });
  }

  // Right-to-left override (can reverse text display)
  if (/[\u202E\u202D]/g.test(content)) {
    threats.push({
      type: 'invisible_chars',
      severity: 'high',
      description: 'RTL override character detected',
    });
  }

  return threats;
}

function detectCommandInjection(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Direct tool invocation attempts
  const toolPatterns: Array<[RegExp, string]> = [
    [/\brm\s+-rf\s+\//gi, 'rm -rf with absolute path'],
    [/\bcurl.*?\|\s*(?:ba)?sh/gi, 'curl pipe to shell'],
    [/\bwget.*?\|\s*(?:ba)?sh/gi, 'wget pipe to shell'],
    [/\beval\s*\(\s*['"`]/gi, 'eval() call'],
  ];

  for (const [pattern, desc] of toolPatterns) {
    if (pattern.test(content)) {
      threats.push({
        type: 'command_injection',
        severity: 'critical',
        description: `Dangerous command pattern: ${desc}`,
        pattern: pattern.source,
      });
    }
  }

  // Persona manipulation attempts
  const personaPatterns: Array<[RegExp, string]> = [
    [/you\s+are\s+now\s+/gi, 'persona reassignment'],
    [/ignore\s+(previous|all|prior)\s+instructions/gi, 'instruction override'],
    [/your\s+new\s+(role|purpose|instructions)\s/gi, 'role reassignment'],
    [/system\s*:\s*you\s+must/gi, 'fake system prompt'],
    [/from\s+now\s+on,?\s+(you|always|never)/gi, 'behavioral override'],
    [/\[system\]|\[INST\]|<\|system\|>/gi, 'prompt format injection'],
  ];

  for (const [pattern, desc] of personaPatterns) {
    if (pattern.test(content)) {
      threats.push({
        type: 'command_injection',
        severity: 'high',
        description: `Persona manipulation: ${desc}`,
        pattern: pattern.source,
      });
    }
  }

  return threats;
}

function detectSyntaxMasking(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Markdown comment hiding: [comment]: # (hidden text)
  const mdCommentCount = (content.match(/\[.*?\]:\s*#\s*\(/g) || []).length;
  if (mdCommentCount > 3) {
    threats.push({
      type: 'markdown_masking',
      severity: 'medium',
      description: `${mdCommentCount} Markdown comments detected (potential hidden instructions)`,
    });
  }

  // LaTeX invisible text
  if (/\\phantom\{|\\hphantom\{|\\vphantom\{/.test(content)) {
    threats.push({
      type: 'latex_obfuscation',
      severity: 'high',
      description: 'LaTeX phantom (invisible text) detected',
    });
  }

  return threats;
}

function detectSteganography(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Mixed script detection: Cyrillic characters in otherwise Latin text
  const cyrillicChars = content.match(/[а-яА-ЯёЁ]/g);
  const latinChars = content.match(/[a-zA-Z]/g);
  if (cyrillicChars && latinChars) {
    const ratio = cyrillicChars.length / (cyrillicChars.length + latinChars.length);
    // Flag if mixed (not purely one script) — between 1% and 40% Cyrillic
    if (ratio > 0.01 && ratio < 0.4) {
      threats.push({
        type: 'steganography',
        severity: 'medium',
        description: `Mixed Cyrillic/Latin characters (${cyrillicChars.length} Cyrillic in ${latinChars.length} Latin — possible homoglyph attack)`,
      });
    }
  }

  return threats;
}

function detectHomoglyphs(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Common homoglyph pairs that could disguise commands
  const homoglyphPairs: Array<[RegExp, string]> = [
    [/\u0430/g, 'Cyrillic "а" (looks like Latin "a")'],
    [/\u0435/g, 'Cyrillic "е" (looks like Latin "e")'],
    [/\u043E/g, 'Cyrillic "о" (looks like Latin "o")'],
    [/\u0440/g, 'Cyrillic "р" (looks like Latin "p")'],
    [/\u0441/g, 'Cyrillic "с" (looks like Latin "c")'],
  ];

  let totalHomoglyphs = 0;
  for (const [pattern] of homoglyphPairs) {
    const matches = content.match(pattern);
    if (matches) totalHomoglyphs += matches.length;
  }

  // Only flag if there are a few (not a Cyrillic text block)
  if (totalHomoglyphs > 0 && totalHomoglyphs < 20) {
    threats.push({
      type: 'homoglyph_attack',
      severity: 'medium',
      description: `${totalHomoglyphs} homoglyph characters detected`,
    });
  }

  return threats;
}

function detectExcessiveWhitespace(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Excessive spaces (potential steganographic data hiding via whitespace encoding)
  const spaceClusters = content.match(/[ \t]{20,}/g);
  if (spaceClusters && spaceClusters.length > 0) {
    threats.push({
      type: 'excessive_whitespace',
      severity: 'low',
      description: `${spaceClusters.length} excessive whitespace clusters detected`,
    });
  }

  return threats;
}

function detectBase64Payloads(content: string): ThreatDetection[] {
  const threats: ThreatDetection[] = [];

  // Long base64 strings (potential encoded payloads)
  const base64Pattern = /[A-Za-z0-9+/]{100,}={0,2}/g;
  const matches = content.match(base64Pattern);
  if (matches) {
    for (const match of matches) {
      try {
        const decoded = Buffer.from(match, 'base64').toString('utf-8');
        // Check if decoded content contains shell commands or injection patterns
        if (/\b(bash|curl|wget|rm\s+-rf|exec|eval|sudo|chmod)\b/.test(decoded)) {
          threats.push({
            type: 'base64_payload',
            severity: 'critical',
            description: 'Base64-encoded command payload detected',
            pattern: match.substring(0, 50) + '...',
          });
        }
      } catch {
        // Not valid base64, ignore
      }
    }
  }

  return threats;
}

// ── Sanitization Functions ─────────────────────────────────────────────────

function stripHtmlTags(content: string): string {
  let sanitized = content;

  // Strip <style> blocks entirely
  sanitized = sanitized.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Strip elements with suspicious CSS inline styles
  sanitized = sanitized.replace(
    /<[^>]*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d]))[^>]*>[\s\S]*?<\/[^>]+>/gi,
    '',
  );

  // Strip script blocks
  sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Convert remaining HTML tags to spaces (preserve content)
  sanitized = sanitized.replace(/<[^>]+>/g, ' ');

  return sanitized;
}

function stripInvisibleChars(content: string): string {
  let sanitized = content;

  // Remove zero-width characters
  sanitized = sanitized.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, '');

  // Remove RTL/LTR overrides
  sanitized = sanitized.replace(/[\u202E\u202D\u202A\u202B\u202C]/g, '');

  // Remove other invisible formatting characters
  sanitized = sanitized.replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E]/g, '');

  return sanitized;
}

function stripSyntaxMasking(content: string): string {
  let sanitized = content;

  // Remove Markdown reference-style comments: [text]: # (hidden content)
  sanitized = sanitized.replace(/\[.*?\]:\s*#\s*\([^)]*\)/g, '');

  // Remove LaTeX phantom commands
  sanitized = sanitized.replace(/\\[hv]?phantom\{[^}]*\}/g, '');

  return sanitized;
}

function normalizeWhitespace(content: string): string {
  return content.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
}

// ── Utilities ──────────────────────────────────────────────────────────────

function getSeverityScore(severity: ThreatDetection['severity']): number {
  switch (severity) {
    case 'low': return 10;
    case 'medium': return 25;
    case 'high': return 50;
    case 'critical': return 100;
  }
}
