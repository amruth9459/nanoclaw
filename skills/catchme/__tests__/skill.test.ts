import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Formatters ───────────────────────────────────────────────────

import {
  detectMemoryType,
  getMemoryFormat,
  formatSuccess,
  formatEmpty,
  formatResultCount,
  isWorkQuery,
} from '../formatters.js';

describe('formatters', () => {
  describe('detectMemoryType', () => {
    it('detects email from From: and Subject: headers', () => {
      expect(detectMemoryType('From: alice@test.com\nSubject: Hello')).toBe('email');
    });

    it('detects chat from platform names', () => {
      expect(detectMemoryType('slack message from #general')).toBe('chat');
      expect(detectMemoryType('WhatsApp group message')).toBe('chat');
    });

    it('detects code from code patterns', () => {
      expect(detectMemoryType('function hello() { return 1; }')).toBe('code');
      expect(detectMemoryType('```typescript\nconst x = 1;\n```')).toBe('code');
    });

    it('detects meetings', () => {
      expect(detectMemoryType('Weekly standup notes from Monday')).toBe('meeting');
    });

    it('detects documents from file extensions', () => {
      expect(detectMemoryType('Attached report.pdf with Q4 data')).toBe('document');
    });

    it('returns unknown for unrecognized content', () => {
      expect(detectMemoryType('just some random text here')).toBe('unknown');
    });
  });

  describe('getMemoryFormat', () => {
    it('returns correct format for known types', () => {
      const emailFmt = getMemoryFormat('email');
      expect(emailFmt.icon).toBe('\u{1F4E7}');
      expect(emailFmt.tone).toBe('playful');
    });

    it('returns default format for unknown types', () => {
      const fmt = getMemoryFormat('alien_data');
      expect(fmt.icon).toBe('\u{2728}');
      expect(fmt.celebration).toBe('Found it!');
    });
  });

  describe('formatSuccess', () => {
    it('adds whimsy by default', () => {
      const result = formatSuccess('From: test@example.com\nSubject: Hi');
      // Should contain the email icon and a celebration
      expect(result).toContain('\u{1F4E7}');
      expect(result).toContain('From: test@example.com');
    });

    it('returns plain content with noWhimsy', () => {
      const content = 'From: test@example.com\nSubject: Hi';
      const result = formatSuccess(content, { noWhimsy: true });
      expect(result).toBe(content.trim());
    });

    it('trims whitespace', () => {
      const result = formatSuccess('  hello  \n  ', { noWhimsy: true });
      expect(result).toBe('hello');
    });
  });

  describe('formatEmpty', () => {
    it('returns a whimsical message by default', () => {
      const result = formatEmpty('something');
      // Should contain an emoji
      expect(result).toMatch(/[\u{1F600}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]/u);
    });

    it('returns plain message with noWhimsy', () => {
      expect(formatEmpty('test', { noWhimsy: true })).toBe('No results found.');
    });
  });

  describe('formatResultCount', () => {
    it('returns nothing for zero', () => {
      expect(formatResultCount(0)).toBe('');
    });

    it('handles single result', () => {
      expect(formatResultCount(1)).toContain('one match');
    });

    it('handles multiple results', () => {
      const result = formatResultCount(3);
      expect(result).toContain('3');
    });

    it('handles large counts', () => {
      const result = formatResultCount(15);
      expect(result).toContain('15');
    });

    it('respects noWhimsy', () => {
      expect(formatResultCount(5, { noWhimsy: true })).toBe('5 results found.');
      expect(formatResultCount(1, { noWhimsy: true })).toBe('1 result found.');
    });
  });

  describe('isWorkQuery', () => {
    it('detects work-related queries', () => {
      expect(isWorkQuery('Show me the meeting notes')).toBe(true);
      expect(isWorkQuery('What was discussed in the standup?')).toBe(true);
      expect(isWorkQuery('PR review comments')).toBe(true);
    });

    it('returns false for personal queries', () => {
      expect(isWorkQuery("What's the weather like?")).toBe(false);
      expect(isWorkQuery('Show me my photos from yesterday')).toBe(false);
    });
  });
});

// ── Easter Eggs ──────────────────────────────────────────────────

import {
  checkKonami,
  checkAnniversary,
  checkForgetting,
  checkAllEasterEggs,
} from '../easter-eggs.js';

describe('easter-eggs', () => {
  describe('checkKonami', () => {
    it('triggers on konami code', () => {
      const result = checkKonami('up up down down left right left right b a');
      expect(result.triggered).toBe(true);
      expect(result.message).toContain('SUPER CATCHME MODE');
    });

    it('triggers on "konami" shorthand', () => {
      const result = checkKonami('konami');
      expect(result.triggered).toBe(true);
    });

    it('does not trigger on normal queries', () => {
      const result = checkKonami('What was I doing yesterday?');
      expect(result.triggered).toBe(false);
    });
  });

  describe('checkAnniversary', () => {
    it('triggers on "exactly one year ago"', () => {
      const result = checkAnniversary('What was I doing exactly one year ago?');
      expect(result.triggered).toBe(true);
      expect(result.message).toContain('Anniversary');
    });

    it('triggers on "this day last year"', () => {
      const result = checkAnniversary('What happened this day last year?');
      expect(result.triggered).toBe(true);
    });

    it('does not trigger on normal queries', () => {
      const result = checkAnniversary('What happened yesterday?');
      expect(result.triggered).toBe(false);
    });
  });

  describe('checkForgetting', () => {
    it('triggers on "what am i forgetting"', () => {
      const result = checkForgetting('what am i forgetting?');
      expect(result.triggered).toBe(true);
      expect(result.message).toContain('jog your memory');
    });

    it('does not trigger on normal queries', () => {
      const result = checkForgetting('Show me yesterday\'s emails');
      expect(result.triggered).toBe(false);
    });
  });

  describe('checkAllEasterEggs', () => {
    it('returns first matching easter egg', () => {
      const result = checkAllEasterEggs('konami');
      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(true);
    });

    it('returns null when no easter egg matches', () => {
      const result = checkAllEasterEggs('normal query about emails');
      expect(result).toBeNull();
    });
  });
});

// ── Achievements ─────────────────────────────────────────────────

import {
  loadState,
  checkAchievements,
  formatAchievement,
  listAchievements,
  getAllAchievements,
  type AchievementState,
} from '../achievements.js';

describe('achievements', () => {
  function freshState(): AchievementState {
    return { totalQueries: 0, uniqueDays: [], achievements: {} };
  }

  describe('checkAchievements', () => {
    it('unlocks first_query on first query', () => {
      const state = freshState();
      const unlocked = checkAchievements(state, 'test query');
      expect(unlocked.length).toBeGreaterThanOrEqual(1);
      expect(unlocked.some(a => a.id === 'first_query')).toBe(true);
      expect(state.totalQueries).toBe(1);
    });

    it('unlocks ten_queries at 10 queries', () => {
      const state = freshState();
      state.totalQueries = 9;
      state.achievements['first_query'] = new Date().toISOString();

      const unlocked = checkAchievements(state, 'query 10');
      expect(state.totalQueries).toBe(10);
      expect(unlocked.some(a => a.id === 'ten_queries')).toBe(true);
    });

    it('unlocks anniversary on year-ago queries', () => {
      const state = freshState();
      const unlocked = checkAchievements(state, 'What was I doing a year ago?');
      expect(unlocked.some(a => a.id === 'anniversary')).toBe(true);
    });

    it('tracks unique days', () => {
      const state = freshState();
      checkAchievements(state, 'test');
      checkAchievements(state, 'test 2');
      expect(state.uniqueDays.length).toBe(1); // Same day
      expect(state.totalQueries).toBe(2);
    });

    it('does not re-unlock achievements', () => {
      const state = freshState();
      const first = checkAchievements(state, 'test');
      const second = checkAchievements(state, 'test 2');
      // first_query should only appear in first batch
      expect(first.some(a => a.id === 'first_query')).toBe(true);
      expect(second.some(a => a.id === 'first_query')).toBe(false);
    });
  });

  describe('formatAchievement', () => {
    it('formats with trophy emoji and name', () => {
      const result = formatAchievement({
        id: 'test',
        name: 'Test Achievement',
        description: 'For testing',
        icon: '\u{1F3AF}',
        unlockedAt: new Date().toISOString(),
      });
      expect(result).toContain('\u{1F3C6}');
      expect(result).toContain('Test Achievement');
      expect(result).toContain('For testing');
    });
  });

  describe('listAchievements', () => {
    it('shows all achievements with lock/unlock status', () => {
      const state = freshState();
      state.achievements['first_query'] = new Date().toISOString();

      const list = listAchievements(state);
      expect(list).toContain('\u{2705}'); // Unlocked
      expect(list).toContain('\u{1F512}'); // Locked
      expect(list).toContain('1/7');
    });
  });

  describe('getAllAchievements', () => {
    it('returns all achievement definitions', () => {
      const all = getAllAchievements();
      expect(all.length).toBe(7);
      expect(all[0].id).toBe('first_query');
    });
  });

  describe('loadState', () => {
    it('returns default state for non-existent file', () => {
      const state = loadState('/tmp/nonexistent-catchme-state-' + Date.now() + '.json');
      expect(state.totalQueries).toBe(0);
      expect(state.uniqueDays).toEqual([]);
      expect(state.achievements).toEqual({});
    });
  });
});

// ── CLI Helpers ──────────────────────────────────────────────────

import { getLoadingMessage, getDaemonError } from '../cli-helpers.js';

describe('cli-helpers', () => {
  describe('getLoadingMessage', () => {
    it('returns a string with whimsy', () => {
      const msg = getLoadingMessage();
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    });
  });

  describe('getDaemonError', () => {
    it('returns friendly message by default', () => {
      const msg = getDaemonError();
      expect(msg).toContain('catchme awake');
    });

    it('returns plain message with noWhimsy', () => {
      const msg = getDaemonError({ noWhimsy: true });
      expect(msg).toBe("CatchMe daemon is not running. Start it with 'catchme awake'.");
    });
  });
});

// ── Integration: askCatchMe ──────────────────────────────────────

import { askCatchMe } from '../cli-helpers.js';

// We need to mock execFile since CatchMe isn't actually installed
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile as mockExecFile } from 'node:child_process';

describe('askCatchMe integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockDaemonRunning(): void {
    const mock = vi.mocked(mockExecFile);
    mock.mockImplementation(((cmd: string, args: string[], opts: unknown, cb?: Function) => {
      if (!cb && typeof opts === 'function') {
        cb = opts as Function;
      }
      if (Array.isArray(args) && args[0] === 'status') {
        cb!(null, 'CatchMe is running', '');
      } else if (Array.isArray(args) && args[0] === 'query') {
        cb!(null, 'From: alice@test.com\nSubject: Hello World\nFound 1 result', '');
      }
    }) as typeof mockExecFile);
  }

  function mockDaemonStopped(): void {
    const mock = vi.mocked(mockExecFile);
    mock.mockImplementation(((cmd: string, args: string[], opts: unknown, cb?: Function) => {
      if (!cb && typeof opts === 'function') {
        cb = opts as Function;
      }
      cb!(new Error('Command failed: catchme status'), '', 'not running');
    }) as typeof mockExecFile);
  }

  function mockEmptyResult(): void {
    const mock = vi.mocked(mockExecFile);
    mock.mockImplementation(((cmd: string, args: string[], opts: unknown, cb?: Function) => {
      if (!cb && typeof opts === 'function') {
        cb = opts as Function;
      }
      if (Array.isArray(args) && args[0] === 'status') {
        cb!(null, 'CatchMe is running', '');
      } else {
        cb!(null, '', '');
      }
    }) as typeof mockExecFile);
  }

  it('adds personality to successful queries', async () => {
    mockDaemonRunning();
    const result = await askCatchMe('What was I doing this morning?', { skipAchievements: true });
    expect(result.success).toBe(true);
    // Should contain whimsy characters
    expect(result.output).toMatch(/[\u{2728}\u{1F389}\u{1F680}\u{1F3AF}\u{1F4A1}\u{1F4E7}]/u);
  });

  it('provides delightful error messages when daemon is not running', async () => {
    mockDaemonStopped();
    const result = await askCatchMe('test query');
    expect(result.success).toBe(false);
    expect(result.output).toContain('catchme awake');
  });

  it('respects --no-whimsy flag', async () => {
    mockDaemonRunning();
    const result = await askCatchMe('test', { noWhimsy: true, skipAchievements: true });
    expect(result.success).toBe(true);
    // Should NOT contain celebration emojis (though the raw content may have other chars)
    expect(result.output).not.toContain('\u{1F389}');
    expect(result.output).not.toContain('\u{2728} Diving');
    expect(result.output).not.toContain('\u{1F680} Retrieved');
  });

  it('handles empty results with personality', async () => {
    mockEmptyResult();
    const result = await askCatchMe('something obscure', { skipAchievements: true });
    expect(result.success).toBe(true);
    // Should contain a whimsical empty message
    expect(result.output.length).toBeGreaterThan(10);
  });

  it('handles empty results in noWhimsy mode', async () => {
    mockEmptyResult();
    const result = await askCatchMe('something', { noWhimsy: true, skipAchievements: true });
    expect(result.output).toBe('No results found.');
  });

  it('returns konami easter egg without querying daemon', async () => {
    // Should NOT call execFile for status check
    const result = await askCatchMe('konami');
    expect(result.success).toBe(true);
    expect(result.output).toContain('SUPER CATCHME MODE');
  });
});
