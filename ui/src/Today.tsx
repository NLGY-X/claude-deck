// Day: the list drawn from server/day.ts, picked from with a tap. Today
// holds a handful, the shortlist shows each item's first sentence, and
// Waiting on is a column with ages, amber at five days.

import { useState } from 'react';
import type { DayRow, DayView } from '../../server/day.ts';
import { act, useNow, type DeckState } from './api.ts';
import { useRun, type Nav } from './App.tsx';
import { useBackClose } from './back.ts';
import { Icon } from './icons.tsx';
import { Clock, firstSentence } from './parts.tsx';
import { ReportSheet, SoFar } from './Report.tsx';

const op = (body: Record<string, unknown>) => act('/deck/day', body);
/** The toast doubles as the double-tap guard, so it names the item. */
const quote = (t: string): string => `“${t.length > 38 ? t.slice(0, 36) + '…' : t}”`;
const AMBER_DAYS = 5;

type Held = { row: DayRow; kind: 'short' | 'waiting' };

export function Today({ state, nav }: { state: DeckState; nav: Nav }) {
  const day = state.day;
  const now = useNow(15_000);
  const [held, setHeld] = useState<Held | null>(null);
  const [report, setReport] = useState(false);
  if (!day) {
    return (
      <div className="waiting">
        <p className="big">No day list yet</p>
        <p className="muted">Add a "day" block to deck.config.jsonc.</p>
      </div>
    );
  }
  const full = day.picked.length >= day.maxPicked;
  const doneCount = day.picked.filter((r) => r.done).length;
  const slotsLeft = Math.max(0, day.maxPicked - day.picked.length);
  const overdue = day.shortlist.filter((r) => /^Overdue/.test(r.meta)).length;

  return (
    <div className="today">
      <header className="ttop">
        <Clock now={now} />
        <div className="chips">
          {day.chips.map((c) => (
            <span key={c.label} className="chip">
              <span className="vdot" style={{ background: c.color }} />
              {c.label} <b className="muted">{c.strong}</b>
            </span>
          ))}
        </div>
        <div className="chips push">
          {state.report && <SoFar report={state.report} onOpen={() => setReport(true)} />}
          <button className="primary tadd" onClick={() => nav.jot('soon')}>
            <Icon name="plus" size={20} stroke={2.4} /> Add
          </button>
        </div>
      </header>

      <div className="tbody">
        <section className="tpanel" aria-label="Today">
          <div className="thead">
            <h1>Today</h1>
            <span className="label">
              {doneCount} done · {day.picked.length} of {day.maxPicked} picked
            </span>
          </div>
          {day.picked.map((r) => (
            <PickedRow key={r.id} r={r} />
          ))}
          {slotsLeft > 0 && (
            <p className="tslots">
              {slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left · {day.shortlist.length ? 'tap a shortlist card to add it' : 'add something with the button above'}
            </p>
          )}
        </section>

        <section className="tpanel" aria-label="Shortlist">
          <div className="thead">
            <h2>Shortlist</h2>
            <span className="label">
              {day.shortlist.length} open{overdue ? ` · ${overdue} overdue` : ''}
            </span>
          </div>
          <div className="tcards">
            {day.shortlist.map((r) => (
              <ShortRow key={r.id} r={r} full={full} onOpen={() => setHeld({ row: r, kind: 'short' })} />
            ))}
            {day.shortlist.length === 0 && <p className="hint box">Nothing open. Add something here, or ask any Claude session to add a line to {day.list}.</p>}
          </div>
          <p className="tfoot">Tap a card to read all of it, put it off or drop it · + adds it to Today</p>
        </section>

        <section className="twaitcol" aria-label="Waiting on">
          <div className="thead">
            <h2>Waiting on</h2>
            <span className="mono muted">{day.waiting.length}</span>
          </div>
          <div className="twaitcards">
            {day.waiting.map((r) => (
              <WaitCard key={r.id} r={r} onOpen={() => setHeld({ row: r, kind: 'waiting' })} />
            ))}
            {day.waiting.length === 0 && <p className="muted">Nobody.</p>}
          </div>
          <p className="tfoot">Amber at {AMBER_DAYS} days, when a Chase card lands on Now</p>
        </section>
      </div>

      {held && <HoldSheet held={held} full={full} onClose={() => setHeld(null)} />}
      {report && state.report && <ReportSheet report={state.report} state={state} now={now} onClose={() => setReport(false)} />}
      {day.decide.length > 0 && <Decide day={day} />}
    </div>
  );
}

// ------------------------------------------------------------------ rows

function PickedRow({ r }: { r: DayRow }) {
  const run = useRun();
  return (
    <div className={`trow${r.done ? ' done' : ''}`}>
      <button
        className="tick"
        aria-label={r.done ? `Mark ${r.title} not done` : `Mark ${r.title} done`}
        onClick={() => run(op({ op: r.done ? 'undone' : 'done', id: r.id }), r.done ? `${quote(r.title)} not done` : `Done: ${quote(r.title)}`)}
      >
        {r.done && <Icon name="check" size={22} stroke={3} />}
      </button>
      <div className="trowtext">
        <span className="tarea" style={{ color: r.color }}>
          {r.areaLabel}
          {r.carried > 0 && !r.done ? ` · carried ${r.carried} day${r.carried === 1 ? '' : 's'}` : ''}
        </span>
        <span className="ttitle">{r.title}</span>
        {r.meta && !r.done && !/^Carried/.test(r.meta) && <span className="tmeta">{r.meta}</span>}
      </div>
      {!r.done && (
        <button className="tback" aria-label={`Put ${r.title} back on the shortlist`} onClick={() => run(op({ op: 'unpick', id: r.id }), `${quote(r.title)} back on the shortlist`)}>
          <Icon name="x" size={18} />
        </button>
      )}
    </div>
  );
}

/** The first sentence, with + to pick. Tap the words to read all of it. */
function ShortRow({ r, full, onOpen }: { r: DayRow; full: boolean; onOpen: () => void }) {
  const run = useRun();
  const head = firstSentence(r.title);
  return (
    <div className={`tcard${full ? ' full' : ''}`}>
      <button className="tcardtext" onClick={onOpen} aria-label={`${r.title}, read`}>
        <span className="tcardtitle">{head}</span>
        <span className="tmeta">
          <span style={{ color: r.color }}>{r.areaLabel}</span>
          {r.meta ? ` · ${r.meta.toLowerCase()}` : ''}
          {head.length < r.title.length ? ' · more' : ''}
        </span>
      </button>
      <button className="tplus" aria-label={`Add ${r.title} to today`} disabled={full} onClick={() => run(op({ op: 'pick', id: r.id }), `On Today: ${quote(r.title)}`)}>
        <Icon name="plus" size={18} stroke={2.4} />
      </button>
    </div>
  );
}

/** Who, how long, and what: the part before the colon is who. */
function WaitCard({ r, onOpen }: { r: DayRow; onOpen: () => void }) {
  const days = r.days ?? 0;
  const colon = r.title.indexOf(':');
  const who = colon > 0 && colon < 24 ? r.title.slice(0, colon) : r.areaLabel;
  const what = colon > 0 && colon < 24 ? r.title.slice(colon + 1).trim() : r.title;
  return (
    <button className="twcard" onClick={onOpen} aria-label={r.title}>
      <span className="twline">
        <span className={`vdot ${days >= AMBER_DAYS ? 'amber' : 'cold'}`} />
        <b>{who}</b>
        <span className={`twage${days >= AMBER_DAYS ? ' amber' : ''}`}>{r.meta}</span>
      </span>
      <span className="twtext">{firstSentence(what)}</span>
    </button>
  );
}

// ------------------------------------------------------------------ sheets

function HoldSheet({ held, full, onClose }: { held: Held; full: boolean; onClose: () => void }) {
  useBackClose(onClose);
  const run = useRun();
  const { row, kind } = held;
  const go = async (body: Record<string, unknown>, ok: string) => {
    if (await run(op(body), ok)) onClose();
  };
  return (
    <div className="tsheet" role="dialog" aria-label={row.title} onClick={onClose}>
      <div className="tsheetcard card" onClick={(e) => e.stopPropagation()}>
        <span className="tarea" style={{ color: row.color }}>
          {row.areaLabel}
          {row.meta ? ` · ${row.meta}` : ''}
        </span>
        <p className="tsheettitle">{row.title}</p>
        <div className="tsheetbtns">
          {kind === 'short' ? (
            <>
              <button className="primary" disabled={full} onClick={() => go({ op: 'pick', id: row.id }, `On Today: ${quote(row.title)}`)}>
                {full ? 'Today is full' : 'On Today'}
              </button>
              <button className="soft" onClick={() => go({ op: 'tomorrow', id: row.id }, `${quote(row.title)} moved to tomorrow`)}>
                Tomorrow
              </button>
              <button className="soft" onClick={() => go({ op: 'handoff', id: row.id }, `${quote(row.title)} handed off`)}>
                Hand off
              </button>
              <button className="ghost" onClick={() => go({ op: 'drop', id: row.id }, `Dropped ${quote(row.title)}`)}>
                Drop
              </button>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => go({ op: 'done', id: row.id }, `${quote(row.title)} off the waiting list`)}>
                Got it
              </button>
              <button className="ghost" onClick={() => go({ op: 'drop', id: row.id }, `Dropped ${quote(row.title)}`)}>
                Drop
              </button>
            </>
          )}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Decide({ day }: { day: DayView }) {
  const run = useRun();
  const r = day.decide[0];
  const go = (o: string, ok: string) => run(op({ op: o, id: r.id }), ok);
  return (
    <div className="tdecide" role="dialog" aria-label={`Decide: ${r.title}`}>
      <div className="tdecidetop">
        <span className="pill blocked">Carried {r.carried} days</span>
        <span className="label">{day.decide.length === 1 ? 'one to decide' : `1 of ${day.decide.length} to decide`}</span>
      </div>
      <span className="tarea" style={{ color: r.color }}>
        {r.areaLabel}
      </span>
      <h1>{r.title}</h1>
      <p className="tdecidewhy">Picked {r.carried} days and never ticked. It stays off the shortlist until you choose.</p>
      <div className="tdecidebtns">
        <button className="tbig keep" onClick={() => go('keep', `Kept ${quote(r.title)}`)}>
          <Icon name="up" size={34} stroke={2.2} />
          <strong>Keep it</strong>
          <span>Onto Today, at the top. The count starts again.</span>
        </button>
        <button className="tbig" onClick={() => go('handoff', `${quote(r.title)} handed off`)}>
          <Icon name="right" size={34} stroke={2.2} />
          <strong>Hand it off</strong>
          <span>Moves to waiting on, so you can see who has it.</span>
        </button>
        <button className="tbig" onClick={() => go('drop', `Dropped ${quote(r.title)}`)}>
          <Icon name="x" size={34} stroke={2.2} />
          <strong>Drop it</strong>
          <span>Off the list for good, kept in the file under Dropped.</span>
        </button>
      </div>
      <div className="tdecidefoot">
        <button className="ghost" onClick={() => go('later', `Asking about ${quote(r.title)} tomorrow`)}>
          Ask me tomorrow
        </button>
        {day.decide[1] && <span className="hint">Next: {day.decide[1].title}</span>}
      </div>
    </div>
  );
}
