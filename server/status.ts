// `npm run status`: is the bridge up, what is the pairing code, and what has
// gone wrong lately. Asks the bridge itself, then falls back to the scheduled
// task and the log when it does not answer.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addresses, tailscaleHttps } from './addresses.ts';
import { loadDeckConfig } from './config.ts';
import { DATA_DIR } from './util.ts';

const LOG = join(DATA_DIR, 'deck.log');
const tail = (n: number): string =>
  existsSync(LOG) ? readFileSync(LOG, 'utf8').trimEnd().split(/\r?\n/).slice(-n).join('\n') : '(no log yet)';

let port = 4771;
try {
  port = loadDeckConfig().port;
} catch (e) {
  console.log(`Config: ${(e as Error).message}`);
}

try {
  const r = await fetch(`http://127.0.0.1:${port}/deck/health`, { signal: AbortSignal.timeout(3000) });
  const h = (await r.json()) as {
    pairCode: string;
    uptimeSec: number;
    lastPollAgoMs: number | null;
    lastPollMs: number;
    tablets: number;
    sessions: number;
    hooks: { sessions: number; last: { event: string; session: string; agoAt: number } | null };
    helpers: Record<string, { restarts: number; lastError: string }>;
    errors: string[];
  };
  console.log(`Deck bridge: running for ${Math.round(h.uptimeSec / 60)} min`);
  console.log(`  Pairing code:   ${h.pairCode}`);
  const a = addresses();
  const urls = (ips: string[]): string => ips.map((ip) => `http://${ip}:${port}`).join('  ');
  console.log(`  On the LAN:     ${urls(a.lan) || 'no LAN address'}`);
  console.log(`  Tailscale:      ${urls(a.tailscale) || 'not on a tailnet (the phone away from home needs it)'}`);
  console.log(`  https (app):    ${tailscaleHttps() ?? `no Tailscale Serve config (tailscale serve --bg --https=443 http://127.0.0.1:${port})`}`);
  console.log(`  Tablets online: ${h.tablets}`);
  console.log(`  Sessions:       ${h.sessions}`);
  console.log(`  Last poll:      ${h.lastPollAgoMs ?? '?'} ms ago, took ${h.lastPollMs} ms`);
  console.log(
    `  Claude hooks:   ${h.hooks.last ? `${h.hooks.sessions} sessions reporting, last ${h.hooks.last.event} ${Math.round((Date.now() - h.hooks.last.agoAt) / 1000)}s ago` : 'none received yet (npm run hooks, then start a new session)'}`
  );
  for (const [name, s] of Object.entries(h.helpers)) {
    console.log(`  Helper ${name.padEnd(5)}: ${s.restarts} restarts${s.lastError ? `, last: ${s.lastError}` : ''}`);
  }
  if (h.errors.length) console.log(`  Errors now:     ${h.errors.join(' | ')}`);
} catch {
  console.log(`Deck bridge: NOT answering on http://127.0.0.1:${port}`);
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-ScheduledTask -TaskName 'Claude Deck' -ErrorAction Stop).State"], { encoding: 'utf8' }).trim();
    console.log(`  Login task: ${out}`);
  } catch {
    console.log('  Login task: not installed (npm run install:task)');
  }
  console.log(`\nLast lines of ${LOG}:\n` + tail(15));
}
