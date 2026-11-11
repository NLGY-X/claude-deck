// "So far today": a chip in a header, a sheet when tapped. Counts only:
// ticks and commits. No hours saved, no money (server/report.ts).

import type { ReportView } from '../../server/report.ts';
import type { DeckState } from './api.ts';
import { useBackClose } from './back.ts';
import { LimitChips } from './parts.tsx';

const commitTotal = (r: ReportView): number | null => (r.commits ? r.commits.repos.reduce((n, x) => n + x.count, 0) : null);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function SoFar({ report, onOpen }: { report: ReportView; onOpen: () => void }) {
  const commits = commitTotal(report);
  return (
    <button className="chip tsofar" onClick={onOpen} aria-label="So far today">
      So far
      <b>{report.done.length} done</b>
      <b>{commits === null ? 'commits ?' : plural(commits, 'commit')}</b>
    </button>
  );
}

const MAX_LINES = 8;

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="treplines">
      {lines.slice(0, MAX_LINES).map((l, i) => (
        <li key={i}>{l}</li>
      ))}
      {lines.length > MAX_LINES && <li className="muted">and {lines.length - MAX_LINES} more</li>}
    </ul>
  );
}

export function ReportSheet({ report, state, now, onClose }: { report: ReportView; state: DeckState; now: number; onClose: () => void }) {
  useBackClose(onClose);
  const c = report.commits;
  const total = commitTotal(report);
  const at = c ? new Date(c.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="tsheet" role="dialog" aria-label="So far today" onClick={onClose}>
      <div className="tsheetcard card treport" onClick={(e) => e.stopPropagation()}>
        <p className="tsheettitle">So far today</p>

        <section>
          <span className="eyebrow">Ticked off the list · {report.done.length}</span>
          {report.done.length ? <Lines lines={report.done} /> : <p className="muted">Nothing ticked yet.</p>}
        </section>

        <section>
          <span className="eyebrow">Commits · {total ?? 'counting'}</span>
          {!c && <p className="muted">The first count of the day hasn't finished.</p>}
          {c && c.repos.length === 0 && <p className="muted">None since midnight.</p>}
          {c?.repos.map((r) => (
            <div key={r.repo} className="treprepo">
              <span className="mono">{r.repo}</span>
              <b>{r.count}</b>
              <span className="muted">{r.subjects[0]}</span>
            </div>
          ))}
          {c && c.failed.length > 0 && <p className="amber">Couldn't read: {c.failed.join(', ')}</p>}
        </section>

        <section>
          <span className="eyebrow">Claude limits</span>
          <div className="chips">
            <LimitChips limits={state.claude} now={now} />
          </div>
        </section>

        <p className="hint">
          Commits you authored since midnight on any branch, in the repos deck.config.jsonc lists under report.repos{at ? `. Counted at ${at}, every five minutes` : ''}.
        </p>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
