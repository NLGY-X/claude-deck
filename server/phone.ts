// "Send to phone": put a Claude session on Remote Control so the Claude app on
// your phone can drive it.
//
// A session nobody holds (finished, or a tool that runs one process per turn
// and exits) is resumed in a new terminal with
// `--remote-control`, the documented flag. `claude remote-control
// --session-id` is NOT this: it only brings back sessions a Remote Control
// server was already serving, for about four hours. A session a terminal
// holds gets `/remote-control` typed into it instead (server/server.ts); the
// same session cannot be resumed twice, one writer per transcript.
//
// Same posture as resumeSession() in server/claude.ts: the directory comes
// from Claude Code's files, never the request, and the command goes in a .cmd
// file so spaces in folder names and `wt`'s `;` cannot bite.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Launcher } from './claude.ts';

export interface PhoneTarget {
  sessionId: string;
  /** what the Claude app should call it: Claude's title, or the registry name */
  name: string;
  cwd: string;
}

export interface PhoneResult {
  sessionId: string;
  dir: string;
  name: string;
  launched: boolean;
}

/** Session ids are UUIDs; anything else never reaches a command line. */
export const isSessionId = (id: string): boolean => /^[0-9a-f-]{8,64}$/i.test(id);

/** The name goes in quotes in the .cmd, so anything that could end the quotes
 *  or the line is dropped, not escaped. Forty characters is what the Claude
 *  app's list shows without cutting. */
export function phoneName(raw: string): string {
  const safe = raw
    .replace(/[^\w .,'()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return safe || 'session';
}

/** `--remote-control` takes an optional name, so it goes last with the name
 *  attached: the session id can never be read as the name. */
export function phoneScript(t: PhoneTarget): string {
  if (!isSessionId(t.sessionId)) throw new Error('not a session id');
  const name = phoneName(t.name);
  return `@echo off

title ${name} (phone)

cd /d "${t.cwd}"

claude --resume ${t.sessionId} --remote-control "${name}"

`;
}

const openTerminal: Launcher = (cmdPath) => {
  spawn('cmd', ['/c', 'start', '', cmdPath], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
};

export function phoneSession(t: PhoneTarget, launch: Launcher = openTerminal): PhoneResult {
  const script = phoneScript(t); // validates the id first
  if (!existsSync(t.cwd)) throw new Error('the session directory no longer exists: ' + t.cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cmdPath = join(tmpdir(), `claude-deck-phone-${stamp}-${t.sessionId.slice(0, 8)}.cmd`);
  writeFileSync(cmdPath, script, 'utf8');
  let launched = true;
  try {
    launch(cmdPath);
  } catch {
    launched = false; // degraded, not an error: the .cmd is there to run by hand
  }
  return { sessionId: t.sessionId, dir: t.cwd, name: phoneName(t.name), launched };
}
