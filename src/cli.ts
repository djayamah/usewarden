#!/usr/bin/env node
import { displayPath, mkdirpSafe, resolveUserPath } from './util.js';
import './boot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './store.js';
import { scan, renderScan } from './scan.js';
import { buildWeek, renderWeek } from './week.js';
import { ageOfNewest, backupCorpus } from './backup.js';
import { POLICY_INPUTS, cannotEverFire, unsupportedFields, whyUnsupported } from './policy/inputs.js';
import {
  DEFAULT_TTL_HOURS, addException, loadExceptions, refuseIfNotHuman, remaining, revokeException,
} from './exceptions.js';
import {
  buildReceipt, latestSessionId, recentSessionIds, receiptJson,
  renderNoSession, renderReceipt, renderReceiptLine,
} from './receipt.js';
import { runHook } from './hook.js';
import { ensureHome, globalPolicyPath, policySealPath, usewardenHome } from './paths.js';
import { driftLines, isWeaker, sealPolicy, type DriftReport } from './policy/drift.js';
import { detectAgents } from './install/detect.js';
import { applyInit, latestBackupDir, nodePath, planInit, restoreConfigs, uninstall, usewardenScriptPath } from './install/installer.js';
import { ago, buildStatus, firingFinding, isUnlocked, relock, unlock, type DoctorFinding, type StatusReport } from './status.js';
import { findRepoRoot, loadPolicy, PolicyLoadError, starterPolicyYaml, trust, untrust } from './policy/load.js';
import { bad, box, checkbox, dim, head, ok, paint, stateBadge, table, warn, wrapLine } from './term.js';
import { buildMetrics, fmtInt, fmtTokenBand, fmtUsdBand, TURN_TOKENS, TURNS_WASTED } from './metrics.js';
import { buildValueReport } from './value.js';
import { defaultLabelsFile } from './paths.js';

const VERSION = '0.1.2';

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
  week [DAYS]           What your agents actually did in the last 7 days (real
                        sessions only, never demo or fixture). Nothing is recorded
                        means usewarden was not watching - that is not a quiet week
  backup [--to DIR]     Write one verified copy of the record to a directory that
                        your own backup already reaches. VACUUM INTO, integrity-
                        checked and row-counted before it is called a snapshot.
                        --if-older-than N skips when the last one is under N hours;
                        --keep N sets how many are retained (default 7)
  replay [--origin O]   Re-run every stored incident against the CURRENT rules and report,
                        per incident, blocked-then / blocked-now / changed. The record
                        is the only thing that can tell you whether a rule change fixed
                        a false positive or quietly dropped a real catch. --policy FILE
                        replays against a ruleset other than the one in force;
                        --changed-only hides rows nothing happened to; --labels FILE
                        adds precision and coverage from a frozen label set
  demo                  Run a safe simulated violation and show a real incident card
  incidents             Show the incident wall
  metrics               Every number usewarden reports, how it was derived, and what
                        it deliberately refuses to estimate
  dashboard             Serve the local read-only dashboard on 127.0.0.1
  doctor [--strict]     Diagnose why usewarden might not be firing (--strict: UNVERIFIED exits 1)
  policy [--drift]      Print the effective policy and where each part came from.
                        --drift: what your rules USED TO CATCH and no longer do, measured by
                        replaying both rulesets - not a diff of the file
  reseal                Accept the policy in force as the new baseline. Do this only when you
                        made the change yourself and meant it
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
    case 'doctor': return cmdDoctor(json, flags.has('--strict'));
    case 'incidents': return cmdIncidents(json, Number(args[1] ?? 20));
    case 'policy': return argv.includes('--drift') ? cmdPolicyDrift(json) : cmdPolicy(json);
    case 'reseal': return cmdReseal(json);
    case 'metrics': return cmdMetrics(json);
    case 'replay': return (await import('./cli-replay.js')).cmdReplay(argv, json);
    case 'demo': return (await import('./demo.js')).runDemo(json);
    case 'scan': return cmdScan(json);
    case 'last': return cmdLast(json, args[1]);
    case 'allow': return cmdAllow(args.slice(1), json, flags);
    case 'sessions': return cmdSessions(json, Number(args[1] ?? 20));
    case 'week': return cmdWeek(json, Number(args[1] ?? 7));
    case 'backup': return cmdBackup(argv, json);
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

    // SEAL THE RULES, NOT JUST THE REGISTRATIONS. `applyInit` records an integrity hash for every
    // agent config it touched, which is how TAMPERED is detected. Until 0.1.2 nothing did the
    // equivalent for usewarden's OWN policy, so an edit that narrowed it was invisible to every
    // surface — see the incident in src/policy/drift.ts. Re-sealing on every `init` is deliberate:
    // `init` is a human running a command, which is exactly the authority a new baseline needs.
    sealPolicy('install');

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

  // ABOVE THE AGENT TABLE, DELIBERATELY.
  //
  // Every row of that table is about the AGENTS' hook registrations. On 2026-08-29 all of them
  // were green — registered, unmodified, firing — for ten days while usewarden's own rules had
  // been narrowed by an agent's `sed -i` and 18 blocks that had really happened on this machine
  // would no longer have happened. A weakened ruleset is not a footnote to a PROTECTED badge; it
  // is the thing that makes the badge mean less than it says.
  if (isWeaker(r.drift)) {
    const lines = driftLines(r.drift);
    out.push(bad('  ' + lines[0]!));
    for (const l of lines.slice(1)) out.push(l.startsWith('  ·') ? dim('  ' + l) : '  ' + l);
    out.push('');
  }

  // A LAST FIRED COLUMN, because STATE alone answers the wrong question.
  //
  // STATE is read from a config file. It says the entries are there and unmodified, which is
  // exactly what it said while every hook was dying on EACCES (writeups/01-hook-not-running).
  // The column beside it is the only one that is evidence of execution, and putting them side by
  // side is the point: a row reading PROTECTED / never is the shape of the bug.
  const rows: string[][] = [[dim('AGENT'), dim('STATE'), dim('LAST FIRED'), dim('CONFIG')]];
  for (const a of r.agents) {
    const f = a.firing;
    const fired = f.verdict === 'firing' ? dim(ago(f.lastEventTs!))
      : f.verdict === 'pending' ? dim('not yet')
        : warn('never');
    rows.push([`${a.label} ${dim('(' + a.scope + ')')}`, stateBadge(a.state), fired, dim(displayPath(a.configPath))]);
  }
  out.push(table(rows).split('\n').map((l) => '  ' + l).join('\n'));
  out.push('');
  for (const a of r.agents) {
    if (a.state !== 'PROTECTED') out.push(`  ${bad(a.label + ':')} ${a.detail}`);
    if (a.caveat) out.push(`  ${warn('note')} ${a.label}: ${a.caveat}`);
    if (a.firing.verdict === 'unverified') {
      // Not red, and not silent. Usewarden genuinely cannot tell "you have not opened this agent"
      // from "its hooks do not execute" - so it reports the fact and the two readings, rather
      // than picking one. Claiming the first would be the silent-guardian failure; claiming the
      // second would be the false alarm that teaches people to ignore the tool.
      out.push(`  ${warn('UNVERIFIED')} ${a.label} is registered but usewarden has never seen it fire.`);
      out.push(dim('             Registration is not evidence of execution. Run any command in that'));
      out.push(dim('             agent, then "usewarden doctor" - or the hooks are not running.'));
    }
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

/**
 * `usewarden doctor` — "Diagnose why usewarden might not be firing".
 *
 * IT DID NOT USED TO CHECK WHETHER ANYTHING HAD FIRED. Six checks, every one of them a question
 * about a config file: does the path resolve, does the script exist, do the entries match the
 * hash, does the command point at us. All six can pass while not one hook has ever executed —
 * which is exactly writeups/01-hook-not-running, where the entries were perfect and every spawn
 * died with EACCES. The write-up's own closing line is "the check you want is not 'is it
 * configured'. It is how many times has it run, and when was the last one", and the command
 * named after that question was not asking it. Found 2026-09-08 (D-267); at the time, this
 * repository's own state had Codex CLI registered for two weeks with zero events and doctor
 * reported PASS on every Codex row.
 *
 * THE THIRD OUTCOME. A registered agent with no events is not a failure — the user may simply not
 * have opened it. Nor is it a pass. It is UNVERIFIED, in the sense CLAUDE.md §4.4 and
 * scripts/verify-all.sh already use: reported by name, counted separately, and never folded into
 * the green. `--strict` turns UNVERIFIED into a non-zero exit for anyone gating on it.
 */
function cmdDoctor(json: boolean, strict = false): number {
  const store = new Store();
  try {
    const r = buildStatus(store, process.cwd());
    const findings: DoctorFinding[] = [];
    findings.push({ check: 'node binary resolves to an absolute path', ok: path.isAbsolute(nodePath()), detail: nodePath() });
    findings.push({ check: 'node binary exists and is executable', ok: isExecutable(nodePath()), detail: nodePath() });
    findings.push({ check: 'usewarden script resolves to an absolute path', ok: path.isAbsolute(usewardenScriptPath()), detail: usewardenScriptPath() });
    findings.push({ check: 'usewarden script exists on disk', ok: fs.existsSync(usewardenScriptPath()), detail: usewardenScriptPath() });
    findings.push({ check: 'state directory writable', ok: canWrite(usewardenHome()), detail: usewardenHome() });
    findings.push({ check: 'policy loads', ok: !r.policyError, detail: r.policyError ?? r.policySources.join(' -> ') });
    // THE ROW THAT WAS MISSING ON 2026-08-29. Every other check in this command reads an AGENT's
    // config; this one reads usewarden's. UNVERIFIED rather than PASS when there is nothing to
    // compare against, because "I have no baseline" and "nothing was weakened" are different
    // sentences and this is the command where the difference matters most.
    findings.push(driftFinding(r.drift));
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
      // Last, and the only one that is evidence rather than bookkeeping.
      if (a.registered) findings.push(firingFinding(a));
    }
    const failed = findings.filter((f) => !f.ok && !f.unverified);
    const unverified = findings.filter((f) => f.unverified);
    const exit = failed.length > 0 ? 1 : (strict && unverified.length > 0) ? 1 : 0;

    if (json) {
      emit(true, { overall: r.overall, findings, unverified: unverified.length, strict }, () => '');
      return exit;
    }
    process.stdout.write('\n' + table([[dim('  '), dim('CHECK'), dim('DETAIL')],
      ...findings.map((f) => [f.unverified ? warn('UNVERIFIED') : f.ok ? ok('PASS') : bad('FAIL'), f.check, dim(f.detail)])]) + '\n\n');
    if (unverified.length > 0) {
      // Deliberately not folded into the PASS count. A control whose state could not be checked
      // is reported as UNVERIFIED and counted against the total (CLAUDE.md §4.4) - "I could not
      // tell" and "it is fine" are different sentences, and this is the command where the
      // difference matters most.
      process.stdout.write(warn(`  ${unverified.length} check${unverified.length === 1 ? '' : 's'} UNVERIFIED - not a pass.\n`));
      process.stdout.write(dim('  Usewarden could not observe these working. Registration is not evidence of execution.\n'));
      if (!strict) process.stdout.write(dim('  "usewarden doctor --strict" exits non-zero on these, for scripts and CI.\n'));
      process.stdout.write('\n');
    }
    return exit;
  } finally { store.close(); }
}

/**
 * One `doctor` row for the policy itself.
 *
 * The detail line names a NUMBER, not a state, when something has been lost: "3 protections you
 * installed no longer fire" is actionable and "policy drift detected" is not. The distinction is
 * the same one docs/VALUE-DELIVERED.md makes about every other figure this tool prints.
 */
function driftFinding(d: DriftReport): DoctorFinding {
  if (d.unavailable) {
    return { check: 'policy is no weaker than the one you installed', ok: false, unverified: true,
      detail: d.unavailable };
  }
  if (!isWeaker(d)) {
    return { check: 'policy is no weaker than the one you installed', ok: true,
      detail: d.changed ? 'edited since install, and nothing it caught has been lost'
        : 'unchanged since it was sealed' };
  }
  const lost = d.lostProbes.length;
  const caught = d.lostCatches.length;
  const down = d.downgradedProbes.length;
  const bits: string[] = [];
  if (caught > 0) bits.push(`${caught} real block${caught === 1 ? '' : 's'} on this machine would not happen now`);
  if (lost > 0) bits.push(`${lost} installed protection${lost === 1 ? '' : 's'} no longer fire${lost === 1 ? 's' : ''}`);
  if (down > 0) bits.push(`${down} downgraded from absolute to project-conditional`);
  return { check: 'policy is no weaker than the one you installed', ok: false,
    detail: `${bits.join('; ')} - run "usewarden policy --drift" for the list` };
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

/**
 * `usewarden policy --drift` — the full list behind the one-line finding in `status` and `doctor`.
 *
 * It prints what was LOST, in two sections that are deliberately not merged: real blocks that
 * happened on this machine and would not happen now, and installed protections that no longer
 * fire. The first is evidence; the second is coverage. A user believes the first and needs the
 * second, and a single blended count would hide which of the two a given machine actually has.
 */
function cmdPolicyDrift(json: boolean): number {
  const store = new Store();
  try {
    const d = buildStatus(store, process.cwd(), 'full').drift;
    if (json) { emit(true, d, () => ''); return isWeaker(d) ? 1 : 0; }
    process.stdout.write('\n' + head('  policy drift') + '\n\n');
    if (d.seal) {
      const when = new Date(d.seal.sealedAt).toISOString().slice(0, 10);
      process.stdout.write(dim(`  sealed ${when} (${d.seal.reason}) — ${displayPath(policySealPath())}\n`));
      process.stdout.write(dim(`  in force            — ${displayPath(globalPolicyPath())}\n`));
      process.stdout.write(dim(`  bytes ${d.changed ? 'DIFFER' : 'identical'}; ${d.corpusConsidered} recorded block(s) replayed\n\n`));
    }
    if (d.unavailable) {
      process.stdout.write(warn(`  UNVERIFIED: ${d.unavailable}\n\n`));
      return 0;
    }
    if (!isWeaker(d)) {
      for (const l of driftLines(d)) process.stdout.write(ok(`  ${l}\n`));
      if (d.gainedProbes.length > 0) {
        process.stdout.write(dim(`\n  ${d.gainedProbes.length} protection(s) were ADDED since the seal:\n`));
        for (const p of d.gainedProbes) process.stdout.write(dim(`    + ${p.label}\n`));
      }
      process.stdout.write('\n');
      return 0;
    }
    process.stdout.write(bad('  YOUR RULES ARE WEAKER THAN THE ONES YOU INSTALLED.\n\n'));
    if (d.lostCatches.length > 0) {
      process.stdout.write(bad(`  ${d.lostCatches.length} thing(s) usewarden really stopped on this machine would NOT be stopped now:\n`));
      for (const l of d.lostCatches) {
        process.stdout.write(`    ${dim(new Date(l.ts).toISOString().slice(0, 10))}  ${l.attempted}\n`);
      }
      process.stdout.write('\n');
    }
    if (d.lostProbes.length > 0) {
      process.stdout.write(bad(`  ${d.lostProbes.length} protection(s) you installed no longer fire:\n`));
      for (const p of d.lostProbes) process.stdout.write(`    ${bad('·')} ${p.label} ${dim('(' + p.ruleThen + ')')}\n`);
      process.stdout.write('\n');
    }
    if (d.downgradedProbes.length > 0) {
      const n = d.downgradedProbes.length;
      process.stdout.write(warn(`  ${n} more ${n === 1 ? 'is' : 'are'} still refused, but only because of where you happen\n`));
      process.stdout.write(warn(`  to be working. ${n === 1 ? 'It used' : 'They used'} to be refused everywhere, from any project:\n`));
      for (const p of d.downgradedProbes) {
        process.stdout.write(`    ${warn('·')} ${p.label} ${dim(p.ruleThen + ' -> ' + p.ruleNow)}\n`);
      }
      process.stdout.write('\n');
    }
    if (d.gainedProbes.length > 0) {
      process.stdout.write(dim(`  ${d.gainedProbes.length} protection(s) were added in the same edit — this does not cancel the losses above:\n`));
      for (const p of d.gainedProbes) process.stdout.write(dim(`    + ${p.label}\n`));
      process.stdout.write('\n');
    }
    process.stdout.write('  ' + dim('If you made this change on purpose, "usewarden reseal" accepts it as the new baseline.\n'));
    process.stdout.write('  ' + dim('If you did not, the rules you installed are still in ' + displayPath(policySealPath()) + '.\n\n'));
    return 1;
  } finally { store.close(); }
}

/**
 * `usewarden reseal` — accept the policy in force as the new baseline.
 *
 * A HUMAN COMMAND, and the reason drift detection is worth having at all. Without it the only way
 * to silence a legitimate policy change would be to ignore the warning, and a warning people learn
 * to ignore is worse than no warning (docs/CHURN-2026-08-27.md). It deliberately prints what it is
 * about to accept before it accepts it.
 */
function cmdReseal(json: boolean): number {
  const store = new Store();
  try {
    const before = buildStatus(store, process.cwd(), 'full').drift;
    const meta = sealPolicy('reseal');
    if (meta === null) {
      if (json) { emit(false, { error: 'no policy to seal' }, () => ''); return 1; }
      process.stderr.write(bad(`\n  There is no policy at ${displayPath(globalPolicyPath())} to seal.\n\n`));
      return 1;
    }
    if (json) { emit(true, { sealed: meta, accepted: before }, () => ''); return 0; }
    process.stdout.write('\n' + ok('  Sealed. This policy is now the baseline.\n'));
    if (isWeaker(before)) {
      process.stdout.write(warn(`  You accepted the loss of ${before.lostProbes.length} protection(s)`
        + ` and ${before.lostCatches.length} recorded catch(es).\n`));
    }
    process.stdout.write(dim(`  ${displayPath(policySealPath())}\n\n`));
    return 0;
  } finally { store.close(); }
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
/**
 * The value block for a terminal. Mirrors the dashboard's, from the same `buildValueReport`, so
 * the two surfaces cannot drift into disagreeing about the same database.
 */
function valueLines(store: Store): string[] {
  const v = buildValueReport({
    store,
    policy: loadPolicy(process.cwd()).policy,
    labelsFile: defaultLabelsFile(),
  });
  const out: string[] = ['  ' + head('VALUE — was it right?')];
  if (!v.precision.available) {
    out.push('  ' + warn('precision   unavailable'));
    for (const line of wrapLine(v.precision.reason, 74)) out.push('    ' + dim(line));
    out.push('');
    return out;
  }
  const p = v.precision.value;
  out.push(`  precision   ${ok(`${p.pct.toFixed(1)}%`)}  ${dim(`(${p.truePositives} of ${p.denominator} blocks that fire today are ones a developer would want)`)}`);
  if (v.coverage.available) {
    const c = v.coverage.value;
    out.push(`  coverage    ${c.pct >= 100 ? ok(`${c.pct.toFixed(1)}%`) : warn(`${c.pct.toFixed(1)}%`)}  ${dim(`(${c.caught} of the ${c.total} real catches in the corpus still fire)`)}`);
  } else {
    out.push(`  coverage    ${warn('unavailable')}  ${dim(v.coverage.reason)}`);
  }
  if (v.labelSet.available) {
    const l = v.labelSet.value;
    out.push('  ' + dim(`from ${l.labelled} incidents labelled ${l.labelledAt}, frozen at ${l.hash.slice(0, 16)}…`));
  }
  if (v.truePositivesBySeverity.available) {
    const bands = v.truePositivesBySeverity.value.map((r) => `${r.severity} ${r.count}`).join('  ·  ');
    out.push('  ' + dim(`caught by severity: ${bands}`));
  }
  if (v.falsePositivesByClass.available) {
    const still = v.falsePositivesByClass.value.filter((r) => r.now > 0);
    out.push('  ' + dim(still.length === 0
      ? 'no labelled false positive still fires'
      : `false positives still firing: ${still.map((r) => `${r.name} ${r.now}/${r.then}`).join(', ')}`));
  }
  out.push('');
  return out;
}

function cmdMetrics(json: boolean): number {
  const store = new Store();
  try {
    const m = buildMetrics(store);
    if (json) {
      process.stdout.write(JSON.stringify({
        ...m,
        value: buildValueReport({
          store,
          policy: loadPolicy(process.cwd()).policy,
          labelsFile: defaultLabelsFile(),
        }),
        constants: { turn_tokens: TURN_TOKENS, turns_wasted: TURNS_WASTED },
      }, null, 2) + '\n');
      return m.integrity.consistent ? 0 : 1;
    }

    const out: string[] = [''];
    out.push('  ' + head('usewarden metrics'));
    out.push('');
    // VALUE FIRST, AND ON THIS SURFACE TOO. The dashboard was rebuilt around value on
    // 2026-09-08; leaving `metrics` reporting activity alone would have fixed the surface being
    // worked on and left the one documented as "every number usewarden reports" saying the
    // opposite thing. That failure has its own entry (D-273) and this is the same shape.
    out.push(...valueLines(store));
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

/**
 * `usewarden backup [--to DIR] [--keep N]`
 *
 * The record is the thing usewarden claims is worth having (docs/RETENTION.md §2), and until this
 * command existed it lived in exactly one file on exactly one disk with no way to get a copy of it
 * that was safe to take while agents were writing. See src/backup.ts for why `cp` is not that way.
 */
function cmdBackup(argv: string[], json: boolean): number {
  const toIdx = argv.indexOf('--to');
  const keepIdx = argv.indexOf('--keep');
  const pol = loadPolicy(findRepoRoot(process.cwd()) ?? process.cwd());
  const dir = toIdx >= 0 ? argv[toIdx + 1] : (pol.policy.backup.dir ?? undefined);
  const keep = keepIdx >= 0 ? Number(argv[keepIdx + 1]) : pol.policy.backup.keep;

  if (!dir || dir.startsWith('-')) {
    process.stderr.write(
      bad('usewarden backup needs a destination.') + '\n' +
      'Give it one that your own backup already reaches:\n\n' +
      '  usewarden backup --to ~/some/backed-up/dir\n\n' +
      'Or set it once, in ~/.usewarden/usewarden.yaml, and session_end will keep it fresh:\n\n' +
      '  backup:\n    dir: ~/some/backed-up/dir\n    every_hours: 12\n    keep: 7\n');
    return 2;
  }

  // `--if-older-than N` makes this safe to call from something that runs often (a git hook, a
  // wrapper script) without writing a 6 MB file every time. A no-op is exit 0 and one line.
  const olderIdx = argv.indexOf('--if-older-than');
  const resolved = resolveUserPath(dir);
  if (olderIdx >= 0) {
    const hours = Number(argv[olderIdx + 1]);
    if (!Number.isFinite(hours) || hours < 0) {
      process.stderr.write(bad('--if-older-than needs a number of hours.') + '\n');
      return 2;
    }
    const age = ageOfNewest(resolved);
    if (age !== null && age < hours * 3600_000) {
      const h = (age / 3600_000).toFixed(1);
      emit(json, { skipped: true, ageHours: Number(h), threshold: hours }, () =>
        dim(`Snapshot is ${h}h old, under the ${hours}h threshold. Nothing to do.`));
      return 0;
    }
  }

  try {
    const r = backupCorpus(resolved, { keep: Number.isFinite(keep) ? keep : 7 });
    emit(json, {
      file: r.file, receipt: r.receipt, bytes: r.bytes, sha256: r.sha256,
      counts: r.counts, pruned: r.pruned, ms: r.ms,
    }, () =>
      ok(`Snapshot written and verified in ${r.ms} ms.`) + '\n\n' +
      table([
          // displayPath, for the reason src/util.ts gives about it: a receipt is a thing people
          // screenshot, and an absolute path carries the account name with it. The JSON above
          // keeps the real path, because that one is for a machine.
          ['File', displayPath(r.file)],
          ['Size', `${(r.bytes / 1024 / 1024).toFixed(2)} MB`],
          ['SHA-256', r.sha256],
          ['Sessions', String(r.counts.sessions)],
          ['Events', String(r.counts.events)],
          ['Incidents', `${r.counts.incidents} (${r.counts.liveIncidents} from real sessions)`],
          ['integrity_check', 'ok'],
      ]) + '\n' +
      dim(r.pruned.length > 0 ? `Pruned ${r.pruned.length} older snapshot(s).` : 'Nothing pruned.') + '\n' +
      dim('This is a database, not a dump. Open it with: USEWARDEN_HOME=<dir> usewarden week 3650'));
    return 0;
  } catch (e) {
    process.stderr.write(bad(`usewarden backup failed: ${(e as Error).message}`) + '\n');
    return 1;
  }
}

function cmdWeek(json: boolean, days: number): number {
  const store = new Store();
  try {
    const n = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
    const w = buildWeek(store, n, Date.now());
    if (json) {
      emit(true, {
        days: w.days, since: new Date(w.since).toISOString(),
        sessions: w.sessions, events: w.events, blocked: w.blocked, warned: w.warned,
        agents: w.agents, projects: w.projects, byRule: w.byRule,
        nothingRecorded: w.nothingRecorded,
      }, () => '');
      // Exit 1 when nothing was recorded: a script asking "is usewarden watching?" must be able
      // to tell that apart from a quiet week, and stdout alone would not.
      return w.nothingRecorded ? 1 : 0;
    }
    process.stdout.write(renderWeek(w));
    return w.nothingRecorded ? 1 : 0;
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
