// Jot: one idea from anywhere, kept as one dated note in the jots folder
// beside the day list. The note is useful the moment it is saved. What the PC
// adds afterwards (a link's text copy, a photo's description, a voice note
// written down) is appended as each arrives, one job at a time, and when a
// job fails the note says so: nothing here fails quietly.
//
//   <jots>/2026-10-28-1012-a-monthly-chart.md
//   <jots>/2026-10-28-1012-a-monthly-chart.png
//
// Any markdown editor reads the folder as it is.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseFrontmatter } from './util.ts';
import type { DayConfig } from './day.ts';

/** The note's kind, by what it mainly holds. */
export type JotKind = 'idea' | 'link' | 'photo' | 'voice' | 'file';
export type JotSource = 'deck' | 'phone' | 'pc';
/** What the sheet asks: an idea, or one of the day list's kinds. */
export const JOT_ASKS = ['idea', 'today', 'soon', 'someday', 'wait'] as const;
export type JotAsk = (typeof JOT_ASKS)[number];

export interface JotFile {
  name: string;
  type: string;
  bytes: Buffer;
}
export interface JotInput {
  text: string;
  area: string | null;
  source: JotSource;
  links: string[];
  files: JotFile[];
}
export interface JotNote {
  stem: string;
  path: string;
  kind: JotKind;
  /** file names beside the note */
  attachments: string[];
  links: string[];
}
/** One line in "Jotted this week" on the sheet. */
export interface JotSummary {
  stem: string;
  at: number;
  kind: JotKind;
  area: string | null;
  text: string;
  attachments: number;
  links: number;
  /** the day list item it became, when it did */
  task: string | null;
  /** what the PC is still doing for it: "reading the link" */
  pending: string | null;
}
export interface LinkCopy {
  url: string;
  title: string;
  text: string;
  /** why there is no text: not a page */
  note?: string;
}
/** The three things the PC does after a save. The bridge wires the real ones;
 *  tests pass fakes. `transcribe` is absent where there is no Python. */
export interface JotTools {
  fetchLink: (url: string) => Promise<LinkCopy>;
  describePhoto: (path: string) => Promise<string>;
  transcribe?: (path: string) => Promise<string>;
}

export const JOT_FILE_BYTES = 20 * 1024 * 1024;
export const JOT_BYTES = 60 * 1024 * 1024;
/** How much of a page's text the note keeps. */
export const MAX_COPY_CHARS = 60_000;

export const jotsDir = (day: Pick<DayConfig, 'list' | 'jots'>): string => day.jots ?? join(dirname(day.list), 'jots');

// ------------------------------------------------------------------ names

const pad = (n: number): string => String(n).padStart(2, '0');
/** "2026-10-28 10:12", local time. */
export const stamp = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The stem's clock, back to a time: 2026-10-28-1012-... */
export function stemTime(stem: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-|$)/.exec(stem);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/** The words, lower case, cut at a word, never empty. */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = s.length > 40 ? s.slice(0, 40).replace(/-[^-]*$/, '') || s.slice(0, 40) : s;
  return cut.replace(/-+$/, '') || 'jot';
}

export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const firstLine = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};
const extOf = (f: Pick<JotFile, 'name' | 'type'>): string => {
  const e = extname(f.name).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(e) ? e : (EXT_BY_TYPE[f.type.split(';')[0].trim()] ?? '.bin');
};
export const isImage = (name: string): boolean => /\.(png|jpe?g|webp|gif|heic|bmp)$/i.test(name);
export const isAudio = (name: string): boolean => /\.(m4a|mp3|webm|ogg|wav|aac|opus)$/i.test(name);
export const attachmentKind = (name: string): JotKind => (isImage(name) ? 'photo' : isAudio(name) ? 'voice' : 'file');

/** A photo outranks a voice note outranks a file outranks a link; words alone are an idea. */
export function noteKind(attachments: string[], links: string[]): JotKind {
  const kinds = attachments.map(attachmentKind);
  for (const k of ['photo', 'voice', 'file'] as const) if (kinds.includes(k)) return k;
  return links.length ? 'link' : 'idea';
}

// ------------------------------------------------------------------ the note

/** Write the note and its files. The frontmatter is flat: scalars and `- item` lists. */
export function writeJot(dir: string, input: JotInput, now: number): JotNote {
  mkdirSync(dir, { recursive: true });
  const text = input.text.replace(/\r\n/g, '\n').trim();
  const head = firstLine(text) || (input.links[0] ? hostOf(input.links[0]) : (input.files[0]?.name ?? 'jot'));
  const d = new Date(now);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug(head)}`;
  let stem = base;
  for (let n = 2; existsSync(join(dir, `${stem}.md`)); n++) stem = `${base}-${n}`;

  const attachments: string[] = [];
  input.files.forEach((f, i) => {
    const name = `${stem}${i ? `-${i + 1}` : ''}${extOf(f)}`;
    writeFileSync(join(dir, name), f.bytes);
    attachments.push(name);
  });
  const kind = noteKind(attachments, input.links);
  const fm = [
    '---',
    `kind: ${kind}`,
    ...(input.area ? [`area: ${input.area}`] : []),
    `source: ${input.source}`,
    `created: ${stamp(now)}`,
    `attachments:${attachments.length ? '' : ' []'}`,
    ...attachments.map((a) => `  - ${a}`),
    `links:${input.links.length ? '' : ' []'}`,
    ...input.links.map((l) => `  - ${l}`),
    '---',
  ];
  // The heading is the first line, cut at a word.
  const title = head.length <= 80 ? head : `${head.slice(0, 80).replace(/\s+\S*$/, '')}…`;
  const body = [`# ${title}`, '', text || input.links[0] || attachments.join(', '), ''];
  const path = join(dir, `${stem}.md`);
  writeFileSync(path, [...fm, '', ...body].join('\n'), 'utf8');
  return { stem, path, kind, attachments, links: input.links };
}

export function appendSection(path: string, title: string, lines: string[]): void {
  appendFileSync(path, `\n## ${title}\n\n${lines.join('\n').trimEnd()}\n`, 'utf8');
}

/** Set one scalar key in the note's frontmatter, replacing it if it is there. */
export function setFrontmatter(path: string, key: string, value: string): void {
  const src = readFileSync(path, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) throw new Error(`${basename(path)} has no frontmatter`);
  const lines = m[1].split(/\r?\n/).filter((l) => !l.startsWith(`${key}:`));
  lines.push(`${key}: ${value}`);
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n${src.slice(m[0].length)}`, 'utf8');
}

/** The jot's own words: the first line of the body that is not a heading. */
export function noteText(src: string): string {
  const lines = parseFrontmatter(src)
    .body.split(/\r?\n/)
    .map((l) => l.trim());
  return lines.find((l) => l && !l.startsWith('#')) ?? lines.find((l) => l.startsWith('# '))?.slice(2) ?? '';
}

export function summarize(stem: string, at: number, src: string): Omit<JotSummary, 'pending'> {
  const { fm } = parseFrontmatter(src);
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  const text = noteText(src) || stem;
  const kind = (['idea', 'link', 'photo', 'voice', 'file'] as const).find((k) => k === fm.kind) ?? 'idea';
  return {
    stem,
    at,
    kind,
    area: str(fm.area) || null,
    text: text.length > 140 ? `${text.slice(0, 139)}…` : text,
    attachments: count(fm.attachments),
    links: count(fm.links),
    task: str(fm.task) || null,
  };
}

const cache = new Map<string, { mtimeMs: number; s: Omit<JotSummary, 'pending'> }>();

/** The jots since `sinceMs`, newest first. Read every poll, so cached by mtime. */
export function readJots(dir: string, sinceMs: number, pending: (stem: string) => string | null = () => null): JotSummary[] {
  if (!existsSync(dir)) return [];
  const out: JotSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const stem = name.slice(0, -3);
    const at = stemTime(stem);
    if (at === null || at < sinceMs) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    let hit = cache.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      hit = { mtimeMs: st.mtimeMs, s: summarize(stem, at, readFileSync(path, 'utf8')) };
      cache.set(path, hit);
    }
    out.push({ ...hit.s, pending: pending(stem) });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ------------------------------------------------------------------ a page as text
// The page can change; the note keeps what you saw.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  bull: '•',
  deg: '°',
  pound: '£',
  euro: '€',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page's title and its text, headings kept as markdown, lists as dashes.
 *  The article or main element when the page marks one: menus and footers
 *  are not what you came for. */
export function htmlToText(html: string): { title: string; text: string } {
  const clean = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || clean(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? '');
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template|iframe|head|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const part = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(h);
  if (part && clean(part[2]).length > 400) h = part[2];
  else h = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(h)?.[1] ?? h;
  h = h
    .replace(/<(nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|blockquote|pre|section|article|dt|dd|figcaption|table|ul|ol)\s*>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, (_m, t: string) => `\n${'#'.repeat(Number(t[1]))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(h)
    .split('\n')
    .map((l) => l.replace(/[ \t \r]+/g, ' ').trim());
  return { title, text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** Fetch a page and keep its text. Follows redirects, gives up after 20 s,
 *  reads at most 3 MB, keeps at most MAX_COPY_CHARS of text. */
export async function fetchLink(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<LinkCopy> {
  const r = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      'accept-language': 'en-GB,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
  });
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new Error(`the site answered ${r.status}`);
  }
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml', 'text/plain', ''].includes(type)) {
    await r.body?.cancel().catch(() => {});
    return { url: r.url, title: '', text: '', note: `Not a page to read: ${type}.` };
  }
  const max = opts.maxBytes ?? 3 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let n = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      if (n >= max) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const { title, text } = type === 'text/plain' ? { title: '', text: raw.trim() } : htmlToText(raw);
  return { url: r.url, title, text: text.length > MAX_COPY_CHARS ? `${text.slice(0, MAX_COPY_CHARS)}\n\n[cut at ${MAX_COPY_CHARS} characters]` : text };
}

// ------------------------------------------------------------------ a photo as words
// One headless Claude call on the cheap model. The prompt goes down stdin
// (Windows caps a shelled command line at 8191 characters)
// and the call runs in the jots folder so Read sees the file as its own.

export function describePhoto(path: string, cli = 'claude', timeoutMs = 120_000): Promise<string> {
  const prompt = `Read the image file ${basename(path)} in the current folder with the Read tool and describe it for a note that will be searched later: two to four sentences on what it shows, then every word visible in it, verbatim. Reply with the description only, no preamble.`;
  const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--model', 'haiku', '--no-session-persistence', '--max-turns', '4'];
  return new Promise((res, rej) => {
    const p = spawn(cli, args, { cwd: dirname(path), shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      p.kill();
      rej(new Error(`Claude took over ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(t);
      rej(e);
    });
    p.on('close', () => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean };
        if (j.is_error) rej(new Error(String(j.result ?? 'Claude reported an error')));
        else res(String(j.result ?? '').trim());
      } catch {
        rej(new Error((err || out).trim().split('\n')[0] || 'no answer from claude'));
      }
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt, 'utf8');
  });
}

/** The voice note's words: faster-whisper on the CPU, through uv so the
 *  first run fetches the packages the script's header names and the small
 *  English model into their caches (server/transcribe.py). Minutes the first
 *  time, seconds after. */
export function transcribe(path: string, opts: { script: string; uv?: string; timeoutMs?: number } = { script: 'server/transcribe.py' }): Promise<string> {
  const args = ['run', opts.script, path];
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  return new Promise((res, rej) => {
    const p = spawn(opts.uv ?? 'uv', args, { cwd: dirname(opts.script), shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      p.kill();
      rej(new Error(`the transcriber took over ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    p.on('error', (e) => {
      clearTimeout(t);
      rej(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) res(out.trim());
      else rej(new Error(err.trim().split('\n').filter(Boolean).pop() || `the transcriber exited ${code}`));
    });
  });
}

// ------------------------------------------------------------------ after save
// One job at a time, in order. A job that fails writes why into the note
// and the queue moves on.

export class JotQueue {
  private chain: Promise<void> = Promise.resolve();
  private jobs = new Map<string, string[]>();
  /** jobs that threw past their own handling, for /deck/health */
  errors: string[] = [];

  add(stem: string, what: string, job: () => Promise<void>): void {
    const list = this.jobs.get(stem) ?? [];
    list.push(what);
    this.jobs.set(stem, list);
    this.chain = this.chain
      .then(job)
      .catch((e: Error) => {
        this.errors.push(`${stem}: ${what}: ${e.message}`);
      })
      .finally(() => {
        const l = this.jobs.get(stem) ?? [];
        l.splice(l.indexOf(what), 1);
        if (!l.length) this.jobs.delete(stem);
      });
  }

  /** What is still to do for a note, the next thing first. */
  pending(stem: string): string | null {
    const l = this.jobs.get(stem);
    return l?.length ? l[0] : null;
  }

  get size(): number {
    let n = 0;
    for (const l of this.jobs.values()) n += l.length;
    return n;
  }

  /** Settles when everything queued so far has run. */
  idle(): Promise<void> {
    return this.chain;
  }
}

export function afterSave(note: JotNote, tools: JotTools, queue: JotQueue, now: () => number): void {
  for (const url of note.links) {
    queue.add(note.stem, 'reading the link', async () => {
      try {
        const c = await tools.fetchLink(url);
        appendSection(note.path, `Link: ${c.title || hostOf(url)}`, [`${url} · read ${stamp(now())}`, '', c.note ?? (c.text || '(no text on the page)')]);
      } catch (e) {
        appendSection(note.path, `Link: ${hostOf(url)}`, [`${url} · couldn't read it ${stamp(now())}: ${(e as Error).message}`]);
      }
    });
  }
  for (const name of note.attachments) {
    if (!isImage(name)) continue;
    queue.add(note.stem, 'describing the photo', async () => {
      try {
        const d = await tools.describePhoto(join(dirname(note.path), name));
        appendSection(note.path, `Photo: ${name}`, [d.trim() || '(no description came back)']);
      } catch (e) {
        appendSection(note.path, `Photo: ${name}`, [`Couldn't describe it: ${(e as Error).message}`]);
      }
    });
  }
  for (const name of note.attachments) {
    if (!isAudio(name)) continue;
    const transcribe = tools.transcribe;
    if (!transcribe) {
      appendSection(note.path, `Voice: ${name}`, ['Kept as audio: this PC has no transcriber wired up.']);
      continue;
    }
    queue.add(note.stem, 'writing down the voice note', async () => {
      try {
        const words = await transcribe(join(dirname(note.path), name));
        appendSection(note.path, `Voice: ${name}`, [words.trim() || '(nothing heard)']);
      } catch (e) {
        appendSection(note.path, `Voice: ${name}`, [`Kept as audio; couldn't write it down: ${(e as Error).message}`]);
      }
    });
  }
}

/** The sentence for the toast: what was kept and what the PC does next. */
export function saidFor(note: JotNote): string {
  const next: string[] = [];
  if (note.links.length) next.push(note.links.length === 1 ? 'reading the link' : `reading ${note.links.length} links`);
  const photos = note.attachments.filter(isImage).length;
  if (photos) next.push(photos === 1 ? 'describing the photo' : `describing ${photos} photos`);
  const audio = note.attachments.filter(isAudio).length;
  if (audio) next.push(audio === 1 ? 'writing down the voice note' : `writing down ${audio} voice notes`);
  const list = next.length > 1 ? `${next.slice(0, -1).join(', ')} and ${next[next.length - 1]}` : next[0];
  return next.length ? `Jotted. The PC is ${list}.` : 'Jotted.';
}
