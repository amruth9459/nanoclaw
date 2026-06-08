import { describe, it, expect } from 'vitest';

import {
  BoundedMemory,
  toOneLine,
  toIntScore,
  estimateTokensInt,
  topN,
} from './BoundedMemory.js';

describe('toOneLine', () => {
  it('collapses newlines and whitespace into a single line', () => {
    const out = toOneLine('hello\n\n  world\t\tagain');
    expect(out).toBe('hello world again');
    expect(out).not.toContain('\n');
  });

  it('caps length with an ellipsis', () => {
    const out = toOneLine('x'.repeat(200), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty/garbage input', () => {
    expect(toOneLine('')).toBe('');
    expect(toOneLine('   \n  ')).toBe('');
  });
});

describe('toIntScore', () => {
  it('scales a 0..1 float to an integer 0..100', () => {
    expect(toIntScore(0.85)).toBe(85);
    expect(toIntScore(1)).toBe(100);
    expect(toIntScore(0)).toBe(0);
  });

  it('treats values >1 as integer percentages and clamps', () => {
    expect(toIntScore(72)).toBe(72);
    expect(toIntScore(150)).toBe(100);
    expect(toIntScore(-5)).toBe(0);
  });

  it('returns 0 for non-finite input', () => {
    expect(toIntScore(NaN)).toBe(0);
    expect(toIntScore(Infinity)).toBe(0); // non-finite ⇒ safe default 0
  });

  it('always returns an integer', () => {
    expect(Number.isInteger(toIntScore(0.857))).toBe(true);
  });
});

describe('estimateTokensInt', () => {
  it('is ~4 chars/token and never negative', () => {
    expect(estimateTokensInt('abcd')).toBe(1);
    expect(estimateTokensInt('abcdefgh')).toBe(2);
    expect(estimateTokensInt('')).toBe(0);
  });
});

describe('topN', () => {
  it('returns the highest-scored items, stable for ties', () => {
    const items = [
      { id: 'a', s: 5 },
      { id: 'b', s: 9 },
      { id: 'c', s: 5 },
      { id: 'd', s: 1 },
    ];
    const top = topN(items, 2, (i) => i.s);
    expect(top.map((i) => i.id)).toEqual(['b', 'a']); // b highest; a before c on tie
  });
});

describe('BoundedMemory', () => {
  it('normalizes summaries to one capped line and scores to integers', () => {
    const mem = new BoundedMemory({ maxSummaryChars: 40 });
    const item = mem.add({ id: 'x', summary: 'multi\nline   summary that is quite long indeed and keeps going', score: 0.9 });
    expect(item.summary).not.toContain('\n');
    expect(item.summary.length).toBeLessThanOrEqual(40);
    expect(item.score).toBe(90);
    expect(Number.isInteger(item.tokens)).toBe(true);
  });

  it('enforces Top-N retention, evicting the lowest score', () => {
    const mem = new BoundedMemory({ maxItems: 3 });
    mem.add({ id: 'a', summary: 'a', score: 10 });
    mem.add({ id: 'b', summary: 'b', score: 50 });
    mem.add({ id: 'c', summary: 'c', score: 30 });
    mem.add({ id: 'd', summary: 'd', score: 70 }); // evicts 'a' (lowest)

    expect(mem.size()).toBe(3);
    expect(mem.get('a')).toBeUndefined();
    expect(mem.all().map((i) => i.id)).toEqual(['d', 'b', 'c']); // score-sorted
  });

  it('replaces an entry with the same id rather than duplicating', () => {
    const mem = new BoundedMemory();
    mem.add({ id: 'k', summary: 'first', score: 20 });
    mem.add({ id: 'k', summary: 'second', score: 80 });
    expect(mem.size()).toBe(1);
    expect(mem.get('k')?.summary).toBe('second');
    expect(mem.get('k')?.score).toBe(80);
  });

  it('keeps footprint bounded under sustained writes', () => {
    const mem = new BoundedMemory({ maxItems: 5, maxSummaryChars: 50 });
    for (let i = 0; i < 1000; i++) {
      mem.add({ id: `id-${i}`, summary: `event number ${i} with a fairly long description attached`, score: i % 100 });
    }
    expect(mem.size()).toBe(5);
    expect(mem.footprintChars()).toBeLessThanOrEqual(mem.maxFootprintChars());
    expect(mem.totalTokens()).toBeGreaterThan(0);
    expect(Number.isInteger(mem.totalTokens())).toBe(true);
  });

  it('renders a compact, bounded context block', () => {
    const mem = new BoundedMemory({ maxItems: 2 });
    mem.add({ id: 'a', summary: 'budget locked for Q3', score: 90 });
    mem.add({ id: 'b', summary: 'checkout bug patched', score: 70 });
    const ctx = mem.toContext();
    expect(ctx.split('\n')).toHaveLength(2);
    expect(ctx).toContain('(90) budget locked for Q3');
  });
});
