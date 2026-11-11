// Starts the deck bridge with the real desktop. The server itself is
// server/server.ts; this file only wires it up.
//
//   npm start            run it here (prints the address and a pairing code)
//   npm run install:task run it at every login, hidden, restarted if it dies
//   npm run status       is it up, what is the code, what went wrong
//   npm run build        rebuild the tablet UI after changing ui/

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addresses, tailscaleHttps } from './addresses.ts';
import { listLiveSessions, resumeSession, startSession } from './claude.ts';
import { DECK_CONFIG, areaForPath, loadDeckConfig, type DeckConfig } from './config.ts';
import { describePhoto, fetchLink, transcribe } from './jots.ts';
import { fetchLimits, readLimits } from './limits.ts';
import { phoneSession } from './phone.ts';
import { readPush } from './push.ts';
import { CommitCounter, gitRepos } from './report.ts';
import { createBridge } from './server.ts';
import { deckSessions } from './sessions.ts';
import { DATA_DIR, resolveCli } from './util.ts';
import { Win32 } from './win32.ts';

const TOKEN_PATH = join(DATA_DIR, 'deck-token');
const TAPS_PATH = join(DATA_DIR, 'deck-taps.jsonl'); // read with npm run taps

function loadToken(): string {
  if (process.argv.includes('--new-token') || !existsSync(TOKEN_PATH)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_PATH, randomBytes(24).toString('hex'), { mode: 0o600 });
    console.log('deck: new token written; every tablet will need to pair again');
  }
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

mkdirSync(DATA_DIR, { recursive: true });
let deck: DeckConfig = loadDeckConfig();
let configError = '';

// Pick up config edits without a restart. A broken file keeps the last good
// config and says why on the tablet.
watch(DECK_CONFIG, () => {
  setTimeout(() => {
    try {
      deck = loadDeckConfig();
      configError = '';
      console.log('deck: config reloaded');
    } catch (e) {
      configError = (e as Error).message;
      console.error('deck: config not reloaded:', configError);
    }
  }, 150);
});

const hands = new Win32('taps', 6000);
const eyes = new Win32('poll', 4000);

function printPairing(code: string): void {
  const a = addresses();
  const url = (ip: string): string => `http://${ip}:${deck.port}`;
  const lan = a.lan.map(url);
  console.log('');
  console.log(`  Deck ready. On the tablet, open ${lan[0] ?? `http://<this PC's IP>:${deck.port}`}`);
  for (const u of lan.slice(1)) console.log(`  (or ${u})`);
  // The phone, anywhere: Tailscale gives this PC a 100.x address that only
  // your own devices can reach. Same bridge, same token, no port opened.
  for (const u of a.tailscale.map(url)) console.log(`  Away from home (Tailscale): ${u}`);
  const https = tailscaleHttps();
  if (https) console.log(`  As an app, https (Tailscale Serve): ${https}`);
  console.log(`  Pairing code: ${code}`);
  console.log('');
}

// Claude's plan limits: asked of Claude Code every five minutes
// (server/limits.ts says why this and not only the status line). No model
// call, so it costs nothing against the limits it reads.
const cli = resolveCli();
let asking = false;
async function askLimits(): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    if (!(await fetchLimits(cli))) console.error('deck: claude /usage gave no reading');
  } finally {
    asking = false;
  }
}
void askLimits();
setInterval(() => void askLimits(), 5 * 60_000).unref();

// Today's commits for "so far today", counted in the background every five
// minutes across the repos the config lists.
const commits = new CommitCounter(() => gitRepos(deck.report.repos));

let listening = false;
const bridge = createBridge({
  deck: () => deck,
  configError: () => configError,
  hands,
  eyes,
  sessions: (hooks) => deckSessions((cwd) => areaForPath(deck.areas, cwd), hooks),
  token: loadToken(),
  startSession: (req) => startSession(req),
  resumeSession: (id) => resumeSession(id),
  phoneSession: (id, name) => {
    const found = listLiveSessions().find((s) => s.sessionId === id);
    if (!found) throw new Error('That session is no longer in Claude Code’s files.');
    return phoneSession({ sessionId: id, name, cwd: found.cwd });
  },
  uiDist: fileURLToPath(new URL('../ui/dist', import.meta.url)),
  onPairCode: (code) => listening && printPairing(code),
  // After a jot: the page's text copy, a photo described by Claude on the
  // cheap model, a voice note written down (server/jots.ts).
  jotTools: {
    fetchLink: (u) => fetchLink(u),
    describePhoto: (p) => describePhoto(p, cli),
    transcribe: (p) => transcribe(p, { script: fileURLToPath(new URL('./transcribe.py', import.meta.url)) }),
  },
  // The phone's push topic (ntfy/install.sh writes it); read each tick so a new file counts without a restart.
  push: () => readPush(),
  transcript: (id) => listLiveSessions().find((s) => s.sessionId === id)?.transcript ?? null,
  limits: () => readLimits(),
  commits: () => commits.get(),
  tapLog: (tap) => appendFileSync(TAPS_PATH, JSON.stringify(tap) + '\n'),
});

await bridge.tick();
bridge.startTimers();
try {
  await bridge.app.listen({ port: deck.port, host: '0.0.0.0' });
} catch (e) {
  // Most often a second copy is already running (the login task and a manual
  // `npm start`). Exiting non-zero would make the service loop retry for
  // ever, so say what happened and exit cleanly.
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`deck: port ${deck.port} is already in use. Is the deck already running? Try: npm run status`);
    hands.stop();
    eyes.stop();
    process.exit(0);
  }
  throw e;
}
listening = true;
printPairing(bridge.pairCode());

const shutdown = (): void => {
  bridge.stop();
  hands.stop();
  eyes.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
