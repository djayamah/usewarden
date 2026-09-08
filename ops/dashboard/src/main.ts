import { execFileSync } from 'node:child_process';
import { githubReadings, impactReadings, npmDownloads, type Reading } from './sources.js';
import { renderText, type DashboardData } from './render.js';

/**
 * `npm run dashboard` — the one view, and the read-only briefing.
 *
 * READ-ONLY BY CONSTRUCTION. It makes GET requests to two public APIs and, optionally, one
 * aggregator. There is no code path here that writes anything, anywhere: not to the repository,
 * not to GitHub, not to a file. It has no public surface, opens no port, and stores nothing.
 *
 * The GitHub token is optional and only widens what can be READ — without it, stars and issues
 * still work and traffic reports as unavailable with the reason. It is read from `gh` if that is
 * already authenticated, so no credential is ever pasted or stored for this.
 *
 * `--json` makes it callable by another agent, which is the briefing use case.
 */

const REPO = process.env['USEWARDEN_DASHBOARD_REPO'] ?? 'djayamah/usewarden';
const PKG = process.env['USEWARDEN_DASHBOARD_PKG'] ?? 'usewarden';
const STATS_URL = process.env['USEWARDEN_AGGREGATOR_STATS_URL'];

/** Borrows an existing `gh` login rather than asking for a token. Never prints it. */
function ghToken(): string | undefined {
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];
  try {
    const t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return t || undefined;
  } catch { return undefined; }
}

async function openIssues(repo: string, token?: string): Promise<{ number: number; title: string; labels: string[] }[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=20`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'usewarden-dashboard',
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) return [];
    const j = await res.json() as { number: number; title: string; pull_request?: unknown; labels: { name: string }[] }[];
    return j.filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, labels: (i.labels ?? []).map((l) => l.name) }));
  } catch { return []; }
}

async function main(): Promise<number> {
  const json = process.argv.includes('--json');
  const token = ghToken();

  const [impact, github, day, week, month, issues] = await Promise.all([
    impactReadings(STATS_URL),
    githubReadings(REPO, token),
    npmDownloads(PKG, 'last-day'),
    npmDownloads(PKG, 'last-week'),
    npmDownloads(PKG, 'last-month'),
    openIssues(REPO, token),
  ]);

  const data: DashboardData = {
    repo: REPO, pkg: PKG, generatedAt: new Date().toISOString(),
    impact, github, npm: [day, week, month] as Reading[], openIssueTitles: issues,
  };

  process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : renderText(data));
  return 0;
}

main().then((c) => { process.exitCode = c; }).catch((e: Error) => {
  process.stderr.write(`dashboard: ${e.message}\n`);
  process.exitCode = 1;
});
