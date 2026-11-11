import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chaseCards, rankCards, sessionCards, type Card } from './cards.ts';
import type { DayItem } from './day.ts';
import type { DeckSession } from './sessions.ts';

// Tuesday 27 October 2026, 10:00 local.
const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const AREAS = [
  { id: 'work', label: 'Work', color: '#7aa7ff' },
  { id: 'home', label: 'Home', color: '#c9a0ff' },
];

const session = (over: Partial<DeckSession>): DeckSession => ({
  sessionId: 's1',
  pid: 100,
  name: 'my-app-1',
  title: 'Login page',
  project: 'my-app',
  area: 'work',
  cwd: 'C:/code/my-app',
  phase: 'needs',
  text: 'Commit the login work on main before the next change? I can do it now.',
  tool: null,
  ageMs: 4 * 60_000,
  host: 'terminal',
  ...over,
});

test('a session card offers the three replies and the phone in a terminal, only Bring to front in an editor', () => {
  const cards = sessionCards(
    [
      session({}),
      session({ sessionId: 's2', host: 'vscode' }),
      session({ sessionId: 's3', host: 'none', pid: 0 }),
      session({ sessionId: 's4', phase: 'permission', text: 'Claude needs your permission to use Bash' }),
      session({ sessionId: 's5', phase: 'working' }),
    ],
    AREAS
  );
  assert.deepEqual(cards.map((c) => c.id), ['session:s1', 'session:s2', 'session:s3', 'session:s4']);
  assert.deepEqual(cards[0].buttons.map((b) => b.action), ['yes', 'no', 'show', 'phone']);
  assert.equal(cards[0].title, 'Login page: Commit the login work on main before the next change?');
  assert.equal(cards[0].source, 'Work · session · terminal');
  assert.equal(cards[0].hue, '#7aa7ff');
  assert.deepEqual(cards[1].buttons.map((b) => b.action), ['front']);
  assert.match(cards[1].detail, /editor/);
  assert.deepEqual(cards[2].buttons.map((b) => b.action), ['phone', 'resume']);
  assert.deepEqual(cards[3].buttons.map((b) => b.action), ['front']);
  assert.equal(cards[3].when, 'needs permission 4m ago');
});

test('a session outside every area is named by its project and drawn grey', () => {
  const [c] = sessionCards([session({ area: null })], AREAS);
  assert.equal(c.source, 'my-app · session · terminal');
  assert.equal(c.hue, '#9aa1ae');
});

const item = (over: Partial<DayItem>): DayItem => ({ id: 'w1', section: 'waiting', title: 'Alex: the signed contract', area: 'work', carried: 0, someday: false, since: '2026-10-12', ...over });

test('a chase card at five days, not before, not while asked to wait, not while its Chase card is on Today', () => {
  const today = '2026-10-27';
  const items = [
    item({}),
    item({ id: 'w2', title: 'Sam: the key', since: '2026-10-24' }),
    item({ id: 'w3', title: 'Jo: the quote', since: '2026-10-19', ask: '2026-10-30' }),
    item({ id: 'w4', title: 'Lee: the figures', since: '2026-10-10' }),
    item({ id: 'c4', section: 'open', title: 'Chase Lee: the figures', picked: today, since: undefined }),
    item({ id: 'c1', section: 'open', title: 'Chase Alex: the signed contract', since: undefined }),
  ];
  const cards = chaseCards(items, AREAS, today, NOW);
  assert.deepEqual(cards.map((c) => c.id), ['chase:w1']);
  assert.equal(cards[0].title, 'Alex: the signed contract');
  assert.equal(cards[0].when, '15 days');
  assert.equal(cards[0].hue, '#7aa7ff');
  assert.equal(cards[0].ref.chaseId, 'c1');
  assert.match(cards[0].detail, /on the shortlist/);
});

test('ranking: sessions, then chases; oldest first within a kind', () => {
  const c = (kind: Card['kind'], id: string, waitedMs: number): Card => ({ id, kind, area: null, hue: '#000', source: '', when: '', title: id, detail: '', buttons: [], waitedMs, ref: {}, body: '' });
  const ranked = rankCards([c('chase', 'ch1', 10), c('session', 's-new', 1), c('chase', 'ch2', 20), c('session', 's-old', 9)]);
  assert.deepEqual(ranked.map((x) => x.id), ['s-old', 's-new', 'ch2', 'ch1']);
});
