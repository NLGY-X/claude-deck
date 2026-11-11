// The bridge driven through app.inject() with a fake desktop: nothing here
// presses a key or moves a window on the machine running the tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_TYPE_INTO, type Area, type DeckConfig } from './config.ts';
import type { DayConfig } from './day.ts';
import { withDeckHooks } from './hooks.ts';
import type { PushNote, PushTarget } from './push.ts';
import { createBridge, type Tap } from './server.ts';
import { permissionPending, type DeckSession, type HookEvent } from './sessions.ts';
import type { Foreground, Hands } from './win32.ts';

const TOKEN = 'a'.repeat(48);
const auth = { authorization: `Bearer ${TOKEN}` };
const AREAS: Area[] = [{ id: 'work', label: 'Work', color: '#5fcf9b', words: ['sam'], paths: [] }];

function fakeHands(fg: Foreground = { proc: 'windowsterminal', title: 'claude' }) {
  const did: string[] = [];
  const hands: Hands & { did: string[]; fg: Foreground; focusOk: boolean } = {
    did,
    fg,
    focusOk: true,
    paste: async (t, enter) => (did.push(`paste:${t}${enter ? '+enter' : ''}`), true),
    keys: async (c) => (did.push(`keys:${c}`), true),
    focusPid: async (pid) => (did.push(`focus:${pid}`), hands.focusOk),
    focusApp: async (p) => (did.push(`focusApp:${p}`), true),
    launch: async (t) => (did.push(`launch:${t}`), true),
    running: async () => new Set(['spotify']),
    media: async () => [],
    mediaCmd: async (c) => (did.push(`media:${c}`), true),
    volume: async () => ({ level: 30, muted: false }),
    setVolume: async (l) => (did.push(`volume:${l}`), true),
    setMute: async (m) => (did.push(`mute:${m}`), true),
    art: async () => null,
    clipboard: async () => '',
    foreground: async () => hands.fg,
    stats: () => ({ restarts: 0, lastError: '' }),
    stop: () => {},
  };
  return hands;
}

const session = (over: Partial<DeckSession>): DeckSession => ({
  sessionId: 's1',
  pid: 100,
  name: 'my-app-1',
  title: 'Login page',
  project: 'my-app',
  area: 'work',
  cwd: 'C:\\code\\my-app',
  phase: 'needs',
  text: 'Commit?',
  tool: null,
  ageMs: 1000,
  host: 'terminal',
  ...over,
});

const deckWith = (over: Partial<DeckConfig> = {}): DeckConfig => ({
  port: 0,
  typeInto: DEFAULT_TYPE_INTO,
  apps: [{ label: 'Spotify', icon: 'spotify', proc: 'spotify', open: 'shell:x' }],
  prompts: { Claude: [{ title: 'Review', text: 'Review the diff' }, { title: 'Clear', text: '/clear', send: true }, { title: 'Tab', keys: 'Ctrl+Tab' }] },
  seats: [],
  areas: AREAS,
  report: { repos: [] },
  push: { sessions: true },
  ...over,
});

function build(sessions: DeckSession[] | (() => DeckSession[]) = [session({})], fg?: Foreground, day?: DayConfig, extra: Partial<Parameters<typeof createBridge>[0]> = {}) {
  const hands = fakeHands(fg);
  const taps: Tap[] = [];
  const phoned: string[] = [];
  const started: { dir: string; brief: string; title: string }[] = [];
  const deck = deckWith({ day });
  const b = createBridge({
    deck: () => deck,
    hands,
    eyes: fakeHands(),
    sessions: typeof sessions === 'function' ? sessions : () => sessions,
    token: TOKEN,
    startSession: (req) => (started.push(req), { dir: req.dir, briefPath: '', launched: true }),
    resumeSession: () => ({}),
    phoneSession: (id, name) => (phoned.push(`${id}:${name}`), { launched: true }),
    tapLog: (t) => taps.push(t),
    ...extra,
  });
  return { ...b, hands, taps, phoned, started };
}

const post = (app: ReturnType<typeof build>['app'], url: string, payload: unknown, headers: Record<string, string> = auth, remoteAddress?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers, ...(remoteAddress ? { remoteAddress } : {}) });

const dayIn = (dir: string): DayConfig => ({ list: join(dir, 'list.md'), jots: join(dir, 'jots'), maxPicked: 5, areas: AREAS });

test('no token, no state; a wrong code is refused and five burn it', async () => {
  const { app, pairCode } = build();
  assert.equal((await app.inject({ url: '/deck/state' })).statusCode, 401);
  const first = pairCode();
  for (let i = 0; i < 4; i++) assert.equal((await post(app, '/deck/pair', { code: '000000' === first ? '111111' : '000000' }, {})).statusCode, 403);
  assert.equal((await post(app, '/deck/pair', { code: 'x' }, {})).statusCode, 429);
  assert.notEqual(pairCode(), first);
});

test('the day list: a tap writes the file and the next state shows it; taps log the op, never the text', async () => {
  const day = dayIn(mkdtempSync(join(tmpdir(), 'deckday-')));
  const { app, taps } = build(undefined, undefined, day);
  const add = await post(app, '/deck/day', { op: 'add', text: 'Chase Sam on the backup key', when: 'today' });
  assert.equal(add.statusCode, 200);
  assert.equal(add.json().said, 'Added to Today');
  assert.match(readFileSync(day.list, 'utf8'), /- \[ \] Chase Sam on the backup key #work/);
  const state = (await app.inject({ url: '/deck/state', headers: auth })).json();
  assert.equal(state.day.picked[0].title, 'Chase Sam on the backup key');
  assert.equal(state.day.picked[0].areaLabel, 'Work');
  assert.deepEqual(taps.map((t) => t.label), ['add']);
  assert.equal((await post(app, '/deck/day', { op: 'explode', id: 'x' })).statusCode, 409);
  assert.equal((await post(app, '/deck/day', { op: 'done', id: 'nope' })).json().error, 'That item is no longer on the list.');
});

test('no day block, no Day screen and a plain refusal', async () => {
  const { app } = build();
  assert.equal((await app.inject({ url: '/deck/state', headers: auth })).json().day, null);
  assert.match((await post(app, '/deck/day', { op: 'add', text: 'x' })).json().error, /no day list/);
});

test('the right code returns the token once', async () => {
  const { app, pairCode } = build();
  const code = pairCode();
  const r = await post(app, '/deck/pair', { code }, {});
  assert.equal(r.json().token, TOKEN);
  assert.equal((await post(app, '/deck/pair', { code }, {})).statusCode, 403);
});

test('a reply focuses the session, then pastes with Enter', async () => {
  const { app, hands } = build();
  const r = await post(app, '/deck/session/reply', { sessionId: 's1', text: 'Yes, go ahead' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(hands.did, ['focus:100', 'paste:Yes, go ahead+enter']);
});

test('a reply to an editor session is refused before anything is touched', async () => {
  const { app, hands } = build([session({ host: 'vscode' })]);
  const r = await post(app, '/deck/session/reply', { sessionId: 's1', text: 'yes' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /runs in an editor/);
  assert.deepEqual(hands.did, []);
});

test('if the window will not come forward, nothing is pasted', async () => {
  const { app, hands } = build();
  hands.focusOk = false;
  const r = await post(app, '/deck/session/reply', { sessionId: 's1', text: 'yes' });
  assert.equal(r.statusCode, 409);
  assert.ok(!hands.did.some((d) => d.startsWith('paste')));
});

test('a text key will not paste into a browser in front', async () => {
  const { app, hands } = build([session({})], { proc: 'chrome', title: 'Inbox - Mail' });
  const r = await post(app, '/deck/prompt', { group: 'Claude', index: 0, target: 'focused' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /Inbox - Mail/);
  assert.deepEqual(hands.did, []);
  // A chord is not a paste: Ctrl+Tab goes to whatever is in front.
  assert.equal((await post(app, '/deck/prompt', { group: 'Claude', index: 2, target: 'focused' })).statusCode, 200);
  assert.deepEqual(hands.did, ['keys:Ctrl+Tab']);
});

test('a text key pastes into a terminal in front, and "send" presses Enter', async () => {
  const { app, hands } = build();
  await post(app, '/deck/prompt', { group: 'Claude', index: 0, target: 'focused' });
  await post(app, '/deck/prompt', { group: 'Claude', index: 1, target: 'focused' });
  assert.deepEqual(hands.did, ['paste:Review the diff', 'paste:/clear+enter']);
});

test('a double tap acts once', async () => {
  const { app, hands } = build();
  const body = { sessionId: 's1', text: 'Yes, go ahead' };
  const [a, b] = await Promise.all([post(app, '/deck/session/reply', body), post(app, '/deck/session/reply', body)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(hands.did.filter((d) => d.startsWith('paste')).length, 1);
});

test('every tap is counted by the key name, and the text of a reply is never logged', async () => {
  const { app, taps } = build();
  await post(app, '/deck/prompt', { group: 'Claude', index: 0, target: 'focused' });
  await post(app, '/deck/app', { index: 0 });
  await post(app, '/deck/session/reply', { sessionId: 's1', text: 'a private reply' });
  await post(app, '/deck/prompt', { group: 'Claude', index: 9 });
  assert.deepEqual(
    taps.map((t) => [t.action, t.label, t.ok]),
    [['prompt', 'Review', true], ['app', 'Spotify', true], ['session/reply', undefined, true], ['prompt', undefined, false]]
  );
  assert.ok(!JSON.stringify(taps).includes('private'));
});

test('hooks and health answer this PC only', async () => {
  const { app, hooks } = build();
  const hook = { session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' };
  assert.equal((await post(app, '/deck/hook', hook, {}, '192.168.1.50')).statusCode, 403);
  assert.equal(hooks.size, 0);
  assert.equal((await post(app, '/deck/hook', hook, {}, '127.0.0.1')).statusCode, 200);
  assert.equal(hooks.get('s1')?.event, 'Notification');
  assert.equal((await app.inject({ url: '/deck/health', remoteAddress: '192.168.1.50' })).statusCode, 403);
  assert.equal((await app.inject({ url: '/deck/health', remoteAddress: '127.0.0.1' })).json().ok, true);
  // Through a proxy on this PC the socket says loopback and the header says a phone.
  const viaProxy = { 'x-forwarded-for': '100.101.102.103' };
  assert.equal((await post(app, '/deck/hook', hook, viaProxy, '127.0.0.1')).statusCode, 403);
  assert.equal((await app.inject({ url: '/deck/health', remoteAddress: '127.0.0.1', headers: viaProxy })).statusCode, 403);
});

test('a permission prompt counts only until the session moves on', () => {
  const ask: HookEvent = { event: 'Notification', message: 'Claude needs your permission to use Bash', at: 10_000 };
  assert.equal(permissionPending(ask, 9_500), ask.message);
  assert.equal(permissionPending(ask, 15_000), null, 'the transcript moved on after the prompt');
  assert.equal(permissionPending({ ...ask, message: 'Claude is waiting for your input' }, 9_500), null);
  assert.equal(permissionPending({ event: 'Stop', at: 10_000 }, 9_500), null);
});

test('the hook installer leaves other hooks alone and is idempotent', () => {
  const mine = { matcher: '*', hooks: [{ type: 'command', command: 'powershell.exe', args: ['-File', 'my-hook.ps1'] }] };
  const s = { theme: 'dark', hooks: { UserPromptSubmit: [mine], Stop: [] } };
  const once = withDeckHooks(s, 'C:\\repo\\server\\deck-hook.cmd', false);
  const twice = withDeckHooks(once, 'C:\\repo\\server\\deck-hook.cmd', false);
  assert.deepEqual(twice, once);
  assert.equal(once.hooks!.UserPromptSubmit.length, 2);
  assert.deepEqual(once.hooks!.UserPromptSubmit[0], mine);
  assert.equal(once.theme, 'dark');
  const removed = withDeckHooks(once, 'C:\\repo\\server\\deck-hook.cmd', true);
  assert.deepEqual(removed.hooks!.UserPromptSubmit, [mine]);
  assert.deepEqual(removed.hooks!.Notification, []);
});

test('a seat starts a session in its folder, the brief opening with the goal it serves', async () => {
  let got: { dir: string; brief: string } | null = null;
  const b = createBridge({
    deck: () => deckWith({ seats: [{ title: 'Weekly note', dir: 'C:/notes', brief: 'Draft it.', why: 'One page a week.' }] }),
    hands: fakeHands(),
    eyes: fakeHands(),
    sessions: () => [],
    token: TOKEN,
    startSession: (req) => ((got = req), { dir: req.dir, briefPath: '', launched: true }),
    resumeSession: () => ({}),
    phoneSession: () => ({}),
  });
  assert.equal((await post(b.app, '/deck/seat', { index: 0 })).statusCode, 200);
  assert.deepEqual(got, { dir: 'C:/notes', brief: 'Why this exists: One page a week.\n\nDraft it.', title: 'Weekly note' });
});

test('send to phone: a session nobody holds is resumed with Remote Control on, under its title', async () => {
  const { app, hands, phoned } = build([session({ host: 'none', pid: 0 })]);
  const r = await post(app, '/deck/session/phone', { sessionId: 's1' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(phoned, ['s1:Login page']);
  assert.deepEqual(hands.did, [], 'nothing on the desktop is focused or typed into');
});

test('send to phone: a terminal session gets /remote-control typed into it, nothing resumed', async () => {
  const { app, hands, phoned } = build([session({ host: 'terminal' })]);
  const r = await post(app, '/deck/session/phone', { sessionId: 's1' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(hands.did, ['focus:100', 'paste:/remote-control+enter']);
  assert.deepEqual(phoned, []);
});

test('send to phone: an editor session is refused, with where to type it', async () => {
  const { app, hands, phoned } = build([session({ host: 'vscode' })]);
  const r = await post(app, '/deck/session/phone', { sessionId: 's1' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /editor/);
  assert.match(r.json().error, /\/remote-control/);
  assert.deepEqual(hands.did, []);
  assert.deepEqual(phoned, []);
});

// ---------------------------------------------------------------- cards

function dayWith(lines: string): DayConfig {
  const day = dayIn(mkdtempSync(join(tmpdir(), 'deckcards-')));
  writeFileSync(day.list, lines);
  return day;
}
const WAITING = '## Waiting on\n\n- [ ] Sam: the backup key #work since:2026-01-01 ^bopq\n';
/** The state after a fresh poll: a card action answers before the list moves on. */
const stateOf = async (b: Pick<ReturnType<typeof build>, 'app' | 'tick'>) => {
  await b.tick();
  return (await b.app.inject({ url: '/deck/state', headers: auth })).json();
};

test('the state carries one ranked list: a session, then a chase from the day list', async () => {
  const b = build([session({})], undefined, dayWith(WAITING));
  const cards = (await stateOf(b)).cards;
  assert.deepEqual(cards.map((c: { kind: string }) => c.kind), ['session', 'chase']);
  assert.equal(cards[1].title, 'Sam: the backup key');
  assert.equal(cards[1].hue, '#5fcf9b');
});

test('a card reply pastes the reply into the session and the tap log says card/session/yes', async () => {
  const { app, hands, taps } = build();
  const r = await post(app, '/deck/card', { id: 'session:s1', action: 'yes' });
  assert.equal(r.statusCode, 200);
  assert.match(r.json().said, /Yes, go ahead/);
  assert.deepEqual(hands.did, ['focus:100', 'paste:Yes, go ahead+enter']);
  assert.deepEqual(taps.map((t) => [t.action, t.ok]), [['card/session/yes', true]]);
  const bad = await post(app, '/deck/card', { id: 'session:s1', action: 'dance' });
  assert.equal(bad.statusCode, 409);
  assert.deepEqual(taps[1], { ...taps[1], action: 'card/session/dance', ok: false });
});

test('chase makes the Chase card and puts it on Today; undo takes it back off and drops what it made', async () => {
  const day = dayWith(WAITING);
  const b = build([], undefined, day);
  const { app } = b;
  await stateOf(b);
  const r = await post(app, '/deck/card', { id: 'chase:bopq', action: 'chase' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().said, 'Chase is on Today.');
  assert.equal(r.json().undo.created, true);
  let file = readFileSync(day.list, 'utf8');
  assert.match(file, /- \[ \] Chase Sam: the backup key #work added:\S+ picked:\S+ \^/);
  assert.deepEqual((await stateOf(b)).cards, [], 'on Today means you are on it');
  assert.equal((await post(app, '/deck/card', r.json().undo)).statusCode, 200);
  file = readFileSync(day.list, 'utf8');
  assert.doesNotMatch(file, /picked:/);
  assert.match(file, /## Dropped\n\n- \[ \] Chase Sam/);
  assert.equal((await stateOf(b)).cards[0].id, 'chase:bopq');
});

test('still waiting asks again in five days; undo clears it', async () => {
  const day = dayWith(WAITING);
  const b = build([], undefined, day);
  const { app } = b;
  await stateOf(b);
  const r = await post(app, '/deck/card', { id: 'chase:bopq', action: 'still' });
  assert.equal(r.statusCode, 200);
  assert.match(readFileSync(day.list, 'utf8'), /since:2026-01-01 ask:\d{4}-\d{2}-\d{2} \^bopq/);
  assert.deepEqual((await stateOf(b)).cards, []);
  await post(app, '/deck/card', r.json().undo);
  assert.doesNotMatch(readFileSync(day.list, 'utf8'), /ask:/);
  assert.equal((await stateOf(b)).cards[0].id, 'chase:bopq');
});

test('a card that has left the list says so instead of acting', async () => {
  const { app } = build([]);
  const r = await post(app, '/deck/card', { id: 'session:gone', action: 'yes' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /gone/);
});

test("a session card's Resolve context: the last turns from its transcript; an editor session gets no reply box", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decktx-'));
  const tx = join(dir, 's2.jsonl');
  const line = (o: object) => JSON.stringify(o);
  writeFileSync(tx, [line({ type: 'user', message: { content: 'Add the login page' } }), line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. Commit it?' }] } })].join('\n') + '\n');
  const { app } = build([session({ sessionId: 's2', host: 'vscode' })], undefined, undefined, { transcript: () => tx });
  const s = (await app.inject({ url: '/deck/resolve/session:s2', headers: auth })).json();
  assert.equal(s.context.kind, 'session');
  assert.deepEqual(s.context.turns, [
    { who: 'you', text: 'Add the login page' },
    { who: 'claude', text: 'Done. Commit it?' },
  ]);
  assert.deepEqual(s.card.buttons.map((b: { action: string }) => b.action), ['front']);
  assert.equal((await app.inject({ url: '/deck/resolve/session:nope', headers: auth })).statusCode, 409);
});

// ---------------------------------------------------------------- push

const TARGET: PushTarget = { url: 'https://ntfy.example.com', topic: 'deck-abc', deckUrl: 'https://desk-pc.example.ts.net' };

test('a test push goes to the ntfy topic with a click on the top card; with no topic the route says how to set one up', async () => {
  const sent: { topic: string; title: string; click?: string }[] = [];
  const { app, tick } = build([], undefined, undefined, { push: () => TARGET, send: async (t, n) => (sent.push({ topic: t.topic, title: n.title, click: n.click }), true) });
  await tick();
  const state = (await app.inject({ url: '/deck/state', headers: auth })).json();
  assert.deepEqual(state.push, { url: 'https://ntfy.example.com', topic: 'deck-abc' });
  const r = await post(app, '/deck/push/test', {});
  assert.match(r.json().said, /^Sent\. Tap it on the phone and the deck opens/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].topic, 'deck-abc');
  assert.equal(sent[0].title, 'Deck test');
  assert.match(sent[0].click ?? '', /^https:\/\/desk-pc\.example\.ts\.net\/(\?card=.+)?$/);

  const none = build([], undefined, undefined, { push: () => null });
  assert.equal((await post(none.app, '/deck/push/test', {})).json().error, 'No push topic yet. On the PC: bash ntfy/install.sh');
  const refused = build([], undefined, undefined, { push: () => TARGET, send: async () => false });
  assert.match((await post(refused.app, '/deck/push/test', {})).json().error, /did not take it/);
});

test('a session that starts waiting on you pushes once, with a click on its card; the ones there at start do not', async () => {
  const sent: PushNote[] = [];
  let list = [session({ sessionId: 'old' })];
  const b = build(() => list, undefined, undefined, { push: () => TARGET, send: async (_t, n) => (sent.push(n), true) });
  await b.tick();
  assert.equal(sent.length, 0, 'already waiting when the bridge started');
  list = [session({ sessionId: 'old' }), session({ sessionId: 'new', title: 'Billing', text: 'Ship it?' })];
  await b.tick();
  await b.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Billing');
  assert.equal(sent[0].body, 'Billing: Ship it?');
  assert.equal(sent[0].click, 'https://desk-pc.example.ts.net/?card=session%3Anew');
  // It answered, then asked again: a new question, a new push.
  list = [session({ sessionId: 'old' })];
  await b.tick();
  list = [session({ sessionId: 'old' }), session({ sessionId: 'new', title: 'Billing', text: 'Ship it?' })];
  await b.tick();
  assert.equal(sent.length, 2);
});

test('push.sessions false keeps session cards off the phone', async () => {
  const sent: PushNote[] = [];
  let list: DeckSession[] = [];
  const deck = deckWith({ push: { sessions: false } });
  const b = build(() => list, undefined, undefined, { deck: () => deck, push: () => TARGET, send: async (_t, n) => (sent.push(n), true) });
  await b.tick();
  list = [session({})];
  await b.tick();
  assert.equal(sent.length, 0);
});

test('the share sheet posts to /share; with no service worker to keep it, the bridge sends the app itself', async () => {
  const { app } = build();
  const r = await app.inject({ method: 'POST', url: '/share' });
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, '/');
  assert.equal((await app.inject({ url: '/share' })).statusCode, 303);
});

// ---------------------------------------------------------------- jot

/** A multipart body the way the jot sheet sends one. */
async function multipart(fields: Record<string, string>, files: { name: string; type: string; data: string }[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('file', new Blob([f.data], { type: f.type }), f.name);
  const r = new Response(fd);
  return { payload: Buffer.from(await r.arrayBuffer()), headers: { ...auth, 'content-type': r.headers.get('content-type')! } };
}
const jotTools = (log: string[]) => ({
  fetchLink: async (url: string) => (log.push(`fetch:${url}`), { url, title: 'Reach benchmarks', text: 'Organic reach by follower band.' }),
  describePhoto: async (p: string) => (log.push(`describe:${basename(p)}`), 'A chart of reach by band.'),
});

test('a jot: an idea is a note in the jots folder, the link read and the photo described after; the tap log counts kinds, never words', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deckjot-'));
  const log: string[] = [];
  const { app, taps, tick, jotsIdle } = build(undefined, undefined, dayIn(dir), { jotTools: jotTools(log) });
  const m = await multipart({ text: 'Reach benchmarks worth a look https://example.com/x', kind: 'idea', area: 'work', links: '[]', source: 'deck' }, [{ name: 'shot.png', type: 'image/png', data: 'png' }]);
  const r = await app.inject({ method: 'POST', url: '/deck/jot', ...m });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().said, 'Jotted. The PC is reading the link and describing the photo.');
  const stem = r.json().stem as string;
  assert.match(stem, /^\d{4}-\d{2}-\d{2}-\d{4}-reach-benchmarks-worth-a-look$/);
  const jots = join(dir, 'jots');
  assert.equal(readFileSync(join(jots, `${stem}.png`), 'utf8'), 'png');
  await jotsIdle();
  const note = readFileSync(join(jots, `${stem}.md`), 'utf8');
  assert.match(note, /^---\nkind: photo\narea: work\nsource: deck\n/);
  assert.match(note, /## Link: Reach benchmarks\n\nhttps:\/\/example\.com\/x · read /);
  assert.match(note, /## Photo: .*\.png\n\nA chart of reach by band\./);
  assert.deepEqual(log, ['fetch:https://example.com/x', `describe:${stem}.png`]);
  assert.deepEqual(taps.map((t) => [t.action, t.label]), [['jot', 'idea+photo+link']]);
  await tick();
  const state = (await app.inject({ url: '/deck/state', headers: auth })).json();
  assert.deepEqual(state.jots.map((j: { stem: string; kind: string; pending: string | null; links: number }) => [j.stem, j.kind, j.links, j.pending]), [[stem, 'photo', 1, null]]);
  assert.equal(state.day.shortlist.length, 0);
});

test('a jot with a task kind: words alone go to the day list; with a link it is a note too, and the item carries the stem', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deckjot-'));
  const { app, tick, jotsIdle } = build(undefined, undefined, dayIn(dir), { jotTools: jotTools([]) });
  const plain = await post(app, '/deck/jot', { text: 'Chase Sam on the backup key', kind: 'today', area: '' });
  assert.equal(plain.json().said, 'Added to Today');
  assert.ok(!existsSync(join(dir, 'jots')));
  const linked = await post(app, '/deck/jot', { text: 'Read the reach benchmarks', kind: 'soon', area: 'work', links: '["https://example.com/x"]' });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().said, 'Added to the shortlist, with the note. The PC is reading the link.');
  const stem = linked.json().stem as string;
  const list = readFileSync(join(dir, 'list.md'), 'utf8');
  assert.match(list, new RegExp(`- \\[ \\] Read the reach benchmarks #work added:\\d{4}-\\d{2}-\\d{2} jot:${stem} \\^[a-z0-9]{4}`));
  const id = /jot:\S+ \^([a-z0-9]{4})/.exec(list)![1];
  await jotsIdle();
  assert.match(
    readFileSync(join(dir, 'jots', `${stem}.md`), 'utf8'),
    new RegExp(`^---\\nkind: link\\narea: work\\nsource: deck\\ncreated: [^\\n]+\\nattachments: \\[\\]\\nlinks:\\n  - https://example.com/x\\ntask: ${id}\\n---\\n`)
  );
  await tick();
  const state = (await app.inject({ url: '/deck/state', headers: auth })).json();
  assert.equal(state.day.shortlist[0].jot, stem);
  assert.equal(state.jots[0].task, id);
  assert.equal((await post(app, '/deck/jot', { text: 'Sam: the backup key', kind: 'wait' })).json().said, 'Added to waiting on');
  assert.equal((await post(app, '/deck/jot', { text: '', kind: 'idea' })).json().error, 'Nothing to jot.');
  assert.equal((await post(app, '/deck/jot', { text: 'x', kind: 'maybe' })).json().error, 'Unknown jot kind.');
});

test('make it a task: the jot becomes a shortlist item that names the note, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deckjot-'));
  const { app, taps } = build(undefined, undefined, dayIn(dir), { jotTools: jotTools([]) });
  const stem = (await post(app, '/deck/jot', { text: 'A daily note the machines write', kind: 'idea', area: 'work' })).json().stem as string;
  const r = await post(app, '/deck/jot/task', { stem });
  assert.equal(r.json().said, 'Added to the shortlist');
  assert.match(readFileSync(join(dir, 'list.md'), 'utf8'), new RegExp(`- \\[ \\] A daily note the machines write #work added:\\S+ jot:${stem} \\^`));
  assert.match(readFileSync(join(dir, 'jots', `${stem}.md`), 'utf8'), /\ntask: [a-z0-9]{4}\n---\n/);
  // a different body, or the double-tap guard would answer the first one again
  assert.equal((await post(app, '/deck/jot/task', { stem, when: 'soon' })).json().error, 'Already on the list.');
  assert.equal((await post(app, '/deck/jot/task', { stem: 'nope' })).json().error, 'That jot is no longer in the folder.');
  assert.deepEqual(taps.map((t) => t.action), ['jot', 'jot/task', 'jot/task', 'jot/task']);
});
