# CatchMe Skill: Your Personal Memory Companion

> "Remember everything, forget nothing, smile always"

Transform your AI agent into a delightful memory companion with CatchMe integration.

## Prerequisites

CatchMe daemon must be running locally. This skill does **not** manage the daemon lifecycle.

```bash
# Wake up your memories
catchme awake
```

## Quick Start

Once CatchMe is running, ask your agent anything:

```
"What was I working on this morning?"
"Show me all my emails from yesterday"
"What meetings do I have today?"
```

## Features

### Personality Modes

Queries are automatically classified:
- **Work queries** (meetings, PRs, deadlines) get a professional prefix
- **Personal queries** get playful, encouraging responses
- Use `--no-whimsy` for minimal, plain output

### Achievement System

Unlock achievements as you explore your memories:

| Achievement | How to Unlock |
|-------------|--------------|
| Memory Master | Query your first memory |
| Memory Explorer | Make 10 queries |
| Memory Archaeologist | Make 50 queries |
| Consistency Champion | Use CatchMe 3 days in a row |
| Time Traveler | Query something from exactly 1 year ago |
| Early Bird | Query before 7 AM |
| Night Owl | Query after 11 PM |

### Easter Eggs

Hidden features for the curious. Hints:
- Classic gaming sequences still work here
- Anniversaries are worth celebrating
- Asking what you're forgetting triggers something helpful

### Error States

Friendly messages when things don't go as planned:
- Daemon not running: helpful wake-up instructions
- Timeout: suggestion to simplify the query
- Empty results: encouraging message to try something else

## API

```typescript
import { query, status, achievements, loading } from './skill.js';

// Query memories
const result = await query('What emails did I get today?');

// Check daemon health
const health = await status();

// View achievement progress
const progress = achievements();

// Get a loading message for display
const msg = loading();
```

### Options

```typescript
query('test', {
  noWhimsy: true,    // Minimal output, no emojis
  timeout: 60_000,   // Custom timeout (ms)
  statePath: '...',  // Custom achievement state file path
});
```

## File Structure

```
skills/catchme/
  skill.ts          Main skill entry point
  cli-helpers.ts    CatchMe CLI execution + daemon checks
  formatters.ts     Response formatting with personality
  achievements.ts   Achievement system with persistence
  easter-eggs.ts    Hidden delights
  __tests__/
    skill.test.ts   Comprehensive test suite
  README.md         This file
```

## Testing

```bash
npx vitest run skills/catchme/
```
