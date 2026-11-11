// The deck bridge as a function of its parts, so tests can build one with a
// fake desktop and drive it with app.inject(). server/bridge.ts wires the real
// parts together and starts it.
//
// It listens on the LAN, requires a paired token on every API call, and
// exposes a fixed set of actions.

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CHASE_AFTER_DAYS, SESSION_REPLIES, chaseCards, chaseItemFor, rankCards, sessionCards, type Card, type CardKind } from './cards.ts';
import type { DeckConfig } from './config.ts';
import { DayList, type DayItem, type DayOp, type DayView, type When } from './day.ts';
import {
  JOT_ASKS,
  JOT_BYTES,
  JOT_FILE_BYTES,
  JotQueue,
  afterSave,
  attachmentKind,
  jotsDir,
  noteText,
  readJots,
  saidFor,
  setFrontmatter,
  summarize,
  urlsIn,
  writeJot,
  type JotAsk,
  type JotFile,
  type JotSummary,
  type JotTools,
} from './jots.ts';
import type { ClaudeLimits } from './limits.ts';
import { cardUrl, push, type PushNote, type PushTarget } from './push.ts';
import { buildReport, type CommitCount, type ReportView } from './report.ts';
import { sessionTurns, type DeckSession, type HookEvent } from './sessions.ts';
import type { Foreground, Hands, NowPlaying } from './win32.ts';

export interface AreaInfo {
  id: string;
  label: string;
  color: string;
}

export interface DeckState {
  at: number;
  sessions: DeckSession[];
  running: string[];
  media: NowPlaying[];
  volume: { level: number; muted: boolean } | null;
  foreground: Foreground | null;
  /** every area in the config, for colours and the filter */
  areas: AreaInfo[];
  config: Omit<DeckConfig, 'port'>;
  /** the Day screen; null when deck.config.jsonc has no `day` block */
  day: DayView | null;
  /** everything that waits on you, ranked (server/cards.ts) */
  cards: Card[];
  /** the phone's push topic, for the Keys screen to show; null until ntfy/install.sh has run */
  push: { url: string; topic: string } | null;
  /** this week's jots, newest first, with what the PC is still doing for each (server/jots.ts) */
  jots: JotSummary[];
  /** Claude's five-hour and weekly limits as last saved; null when never (server/limits.ts) */
  claude: ClaudeLimits | null;
  /** "so far today"; null with no day list (server/report.ts) */
  report: ReportView | null;
  errors: string[];
}

const DAY_OPS = new Set(['add', 'wait', 'pick', 'unpick', 'done', 'undone', 'tomorrow', 'drop', 'keep', 'handoff', 'later']);
/** An undo arrives after the card has left the list, so it carries what it needs. */
interface CardAction {
  id: string;
  action: string;
  /** chase undo: the "Chase X" item's id, and whether the tap created it */
  chaseId?: string;
  created?: boolean;
}

export interface BridgeDeps {
  deck: () => DeckConfig;
  configError?: () => string;
  /** taps go through `hands`, the background poll through `eyes`: two helper
   *  processes, so a slow poll never sits in front of a tap */
  hands: Hands;
  eyes: Hands;
  sessions: (hooks: Map<string, HookEvent>) => DeckSession[];
  token: string;
  startSession: (req: { dir: string; brief: string; title: string }) => { dir: string; briefPath: string; launched: boolean };
  resumeSession: (sessionId: string) => unknown;
  /** Resume a session no process holds in a new terminal with Remote Control
   *  on, under `name`, so the Claude app on your phone can drive it (server/phone.ts). */
  phoneSession: (sessionId: string, name: string) => unknown;
  uiDist?: string;
  onPairCode?: (code: string) => void;
  now?: () => number;
  /** After a jot is saved: read the link, describe the photo, write down the voice note (server/jots.ts). */
  jotTools?: JotTools;
  /** the phone's push topic (server/push.ts); null when none is set up */
  push?: () => PushTarget | null;
  /** The POST to ntfy; tests fake it. */
  send?: (t: PushTarget, n: PushNote) => Promise<boolean>;
  /** A session's transcript path, for the last turns on its Resolve screen. */
  transcript?: (sessionId: string) => string | null;
  /** Claude's plan limits, from the file the status line writes. */
  limits?: () => ClaudeLimits | null;
  /** Today's commit count, already cached by the caller (server/report.ts). */
  commits?: () => CommitCount | null;
  /** One line per tap, to count which keys earn their place (npm run taps). */
  tapLog?: (tap: Tap) => void;
}

export interface Tap {
  at: number;
  action: string;
  /** the key's own name from the config, when the action has one */
  label?: string;
  ok: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** How often the tablet hears from the bridge even when nothing changed. It
 *  treats three missed beats as a dead link (ui/src/api.ts). */
export const HEARTBEAT_MS = 5000;
/** A second identical tap inside this window is the same tap. */
const DEDUPE_MS = 700;

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createBridge(deps: BridgeDeps) {
  const now = deps.now ?? Date.now;
  const app: FastifyInstance = Fastify({ logger: false });
  const started = now();

  // ---------------------------------------------------------------- pairing
  // The tablet trades a six-digit code for the long token. One code, one
  // tablet; five wrong guesses burn it.
  let pairCode = '';
  let pairMisses = 0;
  const newPairCode = (): string => {
    pairCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pairMisses = 0;
    deps.onPairCode?.(pairCode);
    return pairCode;
  };

  const authed = (req: FastifyRequest): boolean => {
    const h = req.headers.authorization ?? '';
    const q = (req.query as { t?: string } | undefined)?.t ?? '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : q;
    return !!given && same(given, deps.token);
  };
  // Only a bare loopback connection is this PC. A request relayed by a proxy
  // on this machine (Tailscale Serve, anything that sets X-Forwarded-*)
  // arrives from 127.0.0.1 at the socket and from somewhere else in truth.
  const local = (req: FastifyRequest): boolean =>
    LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];

  // ---------------------------------------------------------------- state
  // Built per call from the live config, so a config edit applies at once.
  const dayList = (): DayList | null => {
    const cfg = deps.deck().day;
    return cfg ? new DayList(cfg, now) : null;
  };
  // What the PC does after a jot, one job at a time (server/jots.ts).
  const jotQueue = new JotQueue();
  const hooks = new Map<string, HookEvent>();
  let lastHook: { event: string; session: string; agoAt: number } | null = null;
  let state: DeckState | null = null;
  let shape = '';
  let lastPollAt = 0;
  let lastPollMs = 0;
  /** session cards already on the list, so each new one pushes once; null before the first poll */
  let seenSessionCards: Set<string> | null = null;
  const listeners = new Set<FastifyReply>();
  const send = (event: string, data: unknown): void => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.raw.write(msg);
  };

  /** A session that just started waiting on you goes to the phone, once. The
   *  cards present at start count as seen, so a restart pushes nothing. */
  const pushNewSessionCards = (cards: Card[]): void => {
    const ids = new Set(cards.filter((c) => c.kind === 'session').map((c) => c.id));
    const fresh = seenSessionCards ? cards.filter((c) => c.kind === 'session' && !seenSessionCards!.has(c.id)) : [];
    seenSessionCards = ids;
    const t = deps.push?.() ?? null;
    if (!t || !deps.deck().push.sessions) return;
    for (const c of fresh) {
      void (deps.send ?? push)(t, { title: String(c.ref.name ?? 'Claude'), body: c.title, click: cardUrl(t, c.id), tags: 'speech_balloon' });
    }
  };

  async function poll(): Promise<void> {
    const t0 = now();
    const errors: string[] = [];
    const settle = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message}`);
        return fallback;
      }
    };
    let sessions: DeckSession[] = [];
    try {
      sessions = deps.sessions(hooks);
    } catch (e) {
      errors.push(`sessions: ${(e as Error).message}`);
    }
    const [running, media, volume, foreground] = await Promise.all([
      settle('apps', deps.eyes.running(), new Set<string>()),
      settle('media', deps.eyes.media(), [] as NowPlaying[]),
      settle('volume', deps.eyes.volume(), null),
      settle('window', deps.eyes.foreground(), null),
    ]);
    const { port: _port, ...config } = deps.deck();
    const areas = config.areas.map((a) => ({ id: a.id, label: a.label, color: a.color }));
    const cfgErr = deps.configError?.();
    let day: DayView | null = null;
    let items: DayItem[] = [];
    try {
      const list = dayList();
      day = list?.view() ?? null;
      items = list?.read() ?? [];
    } catch (e) {
      errors.push(`day list: ${(e as Error).message}`);
    }
    const t = now();
    let jots: JotSummary[] = [];
    try {
      if (config.day) jots = readJots(jotsDir(config.day), t - 7 * 86_400_000, (stem) => jotQueue.pending(stem));
    } catch (e) {
      errors.push(`jots: ${(e as Error).message}`);
    }
    let cards: Card[] = [];
    try {
      cards = rankCards([...sessionCards(sessions, areas), ...chaseCards(items, areas, day?.date ?? '', t)]);
    } catch (e) {
      errors.push(`cards: ${(e as Error).message}`);
    }
    pushNewSessionCards(cards);
    const next: DeckState = {
      at: t,
      sessions,
      running: [...running],
      media,
      volume,
      foreground,
      areas,
      config,
      day,
      cards,
      push: (() => {
        const p = deps.push?.() ?? null;
        return p ? { url: p.url, topic: p.topic } : null;
      })(),
      jots,
      claude: deps.limits?.() ?? null,
      report: day ? buildReport(day, deps.commits?.() ?? null) : null,
      errors: cfgErr ? [cfgErr, ...errors] : errors,
    };
    // Push only on change. `at` and the ages move every tick, so compare
    // without them; the tablet ages tiles itself from `at`.
    const mins = (ms: number): number => Math.floor(ms / 60_000);
    const nextShape = JSON.stringify({
      ...next,
      at: 0,
      sessions: sessions.map((s) => ({ ...s, ageMs: mins(s.ageMs) })),
      cards: cards.map((c) => ({ ...c, waitedMs: mins(c.waitedMs) })),
    });
    state = next;
    lastPollAt = now();
    lastPollMs = lastPollAt - t0;
    if (nextShape !== shape) {
      shape = nextShape;
      send('state', next);
    }
  }

  let polling: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    // A slow poll never stacks up behind itself.
    if (!polling) polling = poll().finally(() => (polling = null));
    return polling;
  };
  const tickSoon = (ms = 300): void => {
    setTimeout(() => void tick(), ms);
  };

  // ---------------------------------------------------------------- actions
  const sessionById = (id: string): DeckSession => {
    const s = state?.sessions.find((x) => x.sessionId === id) ?? deps.sessions(hooks).find((x) => x.sessionId === id);
    if (!s) throw new Error('That session is no longer running.');
    return s;
  };

  /** Only a terminal session is safe to type into. In an editor the Claude
   *  input is one panel among many, its focus shortcut is a toggle, and one
   *  window can hold several Claude tabs, so a paste could land in a code file. */
  const typeable = (s: DeckSession): void => {
    if (s.host !== 'terminal') {
      throw new Error(`${s.title ?? s.name} runs in an editor, where the deck can't be sure which box it's typing into. Bring it to the front and reply there.`);
    }
  };

  /** Bring a session's window forward, or throw. Every action that types into
   *  a session goes through this first: pasting into whatever else has focus
   *  would put your reply in the wrong window. */
  const focusSession = async (id: string): Promise<DeckSession> => {
    const s = sessionById(id);
    if (!(await deps.hands.focusPid(s.pid, basename(s.cwd)))) {
      throw new Error(`Couldn't bring ${s.title ?? s.name} to the front. Its window may be minimised to the tray or closed.`);
    }
    return s;
  };

  /** Before pasting into "whatever is in front", check what is in front. */
  const checkForeground = async (): Promise<void> => {
    const fg = await deps.hands.foreground();
    if (!deps.deck().typeInto.includes(fg.proc)) {
      const what = fg.title ? `“${fg.title.slice(0, 60)}”` : fg.proc || 'nothing';
      throw new Error(`The window in front is ${what}, not a terminal or an editor, so nothing was pasted. Click into the Claude box first.`);
    }
  };

  /** Links come from the sheet as a JSON array, or one per line. */
  const parseLinks = (raw: string): string[] => {
    const s = raw.trim();
    if (!s) return [];
    try {
      const j = JSON.parse(s) as unknown;
      if (Array.isArray(j)) return j.map(String).filter((u) => /^https?:\/\/\S+$/.test(u));
    } catch {
      /* one per line */
    }
    return s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((u) => /^https?:\/\/\S+$/.test(u));
  };
  const kindOfUpload = (f: JotFile): string => (f.type.startsWith('image/') ? 'photo' : f.type.startsWith('audio/') ? 'voice' : attachmentKind(f.name));

  /** Which key was tapped, by the name the config gave it. Never the text of
   *  a reply or a jot: this log is for counting buttons, not reading messages. */
  const labelOf = (url: string, body: unknown): string | undefined => {
    const b = (body ?? {}) as Record<string, unknown>;
    const cfg = deps.deck();
    const path = url.split('?')[0];
    if (path === '/deck/prompt') return cfg.prompts[String(b.group)]?.[Number(b.index)]?.title;
    if (path === '/deck/app') return cfg.apps[Number(b.index)]?.label;
    if (path === '/deck/seat') return cfg.seats[Number(b.index)]?.title;
    if (path === '/deck/media') return String(b.cmd ?? '');
    if (path === '/deck/volume') return typeof b.muted === 'boolean' ? (b.muted ? 'mute' : 'unmute') : 'level';
    if (path === '/deck/day') return String(b.op ?? ''); // the op, never the text typed
    if (path === '/deck/jot') {
      // the kind and what came with it, never the words
      const files = (Array.isArray(b.files) ? (b.files as JotFile[]) : []).map(kindOfUpload);
      const linked = parseLinks(String(b.links ?? '')).length > 0 || urlsIn(String(b.text ?? '')).length > 0;
      return [String(b.kind || 'idea'), ...[...new Set(files)].sort(), ...(linked ? ['link'] : [])].join('+');
    }
    return undefined;
  };
  /** The tap log's action: the route, or for a card `card/<kind>/<action>`. */
  const actionOf = (url: string, body: unknown): string => {
    const path = url.split('?')[0].replace('/deck/', '');
    if (path !== 'card') return path;
    const b = (body ?? {}) as Partial<CardAction>;
    return `card/${String(b.id ?? '').split(':')[0] || '?'}/${String(b.action ?? '?')}`;
  };

  const recent = new Map<string, number>();
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/deck/')) return;
    if (path === '/deck/pair') return;
    if (path === '/deck/hook' || path === '/deck/health') {
      if (!local(req)) return reply.code(403).send({ error: 'only from this PC' });
      return;
    }
    if (!authed(req)) return reply.code(401).send({ error: 'not paired' });
  });

  // Every action answers { ok: true } or 409 { error } with a sentence the
  // tablet shows as-is. A repeat of the same request within DEDUPE_MS is a
  // double tap and is answered without acting twice: a doubled paste is the
  // kind of mistake that lands in a real conversation.
  const act =
    <B>(fn: (body: B) => Promise<unknown>, keyOf: (body: B) => string = (b) => JSON.stringify(b ?? {})) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.url + keyOf((req.body ?? {}) as B);
      const t = now();
      for (const [k, at] of recent) if (t - at > DEDUPE_MS) recent.delete(k);
      if (recent.has(key)) return { ok: true, repeat: true };
      recent.set(key, t);
      let ok = false;
      try {
        const out = await fn((req.body ?? {}) as B);
        ok = true;
        return { ok: true, ...(out && typeof out === 'object' ? out : {}) };
      } catch (e) {
        return reply.code(409).send({ error: (e as Error).message });
      } finally {
        try {
          deps.tapLog?.({ at: t, action: actionOf(req.url, req.body), label: labelOf(req.url, req.body), ok });
        } catch {
          /* counting taps must never fail one */
        }
        tickSoon(400); // show the effect without waiting for the next poll
      }
    };

  // The jot sheet posts multipart: fields and files. Node's own parser reads
  // it, no plugin; the cap is 60 MB a jot (20 MB a file, checked in the route).
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: JOT_BYTES }, async (req: FastifyRequest, body: Buffer) => {
    // A Buffer is a Uint8Array and fetch's Response takes one; the types disagree.
    const fd = await new Response(body as unknown as BodyInit, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    const files: JotFile[] = [];
    const out: Record<string, unknown> = { files };
    for (const [k, v] of fd) {
      if (typeof v === 'string') out[k] = v;
      else files.push({ name: v.name, type: v.type, bytes: Buffer.from(await v.arrayBuffer()) });
    }
    return out;
  });

  app.post<{ Body: { code?: string } }>('/deck/pair', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    if (pairCode && same(code, pairCode)) {
      newPairCode();
      return { token: deps.token };
    }
    if (++pairMisses >= 5) {
      newPairCode();
      return reply.code(429).send({ error: 'Too many wrong codes. Use the new one shown on the PC.' });
    }
    return reply.code(403).send({ error: "That code doesn't match the one on the PC." });
  });

  // Claude Code hooks (server/deck-hook.cmd) post here from this PC only. Stop
  // and UserPromptSubmit also mean "look again now", which is what makes a
  // glow appear the moment a turn ends instead of up to two seconds later.
  app.post<{ Body: { session_id?: string; hook_event_name?: string; message?: string } }>('/deck/hook', async (req) => {
    const b = req.body ?? {};
    if (b.session_id && b.hook_event_name) {
      hooks.set(b.session_id, { event: b.hook_event_name, message: b.message, at: now() });
      lastHook = { event: b.hook_event_name, session: b.session_id.slice(0, 8), agoAt: now() };
      if (hooks.size > 500) hooks.delete(hooks.keys().next().value!);
      tickSoon(150);
    }
    return { ok: true };
  });

  app.get('/deck/health', async () => ({
    ok: true,
    pairCode,
    port: deps.deck().port,
    uptimeSec: Math.round((now() - started) / 1000),
    lastPollAgoMs: lastPollAt ? now() - lastPollAt : null,
    lastPollMs,
    tablets: listeners.size,
    sessions: state?.sessions.length ?? 0,
    hooks: { sessions: hooks.size, last: lastHook },
    helpers: { taps: deps.hands.stats(), poll: deps.eyes.stats() },
    jots: { pending: jotQueue.size, errors: jotQueue.errors.slice(-5) },
    errors: state?.errors ?? [],
  }));

  // The tablet reports its screen on load and on resize, so a layout problem
  // can be read off the PC instead of described from across the desk.
  app.post<{ Body: Record<string, unknown> }>('/deck/hello', async (req) => {
    console.log('deck: tablet screen', JSON.stringify(req.body));
    return { ok: true };
  });

  app.get('/deck/state', async () => {
    if (!state) await tick();
    return state;
  });

  app.get('/deck/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (state) reply.raw.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    listeners.add(reply);
    req.raw.on('close', () => listeners.delete(reply));
  });

  app.get<{ Params: { id: string } }>('/deck/art/:id', async (req, reply) => {
    // The artwork cache lives in the poll helper, which is the one that read it.
    const b64 = await deps.eyes.art(req.params.id).catch(() => null);
    if (!b64) return reply.code(404).send({ error: 'no artwork' });
    const buf = Buffer.from(b64, 'base64');
    const type = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
    return reply.header('cache-control', 'private, max-age=86400').type(type).send(buf);
  });

  app.post('/deck/session/focus', act<{ sessionId: string }>(async (b) => void (await focusSession(b.sessionId))));

  app.post(
    '/deck/session/reply',
    act<{ sessionId: string; text: string }>(async (b) => {
      const text = String(b.text ?? '').trim();
      if (!text) throw new Error('Nothing to send.');
      typeable(sessionById(b.sessionId));
      await focusSession(b.sessionId);
      await deps.hands.paste(text, true);
    })
  );

  app.post('/deck/session/resume', act<{ sessionId: string }>(async (b) => deps.resumeSession(b.sessionId)));

  // Send to phone, by who holds the session (server/phone.ts says why):
  //   nobody    -> a new terminal resumes it with Remote Control on
  //   terminal  -> type /remote-control into it, the documented toggle
  //   editor    -> refuse, for the reason reply does: the deck can't be sure
  //                which box it is typing into
  const sendToPhone = async (s: DeckSession): Promise<{ typed?: boolean }> => {
    if (s.host === 'none') {
      deps.phoneSession(s.sessionId, s.title ?? s.name);
      return {};
    }
    if (s.host !== 'terminal') throw new Error(`${s.title ?? s.name} runs in an editor. Type /remote-control in its Claude box there.`);
    await focusSession(s.sessionId);
    await deps.hands.paste('/remote-control', true);
    return { typed: true };
  };
  app.post('/deck/session/phone', act<{ sessionId: string }>(async (b) => sendToPhone(sessionById(b.sessionId))));

  // ---------------------------------------------------------------- cards
  // One route for every button on a hand-back card. Each answer is a sentence
  // for the green line the card shrinks to, and `undo` when there is a way
  // back within the ten seconds the line stays.
  const cardById = (id: string): Card => {
    const c = state?.cards.find((x) => x.id === id);
    if (!c) throw new Error('That card has gone: the list moved on.');
    return c;
  };
  const str = (v: unknown): string => (v == null ? '' : String(v));
  const daySaid = (list: DayList | null): DayList => {
    if (!list) throw new Error('There is no day list in deck.config.jsonc.');
    return list;
  };

  const cardAction = async (b: CardAction): Promise<{ said: string; undo?: CardAction }> => {
    const id = str(b.id);
    const action = str(b.action);
    const kind = id.split(':')[0] as CardKind;

    // Undo arrives after the card has left the list, so these need no card.
    if (kind === 'chase' && action === 'unchase') {
      const list = daySaid(dayList());
      const chaseId = str(b.chaseId);
      if (chaseId) {
        list.apply({ op: 'unpick', id: chaseId });
        if (b.created === true) list.apply({ op: 'drop', id: chaseId });
      }
      return { said: 'Chase taken off Today' };
    }
    if (kind === 'chase' && action === 'unstill') {
      daySaid(dayList()).apply({ op: 'later', id: id.slice('chase:'.length), days: 0 });
      return { said: 'Back on the list' };
    }

    const c = cardById(id);
    switch (c.kind) {
      case 'session': {
        const s = sessionById(str(c.ref.sessionId));
        if (action in SESSION_REPLIES) {
          typeable(s);
          await focusSession(s.sessionId);
          await deps.hands.paste(SESSION_REPLIES[action], true);
          return { said: `Sent “${SESSION_REPLIES[action]}”. Claude is on it.` };
        }
        if (action === 'phone') {
          const r = await sendToPhone(s);
          return { said: r.typed ? 'Typed /remote-control. Open the Claude app.' : 'Sent to your phone. Open the Claude app.' };
        }
        if (action === 'front') {
          await focusSession(s.sessionId);
          return { said: 'Brought to the front on the PC.' };
        }
        if (action === 'resume') {
          deps.resumeSession(s.sessionId);
          return { said: 'Opened in a new terminal on the PC.' };
        }
        break;
      }
      case 'chase': {
        const list = daySaid(dayList());
        const itemId = str(c.ref.id);
        if (action === 'still') {
          list.apply({ op: 'later', id: itemId, days: CHASE_AFTER_DAYS });
          return { said: `Still waiting. Asks again in ${CHASE_AFTER_DAYS} days.`, undo: { id, action: 'unstill' } };
        }
        if (action === 'chase') {
          let items = list.read();
          const waiting = items.find((i) => i.id === itemId);
          if (!waiting) throw new Error('That item is no longer on the list.');
          let chase = chaseItemFor(items, waiting);
          let created = false;
          if (!chase) {
            list.apply({ op: 'add', text: `Chase ${waiting.title}`, area: waiting.area ?? undefined });
            items = list.read();
            chase = chaseItemFor(items, waiting);
            created = true;
          }
          if (!chase) throw new Error("Couldn't make the Chase card.");
          list.apply({ op: 'pick', id: chase.id });
          return { said: 'Chase is on Today.', undo: { id, action: 'unchase', chaseId: chase.id, created } };
        }
        break;
      }
    }
    throw new Error(`No "${action}" on a ${c.kind} card.`);
  };
  app.post(
    '/deck/card',
    act<CardAction>(async (b) => {
      if (!state) await tick();
      const out = await cardAction(b);
      // Answer now: the tablet shows the green line itself, and the card
      // leaves the list on the next poll.
      tickSoon(50);
      return out;
    })
  );

  // What a card opens into: a session's last turns, read when the screen
  // opens rather than on every poll.
  app.get<{ Params: { id: string } }>('/deck/resolve/:id', async (req, reply) => {
    if (!state) await tick();
    try {
      const c = cardById(req.params.id);
      if (c.kind !== 'session') return { card: c, context: { kind: c.kind } };
      const t = deps.transcript?.(str(c.ref.sessionId)) ?? null;
      return { card: c, context: { kind: 'session', turns: t && existsSync(t) ? sessionTurns(t) : [] } };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  // ---------------------------------------------------------------- push
  // A test message through ntfy, so the phone's subscription can be proved
  // from the deck: it opens at the top card, or at Now with nothing waiting.
  app.post(
    '/deck/push/test',
    act<Record<string, never>>(async () => {
      const t = deps.push?.() ?? null;
      if (!t) throw new Error('No push topic yet. On the PC: bash ntfy/install.sh');
      if (!state) await tick();
      const top = state?.cards[0] ?? null;
      const ok = await (deps.send ?? push)(t, {
        title: 'Deck test',
        body: top ? `Tap to open the deck at: ${top.title}` : 'Tap to open the deck. Nothing needs you right now.',
        click: cardUrl(t, top?.id ?? null),
        tags: 'bell',
        priority: 'default',
      });
      if (!ok) throw new Error(`ntfy at ${t.url} did not take it. Is the server up and the name resolving?`);
      return { said: top ? 'Sent. Tap it on the phone and the deck opens at the top card.' : 'Sent. Tap it on the phone and the deck opens.' };
    })
  );

  app.post(
    '/deck/prompt',
    act<{ group: string; index: number; target?: string }>(async (b) => {
      const key = deps.deck().prompts[b.group]?.[b.index];
      if (!key) throw new Error('That key is no longer in the config.');
      if (b.target && b.target !== 'focused') {
        typeable(sessionById(b.target));
        await focusSession(b.target);
      } else if (!key.keys) {
        await checkForeground();
      }
      if (key.keys) await deps.hands.keys(key.keys);
      else await deps.hands.paste(key.text!, !!key.send);
    })
  );

  app.post(
    '/deck/app',
    act<{ index: number }>(async (b) => {
      const a = deps.deck().apps[b.index];
      if (!a) throw new Error('That app is no longer in the config.');
      if (a.proc && (await deps.hands.focusApp(a.proc))) return { did: 'focused' };
      await deps.hands.launch(a.open);
      return { did: 'opened' };
    })
  );

  app.post(
    '/deck/media',
    act<{ cmd: 'toggle' | 'next' | 'prev'; app?: string }>(async (b) => {
      if (!['toggle', 'next', 'prev'].includes(b.cmd)) throw new Error('Unknown media command.');
      await deps.hands.mediaCmd(b.cmd, b.app);
    })
  );

  app.post(
    '/deck/volume',
    act<{ level?: number; muted?: boolean }>(async (b) => {
      if (typeof b.muted === 'boolean') await deps.hands.setMute(b.muted);
      else if (typeof b.level === 'number') await deps.hands.setVolume(Math.round(b.level));
      else throw new Error('Send a level or muted.');
    })
  );

  app.post(
    '/deck/seat',
    act<{ index: number }>(async (b) => {
      const seat = deps.deck().seats[b.index];
      if (!seat) throw new Error('That seat is no longer in the config.');
      let brief = seat.brief;
      if (brief.includes('{clipboard}')) {
        const clip = (await deps.hands.clipboard()).trim();
        if (seat.needsClipboard && !clip) throw new Error('Copy what this seat needs on the PC first. The clipboard is empty.');
        brief = brief.replaceAll('{clipboard}', clip.slice(0, 2000));
      }
      // The goal first, so the agent knows what the work is for before what to do.
      if (seat.why) brief = `Why this exists: ${seat.why}\n\n${brief}`;
      const out = deps.startSession({ dir: seat.dir, brief, title: seat.title });
      if (!out.launched) throw new Error(`Couldn't open a terminal. The brief is saved at ${out.briefPath}.`);
      return { dir: out.dir };
    })
  );

  app.post(
    '/deck/day',
    act<DayOp>(async (b) => {
      const list = dayList();
      if (!list) throw new Error('There is no day list in deck.config.jsonc.');
      if (!DAY_OPS.has(String(b.op))) throw new Error('Unknown day list action.');
      const said = list.apply(b);
      // A poll already running read the file before this change; wait it out
      // and poll again, so the tablet sees the change with the toast.
      if (polling) await polling;
      await tick();
      return { said };
    })
  );

  // ---------------------------------------------------------------- jot
  // One sheet from the plus key (server/jots.ts). An idea is a note in the
  // jots folder. A task kind goes to the day list, and gets a note too when
  // something is attached; the item then names the note and the note names
  // the item. The route answers at once; reading the link and describing the
  // photo happen after, one at a time, and the note says so when one fails.
  interface JotBody {
    text?: string;
    kind?: string;
    area?: string;
    links?: string;
    source?: string;
    files?: JotFile[];
  }
  const dayAdd = (kind: JotAsk, text: string, area: string | null, jot?: string): { said: string; id: string | null } => {
    const list = daySaid(dayList());
    const a = area ?? undefined;
    const said = kind === 'wait' ? list.apply({ op: 'wait', text, area: a, jot }) : list.apply({ op: 'add', text, area: a, when: kind as When, jot });
    const id = jot ? (list.read().find((i) => i.jot === jot)?.id ?? null) : null;
    return { said, id };
  };

  app.post(
    '/deck/jot',
    act<JotBody>(
      async (b) => {
        const dayCfg = deps.deck().day;
        if (!dayCfg) throw new Error('There is no day block in deck.config.jsonc, so there is nowhere to file a jot.');
        const text = str(b.text).replace(/\r\n/g, '\n').trim();
        const kindRaw = str(b.kind) || 'idea';
        if (!(JOT_ASKS as readonly string[]).includes(kindRaw)) throw new Error('Unknown jot kind.');
        const kind = kindRaw as JotAsk;
        const files = Array.isArray(b.files) ? b.files : [];
        for (const f of files) if (f.bytes.length > JOT_FILE_BYTES) throw new Error(`${f.name} is over 20 MB, the most one file can be.`);
        const links = [...new Set([...parseLinks(str(b.links)), ...urlsIn(text)])];
        if (!text && !files.length && !links.length) throw new Error('Nothing to jot.');
        const area = deps.deck().areas.some((a) => a.id === b.area) ? str(b.area) : null;
        const source = b.source === 'phone' || b.source === 'pc' ? b.source : 'deck';
        // A task with nothing attached is the day list's alone.
        if (kind !== 'idea' && !files.length && !links.length) return { said: dayAdd(kind, text, area).said };
        const note = writeJot(jotsDir(dayCfg), { text, area, source, links, files }, now());
        if (deps.jotTools) afterSave(note, deps.jotTools, jotQueue, now);
        let said = saidFor(note);
        if (kind !== 'idea') {
          const added = dayAdd(kind, text || links[0] || note.attachments[0], area, note.stem);
          if (added.id) setFrontmatter(note.path, 'task', added.id);
          said = `${added.said}, with the note. ${said.replace(/^Jotted\.\s*/, '')}`.trim();
        }
        return { said, stem: note.stem };
      },
      // the double-tap key: the words and the file names, never the bytes
      (b) => JSON.stringify([b.text, b.kind, b.links, (Array.isArray(b.files) ? b.files : []).map((f) => [f.name, f.bytes?.length])])
    )
  );

  // Make it a task, from the sheet's "Jotted this week" list.
  app.post(
    '/deck/jot/task',
    act<{ stem?: string; when?: string }>(async (b) => {
      const dayCfg = deps.deck().day;
      if (!dayCfg) throw new Error('There is no day list in deck.config.jsonc.');
      const stem = str(b.stem);
      if (!/^[a-z0-9-]+$/.test(stem)) throw new Error('Which jot?');
      const path = join(jotsDir(dayCfg), `${stem}.md`);
      if (!existsSync(path)) throw new Error('That jot is no longer in the folder.');
      const src = readFileSync(path, 'utf8');
      const s = summarize(stem, 0, src);
      if (s.task) throw new Error('Already on the list.');
      const ask: JotAsk = b.when === 'today' || b.when === 'someday' ? b.when : 'soon';
      const added = dayAdd(ask, noteText(src) || stem, s.area, stem);
      if (added.id) setFrontmatter(path, 'task', added.id);
      return { said: added.said };
    })
  );

  // The phone's share sheet posts to /share; the service worker in the page
  // answers it (ui/public/sw.js). This is the fallback when none is running
  // yet: nothing kept, just the app.
  app.post('/share', async (_req, reply) => reply.redirect('/', 303));
  app.get('/share', async (_req, reply) => reply.redirect('/', 303));

  if (deps.uiDist && existsSync(deps.uiDist)) {
    void app.register(fastifyStatic, { root: deps.uiDist, cacheControl: false });
    app.addHook('onSend', async (req, reply, payload) => {
      // index.html must never be cached or a rebuilt UI is invisible on the
      // tablet; hashed assets can be cached for good.
      if (req.url.startsWith('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      else if (!req.url.startsWith('/deck/')) reply.header('cache-control', 'no-cache');
      return payload;
    });
  } else {
    app.get('/', async () => 'The deck UI is not built. Run: npm run build');
  }

  // ---------------------------------------------------------------- timers
  const timers: NodeJS.Timeout[] = [];
  const startTimers = (): void => {
    timers.push(setInterval(() => void tick(), 2000));
    // A named event, not an SSE comment: comments never reach the page, and
    // the page needs something to count to notice a link that died quietly.
    timers.push(setInterval(() => send('ping', { at: now() }), HEARTBEAT_MS));
  };
  const stop = (): void => {
    for (const t of timers) clearInterval(t);
    for (const res of listeners) res.raw.end();
    listeners.clear();
  };

  newPairCode();
  return { app, tick, startTimers, stop, pairCode: () => pairCode, hooks, jotsIdle: () => jotQueue.idle() };
}
