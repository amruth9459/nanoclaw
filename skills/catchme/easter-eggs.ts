/**
 * Easter eggs and hidden delights for CatchMe.
 *
 * Rewards curious users with unexpected moments of joy.
 */

export interface EasterEggResult {
  triggered: boolean;
  message: string;
}

const KONAMI_SEQUENCE = 'up up down down left right left right b a';

/** Check if the query triggers a Konami code easter egg. */
export function checkKonami(query: string): EasterEggResult {
  const normalized = query.toLowerCase().trim();
  if (normalized === KONAMI_SEQUENCE || normalized === 'konami') {
    return {
      triggered: true,
      message: [
        '\u{1F3AE} \u{2728} SUPER CATCHME MODE ACTIVATED \u{2728} \u{1F3AE}',
        '',
        '  \u{2591}\u{2592}\u{2593}\u{2588} POWER LEVEL: OVER 9000 \u{2588}\u{2593}\u{2592}\u{2591}',
        '',
        '  Your memory recall is now legendary.',
        '  All queries return with extra sparkle.',
        '  (Just kidding, but you found the secret! \u{1F60E})',
      ].join('\n'),
    };
  }
  return { triggered: false, message: '' };
}

/** Check if the query asks about something from exactly one year ago. */
export function checkAnniversary(query: string): EasterEggResult {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(now.getFullYear() - 1);

  const dateStr = oneYearAgo.toISOString().slice(0, 10);
  const monthDay = oneYearAgo.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const patterns = [
    'exactly one year ago',
    'exactly 1 year ago',
    'this day last year',
    `on ${dateStr}`,
    'year ago today',
  ];

  if (patterns.some(p => query.toLowerCase().includes(p))) {
    return {
      triggered: true,
      message: [
        `\u{1F382} Memory Anniversary! \u{1F382}`,
        '',
        `On this day (${monthDay}), one year ago...`,
        'Let me find what you were up to:',
        '',
      ].join('\n'),
    };
  }
  return { triggered: false, message: '' };
}

/** Check for "what am I forgetting" style queries. */
export function checkForgetting(query: string): EasterEggResult {
  const patterns = [
    'what am i forgetting',
    'what did i forget',
    'am i forgetting something',
    "what's slipping my mind",
  ];

  if (patterns.some(p => query.toLowerCase().includes(p))) {
    return {
      triggered: true,
      message: [
        "\u{1F914} Let me jog your memory...",
        '',
        "Here's what's been on your plate recently:",
        '',
      ].join('\n'),
    };
  }
  return { triggered: false, message: '' };
}

/** Run all easter egg checks against a query. Returns the first triggered one, or null. */
export function checkAllEasterEggs(query: string): EasterEggResult | null {
  const checks = [checkKonami, checkAnniversary, checkForgetting];
  for (const check of checks) {
    const result = check(query);
    if (result.triggered) return result;
  }
  return null;
}
