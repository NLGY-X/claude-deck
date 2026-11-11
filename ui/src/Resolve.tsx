// Resolve: what a card opens into. Context on the left (a session's last
// turns, or the waiting-on item), the card's answers on the right, and for a
// terminal session a box that types your own reply into it.

import { useEffect, useState } from 'react';
import type { Card } from '../../server/cards.ts';
import { act, get, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { useBackClose } from './back.ts';
import { Icon } from './icons.tsx';
import { buzz, useDictation } from './parts.tsx';

type Settle = (said: string, undo?: Record<string, unknown>) => void;
type Context = { kind: 'session'; turns: { who: 'you' | 'claude'; text: string }[] } | { kind: 'chase' };

export function Resolve({ card: given, onClose, onSettle }: { card: Card; state: DeckState; onClose: () => void; onSettle: Settle }) {
  const run = useRun();
  const [loaded, setLoaded] = useState<Card | null>(null);
  const card = loaded && loaded.id === given.id ? loaded : given;
  const [ctx, setCtx] = useState<Context | null>(null);
  const [err, setErr] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const dictation = useDictation((t) => setDraft((d) => `${d} ${t}`.trim()));
  useBackClose(onClose);

  useEffect(() => {
    let live = true;
    get<{ card: Card; context: Context }>(`/deck/resolve/${encodeURIComponent(given.id)}`)
      .then((r) => {
        if (!live) return;
        setLoaded(r.card);
        setCtx(r.context);
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [given.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);

  /** A button on the card: the bridge answers with the green line's sentence. */
  const decide = async (action: string): Promise<void> => {
    if (busy) return;
    setBusy(action);
    try {
      const r = await act<{ said?: string; undo?: Record<string, unknown> }>('/deck/card', { id: card.id, action }).catch((x: Error) => {
        void run(Promise.reject(x), '');
        return null;
      });
      if (r?.said) {
        buzz();
        onSettle(r.said, r.undo);
        onClose();
      }
    } finally {
      setBusy(null);
    }
  };
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text) return;
    if (await run(act('/deck/session/reply', { sessionId: card.ref.sessionId, text }), `Sent to ${card.ref.name}`)) setDraft('');
  };

  const terminal = card.kind === 'session' && card.ref.host === 'terminal';

  return (
    <div className="resolve" role="dialog" aria-label={card.title}>
      <header className="rhead">
        <button className="rback" aria-label="Back to the list" onClick={onClose}>
          <Icon name="back" size={20} />
        </button>
        <div className="rheadtext">
          <p className="rline">
            <span className="hbdot" style={{ background: card.hue }} />
            {card.source} · {card.when}
          </p>
          <h1 className="rtitle">{card.title}</h1>
        </div>
      </header>

      <div className={`rbody ${card.kind}`}>
        {!ctx ? (
          <section className="rctx">
            <p className={`hint${err ? ' box' : ''}`}>{err || 'Reading…'}</p>
          </section>
        ) : ctx.kind === 'session' ? (
          <SessionPane card={card} turns={ctx.turns} />
        ) : (
          <section className="rctx">
            <article className="rcard">
              <p className="eyebrow">Waiting on</p>
              <pre className="hbbody">{card.body}</pre>
              {card.detail && <p className="hint">{card.detail}</p>}
            </article>
          </section>
        )}

        <section className="rpanel" aria-label="Resolve">
          <div className="rpanelhead">
            <h2>Resolve</h2>
            <span className="mono muted push">{card.when}</span>
          </div>
          <div className="rchips">
            {card.buttons.map((b) => (
              <button key={b.action} className={`rchip ${b.look}`} disabled={!!busy} onClick={() => void decide(b.action)}>
                {b.label}
              </button>
            ))}
          </div>
          <div className="rthread" />
          {terminal ? (
            <div className="rcompose">
              {dictation.can && (
                <button className={`jotmic${dictation.listening ? ' on' : ''}`} aria-label={dictation.listening ? 'Stop listening' : 'Dictate'} onClick={dictation.toggle}>
                  <Icon name="mic" size={20} stroke={1.8} />
                </button>
              )}
              <label className="sr" htmlFor="resolve-text">
                Say it your way
              </label>
              <input id="resolve-text" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder="Commit it, then start the next step" autoComplete="off" />
              <button className="rsend" disabled={!draft.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>
          ) : (
            <p className="hint box">{card.kind === 'session' ? card.detail || 'Nothing on the PC holds this session.' : 'Chase puts the Chase card on Today. Any message is written on the PC, never sent from here.'}</p>
          )}
          <p className="rfoot">{terminal ? 'A reply brings the window to the front, pastes the text and presses Enter.' : card.kind === 'session' ? 'The deck types only into terminal sessions.' : ''}</p>
        </section>
      </div>
    </div>
  );
}

function SessionPane({ card, turns }: { card: Card; turns: { who: 'you' | 'claude'; text: string }[] }) {
  return (
    <section className="rctx" aria-label="The last turns">
      <article className="rcard grow">
        <p className="eyebrow">The last turns · {String(card.ref.name)}</p>
        {turns.length ? (
          <div className="rthread static">
            {turns.map((t, i) => (
              <div key={i} className={`rbubble ${t.who}`}>
                {t.who === 'claude' && <span className="eyebrow">Claude</span>}
                <span>{t.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <p className="hint">The transcript is not readable from here; these are Claude's last words from the card.</p>
            <pre className="hbbody">{card.body}</pre>
          </>
        )}
      </article>
    </section>
  );
}
