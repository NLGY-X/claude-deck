import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCKED_AFTER_MS, derive, endsOnQuestion, hostOf } from './sessions.ts';

const said = (text: string, stop = 'end_turn') => ({ type: 'assistant', message: { stop_reason: stop, content: [{ type: 'text', text }] } });
const toolCall = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] },
});
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
const prompt = (text: string) => ({ type: 'user', message: { content: text } });

test('a turn that ends on a question needs you', () => {
  const d = derive([prompt('build it'), said('Spike is done. Want me to commit?')], 5_000);
  assert.equal(d.phase, 'needs');
  assert.match(d.text, /Want me to commit\?$/);
});

test('a turn that ends on a statement is finished, not a glow', () => {
  assert.equal(derive([said('Committed as a06a2ab.')], 5_000).phase, 'done');
});

test('a question mark hidden by trailing markdown still counts', () => {
  assert.ok(endsOnQuestion('Which would you rather?**'));
  assert.ok(endsOnQuestion('Shall I (a) or (b)?)\n'));
  assert.ok(!endsOnQuestion('The URL is /x?y=1 and it works.'));
});

test('a tool call is working until it has run too long to be sure', () => {
  const entries = [prompt('go'), toolCall('Bash', { command: 'npm test', description: 'Run the tests' })];
  const early = derive(entries, 2_000);
  assert.equal(early.phase, 'working');
  assert.equal(early.tool, 'Bash');
  assert.equal(early.text, 'Run the tests');
  assert.equal(derive(entries, BLOCKED_AFTER_MS + 1).phase, 'blocked');
});

test('a tool result means Claude has the move', () => {
  assert.equal(derive([toolCall('Read', { file_path: 'C:/x/a.ts' }), toolResult], 1_000).phase, 'working');
});

test('thinking-only chunks and bookkeeping are skipped, not read as a turn', () => {
  const thinking = { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }] } };
  assert.equal(derive([said('Ready. Go?'), thinking], 1_000).phase, 'needs');
  const meta = { type: 'user', isMeta: true, message: { content: 'caveat' } };
  assert.equal(derive([said('Ready. Go?'), meta], 1_000).phase, 'needs');
  const compacted = prompt('<local-command-stdout>Compacted </local-command-stdout>');
  assert.equal(derive([said('Done.'), compacted], 1_000).text, 'Compacted. Your move.');
});

test('an interrupt hands the move back to you', () => {
  assert.equal(derive([toolCall('Bash', {}), prompt('[Request interrupted by user]')], 1_000).phase, 'done');
});

test('a long answer is cut from the front, so the question survives', () => {
  const long = 'A'.repeat(900) + '. The question is at the end. Commit?';
  const d = derive([said(long)], 1_000);
  assert.ok(d.text.startsWith('…'));
  assert.ok(d.text.endsWith('Commit?'));
});

test('a session no process holds has no window, so it is not a terminal to type into', () => {
  assert.equal(hostOf({ pid: 0, entrypoint: null, kind: 'interactive' }), 'none');
  assert.equal(hostOf({ pid: 4242, entrypoint: 'claude-vscode', kind: 'interactive' }), 'vscode');
  assert.equal(hostOf({ pid: 4242, entrypoint: 'cli', kind: 'interactive' }), 'terminal');
  assert.equal(hostOf({ pid: 4242, entrypoint: null, kind: 'interactive' }), 'terminal');
});
