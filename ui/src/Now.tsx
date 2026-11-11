// Now: the landing. Left, everything that waits on you as one ranked list
// with an area filter; right, today's picks, the sessions at work, and the
// player. With nothing waiting: the Calm face.

import { useEffect, useState } from 'react';
import type { Card } from '../../server/cards.ts';
import type { DayRow } from '../../server/day.ts';
import { act, ageShort, useNow, type DeckState } from './api.ts';
import { useLink, useRun, type Nav } from './App.tsx';
import { HandBack, SettledLine, useSettled } from './Cards.tsx';
import { Icon } from './icons.tsx';
import { AreaSwitch, Art, Clock, LimitChip, MiniPlayer, PHONE, Transport, areaChips, hueOf, nameOf, pickMedia, sourceName, useArea, useMedia } from './parts.tsx';
import { ReportSheet, SoFar } from './Report.tsx';
import { Resolve } from './Resolve.tsx';

/** The phone's header dot: the rail is a bottom bar there, so the link's
 *  state moves up beside the clock, and says Tailscale when that is the road. */
function PhoneLink() {
  const link = useLink();
  const tailscale = /^100\.|\.ts\.net$/.test(location.hostname);
  return (
    <span className={`phonelink push ${link}`} title={link === 'live' ? 'Connected to the PC' : 'Reconnecting to the PC'}>
      <span className="linkdot" />
      {link === 'live' ? 'PC' : link === 'lost' ? 'Lost' : '...'}
      {tailscale ? ' · Tailscale' : ''}
    </span>
  );
}

export function Now({ state, nav, wanted = null, onWanted }: { state: DeckState; nav: Nav; wanted?: string | null; onWanted?: () => void }) {
  const now = useNow(15_000);
  const phone = useMedia(PHONE);
  const [area, setArea] = useArea();
  const [open, setOpen] = useState<string | null>(null);
  // A push said which card: open it when the list has it, and only once.
  useEffect(() => {
    if (!wanted) return;
    if (state.cards.some((c) => c.id === wanted)) {
      setOpen(wanted);
      onWanted?.();
    }
  }, [wanted, state.cards, onWanted]);
  const [report, setReport] = useState(false);
  const { settled, settle, clear } = useSettled();

  const chips = areaChips(state, state.cards.map((c) => c.area));
  const filter = area && chips.some((c) => c.id === area) ? area : null;
  const cards = filter ? state.cards.filter((c) => c.area === filter) : state.cards;
  // The list to draw: live cards, with each settled card's green line put
  // back at the index its card had, so the list does not jump under a hand
  // that is about to tap Undo.
  type Row = { kind: 'card'; card: Card } | { kind: 'settled'; id: string };
  const rows: Row[] = cards.filter((c) => !settled.has(c.id)).map((c) => ({ kind: 'card', card: c }));
  for (const [id, s] of [...settled].sort((a, b) => a[1].index - b[1].index)) {
    if (filter && s.card.area !== filter) continue;
    rows.splice(Math.min(s.index, rows.length), 0, { kind: 'settled', id });
  }
  const opened = open ? state.cards.find((c) => c.id === open) : null;
  const oldest = cards.length ? Math.max(...cards.map((c) => c.waitedMs)) : 0;
  // The phone has room for one pill: it walks All, then each area, round again.
  const cycle = (): void => {
    const ids: (string | null)[] = [null, ...chips.map((c) => c.id)];
    setArea(ids[(ids.indexOf(filter) + 1) % ids.length]);
  };
  const filterChip = filter ? chips.find((c) => c.id === filter) : null;

  if (state.cards.length === 0 && settled.size === 0) return <Calm state={state} now={now} nav={nav} phone={phone} />;

  return (
    <div className="now">
      <header className="ntop">
        <Clock now={now} />
        {phone ? (
          <PhoneLink />
        ) : (
          <div className="chips push">
            {state.report && <SoFar report={state.report} onOpen={() => setReport(true)} />}
            <LimitChip limits={state.claude} now={now} />
          </div>
        )}
      </header>

      {state.errors.length > 0 && <p className="errors">{state.errors[0]}</p>}

      <div className="nbody">
        <section className="nlist" aria-label="Needs you">
          <div className="nhead">
            <h1>Needs you</h1>
            <span className="mono muted">
              {cards.length}
              {oldest > 0 && <span className="nold"> · oldest {ageShort(oldest)}</span>}
            </span>
            {chips.length > 1 && phone && (
              <button className="vcycle push" onClick={cycle} aria-label={`Area: ${filterChip?.label ?? 'all'}. Tap for the next`}>
                {filterChip && <span className="vdot" style={{ background: filterChip.hue }} />}
                {filterChip?.label ?? 'All areas'}
              </button>
            )}
            {chips.length > 1 && !phone && (
              <div className="push">
                <AreaSwitch chips={chips} value={area} onChange={setArea} />
              </div>
            )}
          </div>
          <div className="ncards">
            {rows.map((r, i) =>
              r.kind === 'card' ? (
                <HandBack key={r.card.id} card={r.card} top={i === 0} now={now} onSettle={(said, undo) => settle(r.card, said, undo, i)} onOpen={() => setOpen(r.card.id)} />
              ) : (
                <SettledLine key={r.id} s={settled.get(r.id)!} onUndone={() => clear(r.id)} />
              )
            )}
            {rows.length === 0 && <p className="hint box">Nothing for {chips.find((c) => c.id === filter)?.label ?? 'this area'}. The other areas have {state.cards.length}.</p>}
          </div>
        </section>

        <aside className="nside">
          <TodayBox state={state} nav={nav} />
          <Working state={state} nav={nav} />
          <MiniPlayer state={state} onOpen={() => nav.go('media')} />
        </aside>
      </div>

      {opened && <Resolve card={opened} state={state} onClose={() => setOpen(null)} onSettle={(said, undo) => settle(opened, said, undo, rows.findIndex((r) => r.kind === 'card' && r.card.id === opened.id))} />}
      {report && state.report && <ReportSheet report={state.report} state={state} now={now} onClose={() => setReport(false)} />}
    </div>
  );
}

/** Today's picks from the day list, ticked from here. */
function TodayBox({ state, nav }: { state: DeckState; nav: Nav }) {
  const run = useRun();
  const picked = state.day?.picked ?? [];
  return (
    <section className="nbox" aria-label="Today">
      <div className="nboxhead">
        <h2>Today</h2>
        <span className="mono muted push">{state.day ? `${picked.filter((r) => r.done).length} of ${picked.length} done` : 'no day list'}</span>
      </div>
      {picked.map((r) => (
        <div key={r.id} className={`calmrow${r.done ? ' done' : ''}`}>
          <button className="tick sm" aria-label={r.done ? `Mark ${r.title} not done` : `Mark ${r.title} done`} onClick={() => run(act('/deck/day', { op: r.done ? 'undone' : 'done', id: r.id }), r.done ? 'Not done' : 'Done')}>
            {r.done && <Icon name="check" size={14} stroke={3} />}
          </button>
          <span className="vdot" style={{ background: r.color }} />
          <span className="calmtitle">{r.title}</span>
        </div>
      ))}
      {state.day && picked.length === 0 && (
        <p className="muted" role="button" onClick={() => nav.go('day')}>
          Nothing picked yet. Day has {state.day.shortlist.length} on the shortlist.
        </p>
      )}
    </section>
  );
}

/** The sessions Claude is busy in right now: the ones that do not need you. */
function Working({ state, nav }: { state: DeckState; nav: Nav }) {
  const busy = state.sessions.filter((s) => s.phase === 'working' || s.phase === 'blocked');
  return (
    <section className="nbox" aria-label="Working">
      <div className="nboxhead">
        <h2>Working</h2>
        <span className="mono muted push">
          {busy.length} session{busy.length === 1 ? '' : 's'}
        </span>
      </div>
      {busy.slice(0, 4).map((s) => (
        <button key={s.sessionId} className="nrun" onClick={() => nav.go('sessions', s.sessionId)}>
          <div className="nrunrow">
            <span className="vdot" style={{ background: hueOf(state, s.area) }} />
            <span className="nruntitle">{nameOf(s)}</span>
            <span className="mono muted">{s.phase === 'blocked' ? 'tool waiting' : (s.tool ?? 'working')}</span>
          </div>
          <div className="sweepbar">
            <span style={{ background: hueOf(state, s.area) }} />
          </div>
        </button>
      ))}
      {busy.length > 4 && <p className="muted">and {busy.length - 4} more under Sessions</p>}
      {busy.length === 0 && <p className="muted">No session is working.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ calm

function Calm({ state, now, nav, phone }: { state: DeckState; now: number; nav: Nav; phone: boolean }) {
  const run = useRun();
  const m = pickMedia(state);
  const three = state.day?.picked ?? [];
  const working = state.sessions.filter((x) => x.phase === 'working' || x.phase === 'blocked').length;
  const word = (k: number) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][k] ?? String(k);
  const open = state.sessions.length;
  const line = working ? `${word(working)} session${working === 1 ? ' is' : 's are'} working` : `${word(open)} session${open === 1 ? '' : 's'} open, all quiet`;
  const tick = (r: DayRow) => run(act('/deck/day', { op: r.done ? 'undone' : 'done', id: r.id }), r.done ? `“${r.title.slice(0, 36)}” not done` : `Done: “${r.title.slice(0, 36)}”`);

  return (
    <div className="calm">
      <section className="calmmain">
        <div className="ntop">
          <Clock now={now} big />
          {phone && <PhoneLink />}
        </div>
        <p className="calmhead">Nothing needs you.</p>
        <p className="muted">{line}.</p>

        {three.length > 0 && (
          <div className="calmlist">
            <h2 className="eyebrow">Today's {['', 'one', 'two', 'three', 'four', 'five'][three.length] ?? three.length}</h2>
            {three.map((r) => (
              <div key={r.id} className={`calmrow${r.done ? ' done' : ''}`}>
                <button className="tick sm" aria-label={r.done ? `Mark ${r.title} not done` : `Mark ${r.title} done`} onClick={() => tick(r)}>
                  {r.done && <Icon name="check" size={14} stroke={3} />}
                </button>
                <span className="vdot" style={{ background: r.color }} />
                <span className="calmtitle">{r.title}</span>
              </div>
            ))}
          </div>
        )}
        {three.length === 0 && state.day && (
          <p className="hint box" onClick={() => nav.go('day')} role="button">
            Nothing picked for today. Day has {state.day.shortlist.length} on the shortlist.
          </p>
        )}

        <div className="calmfoot">
          <div className="calmnext">
            <span className="eyebrow">So far today</span>
            {state.report ? (
              <span>
                {state.report.done.length} done
                {state.report.commits ? ` · ${state.report.commits.repos.reduce((n, r) => n + r.count, 0)} commits` : ''}
              </span>
            ) : (
              <span className="muted">no day list</span>
            )}
          </div>
          <div className="chips push">
            <LimitChip limits={state.claude} now={now} />
          </div>
        </div>
      </section>

      <section className="calmplayer" aria-label="Now playing">
        <Art m={m} className="calmart" />
        <div>
          <p className="track">{m?.title || 'Nothing playing'}</p>
          <p className="muted">{m ? [m.artist, m.album].filter(Boolean).join(' · ') : 'Spotify or a video on the PC appears here'}</p>
        </div>
        {m && (
          <div className="progress">
            <div className="bar">
              <span style={{ width: m.duration && m.position ? `${(Math.min(m.duration, m.position + (m.status === 'Playing' ? (now - m.updatedAt) / 1000 : 0)) / m.duration) * 100}%` : '0%' }} />
            </div>
          </div>
        )}
        {m ? <Transport m={m} /> : <span />}
        <button className="hbbtn quiet" onClick={() => nav.go('media')}>
          {m ? sourceName(m.app) : 'Media'} <Icon name="right" size={16} />
        </button>
      </section>
    </div>
  );
}
