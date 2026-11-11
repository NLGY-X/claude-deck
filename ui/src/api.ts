// Talking to the bridge: the paired token, actions, and the live state stream.

import { useEffect, useState } from 'react';
import type { DeckState } from '../../server/server.ts';

export type { AreaInfo, DeckState } from '../../server/server.ts';

/** The bridge beats every 5 s (HEARTBEAT_MS in server/server.ts). Three missed
 *  beats and the picture on screen is no longer the PC's. */
const DEAD_AFTER_MS = 16_000;

const KEY = 'deck-token';

// Storage can throw (private mode, cleared site data). Without it the tablet
// just asks for a pairing code again, which is the right failure.
export const token = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(t: string): void {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* see above */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* see above */
    }
  },
};

export async function pair(code: string): Promise<void> {
  const r = await fetch('/deck/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(j.error ?? `Pairing failed (${r.status})`);
  token.set(j.token);
}

/** POST an action. Resolves with the bridge's reply or throws its sentence. */
export async function act<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  return send<T>(path, { 'content-type': 'application/json' }, JSON.stringify(body));
}

/** POST a form with files: the jot sheet. The browser sets the multipart boundary. */
export async function actForm<T = Record<string, unknown>>(path: string, form: FormData): Promise<T> {
  return send<T>(path, {}, form);
}

/** GET something the bridge reads on demand: a card's Resolve context. */
export async function get<T = Record<string, unknown>>(path: string): Promise<T> {
  return send<T>(path, {}, undefined);
}

async function send<T>(path: string, headers: Record<string, string>, body: BodyInit | undefined): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, authorization: `Bearer ${token.get() ?? ''}` }, body });
  } catch {
    throw new Error("Can't reach the PC. Is the bridge running?");
  }
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (r.status === 401) {
    token.clear();
    location.reload();
  }
  if (r.status === 413) throw new Error('That is over 60 MB, the most one jot can carry.');
  if (!r.ok) throw new Error(j.error ?? `That didn't work (${r.status})`);
  return j;
}

export const artUrl = (id: string): string => `/deck/art/${encodeURIComponent(id)}?t=${encodeURIComponent(token.get() ?? '')}`;

export type Link = 'connecting' | 'live' | 'lost';

/**
 * The bridge pushes a new state whenever something changes, and a heartbeat
 * every few seconds whether or not it did. EventSource reconnects by itself
 * after an error, but a link that dies quietly (the PC sleeps, the Wi-Fi
 * drops) raises no error at all, and the screen would go on showing an old
 * picture as if it were live. So the tablet counts heartbeats: if they stop,
 * it says so and opens a fresh connection itself.
 */
export function useDeckState(): { state: DeckState | null; link: Link; heardAt: number } {
  const [state, setState] = useState<DeckState | null>(null);
  const [link, setLink] = useState<Link>('connecting');
  const [heardAt, setHeardAt] = useState(0);
  useEffect(() => {
    const t = token.get();
    if (!t) return;
    let es: EventSource | null = null;
    let last = Date.now();
    const heard = () => {
      last = Date.now();
      setHeardAt(last);
      setLink('live');
    };
    const open = () => {
      es?.close();
      es = new EventSource(`/deck/events?t=${encodeURIComponent(t)}`);
      es.addEventListener('state', (e) => {
        const s = JSON.parse((e as MessageEvent<string>).data) as DeckState;
        setState(s);
        heard();
      });
      es.addEventListener('ping', heard);
      es.onopen = heard;
      es.onerror = () => {
        setLink('lost');
        // A 401 on the stream means the token was rotated on the PC.
        fetch('/deck/state', { headers: { authorization: `Bearer ${t}` } })
          .then((r) => {
            if (r.status === 401) {
              token.clear();
              location.reload();
            }
          })
          .catch(() => {});
      };
    };
    open();
    const watchdog = setInterval(() => {
      if (Date.now() - last > DEAD_AFTER_MS) {
        setLink('lost');
        last = Date.now(); // one reconnect per window, not one per tick
        open();
      }
    }, 2000);
    // Waking the tablet: don't wait for the watchdog to notice.
    const onWake = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 6000) open();
    };
    document.addEventListener('visibilitychange', onWake);
    return () => {
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onWake);
      es?.close();
    };
  }, []);
  return { state, link, heardAt };
}

/** A clock that re-renders once a second, for ages. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(iv);
  }, [ms]);
  return now;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Ages that can run to weeks: minutes, then hours, then days. */
export function ageShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const mmss = (secs: number): string =>
  `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
