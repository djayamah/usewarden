import type { Store } from './store.js';
import type { AgentId, IncidentOrigin } from './types.js';
import { ok, bad, warn, dim, head, stripAnsi, wrapLine } from './term.js';
import { displayPath, ellipsis, oneLine } from './util.js';

/**
 * SESSION RECEIPTS — the artifact that exists whether or not anything fired.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS THE MOST IMPORTANT THING IN THE PRODUCT
 * ---------------------------------------------------------------------------------------------
 * Everything else usewarden does is prevention, and prevention produces no evidence when it
 * succeeds. A user whose agent never drifts sees an install, a `demo` they know is synthetic, and
 * then nothing — for days. "Nothing happened" and "this tool is not running" render identically,
 * and the second is this product's worst failure mode by its own spec (SPEC-BUILD 3B). The
 * incident card is the marketing asset; it is also, by construction, the artifact that only
 * exists on the sessions that went wrong.
 *
 * The receipt is the one that exists every time. It is what a user reads on a clean session, and
 * a clean session is the majority of them.
 *
 * ---------------------------------------------------------------------------------------------
 * THREE PROPERTIES IT MUST HAVE, AND WHY EACH ONE IS A RULE RATHER THAN A PREFERENCE
 * ---------------------------------------------------------------------------------------------
 * 1. **DERIVED BY QUERY, NEVER FROM A STORED COUNTER.** docs/METRICS.md: "Every figure is computed
 *    by query when you ask for it... It can be recomputed and corrected; a counter can only be
 *    wrong forever." `sessions.judge_calls` and `sessions.judge_cost` exist and are deliberately
 *    NOT read here.
 *
 * 2. **NEVER DEPENDENT ON A SESSION-END HOOK FIRING.** OpenCode has no session lifecycle hook at
 *    all — it exposes a TypeScript plugin whose only interception point is `tool.execute.before`
 *    (docs/HOOK-MATRIX.md). And even the five agents that document `SessionEnd` do not fire it
 *    when the process is killed, the terminal is closed, or the machine sleeps. A receipt that
 *    exists only when a hook fired is precisely the defect class this build has hit repeatedly:
 *    the drift guardian that was silently not running, the hooks that failed with EACCES while
 *    status said PROTECTED (D-012). So the boundary is DERIVED, the hook is used as evidence when
 *    it exists, and the receipt always says which of the two it used.
 *
 * 3. **NEVER EMPTY.** A session with zero blocks and zero warnings renders every field, and says
 *    in words that nothing was blocked. A count that is genuinely zero prints `0`. A value that
 *    could not be determined prints `unavailable` WITH ITS REASON and never prints `0`. "I could
 *    not tell" and "it is fine" are different sentences (CLAUDE.md §4.4).
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** How the end of the session was established. Always reported; never guessed at silently. */
export type BoundaryMethod =
  /** A real `session_end` event from the agent's own lifecycle hook. */
  | 'session-end-hook'
  /** No hook. The session had been silent longer than the idle gap, so it is treated as over. */
  | 'idle-gap'
  /** No hook, and still active within the idle gap. The receipt is a running total. */
  | 'in-progress';

/**
 * A value that may not be knowable. There is no third state where it quietly becomes zero.
 */
export type Field<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

const has = <T>(value: T): Field<T> => ({ available: true, value });
const missing = <T>(reason: string): Field<T> => ({ available: false, reason });

export interface Receipt {
  sessionId: string;
  agent: AgentId;
  origin: IncidentOrigin;
  cwd: string;
  goal: string | null;
  startedAt: number;
  endedAt: number | null;
  /**
   * The last moment this session did anything. Distinct from `endedAt`, which is null while a
   * session is still running — and `usewarden sessions` orders by THIS, so the column it prints
   * and the order it prints in are the same fact. Ordering by one and displaying the other made
   * the list look shuffled.
   */
  lastActivityAt: number;
  boundary: { method: BoundaryMethod; detail: string };
  durationMs: Field<number>;
  events: number;
  filesTouched: Field<number>;
  commandsRun: Field<number>;
  outsideScope: number;
  blocked: number;
  warned: number;
  peakContextFill: Field<number>;
  judge: Field<{ calls: number; metered: number; unmetered: number; usd: number }>;
  /** Arithmetic re-checked at read time. Non-empty means something did not add up. */
  problems: string[];
}

/** How long a session may be silent before it is considered finished, when no hook says so. */
export function idleGapMs(): number {
  const raw = Number(process.env['USEWARDEN_SESSION_IDLE_MIN']);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 30;
  return minutes * 60_000;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

interface EventRow {
  event: string; tool: string | null; target: string | null;
  ts: number | null; context_fill: number | null;
}

/**
 * Builds the receipt for one session, entirely by query.
 *
 * `now` is injected so a test can place a session in the past without sleeping, and so the
 * idle-gap branch is reachable deterministically.
 */
export function buildReceipt(store: Store, sessionId: string, now = Date.now()): Receipt | null {
  const s = store.db.prepare(
    `SELECT id, agent, cwd, origin, goal, started_at AS startedAt FROM sessions WHERE id = ?`,
  ).get(sessionId) as { id: string; agent: AgentId; cwd: string; origin: IncidentOrigin;
    goal: string | null; startedAt: number } | undefined;
  if (!s) return null;

  const rows = store.db.prepare(
    `SELECT event, tool, target, ts, context_fill FROM events WHERE session_id = ? ORDER BY ts ASC`,
  ).all(sessionId) as unknown as EventRow[];

  const problems: string[] = [];

  // --- row validation, so a corrupt row costs its OWN field and not the whole receipt ---------
  const validTs = rows.filter((r) => typeof r.ts === 'number' && Number.isFinite(r.ts) && r.ts > 0);
  const badTs = rows.length - validTs.length;
  if (badTs > 0) problems.push(`${badTs} event row(s) carry an unusable timestamp`);

  // A file tool with no target, or a bash event with no command, is a row that cannot be counted.
  const fileRows = rows.filter((r) => r.tool === 'write' || r.tool === 'edit' || r.tool === 'read' || r.tool === 'grep');
  const badFileRows = fileRows.filter((r) => r.target === null || r.target === '').length;
  const bashRows = rows.filter((r) => r.tool === 'bash');
  const badBashRows = bashRows.filter((r) => r.target === null || r.target === '').length;
  if (badFileRows > 0) problems.push(`${badFileRows} file event(s) have no recorded target`);
  if (badBashRows > 0) problems.push(`${badBashRows} command event(s) have no recorded command`);

  // --- boundary ------------------------------------------------------------------------------
  const endEvent = validTs.filter((r) => r.event === 'session_end').pop();
  const lastTs = validTs.length > 0 ? validTs[validTs.length - 1]!.ts! : null;
  const firstTs = validTs.length > 0 ? validTs[0]!.ts! : null;

  let boundary: { method: BoundaryMethod; detail: string };
  let endedAt: number | null;
  if (endEvent) {
    boundary = { method: 'session-end-hook', detail: "the agent's own session-end hook fired" };
    endedAt = endEvent.ts!;
  } else if (lastTs !== null && now - lastTs > idleGapMs()) {
    const mins = Math.round(idleGapMs() / 60_000);
    boundary = {
      method: 'idle-gap',
      detail: `no session-end hook; silent for over ${mins}m, so the last event is treated as the end`,
    };
    endedAt = lastTs;
  } else {
    boundary = { method: 'in-progress', detail: 'no session-end hook yet; this session is still active' };
    endedAt = null;
  }

  // --- duration ------------------------------------------------------------------------------
  const start = firstTs !== null ? Math.min(s.startedAt, firstTs) : s.startedAt;
  let durationMs: Field<number>;
  if (!Number.isFinite(start) || start <= 0) {
    durationMs = missing('the session has no usable start timestamp');
  } else if (badTs > 0 && endedAt === null) {
    durationMs = missing(`${badTs} event row(s) carry an unusable timestamp, so the end cannot be placed`);
  } else {
    const end = endedAt ?? now;
    durationMs = end >= start
      ? has(end - start)
      : missing('the recorded end precedes the recorded start');
  }

  // --- what the agent did --------------------------------------------------------------------
  const distinctFiles = new Set(fileRows.filter((r) => r.target).map((r) => r.target as string));
  const filesTouched: Field<number> = badFileRows > 0
    ? missing(`${badFileRows} of ${fileRows.length} file event(s) have no recorded target`)
    : has(distinctFiles.size);
  const commandsRun: Field<number> = badBashRows > 0
    ? missing(`${badBashRows} of ${bashRows.length} command event(s) have no recorded command`)
    : has(bashRows.length);

  // --- what usewarden did about it -------------------------------------------------------------
  const inc = store.db.prepare(
    `SELECT action, rule, COUNT(*) AS n FROM incidents WHERE session_id = ? GROUP BY action, rule`,
  ).all(sessionId) as { action: string; rule: string; n: number }[];
  const blocked = inc.filter((r) => r.action === 'block').reduce((a, r) => a + Number(r.n), 0);
  const warned = inc.filter((r) => r.action === 'warn').reduce((a, r) => a + Number(r.n), 0);
  const outsideScope = inc
    .filter((r) => r.rule.startsWith('scope.'))
    .reduce((a, r) => a + Number(r.n), 0);

  // --- peak context fill -----------------------------------------------------------------------
  const fills = rows.map((r) => r.context_fill)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
  const peakContextFill: Field<number> = fills.length > 0
    ? has(Math.max(...fills))
    : missing(rows.length === 0
      ? 'this session recorded no events'
      // FOUND BY THIS RECEIPT, ON ITS FIRST LIVE RUN, AND STATED EXACTLY.
      //
      // The first wording here was "not every agent reports one", which implies some do. None do:
      // `contextFill` is set nowhere in `src/adapters/` and is populated only by tests. So the
      // `context.warn_pct` rule ships in the default policy, appears in `usewarden policy`, and
      // cannot fire in production. A field that softens a dead capability into "sometimes
      // unavailable" is the same lie as a counter that reports zero for something it never
      // measured. See D-224.
      : 'no agent currently reports context fill to usewarden — no adapter populates it, so '
        + 'context.warn_pct cannot fire in production either (D-224). This is not a gap in this '
        + 'session; it is a gap in the product.');

  // --- judge spend for THIS session -------------------------------------------------------------
  const spend = store.db.prepare(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(CASE WHEN provider LIKE 'local-%' THEN 0 ELSE 1 END),0) AS metered,
            COALESCE(SUM(CASE WHEN provider LIKE 'local-%' THEN 1 ELSE 0 END),0) AS unmetered,
            COALESCE(SUM(cost_usd),0) AS usd
     FROM judge_spend WHERE session_id = ?`,
  ).get(sessionId) as { calls: number; metered: number; unmetered: number; usd: number };
  const orphaned = store.db.prepare(
    `SELECT COUNT(*) AS n FROM judge_spend WHERE session_id IS NULL`,
  ).get() as { n: number };
  const judge: Field<{ calls: number; metered: number; unmetered: number; usd: number }> =
    Number(spend.calls) === 0 && Number(orphaned.n) > 0
      ? missing(`${Number(orphaned.n)} judge call(s) in this database predate schema v3 and carry no session, so none can be attributed here`)
      : has({
        calls: Number(spend.calls),
        metered: Number(spend.metered),
        unmetered: Number(spend.unmetered),
        usd: Number(spend.usd),
      });

  // --- arithmetic re-checked at READ time, per docs/METRICS.md ----------------------------------
  const totalIncidents = inc.reduce((a, r) => a + Number(r.n), 0);
  if (blocked + warned > totalIncidents) {
    problems.push(`blocked (${blocked}) + warned (${warned}) exceeds this session's ${totalIncidents} incident(s)`);
  }
  if (filesTouched.available && filesTouched.value > rows.length) {
    problems.push(`more distinct files (${filesTouched.value}) than events (${rows.length})`);
  }
  if (commandsRun.available && commandsRun.value > rows.length) {
    problems.push(`more commands (${commandsRun.value}) than events (${rows.length})`);
  }

  return {
    sessionId: s.id, agent: s.agent, origin: s.origin, cwd: s.cwd, goal: s.goal,
    startedAt: start, endedAt, lastActivityAt: lastTs ?? start, boundary, durationMs,
    events: rows.length, filesTouched, commandsRun,
    outsideScope, blocked, warned, peakContextFill, judge, problems,
  };
}

/** The most recent session by last activity, or null when the store has none. */
export function latestSessionId(store: Store): string | null {
  const r = store.db.prepare(
    `SELECT s.id AS id
       FROM sessions s
       LEFT JOIN events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY COALESCE(MAX(e.ts), s.started_at) DESC
      LIMIT 1`,
  ).get() as { id: string } | undefined;
  return r?.id ?? null;
}

/** Session ids, most recently active first. */
export function recentSessionIds(store: Store, limit = 20): string[] {
  const rows = store.db.prepare(
    `SELECT s.id AS id
       FROM sessions s
       LEFT JOIN events e ON e.session_id = s.id
      GROUP BY s.id
      ORDER BY COALESCE(MAX(e.ts), s.started_at) DESC
      LIMIT ?`,
  ).all(limit) as { id: string }[];
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** A field, rendered. Unavailable NEVER renders as a number. */
function show<T>(f: Field<T>, fmt: (v: T) => string): string {
  return f.available ? fmt(f.value) : dim(`unavailable — ${f.reason}`);
}

/**
 * The full receipt.
 *
 * Format follows the CLI conventions this project already uses and the current consensus in
 * `clig.dev` and the accessibility guidance behind `NO_COLOR`: human-readable first with a
 * separate `--json` mode, colour carrying no information a plain reader would lose, and no
 * animation or width trickery so a non-TTY capture is identical to what a terminal shows.
 */
export function renderReceipt(r: Receipt): string {
  // Fixed rather than read from the terminal: a captured receipt in verification/ must be
  // byte-identical to what a terminal shows, and clig.dev's guidance is to prefer a stable
  // wrap when the output is not a TTY. 84 matches the incident card.
  const WIDTH = 84;
  const out: string[] = [];
  // The padding sits OUTSIDE the colour codes on purpose: `wrapLine` recognises a two-column line
  // by "a token followed by two or more spaces", and spaces buried inside an ANSI sequence do not
  // match it — so continuation lines would have hung off the left margin instead of lining up
  // under the value. An unavailable field carries its whole reason, which is exactly the long
  // value that needs the wrap.
  // Wrapped WITHOUT the two-space margin and indented afterwards: `wrapLine` anchors its
  // hanging-indent detection at the start of the string, so a leading margin makes it read the
  // whole line as prose and hang the continuation off the left edge instead of under the value.
  const label = (k: string, v: string): void => {
    const line = `${dim(k)}${' '.repeat(Math.max(1, 12 - k.length))}${v}`;
    for (const w of wrapLine(line, WIDTH - 2)) out.push(`  ${w}`);
  };

  const shortId = r.sessionId.length > 12 ? `${r.sessionId.slice(0, 8)}…` : r.sessionId;
  out.push('');
  out.push(`  ${head('usewarden receipt')}  ${r.agent}  ${dim(`session ${shortId}`)}`);
  out.push('');

  const when = r.boundary.method === 'in-progress'
    ? `started ${stamp(r.startedAt)}`
    : `${stamp(r.startedAt)} → ${stamp(r.endedAt!)}`;
  label('session', `${when}  ${dim(`(${show(r.durationMs, humanDuration)})`)}`);
  label('boundary', `${r.boundary.method}  ${dim(`— ${r.boundary.detail}`)}`);
  label('project', displayPath(r.cwd));
  label('goal', r.goal ? `"${ellipsis(oneLine(r.goal), 62)}"` : dim('none declared'));
  out.push('');

  label('did', `${r.events} events · ${show(r.filesTouched, (n) => `${n} file${n === 1 ? '' : 's'} touched`)}`
    + ` · ${show(r.commandsRun, (n) => `${n} command${n === 1 ? '' : 's'} run`)}`);

  const caught = `${r.blocked} blocked · ${r.warned} warned · ${r.outsideScope} outside scope`;
  label('caught', r.blocked > 0 ? bad(caught) : r.warned > 0 ? warn(caught) : ok(caught));

  label('context', show(r.peakContextFill, (v) => `peak ${Math.round(v * 100)}% of the window`));
  label('guardian', show(r.judge, (j) => {
    const parts = [`${j.calls} judge call${j.calls === 1 ? '' : 's'}`];
    if (j.metered > 0) parts.push(`$${j.usd.toFixed(4)} metered`);
    else parts.push('$0.0000 metered');
    if (j.unmetered > 0) parts.push(`${j.unmetered} unpriced local`);
    return parts.join(' · ');
  }));

  if (r.origin !== 'live') {
    out.push('');
    out.push(`  ${warn(`origin: ${r.origin}`)} ${dim('— not a real agent session, and excluded from every headline figure')}`);
  }

  out.push('');
  // THE CLEAN-SESSION SENTENCE. A receipt whose whole content is zeros reads as a broken tool
  // unless it says, in words, that zero is the answer and not the absence of one.
  if (r.blocked === 0 && r.warned === 0) {
    out.push(`  ${ok('Nothing needed blocking this session.')} ${dim('That is the good outcome, and this')}`);
    out.push(`  ${dim(`receipt is the evidence it happened: ${r.events} events were inspected against your policy.`)}`);
  } else {
    out.push(`  ${dim('Run')} usewarden incidents ${dim('to see the cards for what was caught.')}`);
  }

  if (r.problems.length > 0) {
    out.push('');
    out.push(`  ${bad('THESE FIGURES DO NOT ADD UP:')}`);
    for (const p of r.problems) out.push(`  ${bad('·')} ${p}`);
    out.push(`  ${dim('Affected fields are reported as unavailable rather than as zero.')}`);
  }

  out.push('');
  return out.join('\n');
}

/** One line per session, for `usewarden sessions`. */
export function renderReceiptLine(r: Receipt): string {
  const shortId = r.sessionId.length > 10 ? r.sessionId.slice(0, 8) : r.sessionId.padEnd(8);
  const dur = r.durationMs.available ? humanDuration(r.durationMs.value) : '—';
  const mark = r.blocked > 0 ? bad('!') : r.warned > 0 ? warn('~') : ok('·');
  const flag = r.boundary.method === 'in-progress' ? ' (live)'
    : r.boundary.method === 'idle-gap' ? ' (idle)' : '';
  const tag = r.origin !== 'live' ? ` [${r.origin}]` : '';
  return `  ${mark} ${stamp(r.lastActivityAt).slice(0, 16)}  ${r.agent.padEnd(7)} ${shortId}  `
    + `${dur.padStart(7)}  ${String(r.events).padStart(4)} ev  `
    + `${String(r.blocked).padStart(2)}b ${String(r.warned).padStart(2)}w${flag}${tag}`;
}

/** The status-line fragment. One line, no interruption, session end only. */
export function receiptStatusLine(r: Receipt): string {
  const dur = r.durationMs.available ? humanDuration(r.durationMs.value) : '?';
  return `${dur} · ${r.events} ev · ${r.blocked}b ${r.warned}w`;
}

/** Machine form. Mirrors the human one exactly, including unavailability and its reason. */
export function receiptJson(r: Receipt): unknown {
  const f = <T>(x: Field<T>): unknown =>
    x.available ? { available: true, value: x.value } : { available: false, reason: x.reason };
  return {
    session_id: r.sessionId,
    agent: r.agent,
    origin: r.origin,
    cwd: r.cwd,
    goal: r.goal,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    last_activity_at: r.lastActivityAt,
    boundary_method: r.boundary.method,
    boundary_detail: r.boundary.detail,
    duration_ms: f(r.durationMs),
    events: r.events,
    files_touched: f(r.filesTouched),
    commands_run: f(r.commandsRun),
    outside_scope: r.outsideScope,
    blocked: r.blocked,
    warned: r.warned,
    peak_context_fill: f(r.peakContextFill),
    judge: f(r.judge),
    problems: r.problems,
  };
}

/** The loud empty state. Deliberately not a receipt, and deliberately not silence. */
export function renderNoSession(scope: string): string {
  return [
    '',
    `  ${bad('NO SESSION FOUND')}`,
    '',
    `  ${scope}`,
    '',
    `  ${dim('This is NOT the same as a session in which nothing was blocked. A clean session still')}`,
    `  ${dim('produces a full receipt. This means usewarden has no record of any agent activity at')}`,
    `  ${dim('all, which usually means the hooks are not registered.')}`,
    '',
    `  ${dim('Check with')} usewarden status ${dim('— if it says UNPROTECTED, run')} usewarden init`,
    '',
  ].join('\n');
}

/** Used by the tests to assert no rendered line exceeds the terminal budget. */
export function widestLine(text: string): number {
  return Math.max(0, ...text.split('\n').map((l) => stripAnsi(l).length));
}

