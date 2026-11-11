// deck.config.jsonc, loaded and checked. A bad chord or a malformed area
// fails here, at load, with the line that is wrong, rather than as a button
// that does nothing. The bridge reloads the file on save.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DayArea, DayConfig } from './day.ts';
import { REPO_DIR, expandPath, isUnder, stripJsonc } from './util.ts';
import { parseChord } from './win32.ts';

export const DECK_CONFIG = process.env.CLAUDE_DECK_CONFIG || join(REPO_DIR, 'deck.config.jsonc');
export const EXAMPLE_CONFIG = join(REPO_DIR, 'deck.config.example.jsonc');

export interface AppButton {
  label: string;
  icon: string;
  proc?: string;
  open: string;
}

export interface PromptKey {
  title: string;
  icon?: string;
  text?: string;
  send?: boolean;
  keys?: string;
}

export interface Seat {
  title: string;
  icon?: string;
  /** the folder the new session starts in */
  dir: string;
  brief: string;
  needsClipboard?: boolean;
  /** the goal the seat serves: it opens the brief, and the key shows it */
  why?: string;
}

/** One colour and label for a part of your life: day list items, sessions
 *  (by folder) and jots all carry one. */
export interface Area extends DayArea {
  /** folders whose Claude sessions belong to this area */
  paths: string[];
}

/** Processes a text key may paste into when the target is "focused window".
 *  Anything else in front (a browser, a mail client) gets a refusal, not a paste. */
export const DEFAULT_TYPE_INTO = ['windowsterminal', 'openconsole', 'conhost', 'powershell', 'pwsh', 'cmd', 'cursor', 'code', 'claude', 'wezterm-gui', 'alacritty'];

const NEUTRAL = '#9aa1ae';

export interface DeckConfig {
  port: number;
  typeInto: string[];
  apps: AppButton[];
  prompts: Record<string, PromptKey[]>;
  seats: Seat[];
  areas: Area[];
  /** the Day screen's list file; no `day` block, no Day screen and no jots */
  day?: DayConfig;
  /** repos (or folders of repos) whose commits today count on "So far" */
  report: { repos: string[] };
  /** what goes to the phone through ntfy */
  push: { sessions: boolean };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseAreas(raw: Partial<Area>[] | undefined): Area[] {
  return (raw ?? []).map((a) => {
    if (!/^[a-z0-9-]+$/.test(a.id ?? '')) throw new Error(`area ${JSON.stringify(a)}: id must be lower case letters, digits or -`);
    if (!a.label) throw new Error(`area "${a.id}" needs a label`);
    for (const k of ['from', 'until'] as const) if (a[k] && !YMD.test(a[k]!)) throw new Error(`area "${a.id}": ${k} must be YYYY-MM-DD`);
    return { id: a.id!, label: a.label, color: a.color || NEUTRAL, paths: (a.paths ?? []).map(expandPath), words: a.words, from: a.from, until: a.until };
  });
}

export function parseDeckConfig(src: string): DeckConfig {
  const raw = JSON.parse(stripJsonc(src)) as Partial<DeckConfig> & { day?: Partial<DayConfig> };
  const areas = parseAreas(raw.areas);
  let day: DayConfig | undefined;
  if (raw.day) {
    if (!raw.day.list) throw new Error('day needs a list: the path of the markdown file the Day screen reads and writes');
    const list = expandPath(raw.day.list);
    // Jots sit beside the list unless the config says otherwise.
    day = { list, jots: raw.day.jots ? expandPath(raw.day.jots) : join(dirname(list), 'jots'), maxPicked: Number(raw.day.maxPicked ?? 5), areas };
  }
  const cfg: DeckConfig = {
    port: Number(raw.port ?? 4771),
    typeInto: (raw.typeInto ?? DEFAULT_TYPE_INTO).map((p) => p.toLowerCase()),
    apps: raw.apps ?? [],
    prompts: raw.prompts ?? {},
    seats: (raw.seats ?? []).map((s) => {
      if (!s.title || !s.dir || !s.brief) throw new Error(`seat ${JSON.stringify(s.title ?? s)} needs a title, a dir and a brief`);
      return { ...s, dir: expandPath(s.dir) };
    }),
    areas,
    day,
    report: { repos: (raw.report?.repos ?? []).map(expandPath) },
    push: { sessions: raw.push?.sessions !== false },
  };

  for (const a of cfg.apps) {
    if (!a.label || !a.icon || !a.open) throw new Error(`app ${JSON.stringify(a)} needs label, icon and open`);
  }
  for (const [group, keys] of Object.entries(cfg.prompts)) {
    for (const k of keys) {
      if (!k.text && !k.keys) throw new Error(`prompt "${k.title}" in ${group} needs text or keys`);
      if (k.keys) parseChord(k.keys);
    }
  }
  return cfg;
}

export function loadDeckConfig(path = DECK_CONFIG): DeckConfig {
  if (!existsSync(path)) throw new Error(`${path} is missing. Copy deck.config.example.jsonc to deck.config.jsonc and edit it.`);
  try {
    return parseDeckConfig(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

/** The area a folder belongs to: the one with the longest matching path. */
export function areaForPath(areas: Area[], p: string): string | null {
  let best: string | null = null;
  let len = -1;
  for (const a of areas) {
    for (const root of a.paths) {
      if (isUnder(p, root) && root.length > len) {
        best = a.id;
        len = root.length;
      }
    }
  }
  return best;
}
