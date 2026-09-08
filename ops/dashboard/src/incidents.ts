import { Store } from '../../../src/store.js';
import { categorise, type Category } from '../../../src/metrics.js';

/**
 * THE INCIDENT WALL — evidence, rendered so it can be shown to anyone.
 *
 * ============================================================================================
 * SANITISED BY CONSTRUCTION, NOT BY REDACTION
 * ============================================================================================
 * The absolute rule is that nothing identifying appears here: no file path, no project name, no
 * hostname, no username, no command, no code — from this machine or anyone else's.
 *
 * A redaction approach would take the incident's real text and strip the dangerous parts. That
 * is the wrong shape, and this repository has already been bitten by it twice: `redact()` missed
 * a whole Google key format (D-093), and every "scan for the bad pattern" control here has needed
 * narrowing at least once. A stripper you have to keep teaching is a stripper that is wrong
 * between lessons.
 *
 * So no incident text is ever passed through. Each incident is reduced to a CATEGORY — a value
 * from a closed set this project defined — and the sentence shown is a constant looked up from
 * that category. The only variable data that reaches the page is a timestamp and an integer.
 * There is no code path from `incident.target`, `incident.attempted`, `incident.cwd`, or
 * `incident.rule` to the rendered output, which is what `tests/dashboard-web.test.ts` asserts by
 * stuffing every one of those fields with paths, keys and hostnames and checking the output.
 */

export interface WallEntry {
  /** ISO timestamp. The only per-incident datum that is not a constant. */
  at: string;
  /** Plain English, from a fixed table. Never derived from the incident's text. */
  what: string;
  /** Why it was stopped, from the same fixed table. */
  why: string;
  /** 'blocked' or 'warned' — the two things usewarden does. */
  action: 'blocked' | 'warned';
}

/**
 * The whole vocabulary. Written for someone non-technical: what the agent tried, in one line,
 * with no jargon and nothing that could identify a project or a person.
 */
const SENTENCES: Record<Category, { what: string; why: string }> = {
  credential_exposure: {
    what: 'An AI agent tried to read a file of passwords and API keys',
    why: 'Credentials must never enter a model\'s context — once read, they are effectively published',
  },
  out_of_scope_write: {
    what: 'An AI agent tried to change a file in a different project',
    why: 'It was working in one project and reached into another one nearby',
  },
  destructive: {
    what: 'An AI agent tried to delete files or rewrite shared history',
    why: 'The action was outside the folder it was working in, and would have been hard to undo',
  },
  shell_execution: {
    what: 'An AI agent tried to download and run code from the internet',
    why: 'Nobody had read the code it was about to execute',
  },
  drift: {
    what: 'An AI agent started working on something other than what it was asked to do',
    why: 'Its actions no longer matched the goal it was given',
  },
  other: {
    what: 'An AI agent tried something the policy does not allow',
    why: 'It fell outside the rules set for this machine',
  },
};

/** Fields that must never reach the wall. Named so a test can assert on the list itself. */
export const FORBIDDEN_FIELDS = ['target', 'attempted', 'cwd', 'rule', 'title', 'reason', 'sessionId'] as const;

/**
 * Builds the wall from a store. Only `layer`, `action`, `rule` (to categorise, never to display)
 * and `ts` are read; nothing else is touched.
 */
export function wallFromStore(store: Store, limit = 8): WallEntry[] {
  return store.incidentsByOrigin('live', limit * 3)
    .filter((i) => i.severity !== 'info')
    .slice(0, limit)
    .map((i) => {
      const category = categorise(i.rule, Number(i.layer));
      const s = SENTENCES[category] ?? SENTENCES.other;
      return {
        at: new Date(Number(i.ts)).toISOString(),
        what: s.what,
        why: s.why,
        action: i.action === 'block' ? ('blocked' as const) : ('warned' as const),
      };
    });
}

/**
 * The same, from the aggregator's `/v1/stats`, when it exists. The aggregate carries only counts
 * per rule id, so the wall becomes "what has been stopped across all installs" rather than a
 * timeline — which is the correct shape: the aggregator never receives an individual incident,
 * by design, so there is nothing to show a timeline of.
 */
export function wallFromAggregate(rules: { rule: string; hits: number }[], limit = 6):
{ what: string; why: string; count: number }[] {
  const totals = new Map<Category, number>();
  for (const r of rules) {
    const c = categorise(r.rule, 1);
    totals.set(c, (totals.get(c) ?? 0) + Number(r.hits));
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([c, count]) => ({ what: SENTENCES[c].what, why: SENTENCES[c].why, count }));
}
