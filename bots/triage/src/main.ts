import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type GitHubApi } from './run.js';
import { buildPrompt, parseClassification, selectBotProvider } from './classify.js';
import type { Issue } from './triage.js';

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

async function main(): Promise<number> {
  const token = process.env['GITHUB_TOKEN'];
  const repo = process.env['GITHUB_REPOSITORY'];
  const issueNumber = Number(process.env['ISSUE_NUMBER']);
  if (!token || !repo || !Number.isInteger(issueNumber)) {
    process.stderr.write('triage: GITHUB_TOKEN, GITHUB_REPOSITORY and ISSUE_NUMBER are all required\n');
    return 2;
  }

  const classify = await makeClassifier();
  const outcome = await run({
    repoRoot: REPO_ROOT,
    issueNumber,
    api: gh(token, repo),
    enabledVar: process.env['TRIAGE_BOT_ENABLED'],
    log: (s) => process.stdout.write(`triage: ${s}\n`),
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
