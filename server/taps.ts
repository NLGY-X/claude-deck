// npm run taps [days]  which deck keys get pressed, and which never do.
//
// Reads deck-taps.jsonl in the data folder (written by the bridge, one line per tap) and
// lists every key in deck.config.jsonc with its count, zeros included: the
// zeros are the point, they are what to cut.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDeckConfig } from './config.ts';
import type { Tap } from './server.ts';
import { DATA_DIR } from './util.ts';

const days = Number(process.argv[2]) || 7;
const path = join(DATA_DIR, 'deck-taps.jsonl');
const since = Date.now() - days * 864e5;

const taps: Tap[] = existsSync(path)
  ? readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Tap)
      .filter((t) => t.at >= since)
  : [];

const count = new Map<string, number>();
for (const t of taps) {
  const k = `${t.action}|${t.label ?? ''}`;
  count.set(k, (count.get(k) ?? 0) + 1);
}
const take = (action: string, label = ''): number => {
  const k = `${action}|${label}`;
  const n = count.get(k) ?? 0;
  count.delete(k);
  return n;
};

const deck = loadDeckConfig();
const rows: [string, string, number][] = [];
for (const a of deck.apps) rows.push(['app', a.label, take('app', a.label)]);
for (const [group, keys] of Object.entries(deck.prompts)) for (const p of keys) rows.push([group, p.title, take('prompt', p.title)]);
for (const s of deck.seats) rows.push(['seat', s.title, take('seat', s.title)]);
// everything else (sessions, cards, media, volume, day) as it was logged
for (const [k, n] of count) {
  const [action, label] = k.split('|');
  rows.push([action, label || '-', n]);
}

console.log(`${taps.length} taps in the last ${days} days (${path})\n`);
for (const [group, label, n] of rows.sort((a, b) => b[2] - a[2])) {
  console.log(`${String(n).padStart(4)}  ${group.padEnd(14)} ${label}`);
}
const unused = rows.filter((r) => r[2] === 0).length;
if (taps.length) console.log(`\n${unused} of ${rows.length} keys never pressed.`);
