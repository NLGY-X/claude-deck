// The day list: one markdown file that the deck and Claude both write, and
// the Day screen drawn from it.
//
// The file is the only store. Nothing here keeps state in memory between
// calls: every read parses the file, every change writes it back whole. A
// line looks like
//
//   - [ ] Send the invoice #work added:2026-10-12 picked:2026-10-12 ^k3f9
//
// so it reads fine in any markdown editor, survives a hand edit, and diffs
// cleanly.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DayArea {
  id: string;
  label: string;
  color: string;
  /** first day the area is live (YYYY-MM-DD); before it, the top bar counts down to it */
  from?: string;
  /** last day; after it the area is no longer offered for new items */
  until?: string;
  /** words that make capture guess this area */
  words?: string[];
}

export interface DayConfig {
  list: string;
  maxPicked: number;
  areas: DayArea[];
  /** where jots are filed; a `jots` folder beside the list unless the config says */
  jots?: string;
}

export type Section = 'open' | 'waiting' | 'done' | 'dropped';

export interface DayItem {
  id: string;
  section: Section;
  title: string;
  area: string | null;
  added?: string;
  /** the day it was picked for Today */
  picked?: string;
  /** how many days it was picked and not finished */
  carried: number;
  /** not shown before this day */
  start?: string;
  due?: string;
  someday: boolean;
  done?: string;
  dropped?: string;
  /** waiting on someone since */
  since?: string;
  /** a carried item put off with "ask me tomorrow" is not asked about again before this day */
  ask?: string;
  /** the jot it was made from: the note's file stem under the jots folder (server/jots.ts) */
  jot?: string;
}

/** soon: on the shortlist with no date, the default. A due date on everything
 *  makes "Due Fri" mean nothing. */
export type When = 'today' | 'soon' | 'tomorrow' | 'week' | 'someday';

export type DayOp =
  | { op: 'add'; text: string; area?: string; when?: When; due?: string; jot?: string }
  | { op: 'wait'; text: string; area?: string; jot?: string }
  | { op: 'pick' | 'unpick' | 'done' | 'undone' | 'tomorrow' | 'drop' | 'keep' | 'handoff'; id: string }
  /** ask again in `days` (default one); 0 clears a pending ask */
  | { op: 'later'; id: string; days?: number };

export interface DayRow {
  id: string;
  title: string;
  area: string | null;
  areaLabel: string;
  color: string;
  meta: string;
  carried: number;
  done: boolean;
  /** waiting rows: days since it was handed over */
  days?: number;
  /** the jot note it came from, when it did */
  jot?: string;
}

export interface DayView {
  date: string;
  picked: DayRow[];
  shortlist: DayRow[];
  waiting: DayRow[];
  /** carried three days or more: the tablet asks keep, hand off or drop */
  decide: DayRow[];
  /** titles of everything ticked today, picked or not, waiting-on included */
  doneToday: string[];
  chips: { label: string; strong: string; color: string }[];
  /** areas open for new items, for the capture sheet */
  areas: DayArea[];
  maxPicked: number;
  list: string;
}

export const CARRY_LIMIT = 3;
const NEUTRAL = '#9aa1ae';

// ------------------------------------------------------------------ dates
// Local dates as YYYY-MM-DD. The list is about your day, not UTC's.

const pad = (n: number): string => String(n).padStart(2, '0');
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s: string, n: number): string => {
  const d = fromYmd(s);
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
/** Friday of this week; on a weekend, next Friday. */
export const friday = (s: string): string => addDays(s, (5 - fromYmd(s).getDay() + 7) % 7);
const short = (s: string): string => fromYmd(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const weekday = (s: string): string => fromYmd(s).toLocaleDateString('en-GB', { weekday: 'short' });
export const daysBetween = (a: string, b: string): number => Math.round((fromYmd(b).getTime() - fromYmd(a).getTime()) / 86_400_000);

/** Working days after `from`, up to and including `to`. */
export function workingDaysLeft(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const dow = fromYmd(d).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

// ------------------------------------------------------------------ the file

const SECTIONS: [Section, string][] = [
  ['open', 'Open'],
  ['waiting', 'Waiting on'],
  ['done', 'Done'],
  ['dropped', 'Dropped'],
];
const DATE_KEYS = ['added', 'picked', 'start', 'due', 'done', 'dropped', 'since', 'ask'] as const;

const HEADER = `# Day list

The deck and Claude both write this file. Edit it by hand if you like: one item
per line, keep the ^id at the end. Lines that are not items are not kept.
`;

export function parseList(src: string, areaIds: Set<string>): DayItem[] {
  const items: DayItem[] = [];
  let section: Section = 'open';
  for (const raw of src.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      section = SECTIONS.find(([, title]) => title.toLowerCase() === h[1].toLowerCase())?.[0] ?? section;
      continue;
    }
    const m = /^\s*-\s+\[( |x|X)\]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const item: DayItem = { id: '', section, title: '', area: null, carried: 0, someday: false };
    const words: string[] = [];
    for (const w of m[2].trim().split(/\s+/)) {
      const kv = /^([a-z]+):(.+)$/.exec(w);
      if (/^\^[a-z0-9]+$/.test(w)) item.id = w.slice(1);
      else if (/^#[a-z0-9-]+$/.test(w) && areaIds.has(w.slice(1))) item.area = w.slice(1);
      else if (w === 'someday') item.someday = true;
      else if (kv && kv[1] === 'carried' && /^\d+$/.test(kv[2])) item.carried = Number(kv[2]);
      else if (kv && kv[1] === 'jot' && /^[a-z0-9-]+$/.test(kv[2])) item.jot = kv[2];
      else if (kv && (DATE_KEYS as readonly string[]).includes(kv[1]) && /^\d{4}-\d{2}-\d{2}$/.test(kv[2])) item[kv[1] as (typeof DATE_KEYS)[number]] = kv[2];
      else words.push(w);
    }
    item.title = words.join(' ');
    // A box ticked by hand in the open section counts as done.
    if (m[1] !== ' ' && item.section === 'open') item.section = 'done';
    if (item.title) items.push(item);
  }
  return items;
}

export function serializeList(items: DayItem[]): string {
  const line = (it: DayItem): string => {
    const parts = [`- [${it.section === 'done' ? 'x' : ' '}]`, it.title];
    if (it.area) parts.push(`#${it.area}`);
    if (it.someday) parts.push('someday');
    if (it.carried) parts.push(`carried:${it.carried}`);
    for (const k of DATE_KEYS) if (it[k]) parts.push(`${k}:${it[k]}`);
    if (it.jot) parts.push(`jot:${it.jot}`);
    parts.push(`^${it.id}`);
    return parts.join(' ');
  };
  let out = HEADER;
  for (const [s, title] of SECTIONS) {
    out += `\n## ${title}\n\n`;
    const rows = items.filter((it) => it.section === s);
    out += rows.length ? rows.map(line).join('\n') + '\n' : '';
  }
  return out;
}

const newId = (taken: Set<string>): string => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 6);
    if (id.length === 4 && !taken.has(id)) return id;
  }
};

/**
 * Bring the list up to today. Something picked on an earlier day and not
 * finished goes back to the shortlist one day more carried. Items with no id
 * (typed by hand) get one. Returns whether anything changed.
 */
export function normalize(items: DayItem[], today: string): boolean {
  let changed = false;
  const taken = new Set(items.map((i) => i.id).filter(Boolean));
  for (const it of items) {
    if (!it.id) {
      it.id = newId(taken);
      taken.add(it.id);
      changed = true;
    }
    if (it.section === 'open' && it.picked && it.picked < today) {
      it.picked = undefined;
      it.carried += 1;
      changed = true;
    }
  }
  return changed;
}

export function guessArea(text: string, areas: DayArea[]): string | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')} `;
  for (const a of areas) {
    for (const w of a.words ?? []) if (t.includes(` ${w.toLowerCase()} `)) return a.id;
  }
  return null;
}

// ------------------------------------------------------------------ the list

export class DayList {
  private cfg: DayConfig;
  private now: () => number;
  constructor(cfg: DayConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  today(): string {
    return ymd(new Date(this.now()));
  }

  /** Every item, brought up to today. Writes the file back if rolling over changed it. */
  read(): DayItem[] {
    const ids = new Set(this.cfg.areas.map((a) => a.id));
    const items = existsSync(this.cfg.list) ? parseList(readFileSync(this.cfg.list, 'utf8'), ids) : [];
    if (normalize(items, this.today())) this.write(items);
    return items;
  }

  private write(items: DayItem[]): void {
    mkdirSync(dirname(this.cfg.list), { recursive: true });
    // Write beside it and rename, so a reader never sees half a file.
    const tmp = `${this.cfg.list}.tmp`;
    writeFileSync(tmp, serializeList(items), 'utf8');
    renameSync(tmp, this.cfg.list);
  }

  private liveAreas(): DayArea[] {
    const today = this.today();
    return this.cfg.areas.filter((a) => !a.until || a.until >= today);
  }

  /** Apply one change and say what happened, in a sentence for the tablet's toast. */
  apply(op: DayOp): string {
    const items = this.read();
    const today = this.today();
    // A ticked item stays on Today, struck through, so it still holds its slot.
    const pickedToday = items.filter((i) => i.picked === today && (i.section === 'open' || (i.section === 'done' && i.done === today))).length;

    if (op.op === 'add' || op.op === 'wait') {
      const title = op.text.replace(/\s+/g, ' ').trim();
      if (!title) throw new Error('Nothing to add.');
      const area = op.area && this.cfg.areas.some((a) => a.id === op.area) ? op.area : guessArea(title, this.liveAreas());
      const it: DayItem = { id: newId(new Set(items.map((i) => i.id))), section: 'open', title, area, carried: 0, someday: false, added: today };
      if (op.jot) it.jot = op.jot;
      if (op.op === 'wait') {
        it.section = 'waiting';
        it.since = today;
        items.push(it);
        this.write(items);
        return 'Added to waiting on';
      }
      const when = op.when ?? 'soon';
      if (when === 'today') {
        if (pickedToday >= this.cfg.maxPicked) throw new Error(`Today already has ${this.cfg.maxPicked}. Finish or put one back first.`);
        it.picked = today;
      } else if (when === 'tomorrow') it.start = addDays(today, 1);
      else if (when === 'week') it.due = friday(today);
      else if (when === 'someday') it.someday = true;
      if (op.due && /^\d{4}-\d{2}-\d{2}$/.test(op.due)) it.due = op.due;
      items.push(it);
      this.write(items);
      return { today: 'Added to Today', soon: 'Added to the shortlist', tomorrow: 'Added for tomorrow', week: 'Added for this week', someday: 'Added for someday' }[when];
    }

    const it = items.find((i) => i.id === op.id);
    if (!it) throw new Error('That item is no longer on the list.');
    let said: string;
    switch (op.op) {
      case 'pick':
        if (it.section !== 'open') throw new Error('Only open items can go on Today.');
        if (it.picked === today) return 'Already on Today';
        if (pickedToday >= this.cfg.maxPicked) throw new Error(`Today already has ${this.cfg.maxPicked}. Finish or put one back first.`);
        it.picked = today;
        it.start = undefined;
        said = 'On Today';
        break;
      case 'unpick':
        it.picked = undefined;
        said = 'Back on the shortlist';
        break;
      case 'done':
        it.section = 'done';
        it.done = today;
        said = it.since ? 'Off the waiting list' : 'Done';
        break;
      case 'undone':
        it.section = 'open';
        it.done = undefined;
        said = 'Not done after all';
        break;
      case 'tomorrow':
        it.picked = undefined;
        it.start = addDays(today, 1);
        said = 'Moved to tomorrow';
        break;
      case 'drop':
        it.section = 'dropped';
        it.dropped = today;
        said = 'Dropped';
        break;
      case 'keep':
        it.carried = 0;
        it.ask = undefined;
        if (pickedToday < this.cfg.maxPicked) {
          it.picked = today;
          said = 'Kept, and on Today';
        } else said = 'Kept on the shortlist. Today is full';
        break;
      case 'handoff':
        it.section = 'waiting';
        it.since = today;
        it.picked = undefined;
        it.carried = 0;
        if (!/^handed off:/i.test(it.title)) it.title = `Handed off: ${it.title}`;
        said = 'Moved to waiting on';
        break;
      case 'later': {
        const days = Math.min(14, Math.max(0, Math.round(Number(op.days ?? 1))));
        it.ask = days ? addDays(today, days) : undefined;
        said = days === 0 ? 'Asking again now' : days === 1 ? 'Asking again tomorrow' : `Asking again in ${days} days`;
        break;
      }
    }
    this.write(items);
    return said;
  }

  view(): DayView {
    const items = this.read();
    const today = this.today();
    const area = (id: string | null): DayArea | undefined => this.cfg.areas.find((a) => a.id === id);
    const order = (id: string | null): number => {
      const i = this.cfg.areas.findIndex((a) => a.id === id);
      return i === -1 ? 99 : i;
    };
    const row = (it: DayItem, meta: string): DayRow => ({
      id: it.id,
      title: it.title,
      area: it.area,
      areaLabel: area(it.area)?.label ?? 'No area',
      color: area(it.area)?.color ?? NEUTRAL,
      meta,
      carried: it.carried,
      done: it.section === 'done',
      jot: it.jot,
    });
    const metaOf = (it: DayItem): string => {
      const bits: string[] = [];
      if (it.carried) bits.push(`Carried ${it.carried} day${it.carried === 1 ? '' : 's'}`);
      if (it.due) bits.push(it.due < today ? `Overdue since ${short(it.due)}` : it.due === today ? 'Due today' : `Due ${daysBetween(today, it.due) < 7 ? weekday(it.due) : short(it.due)}`);
      if (it.someday) bits.push('Someday');
      if (!bits.length && it.added) bits.push(it.added === today ? 'Added today' : `Added ${short(it.added)}`);
      return bits.join(' · ');
    };

    const picked = items
      .filter((i) => i.picked === today && (i.section === 'open' || (i.section === 'done' && i.done === today)))
      .map((i) => row(i, i.section === 'done' ? 'Done' : metaOf(i)));

    const open = items.filter((i) => i.section === 'open' && i.picked !== today && !(i.start && i.start > today));
    const asked = (i: DayItem): boolean => !!i.ask && i.ask > today;
    const decide = open.filter((i) => i.carried >= CARRY_LIMIT && !asked(i));
    const rank = (i: DayItem): [number, number, string, number, string] => [
      i.someday ? 1 : 0,
      -(i.due && i.due <= today ? 1000 : i.carried),
      i.due ?? '9999',
      order(i.area),
      i.added ?? '',
    ];
    const cmp = (a: DayItem, b: DayItem): number => {
      const x = rank(a);
      const y = rank(b);
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
      return 0;
    };
    const shortlist = open
      .filter((i) => i.carried < CARRY_LIMIT)
      .sort(cmp)
      .map((i) => row(i, metaOf(i)));

    const waiting = items
      .filter((i) => i.section === 'waiting')
      .sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''))
      .map((i) => {
        const d = i.since ? daysBetween(i.since, today) : 0;
        return { ...row(i, d <= 0 ? 'today' : `${d}d`), days: Math.max(0, d) };
      });

    const chips = this.cfg.areas.flatMap((a) => {
      if (a.from && a.from > today) return [{ label: a.label, strong: `from ${short(a.from)}`, color: a.color }];
      if (a.until && a.until >= today) {
        const n = workingDaysLeft(today, a.until);
        return [{ label: a.label, strong: n === 0 ? 'last day' : `${n} working day${n === 1 ? '' : 's'} left`, color: a.color }];
      }
      return [];
    });

    return {
      date: today,
      picked,
      shortlist,
      waiting,
      decide: decide.map((i) => row(i, metaOf(i))),
      doneToday: items.filter((i) => i.section === 'done' && i.done === today).map((i) => i.title),
      chips,
      areas: this.liveAreas(),
      maxPicked: this.cfg.maxPicked,
      list: this.cfg.list,
    };
  }
}
