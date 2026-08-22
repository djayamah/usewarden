import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type GitHubApi } from './run.js';
import { buildPrompt, parseClassification, selectBotProvider } from './classify.js';
import type { Issue } from './triage.js';
import { parseSurfaces, surfaceFromEvent } from './surface.js';
import { discussionApi, makeGraphQLClient } from './discussions.js';

/**
 * Thin GitHub Actions wrapper. All decisions live in `triage.ts` and `run.ts`, which are pure and
 * tested; this file only turns environment variables into an API client and prints the outcome.
 *
 * It exits 0 on every non-action outcome — a kill switch, a daily cap, an already-triaged issue
 * are all normal. It exits non-zero only when the bot refused to post something it considered
 * unsafe, because that is a bug in the bot and should be loud.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const API = 'https://api.github.com';

function gh(token: string, repo: string): GitHubApi {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'usewarden-triage-bot',
  };
  const req = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${API}${url}`, {
      method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} -> ${res.status}`);
    return res.status === 204 ? null : await res.json();
  };

  return {
    async getIssue(n) {
      const j = await req('GET', `/repos/${repo}/issues/${n}`) as {
        number: number; title: string; body: string | null; state: string;
        user: { login: string }; labels: { name: string }[];
      };
      return {
        number: j.number, title: j.title ?? '', body: j.body ?? '', user: j.user?.login ?? '',
        state: j.state, labels: (j.labels ?? []).map((l) => l.name),
      };
    },
    async listIssueComments(n) {
      const j = await req('GET', `/repos/${repo}/issues/${n}/comments?per_page=100`) as
        { user: { login: string; type: string }; body: string | null }[];
      return j.map((c) => ({
        user: c.user?.login ?? '', isBot: c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? ''),
        body: c.body ?? '',
      }));
    },
    async createComment(n, body) { await req('POST', `/repos/${repo}/issues/${n}/comments`, { body }); },
    async addLabels(n, labels) { await req('POST', `/repos/${repo}/issues/${n}/labels`, { labels }); },
    async countRecentBotComments() {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const j = await req('GET', `/repos/${repo}/issues/comments?since=${since}&per_page=100`) as
        { user: { type: string }; body: string | null }[];
      return j.filter((c) => c.user?.type === 'Bot' && (c.body ?? '').includes('Automated triage')).length;
    },
  };
}

/** The optional model pass. Returns null unless a bot key is configured. */
async function makeClassifier(): Promise<((issue: Issue) => Promise<{ labels: string[]; note: string } | null>) | undefined> {
  const cfg = selectBotProvider();
  if (!cfg) return undefined;
  const { callBotProvider } = await import('./transport.js');
  return async (issue: Issue) => {
    const raw = await callBotProvider(cfg, buildPrompt(issue));
    return parseClassification(raw);
  };
}

/**
 * Read the Actions event payload for the two facts the conversation guard needs and the workflow
 * cannot pass as a scalar: WHO triggered this, and whether an `issue_comment` is really a PR.
 *
 * Missing or unreadable payload is not an error — it means `issues: opened`, where the triggering
 * author is the issue author and `run.ts` derives it. Anything this cannot read stays undefined so
 * the caller falls back rather than guessing.
 */
function readEventPayload(): { actor?: string; actorIsBot?: boolean; isPullRequest: boolean } {
  const p = process.env['GITHUB_EVENT_PATH'];
  if (!p || !fs.existsSync(p)) return { isPullRequest: false };
  try {
    const e = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      comment?: { user?: { login?: string; type?: string } };
      discussion?: { user?: { login?: string; type?: string } };
      issue?: { pull_request?: unknown };
    };
    // On a comment event the author of the COMMENT is who we would be replying to. On a discussion
    // opened event there is no comment, so it is the discussion's author.
    const u = e.comment?.user ?? e.discussion?.user;
    const login = u?.login;
    return {
      ...(login ? { actor: login } : {}),
      ...(u ? { actorIsBot: u.type === 'Bot' || /\[bot\]$/.test(login ?? '') } : {}),
      isPullRequest: e.issue?.pull_request != null,
    };
  } catch {
    // A payload we cannot parse tells us nothing. Returning "not a PR, no actor" makes the caller
    // fall back to the issue author, and the conversation guard refuses an empty author anyway.
    return { isPullRequest: false };
  }
}

async function main(): Promise<number> {
  const token = process.env['GITHUB_TOKEN'];
  const repo = process.env['GITHUB_REPOSITORY'];
  const issueNumber = Number(process.env['ISSUE_NUMBER']);
  if (!token || !repo || !Number.isInteger(issueNumber)) {
    process.stderr.write('triage: GITHUB_TOKEN, GITHUB_REPOSITORY and ISSUE_NUMBER are all required\n');
    return 2;
  }

  const log = (s: string): void => { process.stdout.write(`triage: ${s}\n`); };

  // WHICH SURFACE. An event this has no mapping for is not one to improvise on.
  const payload = readEventPayload();
  const eventName = process.env['GITHUB_EVENT_NAME'] ?? 'issues';
  const surface = surfaceFromEvent(eventName, payload.isPullRequest);
  if (!surface) {
    log(`no surface for event ${eventName} - nothing to do`);
    return 0;
  }

  const { surfaces, unknown } = parseSurfaces(process.env['TRIAGE_BOT_SURFACES']);
  // A misconfigured surface name is reported loudly. Silently ignoring it is how someone believes
  // they enabled something they did not.
  if (unknown.length > 0) log(`ignoring unknown surface name(s) in TRIAGE_BOT_SURFACES: ${unknown.join(', ')}`);

  const maintainers = (process.env['TRIAGE_BOT_MAINTAINERS'] ?? '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const rest = gh(token, repo);
  const onDiscussion = surface === 'discussion' || surface === 'discussion_comment';
  const api = onDiscussion
    ? discussionApi(makeGraphQLClient(token), repo, rest.countRecentBotComments.bind(rest), log)
    : rest;

  const classify = await makeClassifier();
  const outcome = await run({
    repoRoot: REPO_ROOT,
    issueNumber,
    api,
    enabledVar: process.env['TRIAGE_BOT_ENABLED'],
    enabledSurfaces: surfaces,
    maintainers,
    event: {
      surface,
      // OMITTED on `issues: opened` so run.ts uses the issue author - there is no comment to have
      // an author. On every OTHER surface the commenter is who we would be replying to, and an
      // actor we could not read is passed through as empty ON PURPOSE: the conversation guard
      // refuses an unnamed author, and falling back to the issue author there would let a comment
      // be judged against the wrong person's history on the thread.
      ...(surface === 'issue' ? {} : { triggeredBy: payload.actor ?? '' }),
      triggeredByIsBot: payload.actorIsBot ?? false,
    },
    log,
    ...(classify ? { classify } : {}),
  });

  process.stdout.write(`triage: ${JSON.stringify(outcome)}\n`);
  return 0;
}

main().then((c) => { process.exitCode = c; }).catch((e: Error) => {
  // A refusal is a bug in the bot and must be loud. Never post-and-hope.
  process.stderr.write(`triage: FAILED - ${e.message}\n`);
  process.exitCode = 1;
});
