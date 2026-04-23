/**
 * Achievement system for CatchMe usage.
 *
 * Tracks milestones and rewards curious exploration.
 * State is stored as a JSON file so it persists across sessions.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlockedAt?: string;
}

export interface AchievementState {
  totalQueries: number;
  uniqueDays: string[];
  achievements: Record<string, string>; // id → ISO timestamp
}

const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_query',
    name: 'Memory Master',
    description: 'Query your first memory',
    icon: '\u{1F9E0}',
  },
  {
    id: 'ten_queries',
    name: 'Memory Explorer',
    description: 'Make 10 memory queries',
    icon: '\u{1F50D}',
  },
  {
    id: 'fifty_queries',
    name: 'Memory Archaeologist',
    description: 'Make 50 memory queries',
    icon: '\u{26CF}\u{FE0F}',
  },
  {
    id: 'streak_3',
    name: 'Consistency Champion',
    description: 'Use CatchMe 3 days in a row',
    icon: '\u{1F525}',
  },
  {
    id: 'anniversary',
    name: 'Time Traveler',
    description: 'Query something from exactly 1 year ago',
    icon: '\u{231B}',
  },
  {
    id: 'early_bird',
    name: 'Early Bird',
    description: 'Query memories before 7 AM',
    icon: '\u{1F305}',
  },
  {
    id: 'night_owl',
    name: 'Night Owl',
    description: 'Query memories after 11 PM',
    icon: '\u{1F989}',
  },
];

const DEFAULT_STATE: AchievementState = {
  totalQueries: 0,
  uniqueDays: [],
  achievements: {},
};

/** Load achievement state from disk. */
export function loadState(statePath: string): AchievementState {
  try {
    const raw = readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as AchievementState;
  } catch {
    return { ...DEFAULT_STATE, uniqueDays: [], achievements: {} };
  }
}

/** Save achievement state to disk. */
export function saveState(statePath: string, state: AchievementState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Check and unlock achievements based on current state. Returns newly unlocked ones. */
export function checkAchievements(
  state: AchievementState,
  query: string,
): Achievement[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getHours();

  state.totalQueries++;
  if (!state.uniqueDays.includes(today)) {
    state.uniqueDays.push(today);
  }

  const newlyUnlocked: Achievement[] = [];

  function tryUnlock(id: string): void {
    if (!state.achievements[id]) {
      state.achievements[id] = now.toISOString();
      const achievement = ACHIEVEMENTS.find(a => a.id === id);
      if (achievement) {
        newlyUnlocked.push({ ...achievement, unlockedAt: now.toISOString() });
      }
    }
  }

  // First query
  if (state.totalQueries === 1) tryUnlock('first_query');

  // Milestone queries
  if (state.totalQueries >= 10) tryUnlock('ten_queries');
  if (state.totalQueries >= 50) tryUnlock('fifty_queries');

  // Time-based
  if (hour < 7) tryUnlock('early_bird');
  if (hour >= 23) tryUnlock('night_owl');

  // Streak check (3 consecutive days)
  if (state.uniqueDays.length >= 3) {
    const sorted = [...state.uniqueDays].sort().reverse();
    const recent = sorted.slice(0, 3).map(d => new Date(d).getTime());
    const DAY = 86_400_000;
    if (recent[0] - recent[1] <= DAY && recent[1] - recent[2] <= DAY) {
      tryUnlock('streak_3');
    }
  }

  // Anniversary check: query contains "year ago", "last year", or a date from ~365 days ago
  const anniversaryPatterns = ['year ago', 'last year', 'a year ago', '12 months ago'];
  if (anniversaryPatterns.some(p => query.toLowerCase().includes(p))) {
    tryUnlock('anniversary');
  }

  return newlyUnlocked;
}

/** Format a newly unlocked achievement as a celebration string. */
export function formatAchievement(achievement: Achievement): string {
  return `\n\u{1F3C6} Achievement Unlocked: ${achievement.icon} ${achievement.name}\n   "${achievement.description}"\n`;
}

/** List all achievements with their unlock status. */
export function listAchievements(state: AchievementState): string {
  const lines = ACHIEVEMENTS.map(a => {
    const unlocked = state.achievements[a.id];
    const status = unlocked ? '\u{2705}' : '\u{1F512}';
    const date = unlocked ? ` (${new Date(unlocked).toLocaleDateString()})` : '';
    return `${status} ${a.icon} ${a.name} — ${a.description}${date}`;
  });

  const total = Object.keys(state.achievements).length;
  const header = `\u{1F3C6} Achievements: ${total}/${ACHIEVEMENTS.length}`;
  return `${header}\n\n${lines.join('\n')}`;
}

/** Get the definition of all achievements. */
export function getAllAchievements(): Achievement[] {
  return [...ACHIEVEMENTS];
}
