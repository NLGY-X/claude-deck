// The hand-back card (server/cards.ts), drawn: who and what in mono, one
// sentence that is the decision, the answer as buttons, and the whole card a
// button that opens the sheet. After a tap it shrinks to one green line with
// Undo for ten seconds.

import { useCallback, useEffect, useState } from 'react';
import type { Card, CardButton } from '../../server/cards.ts';
import { act } from './api.ts';
import { useRun } from './App.tsx';
import { Icon } from './icons.tsx';
import { buzz } from './parts.tsx';

export interface Settled {
  card: Card;
  said: string;
  undo?: Record<string, unknown>;
  at: number;
  /** where the card sat in the list when it was answered, so the line holds its place */
  index: number;
}

const LINE_MS = 10_000;

export type Settle = (card: Card, said: string, undo: Record<string, unknown> | undefined, index: number) => void;

/** Cards that were just answered, kept for ten seconds as a green line even
 *  after the PC's list has moved on without them. */
export function useSettled(): { settled: Map<string, Settled>; settle: Settle; clear: (id: string) => void } {
  const [settled, setSettled] = useState(new Map<string, Settled>());
  const settle = useCallback<Settle>((card, said, undo, index) => {
    setSettled((m) => new Map(m).set(card.id, { card, said, undo, at: Date.now(), index }));
  }, []);
  const clear = useCallback((id: string) => {
    setSettled((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
  }, []);
  useEffect(() => {
    if (!settled.size) return;
    const iv = setInterval(() => {
      const t = Date.now();
      setSettled((m) => {
        const n = new Map([...m].filter(([, s]) => t - s.at < LINE_MS));
        return n.size === m.size ? m : n;
      });
    }, 500);
    return () => clearInterval(iv);
  }, [settled.size]);
  return { settled, settle, clear };
}

const COMPACT = new Set(['chase']);

export function HandBack({ card, top, now, onSettle, onOpen }: { card: Card; top: boolean; now: number; onSettle: (said: string, undo?: Record<string, unknown>) => void; onOpen: () => void }) {
  const run = useRun();
  const [busy, setBusy] = useState<string | null>(null);
  const tap = async (b: CardButton, e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(b.action);
    try {
      const r = (await act<{ said?: string; undo?: Record<string, unknown> }>('/deck/card', { id: card.id, action: b.action }).catch((x: Error) => {
        void run(Promise.reject(x), '');
        return null;
      })) as { said?: string; undo?: Record<string, unknown> } | null;
      if (r?.said) {
        buzz();
        onSettle(r.said, r.undo);
      }
    } finally {
      setBusy(null);
    }
  };
  void now; // the line's own `when` carries the age; the push refreshes it each minute

  if (COMPACT.has(card.kind)) {
    return (
      <article className={`hb compact ${card.kind}${top ? ' top' : ''}`} onClick={onOpen} role="button" tabIndex={0} aria-label={card.title}>
        <span className="hbdot" style={{ background: card.hue }} />
        <div className="hbtext">
          <p className="hbtitle sm">{card.title}</p>
          <p className="hbdetail">{card.detail}</p>
        </div>
        {card.buttons.map((b) => (
          <button key={b.action} className={`hbbtn ${b.look} sm`} data-action={b.action} disabled={busy !== null} onClick={(e) => void tap(b, e)}>
            {b.label}
          </button>
        ))}
      </article>
    );
  }

  return (
    <article className={`hb ${card.kind}${top ? ' top' : ''}`} onClick={onOpen} role="button" tabIndex={0} aria-label={card.title}>
      <div className="hbmain">
        <div className="hbwords">
          <div className="hbline">
            <span className="hbdot" style={{ background: card.hue }} />
            <span>{card.source}</span>
            <span className="hbwhen">{card.when}</span>
          </div>
          <p className="hbtitle">{card.title}</p>
          {card.detail && <p className="hbdetail">{card.detail}</p>}
        </div>
      </div>
      <div className="hbbtns">
        {card.buttons.map((b) => (
          <button key={b.action} className={`hbbtn ${b.look}`} data-action={b.action} disabled={busy !== null} onClick={(e) => void tap(b, e)}>
            {busy === b.action ? '…' : b.label}
          </button>
        ))}
      </div>
    </article>
  );
}

/** The line a card shrinks to after a tap. Undo posts the bridge's own undo
 *  body back, to the card route unless the caller names another. */
export function SettledLine({ s, onUndone, undoPath = '/deck/card' }: { s: Settled; onUndone: () => void; undoPath?: string }) {
  const run = useRun();
  const left = Math.max(0, LINE_MS - (Date.now() - s.at));
  return (
    <article className="hb settled" aria-live="polite">
      <span className="hbtick" aria-hidden="true">
        <Icon name="check" size={14} stroke={3} />
      </span>
      <div className="hbtext">
        <p className="hbtitle sm">{s.said}</p>
        {s.card.title && <p className="hbdetail">{s.card.title}</p>}
      </div>
      {s.undo && (
        <button
          className="hbbtn quiet sm"
          onClick={async () => {
            if (await run(act(undoPath, s.undo!), 'Undone')) {
              buzz();
              onUndone();
            }
          }}
        >
          Undo <span className="mono muted">{Math.ceil(left / 1000)}</span>
        </button>
      )}
    </article>
  );
}
