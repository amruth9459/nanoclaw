/**
 * Model Selector
 * Automatically selects Opus or Sonnet based on task complexity.
 *
 * Opus: Lexios work, reasoning, planning, strategizing, complex analysis
 * Sonnet: Routine tasks, status checks, simple lookups
 *
 * Scoring: Lexios group +10, Opus keywords +2 each, Sonnet keywords -1 each.
 * Threshold: score >= 5 → Opus, else Sonnet.
 */

const OPUS_MODEL = 'claude-opus-4-6';
const SONNET_MODEL = 'claude-sonnet-4-5';

const OPUS_KEYWORDS = [
  'analyze', 'reason', 'plan', 'strategy', 'design', 'architect',
  'competitive', 'evaluate', 'research', 'debug', 'optimize', 'refactor',
  'assess', 'investigate', 'implement', 'build', 'create', 'review',
  'compare', 'synthesize',
];

const SONNET_KEYWORDS = [
  'status', 'list', 'show', 'get', 'read', 'check', 'find', 'search',
  'count', 'fetch', 'display', 'print', 'log', 'echo',
];

const LEXIOS_GROUP_PREFIXES = ['claw-lexios', 'lexios-'];

const OPUS_THRESHOLD = 5;

function isLexiosGroup(groupFolder: string): boolean {
  const lower = groupFolder.toLowerCase();
  return LEXIOS_GROUP_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function countKeywordMatches(prompt: string, keywords: string[]): number {
  const lower = prompt.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    // Match whole word boundaries to avoid false positives
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(lower)) {
      count++;
    }
  }
  return count;
}

export function selectModel(
  groupFolder: string,
  prompt: string,
  isScheduledTask?: boolean,
): string {
  let score = 0;

  // Lexios groups get a strong Opus signal
  if (isLexiosGroup(groupFolder)) {
    score += 10;
  }

  // Score based on keyword matches
  const opusMatches = countKeywordMatches(prompt, OPUS_KEYWORDS);
  const sonnetMatches = countKeywordMatches(prompt, SONNET_KEYWORDS);

  score += opusMatches * 2;
  score -= sonnetMatches * 1;

  // Scheduled tasks are usually routine — slight Sonnet bias
  if (isScheduledTask) {
    score -= 2;
  }

  return score >= OPUS_THRESHOLD ? OPUS_MODEL : SONNET_MODEL;
}

export function getSelectionReason(
  model: string,
  groupFolder: string,
  prompt: string,
): string {
  const parts: string[] = [];

  if (isLexiosGroup(groupFolder)) {
    parts.push('lexios-group');
  }

  const opusMatches = OPUS_KEYWORDS.filter(kw =>
    new RegExp(`\\b${kw}\\b`, 'i').test(prompt),
  );
  const sonnetMatches = SONNET_KEYWORDS.filter(kw =>
    new RegExp(`\\b${kw}\\b`, 'i').test(prompt),
  );

  if (opusMatches.length > 0) {
    parts.push(`opus-kw:[${opusMatches.join(',')}]`);
  }
  if (sonnetMatches.length > 0) {
    parts.push(`sonnet-kw:[${sonnetMatches.join(',')}]`);
  }

  if (parts.length === 0) {
    parts.push('default');
  }

  return `${model === OPUS_MODEL ? 'opus' : 'sonnet'}: ${parts.join(', ')}`;
}
