// The Windows desktop, seen from Node. It keeps win32.ps1 running
// and turns each deck action into one JSON line to it. Another OS would
// replace this file and the .cmd launchers in claude.ts and phone.ts.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./win32.ps1', import.meta.url));

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export interface NowPlaying {
  app: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  /** seconds, as of `updatedAt`. A player that does not report position
   *  (Spotify while paused) sends 0, so 0 means unknown, not the start. */
  position: number;
  duration: number;
  updatedAt: number;
  /** id for `art()`, or null when the player gave no artwork */
  art: string | null;
}

export interface Foreground {
  proc: string;
  title: string;
}

/** Everything the bridge asks of the desktop. The bridge takes this as an
 *  interface so its tests can hand it a fake instead of a real keyboard. */
export interface Hands {
  paste(text: string, enter?: boolean): Promise<boolean>;
  keys(chord: string): Promise<boolean>;
  focusPid(pid: number, hint?: string): Promise<boolean>;
  focusApp(proc: string): Promise<boolean>;
  launch(target: string): Promise<boolean>;
  running(): Promise<Set<string>>;
  media(): Promise<NowPlaying[]>;
  mediaCmd(cmd: 'toggle' | 'next' | 'prev', app?: string): Promise<boolean>;
  volume(): Promise<{ level: number; muted: boolean }>;
  setVolume(level: number): Promise<boolean>;
  setMute(muted: boolean): Promise<boolean>;
  art(id: string): Promise<string | null>;
  clipboard(): Promise<string>;
  foreground(): Promise<Foreground>;
  stats(): { restarts: number; lastError: string };
  stop(): void;
}

/** Virtual-key codes for the names a config file uses. Letters and digits map
 *  to their ASCII code, which is what Windows uses for them. */
const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b,
  tab: 0x09, enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  '`': 0xc0, '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc,
};

/** "Ctrl+Shift+M" -> [0x11, 0x10, 0x4D]. Throws on a name it does not know, so
 *  a typo in the config fails at load rather than silently sending nothing. */
export function parseChord(chord: string): number[] {
  return chord.split('+').map((raw) => {
    const k = raw.trim().toLowerCase();
    if (k in VK) return VK[k];
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    throw new Error(`unknown key "${raw.trim()}" in "${chord}"`);
  });
}

/**
 * One PowerShell helper process. Calls are answered in order, so one hung
 * call (the Windows media API does hang now and then) would hold up every
 * call behind it. A timeout therefore kills the helper outright; the next call
 * starts a fresh one. The bridge runs two of these, one for taps and one for
 * the background poll, so a slow poll never sits in front of a tap.
 */
export class Win32 implements Hands {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private restarts = 0;
  private lastError = '';
  private readonly label: string;
  private readonly timeoutMs: number;

  constructor(label = 'win32', timeoutMs = 6000) {
    this.label = label;
    this.timeoutMs = timeoutMs;
  }

  stats(): { restarts: number; lastError: string } {
    return { restarts: this.restarts, lastError: this.lastError };
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true,
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
    this.ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      let booted = false;
      const bootTimer = setTimeout(() => {
        if (!booted) this.kill(`${this.label} helper did not start within 20s`);
      }, 20_000);
      lines.on('line', (line) => {
        let msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          return; // PowerShell noise, not a reply
        }
        if (msg.ready) {
          booted = true;
          clearTimeout(bootTimer);
          resolve();
          return;
        }
        const p = msg.id != null ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'win32 helper failed'));
      });
      child.on('exit', (code) => {
        clearTimeout(bootTimer);
        const err = new Error(`${this.label} helper exited (${code}): ${stderr.trim().slice(-400)}`);
        if (!booted) reject(err);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null; // the next call starts a fresh one
        }
      });
    });
    return this.ready;
  }

  /** Throw the helper away. Everything waiting on it fails now rather than
   *  after its own timeout, and the next call boots a clean one. */
  private kill(why: string): void {
    this.lastError = why;
    this.restarts++;
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    child?.kill();
  }

  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new Error(`${this.label} helper is restarting, try again`);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.kill(`${this.label} ${op} took over ${this.timeoutMs / 1000}s, helper restarted`), this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  paste = (text: string, enter = false) => this.call<boolean>('paste', { text, enter });
  keys = (chord: string) => this.call<boolean>('keys', { vks: parseChord(chord) });
  /** `hint` picks between several windows of one process by title. */
  focusPid = (pid: number, hint = '') => this.call<boolean>('focusPid', { pid, hint });
  focusApp = (proc: string) => this.call<boolean>('focusApp', { proc });
  launch = (target: string) => this.call<boolean>('launch', { target });
  running = async () => new Set(((await this.call<string[] | null>('running')) ?? []).map((s) => s.toLowerCase()));
  media = async () => (await this.call<NowPlaying[] | null>('media')) ?? [];
  mediaCmd = (cmd: 'toggle' | 'next' | 'prev', app?: string) => this.call<boolean>('mediaCmd', { cmd, app });
  volume = () => this.call<{ level: number; muted: boolean }>('volume');
  setVolume = (level: number) => this.call<boolean>('setVolume', { level });
  setMute = (muted: boolean) => this.call<boolean>('setMute', { muted });
  /** Artwork bytes, base64, or null if the id has aged out of the cache. */
  art = (id: string) => this.call<string | null>('art', { art: id });
  clipboard = async () => (await this.call<string | null>('clipboard')) ?? '';
  foreground = async () => (await this.call<Foreground | null>('foreground')) ?? { proc: '', title: '' };

  stop(): void {
    this.child?.kill();
  }
}
