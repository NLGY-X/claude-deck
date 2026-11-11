// "So far today" on the Now and Day screens: what the day produced, from
// things that can be counted. No hours saved and no money: those would be a
// guess at how long you would have taken, multiplied by a rate.
//
//   done      day-list items ticked today, waiting-on items closed included
//   commits   commits you authored since local midnight, on any local or
//             remote branch, in the repos deck.config.jsonc lists under
//             report.repos
//
// Commits cost two git calls per repo, so CommitCounter counts them every five
// minutes in the background and the 2 s poll reads the last count.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ymd, type DayView } from './day.ts';

export interface RepoCommits {
  repo: string;
  count: number;
  /** newest first */
  subjects: string[];
}

export interface CommitCount {
  at: number;
  repos: RepoCommits[];
  /** repos git could not read, by folder name */
  failed: string[];
}

export interface ReportView {
  /** titles ticked today */
  done: string[];
  /** null until the first count of the day finishes */
  commits: CommitCount | null;
}

export const midnight = (now: number): number => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Each configured path that is a repo, or, for a folder that is not, each
 *  repo directly inside it: `~/code` counts every project under it. */
export function gitRepos(paths: string[]): string[] {
  const out = new Map<string, string>();
  const isRepo = (p: string): boolean => existsSync(join(p, '.git'));
  for (const p of paths) {
    if (isRepo(p)) out.set(p.toLowerCase(), p);
    else if (existsSync(p)) {
      try {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const child = join(p, e.name);
          if (e.isDirectory() && isRepo(child)) out.set(child.toLowerCase(), child);
        }
      } catch {
        /* unreadable folder: nothing to count */
      }
    }
  }
  return [...out.values()];
}

const git = (repo: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out)))
  );

/** `%H<tab>%s` lines to subjects, one per commit. */
export function parseCommits(raw: string): string[] {
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const sha = line.slice(0, tab);
    if (seen.has(sha)) continue;
    seen.add(sha);
    subjects.push(line.slice(tab + 1));
  }
  return subjects;
}

/**
 * Subjects of the commits this repo's own user.email authored since `since`.
 * Branches and remotes, not --all: --all takes in refs/stash, and every stash
 * is a commit you authored. A repo with no user.email counts nothing rather
 * than everyone's commits.
 */
export async function commitsSince(repo: string, since: number): Promise<string[]> {
  const email = (await git(repo, ['config', 'user.email']).catch(() => '')).trim();
  if (!email) return [];
  const author = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = await git(repo, ['log', '--branches', '--remotes', `--since=${new Date(since).toISOString()}`, `--author=${author}`, '--format=%H%x09%s']);
  return parseCommits(out);
}

export class CommitCounter {
  private last: (CommitCount & { day: string }) | null = null;
  private busy = false;
  private repos: () => string[];
  private now: () => number;
  private every: number;
  private count: (repo: string, since: number) => Promise<string[]>;

  constructor(repos: () => string[], opts: { now?: () => number; every?: number; count?: (repo: string, since: number) => Promise<string[]> } = {}) {
    this.repos = repos;
    this.now = opts.now ?? Date.now;
    this.every = opts.every ?? 5 * 60_000;
    this.count = opts.count ?? commitsSince;
  }

  /** Today's last count, starting a new one when it is stale. Never waits,
   *  and never hands yesterday's count back as today's. */
  get(): CommitCount | null {
    const t = this.now();
    const today = ymd(new Date(t));
    if (!this.busy && (!this.last || this.last.day !== today || t - this.last.at > this.every)) void this.refresh();
    if (!this.last || this.last.day !== today) return null;
    const { day: _day, ...count } = this.last;
    return count;
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const t = this.now();
      const since = midnight(t);
      const repos: RepoCommits[] = [];
      const failed: string[] = [];
      await Promise.all(
        this.repos().map(async (path) => {
          try {
            const subjects = await this.count(path, since);
            if (subjects.length) repos.push({ repo: basename(path), count: subjects.length, subjects });
          } catch {
            failed.push(basename(path));
          }
        })
      );
      repos.sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
      this.last = { day: ymd(new Date(t)), at: t, repos, failed: failed.sort() };
    } finally {
      this.busy = false;
    }
  }
}

export function buildReport(day: DayView, commits: CommitCount | null): ReportView {
  return { done: day.doneToday, commits };
}
