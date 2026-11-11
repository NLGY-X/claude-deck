// Small helpers the rest of the bridge shares: where the deck keeps its own
// files, JSON with comments, home-relative paths, flat frontmatter, and where
// the Claude Code executable lives.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The deck's own files: the token, the log, the tap log, the push topic.
 *  CLAUDE_DECK_HOME moves it. */
export const DATA_DIR = process.env.CLAUDE_DECK_HOME || join(homedir(), '.claude-deck');

/** Strip // and block comments plus trailing commas, without touching strings. */
export function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** `~` is the home folder; a relative path is relative to this repo. */
export function expandPath(p: string): string {
  const expanded = p.replace(/^~(?=[/\\]|$)/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(REPO_DIR, expanded);
}

/** Forward slashes, lower case, no trailing slash: for comparing paths on a case-insensitive filesystem. */
export const pathKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** True when `p` is `root` or inside it. */
export const isUnder = (p: string, root: string): boolean => {
  const k = pathKey(p);
  const r = pathKey(root);
  return k === r || k.startsWith(`${r}/`);
};

// Flat frontmatter: scalars, inline [a, b] lists and `- item` block lists.
// Anything else is skipped, never fatal.
type FmValue = string | string[];
const unquote = (s: string): string => s.replace(/^["']|["']$/g, '').trim();

export function parseFrontmatter(src: string): { fm: Record<string, FmValue>; body: string; hasFm: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { fm: {}, body: src, hasFm: false };
  const fm: Record<string, FmValue> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey) (fm[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w -]*?)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      listKey = null;
      continue;
    }
    const key = kv[1].trim().toLowerCase().replace(/\s+/g, '_');
    const raw = kv[2].trim();
    if (!raw) {
      fm[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      fm[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean);
    } else {
      fm[key] = unquote(raw);
    }
  }
  return { fm, body: src.slice(m[0].length), hasFm: true };
}

/** The Claude Code executable. On Windows a bare `claude` spawned with
 *  shell: true goes through cmd.exe and its quoting, so the real .exe is found
 *  instead. CLAUDE_DECK_CLAUDE_BIN overrides. */
export function resolveCli(env: NodeJS.ProcessEnv = process.env, exists = existsSync): string {
  const home = homedir();
  const inPkg = join('node_modules', '@anthropic-ai', 'claude-code', 'bin');
  const candidates = [
    env.CLAUDE_DECK_CLAUDE_BIN,
    join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', inPkg, 'claude.exe'),
    join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'npm', inPkg, 'claude.exe'),
    join(home, '.local', 'bin', 'claude.exe'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (exists(c)) return c;
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, 'claude' + ext);
      if (exists(p)) return p;
    }
  }
  return 'claude';
}
