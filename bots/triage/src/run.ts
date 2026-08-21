import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertCommentIsSafe, triage, type Issue } from './triage.js';
import { ALLOWED_LABELS } from './knowledge.js';
import { Corpus } from './corpus.js';

/**
 * The GitHub Actions entrypoint.
 *
 * Runs with a scoped `GITHUB_TOKEN` (`issues: write`, `contents: read`) from the workflow, never
 * a personal credential. Everything it is allowed to do is: read one issue, post at most one
 * comment on it, and apply labels from a fixed list.
 *
 * FOUR STOPS, checked in this order, each of which aborts before anything is written:
 *   1. KILL SWITCH  — a committed file, or a repository variable. Either one alone halts it.
 *   2. ALREADY SEEN — the bot has already commented on this issue.
 *   3. DAILY CAP    — the bot has posted its daily maximum across the repository.
 *   4. SELF         — the issue was opened by the bot, or by another bot.
 *
 * The kill switch is a FILE first and a variable second, deliberately. A repository variable is
 * faster to flip, but it lives in a settings page; a committed file is visible in a diff, shows
 * up in the repository at a glance, and can be added by anyone with push access without hunting
 * through settings. Either is sufficient on its own, because a kill switch that can itself fail
 * is not one.
 */

export const KILL_SWITCH_FILE = '.github/TRIAGE_BOT_DISABLED';
export const DAILY_COMMENT_CAP = 30;

export interface GitHubApi {
  getIssue(n: number): Promise<Issue & { labels: string[]; state: string }>;
  listIssueComments(n: number): Promise<{ user: string; isBot: boolean; body: string }[]>;
  createComment(n: number, body: string): Promise<void>;
  addLabels(n: number, labels: string[]): Promise<void>;
  /** Comments made by this bot across the repo in the last 24h, for the daily cap. */
  countRecentBotComments(): Promise<number>;
}

export interface RunOptions {
  repoRoot: string;
  issueNumber: number;
  api: GitHubApi;
  /** Value of the `TRIAGE_BOT_ENABLED` repository variable. Anything but 'true' halts. */
  enabledVar: string | undefined;
  log?: (s: string) => void;
  /** Optional model classifier for issues the deterministic pass could not match. */
  classify?: (issue: Issue) => Promise<{ labels: string[]; note: string } | null>;
}

export type RunOutcome =
  | { acted: false; reason: 'kill_switch_file' | 'kill_switch_variable' | 'already_commented'
      | 'daily_cap' | 'bot_author' | 'issue_closed' | 'empty_corpus' }
  | { acted: true; route: string; labels: string[] };

export async function run(opts: RunOptions): Promise<RunOutcome> {
  const log = opts.log ?? ((): void => { /* quiet */ });

  // 1. KILL SWITCH — both forms, either sufficient.
  if (fs.existsSync(path.join(opts.repoRoot, KILL_SWITCH_FILE))) {
    log(`halted: ${KILL_SWITCH_FILE} exists`);
    return { acted: false, reason: 'kill_switch_file' };
  }
  if (opts.enabledVar !== 'true') {
    log(`halted: TRIAGE_BOT_ENABLED is ${JSON.stringify(opts.enabledVar ?? null)}, not "true"`);
    return { acted: false, reason: 'kill_switch_variable' };
  }

  const issue = await opts.api.getIssue(opts.issueNumber);

  // 4. SELF / bot-authored, and closed issues.
  if (/\[bot\]$/.test(issue.user) || issue.user === 'github-actions') {
    log('halted: issue was opened by a bot');
    return { acted: false, reason: 'bot_author' };
  }
  if (issue.state !== 'open') {
    log('halted: issue is not open');
    return { acted: false, reason: 'issue_closed' };
  }

  // 2. ALREADY SEEN — one comment per issue, ever. A bot that comments twice is noise.
  const comments = await opts.api.listIssueComments(opts.issueNumber);
  if (comments.some((c) => c.isBot && c.body.includes('Automated triage'))) {
    log('halted: already commented on this issue');
    return { acted: false, reason: 'already_commented' };
  }

  // 3. DAILY CAP — a broken trigger or an issue import must not turn into thirty notifications.
  const recent = await opts.api.countRecentBotComments();
  if (recent >= DAILY_COMMENT_CAP) {
    log(`halted: daily cap reached (${recent}/${DAILY_COMMENT_CAP})`);
    return { acted: false, reason: 'daily_cap' };
  }

  // BUILD THE CORPUS FROM THE CHECKOUT, and pass it. This line is the whole of defect D-164:
  // it read `triage(issue)`, the corpus argument was optional, and the production bot therefore
  // ran with no documents and declined every answerable question in public.
  //
  // The corpus is built here rather than in triage() on purpose - triage() is pure and testable,
  // and reading the filesystem inside it would make every test touch the disk. What changed is
  // that omitting it is now impossible: the parameter is required.
  const corpus = new Corpus(opts.repoRoot);
  if (corpus.size === 0) {
    // A corpus that loaded nothing is the same failure wearing a different hat: the bot would
    // decline everything and blame the documentation. Refuse to comment at all rather than post
    // a confident "the docs do not cover this" from a bot that read no docs.
    log(`halted: corpus is empty at ${opts.repoRoot} - refusing to answer from nothing`);
    return { acted: false, reason: 'empty_corpus' };
  }
  log(`corpus: ${corpus.size} chunk(s) from ${opts.repoRoot}`);

  const result = triage(issue, corpus);
  let comment = result.comment;
  let labels = [...result.labels];

  // OPTIONAL model pass — only for issues the deterministic pass could not place, mirroring the
  // product's own ordering: deterministic first and free, model second and sampled.
  if (result.needsClassifier && opts.classify) {
    try {
      const extra = await opts.classify(issue);
      if (extra) {
        labels = [...new Set([...labels, ...extra.labels])].filter((l) => ALLOWED_LABELS.includes(l));
        comment = comment.replace('---\n_🤖 Automated triage',
          `${extra.note}\n\n---\n_🤖 Automated triage`);
      }
    } catch (e) {
      // A classifier failure must never stop the deterministic comment from going out.
      log(`classifier failed, continuing without it: ${(e as Error).message}`);
    }
  }

  // Final guard. Throwing here fails the workflow loudly rather than posting something wrong.
  assertCommentIsSafe(comment);
  const disallowed = labels.filter((l) => !ALLOWED_LABELS.includes(l));
  if (disallowed.length > 0) throw new Error(`triage bot refused to apply labels: ${disallowed.join(', ')}`);

  await opts.api.createComment(opts.issueNumber, comment);
  if (labels.length > 0) await opts.api.addLabels(opts.issueNumber, labels);

  log(`commented on #${opts.issueNumber}: route=${result.route} labels=${labels.join(',') || '(none)'}`);
  return { acted: true, route: result.route, labels };
}
