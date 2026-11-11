import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DayList, friday, guessArea, parseList, serializeList, workingDaysLeft, type DayConfig } from './day.ts';

// Monday 12 October 2026, 08:12 local.
const MON = new Date(2026, 9, 12, 8, 12).getTime();
const DAY = 86_400_000;

function setup(at = MON) {
  const dir = mkdtempSync(join(tmpdir(), 'day-'));
  const cfg: DayConfig = {
    list: join(dir, 'list.md'),
    maxPicked: 5,
    areas: [
      { id: 'contract', label: 'Old contract', color: '#7aa7ff', until: '2026-10-23', words: ['alex', 'handover'] },
      { id: 'newjob', label: 'New job', color: '#ff8f6b', from: '2026-11-02', words: ['onboarding', 'laptop'] },
      { id: 'work', label: 'Work', color: '#5fcf9b', words: ['sam', 'invoice'] },
    ],
  };
  let now = at;
  const list = new DayList(cfg, () => now);
  return { cfg, list, set: (t: number) => (now = t), file: () => readFileSync(cfg.list, 'utf8') };
}

test('a list survives a round trip through the file', () => {
  const src = serializeList([
    { id: 'a1b2', section: 'open', title: 'Hand Sam the branch', area: 'work', carried: 2, someday: false, added: '2026-10-10', due: '2026-10-16' },
    { id: 'c3d4', section: 'waiting', title: 'Alex: handover notes', area: 'contract', carried: 0, someday: false, since: '2026-10-09' },
  ]);
  const back = parseList(src, new Set(['work', 'contract']));
  assert.equal(back.length, 2);
  assert.deepEqual(back[0], { id: 'a1b2', section: 'open', title: 'Hand Sam the branch', area: 'work', carried: 2, someday: false, added: '2026-10-10', due: '2026-10-16' });
  assert.equal(back[1].section, 'waiting');
  assert.equal(back[1].since, '2026-10-09');
});

test('a box ticked by hand counts as done, and a hand-typed line gets an id', () => {
  const { cfg, list } = setup();
  writeFileSync(cfg.list, '## Open\n\n- [x] Ticked by hand\n- [ ] Typed by hand #work\n');
  const items = list.read();
  assert.equal(items[0].section, 'done');
  assert.equal(items[1].area, 'work');
  assert.match(items[1].id, /^[a-z0-9]{4}$/);
});

test('a tag that is not an area stays in the title', () => {
  const [it] = parseList('- [ ] Fix #123 today\n', new Set(['contract']));
  assert.equal(it.title, 'Fix #123 today');
  assert.equal(it.area, null);
});

test('capture guesses the area from a word in the text', () => {
  const { cfg } = setup();
  assert.equal(guessArea('Chase Sam on the backup key', cfg.areas), 'work');
  assert.equal(guessArea('Unbox the laptop', cfg.areas), 'newjob');
  assert.equal(guessArea('Samba tickets', cfg.areas), null); // whole words only
});

test('when: today picks it, tomorrow hides it until tomorrow, week dues it Friday', () => {
  const { list, set } = setup();
  list.apply({ op: 'add', text: 'A', when: 'today' });
  list.apply({ op: 'add', text: 'B', when: 'tomorrow' });
  list.apply({ op: 'add', text: 'C', when: 'week' });
  list.apply({ op: 'add', text: 'D', when: 'someday' });
  list.apply({ op: 'add', text: 'E' }); // soon: no date at all
  let v = list.view();
  assert.deepEqual(v.picked.map((r) => r.title), ['A']);
  assert.deepEqual(v.shortlist.map((r) => r.title), ['C', 'E', 'D']); // dated first, someday last
  assert.equal(v.shortlist[0].meta, 'Due Fri');
  assert.equal(v.shortlist[1].meta, 'Added today');
  set(MON + DAY);
  v = list.view();
  assert.ok(v.shortlist.some((r) => r.title === 'B'));
});

test('later takes a day count: five days for still waiting, zero clears it; waiting rows carry their age', () => {
  const { list, set } = setup();
  list.apply({ op: 'wait', text: 'Alex: the notes' });
  const id = list.view().waiting[0].id;
  assert.equal(list.apply({ op: 'later', id, days: 5 }), 'Asking again in 5 days');
  assert.equal(list.read()[0].ask, '2026-10-17');
  assert.equal(list.apply({ op: 'later', id, days: 0 }), 'Asking again now');
  assert.equal(list.read()[0].ask, undefined);
  assert.equal(list.apply({ op: 'later', id, days: 99 }), 'Asking again in 14 days');
  set(MON + 6 * DAY);
  assert.equal(list.view().waiting[0].days, 6);
  assert.equal(list.view().waiting[0].meta, '6d');
});

test('friday is this week, or next week from a weekend', () => {
  assert.equal(friday('2026-10-12'), '2026-10-16');
  assert.equal(friday('2026-10-16'), '2026-10-16');
  assert.equal(friday('2026-10-17'), '2026-10-23');
});

test('Today holds five, and a ticked item keeps its slot', () => {
  const { list } = setup();
  for (const t of ['1', '2', '3', '4', '5', '6']) list.apply({ op: 'add', text: t });
  const ids = list.view().shortlist.map((r) => r.id);
  for (const id of ids.slice(0, 5)) list.apply({ op: 'pick', id });
  assert.throws(() => list.apply({ op: 'pick', id: ids[5] }), /already has 5/);
  list.apply({ op: 'done', id: ids[0] });
  assert.throws(() => list.apply({ op: 'pick', id: ids[5] }), /already has 5/);
  const v = list.view();
  assert.equal(v.picked.length, 5);
  assert.equal(v.picked.find((r) => r.id === ids[0])?.done, true);
  list.apply({ op: 'unpick', id: ids[1] });
  list.apply({ op: 'pick', id: ids[5] });
  assert.equal(list.view().picked.length, 5);
});

test('picked and not finished comes back carried, and at three days it asks', () => {
  const { list, set, file } = setup();
  list.apply({ op: 'add', text: 'Rebuild the handover pack', when: 'today' });
  const id = list.view().picked[0].id;
  set(MON + DAY);
  let v = list.view();
  assert.equal(v.picked.length, 0);
  assert.equal(v.shortlist[0].meta, 'Carried 1 day');
  assert.match(file(), /carried:1/); // the rollover is written, not just shown
  list.apply({ op: 'pick', id });
  set(MON + 2 * DAY);
  list.apply({ op: 'pick', id });
  set(MON + 3 * DAY);
  v = list.view();
  assert.equal(v.shortlist.length, 0);
  assert.deepEqual(v.decide.map((r) => r.id), [id]);
  assert.equal(v.decide[0].area, 'contract');

  list.apply({ op: 'later', id });
  assert.equal(list.view().decide.length, 0);
  set(MON + 4 * DAY);
  assert.equal(list.view().decide.length, 1);

  assert.equal(list.apply({ op: 'keep', id }), 'Kept, and on Today');
  v = list.view();
  assert.equal(v.decide.length, 0);
  assert.equal(v.picked[0].carried, 0);
});

test('hand off moves it to waiting on, and done clears it from there', () => {
  const { list, set } = setup();
  list.apply({ op: 'add', text: 'Leaver books' });
  const id = list.view().shortlist[0].id;
  list.apply({ op: 'handoff', id });
  set(MON + 2 * DAY);
  let v = list.view();
  assert.equal(v.shortlist.length, 0);
  assert.deepEqual(v.waiting.map((r) => [r.title, r.meta]), [['Handed off: Leaver books', '2d']]);
  assert.equal(list.apply({ op: 'done', id }), 'Off the waiting list');
  v = list.view();
  assert.equal(v.waiting.length, 0);
});

test('the top bar counts down to the end of one area and the start of another', () => {
  const { list, set } = setup();
  assert.equal(workingDaysLeft('2026-10-12', '2026-10-23'), 9);
  let v = list.view();
  assert.deepEqual(v.chips.map((c) => `${c.label} ${c.strong}`), ['Old contract 9 working days left', 'New job from Mon 2 Nov']);
  set(new Date(2026, 9, 23, 9).getTime());
  assert.equal(list.view().chips[0].strong, 'last day');
  set(new Date(2026, 9, 26, 9).getTime());
  v = list.view();
  assert.deepEqual(v.chips.map((c) => c.label), ['New job']);
  assert.deepEqual(v.areas.map((a) => a.id), ['newjob', 'work']); // the old contract is no longer offered
});

test('errors are sentences the tablet can show', () => {
  const { list } = setup();
  assert.throws(() => list.apply({ op: 'add', text: '   ' }), /Nothing to add/);
  assert.throws(() => list.apply({ op: 'done', id: 'zzzz' }), /no longer on the list/);
});

import { parseList as parseDayList, serializeList as serializeDayList } from './day.ts';

test("a jot stem rides on the line and comes back as the row's link to the note", () => {
  const items = parseDayList('## Open\n\n- [ ] Read the benchmarks #work added:2026-10-28 jot:2026-10-28-1012-read-the-benchmarks ^ab12\n', new Set(['work']));
  assert.equal(items[0].jot, '2026-10-28-1012-read-the-benchmarks');
  assert.equal(items[0].title, 'Read the benchmarks');
  assert.match(serializeDayList(items), /- \[ \] Read the benchmarks #work added:2026-10-28 jot:2026-10-28-1012-read-the-benchmarks \^ab12/);
});

test('the sample list in examples/ parses: four open, one waiting', () => {
  const src = readFileSync(new URL('../examples/list.md', import.meta.url), 'utf8');
  const items = parseList(src, new Set(['work', 'home']));
  assert.deepEqual(items.map((i) => i.section), ['open', 'open', 'open', 'open', 'waiting']);
  assert.equal(items[1].area, 'home');
  assert.equal(items[3].someday, true);
});
