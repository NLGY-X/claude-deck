import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { JotAsk } from '../../server/jots.ts';
import { act, pair, token, useDeckState, type DeckState, type Link } from './api.ts';
import { pushBack } from './back.ts';
import { Icon } from './icons.tsx';
import { Jot, type JotInitial } from './Jot.tsx';
import { Keys } from './Keys.tsx';
import { Media } from './Media.tsx';
import { Now } from './Now.tsx';
import { HANDHELD, PHONE, useMedia, useWakeLock } from './parts.tsx';
import { useRest, Veil } from './Rest.tsx';
import { Sessions } from './Sessions.tsx';
import { readShare } from './share.ts';
import { Today } from './Today.tsx';

export type Screen = 'now' | 'day' | 'sessions' | 'keys' | 'media';

interface Toast {
  text: string;
  bad: boolean;
}

/** Run an action and say what happened: its own sentence on success, the
 *  bridge's sentence on failure. Every button goes through this, so nothing
 *  on the deck fails silently. */
type Run = (p: Promise<unknown>, ok: string) => Promise<boolean>;
const RunContext = createContext<Run>(async () => false);
export const useRun = (): Run => useContext(RunContext);
/** The SSE link's state, for the phone's header dot (the rail shows it elsewhere). */
const LinkContext = createContext<Link>('connecting');
export const useLink = (): Link => useContext(LinkContext);

export interface Nav {
  go: (s: Screen, sessionId?: string) => void;
  /** open the Jot sheet (ui/src/Jot.tsx) with a kind already chosen */
  jot: (kind?: JotAsk) => void;
}

export function App() {
  const [paired, setPaired] = useState(() => !!token.get());
  if (!paired) return <Pair onDone={() => setPaired(true)} />;
  return <Deck />;
}

function Deck() {
  const { state, link, heardAt } = useDeckState();
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const hello = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const vv = window.visualViewport;
        void act('/deck/hello', {
          w: window.innerWidth,
          h: window.innerHeight,
          vv: vv ? [Math.round(vv.width), Math.round(vv.height), vv.scale] : null,
          screen: [window.screen.width, window.screen.height],
          dpr: window.devicePixelRatio,
          orient: window.screen.orientation?.type,
          fontPx: getComputedStyle(document.documentElement).fontSize,
          standalone: matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches,
          secure: window.isSecureContext,
          // which layout the stylesheet chose
          layout: matchMedia(PHONE).matches ? 'phone' : matchMedia(HANDHELD).matches ? 'phone-open' : 'tablet',
          host: location.hostname,
          ua: navigator.userAgent,
        }).catch(() => {});
      }, 400);
    };
    hello();
    addEventListener('resize', hello);
    return () => removeEventListener('resize', hello);
  }, []);
  const [screen, setScreen] = useState<Screen>('now');
  const [focus, setFocus] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [jot, setJot] = useState<{ kind: JotAsk; initial?: JotInitial } | null>(null);
  // A push from the phone's ntfy app lands here with ?card=<id>: Now opens
  // at that card once the list has it (ui/src/Now.tsx).
  const [wanted, setWanted] = useState<string | null>(() => new URLSearchParams(location.search).get('card'));
  useEffect(() => {
    if (wanted) history.replaceState(null, '', '/');
  }, [wanted]);
  // The phone's share sheet: the service worker left it in the cache and sent
  // us to /?share=1; it opens Jot with the words, the link and the files.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('share') !== '1') return;
    history.replaceState(null, '', '/');
    void readShare()
      .then((s) => s && setJot({ kind: 'idea', initial: s }))
      .catch(() => {});
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(new Set<string>());

  const run = useCallback<Run>(async (p, ok) => {
    clearTimeout(timer.current);
    // The same action while the first is still going is a double tap. The
    // bridge ignores it too; stopping it here also keeps the toast honest.
    if (ok && inFlight.current.has(ok)) return false;
    if (ok) inFlight.current.add(ok);
    try {
      await p;
      if (ok) {
        setToast({ text: ok, bad: false });
        timer.current = setTimeout(() => setToast(null), 1800);
      }
      return true;
    } catch (e) {
      setToast({ text: (e as Error).message, bad: true });
      timer.current = setTimeout(() => setToast(null), 5000);
      return false;
    } finally {
      if (ok) inFlight.current.delete(ok);
    }
  }, []);

  const nav: Nav = {
    go: (s, sessionId) => {
      if (sessionId) setFocus(sessionId);
      switchTo(s);
    },
    jot: (kind = 'idea') => setJot({ kind }),
  };

  const waiting = state?.cards.length ?? 0;
  const sessionsWaiting = state?.cards.some((c) => c.kind === 'session') ?? false;
  const stale = link === 'lost' && !!state;
  const handheld = useMedia(HANDHELD);
  const rest = useRest(waiting, !handheld);
  // The desk tablet stays lit by the page itself once it is on https; the
  // phone keeps its own timeout.
  useWakeLock(!handheld);

  // Each tab keeps its place in the scroll, as native tabs do: the place is
  // noted at the tap, before the swap clamps it, and put back before paint.
  // The document scrolls on the phone; on the tablet the lists scroll inside
  // and this is 0.
  const scrolls = useRef<Partial<Record<Screen, number>>>({});
  const screenRef = useRef(screen);
  const switchTo = useCallback((s: Screen) => {
    scrolls.current[screenRef.current] = window.scrollY;
    setScreen(s);
  }, []);
  useLayoutEffect(() => {
    if (screenRef.current !== screen) {
      screenRef.current = screen;
      window.scrollTo(0, scrolls.current[screen] ?? 0);
    }
  }, [screen]);
  // Back from a tab returns to Now, as a bottom-bar app does (back.ts).
  const tabBack = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (screen !== 'now' && !tabBack.current) {
      tabBack.current = pushBack(() => {
        tabBack.current = null;
        switchTo('now');
      });
    } else if (screen === 'now' && tabBack.current) {
      const release = tabBack.current;
      tabBack.current = null;
      release();
    }
  }, [screen, switchTo]);

  return (
    <RunContext.Provider value={run}>
      <LinkContext.Provider value={link}>
      <div className="deck" style={{ transform: rest.shift }}>
        <Rail screen={screen} go={switchTo} waiting={waiting} sessionsWaiting={sessionsWaiting} link={link} jotOpen={!!jot} onJot={() => setJot(jot ? null : { kind: 'idea' })} />
        <main className={`stage${stale ? ' stale' : ''}`}>
          {stale && <Stale heardAt={heardAt} />}
          {!state ? (
            <Waiting link={link} />
          ) : screen === 'now' ? (
            <Now state={state} nav={nav} wanted={wanted} onWanted={() => setWanted(null)} />
          ) : screen === 'day' ? (
            <Today state={state} nav={nav} />
          ) : screen === 'sessions' ? (
            <Sessions state={state} focus={focus} setFocus={setFocus} />
          ) : screen === 'keys' ? (
            <Keys state={state} />
          ) : (
            <Media state={state} />
          )}
          {jot && state && <Jot state={state} preset={jot.kind} initial={jot.initial} onClose={() => setJot(null)} />}
        </main>
        {toast && (
          <div className={`toast${toast.bad ? ' bad' : ''}`} role="status" onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
      </div>
      {rest.resting && <Veil onWake={rest.wake} />}
      </LinkContext.Provider>
    </RunContext.Provider>
  );
}

const TABS: { id: Screen; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'day', label: 'Day' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'keys', label: 'Keys' },
  { id: 'media', label: 'Media' },
];

function Rail({ screen, go, waiting, sessionsWaiting, link, jotOpen, onJot }: { screen: Screen; go: (s: Screen) => void; waiting: number; sessionsWaiting: boolean; link: Link; jotOpen: boolean; onJot: () => void }) {
  const fullscreen = () => {
    const d = document as Document & { webkitFullscreenElement?: Element };
    if (d.fullscreenElement || d.webkitFullscreenElement) void d.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return (
    <nav className="rail" aria-label="Main">
      <div className="brandmark" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      {TABS.map((t) => (
        <button key={t.id} className={`navlink${screen === t.id ? ' on' : ''}`} aria-current={screen === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
          <span className="navicon">
            <Icon name={t.id} size={24} stroke={1.8} />
            {t.id === 'now' && waiting > 0 && <span className="badge">{waiting}</span>}
            {t.id === 'sessions' && sessionsWaiting && <span className="navdot" />}
          </span>
          <span>{t.label}</span>
        </button>
      ))}
      <div className="grow" />
      <button className={`jotkey${jotOpen ? ' on' : ''}`} onClick={onJot} aria-label="Jot something down" aria-pressed={jotOpen}>
        <Icon name="plus" size={26} stroke={2.4} />
      </button>
      <button className="navlink small" onClick={fullscreen} aria-label="Full screen">
        <Icon name="expand" size={20} stroke={1.8} />
      </button>
      <div className={`link ${link}`} title={link === 'live' ? 'Connected to the PC' : 'Reconnecting to the PC'}>
        <span className="linkdot" />
        <span>{link === 'live' ? 'PC' : link === 'lost' ? 'Lost' : '...'}</span>
      </div>
    </nav>
  );
}

/** Over a picture that is no longer the PC's. Says how old it is and that
 *  the tablet is trying again, so nobody acts on a glow that has gone. */
function Stale({ heardAt }: { heardAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const secs = heardAt ? Math.round((Date.now() - heardAt) / 1000) : null;
  return (
    <div className="stalebar" role="alert">
      <span className="linkdot" />
      Lost the PC{secs != null ? `, last heard ${secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`} ago` : ''}. Reconnecting. What you see may be out of date.
    </div>
  );
}

function Waiting({ link }: { link: Link }) {
  return (
    <div className="waiting">
      <p className="big">{link === 'lost' ? "Can't reach the PC" : 'Connecting to the PC'}</p>
      <p className="muted">{link === 'lost' ? 'Check the bridge is running: npm start' : 'One moment.'}</p>
    </div>
  );
}

function Pair({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // The same screen pairs the desk tablet and the phone; name the one in hand.
  const handheld = useMedia(HANDHELD);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await pair(code);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pair">
      <form onSubmit={submit} className="paircard">
        <div className="brandmark big" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <h1>{handheld ? 'Pair this phone' : 'Pair this tablet'}</h1>
        <p className="muted">Enter the six-digit code the bridge printed on the PC.</p>
        <label htmlFor="pair-code" className="sr">
          Pairing code
        </label>
        <input
          id="pair-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          autoFocus
        />
        {err && <p className="err">{err}</p>}
        <button className="primary" disabled={code.length !== 6 || busy}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  );
}

export type { DeckState };
