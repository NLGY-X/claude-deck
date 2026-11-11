// The hand-back card: everything that waits on you, in one shape, in one
// list, ranked. Two kinds, each read from a source that already exists:
//
//   session  a Claude session whose turn ended on a question, or that waits
//            on a permission prompt
//   chase    a waiting-on item on the day list five days old or older
//
// Everything here is pure, so the ranking and the buttons are tested on
// fixtures. The bridge (server/server.ts) turns a button into an action.

import type { Area } from './config.ts';
import { daysBetween, type DayItem } from './day.ts';
import type { DeckSession } from './sessions.ts';

export type CardKind = 'session' | 'chase';

export interface CardButton {
  /** what the tablet posts back; the tap log counts card/<kind>/<action> */
  action: string;
  label: string;
  /** primary: the one most people take. soft: the other answers. quiet: bring to front and the like. */
  look: 'primary' | 'soft' | 'quiet';
}

export interface Card {
  /** stable across polls, so the tablet can hold a settled line in place */
  id: string;
  kind: CardKind;
  area: string | null;
  hue: string;
  /** the mono line: "Work · session · terminal" */
  source: string;
  /** the mono line's right end: "asked 3m ago" */
  when: string;
  /** the decision, one sentence */
  title: string;
  /** one line under it; '' when the title says it all */
  detail: string;
  buttons: CardButton[];
  /** how long it has waited, ms: oldest first within a kind */
  waitedMs: number;
  /** what the bridge needs to act, and the sheet needs to show */
  ref: Record<string, string | number | null>;
  /** the long form for the sheet: Claude's last words, the waiting item */
  body: string;
}

const NEUTRAL = '#9aa1ae';
const areaOf = (areas: Pick<Area, 'id' | 'label' | 'color'>[], id: string | null) => areas.find((a) => a.id === id);

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The first sentence of a paragraph, for a card's one line. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.?!])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

// ------------------------------------------------------------------ sessions

const HOST_LABEL: Record<DeckSession['host'], string> = { terminal: 'terminal', vscode: 'VS Code', other: 'Claude', none: 'no window' };

export const SESSION_REPLIES: Record<string, string> = { yes: 'Yes, go ahead', no: 'No, stop there', show: 'Show me first' };

export function sessionCards(sessions: DeckSession[], areas: Pick<Area, 'id' | 'label' | 'color'>[]): Card[] {
  const out: Card[] = [];
  for (const s of sessions) {
    if (s.phase !== 'needs' && s.phase !== 'permission') continue;
    const permission = s.phase === 'permission';
    let buttons: CardButton[];
    let detail = '';
    if (s.host === 'terminal' && !permission) {
      buttons = [
        { action: 'yes', label: SESSION_REPLIES.yes, look: 'primary' },
        { action: 'no', label: SESSION_REPLIES.no, look: 'soft' },
        { action: 'show', label: SESSION_REPLIES.show, look: 'soft' },
        { action: 'phone', label: 'Send to phone', look: 'quiet' },
      ];
    } else if (s.host === 'none') {
      buttons = [
        { action: 'phone', label: 'Send to phone', look: 'primary' },
        { action: 'resume', label: 'Resume in a terminal', look: 'soft' },
      ];
      detail = 'Nothing on the PC holds this session.';
    } else {
      buttons = [{ action: 'front', label: 'Bring to front', look: 'primary' }];
      detail = permission ? 'Answer the permission prompt on the PC.' : 'Runs in an editor: reply there. The deck cannot be sure which box it would type into.';
    }
    const name = s.title ?? s.name;
    const q = firstSentence(s.text);
    const area = areaOf(areas, s.area);
    out.push({
      id: `session:${s.sessionId}`,
      kind: 'session',
      area: s.area,
      hue: area?.color ?? NEUTRAL,
      source: `${area?.label ?? s.project} · session · ${HOST_LABEL[s.host]}`,
      when: `${permission ? 'needs permission' : 'asked'} ${ago(s.ageMs)} ago`,
      title: q ? `${name}: ${q}` : `${name}: your move`,
      detail,
      buttons,
      waitedMs: s.ageMs,
      ref: { sessionId: s.sessionId, host: s.host, name },
      body: s.text,
    });
  }
  return out;
}

// ------------------------------------------------------------------ chases

export const CHASE_AFTER_DAYS = 5;

/** The "Chase X" open item for a waiting item, if a tap made one. */
export function chaseItemFor(items: DayItem[], waiting: DayItem): DayItem | undefined {
  const want = `chase ${waiting.title}`.toLowerCase();
  return items.find((i) => i.section === 'open' && i.title.toLowerCase() === want);
}

export function chaseCards(items: DayItem[], areas: Pick<Area, 'id' | 'label' | 'color'>[], today: string, now: number): Card[] {
  const out: Card[] = [];
  for (const it of items) {
    if (it.section !== 'waiting' || !it.since) continue;
    const days = daysBetween(it.since, today);
    if (days < CHASE_AFTER_DAYS) continue;
    if (it.ask && it.ask > today) continue;
    const chase = chaseItemFor(items, it);
    if (chase?.picked === today) continue; // on Today: you are on it
    const area = areaOf(areas, it.area);
    out.push({
      id: `chase:${it.id}`,
      kind: 'chase',
      area: it.area,
      hue: area?.color ?? NEUTRAL,
      source: `${area?.label ?? 'No area'} · waiting on`,
      when: `${days} days`,
      title: it.title,
      detail: `Waiting ${days} days.${chase ? ' A Chase card is on the shortlist.' : ''}`,
      buttons: [
        { action: 'chase', label: 'Chase', look: 'primary' },
        { action: 'still', label: 'Still waiting', look: 'quiet' },
      ],
      waitedMs: Math.max(0, now - new Date(it.since).getTime()),
      ref: { id: it.id, chaseId: chase?.id ?? null },
      body: it.title,
    });
  }
  return out;
}

// ------------------------------------------------------------------ ranking

const KIND_RANK: Record<CardKind, number> = { session: 0, chase: 1 };

/** Sessions first (a session waiting on you holds up work), then chases. Within a kind, oldest first. */
export function rankCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.waitedMs - a.waitedMs);
}
