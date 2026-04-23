/**
 * Whimsical response formatting for CatchMe memory results.
 *
 * Transforms raw CLI output into engaging, personality-rich messages.
 * Respects --no-whimsy mode for minimal output.
 */

export type Tone = 'playful' | 'professional' | 'excited';

export interface MemoryFormat {
  icon: string;
  celebration: string;
  tone: Tone;
}

export interface FormatOptions {
  noWhimsy?: boolean;
}

const MEMORY_TYPE_MAP: Record<string, MemoryFormat> = {
  email: { icon: '\u{1F4E7}', celebration: 'Inbox treasure found!', tone: 'playful' },
  chat: { icon: '\u{1F4AC}', celebration: 'Conversation recovered!', tone: 'playful' },
  document: { icon: '\u{1F4C4}', celebration: 'Document unearthed!', tone: 'professional' },
  calendar: { icon: '\u{1F4C5}', celebration: 'Event spotted!', tone: 'professional' },
  note: { icon: '\u{1F4DD}', celebration: 'Note retrieved!', tone: 'playful' },
  code: { icon: '\u{1F4BB}', celebration: 'Code snippet located!', tone: 'professional' },
  meeting: { icon: '\u{1F91D}', celebration: 'Meeting notes found!', tone: 'professional' },
  browser: { icon: '\u{1F310}', celebration: 'Web memory surfaced!', tone: 'playful' },
  file: { icon: '\u{1F4C1}', celebration: 'File discovered!', tone: 'professional' },
  screenshot: { icon: '\u{1F4F8}', celebration: 'Visual memory captured!', tone: 'excited' },
};

const DEFAULT_FORMAT: MemoryFormat = {
  icon: '\u{2728}',
  celebration: 'Found it!',
  tone: 'playful',
};

const SUCCESS_CELEBRATIONS = [
  '\u{1F389} Found it!',
  '\u{2728} Memory unlocked!',
  '\u{1F680} Retrieved at warp speed!',
  '\u{1F3AF} Bullseye! Here it is:',
  '\u{1F4A1} Eureka!',
];

const EMPTY_MESSAGES = [
  "Hmm, I don't recall anything about that. Maybe it's a new adventure? \u{1F680}",
  "Drawing a blank on that one. Your future self might know! \u{1F52E}",
  "Nothing in the memory banks for that. Shall we make some new memories? \u{1F31F}",
  "That's uncharted territory in my memory. Time to explore? \u{1F5FA}\u{FE0F}",
];

/** Detect the memory type from CatchMe output content. */
export function detectMemoryType(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('from:') && lower.includes('subject:')) return 'email';
  if (lower.includes('slack') || lower.includes('discord') || lower.includes('whatsapp')) return 'chat';
  if (lower.includes('.pdf') || lower.includes('.docx') || lower.includes('.doc')) return 'document';
  if (lower.includes('meeting') || lower.includes('standup') || lower.includes('sync')) return 'meeting';
  if (lower.includes('calendar') || lower.includes('event') || lower.includes('invite')) return 'calendar';
  if (lower.includes('```') || lower.includes('function') || lower.includes('class ')) return 'code';
  if (lower.includes('screenshot') || lower.includes('.png') || lower.includes('.jpg')) return 'screenshot';
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('browser')) return 'browser';
  if (lower.includes('note') || lower.includes('todo') || lower.includes('reminder')) return 'note';
  if (lower.includes('file') || lower.includes('folder') || lower.includes('directory')) return 'file';
  return 'unknown';
}

/** Get the format config for a memory type. */
export function getMemoryFormat(memoryType: string): MemoryFormat {
  return MEMORY_TYPE_MAP[memoryType] ?? DEFAULT_FORMAT;
}

/** Pick a deterministic-ish item from an array based on content hash. */
function pickFromArray(arr: readonly string[], seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return arr[Math.abs(hash) % arr.length];
}

/** Format a successful CatchMe result with whimsy. */
export function formatSuccess(content: string, opts: FormatOptions = {}): string {
  if (opts.noWhimsy) {
    return content.trim();
  }

  const memoryType = detectMemoryType(content);
  const fmt = getMemoryFormat(memoryType);
  const celebration = pickFromArray(SUCCESS_CELEBRATIONS, content);

  return `${fmt.icon} ${celebration}\n\n${content.trim()}`;
}

/** Format an empty result with personality. */
export function formatEmpty(query: string, opts: FormatOptions = {}): string {
  if (opts.noWhimsy) {
    return 'No results found.';
  }
  return pickFromArray(EMPTY_MESSAGES, query);
}

/** Format a count summary with whimsy. */
export function formatResultCount(count: number, opts: FormatOptions = {}): string {
  if (opts.noWhimsy) {
    return `${count} result${count === 1 ? '' : 's'} found.`;
  }

  if (count === 0) return '';
  if (count === 1) return '\u{1F3AF} Found exactly one match:';
  if (count <= 5) return `\u{2728} Found ${count} memories:`;
  return `\u{1F4DA} Wow, ${count} memories surfaced!`;
}

/** Detect if a query is work-related (use professional tone). */
export function isWorkQuery(query: string): boolean {
  const workKeywords = [
    'meeting', 'project', 'deadline', 'client', 'report',
    'standup', 'sprint', 'ticket', 'jira', 'pr ', 'pull request',
    'deploy', 'production', 'release', 'budget', 'invoice',
  ];
  const lower = query.toLowerCase();
  return workKeywords.some(kw => lower.includes(kw));
}
