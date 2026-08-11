/**
 * Request Classifier
 * Classifies incoming requests as simple/complex/team-worthy.
 * All tasks require planning (requiresPlanning: true always).
 *
 * Uses heuristic-based classification (keyword matching + prompt analysis).
 * No API call needed — instant classification.
 */

export interface RequestClassification {
  complexity: 'simple' | 'complex' | 'team-worthy';
  requiresPlanning: true; // ALWAYS TRUE per user requirement
  shouldUseTeams: boolean;
  estimatedTurns: number;
  reasoning: string;
}

// Keywords that indicate team-worthy complexity
const TEAM_KEYWORDS = [
  'build .* system',
  'implement .* architecture',
  'create .* platform',
  'build \\d+ ',
  'multiple.*projects',
  'full.stack',
  'end.to.end',
  'microservice',
  'redesign',
  'migrate',
  'refactor.*entire',
  'overhaul',
  'mvp',
];

// Keywords that indicate complex tasks
const COMPLEX_KEYWORDS = [
  'implement',
  'create.*feature',
  'build',
  'design',
  'refactor',
  'optimize',
  'integrate',
  'authentication',
  'database',
  'api.*endpoint',
  'test.*suite',
  'deploy',
  'pipeline',
  'performance',
  'security.*audit',
  'debug.*complex',
  'investigate',
  'analyze.*codebase',
];

// Keywords that indicate simple tasks
const SIMPLE_KEYWORDS = [
  'fix.*typo',
  'add.*comment',
  'rename',
  'update.*version',
  'change.*color',
  'console\\.log',
  'add.*import',
  'remove.*unused',
  'format',
  'lint',
  'what.*does',
  'explain',
  'show.*me',
  'list.*files',
  'read.*file',
  'check.*status',
];

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some(p => new RegExp(p, 'i').test(lower));
}

function countIndicators(text: string): { files: number; steps: number; technologies: number } {
  const lower = text.toLowerCase();

  // Count file references
  const filePatterns = /\b[\w-]+\.(ts|js|py|tsx|jsx|css|html|md|json|yaml|yml|toml|sql)\b/gi;
  const files = (lower.match(filePatterns) || []).length;

  // Count step indicators (numbered lists, "then", "after that", "next")
  const stepPatterns = /\b(then|next|after that|step \d|finally|first|second|third|\d\.\s)/gi;
  const steps = (lower.match(stepPatterns) || []).length;

  // Count technology references
  const techPatterns = /\b(react|vue|angular|node|python|docker|kubernetes|redis|postgres|mongodb|graphql|rest|grpc|websocket|oauth|jwt|webpack|vite|tailwind|prisma)\b/gi;
  const technologies = (lower.match(techPatterns) || []).length;

  return { files, steps, technologies };
}

export function classifyRequest(prompt: string): RequestClassification {
  const trimmed = prompt.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const indicators = countIndicators(trimmed);

  // Team-worthy: multiple technologies, many files, or explicit team keywords
  if (
    matchesAny(trimmed, TEAM_KEYWORDS) ||
    (indicators.technologies >= 3 && indicators.files >= 3) ||
    (indicators.steps >= 5 && wordCount > 100) ||
    wordCount > 500
  ) {
    return {
      complexity: 'team-worthy',
      requiresPlanning: true,
      shouldUseTeams: true,
      estimatedTurns: Math.max(20, Math.min(50, wordCount / 5)),
      reasoning: `Team-worthy: ${indicators.technologies} technologies, ${indicators.files} files referenced, ${indicators.steps} steps detected, ${wordCount} words`,
    };
  }

  // Simple: short prompts with simple keywords, few indicators
  if (
    (matchesAny(trimmed, SIMPLE_KEYWORDS) && wordCount < 30) ||
    (wordCount < 15 && indicators.files <= 1 && indicators.steps === 0)
  ) {
    return {
      complexity: 'simple',
      requiresPlanning: true,
      shouldUseTeams: false,
      estimatedTurns: Math.max(3, Math.min(8, wordCount / 2)),
      reasoning: `Simple task: ${wordCount} words, ${indicators.files} files, matches simple pattern`,
    };
  }

  // Complex: everything else, or explicit complex keywords
  const isExplicitComplex = matchesAny(trimmed, COMPLEX_KEYWORDS);
  return {
    complexity: 'complex',
    requiresPlanning: true,
    shouldUseTeams: false,
    estimatedTurns: Math.max(8, Math.min(30, wordCount / 3)),
    reasoning: `Complex task: ${wordCount} words, ${indicators.files} files, ${indicators.technologies} technologies${isExplicitComplex ? ', matches complex keywords' : ''}`,
  };
}
