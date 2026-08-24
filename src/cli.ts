#!/usr/bin/env node
import { displayPath, mkdirpSafe } from './util.js';
import './boot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './store.js';
import { scan, renderScan } from './scan.js';
import { POLICY_INPUTS, cannotEverFire, unsupportedFields, whyUnsupported } from './policy/inputs.js';
import {
  DEFAULT_TTL_HOURS, addException, loadExceptions, refuseIfNotHuman, remaining, revokeException,
} from './exceptions.js';
import {
  buildReceipt, latestSessionId, recentSessionIds, receiptJson,
  renderNoSession, renderReceipt, renderReceiptLine,
} from './receipt.js';
import { runHook } from './hook.js';
import { ensureHome, globalPolicyPath, usewardenHome } from './paths.js';
import { detectAgents } from './install/detect.js';
import { applyInit, latestBackupDir, nodePath, planInit, restoreConfigs, uninstall, usewardenScriptPath } from './install/installer.js';
import { buildStatus, isUnlocked, relock, unlock, type StatusReport } from './status.js';
import { findRepoRoot, loadPolicy, PolicyLoadError, starterPolicyYaml, trust, untrust } from './policy/load.js';
import { bad, box, checkbox, dim, head, ok, paint, stateBadge, table, warn, wrapLine } from './term.js';
import { buildMetrics, fmtInt, fmtTokenBand, fmtUsdBand, TURN_TOKENS, TURNS_WASTED } from './metrics.js';

const VERSION = '0.1.0';

const USAGE = `usewarden ${VERSION} - a guardrail for your AI coding agents

USAGE
  usewarden <command> [options]

COMMANDS
  init                  Detect agents, preview config changes, register hooks
  status                Is usewarden actually protecting you right now?
  scan                  What would usewarden do in THIS project? Read-only, ~1 second
  last [session-id]     The receipt for the most recent agent session, or a named one
  allow <rule-id>       Waive one rule in this project for 24 hours. Humans only
  allow --list          Every waiver you have granted, and when each expires
  sessions [N]          One line per session, most recent first (default 20)
  demo                  Run a safe simulated violation and show a real incident card
  incidents             Show the incident wall
  metrics               Every number usewarden reports, how it was derived, and what
                        it deliberately refuses to estimate
  dashboard             Serve the local read-only dashboard on 127.0.0.1
  doctor                Diagnose why usewarden might not be firing
  policy                Print the effective policy and where each part came from
  trust <path>          Trust a repo's usewarden.yaml to widen scope (default: narrow only)
  untrust <path>        Revoke that trust
  unlock [--minutes N]  Suppress TAMPERED while you edit your own agent config
  lock                  End the unlock window early
  uninstall             Remove usewarden's hook entries from every agent config
  restore-configs [dir] Restore agent configs byte-identically from a backup
  telemetry <on|off|status>  Opt in or out. Off by default; DO_NOT_TRACK and
                        USEWARDEN_TELEMETRY=0 are honoured. v1 has NO endpoint.
                        "on" shows the exact payload and needs a confirmation
                        (or --yes); "off --purge" also deletes what was recorded.
  hook <agent> <kind>   Internal: invoked by an agent's hook system. Not for humans.
  judge-check           Make ONE real Layer-2 judge call and report what happened.
                        The only way to prove a metered provider works end to end.
  judge-run <payload>   Internal: the detached Layer-2 drift judge. Not for humans.
  statusline            Internal: one-line status for a Claude Code status line.

GLOBAL OPTIONS
  --json                Machine-readable output (every command supports it)
  --yes, -y             Non-interactive: apply without waiting for confirmation
  --dry-run             Show what would change and exit
  --project             Register in THIS repo's config instead of your home config
  -h, --help            This text
  -V, --version         Print version

ENVIRONMENT
  USEWARDEN_HOME                 Where usewarden keeps its state (default ~/.usewarden)
  USEWARDEN_ALLOW_CONFIG_WRITE=1 Escape hatch: never report TAMPERED for your own edits
  NO_COLOR / DO_NOT_TRACK     Both honoured
`;

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const args = argv.filter((a) => !a.startsWith('-'));
  const cmd = args[0];
  const json = flags.has('--json');

  // ORDER MATTERS HERE, and getting it wrong made `--version` print the entire help.
  //
  // `usewarden --version` has no positional argument, so `cmd` is `undefined` — and the help
  // branch used to fire on `cmd === undefined` BEFORE the version check was reached. So the flag
  // this tool's own usage text documents as "Print version" printed 43 lines of usage instead,
  // and it did so for every user of every published version. `usewarden foo --version` worked,
  // which is why it survived: nobody types that.
  //
  // Found by running the packed tarball rather than the repository (D2 of the release runbook),
  // which is the whole argument for that step: `npm test` never invoked the real entry point with
  // a bare flag and no command.
  const wantsHelp = flags.has('-h') || flags.has('--help') || cmd === 'help';
  if ((flags.has('-V') || flags.has('--version')) && !wantsHelp) {
    process.stdout.write(json ? JSON.stringify({ version: VERSION }) + '\n' : VERSION + '\n');
    return 0;
  }
  if (wantsHelp || cmd === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  // `hook` must be first and must never touch any of the pretty-printing above.
  if (cmd === 'hook') return runHook(args.slice(1));

  switch (cmd) {
    case 'init': return cmdInit(flags, json);
    case 'status': return cmdStatus(json);
    case 'doctor': return cmdDoctor(json);
    case 'incidents': return cmdIncidents(json, Number(args[1] ?? 20));
    case 'policy': return cmdPolicy(json);
    case 'metrics': return cmdMetrics(json);
    case 'demo': return (await import('./demo.js')).runDemo(json);
    case 'scan': return cmdScan(json);
    case 'last': return cmdLast(json, args[1]);
    case 'allow': return cmdAllow(args.slice(1), json, flags);
    case 'sessions': return cmdSessions(json, Number(args[1] ?? 20));
    case 'judge-run': return cmdJudgeRun(args[1]);
    case 'judge-check': return cmdJudgeCheck(json);
    case 'statusline': return (await import('./statusline.js')).runStatusLine();
    case 'dashboard': return (await import('./dashboard.js')).serveDashboard(flags, args);
    case 'trust': return cmdTrust(args[1], true, json);
    case 'untrust': return cmdTrust(args[1], false, json);
    case 'unlock': return cmdUnlock(argv, json);
    case 'lock': relock(); emit(json, { locked: true }, () => ok('usewarden re-locked. TAMPERED detection is active again.')); return 0;
    case 'uninstall': return cmdUninstall(json);
    case 'restore-configs': return cmdRestore(args[1], json);
    case 'telemetry': return cmdTelemetry(args[1] ?? 'status', json, flags);
    default:
      process.stderr.write(`usewarden: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

/**
 * The detached Layer-2 judge (see src/engine/detached.ts). Runs in its own process so a judge
 * that takes 30 seconds cannot make the user's agent wait 30 seconds. Always exits 0: this
 * process has no caller to report to, and a non-zero exit here would only pollute logs.
 */
/**
 * ONE real judge call, against whichever provider the environment selects, on a scenario whose
 * correct answer is not in doubt.
 *
 * This exists because the metered providers cannot be proved by the test suite. The contract
 * suite (tests/judge-providers.test.ts) proves usewarden speaks each protocol correctly against
 * the published schemas with a stubbed transport; only a real key proves the vendor still speaks
 * it. Rather than ask a human to hand-build a payload, `judge-check` runs the whole path -
 * provider selection, prompt construction, transport, response parsing, ledger accounting - and
 * prints the four things that make the result checkable: which provider answered, what it cost,
 * whether it detected an obvious drift, and whether the ledger moved by the same amount.
 *
 * The scenario is a session whose declared goal is fixing a unit test, whose activity is writing
 * marketing copy. A judge that cannot call that drift is not working, whatever it returns.
 */
async function cmdJudgeCheck(json: boolean): Promise<number> {
  const { maybeJudge, selectProvider, pricingStaleness, providerSpecs, modelOverrideWarning,
    rankedProviders, costPerCall, inspectKeyShape } = await import('./engine/judge.js');
  const { defaultPolicy } = await import('./policy/schema.js');

  ensureHome();
  const store = new Store();
  try {
    const policy = defaultPolicy(process.cwd());
    const cfg = selectProvider(policy);
    if (!cfg) {
      const msg = 'No judge available: set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, '
        + 'or install and authenticate the `claude` or `gemini` CLI.';
      if (json) process.stdout.write(JSON.stringify({ ok: false, reason: 'no_provider', message: msg }) + '\n');
      else process.stdout.write('\n' + bad('  ' + msg) + '\n\n');
      return 1;
    }

    const before = store.totalJudgeSpend();
    const sessionId = `judge-check-${Date.now()}`;
    const ts = Date.now();
    store.upsertSession(sessionId, 'claude', process.cwd(), ts);
    store.setGoal(sessionId, 'Fix the failing unit test in src/parser.ts. Do not touch anything else.');

    const event = {
      sessionId, agent: 'claude' as const, event: 'pre_tool' as const, ts,
      tool: 'bash' as const, command: 'echo "10 Reasons Our Startup Will Change Everything" > marketing/launch-blog.md',
      cwd: process.cwd(),
    };
    const layer1 = { decision: 'allow' as const, reason: '', layer: 1 as const, severity: 'info' as const };

    const started = Date.now();
    const out = await maybeJudge(store, event, policy, layer1);
    const ms = Date.now() - started;
    const after = store.totalJudgeSpend();

    const ledgerDelta = {
      usd: Number((after.usd - before.usd).toFixed(6)),
      inTok: after.inTok - before.inTok,
      outTok: after.outTok - before.outTok,
    };
    const driftDetected = Boolean(out.verdict);
    const passed = out.ran && driftDetected;
    const stale = cfg.metered ? pricingStaleness(cfg.provider as 'anthropic' | 'openai' | 'gemini') : null;
    const override = modelOverrideWarning(cfg);
    // Shown BEFORE the result, always. `judge-check` exists to diagnose, and the shape of the
    // credential is the one input the user controls and cannot see usewarden's opinion of.
    const shape = cfg.metered ? inspectKeyShape(cfg.provider as 'anthropic' | 'openai' | 'gemini', cfg.apiKey) : null;
    // Why THIS provider. Printed because a silent automatic choice about someone's bill is the
    // kind of thing that should be visible without reading the source.
    const specs = providerSpecs();
    const ranking = rankedProviders().map((p) => ({
      provider: p, model: specs[p].model, usdPerCall: Number(costPerCall(specs[p]).toFixed(6)),
      keyPresent: Boolean(process.env[specs[p].env]?.trim()),
    }));

    if (json) {
      process.stdout.write(JSON.stringify({
        ok: passed, provider: out.provider ?? cfg.provider, model: out.model ?? cfg.model,
        metered: cfg.metered, ran: out.ran, driftDetected, latencyMs: ms,
        costUsd: out.costUsd, ledgerDelta,
        pricedOn: cfg.metered ? providerSpecs()[cfg.provider as 'anthropic' | 'openai' | 'gemini'].pricedOn : null,
        verdict: out.verdict ? out.verdict.reason : null,
        warning: out.warning ?? null, pricingWarning: stale, modelWarning: override,
        keyShape: shape ? { ok: shape.ok, code: shape.code, message: shape.message } : null,
        selection: { policy: 'cheapest-capable', ranking },
      }) + '\n');
      return passed ? 0 : 1;
    }

    process.stdout.write('\n' + head('  usewarden judge-check') + '\n\n');
    process.stdout.write(`  ${dim('provider')}   ${out.provider ?? cfg.provider} / ${out.model ?? cfg.model}`
      + `${cfg.metered ? '' : dim('  (local CLI - real cost, no token counts)')}\n`);
    process.stdout.write(`  ${dim('latency')}    ${ms} ms\n`);
    process.stdout.write(`  ${dim('tokens')}     in ${ledgerDelta.inTok}, out ${ledgerDelta.outTok}\n`);
    process.stdout.write(`  ${dim('cost')}       $${out.costUsd.toFixed(6)}   ${dim(`ledger moved by $${ledgerDelta.usd.toFixed(6)}`)}\n\n`);
    process.stdout.write(`  ${out.ran ? ok('the call completed') : bad('the call did NOT complete')}\n`);
    process.stdout.write(`  ${driftDetected ? ok('drift was detected on a scenario that is unambiguously drift') : bad('NO drift detected - the judge is answering, but not usefully')}\n`);
    process.stdout.write(`  ${ledgerDelta.inTok > 0 || !cfg.metered ? ok('the ledger recorded the usage') : bad('the ledger did NOT move')}\n`);
    if (out.verdict) process.stdout.write(`\n  ${dim('verdict')}    ${out.verdict.reason}\n`);
    if (out.warning) process.stdout.write(`\n  ${warn('  ' + out.warning)}\n`);
    if (stale) process.stdout.write(`\n  ${warn('  ' + stale)}\n`);
    if (override) process.stdout.write(`\n  ${warn('  ' + override)}\n`);
    if (shape && !shape.ok) process.stdout.write(`\n  ${bad('  ' + shape.message)}\n`);
    else if (shape) process.stdout.write(`\n  ${dim('  ' + shape.message)}\n`);
    process.stdout.write(`\n  ${dim('selection  cheapest-capable. One representative call (500 in / 50 out) would cost:')}\n`);
    for (const r of ranking) {
      process.stdout.write(`  ${dim(`           $${r.usdPerCall.toFixed(6)}  ${r.provider}/${r.model}`
        + `${r.keyPresent ? '  <- key present' : '  (no key set)'}`)}\n`);
    }
    process.stdout.write('\n  ' + (passed ? ok('PASS') : bad('FAIL')) + '\n\n');
    return passed ? 0 : 1;
  } finally {
    store.close();
  }
}

async function cmdJudgeRun(payloadPath: string | undefined): Promise<number> {
  if (!payloadPath) return 0;
  const { readPayload, discardPayload } = await import('./engine/detached.js');
  const { maybeJudge } = await import('./engine/judge.js');
  const { recordJudgeFinding } = await import('./engine/pipeline.js');
  const { logQuiet } = await import('./hook.js');

  const payload = readPayload(payloadPath);
  discardPayload(payloadPath);
  if (!payload) return 0;

  const store = new Store();
  try {
    const loaded = loadPolicy(payload.event.cwd);
    const out = await maybeJudge(store, payload.event, loaded.policy, payload.layer1);
    if (out.warning) logQuiet(out.warning);
    if (out.verdict && out.verdict.severity !== 'info') {
      recordJudgeFinding(store, payload.event, out.verdict, payload.live);
      logQuiet(`JUDGE_DRIFT recorded: ${out.verdict.reason}`);
    } else if (out.ran) {
      logQuiet(`judge ran (${out.provider}/${out.model}): no drift`);
    }
  } catch (e) {
    logQuiet(`judge-run failed: ${(e as Error).message}`);
  } finally {
    store.close();
  }
  return 0;
}

function emit(json: boolean, obj: unknown, human: () => string): void {
  process.stdout.write(json ? JSON.stringify(obj, null, 2) + '\n' : human() + '\n');
}

// ---------------------------------------------------------------------------

function cmdInit(flags: Set<string>, json: boolean): number {
  ensureHome();
  const store = new Store();
  try {
    const detections = detectAgents();
    const present = detections.filter((d) => d.installed);
    if (present.length === 0) {
      // Say what usewarden looked for, and what to do about it. The previous message printed six
      // absolute paths and stopped - which tells someone whose agent IS installed nothing about
      // why it was not found, and tells someone whose agent is not installed nothing at all.
      emit(json, { agents: [], error: 'no agents detected' }, () =>
        bad('No AI coding agents detected on this machine.') + '\n\n' +
        'usewarden registers with an agent by editing its config, so it needs one to be '
        + 'installed first.\n\n'
        + 'It looked for a directory or config file for each of these:\n'
        + detections.map((d) => `  ${d.label.padEnd(16)} ${d.configPath}`).join('\n') + '\n\n'
        + dim('If your agent IS installed and is not listed above, it keeps its config somewhere '
          + 'usewarden does not know about yet - please open an issue saying which agent and '
          + 'which version, and it will be added.') + '\n'
        + dim('If you want to protect a single project rather than your whole machine, run '
          + '"usewarden init --project" from inside it.'));
      return 1;
    }

    // Starter policy first, so the diff preview reflects a policy that exists.
    const pol = globalPolicyPath();
    let policyCreated = false;
    if (!fs.existsSync(pol)) {
      const repoRoot = findRepoRoot(process.cwd()) ?? process.cwd();
      fs.writeFileSync(pol, starterPolicyYaml(repoRoot), { mode: 0o600 });
      policyCreated = true;
      store.completeStep('policy_created', Date.now());
    } else {
      store.completeStep('policy_created', Date.now());
    }

    const projectRoot = findRepoRoot(process.cwd());
    const wantProject = flags.has('--project');
    if (wantProject && !projectRoot) {
      process.stderr.write('usewarden: --project requires being inside a git repository\n');
      return 2;
    }
    const changes = planInit(wantProject
      ? { scope: 'project', projectRoot: projectRoot! }
      : {});
    const dryRun = flags.has('--dry-run');

    if (json && dryRun) {
      emit(true, { policyCreated, policyPath: pol, changes: changes.map(summarize) }, () => '');
      return 0;
    }

    if (!json) {
      process.stdout.write(head('\nusewarden init - proposed changes\n\n'));
      process.stdout.write(dim(`usewarden command: ${nodePath()} ${usewardenScriptPath()} hook <agent> <event>\n`));
      process.stdout.write(dim(`policy:        ${pol}${policyCreated ? ' (created)' : ' (existing)'}\n\n`));
      for (const c of changes) {
        const flag = c.creates ? warn('  CREATES A FILE THAT DOES NOT EXIST YET') : '';
        process.stdout.write(`${head(c.label)}  ${dim(c.configPath)}\n`);
        if (flag) process.stdout.write(flag + '\n');
        if (c.caveat) process.stdout.write(warn(`  caveat: ${c.caveat}`) + '\n');
        process.stdout.write(c.changed ? indent(c.diff) + '\n\n' : dim('  (already up to date)\n\n'));
      }
    }

    if (dryRun) {
      if (!json) process.stdout.write(dim('--dry-run: nothing written.\n'));
      return 0;
    }

    const res = applyInit(changes, store);
    // Idempotent re-run: mark the checklist even when nothing needed writing.
    if (res.applied) store.setMeta('installed', 'true');

    const report = buildStatus(store, process.cwd());
    if (json) {
      emit(true, { policyCreated, policyPath: pol, applied: res.applied, backupDir: res.backupDir, errors: res.errors, changes: changes.map(summarize), status: report }, () => '');
      return res.errors.length ? 1 : 0;
    }

    process.stdout.write(res.applied
      ? ok(`Applied. Backup: ${res.backupDir}\n`) + dim(`Undo with: usewarden restore-configs "${res.backupDir}"\n\n`)
      : dim('Nothing to write - already registered.\n\n'));
    for (const e of res.errors) process.stdout.write(bad(`  error: ${e}\n`));
    process.stdout.write(renderSummary(report) + '\n');
    return res.errors.length ? 1 : 0;
  } finally {
    store.close();
  }
}

function summarize(c: ReturnType<typeof planInit>[number]) {
  return { agent: c.agent, scope: c.scope, configPath: c.configPath, creates: c.creates, changed: c.changed, diff: c.diff, caveat: c.caveat };
}

function indent(s: string): string {
  return s.split('\n').map((l) => '  ' + l).join('\n');
}

function cmdStatus(json: boolean): number {
  const store = new Store();
  try {
    const r = buildStatus(store, process.cwd());
    if (json) { emit(true, r, () => ''); return exitFor(r); }
    process.stdout.write(renderStatus(r) + '\n');
    return exitFor(r);
  } finally { store.close(); }
}

function exitFor(r: StatusReport): number {
  return r.overall === 'PROTECTED' ? 0 : 1;
}

function renderStatus(r: StatusReport): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${head('usewarden')}  ${stateBadge(r.overall)}`);
  out.push('');

  if (r.policyError) {
    out.push(bad('  POLICY_INVALID - usewarden is NOT enforcing anything until this is fixed:'));
    for (const l of r.policyError.split('\n')) out.push('    ' + l);
    out.push('');
  }

  const rows: string[][] = [[dim('AGENT'), dim('STATE'), dim('CONFIG')]];
  for (const a of r.agents) rows.push([`${a.label} ${dim('(' + a.scope + ')')}`, stateBadge(a.state), dim(displayPath(a.configPath))]);
  out.push(table(rows).split('\n').map((l) => '  ' + l).join('\n'));
  out.push('');
  for (const a of r.agents) {
    if (a.state !== 'PROTECTED') out.push(`  ${bad(a.label + ':')} ${a.detail}`);
    if (a.caveat) out.push(`  ${warn('note')} ${a.label}: ${a.caveat}`);
  }
  for (const n of r.policyNotices) out.push(`  ${warn('policy')} ${n}`);
  if (r.unlocked) out.push(`  ${warn('UNLOCKED')} tamper detection is suppressed. Run "usewarden lock" when you are done.`);
  out.push('');

  // The FIRST unfinished item names the command that finishes it.
  //
  // Found by installing this as a stranger would. A new user's first command is `usewarden
  // status`, and before `init` it printed the word UNPROTECTED in red, an empty agent table,
  // four empty checkboxes, a table of zeroes, and exited 1 - without ever saying what to do
  // next. Every fact on that screen was correct and the screen was useless. The checklist is
  // supposed to be the onboarding path; a path with no next step is a list.
  const NEXT_STEP: Record<string, string> = {
    'Agents detected': 'usewarden init',
    'Policy created': 'usewarden init',
    'Protection verified': 'usewarden init',
    'First catch in a real session': 'usewarden demo   (a real catch happens on its own, next time an agent oversteps)',
  };
  const checklistLines = r.checklist.map((c) => `${checkbox(c.done)} ${c.label}`);
  const firstUnfinished = r.checklist.find((c) => !c.done);
  if (firstUnfinished && NEXT_STEP[firstUnfinished.label]) {
    checklistLines.push('', dim(`Next: ${NEXT_STEP[firstUnfinished.label]}`));
  }
  out.push(box('Getting started', checklistLines));
  out.push('');

  const m = r.metrics;
  const lines = [
    `actions blocked      ${paint(fmtInt(m.live.attempts), 'bold')}  ${dim(`(${fmtInt(m.live.distinct_actions)} distinct)`)}`,
    `drift warnings       ${paint(fmtInt(m.live.drift_warnings), 'bold')}`,
    `events inspected     ${fmtInt(m.live.events)}`,
    `sessions protected   ${fmtInt(m.live.sessions)}`,
    dim('every figure above counts REAL agent sessions only'),
  ];
  if (m.demo.incidents > 0) {
    lines.push(dim(`demo runs            ${fmtInt(m.demo.attempts)} blocked in ${fmtInt(m.demo.sessions)} demo session(s), counted separately`));
  }
  lines.push('');
  lines.push(`est. tokens saved    ${fmtTokenBand(m.savings.tokens)}`);
  lines.push(`est. money saved     ${fmtUsdBand(m.savings.usd)}`);
  lines.push(dim(`guardian overhead    $${m.overhead.metered_usd.toFixed(4)} metered, ${m.overhead.unmetered_calls} unpriced local calls`));
  if (m.savings.unpriced_actions > 0) {
    lines.push(dim(`${fmtInt(m.savings.unpriced_actions)} catch(es) deliberately not priced (credential / shell). "usewarden metrics" explains why.`));
  }
  lines.push(dim('an ESTIMATE from assumed bands, not a measurement.'));
  lines.push(dim('method and constants: usewarden metrics'));
  out.push(box('What usewarden has done', lines));
  out.push('');
  if (!m.integrity.consistent) {
    out.push(bad('  METRICS INCONSISTENT - usewarden does not believe its own numbers:'));
    for (const p of m.integrity.problems) out.push(bad(`    ${p}`));
    out.push('');
  }
  out.push(dim(`  state: ${r.usewardenHome}   policy: ${r.policySources.join(' -> ')}`));
  return out.join('\n');
}

function renderSummary(r: StatusReport): string {
  const lines = r.agents.map((a) => `${a.label}: ${stateBadge(a.state)}`);
  lines.push('');
  lines.push(...r.checklist.map((c) => `${checkbox(c.done)} ${c.label}`));
  lines.push('');
  lines.push(dim('Next: run "usewarden demo" to see a real incident card in under a minute.'));
  lines.push('');
  // Spec 3C: telemetry is off by default and that fact is "printed plainly at first run".
  // Stating it here, unprompted, is the whole point - a privacy default nobody is told about
  // is indistinguishable from one that does not exist.
  lines.push(dim('Telemetry is OFF. Usewarden sends nothing, and v1 ships no endpoint to send it to.'));
  lines.push(dim('"usewarden telemetry status" shows the exact payload it would record if you opted in.'));
  return box('Protection summary', lines);
}

function cmdDoctor(json: boolean): number {
  const store = new Store();
  try {
    const r = buildStatus(store, process.cwd());
    const findings: { check: string; ok: boolean; detail: string }[] = [];
    findings.push({ check: 'node binary resolves to an absolute path', ok: path.isAbsolute(nodePath()), detail: nodePath() });
    findings.push({ check: 'node binary exists and is executable', ok: isExecutable(nodePath()), detail: nodePath() });
    findings.push({ check: 'usewarden script resolves to an absolute path', ok: path.isAbsolute(usewardenScriptPath()), detail: usewardenScriptPath() });
    findings.push({ check: 'usewarden script exists on disk', ok: fs.existsSync(usewardenScriptPath()), detail: usewardenScriptPath() });
    findings.push({ check: 'state directory writable', ok: canWrite(usewardenHome()), detail: usewardenHome() });
    findings.push({ check: 'policy loads', ok: !r.policyError, detail: r.policyError ?? r.policySources.join(' -> ') });
    // EVERY ROW CARRIES ITS OWN DETAIL.
    //
    // Three of these four used to share `a.detail`, which is the message for the agent's WORST
    // condition. So a machine whose registered path had merely moved printed
    //
    //     PASS  Claude Code: entries unmodified   ... Something rewrote it. Inspect immediately.
    //
    // - a green row whose text describes an emergency, with the same emergency repeated on two
    // other rows. The PASS was factually correct (the entries really were unmodified); the
    // message belonged to a different check. A control whose state cannot be read off its own
    // output is the failure this project exists to eliminate, and `doctor` is the command people
    // will paste into an issue.
    for (const a of r.agents) {
      findings.push({ check: `${a.label}: hooks registered`, ok: a.registered,
        detail: a.registered ? a.configPath : `no usewarden entries in ${a.configPath} - run: usewarden init` });
      findings.push({ check: `${a.label}: entries unmodified`, ok: a.hashMatches || r.unlocked,
        detail: a.hashMatches ? 'match the recorded baseline'
          : r.unlocked ? 'changed, but usewarden is UNLOCKED so this counts as your own edit'
            : `entries in ${a.configPath} do not match the recorded hash - if you changed them, run "usewarden unlock" then "usewarden init"` });
      findings.push({ check: `${a.label}: hooks not globally disabled`, ok: !a.hooksGloballyDisabled, detail: a.hooksGloballyDisabled ? 'disableAllHooks is true' : 'ok' });
      findings.push({ check: `${a.label}: command points at usewarden`, ok: a.commandPointsAtUsewarden,
        detail: a.commandPointsAtUsewarden ? usewardenScriptPath() : a.detail });
    }
    if (json) { emit(true, { overall: r.overall, findings }, () => ''); return findings.every((f) => f.ok) ? 0 : 1; }
    process.stdout.write('\n' + table([[dim('  '), dim('CHECK'), dim('DETAIL')],
      ...findings.map((f) => [f.ok ? ok('PASS') : bad('FAIL'), f.check, dim(f.detail)])]) + '\n\n');
    return findings.every((f) => f.ok) ? 0 : 1;
  } finally { store.close(); }
}

/**
 * A real Claude Code session once failed with `EACCES: posix_spawn` because usewarden's script had
 * no execute bit, and every hook silently no-opped. Usewarden now invokes node explicitly, and
 * doctor checks the interpreter for the same class of failure.
 */
function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function canWrite(dir: string): boolean {
  try {
    mkdirpSafe(dir, 0o755);
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

function cmdIncidents(json: boolean, limit: number): number {
  const store = new Store();
  try {
    const rows = store.recentIncidents(Number.isFinite(limit) ? limit : 20);
    if (json) { emit(true, rows, () => ''); return 0; }
    if (rows.length === 0) {
      process.stdout.write(dim('\n  No incidents yet. Run "usewarden demo" to see what one looks like.\n\n'));
      return 0;
    }
    process.stdout.write('\n');
    for (const i of rows) process.stdout.write(incidentCard(i) + '\n\n');
    return 0;
  } finally { store.close(); }
}

/** The incident card IS the marketing asset (spec 3.6). Keep it screenshot-worthy. */
export function incidentCard(i: {
  ts: number; agent: string; action: string; title: string; attempted: string;
  reason: string; rule: string; live: number; layer: number;
}): string {
  const when = new Date(i.ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  const verb = i.action === 'block' ? bad('BLOCKED') : warn(i.action.toUpperCase());
  return box(`${verb}  ${i.title}`, [
    `${dim('when')}     ${when}`,
    `${dim('agent')}    ${i.agent}${i.live ? '  ' + ok('live session') : '  ' + dim('fixture')}`,
    `${dim('attempt')}  ${displayPath(i.attempted)}`,
    `${dim('why')}      ${displayPath(i.reason)}`,
    `${dim('rule')}     ${i.rule}  ${dim('(layer ' + i.layer + ')')}`,
  ]);
}

function cmdPolicy(json: boolean): number {
  try {
    const loaded = loadPolicy(process.cwd());
    if (json) { emit(true, loaded, () => ''); return 0; }
    process.stdout.write('\n' + head('  effective policy') + '\n');
    process.stdout.write(dim('  sources: ' + loaded.sources.join(' -> ') + '\n\n'));
    // RULES THAT CANNOT FIRE ARE NOT PRINTED AS POLICY.
    //
    // `usewarden policy` is where a user goes to read what protects them. Printing a rule whose
    // input no adapter supplies tells them they have a protection they do not have - which is
    // exactly what `context.warn_pct` did for months (D-224). So a section whose every input
    // field is unpopulated is REMOVED from the printed document and listed separately, by name,
    // with the reason. Suppressing it silently would swap one lie for a quieter one.
    const suppressed = POLICY_INPUTS.filter((pi) => cannotEverFire(pi.section));
    const shown = structuredClone(loaded.policy) as unknown as Record<string, unknown>;
    for (const pi of suppressed) {
      const [head0, leaf] = pi.section.split('.');
      if (leaf === undefined) { delete shown[head0!]; continue; }
      const parent = shown[head0!] as Record<string, unknown> | undefined;
      if (parent && leaf in parent) delete parent[leaf];
    }
    process.stdout.write(indent(JSON.stringify(shown, null, 2)) + '\n');

    if (suppressed.length > 0) {
      process.stdout.write('\n' + warn('  NOT SHOWN ABOVE, BECAUSE IT CANNOT FIRE:') + '\n');
      for (const pi of suppressed) {
        const missing = unsupportedFields(pi.section);
        process.stdout.write(`  ${bad('·')} ${head(pi.section)} — ${pi.what}\n`);
        for (const f of missing) {
          for (const w of wrapLine(`needs \`${String(f)}\`: ${whyUnsupported(f)}`, 74)) {
            process.stdout.write(dim(`      ${w}\n`));
          }
        }
      }
      process.stdout.write(dim('  These are omitted from the policy above on purpose. A rule you can\n'));
      process.stdout.write(dim('  read but that cannot fire is a protection you think you have.\n'));
    }

    for (const n of loaded.notices) process.stdout.write('\n' + warn(`  ${n.code}: ${n.detail}`) + '\n');
    return 0;
  } catch (e) {
    const msg = e instanceof PolicyLoadError ? e.message : (e as Error).message;
    if (json) { process.stdout.write(JSON.stringify({ error: msg }) + '\n'); return 1; }
    process.stderr.write(bad('\n  ' + msg + '\n\n'));
    return 1;
  }
}

function cmdTrust(target: string | undefined, on: boolean, json: boolean): number {
  if (!target) { process.stderr.write('usewarden: trust requires a path to a usewarden.yaml\n'); return 2; }
  const abs = path.resolve(target);
  if (on) trust(abs); else untrust(abs);
  emit(json, { path: abs, trusted: on }, () => on
    ? warn(`Trusted ${abs}. That repo's usewarden.yaml may now WIDEN your scope. Undo: usewarden untrust "${abs}"`)
    : ok(`Untrusted ${abs}. It can only narrow your policy again.`));
  return 0;
}

function cmdUnlock(argv: string[], json: boolean): number {
  const idx = argv.indexOf('--minutes');
  const mins = idx >= 0 ? Number(argv[idx + 1]) : 15;
  const until = unlock(Number.isFinite(mins) && mins > 0 ? mins : 15);
  emit(json, { unlockedUntil: until }, () =>
    warn(`Usewarden unlocked until ${new Date(until).toISOString()}. Config edits will not report TAMPERED.`) +
    '\n' + dim('Run "usewarden init" afterwards to re-baseline, or "usewarden lock" to end early.'));
  return 0;
}

function cmdUninstall(json: boolean): number {
  const store = new Store();
  try {
    const r = uninstall(store, findRepoRoot(process.cwd()) ?? undefined);
    emit(json, r, () => {
      const lines = r.removed.length
        ? [ok('Removed usewarden hook entries from:'), ...r.removed.map((p) => '  ' + p)]
        : [dim('No usewarden hook entries found; nothing to remove.')];
      if (latestBackupDir()) lines.push('', dim(`Original configs are still in ${latestBackupDir()} - "usewarden restore-configs" puts them back byte-identically.`));
      for (const e of r.errors) lines.push(bad('  error: ' + e));
      return lines.join('\n');
    });
    return r.errors.length ? 1 : 0;
  } finally { store.close(); }
}

function cmdRestore(dir: string | undefined, json: boolean): number {
  const r = restoreConfigs(dir);
  const allOk = r.errors.length === 0 && r.restored.every((x) => x.byteIdentical);
  emit(json, { ...r, allByteIdentical: allOk }, () => {
    const lines = [head(`restore from ${r.dir}`), ''];
    for (const x of r.restored) {
      lines.push(`${x.byteIdentical ? ok('OK  ') : bad('FAIL')} ${x.action.padEnd(9)} ${x.path}`);
    }
    for (const e of r.errors) lines.push(bad('  error: ' + e));
    lines.push('', allOk ? ok('Every config restored byte-identically.') : bad('At least one config did NOT restore byte-identically.'));
    return lines.join('\n');
  });
  return allOk ? 0 : 1;
}

/**
 * `usewarden metrics` - the audit surface for every figure the product shows.
 *
 * It exists because "actions blocked" is a marketing number, and a marketing number that cannot
 * be audited is a claim. This prints the derivation: which origin each figure came from, what
 * the savings estimate was computed from, every constant that went into it, and the categories
 * usewarden refuses to convert into dollars at all.
 */
function cmdMetrics(json: boolean): number {
  const store = new Store();
  try {
    const m = buildMetrics(store);
    if (json) {
      process.stdout.write(JSON.stringify({
        ...m,
        constants: { turn_tokens: TURN_TOKENS, turns_wasted: TURNS_WASTED },
      }, null, 2) + '\n');
      return m.integrity.consistent ? 0 : 1;
    }

    const out: string[] = [''];
    out.push('  ' + head('usewarden metrics'));
    out.push('');
    const rows: string[][] = [[dim('ORIGIN'), dim('BLOCKED'), dim('DISTINCT'), dim('DRIFT'), dim('EVENTS'), dim('SESSIONS')]];
    for (const [label, b] of [['real sessions', m.live], ['demo', m.demo], ['fixture/tests', m.fixture]] as const) {
      rows.push([label, fmtInt(b.attempts), fmtInt(b.distinct_actions), fmtInt(b.drift_warnings), fmtInt(b.events), fmtInt(b.sessions)]);
    }
    out.push(table(rows).split('\n').map((l) => '  ' + l).join('\n'));
    out.push('');
    out.push(dim('  Only the "real sessions" row is ever shown as a headline figure. A demo run and a'));
    out.push(dim('  test fixture are recorded, labelled, and kept out of it. Every figure is derived by'));
    out.push(dim('  query, not read from a counter, so it can be recomputed and audited.'));
    out.push('');

    out.push(box('Estimated savings  ' + dim('(' + m.savings.method + ')'), [
      `tokens               ${fmtTokenBand(m.savings.tokens)}`,
      `money                ${fmtUsdBand(m.savings.usd)}`,
      `guardian overhead    $${m.overhead.metered_usd.toFixed(4)} metered  ${dim(`(${m.overhead.unmetered_calls} unpriced local judge calls, ${m.overhead.judge_calls} total)`)}`,
      '',
      `priced actions       ${fmtInt(m.savings.priced_actions)}`,
      `NOT priced           ${fmtInt(m.savings.unpriced_actions)}  ${dim('credential exposure and shell execution')}`,
      '',
      dim(`reference price      ${m.savings.reference.model}  $${m.savings.reference.input_per_mtok}/MTok in, $${m.savings.reference.output_per_mtok}/MTok out`),
      dim(`                     checked ${m.savings.reference.priced_on}`),
      dim(`                     ${m.savings.reference.source.replace(/^https:\/\//, '')}`),
      dim(`assumed per turn     ${fmtInt(TURN_TOKENS.low)}-${fmtInt(TURN_TOKENS.high)} marginal tokens`),
    ]));
    out.push('');
    out.push('  ' + warn('These savings are an ESTIMATE built from assumptions, not a measurement.'));
    for (const c of m.savings.caveats) out.push(dim(`    - ${c}`));
    out.push('');
    out.push(dim('  Full method, every constant, and how to recompute with your own: docs/METRICS.md'));
    out.push('');

    if (!m.integrity.consistent) {
      out.push(bad('  INTEGRITY CHECK FAILED - these numbers do not add up:'));
      for (const p of m.integrity.problems) out.push(bad(`    ${p}`));
      out.push('');
    } else {
      out.push('  ' + ok('integrity check passed - every derived figure is arithmetically consistent'));
      out.push('');
    }
    process.stdout.write(out.join('\n'));
    return m.integrity.consistent ? 0 : 1;
  } finally { store.close(); }
}

/**
 * `usewarden telemetry <on|off|status>`.
 *
 * Turning it ON is a two-step consent flow, not a flag flip:
 *
 *   1. the exact payload that would be sent is printed FIRST, built from this machine's real
 *      numbers, so there is nothing to take on trust;
 *   2. the user confirms - interactively, or with `--yes` in a script - and only then is a
 *      consent receipt written naming the schema version and every field it covers.
 *
 * `telemetryEnabled()` requires that receipt. Flipping the setting in the database without one
 * changes nothing (SAB-23), and bumping the payload schema invalidates every existing receipt,
 * so a later version cannot inherit a yes the user gave to a smaller payload.
 */
async function cmdTelemetry(mode: string | undefined, json: boolean, flags: Set<string>): Promise<number> {
  const store = new Store();
  try {
    if (mode !== 'on' && mode !== 'off' && mode !== 'status') {
      process.stderr.write('usewarden: telemetry <on|off|status> [--yes] [--purge]\n');
      return 2;
    }
    const tm = await import('./telemetry.js');
    const report = buildStatus(store, process.cwd());
    const payload = tm.buildPayload(store, VERSION,
      report.agents.map((a) => a.agent),
      report.checklist.filter((c) => c.done).map((c) => c.step));

    let purged: string | null = null;
    if (mode === 'off') {
      store.setMeta('telemetry', 'off');
      tm.revokeConsent();
      if (flags.has('--purge')) purged = tm.purgeRecorded();
    }

    if (mode === 'on') {
      const already = tm.consentIsCurrent(tm.readConsent());
      if (!already) {
        const agreed = await confirmConsent(payload, json, flags);
        if (!agreed) {
          emit(json, { setting: store.getMeta('telemetry') ?? 'off', effective: false, consented: false },
            () => ok('Telemetry left OFF. Nothing was recorded and no consent was stored.'));
          return 0;
        }
        tm.grantConsent(VERSION);
      }
      store.setMeta('telemetry', 'on');
    }

    const reason = tm.telemetryOffReason(store);
    const effective = reason === null;
    let recorded: string | undefined;
    if (effective) { recorded = tm.record(store, payload); tm.send(payload); }
    const receipt = tm.readConsent();

    emit(json, {
      setting: store.getMeta('telemetry') ?? 'off',
      effective,
      offReason: reason,
      doNotTrack: process.env['DO_NOT_TRACK'] === '1',
      endpoint: tm.endpoint(),
      recordedTo: recorded,
      purged,
      consent: receipt,
      consentCurrent: tm.consentIsCurrent(receipt),
      schemaVersion: tm.SCHEMA_VERSION,
      payload,
    }, () => effective
      ? [
        warn('Telemetry ON.'),
        dim('  Counts and coarse categories only - never a path, prompt, command or file content.'),
        dim('  Real-session figures only: a "usewarden demo" run can never move a number that leaves'),
        dim('  this machine (docs/METRICS.md).'),
        dim(`  v1 ships NO endpoint: the payload is written to ${recorded} and goes nowhere.`),
        receipt ? dim(`  Consent recorded ${new Date(receipt.granted_at).toISOString()} for schema v${receipt.schema_version},`) : '',
        receipt ? dim(`  covering exactly: ${receipt.fields.join(', ')}. A schema change revokes it.`) : '',
        dim('  Schema: docs/TELEMETRY.md. This is exactly what would be sent:'),
        indent(JSON.stringify(payload, null, 2)),
      ].filter(Boolean).join('\n')
      : [
        ok('Telemetry OFF.'),
        dim('  ' + tm.explainOffReason(reason)),
        purged ? dim(`  Purged locally recorded payloads: ${purged}`) : '',
        flags.has('--purge') && !purged ? dim('  Nothing to purge - no local payloads were recorded.') : '',
      ].filter(Boolean).join('\n'));
    return 0;
  } finally { store.close(); }
}

/**
 * Shows the payload and asks. Non-interactive callers must pass `--yes`; a script that pipes
 * usewarden somewhere must not be able to opt in by accident, and a prompt with nowhere to read
 * an answer from must default to no rather than block.
 */
async function confirmConsent(payload: unknown, json: boolean, flags: Set<string>): Promise<boolean> {
  if (flags.has('--yes') || flags.has('-y')) return true;
  if (json || !process.stdin.isTTY) {
    process.stderr.write('usewarden: telemetry on needs an explicit --yes when it cannot ask.\n'
      + '           Run "usewarden telemetry status" first to read the exact payload.\n');
    return false;
  }
  process.stdout.write('\n' + head('  Telemetry opt-in') + '\n\n');
  process.stdout.write(dim('  This is EXACTLY what usewarden would record. There is no endpoint in v1,\n'));
  process.stdout.write(dim('  so it goes to a local file and nowhere else.\n\n'));
  process.stdout.write(indent(JSON.stringify(payload, null, 2)) + '\n\n');
  process.stdout.write('  Record this? [y/N] ');
  const answer = await readLineOnce();
  process.stdout.write('\n');
  return /^y(es)?$/i.test(answer.trim());
}

function readLineOnce(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) { cleanup(); resolve(buf.split('\n')[0]!); }
    };
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export { isUnlocked };

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`usewarden: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  });

/**
 * `usewarden scan` — see src/scan.ts for why this exists and what it deliberately does not do.
 *
 * Read-only by construction: it opens the store only to ask whether hooks are registered, records
 * nothing, and moves no counter. The closing line of the output depends on that answer, because
 * telling someone their project is guarded when they have not run `init` is the precise lie
 * `status` exists to prevent.
 */
/**
 * `usewarden allow` — the escape hatch, with a fuse and an audit trail.
 *
 * The point of failure this exists to prevent is a person mid-task with a legitimate action refused
 * and no way past it but editing a policy file. The point of failure it must NOT introduce is an
 * agent finding the same command. See src/exceptions.ts.
 */
function cmdAllow(rest: string[], json: boolean, flags: Set<string>): number {
  const root = findRepoRoot(process.cwd()) ?? process.cwd();
  const now = Date.now();

  if (flags.has('--list')) {
    const live = loadExceptions(now);
    if (json) { emit(true, { exceptions: live }, () => ''); return 0; }
    if (live.length === 0) {
      process.stdout.write(`\n  ${ok('No waivers are active.')} ${dim('Every rule in your policy is enforced.')}\n\n`);
      return 0;
    }
    process.stdout.write(`\n  ${head('active waivers')}\n\n`);
    for (const x of live) {
      process.stdout.write(`  ${warn('·')} ${head(x.rule)}  ${dim(remaining(x, now))}\n`);
      process.stdout.write(dim(`      in ${displayPath(x.scope)}\n`));
      if (x.note) process.stdout.write(dim(`      "${x.note}"\n`));
    }
    process.stdout.write(dim('\n  Revoke one early:  usewarden allow --revoke <rule-id>\n\n'));
    return 0;
  }

  const revoking = flags.has('--revoke');
  const rule = rest[0] ?? '';
  if (rule === '' || rule.startsWith('--')) {
    process.stderr.write('usewarden: allow needs a rule id, e.g.  usewarden allow dotenv-access\n'
      + '           the id is printed on the incident card as  rule  commands.deny[6] (dotenv-access)\n');
    return 2;
  }

  // THE GUARD, BEFORE ANYTHING IS WRITTEN. An escape hatch an agent can operate is not a guardrail.
  const refusal = refuseIfNotHuman();
  if (refusal) {
    if (json) { emit(true, { error: 'not_interactive', detail: refusal }, () => ''); return 3; }
    process.stderr.write(`\n  ${bad('REFUSED')}\n  ${refusal}\n\n`);
    return 3;
  }

  if (revoking) {
    const n = revokeException(rule, root, now);
    emit(json, { revoked: n, rule, scope: root }, () => n > 0
      ? ok(`Revoked the waiver on "${rule}". That rule is enforced again from the next event.`)
      : warn(`No active waiver on "${rule}" in this project. Nothing changed.`));
    return 0;
  }

  const ex = addException(rule, root, DEFAULT_TTL_HOURS, undefined, now);
  emit(json, ex, () => [
    '',
    `  ${warn('WAIVED')}  ${head(rule)}  ${dim(`in ${displayPath(root)}`)}`,
    '',
    `  It expires in ${DEFAULT_TTL_HOURS} hours and cannot be renewed by an agent.`,
    `  Attempts it lets through are still recorded and still appear on your receipt —`,
    `  a waiver changes the verdict, not the audit trail.`,
    '',
    `  ${dim('End it early:')}  usewarden allow --revoke ${rule}`,
    '',
  ].join('\n'));
  return 0;
}

/**
 * `usewarden last` — the receipt for the most recent session.
 *
 * Prints at session end and never mid-session: there is no notification, no daemon and no
 * interruption anywhere in this path. The user runs it, or the status line carries the short form.
 */
function cmdLast(json: boolean, sessionId?: string): number {
  const store = new Store();
  try {
    // An explicit id makes a specific receipt reproducible - which is what a captured verification
    // artifact needs, since "the most recent session" stops being the same session a minute later.
    const id = sessionId && sessionId !== '' ? sessionId : latestSessionId(store);
    if (id === null) {
      // LOUD, and deliberately not shaped like a receipt. "No session recorded" and "a session in
      // which nothing was blocked" are opposite facts and must never render alike.
      if (json) { emit(true, { error: 'no_session_found', sessions: 0 }, () => ''); return 1; }
      process.stdout.write(renderNoSession('usewarden has no session recorded in this database.'));
      return 1;
    }
    const r = buildReceipt(store, id);
    if (r === null) {
      if (json) { emit(true, { error: 'no_session_found', sessions: 0 }, () => ''); return 1; }
      process.stdout.write(renderNoSession(`session ${id} is listed but has no readable record.`));
      return 1;
    }
    if (json) { emit(true, receiptJson(r), () => ''); return 0; }
    process.stdout.write(renderReceipt(r));
    return 0;
  } finally { store.close(); }
}

/** `usewarden sessions` — the last N, one line each. */
function cmdSessions(json: boolean, limit: number): number {
  const store = new Store();
  try {
    const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
    const ids = recentSessionIds(store, n);
    const receipts = ids.map((id) => buildReceipt(store, id)).filter((r): r is NonNullable<typeof r> => r !== null);
    if (receipts.length === 0) {
      if (json) { emit(true, { error: 'no_session_found', sessions: [] }, () => ''); return 1; }
      process.stdout.write(renderNoSession('usewarden has no session recorded in this database.'));
      return 1;
    }
    if (json) { emit(true, { sessions: receipts.map(receiptJson) }, () => ''); return 0; }
    const out = ['', `  ${head('usewarden sessions')}  ${dim(`${receipts.length} most recent`)}`, ''];
    for (const r of receipts) out.push(renderReceiptLine(r));
    out.push('');
    out.push(`  ${dim('!')} blocked   ${dim('~')} warned   ${dim('·')} clean   ${dim('· time = last activity ·')}  ${dim('usewarden last')}`);
    out.push('');
    process.stdout.write(out.join('\n'));
    return 0;
  } finally { store.close(); }
}

function cmdScan(json: boolean): number {
  const store = new Store();
  try {
    const registered = buildStatus(store, process.cwd()).agents.some((a) => a.registered);
    const r = scan(process.cwd(), registered);
    if (json) { emit(true, r, () => ''); return 0; }
    process.stdout.write(renderScan(r));
    return 0;
  } finally { store.close(); }
}
