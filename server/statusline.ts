// Claude Code's status line command, set as "statusLine" in
// ~/.claude/settings.json. Claude Code runs it on each status line update with
// the session as JSON on stdin; it saves the plan limits in that JSON for the
// deck (server/limits.ts) and prints the line itself:
//
//   Opus 5.5 · 5h 42% · week 61%
//
// It must never fail loudly: whatever goes wrong, it still prints a line.

import { LIMITS_FILE, parseRateLimits, writeLimits } from './limits.ts';

/** The line Claude Code shows, from the session JSON. */
export function line(session: { model?: { display_name?: string }; rate_limits?: unknown }): string {
  const parts: string[] = [];
  if (session.model?.display_name) parts.push(session.model.display_name);
  for (const w of parseRateLimits(session.rate_limits) ?? []) {
    parts.push(`${w.id === 'five_hour' ? '5h' : 'week'} ${w.pct}%`);
  }
  return parts.join(' · ');
}

/** Saves the limits for the deck. False: the session carries none. */
export function save(rateLimits: unknown, path = LIMITS_FILE, now = Date.now()): boolean {
  const windows = parseRateLimits(rateLimits);
  return windows ? writeLimits(windows, path, now) : false;
}

if (import.meta.main) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let session: Parameters<typeof line>[0] = {};
    try {
      session = JSON.parse(input);
    } catch {
      /* print an empty line rather than an error in Claude Code's footer */
    }
    save(session.rate_limits);
    process.stdout.write(line(session));
  });
}
