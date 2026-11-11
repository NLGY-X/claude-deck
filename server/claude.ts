// Claude Code sessions on this PC, read from Claude Code's own files:
//
//   ~/.claude/sessions/<pid>.json        one row per running process
//   ~/.claude/projects/<key>/<id>.jsonl  the transcript of each session
//
// The transcripts are the base set: the registry is pruned on a timer, so a
// session that no process holds any more is still listed (host "none") and
// can be resumed or sent to the phone. This is a read of those files on each
// poll, nothing is cached on disk.
//
// Starting and resuming a session open a new terminal through a .cmd file
// rather than a long command line: folder names have spaces, and `wt` reads
// `;` as a pane separator.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

export interface LiveSession {
  sessionId: string;
  /** 0 when no process holds it */
  pid: number;
  name: string;
  cwd: string;
  project: string;
  kind: string;
  entrypoint: string | null;
  /** transcript mtime, epoch ms */
  lastActivity: number | null;
  idleMs: number | null;
  transcript: string | null;
}

interface RegistryRow {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  updatedAt?: number;
  kind?: string;
  entrypoint?: string;
  name?: string;
}

let txCache: { at: number; map: Map<string, string> } | null = null;

/** sessionId to transcript path, across every project folder. Cached for ten seconds. */
function transcriptIndex(): Map<string, string> {
  if (txCache && Date.now() - txCache.at < 10_000) return txCache.map;
  const map = new Map<string, string>();
  if (existsSync(PROJECTS_DIR)) {
    for (const key of readdirSync(PROJECTS_DIR)) {
      let files: string[];
      try {
        files = readdirSync(join(PROJECTS_DIR, key));
      } catch {
        continue;
      }
      for (const f of files) if (f.endsWith('.jsonl')) map.set(f.slice(0, -'.jsonl'.length), join(PROJECTS_DIR, key, f));
    }
  }
  txCache = { at: Date.now(), map };
  return map;
}

const projCache = new Map<string, string | null>();
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A project folder's name back to the path it stands for. Claude Code turns
 * `C:\Users\me\code\my-app` into `C--Users-me-code-my-app`, which loses the
 * difference between `\` and `-`, so this walks the disk and takes the longest
 * folder name that matches at each step. Null when the folder is gone.
 */
export function resolveProject(key: string): string | null {
  if (projCache.has(key)) return projCache.get(key)!;
  const m = /^([A-Za-z])--(.+?)-*$/.exec(key);
  let out: string | null = null;
  if (m) {
    let cur = m[1].toUpperCase() + ':\\';
    const parts = m[2].split('-');
    let i = 0;
    let ok = true;
    const isDir = (name: string): boolean => {
      try {
        return statSync(join(cur, name)).isDirectory();
      } catch {
        return false;
      }
    };
    while (i < parts.length) {
      let dirs: string[];
      try {
        dirs = readdirSync(cur).map(String);
      } catch {
        ok = false;
        break;
      }
      let hit: string | null = null;
      let len = 0;
      for (let l = parts.length - i; l >= 1; l--) {
        const cand = norm(parts.slice(i, i + l).join('-'));
        const found = dirs.find((d) => norm(d) === cand && isDir(d));
        if (found) {
          hit = found;
          len = l;
          break;
        }
      }
      if (!hit) {
        ok = false;
        break;
      }
      cur = join(cur, hit);
      i += len;
    }
    if (ok) out = cur;
  }
  projCache.set(key, out);
  return out;
}

/** Every session with a transcript or a registry row, newest first. */
export function listLiveSessions(): LiveSession[] {
  const tx = transcriptIndex();
  const now = Date.now();
  let files: string[] = [];
  try {
    if (existsSync(SESSIONS_DIR)) files = readdirSync(SESSIONS_DIR);
  } catch {
    files = [];
  }

  // A stale <pid>.json survives a restart: dedupe by session, newest row wins.
  const bySession = new Map<string, RegistryRow>();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let row: RegistryRow;
    try {
      row = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')) as RegistryRow;
    } catch {
      continue;
    }
    if (!row.sessionId || !row.cwd) continue;
    const prev = bySession.get(row.sessionId);
    const stamp = (r: RegistryRow): number => r.updatedAt ?? r.startedAt ?? 0;
    if (!prev || stamp(row) >= stamp(prev)) bySession.set(row.sessionId, row);
  }
  for (const [sessionId, path] of tx) {
    if (bySession.has(sessionId)) continue;
    const cwd = resolveProject(basename(dirname(path)));
    if (!cwd) continue;
    bySession.set(sessionId, { sessionId, cwd, pid: 0, name: `${(basename(cwd) || 'session').toLowerCase()}-${sessionId.slice(0, 2)}`, kind: 'interactive' });
  }

  const out: LiveSession[] = [];
  for (const row of bySession.values()) {
    const transcript = tx.get(row.sessionId!) ?? null;
    let lastActivity: number | null = null;
    if (transcript) {
      try {
        lastActivity = statSync(transcript).mtimeMs;
      } catch {
        lastActivity = null;
      }
    }
    if (lastActivity == null) lastActivity = row.updatedAt ?? row.startedAt ?? null;
    const cwd = row.cwd!;
    out.push({
      sessionId: row.sessionId!,
      pid: row.pid ?? 0,
      name: row.name ?? row.sessionId!.slice(0, 8),
      cwd,
      project: basename(cwd) || cwd,
      kind: row.kind ?? 'interactive',
      entrypoint: row.entrypoint ?? null,
      lastActivity,
      idleMs: lastActivity == null ? null : Math.max(0, now - lastActivity),
      transcript,
    });
  }
  return out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
}

/** Opening a terminal is the one step a test cannot take, so it is a parameter. */
export type Launcher = (cmdPath: string) => void;

const openTerminal: Launcher = (cmdPath) => {
  spawn('cmd', ['/c', 'start', '', cmdPath], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
};

const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
/** A window title goes on a command line: drop what cmd treats specially. */
const safeTitle = (t: string): string => t.replace(/[%&|<>^"\r\n]/g, ' ').slice(0, 60);

/** `claude --resume <id>` in a new terminal, in the session's own folder.
 *  The folder comes from Claude Code's files, never from the request. */
export function resumeSession(sessionId: string, launch: Launcher = openTerminal): { dir: string; launched: boolean } {
  const found = listLiveSessions().find((s) => s.sessionId === sessionId);
  if (!found) throw new Error('That session is no longer in Claude Code’s files.');
  if (!existsSync(found.cwd)) throw new Error(`The session's folder no longer exists: ${found.cwd}`);
  const cmdPath = join(tmpdir(), `claude-deck-resume-${stampNow()}.cmd`);
  writeFileSync(cmdPath, `@echo off\r\ntitle ${safeTitle(found.name)}\r\ncd /d "${found.cwd}"\r\nclaude --resume ${sessionId}\r\n`, 'utf8');
  let launched = true;
  try {
    launch(cmdPath);
  } catch {
    launched = false;
  }
  return { dir: found.cwd, launched };
}

let startSeq = 0;

/**
 * A fresh session in `dir` with `brief` as its first instruction. The brief
 * goes in a file and the command line carries only its path: a brief is prose
 * (quotes, %, &, new lines) and a path needs no escaping.
 */
export function startSession(req: { dir: string; brief: string; title?: string }, launch: Launcher = openTerminal): { dir: string; briefPath: string; launched: boolean } {
  const brief = req.brief.trim();
  if (!brief) throw new Error('A seat needs a brief.');
  if (!existsSync(req.dir)) throw new Error(`The seat's folder does not exist: ${req.dir}`);
  const stamp = `${stampNow()}-${process.pid}-${++startSeq}`;
  const briefPath = join(tmpdir(), `claude-deck-brief-${stamp}.md`);
  writeFileSync(briefPath, brief.replace(/\r?\n/g, '\r\n'), 'utf8');
  const cmdPath = join(tmpdir(), `claude-deck-start-${stamp}.cmd`);
  const title = safeTitle(req.title ?? basename(req.dir));
  writeFileSync(cmdPath, `@echo off\r\ntitle ${title}\r\ncd /d "${req.dir}"\r\nclaude "Read the brief at ${briefPath} and carry out what it asks."\r\n`, 'utf8');
  let launched = true;
  try {
    launch(cmdPath);
  } catch {
    launched = false;
  }
  return { dir: req.dir, briefPath, launched };
}
