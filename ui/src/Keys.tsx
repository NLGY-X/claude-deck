// Keys: prompt keys, hotkeys, seats, and the app launchers along the bottom.
// Away from home (the page reached over Tailscale), "Focused window" keys are
// hidden: nothing is in front of you to paste into, so only session-targeted
// keys show.

import { useState } from 'react';
import { act, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { Icon } from './icons.tsx';
import { Dock, hueOf, nameOf } from './parts.tsx';

const SEATS = 'Seats';

/** Reached over the tailnet: a 100.64.0.0/10 address or a .ts.net host. */
export const awayFromHome = (): boolean => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\.ts\.net$/i.test(location.hostname);

export function Keys({ state }: { state: DeckState }) {
  const run = useRun();
  const away = awayFromHome();
  const groups = [...Object.keys(state.config.prompts), SEATS];
  const [tab, setTab] = useState(groups[0]);
  const terminals = state.sessions.filter((s) => s.host === 'terminal');
  const [target, setTarget] = useState(away ? (terminals[0]?.sessionId ?? 'focused') : 'focused');
  const isSeats = tab === SEATS;
  const targetName = target === 'focused' ? 'the focused window' : nameOf(terminals.find((s) => s.sessionId === target) ?? terminals[0]);
  // What a paste would land in right now, straight from the PC. Green means
  // the bridge will paste into it; amber means it will refuse.
  const fg = state.foreground;
  const fgOk = !!fg && state.config.typeInto.includes(fg.proc);
  const fgTitle = fg?.title.replace(/ - (Cursor|Visual Studio Code)$/, '') ?? '';
  const fgLabel = fg ? `${fg.proc === 'windowsterminal' ? 'Terminal' : fg.proc}${fgTitle ? ` · ${fgTitle.slice(0, 38)}` : ''}` : '';
  const keys = (state.config.prompts[tab] ?? []).filter((k) => !(away && k.keys)); // a chord needs a window in front

  return (
    <div className="prompts">
      <header className="ptop">
        <h1>Keys</h1>
        <div className="tabs" role="tablist">
          {groups.map((g) => (
            <button key={g} role="tab" aria-selected={g === tab} className={g === tab ? 'on' : ''} onClick={() => setTab(g)}>
              {g}
            </button>
          ))}
        </div>
      </header>

      {!isSeats ? (
        <div className="targets">
          <span className="label">Sends to</span>
          {!away && (
            <button className={`target${target === 'focused' ? ' on' : ''}`} onClick={() => setTarget('focused')}>
              <span className="swatch" style={{ background: fgOk ? '#5fcf9b' : '#f5b544' }} />
              Focused window
              {fg && <span className="fgname">{fgLabel}</span>}
            </button>
          )}
          {terminals.slice(0, 4).map((s) => (
            <button key={s.sessionId} className={`target${target === s.sessionId ? ' on' : ''}`} onClick={() => setTarget(s.sessionId)}>
              <span className="swatch" style={{ background: hueOf(state, s.area) }} />
              {nameOf(s)}
            </button>
          ))}
          {away && terminals.length === 0 && <span className="muted">Away from home: no terminal session to send to.</span>}
        </div>
      ) : (
        <div className="targets">
          <span className="label">Each starts a new Claude session in its folder.</span>
        </div>
      )}

      <div className="keys">
        {!isSeats &&
          keys.map((k) => {
            const i = state.config.prompts[tab].indexOf(k);
            return (
              <button
                key={k.title}
                className="key"
                disabled={away && target === 'focused'}
                onClick={() =>
                  run(
                    act('/deck/prompt', { group: tab, index: i, target }),
                    k.keys ? `Sent ${k.keys}` : k.send ? `Ran “${k.title}” in ${targetName}` : `Pasted “${k.title}” into ${targetName}`
                  )
                }
              >
                <span className="keytop">
                  <span className="keyicon">
                    <Icon name={k.icon ?? 'keys'} size={20} />
                  </span>
                  <span className="kind">{k.keys ?? (k.send ? 'runs' : 'text')}</span>
                </span>
                <strong>{k.title}</strong>
                {k.text && !k.keys && <span className="desc">{k.text}</span>}
              </button>
            );
          })}
        {isSeats &&
          state.config.seats.map((s, i) => (
            <button key={s.title} className="key seat" onClick={() => run(act('/deck/seat', { index: i }), `Started “${s.title}”. It shows up on Now when it needs you.`)}>
              <span className="keytop">
                <span className="keyicon">
                  <Icon name={s.icon ?? 'seat'} size={20} />
                </span>
                <span className="kind">{s.dir.split(/[\\/]/).pop()}</span>
              </span>
              <strong>{s.title}</strong>
              <span className="desc">
                {s.needsClipboard ? 'Uses what you copied on the PC. ' : ''}
                {s.why ?? s.brief.split('\n')[0]}
              </span>
            </button>
          ))}
      </div>

      <PushBox state={state} />
      <Dock state={state} />
    </div>
  );
}

/** The phone's push subscription: the server and the topic to put into the
 *  ntfy app, and a test that opens the deck at the top card. The topic is
 *  the secret, so it shows here, on the paired deck, and nowhere public. */
function PushBox({ state }: { state: DeckState }) {
  const run = useRun();
  const p = state.push;
  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      void run(Promise.resolve(), `Copied the ${what}`);
    } catch {
      void run(Promise.reject(new Error(`Couldn't copy here. The ${what} is ${text}`)), '');
    }
  };
  return (
    <section className="pushbox" aria-label="Phone push">
      <div className="pushhead">
        <span className="label">Phone push</span>
        {p ? (
          <span className="muted">On the phone or the tablet with the ntfy app installed: tap Open and subscribe, or put these two into Subscribe to topic, Use another server. A session that starts waiting on you lands there and opens the deck at its card.</span>
        ) : (
          <span className="muted">Not set up. On the PC: bash ntfy/install.sh, then it shows here.</span>
        )}
      </div>
      {p && (
        <div className="pushrow">
          <a className="hbbtn primary pushopen" href={`ntfy://${p.url.replace(/^https?:\/\//, '')}/${p.topic}`} title="On a device with the ntfy app: opens it on this topic">
            Open in the ntfy app
          </a>
          <button className="pushval" onClick={() => void copy(p.url, 'server')} title="Tap to copy">
            <span className="muted">server</span>
            <span className="mono">{p.url}</span>
          </button>
          <button className="pushval" onClick={() => void copy(p.topic, 'topic')} title="Tap to copy">
            <span className="muted">topic</span>
            <span className="mono">{p.topic}</span>
          </button>
          <button className="hbbtn soft" onClick={() => run(act('/deck/push/test', {}), '')}>
            Send a test
          </button>
        </div>
      )}
    </section>
  );
}
