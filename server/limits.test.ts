import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRateLimits, parseReset, parseUsageText, readLimits } from './limits.ts';
import { line, save } from './statusline.ts';

// The shape the status line docs give: percent used, reset in epoch seconds.
const RATE = {
  five_hour: { used_percentage: 41.6, resets_at: 1_792_160_000 },
  seven_day: { used_percentage: 61, resets_at: 1_792_521_600 },
};

test('parseRateLimits keeps both windows, rounds the percent and turns resets into ms', () => {
  assert.deepEqual(parseRateLimits(RATE), [
    { id: 'five_hour', pct: 42, resetsAt: 1_792_160_000_000 },
    { id: 'seven_day', pct: 61, resetsAt: 1_792_521_600_000 },
  ]);
});

test('parseRateLimits: a window Claude Code dropped after its reset is left out, none at all is null', () => {
  assert.deepEqual(parseRateLimits({ seven_day: RATE.seven_day }), [{ id: 'seven_day', pct: 61, resetsAt: 1_792_521_600_000 }]);
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits(undefined), null);
  assert.equal(parseRateLimits({ five_hour: { used_percentage: '41' } }), null);
});

test('save then readLimits round-trips, and a window past its reset reads as reset', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'decklimits-')), 'limits.json');
  assert.equal(save(RATE, path, 1_792_150_000_000), true);
  const before = readLimits(path, 1_792_150_000_000);
  assert.equal(before?.at, 1_792_150_000_000);
  assert.deepEqual(before?.windows.map((w) => w.pct), [42, 61]);
  // After the five-hour reset but before the weekly one.
  assert.deepEqual(readLimits(path, 1_792_170_000_000)?.windows.map((w) => w.pct), [null, 61]);
});

test('save writes nothing when the session carries no limits (an API-key login, or before the first response)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'decklimits-')), 'limits.json');
  assert.equal(save(undefined, path), false);
  assert.equal(readLimits(path), null);
});

test('readLimits: an unreadable file is null, not a throw', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'decklimits-')), 'limits.json');
  writeFileSync(path, '{not json');
  assert.equal(readLimits(path), null);
});

test('the status line itself: model, then the two windows', () => {
  assert.equal(line({ model: { display_name: 'Opus 5.5' }, rate_limits: RATE }), 'Opus 5.5 · 5h 42% · week 61%');
  assert.equal(line({ model: { display_name: 'Opus 5.5' } }), 'Opus 5.5');
  assert.equal(line({}), '');
});

// What `claude -p /usage` printed on 16 Oct 2026, trimmed.
const USAGE = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 56% used · resets Oct 16, 1:50pm (Europe/London)',
  'Current week (all models): 65% used · resets Oct 21, 7pm (Europe/London)',
  'Current week (Fable): 0% used · resets Oct 21, 7pm (Europe/London)',
  '',
  "What's contributing to your limits usage?",
].join('\n');

test('parseUsageText reads the session and all-models week lines, not the per-model one', () => {
  const now = new Date(2026, 9, 16, 11, 30).getTime();
  assert.deepEqual(parseUsageText(USAGE, now), [
    { id: 'five_hour', pct: 56, resetsAt: new Date(2026, 9, 16, 13, 50).getTime() },
    { id: 'seven_day', pct: 65, resetsAt: new Date(2026, 9, 21, 19, 0).getTime() },
  ]);
});

test('parseUsageText: changed wording is no reading, not a wrong number', () => {
  assert.equal(parseUsageText('Session usage: 56%'), null);
  assert.equal(parseUsageText(''), null);
});

test('parseReset: a time alone is today, noon and midnight land right, and a date already gone is next year', () => {
  const now = new Date(2026, 9, 16, 11, 30).getTime();
  assert.equal(parseReset('1:50pm', now), new Date(2026, 9, 16, 13, 50).getTime());
  assert.equal(parseReset('12pm', now), new Date(2026, 9, 16, 12, 0).getTime());
  assert.equal(parseReset('Oct 17, 12am', now), new Date(2026, 9, 17, 0, 0).getTime());
  assert.equal(parseReset('Jan 2, 9am (Europe/London)', new Date(2026, 11, 30).getTime()), new Date(2027, 0, 2, 9, 0).getTime());
  assert.equal(parseReset('soon'), null);
});
