import { Store } from './store.js';
import { buildReceipt, recentSessionIds, type Receipt } from './receipt.js';
import { bad, dim, head, ok, warn } from './term.js';

/**
 * `usewarden week` — THE ONE COMMAND WORTH RUNNING.
 *
 * Everything usewarden knows is already in the database and nothing surfaces it. `docs/RETENTION.md`
 * §1 is the argument: a tool that never interrupts has to be worth *looking at*, and until this
 * command existed there was no reason for anyone to type `usewarden` again after `init`. The record
 * is also the only thing usewarden has that Claude Code's own deny rules and OS sandbox do not
 * (§2) — a permission denial is a moment in a transcript nobody scrolls back to; this is still
 * readable six days later.
 *
 * IT IS A PULL, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
 *
 * D-230 cut the "weekly signal" because anything that fires on a schedule is a notification whatever
 * it is called, and the session receipt already serves the moment a user looks. That reasoning is
 * not reversed here. This has no daemon, no scheduler, no mid-session output, and says nothing
 * unless it is asked. D-230's closing sentence named exactly this: "it should be pull rather than
 * push even then."
 *
 * THREE OUTCOMES, AND THEY MUST NOT LOOK ALIKE (CLAUDE.md §4.4).
 *
 *   no sessions at all     usewarden may not be running. Say that, and point at `status`. This is
 *                          the UNVERIFIED case and it must never be dressed up as a quiet week.
 *   sessions, no blocks    a genuinely quiet week. Say so plainly, without congratulating anyone.
 *   sessions with blocks   show what was caught, grouped by rule, because the rule is the part a
 *                          human can act on.
 */

export interface WeekSummary {
  days: number;
  since: number;
  sessions: number;
  events: number;
  blocked: number;
  warned: number;
  agents: string[];
  projects: string[];
  byRule: { rule: string; count: number }[];
  receipts: Receipt[];
  /** True when nothing has been recorded at all — which is a question, not a clean bill of health. */
  nothingRecorded: boolean;
}

const DAY_MS = 86_400_000;

export function buildWeek(store: Store, days: number, now: number): WeekSummary {
  const since = now - days * DAY_MS;

  // Real sessions only. A demo or fixture row in a "what did my agents do" report would be a lie
  // of exactly the kind `origin` was added to prevent (D-005 / schema v2).
  const receipts = recentSessionIds(store, 200)
    .map((id) => buildReceipt(store, id))
    .filter((r): r is Receipt => r !== null && r.origin === 'live' && r.lastActivityAt >= since)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const ids = new Set(receipts.map((r) => r.sessionId));
  const counts = new Map<string, number>();
  for (const inc of store.recentIncidents(500)) {
    if (inc.origin !== 'live' || !ids.has(inc.sessionId) || inc.ts < since) continue;
    counts.set(inc.rule, (counts.get(inc.rule) ?? 0) + 1);
  }

  return {
    days, since,
    sessions: receipts.length,
    events: receipts.reduce((n, r) => n + r.events, 0),
    blocked: receipts.reduce((n, r) => n + r.blocked, 0),
    warned: receipts.reduce((n, r) => n + r.warned, 0),
    agents: [...new Set(receipts.map((r) => r.agent))].sort(),
    projects: [...new Set(receipts.map((r) => r.cwd))].sort(),
    byRule: [...counts.entries()].map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
    receipts,
    nothingRecorded: receipts.length === 0,
  };
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function renderWeek(w: WeekSummary): string {
  const out: string[] = ['', `  ${head(`usewarden week`)}  ${dim(`the last ${w.days} days · real agent sessions only`)}`, ''];

  if (w.nothingRecorded) {
    // NOT "all clear". Zero sessions and a working guardian look identical from here, and only one
    // of them is good news. §4.4: "I could not tell" and "it is fine" are different sentences.
    out.push(`  ${warn('No agent sessions were recorded in this window.')}`);
    out.push('');
    out.push(dim('  That is not the same as "nothing happened". If you have been running agents,'));
    out.push(dim('  usewarden was not watching them. Check it is registered:'));
    out.push('');
    out.push('      usewarden status');
    out.push('');
    return out.join('\n');
  }

  const where = w.projects.length === 1 ? shortPath(w.projects[0]!) : `${w.projects.length} projects`;
  out.push(`  ${w.sessions} session${w.sessions === 1 ? '' : 's'}  ·  ${w.events.toLocaleString()} events inspected  ·  ${w.agents.join(', ')}  ·  ${where}`);
  out.push('');

  if (w.blocked === 0 && w.warned === 0) {
    out.push(`  ${ok('Nothing was blocked and nothing drifted.')}`);
    out.push(dim('  A quiet week is the normal outcome. Usewarden only speaks when asked.'));
  } else {
    out.push(`  ${bad(`${w.blocked} blocked`)}   ${w.warned} warned`);
    out.push('');
    for (const { rule, count } of w.byRule) {
      out.push(`    ${String(count).padStart(3)}  ${rule}`);
    }
    out.push('');
    out.push(dim('  usewarden incidents   the card for each one, with the exact command'));
  }

  out.push('');
  out.push(`  ${dim('sessions')}`);
  for (const r of w.receipts) {
    const mark = r.blocked > 0 ? bad('!') : r.warned > 0 ? warn('~') : dim('·');
    const caught = r.blocked > 0 || r.warned > 0 ? `${r.blocked}b ${r.warned}w` : dim('clean');
    out.push(`    ${mark} ${day(r.lastActivityAt)}  ${r.agent.padEnd(7)} ${r.sessionId.slice(0, 8)}  ${String(r.events).padStart(5)} ev  ${caught}`);
  }
  out.push('');
  out.push(`  ${dim('usewarden last <session-id>')}  the full receipt for one of them`);
  out.push('');
  return out.join('\n');
}

function shortPath(p: string): string {
  const home = process.env['HOME'];
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
