// What each Claude session is doing right now, from the tail of its transcript.
//
// The deck needs to know whose move it is, and the transcript says so:
//
//   last entry is Claude, turn ended      -> your move (a question: needs you)
//   last entry is Claude, calling a tool  -> a tool is running, or a
//                                            permission prompt is up; after a
//                                            while we cannot tell which, so say so
//   last entry is you or a tool result    -> Claude's move: working
//
// A glow that cries wolf gets ignored, so "needs you" is reserved for a turn
// that ends on a question, and everything else says what it saw instead of
// guessing.

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { listLiveSessions, type LiveSession } from './claude.ts';

export type Phase = 'needs' | 'permission' | 'blocked' | 'working' | 'done' | 'idle';

/** The last Claude Code hook a session fired (server/deck-hook.cmd posts these). A
 *  permission prompt never reaches the transcript, so this is the only way to
 *  know one is up rather than guess from a quiet tool call. */
export interface HookEvent {
  event: string;
  message?: string;
  at: number;
}

export interface DeckSession {
  sessionId: string;
  pid: number;
  name: string;
  /** Claude Code's own one-line title for the conversation, once it has written one */
  title: string | null;
  project: string;
  /** the config area whose `paths` hold its folder */
  area: string | null;
  cwd: string;
  phase: Phase;
  /** what to put on the tile: Claude's last words, or the tool it is running */
  text: string;
  /** e.g. "Bash", or null when the last thing was prose */
  tool: string | null;
  /** ms since the transcript last changed */
  ageMs: number;
  /** "vscode" when the session lives in VS Code or Cursor, which changes what focusing it can do;
   *  "none" when no process holds it: nothing to focus or type into, but it
   *  can be resumed or sent to the phone */
  host: 'terminal' | 'vscode' | 'other' | 'none';
}

/** Sessions quiet for longer than this are off the deck. Windows reuses process
 *  ids, so a registry row from three weeks ago can point at a live, unrelated
 *  process; age is the check that does not depend on the pid. */
export const OFF_DECK_AFTER_MS = 12 * 60 * 60_000;
/** How long a pending tool call runs before we stop calling it "working". Long
 *  enough for a test suite, short enough that a permission prompt does not sit
 *  unseen for ten minutes. */
export const BLOCKED_AFTER_MS = 45_000;
/** A user turn with nothing after it for this long was abandoned or interrupted. */
const STALLED_AFTER_MS = 15 * 60_000;
const TAIL_BYTES = 256 * 1024;

interface Entry {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  aiTitle?: string;
  message?: { role?: string; stop_reason?: string | null; content?: unknown };
  timestamp?: string;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

const blocks = (e: Entry): Block[] => (Array.isArray(e.message?.content) ? (e.message!.content as Block[]) : []);

function toolSummary(b: Block): string {
  const i = b.input ?? {};
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const detail =
    pick('description') ||
    pick('command') ||
    (pick('file_path') && basename(pick('file_path'))) ||
    pick('pattern') ||
    pick('url') ||
    pick('prompt');
  return detail.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** The end of what Claude said, which is where a question lives. */
function lastWords(text: string, max = 320): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const start = cut.search(/[.!?]\s+[A-Z]/);
  return '…' + (start >= 0 && start < 120 ? cut.slice(start + 2) : cut);
}

/** True when a turn ends by asking you something. Trailing markdown and a
 *  closing bracket or quote do not hide the question mark. */
export function endsOnQuestion(text: string): boolean {
  return /\?\s*[)"'”*_`]*\s*$/.test(text.trim());
}

/** Pure: the phase and tile text from the last entries of a transcript. */
export function derive(entries: Entry[], ageMs: number): Pick<DeckSession, 'phase' | 'text' | 'tool'> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    if (e.isMeta || e.isCompactSummary) continue;
    const bs = blocks(e);

    if (e.type === 'assistant') {
      const tool = [...bs].reverse().find((b) => b.type === 'tool_use');
      if (tool) {
        const running = ageMs < BLOCKED_AFTER_MS;
        return { phase: running ? 'working' : 'blocked', text: toolSummary(tool), tool: tool.name ?? 'tool' };
      }
      const text = bs.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
      if (!text) continue; // a thinking-only chunk; the turn's words are further up
      return { phase: endsOnQuestion(text) ? 'needs' : 'done', text: lastWords(text), tool: null };
    }

    // A user entry: your prompt, a tool result, or an interrupt marker.
    const content = e.message?.content;
    const plain = typeof content === 'string' ? content : bs.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ');
    if (/^\[Request interrupted/.test(plain.trim())) return { phase: 'done', text: 'Interrupted. Your move.', tool: null };
    // Claude Code's own bookkeeping (a slash command and its output) is not a
    // turn by either side. /compact leaves one as the last entry, and the move
    // is still yours.
    if (/^<(local-command|command-)/.test(plain.trim())) {
      if (/Compacted/.test(plain)) return { phase: 'done', text: 'Compacted. Your move.', tool: null };
      continue;
    }
    if (!plain.trim() && !bs.some((b) => b.type === 'tool_result')) continue;
    return {
      phase: ageMs > STALLED_AFTER_MS ? 'idle' : 'working',
      text: bs.some((b) => b.type === 'tool_result') ? 'Reading the result' : lastWords(plain, 160),
      tool: null,
    };
  }
  return { phase: 'idle', text: '', tool: null };
}

/** The last TAIL_BYTES of a file as parsed JSON lines. The first line is
 *  usually cut in half by the seek and is dropped. */
export function readTail(path: string): { entries: Entry[]; mtimeMs: number; title: string | null } {
  const fd = openSync(path, 'r');
  try {
    const { size, mtimeMs } = fstatSync(fd);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    const entries: Entry[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        entries.push(JSON.parse(l));
      } catch {
        /* a line being written as we read; the next poll gets it */
      }
    }
    let title: string | null = null;
    for (let i = entries.length - 1; i >= 0 && !title; i--) if (entries[i].type === 'ai-title') title = entries[i].aiTitle ?? null;
    return { entries, mtimeMs, title };
  } finally {
    closeSync(fd);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function hostOf(s: Pick<LiveSession, 'pid' | 'entrypoint' | 'kind'>): DeckSession['host'] {
  if (!s.pid) return 'none'; // a transcript with no registry row: nobody holds it
  const where = `${s.entrypoint ?? ''} ${s.kind}`.toLowerCase();
  if (where.includes('vscode')) return 'vscode';
  if (where.includes('cli') || where.includes('interactive')) return 'terminal';
  return 'other';
}

const RANK: Record<Phase, number> = { permission: 0, needs: 0, blocked: 1, done: 2, working: 3, idle: 4 };

/**
 * A permission prompt the hooks reported, if it is still the latest thing that
 * happened. Anything the session writes afterwards (the tool's result once
 * you answer, or a new prompt) moves the transcript past it; a Stop,
 * PostToolUse or UserPromptSubmit hook replaces it outright.
 */
export function permissionPending(hook: HookEvent | undefined, transcriptMtime: number): string | null {
  if (!hook || hook.event !== 'Notification' || !/permission/i.test(hook.message ?? '')) return null;
  return hook.at >= transcriptMtime - 1000 ? (hook.message ?? 'Claude needs your permission') : null;
}

// Parsing 256 KB of JSON per session every two seconds is wasted work when
// the file has not changed, which is most of the time.
const tailCache = new Map<string, { mtimeMs: number; size: number; tail: ReturnType<typeof readTail> }>();
function cachedTail(path: string): ReturnType<typeof readTail> {
  const { mtimeMs, size } = statSync(path);
  const hit = tailCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.tail;
  const tail = readTail(path);
  tailCache.set(path, { mtimeMs, size, tail });
  if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value!);
  return tail;
}

/** Every session whose process is still running, most urgent first. A closed
 *  session is not on the deck: there is nothing to tap it into. */
export function deckSessions(areaOf: (cwd: string) => string | null, hooks: Map<string, HookEvent> = new Map(), now = Date.now()): DeckSession[] {
  const out: DeckSession[] = [];
  for (const s of listLiveSessions()) {
    if (!alive(s.pid)) continue;
    let d: Pick<DeckSession, 'phase' | 'text' | 'tool'> = { phase: 'idle', text: '', tool: null };
    let ageMs = s.idleMs ?? Number.MAX_SAFE_INTEGER;
    let title: string | null = null;
    if (s.transcript) {
      try {
        const tail = cachedTail(s.transcript);
        ageMs = now - tail.mtimeMs;
        title = tail.title;
        d = derive(tail.entries, ageMs);
        const ask = permissionPending(hooks.get(s.sessionId), tail.mtimeMs);
        if (ask) d = { phase: 'permission', text: ask, tool: d.tool };
      } catch {
        /* unreadable transcript: shown as quiet */
      }
    }
    if (ageMs > OFF_DECK_AFTER_MS) continue;
    out.push({
      sessionId: s.sessionId,
      pid: s.pid,
      name: s.name,
      title,
      project: s.project,
      area: areaOf(s.cwd),
      cwd: s.cwd,
      ...d,
      ageMs,
      host: hostOf(s),
    });
  }
  return out.sort((a, b) => RANK[a.phase] - RANK[b.phase] || a.ageMs - b.ageMs);
}

/** The last turns of a transcript as words: your prompts and Claude's
 *  replies, with tool traffic, slash commands and reminders left out. */
export function sessionTurns(transcript: string, max = 6): { who: 'you' | 'claude'; text: string }[] {
  const out: { who: 'you' | 'claude'; text: string }[] = [];
  for (const e of readTail(transcript).entries) {
    if ((e.type !== 'assistant' && e.type !== 'user') || e.isMeta || e.isCompactSummary) continue;
    const c = e.message?.content;
    const bs = Array.isArray(c) ? (c as Block[]) : [];
    if (e.type === 'user' && bs.some((b) => b.type === 'tool_result')) continue;
    const raw = typeof c === 'string' ? c : bs.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!text || /^<(local-command|command-)/.test(text) || /^\[Request interrupted/.test(text)) continue;
    const who = e.type === 'assistant' ? 'claude' : 'you';
    const cut = text.length > 900 ? (who === 'claude' ? `…${text.slice(-900)}` : `${text.slice(0, 900)}…`) : text;
    const last = out[out.length - 1];
    // One reply arrives as several assistant entries around tool calls; join them.
    if (last && last.who === 'claude' && who === 'claude') last.text = `${last.text}\n${cut}`;
    else out.push({ who, text: cut });
  }
  return out.slice(-max);
}
