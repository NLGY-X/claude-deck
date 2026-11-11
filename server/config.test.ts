import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXAMPLE_CONFIG, areaForPath, parseDeckConfig } from './config.ts';
import { parseChord } from './win32.ts';

test('chords parse to virtual keys and typos fail loudly', () => {
  assert.deepEqual(parseChord('Ctrl+Shift+M'), [0x11, 0x10, 0x4d]);
  assert.deepEqual(parseChord('Alt+Tab'), [0x12, 0x09]);
  assert.deepEqual(parseChord('Win+Shift+S'), [0x5b, 0x10, 0x53]);
  assert.throws(() => parseChord('Ctrl+Shfit+M'), /unknown key "Shfit"/);
});

test('config: a bad chord, an empty key or a seat with no folder is caught at load', () => {
  assert.throws(() => parseDeckConfig(JSON.stringify({ prompts: { K: [{ title: 'x', keys: 'Ctrl+Nope' }] } })), /unknown key/);
  assert.throws(() => parseDeckConfig(JSON.stringify({ prompts: { K: [{ title: 'x' }] } })), /needs text or keys/);
  assert.throws(() => parseDeckConfig(JSON.stringify({ seats: [{ title: 'x', brief: 'b' }] })), /needs a title, a dir and a brief/);
  assert.throws(() => parseDeckConfig(JSON.stringify({ areas: [{ id: 'Work', label: 'Work' }] })), /lower case/);
  assert.throws(() => parseDeckConfig(JSON.stringify({ day: {} })), /day needs a list/);
});

test('config: ~ is the home folder, jots sit beside the list, and the defaults fill the rest', () => {
  const cfg = parseDeckConfig('{ "day": { "list": "~/Day/list.md" }, // a comment\n "areas": [{ "id": "work", "label": "Work", "paths": ["~/code/work"] }], }');
  assert.equal(cfg.port, 4771);
  assert.equal(cfg.day?.list, join(homedir(), 'Day', 'list.md'));
  assert.equal(cfg.day?.jots, join(homedir(), 'Day', 'jots'));
  assert.equal(cfg.day?.maxPicked, 5);
  assert.equal(cfg.areas[0].color, '#9aa1ae');
  assert.equal(cfg.push.sessions, true);
});

test('a session folder takes the area with the longest matching path', () => {
  const areas = [
    { id: 'code', label: 'Code', color: '#000', paths: ['C:\\code'] },
    { id: 'client', label: 'Client', color: '#111', paths: ['C:\\code\\client-x'] },
  ];
  assert.equal(areaForPath(areas, 'C:/code/client-x/api'), 'client');
  assert.equal(areaForPath(areas, 'c:\\CODE\\other'), 'code');
  assert.equal(areaForPath(areas, 'C:\\code-old'), null, 'a prefix of the name is not a parent folder');
  assert.equal(areaForPath(areas, 'D:\\music'), null);
});

test('the shipped deck.config.example.jsonc loads', () => {
  const cfg = parseDeckConfig(readFileSync(EXAMPLE_CONFIG, 'utf8'));
  assert.ok(cfg.apps.length >= 3);
  assert.ok(Object.keys(cfg.prompts).length >= 2);
  assert.ok(cfg.seats.length >= 1);
  assert.ok(cfg.day);
});
