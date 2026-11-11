// Adds (or with --remove, takes out) the deck's Claude Code hooks in
// ~/.claude/settings.json. Every other hook is left exactly as it was, the
// file is backed up first, and running it twice changes nothing.
//
//   npm run hooks       install
//   npm run unhooks     remove

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
const HOOK_CMD = fileURLToPath(new URL('./deck-hook.cmd', import.meta.url));
/** Notification carries permission prompts; the other three say the moment
 *  has passed (a turn ended, a tool finished, you typed). */
export const EVENTS = ['Notification', 'Stop', 'PostToolUse', 'UserPromptSubmit'];
const MARK = 'deck-hook.cmd';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; args?: string[]; timeout?: number }[];
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

const isDeck = (e: HookEntry): boolean => e.hooks.some((h) => (h.args ?? []).some((a) => a.endsWith(MARK)));

export function withDeckHooks(s: Settings, hookCmd: string, remove: boolean): Settings {
  const hooks = { ...(s.hooks ?? {}) };
  for (const ev of EVENTS) {
    const kept = (hooks[ev] ?? []).filter((e) => !isDeck(e));
    if (!remove) kept.push({ matcher: '*', hooks: [{ type: 'command', command: 'cmd.exe', args: ['/d', '/c', hookCmd], timeout: 5 }] });
    hooks[ev] = kept;
  }
  return { ...s, hooks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const remove = process.argv.includes('--remove');
  const raw = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '{}';
  const next = withDeckHooks(JSON.parse(raw) as Settings, HOOK_CMD, remove);
  const backup = `${SETTINGS}.before-deck-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, backup);
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`${remove ? 'Removed' : 'Installed'} the deck hooks (${EVENTS.join(', ')}) in ${SETTINGS}`);
  if (existsSync(backup)) console.log(`Backup of the previous file: ${backup}`);
  if (!remove) console.log('New Claude sessions pick them up; running ones need a restart to see them.');
}
