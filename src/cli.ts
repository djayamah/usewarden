#!/usr/bin/env node
import { displayPath, mkdirpSafe } from './util.js';
import './boot.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './store.js';
import { runHook } from './hook.js';
import { ensureHome, globalPolicyPath, usewardenHome } from './paths.js';
import { detectAgents } from './install/detect.js';
import { applyInit, latestBackupDir, nodePath, planInit, restoreConfigs, uninstall, usewardenScriptPath } from './install/installer.js';
import { buildStatus, isUnlocked, relock, unlock, type StatusReport } from './status.js';
import { findRepoRoot, loadPolicy, PolicyLoadError, starterPolicyYaml, trust, untrust } from './policy/load.js';
import { bad, box, checkbox, dim, head, ok, paint, stateBadge, table, warn } from './term.js';

const VERSION = '0.1.0';

const USAGE = `usewarden ${VERSION} - a firewall for your AI coding agents

USAGE
  usewarden <command> [options]

COMMANDS
  init                  Detect agents, preview config changes, register hooks
  status                Is usewarden actually protecting you right now?
  demo                  Run a safe simulated violation and show a real incident card
  incidents             Show the incident wall
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

  if (flags.has('-h') || flags.has('--help') || cmd === 'help' || cmd === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags.has('-V') || flags.has('--version')) {
    process.stdout.write(json ? JSON.stringify({ version: VERSION }) + '\n' : VERSION + '\n');
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
    case 'demo': return (await import('./demo.js')).runDemo(json);
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
    case 'telemetry': return cmdTelemetry(args[1] ?? 'status', json);
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
  const { maybeJudge, selectProvider, pricingStaleness, providerSpecs } = await import('./engine/judge.js');
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

    if (json) {
      process.stdout.write(JSON.stringify({
        ok: passed, provider: out.provider ?? cfg.provider, model: out.model ?? cfg.model,
        metered: cfg.metered, ran: out.ran, driftDetected, latencyMs: ms,
        costUsd: out.costUsd, ledgerDelta,
        pricedOn: cfg.metered ? providerSpecs()[cfg.provider as 'anthropic' | 'openai' | 'gemini'].pricedOn : null,
        verdict: out.verdict ? out.verdict.reason : null,
        warning: out.warning ?? null, pricingWarning: stale,
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
      emit(json, { agents: [], error: 'no agents detected' }, () =>
        bad('No AI coding agents detected on this machine.') + '\n' +
        dim('Usewarden probes: ' + detections.map((d) => d.configPath).join(', ')));
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

  out.push(box('Getting started', r.checklist.map((c) => `${checkbox(c.done)} ${c.label}`)));
  out.push('');

  const c = r.counters;
  out.push(box('What usewarden has done', [
    `actions blocked      ${paint(String(c['actions_blocked'] ?? 0), 'bold')}`,
    `drift warnings       ${paint(String(c['drift_caught'] ?? 0), 'bold')}`,
    `events inspected     ${String(c['events_seen'] ?? 0)}`,
    `catches in REAL sessions  ${paint(String(r.liveCatches), 'bold')} of ${r.totalCatches} total`,
    dim(`judge calls          ${r.judge.calls}`),
    dim(`guardian overhead    $${r.judge.usd.toFixed(4)} metered`),
    dim(`unpriced judge calls ${r.judge.unmetered} on a local CLI, ${r.judge.mocked} mocked`),
  ]));
  out.push('');
  out.push(dim(`  state: ${r.usewardenHome}   policy: ${r.policySources.join(' -> ')}`));
  return out.join('\n');
}

function renderSummary(r: StatusReport): string {
  const lines = r.agents.map((a) => `${a.label}: ${stateBadge(a.state)}`);
  lines.push('');
  lines.push(...r.checklist.map((c) => `${checkbox(c.done)} ${c.label}`));
  lines.push('');
  lines.push(dim('Next: run "usewarden demo" to see a real incident card in under a minute.'));
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
    for (const a of r.agents) {
      findings.push({ check: `${a.label}: hooks registered`, ok: a.registered, detail: a.configPath });
      findings.push({ check: `${a.label}: entries unmodified`, ok: a.hashMatches || r.unlocked, detail: a.detail });
      findings.push({ check: `${a.label}: hooks not globally disabled`, ok: !a.hooksGloballyDisabled, detail: a.hooksGloballyDisabled ? 'disableAllHooks is true' : 'ok' });
      findings.push({ check: `${a.label}: command points at usewarden`, ok: a.commandPointsAtUsewarden, detail: a.detail });
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
    process.stdout.write(indent(JSON.stringify(loaded.policy, null, 2)) + '\n');
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

async function cmdTelemetry(mode: string | undefined, json: boolean): Promise<number> {
  const store = new Store();
  try {
    if (mode !== 'on' && mode !== 'off' && mode !== 'status') {
      process.stderr.write('usewarden: telemetry <on|off|status>\n');
      return 2;
    }
    if (mode !== 'status') store.setMeta('telemetry', mode);
    const tm = await import('./telemetry.js');
    const effective = tm.telemetryEnabled(store);
    const report = buildStatus(store, process.cwd());
    const payload = tm.buildPayload(store, VERSION,
      report.agents.map((a) => a.agent),
      report.checklist.filter((c) => c.done).map((c) => c.step));
    let recorded: string | undefined;
    if (effective) { recorded = tm.record(store, payload); tm.send(payload); }
    emit(json, {
      setting: store.getMeta('telemetry') ?? 'off',
      effective,
      doNotTrack: process.env['DO_NOT_TRACK'] === '1',
      endpoint: tm.endpoint(),
      recordedTo: recorded,
      payload,
    }, () => effective
      ? [
        warn('Telemetry ON.'),
        dim('  Counts and coarse categories only - never a path, prompt, command or file content.'),
        dim(`  v1 ships NO endpoint: the payload is written to ${recorded} and goes nowhere.`),
        dim('  Schema: docs/TELEMETRY.md. This is exactly what would be sent:'),
        indent(JSON.stringify(payload, null, 2)),
      ].join('\n')
      : [
        ok('Telemetry OFF.'),
        process.env['DO_NOT_TRACK'] === '1' ? dim('  DO_NOT_TRACK=1 is set and is honoured, overriding any setting.') : '',
        process.env['USEWARDEN_TELEMETRY'] === '0' ? dim('  USEWARDEN_TELEMETRY=0 is set and is honoured, overriding any setting.') : '',
        dim('  Run "usewarden telemetry on" to see exactly what would be recorded.'),
      ].filter(Boolean).join('\n'));
    return 0;
  } finally { store.close(); }
}

export { isUnlocked };

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`usewarden: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  });
