// Pieces more than one screen uses: the area switch, the header chips,
// the player, the dock, session state lines.

import { useEffect, useRef, useState } from 'react';
import type { ClaudeLimits } from '../../server/limits.ts';
import type { DeckSession, Phase } from '../../server/sessions.ts';
import type { NowPlaying } from '../../server/win32.ts';
import { act, ago, artUrl, mmss, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { BRANDS } from './brands.ts';
import { Icon, Play, Skip } from './icons.tsx';

export const PHASE: Record<Phase, { label: string; cls: string }> = {
  needs: { label: 'Needs you', cls: 'needs' },
  permission: { label: 'Needs permission', cls: 'needs' },
  blocked: { label: 'Tool waiting', cls: 'blocked' },
  working: { label: 'Working', cls: 'working' },
  done: { label: 'Finished', cls: 'done' },
  idle: { label: 'Quiet', cls: 'idle' },
};

export const nameOf = (s: DeckSession): string => s.title ?? s.name;

/** An area's colour from the config; grey for none. */
export function hueOf(state: DeckState, area: string | null): string {
  return state.areas.find((a) => a.id === area)?.color ?? '#9aa1ae';
}

/** Age of a session as of now, not as of the last push. */
export const ageOf = (state: DeckState, s: DeckSession, now: number): number => s.ageMs + (now - state.at);

/** The first sentence, for a card's one line; the whole thing when there is no full stop. */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.?!])(\s|$)/.exec(t);
  return m ? m[1] : t;
}

export function StateLine({ s, state, now }: { s: DeckSession; state: DeckState; now: number }) {
  const p = PHASE[s.phase];
  return (
    <span className={`stateline ${p.cls}`}>
      <span className="dot" />
      {s.phase === 'working' && s.tool ? `${s.tool}` : p.label}
      <span className="age">{ago(ageOf(state, s, now))}</span>
    </span>
  );
}

// ------------------------------------------------------------------ area switch
// One choice shared by Now and Sessions, kept on the tablet.

const AREA_KEY = 'deck-area';

/** The two phone widths: a folded phone, about 354 CSS px wide, gets one
 *  column and the compact cards; an open one, about 719, keeps the tablet's
 *  two-column Now. Both get the bottom bar (styles.css, "phone"). */
export const PHONE = '(max-width: 600px)';
export const HANDHELD = '(max-width: 760px)';

/** One short tick under the thumb when a decision lands or comes back. The
 *  phone has a motor; the tablet and the PC ignore it. */
export const buzz = (ms = 10): void => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no motor, or not allowed yet */
  }
};

/** Keep the screen on while the deck is up (the Wake Lock API, https only).
 *  Taken again whenever the page comes back into view, since the lock goes
 *  each time it leaves. Denied on a low battery; the page carries on. */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on || !window.isSecureContext || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let gone = false;
    const take = async (): Promise<void> => {
      if (gone || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* refused: a low battery, or a browser without it */
      }
    };
    void take();
    document.addEventListener('visibilitychange', () => void take());
    return () => {
      gone = true;
      void lock?.release();
    };
  }, [on]);
}

/** A media query as state, so a screen can draw differently rather than hide twice. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = (): void => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}

export function useArea(): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(() => {
    try {
      return localStorage.getItem(AREA_KEY);
    } catch {
      return null;
    }
  });
  const set = (next: string | null) => {
    setV(next);
    try {
      if (next) localStorage.setItem(AREA_KEY, next);
      else localStorage.removeItem(AREA_KEY);
    } catch {
      /* a switch that does not stick is still a switch */
    }
  };
  return [v, set];
}

/** The areas worth a chip: those present in `ids`, in the config's order. */
export function areaChips(state: DeckState, ids: (string | null)[]): { id: string; label: string; hue: string }[] {
  const present = new Set(ids.filter((x): x is string => !!x));
  return state.areas.filter((a) => present.has(a.id)).map((a) => ({ id: a.id, label: a.label, hue: a.color }));
}

export function AreaSwitch({ chips, value, onChange, look = 'pills' }: { chips: { id: string; label: string; hue: string }[]; value: string | null; onChange: (v: string | null) => void; look?: 'pills' | 'segment' }) {
  // An area that is no longer on this screen is no longer a filter.
  const on = value && chips.some((c) => c.id === value) ? value : null;
  return (
    <div className={look === 'pills' ? 'vchips' : 'vswitch'} role="group" aria-label="Area">
      <button className={on === null ? 'on' : ''} aria-pressed={on === null} onClick={() => onChange(null)}>
        All
      </button>
      {chips.map((c) => (
        <button key={c.id} className={on === c.id ? 'on' : ''} aria-pressed={on === c.id} onClick={() => onChange(on === c.id ? null : c.id)}>
          <span className="vdot" style={{ background: c.hue }} />
          {c.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ header chips

export function Clock({ now, big = false }: { now: number; big?: boolean }) {
  const d = new Date(now);
  return (
    <div className={`clock${big ? ' big' : ''}`}>
      <time>{d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
      <span>{d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
    </div>
  );
}

const clockAt = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** "14:13" inside a day, "Tue 19:00" beyond. */
export const when = (t: number, now: number) => (Math.abs(t - now) < 86_400_000 ? clockAt(t) : `${new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })} ${clockAt(t)}`);

/** Claude's two windows in one chip: "5h 28% · wk 42%", amber from 80%. */
export function LimitChip({ limits, now }: { limits: ClaudeLimits | null; now: number }) {
  if (!limits) return <span className="chip mono">limits <b className="muted">no reading</b></span>;
  const five = limits.windows.find((w) => w.id === 'five_hour');
  const week = limits.windows.find((w) => w.id === 'seven_day');
  const pct = (w?: { pct: number | null }) => (w ? (w.pct === null ? 'reset' : `${w.pct}%`) : '?');
  const hot = [five, week].some((w) => w && w.pct !== null && w.pct >= 80);
  const old = now - limits.at > 30 * 60_000;
  return (
    <span className={`chip mono${hot ? ' amber' : ''}`} title={old ? `as of ${when(limits.at, now)}` : undefined}>
      5h <b>{pct(five)}</b> · wk <b>{pct(week)}</b>
      {old && <span className="muted"> · {when(limits.at, now)}</span>}
    </span>
  );
}

/** Claude's two windows as the status line last saved them, amber from 80%. */
export function LimitChips({ limits, now }: { limits: ClaudeLimits | null; now: number }) {
  if (!limits) {
    return (
      <span className="chip">
        Claude limits <b className="muted">no reading yet</b>
      </span>
    );
  }
  return (
    <>
      {limits.windows.map((w) => (
        <span key={w.id} className={`chip${w.pct !== null && w.pct >= 80 ? ' amber' : ''}`}>
          {w.id === 'five_hour' ? '5h' : 'Week'} <b>{w.pct === null ? 'reset' : `${w.pct}%`}</b>
          {w.pct !== null && <span className="muted">till {when(w.resetsAt, now)}</span>}
        </span>
      ))}
      {now - limits.at > 30 * 60_000 && <span className="chip">as of {when(limits.at, now)}</span>}
    </>
  );
}

// ------------------------------------------------------------------ media

export function Dock({ state }: { state: DeckState }) {
  const run = useRun();
  const running = new Set(state.running);
  return (
    <nav className="dock" aria-label="Apps">
      {state.config.apps.map((a, i) => {
        const b = BRANDS[a.icon] ?? { bg: '#2a2e37', fg: '#eceef3', glyph: a.label.slice(0, 1) };
        const on = !!a.proc && running.has(a.proc.toLowerCase());
        return (
          <button
            key={a.label}
            className="app"
            aria-label={a.label}
            onClick={() => run(act('/deck/app', { index: i }), on ? `Switched to ${a.label}` : `Opening ${a.label}`)}
          >
            <span className="apptile" style={{ background: b.bg }}>
              {b.path ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path fill={b.fg} d={b.path} />
                </svg>
              ) : (
                <span className="glyph" style={{ color: b.fg }}>
                  {b.glyph}
                </span>
              )}
              {on && <span className="runningdot" />}
            </span>
            <span className="applabel">{a.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function sourceName(app: string): string {
  if (/spotify/i.test(app)) return 'Spotify';
  if (/chrome/i.test(app)) return 'Chrome';
  if (/msedge|edge/i.test(app)) return 'Edge';
  if (/firefox/i.test(app)) return 'Firefox';
  return app.split('!').pop()!.split('.').pop()!;
}

export function pickMedia(state: DeckState, preferred?: string | null): NowPlaying | null {
  const m = state.media;
  return m.find((x) => x.app === preferred) ?? m.find((x) => x.status === 'Playing') ?? m[0] ?? null;
}

/** Where the track is now. Players report position as of `updatedAt`, and
 *  Spotify's desktop app always reports 0, which means unknown. */
export function livePosition(m: NowPlaying, now: number): number | null {
  if (!m.duration || !m.position) return null;
  const extra = m.status === 'Playing' ? (now - m.updatedAt) / 1000 : 0;
  return Math.min(m.duration, m.position + extra);
}

export function Progress({ m, now }: { m: NowPlaying; now: number }) {
  const pos = livePosition(m, now);
  if (pos == null) return null;
  return (
    <div className="progress">
      <div className="bar">
        <span style={{ width: `${(pos / m.duration) * 100}%` }} />
      </div>
      <div className="times">
        <span>{mmss(pos)}</span>
        <span>{mmss(m.duration)}</span>
      </div>
    </div>
  );
}

export function Art({ m, className }: { m: NowPlaying | null; className: string }) {
  if (m?.art) return <img className={className} src={artUrl(m.art)} alt={`Artwork for ${m.title}`} />;
  return (
    <div className={`${className} noart`} aria-hidden="true">
      <Icon name="media" size={40} stroke={1.5} />
    </div>
  );
}

export function Transport({ m, big = false }: { m: NowPlaying; big?: boolean }) {
  const run = useRun();
  const playing = m.status === 'Playing';
  const cmd = (c: 'toggle' | 'next' | 'prev', ok: string) => run(act('/deck/media', { cmd: c, app: m.app }), ok);
  return (
    <div className={`transport${big ? ' big' : ''}`}>
      <button className="round" aria-label="Previous track" onClick={() => cmd('prev', 'Previous track')}>
        <Skip dir="prev" size={big ? 28 : 20} />
      </button>
      <button className="round play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => cmd('toggle', playing ? 'Paused' : 'Playing')}>
        <Play playing={playing} size={big ? 36 : 24} />
      </button>
      <button className="round" aria-label="Next track" onClick={() => cmd('next', 'Next track')}>
        <Skip dir="next" size={big ? 28 : 20} />
      </button>
    </div>
  );
}

/** The strip at the foot of Now's side column: artwork, title, play, next. */
export function MiniPlayer({ state, onOpen }: { state: DeckState; onOpen: () => void }) {
  const run = useRun();
  const m = pickMedia(state);
  const playing = m?.status === 'Playing';
  const cmd = (c: 'toggle' | 'next', ok: string) => m && run(act('/deck/media', { cmd: c, app: m.app }), ok);
  return (
    <section className="nplayer" aria-label="Now playing">
      <button className="nplayerart" aria-label="Open the player" onClick={onOpen}>
        <Art m={m} className="art small" />
      </button>
      <div className="nplayertext">
        <p className="nplayertitle">{m?.title || 'Nothing playing'}</p>
        <p className="muted">{m ? `${m.artist || m.album} · ${sourceName(m.app)} · ${playing ? 'playing' : m.status.toLowerCase()}` : 'Spotify or a video on the PC shows here'}</p>
      </div>
      {m && (
        <>
          <button className="round play sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => cmd('toggle', playing ? 'Paused' : 'Playing')}>
            <Play playing={!!playing} size={20} />
          </button>
          <button className="round outline sm" aria-label="Next track" onClick={() => cmd('next', 'Next track')}>
            <Skip dir="next" size={18} />
          </button>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ dictation
// The browser's own speech recognition, which needs a secure page; over plain
// http the keyboard's mic is the way, so the button only shows where it can
// work.

export type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
export const speech = (): (new () => Recognition) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export function useDictation(onText: (text: string) => void): { can: boolean; listening: boolean; toggle: () => void } {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => () => rec.current?.stop(), []);
  const toggle = (): void => {
    if (listening) return rec.current?.stop();
    const R = speech();
    if (!R) return;
    const r = new R();
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.onresult = (e) => onText(Array.from(e.results, (x) => x[0].transcript).join(' ').trim());
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };
  return { can: !!speech() && window.isSecureContext, listening, toggle };
}
