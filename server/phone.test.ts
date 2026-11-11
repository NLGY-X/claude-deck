import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionId, phoneName, phoneScript, phoneSession } from './phone.ts';

const ID = '6d7fbd89-a53e-4156-9a94-fa025618589e';

test('the phone name cannot break out of its quotes or its line', () => {
  assert.equal(phoneName('Deck work'), 'Deck work');
  assert.equal(phoneName('say "hi" && del *\r\nnext'), 'say hi del next');
  assert.equal(phoneName('x'.repeat(60)).length, 40);
  assert.equal(phoneName('   '), 'session');
  assert.equal(phoneName('""'), 'session');
});

test('the script resumes the session in its own directory, Remote Control last with the name attached', () => {
  const s = phoneScript({ sessionId: ID, name: 'Deck work', cwd: 'C:/Users/d/code/work space' });
  assert.match(s, /^@echo off/);
  assert.ok(s.includes('cd /d "C:/Users/d/code/work space"'), 'the directory is quoted, spaces and all');
  assert.ok(s.includes(`claude --resume ${ID} --remote-control "Deck work"\n`), 'resume first, then the flag with its name');
  assert.ok(s.indexOf('--resume') < s.indexOf('--remote-control'), 'the id comes before the flag that takes a name');
});

test('anything that is not a session id never reaches a command line', () => {
  assert.equal(isSessionId(ID), true);
  assert.equal(isSessionId('x; del *'), false);
  assert.throws(() => phoneScript({ sessionId: 'x; del *', name: 'n', cwd: 'C:/' }), /not a session id/);
});

test('phoneSession writes the .cmd, hands it to the launcher, and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-'));
  const launched: string[] = [];
  const r = phoneSession({ sessionId: ID, name: 'Deck work', cwd: dir }, (p) => void launched.push(p));
  assert.equal(r.launched, true);
  assert.equal(r.name, 'Deck work');
  assert.equal(launched.length, 1);
  assert.match(launched[0], /claude-deck-phone-.*-6d7fbd89\.cmd$/);
  assert.ok(readFileSync(launched[0], 'utf8').includes('--remote-control "Deck work"'));
});

test('a missing directory is refused before anything is written; a failed launch is reported, not thrown', () => {
  assert.throws(() => phoneSession({ sessionId: ID, name: 'n', cwd: join(tmpdir(), 'phone-gone-' + Date.now()) }, () => {}), /no longer exists/);
  const dir = mkdtempSync(join(tmpdir(), 'phone-'));
  const r = phoneSession({ sessionId: ID, name: 'n', cwd: dir }, () => {
    throw new Error('no desktop');
  });
  assert.equal(r.launched, false);
});
