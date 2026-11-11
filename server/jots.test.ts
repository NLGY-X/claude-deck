import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { JotQueue, afterSave, htmlToText, noteKind, readJots, saidFor, setFrontmatter, slug, stemTime, urlsIn, writeJot } from './jots.ts';

const T = new Date(2026, 9, 28, 10, 12).getTime();
const dir = (): string => mkdtempSync(join(tmpdir(), 'jots-'));

test('a slug is the words, lower case, cut at a word, never empty', () => {
  assert.equal(slug('Radio: a monthly chart built from the show’s tracklists, voted on'), 'radio-a-monthly-chart-built-from-the');
  assert.equal(slug('https://x.y/z'), 'jot');
  assert.equal(slug('  !!  '), 'jot');
});

test('urls in text, trailing punctuation dropped, no repeats', () => {
  assert.deepEqual(urlsIn('see https://a.b/c, and (https://d.e/f?x=1). https://a.b/c'), ['https://a.b/c', 'https://d.e/f?x=1']);
});

test('the stem carries the local clock and reads back', () => {
  assert.equal(stemTime('2026-10-28-1012-radio'), T);
  assert.equal(stemTime('notes'), null);
});

test('the kind is what the jot mainly holds', () => {
  assert.equal(noteKind([], []), 'idea');
  assert.equal(noteKind([], ['https://a.b']), 'link');
  assert.equal(noteKind(['a.m4a', 'b.png'], ['https://a.b']), 'photo');
  assert.equal(noteKind(['a.pdf'], []), 'file');
});

test('a jot is one note with flat frontmatter, its files beside it under the same stem', () => {
  const d = dir();
  const n = writeJot(
    d,
    {
      text: 'Radio: a monthly chart\nmore',
      area: 'music',
      source: 'deck',
      links: ['https://example.com/x'],
      files: [
        { name: 'IMG_1.PNG', type: 'image/png', bytes: Buffer.from('a') },
        { name: 'walk', type: 'audio/mp4', bytes: Buffer.from('b') },
      ],
    },
    T
  );
  assert.equal(n.stem, '2026-10-28-1012-radio-a-monthly-chart');
  assert.equal(n.kind, 'photo');
  assert.deepEqual(n.attachments, [`${n.stem}.png`, `${n.stem}-2.m4a`]);
  assert.ok(existsSync(join(d, `${n.stem}-2.m4a`)));
  assert.equal(
    readFileSync(n.path, 'utf8'),
    [
      '---',
      'kind: photo',
      'area: music',
      'source: deck',
      'created: 2026-10-28 10:12',
      'attachments:',
      `  - ${n.stem}.png`,
      `  - ${n.stem}-2.m4a`,
      'links:',
      '  - https://example.com/x',
      '---',
      '',
      '# Radio: a monthly chart',
      '',
      'Radio: a monthly chart',
      'more',
      '',
    ].join('\n')
  );
  assert.equal(saidFor(n), 'Jotted. The PC is reading the link, describing the photo and writing down the voice note.');
  // A second jot in the same minute with the same words gets its own stem.
  const n2 = writeJot(d, { text: 'Radio: a monthly chart', area: null, source: 'deck', links: [], files: [] }, T);
  assert.equal(n2.stem, `${n.stem}-2`);
  assert.equal(n2.kind, 'idea');
  assert.doesNotMatch(readFileSync(n2.path, 'utf8'), /area:/);
  assert.equal(saidFor(n2), 'Jotted.');
});

test('a page becomes its title and readable text: scripts and nav gone, entities decoded, the article preferred', () => {
  const html = `<html><head><title>Benchmarks &amp; reach</title><style>p{}</style><script>x()</script></head><body><nav><a>Home</a></nav><article><h1>Instagram reach</h1><p>Organic reach by follower band is 9&#37;.</p><ul><li>one</li><li>two</li></ul>${'<p>filler text that makes the article long enough to count as the page. </p>'.repeat(8)}</article><footer>&copy; 2026</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Benchmarks & reach');
  assert.match(text, /^# Instagram reach\nOrganic reach by follower band is 9%\.\n- one\n- two/);
  assert.doesNotMatch(text, /Home|2026|x\(\)/);
});

test('the queue runs one job at a time in order, says what is pending, and keeps going after a failure', async () => {
  const q = new JotQueue();
  const log: string[] = [];
  q.add('a', 'reading the link', async () => {
    await new Promise((r) => setTimeout(r, 20));
    log.push('a1');
  });
  q.add('a', 'describing the photo', async () => {
    log.push('a2');
    throw new Error('boom');
  });
  q.add('b', 'reading the link', async () => {
    log.push('b');
  });
  assert.equal(q.pending('a'), 'reading the link');
  assert.equal(q.pending('b'), 'reading the link');
  assert.equal(q.size, 3);
  await q.idle();
  assert.deepEqual(log, ['a1', 'a2', 'b']);
  assert.equal(q.pending('a'), null);
  assert.deepEqual(q.errors, ['a: describing the photo: boom']);
});

test("after save: the link's text copy and the photo's description land in the note; a failed read says so", async () => {
  const d = dir();
  const n = writeJot(
    d,
    {
      text: 'benchmarks',
      area: null,
      source: 'deck',
      links: ['https://example.com/x', 'https://down.example/y'],
      files: [
        { name: 'shot.png', type: 'image/png', bytes: Buffer.from('a') },
        { name: 'voice-1012.webm', type: 'audio/webm', bytes: Buffer.from('b') },
      ],
    },
    T
  );
  const q = new JotQueue();
  const tools = {
    fetchLink: async (url: string) => {
      if (url.includes('down')) throw new Error('the site answered 503');
      return { url, title: 'Instagram benchmarks', text: 'Organic reach by follower band.' };
    },
    describePhoto: async (p: string) => `A screenshot (${basename(p)}).`,
    transcribe: async (p: string) => `Chase Alex on Friday (${basename(p)}).`,
  };
  afterSave(n, tools, q, () => T + 60_000);
  assert.equal(q.pending(n.stem), 'reading the link');
  await q.idle();
  const src = readFileSync(n.path, 'utf8');
  assert.match(src, /## Link: Instagram benchmarks\n\nhttps:\/\/example\.com\/x · read 2026-10-28 10:13\n\nOrganic reach by follower band\.\n/);
  assert.match(src, /## Link: down\.example\n\nhttps:\/\/down\.example\/y · couldn't read it 2026-10-28 10:13: the site answered 503\n/);
  assert.match(src, /## Photo: 2026-10-28-1012-benchmarks\.png\n\nA screenshot \(2026-10-28-1012-benchmarks\.png\)\.\n/);
  assert.match(src, /## Voice: 2026-10-28-1012-benchmarks-2\.webm\n\nChase Alex on Friday \(2026-10-28-1012-benchmarks-2\.webm\)\.\n/);
  assert.equal(q.pending(n.stem), null);
  assert.deepEqual(q.errors, []);

  // Without a transcriber on the PC the note says so, at once, and nothing queues.
  const m = writeJot(d, { text: 'memo', area: null, source: 'phone', links: [], files: [{ name: 'memo.m4a', type: 'audio/mp4', bytes: Buffer.from('c') }] }, T + 120_000);
  afterSave(m, { fetchLink: tools.fetchLink, describePhoto: tools.describePhoto }, q, () => T);
  assert.equal(q.pending(m.stem), null);
  assert.match(readFileSync(m.path, 'utf8'), /## Voice: 2026-10-28-1014-memo\.m4a\n\nKept as audio: this PC has no transcriber wired up\.\n/);
});

test("this week's jots, newest first, with what the PC is still doing, and the task id once it has one", () => {
  const d = dir();
  const a = writeJot(d, { text: 'first', area: 'work', source: 'deck', links: [], files: [] }, T);
  const b = writeJot(d, { text: 'second', area: null, source: 'phone', links: ['https://a.b'], files: [] }, T + 3_600_000);
  writeJot(d, { text: 'old', area: null, source: 'deck', links: [], files: [] }, T - 8 * 86_400_000);
  setFrontmatter(a.path, 'task', 'k3f9');
  const jots = readJots(d, T - 7 * 86_400_000, (stem) => (stem === b.stem ? 'reading the link' : null));
  assert.deepEqual(
    jots.map((j) => [j.stem, j.text, j.area, j.kind, j.links, j.task, j.pending]),
    [
      [b.stem, 'second', null, 'link', 1, null, 'reading the link'],
      [a.stem, 'first', 'work', 'idea', 0, 'k3f9', null],
    ]
  );
  assert.match(readFileSync(a.path, 'utf8'), /^---\nkind: idea\narea: work\nsource: deck\ncreated: 2026-10-28 10:12\nattachments: \[\]\nlinks: \[\]\ntask: k3f9\n---\n/);
});
