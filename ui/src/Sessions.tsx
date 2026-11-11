// Sessions: every Claude session on the PC, one chosen, with the reply box
// for terminal sessions and the three ways to reach it.

import { useState } from 'react';
import { act, useNow, type DeckState } from './api.ts';
import { useRun } from './App.tsx';
import { Icon } from './icons.tsx';
import { AreaSwitch, PHASE, StateLine, areaChips, hueOf, nameOf, useArea } from './parts.tsx';

export const QUICK_REPLIES = ['Yes, go ahead', 'No, stop there', 'Show me first'];

export function Sessions({ state, focus, setFocus }: { state: DeckState; focus: string | null; setFocus: (id: string) => void }) {
  const [area, setArea] = useArea();
  const chips = areaChips(state, state.sessions.map((s) => s.area));
  const filter = area && chips.some((c) => c.id === area) ? area : null;
  // A session asked for from elsewhere shows even when the filter would hide it.
  const sessions = state.sessions.filter((s) => !filter || s.area === filter || s.sessionId === focus);
  return (
    <div className="work">
      <header className="wtop">
        <h1>Sessions</h1>
        {chips.length > 1 && <AreaSwitch chips={chips} value={area} onChange={setArea} look="segment" />}
      </header>
      <SessionList state={state} sessions={sessions} filtered={!!filter} focus={focus} setFocus={setFocus} />
    </div>
  );
}

function SessionList({ state, sessions, filtered, focus, setFocus }: { state: DeckState; sessions: DeckState['sessions']; filtered: boolean; focus: string | null; setFocus: (id: string) => void }) {
  const now = useNow();
  const run = useRun();
  const [draft, setDraft] = useState('');
  const s = sessions.find((x) => x.sessionId === focus) ?? sessions[0] ?? null;

  if (!s) {
    return (
      <div className="waiting">
        <p className="big">No sessions{filtered ? ' here' : ' running'}</p>
        <p className="muted">{filtered ? 'Switch to All to see every session.' : 'Start Claude Code on the PC and it shows up here.'}</p>
      </div>
    );
  }

  const terminal = s.host === 'terminal';
  const reply = async (text: string) => {
    if (await run(act('/deck/session/reply', { sessionId: s.sessionId, text }), `Sent “${text}” to ${nameOf(s)}`)) setDraft('');
  };

  return (
    <div className="sessions">
      <aside className="slist" aria-label="Sessions">
        {sessions.map((x) => (
          <button key={x.sessionId} className={`srow ${PHASE[x.phase].cls}${x === s ? ' on' : ''}`} onClick={() => setFocus(x.sessionId)}>
            <span className="swatch" style={{ background: hueOf(state, x.area) }} />
            <span className="srowtext">
              <span className="tname">{nameOf(x)}</span>
              <StateLine s={x} state={state} now={now} />
            </span>
          </button>
        ))}
      </aside>

      <section className="sdetail">
        <header className="shead">
          <span className="swatch lg" style={{ background: hueOf(state, s.area) }} />
          <div>
            <h1>{nameOf(s)}</h1>
            <p className="mono muted">
              {s.project} · {s.host === 'vscode' ? 'VS Code or Cursor' : s.host === 'terminal' ? 'Terminal' : s.host === 'none' ? 'no window' : 'Claude'}
              {s.pid ? ` · pid ${s.pid}` : ''}
            </p>
          </div>
          <span className={`pill ${PHASE[s.phase].cls}`}>{PHASE[s.phase].label}</span>
        </header>

        <article className={`said ${PHASE[s.phase].cls}`}>
          <span className="eyebrow">{s.phase === 'working' || s.phase === 'blocked' ? `Now: ${s.tool ?? 'working'}` : 'Claude said'}</span>
          <p>{s.text || 'Nothing yet.'}</p>
        </article>

        <div className="replyarea">
          {terminal ? (
            <>
              <div className="quick">
                {QUICK_REPLIES.map((q, i) => (
                  <button key={q} className={i === 0 ? 'primary' : 'soft'} onClick={() => reply(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <label htmlFor="reply-text" className="muted">
                Or type your own
              </label>
              <div className="typed">
                <textarea id="reply-text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Commit it, then start the next step" />
                <button className="primary" disabled={!draft.trim()} onClick={() => reply(draft.trim())}>
                  Send
                </button>
              </div>
              <p className="hint">A reply brings the window to the front, pastes the text and presses Enter.</p>
            </>
          ) : s.host === 'none' ? (
            <p className="hint box">
              Nothing on the PC holds this session. Send it to your phone and reply from the Claude app, or resume it in a new terminal and reply there.
            </p>
          ) : (
            <p className="hint box">
              This session runs in an editor. The deck can bring the right window forward, but it can't be sure the Claude box has the cursor, so replies from
              the tablet only go to terminal sessions.
            </p>
          )}
        </div>

        <div className="sactions">
          <button
            className="soft"
            onClick={() =>
              run(
                act('/deck/session/phone', { sessionId: s.sessionId }),
                s.host === 'none' ? `Sent ${nameOf(s)} to your phone. Open the Claude app.` : `Typed /remote-control into ${nameOf(s)}`
              )
            }
          >
            <Icon name="phone" size={20} /> Send to phone
          </button>
          {s.host !== 'none' && (
            <button className="soft" onClick={() => run(act('/deck/session/focus', { sessionId: s.sessionId }), `Brought ${nameOf(s)} to the front`)}>
              <Icon name="window" size={20} /> Bring to front
            </button>
          )}
          <button className="soft" onClick={() => run(act('/deck/session/resume', { sessionId: s.sessionId }), `Opened ${nameOf(s)} in a new terminal`)}>
            <Icon name="resume" size={20} /> Resume in a new terminal
          </button>
        </div>
      </section>
    </div>
  );
}
