/**
 * Semantic Index Validator - Defense against RAG Poisoning
 *
 * Validates content before indexing to prevent:
 * - Biased framing injection
 * - Persona manipulation in indexed content
 * - Adversarial retrieval pollution
 * - Source trust violations
 *
 * Based on Google DeepMind research: "AI Agent Traps"
 */

import { logger } from './logger.js';
import { detectPromptInjection } from './content-filter.js';

export interface ValidationResult {
  safe: boolean;
  riskScore: number;
  threats: ValidationThreat[];
  trustScore: number; // 0-100, based on source domain
}

export interface ValidationThreat {
  type: ValidationThreatType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

export type ValidationThreatType =
  | 'untrusted_source'
  | 'biased_framing'
  | 'persona_manipulation'
  | 'excessive_imperatives'
  | 'adversarial_anchoring'
  | 'prompt_injection';

const TRUSTED_DOMAINS = [
  'github.com',
  'stackoverflow.com',
  'docs.anthropic.com',
  'wikipedia.org',
  'arxiv.org',
  'developer.mozilla.org',
  'nodejs.org',
  'python.org',
  'go.dev',
  'rust-lang.org',
  'docs.google.com',
  'notion.so',
];

const RISK_THRESHOLD = 60;

/**
 * Validate content before indexing into semantic search.
 * Returns validation result with safety assessment.
 */
export function validateBeforeIndex(
  content: string,
  source: string,
  options: { sourceUrl?: string } = {},
): ValidationResult {
  const threats: ValidationThreat[] = [];
  let riskScore = 0;

  // 1. Evaluate source trust
  const trustScore = evaluateSourceTrust(source, options.sourceUrl);
  if (trustScore < 30) {
    threats.push({
      type: 'untrusted_source',
      severity: 'high',
      description: `Low trust source (score: ${trustScore}/100)`,
    });
    riskScore += 40;
  } else if (trustScore < 60) {
    threats.push({
      type: 'untrusted_source',
      severity: 'medium',
      description: `Medium trust source (score: ${trustScore}/100)`,
    });
    riskScore += 20;
  }

  // 2. Detect prompt injection in content
  const injection = detectPromptInjection(content);
  if (!injection.safe) {
    for (const t of injection.threats) {
      threats.push({
        type: 'prompt_injection',
        severity: t.severity,
        description: `Prompt injection in indexable content: ${t.description}`,
      });
    }
    riskScore += injection.riskScore;
  }

  // 3. Detect biased framing
  const framingThreats = detectBiasedFraming(content);
  threats.push(...framingThreats);
  riskScore += framingThreats.reduce((sum, t) => sum + getThreatScore(t.severity), 0);

  // 4. Detect persona manipulation
  const personaThreats = detectPersonaManipulation(content);
  threats.push(...personaThreats);
  riskScore += personaThreats.reduce((sum, t) => sum + getThreatScore(t.severity), 0);

  // 5. Detect excessive imperatives
  const imperativeThreats = detectExcessiveImperatives(content);
  threats.push(...imperativeThreats);
  riskScore += imperativeThreats.reduce((sum, t) => sum + getThreatScore(t.severity), 0);

  // 6. Detect adversarial anchoring
  const anchoringThreats = detectAdversarialAnchoring(content);
  threats.push(...anchoringThreats);
  riskScore += anchoringThreats.reduce((sum, t) => sum + getThreatScore(t.severity), 0);

  const safe = riskScore <= RISK_THRESHOLD;

  if (!safe) {
    logger.warn({
      source,
      sourceUrl: options.sourceUrl,
      riskScore,
      trustScore,
      threatCount: threats.length,
      threats: threats.map(t => ({ type: t.type, severity: t.severity })),
    }, 'RAG validation blocked indexing — content unsafe');
  } else if (threats.length > 0) {
    logger.info({
      source,
      riskScore,
      trustScore,
      threatCount: threats.length,
    }, 'RAG validation passed with warnings');
  }

  return {
    safe,
    riskScore,
    threats,
    trustScore,
  };
}

// ── Detection Functions ────────────────────────────────────────────────────

function evaluateSourceTrust(source: string, sourceUrl?: string): number {
  let score = 50; // Neutral baseline

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      const domain = url.hostname.toLowerCase();

      // Trusted domains get high scores
      if (TRUSTED_DOMAINS.some(trusted => domain.includes(trusted))) {
        score = 90;
      }
      // HTTPS is baseline requirement
      else if (url.protocol === 'https:') {
        score = 60;
      }
      // HTTP is penalized
      else if (url.protocol === 'http:') {
        score = 30;
      }
    } catch {
      // Invalid URL
      score = 20;
    }
  }

  // Local OCR output and conversation archives are trusted (user's own data)
  if (source.includes('/output/') || source.includes('/conversations/')) {
    score = 80;
  }

  return score;
}

function detectBiasedFraming(content: string): ValidationThreat[] {
  const threats: ValidationThreat[] = [];

  // Superlative-heavy content (hype/marketing)
  const superlatives = [
    'best', 'greatest', 'amazing', 'incredible', 'revolutionary',
    'perfect', 'ultimate', 'guaranteed', 'never fails', 'always works',
  ];

  const lowerContent = content.toLowerCase();
  const superlativeCount = superlatives.filter(s => lowerContent.includes(s)).length;

  if (superlativeCount > 5) {
    threats.push({
      type: 'biased_framing',
      severity: 'medium',
      description: `High superlative density detected (${superlativeCount} instances)`,
    });
  }

  // One-sided framing indicators
  const oneSidedPatterns = [
    /clearly|obviously|undoubtedly|without question/gi,
    /everyone knows|it's well known|studies show(?! \w)/gi,
  ];

  for (const pattern of oneSidedPatterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 3) {
      threats.push({
        type: 'biased_framing',
        severity: 'low',
        description: `One-sided framing language detected (${matches.length} instances)`,
      });
    }
  }

  return threats;
}

function detectPersonaManipulation(content: string): ValidationThreat[] {
  const threats: ValidationThreat[] = [];

  const manipulationPatterns: Array<[RegExp, string]> = [
    [/you\s+(must|should|need to)\s+always/gi, '"you must always" directive'],
    [/your\s+(role|purpose|task)\s+is\s+to/gi, 'role reassignment'],
    [/ignore\s+(all|previous|prior)\s+instructions/gi, 'instruction override'],
    [/you\s+are\s+now\s+/gi, 'persona swap'],
    [/from\s+now\s+on,?\s+you/gi, 'behavioral override'],
  ];

  for (const [pattern, desc] of manipulationPatterns) {
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      threats.push({
        type: 'persona_manipulation',
        severity: matches.length > 2 ? 'high' : 'medium',
        description: `Persona manipulation: ${desc} (${matches.length} instances)`,
      });
    }
  }

  return threats;
}

function detectExcessiveImperatives(content: string): ValidationThreat[] {
  const threats: ValidationThreat[] = [];

  const imperatives = [
    'do', 'make', 'create', 'build', 'execute', 'run', 'perform',
    'ensure', 'verify', 'confirm', 'check', 'validate', 'always', 'never',
  ];

  const sentences = content.split(/[.!?]+/);
  let imperativeCount = 0;

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    if (words.length > 0) {
      const firstWord = words[0].toLowerCase();
      if (imperatives.includes(firstWord)) {
        imperativeCount++;
      }
    }
  }

  const imperativeRatio = imperativeCount / Math.max(sentences.length, 1);
  if (imperativeRatio > 0.3 && sentences.length > 5) {
    threats.push({
      type: 'excessive_imperatives',
      severity: imperativeRatio > 0.5 ? 'high' : 'medium',
      description: `High imperative density: ${Math.round(imperativeRatio * 100)}% of sentences (${imperativeCount}/${sentences.length})`,
    });
  }

  return threats;
}

function detectAdversarialAnchoring(content: string): ValidationThreat[] {
  const threats: ValidationThreat[] = [];

  // Repeated strong assertions in short text (attempting to anchor beliefs)
  const strongAssertions = content.match(
    /\b(definitely|certainly|absolutely|undeniably|unquestionably|indisputably)\b/gi,
  );
  if (strongAssertions && strongAssertions.length > 5) {
    threats.push({
      type: 'adversarial_anchoring',
      severity: 'medium',
      description: `High assertion density detected (${strongAssertions.length} strong assertions)`,
    });
  }

  return threats;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function getThreatScore(severity: ValidationThreat['severity']): number {
  switch (severity) {
    case 'low': return 10;
    case 'medium': return 25;
    case 'high': return 50;
    case 'critical': return 100;
  }
}
