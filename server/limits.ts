// Claude's plan limits as the status line last saw them, for the deck.
//
// Claude Code hands a status line command `rate_limits` on stdin: the five-hour
// and seven-day windows, percent used and reset time (documented at
// code.claude.com/docs/en/statusline). It is the one supported place a
// subscription's limits reach a local program. server/statusline.ts saves them
// to LIMITS_FILE on every status line update, and the deck reads them back
// here.
//
// The VS Code panel never runs a status line, though, and neither do headless
// runs. So the bridge also asks Claude Code itself every five minutes: `claude -p /usage` prints the same figures as text, makes no model
// call (0 tokens, 0 turns, about 4 s) and does its own login refresh. That
// command is undocumented in print mode, so its text is parsed loosely and a
// change of wording reads as "no reading", never as a wrong number. Both write
// LIMITS_FILE, so whichever spoke last is what the deck shows.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './util.ts';

export const LIMITS_FILE = join(DATA_DIR, 'rate-limits.json');

export interface LimitWindow {
  id: 'five_hour' | 'seven_day';
  /** percent used; null once the reset time has passed and no session has said since */
  pct: number | null;
  /** epoch ms */
  resetsAt: number;
}

export interface ClaudeLimits {
  /** when the status line saved this, epoch ms */
  at: number;
  windows: LimitWindow[];
}

const IDS = ['five_hour', 'seven_day'] as const;

/** The windows out of a status line's `rate_limits`, resets in epoch ms. Null: none there. */
export function parseRateLimits(raw: unknown): { id: LimitWindow['id']; pct: number; resetsAt: number }[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: { id: LimitWindow['id']; pct: number; resetsAt: number }[] = [];
  for (const id of IDS) {
    const w = (raw as Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined>)[id];
    if (typeof w?.used_percentage !== 'number' || typeof w.resets_at !== 'number') continue;
    out.push({ id, pct: Math.round(w.used_percentage), resetsAt: w.resets_at * 1000 });
  }
  return out.length ? out : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LINES: [LimitWindow['id'], RegExp][] = [
  ['five_hour', /^Current session: (\d+)% used · resets (.+)$/m],
  ['seven_day', /^Current week \(all models\): (\d+)% used · resets (.+)$/m],
];

/** "Oct 21, 7pm (Europe/London)" or "1:50pm" as epoch ms, in this machine's
 *  time zone (the CLI prints the same one). No year: the next one that is not
 *  in the past. Null: a shape this does not know. */
export function parseReset(text: string, now = Date.now()): number | null {
  const m = text.match(/^(?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm)\b/);
  if (!m) return null;
  const d = new Date(now);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1]);
    if (month < 0) return null;
    d.setMonth(month, Number(m[2]));
  }
  d.setHours((Number(m[3]) % 12) + (m[5] === 'pm' ? 12 : 0), Number(m[4] ?? 0), 0, 0);
  if (d.getTime() < now - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

/** The two windows out of `/usage`'s text. Null: neither line found. */
export function parseUsageText(text: string, now = Date.now()): { id: LimitWindow['id']; pct: number; resetsAt: number }[] | null {
  const out: { id: LimitWindow['id']; pct: number; resetsAt: number }[] = [];
  for (const [id, re] of LINES) {
    const m = text.match(re);
    const resetsAt = m ? parseReset(m[2], now) : null;
    if (m && resetsAt !== null) out.push({ id, pct: Number(m[1]), resetsAt });
  }
  return out.length ? out : null;
}

/** Saves windows for readLimits. Several writers (each status line, the
 *  bridge) may race: each writes its own temp file and renames it over the
 *  last, so a reader never sees half a file, and a rename that loses is dropped. */
export function writeLimits(windows: { id: LimitWindow['id']; pct: number; resetsAt: number }[], path = LIMITS_FILE, now = Date.now()): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ at: now, windows }));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Asks Claude Code for `/usage` and saves what it says. Resolves false when
 *  the CLI fails, times out or prints something unrecognised. */
export function fetchLimits(cli: string, path = LIMITS_FILE): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      cli,
      ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
      { cwd: tmpdir(), timeout: 30_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(false);
        try {
          const windows = parseUsageText(String((JSON.parse(stdout) as { result?: unknown }).result ?? ''));
          resolve(windows ? writeLimits(windows, path) : false);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

/** What a status line or the bridge last saved. Null: nothing saved yet, or the file is unreadable. */
export function readLimits(path = LIMITS_FILE, now = Date.now()): ClaudeLimits | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; windows?: unknown };
    if (typeof j.at !== 'number' || !Array.isArray(j.windows)) return null;
    const windows = (j.windows as LimitWindow[])
      .filter((w) => IDS.includes(w.id) && typeof w.resetsAt === 'number')
      .map((w) => ({ id: w.id, pct: w.resetsAt <= now ? null : w.pct, resetsAt: w.resetsAt }));
    return { at: j.at, windows };
  } catch {
    return null;
  }
}
