/**
 * KNOWN FAILURE MODES — the triage bot's entire Layer 1.
 *
 * Every entry here is a defect this project actually shipped and then fixed, or a state the tool
 * is designed to report. That is the point: the most useful thing a triage bot for THIS project
 * can do is recognise its own history, because the seven live-only defects in `DECISIONS.md` are
 * the failure modes most likely to be reported by someone else.
 *
 * Rules this file exists to enforce, all asserted in tests:
 *   - a match NEVER claims the issue is fixed, and never claims to know the cause. It says what
 *     the report LOOKS LIKE and what would confirm or rule it out. A bot that tells a reporter
 *     "this is a known issue, already fixed" when it is not has cost them a day and cost the
 *     project a bug report.
 *   - every entry names the artifact or decision a human can check. If a match cannot point at
 *     evidence, it should not be an entry.
 *   - `ask` is what the reporter should run. It is never more than two commands.
 */

/**
 * Where an issue lands in the maintainer's queue.
 *
 * `unmatched` used to mean three unrelated things at once — a feature request, a question the
 * documents do not answer, and a bug report matching no known failure mode — which made the label
 * useless for the one job a triage label has: telling the maintainer what kind of work an issue
 * is. Issue #14 was labelled `question, unmatched` when what it had actually found was a
 * documentation gap, and nothing in the queue said so. The three are now distinct:
 *
 *   - `docs-gap`  a question the corpus could not answer. This is a DEFECT IN THE DOCUMENTATION
 *                  and it is actionable: write the missing section and the bot answers it next
 *                  time. It is not a judgement about the asker.
 *   - `feature`   a request for something usewarden does not do. Nothing to retrieve, nothing
 *                  missing from the docs; it is a roadmap decision.
 *   - `unmatched` a bug report matching no failure mode the project has recorded. A human has to
 *                  read this one properly, and it is the only one of the three that means that.
 */
export type Route =
  | 'needs-info' | 'likely-known' | 'possible-regression' | 'security'
  | 'docs-gap' | 'feature' | 'unmatched';

export interface FailureMode {
  /** Stable id, used in labels and tests. */
  id: string;
  /** One line, written to be read by the person who filed the issue. */
  summary: string;
  /** Regexes over the issue title + body, lowercased. ANY match counts. */
  signals: RegExp[];
  /** Regexes that DISQUALIFY a match, to keep a common word from over-matching. */
  antiSignals?: RegExp[];
  /** What the reporter should run or check. Never more than two commands. */
  ask: string;
  /** Where a human can check this — a decision id, a test, or an artifact. */
  evidence: string;
  labels: string[];
  route: Route;
}

export const FAILURE_MODES: FailureMode[] = [
  {
    id: 'hook-not-executing',
    summary: 'The hook process may not be starting at all — `status` can say PROTECTED while every '
      + 'hook invocation dies before it runs.',
    signals: [/eacces/, /posix_spawn/, /permission denied/, /hook (never|not) (run|firing|fired|executing)/,
      /nothing (is )?blocked/, /status says protected but/],
    ask: '`usewarden doctor` — it checks the node path, the script path, and the execute bit directly.',
    evidence: 'DECISIONS.md D-012. This exact defect shipped here: the built CLI had no execute bit, '
      + 'every Claude Code hook died with EACCES, and status still said PROTECTED.',
    labels: ['bug', 'triage:hook-not-executing'],
    route: 'likely-known',
  },
  {
    id: 'gemini-hook-contract',
    summary: 'A Gemini CLI hook contract mismatch. Gemini differs from Claude Code in three ways that '
      + 'have each caused a silent failure here: `timeout` is milliseconds, `args` is ignored, and '
      + 'empty stdout counts as a hook failure rather than "no opinion".',
    signals: [/gemini/],
    antiSignals: [/gemini api key/, /gemini judge/, /judge.*gemini/],
    ask: '`usewarden status --json` plus the contents of your `.gemini/settings.json`.',
    evidence: 'DECISIONS.md D-024, D-025, D-026 — all three found by live session, not by contract tests. '
      + 'docs/HOOK-MATRIX.md records the per-vendor differences.',
    labels: ['bug', 'agent:gemini', 'triage:gemini-contract'],
    route: 'likely-known',
  },
  {
    id: 'hook-hangs',
    summary: 'A hook that hangs rather than failing. A blocked hook is a blocked agent, so this is '
      + 'treated as more serious than a crash.',
    signals: [/hang(s|ing|ed)?/, /freez(e|es|ing)/, /stuck/, /never returns/, /times? out/, /no response/],
    ask: '`usewarden doctor`, and the value of `USEWARDEN_HOME` — a state directory on procfs is the '
      + 'known cause of this one.',
    evidence: 'DECISIONS.md D-065 and SAB-16. `fs.mkdirSync(p, {recursive:true})` never returns on '
      + 'procfs; it stalled three CI legs for fifteen minutes each. The regression test asserts a '
      + 'latency bound on the real hook subprocess, not just an exit code.',
    labels: ['bug', 'priority:high', 'triage:hang'],
    route: 'likely-known',
  },
  {
    id: 'unprotected-or-tampered',
    summary: '`status` is reporting a state rather than failing. UNPROTECTED, TAMPERED and '
      + 'POLICY_INVALID are each designed to be loud and to exit non-zero — they usually mean what '
      + 'they say.',
    signals: [/unprotected/, /tampered/, /policy_invalid/, /exit(s|ed)? (with )?1/, /non-?zero exit/],
    ask: '`usewarden status --json` — the `agents[].detail` field says which config and which check failed.',
    evidence: 'README "The failure mode this product takes seriously". SAB-08 proves the UNPROTECTED '
      + 'path A/B against a live agent session.',
    labels: ['triage:status-state'],
    route: 'needs-info',
  },
  {
    id: 'dotenv-bypass',
    summary: 'A way of reading a `.env` that usewarden did not block. Treated as a security report, '
      + 'not a feature request.',
    // Same narrowing: mentioning `.env` is not a vulnerability report. A BYPASS is.
    signals: [
      /\.env[^\n]{0,80}(read|leak|expos|bypass|not blocked|got through|still able)/,
      /(read|leak|expos|bypass|not blocked|got through|still able)[^\n]{0,80}\.env/,
      /dotenv[^\n]{0,60}(bypass|not blocked|leak)/,
      /secret.*(leak|expos)/, /credential.*(leak|expos)/,
    ],
    antiSignals: [/\.env\.example/, /does.{0,20}(it|usewarden).{0,20}(read|send|access)/],
    ask: 'The exact command, and whether it was a `Bash` tool call or a file-tool call. Please do not '
      + 'paste real credential values.',
    evidence: 'DECISIONS.md D-081 — a real bypass via `sed` was found by a live session because the '
      + 'rule enumerated readers. Layer 1 now uses an allowlist of commands that cannot disclose.',
    labels: ['security', 'triage:dotenv'],
    route: 'security',
  },
  {
    id: 'credential-format',
    summary: 'A credential usewarden did not recognise or did not redact. Vendors change key formats '
      + 'without notice and this project has been caught by that once already.',
    // NARROWED after watching it work. `/api key/` alone matched "do I need an API key?" - the
    // single most common new-user question - and routed it as a SECURITY report, telling someone
    // to close their issue and file a vulnerability advisory. That is a confident wrong answer
    // to a beginner, which is the worst failure this bot has available. A credential FORMAT
    // problem always comes with a symptom; the phrase alone never does.
    signals: [
      /\bapi key\b[^.\n]{0,60}(reject|invalid|401|unauthor|not work|fail|error|bad)/,
      /(reject|invalid|401|unauthor|not work|fail|error)[^.\n]{0,60}\bapi key\b/,
      /aiza[0-9a-z_-]{10,}/i, /\baq\.[a-z0-9_-]{10,}/i,
      /key.*(reject|invalid|401|unauthor)/, /\bredact(ed|ion)?\b/,
    ],
    antiSignals: [/do i need an api key/, /need an api key/, /require an api key/],
    ask: '`usewarden judge-check` — it reports the key SHAPE (length and prefix class) without ever '
      + 'printing the value. **Never paste a key into an issue.**',
    evidence: 'DECISIONS.md D-093, D-094. Google moved Gemini keys from `AIza`+35 to `AQ.`+50 and every '
      + 'credential control here knew only the old shape.',
    labels: ['security', 'triage:credential-format'],
    route: 'security',
  },
  {
    id: 'metrics-inconsistent',
    summary: 'A reported number that does not add up. usewarden re-checks its own arithmetic and is '
      + 'supposed to refuse to print figures it does not believe.',
    signals: [/metrics inconsistent/, /integrity check failed/, /more blocks than/, /wrong count/,
      /inflat(ed|ion)/, /counter.*wrong/],
    ask: '`usewarden metrics --json` — the `integrity.problems` array names exactly which arithmetic failed.',
    evidence: 'docs/METRICS.md §1 and SAB-17..SAB-24. The pre-v2 defect reported 12 blocks against 8 '
      + 'inspected events; the artifacts are verification/metrics-inflation-{before,after}.txt.',
    labels: ['bug', 'triage:metrics'],
    route: 'likely-known',
  },
  {
    id: 'config-restore',
    summary: 'Something about usewarden writing to, or restoring, an agent config file.',
    signals: [/settings\.json/, /restore/, /uninstall/, /backup/, /overwrote/, /clobber/, /my config/],
    ask: '`usewarden status --json`, and the newest directory under `~/.usewarden/backups/` — every write '
      + 'is preceded by a timestamped backup and a diff.',
    evidence: 'Phase 7 clean-machine simulation, sha256-verified byte-identical restore. '
      + 'tests/installer.test.ts G1/G2/G5/G7.',
    labels: ['bug', 'priority:high', 'triage:config'],
    route: 'possible-regression',
  },
  {
    id: 'judge-provider',
    summary: 'Something about the Layer 2 drift judge or its provider. Layer 2 is optional, sampled, '
      + 'and can only warn — if it is down, Layer 1 is unaffected by design.',
    signals: [/judge/, /drift/, /layer ?2/, /anthropic|openai/, /judge_unavailable/],
    ask: '`usewarden judge-check` — one real call that prints the provider, tokens, cost and verdict.',
    evidence: 'ops/JUDGE-LIVE-CHECK.md and verification/judge-live-check.txt. Only Gemini is verified '
      + 'against the live API; Anthropic and OpenAI are UNVERIFIED-LIVE and the README says so.',
    labels: ['triage:judge'],
    route: 'needs-info',
  },
  {
    id: 'false-positive',
    summary: 'usewarden blocking something it should not. Over-guarding is treated as a real defect '
      + 'here, not as the tool working — a guardrail that stops you working gets uninstalled.',
    signals: [/false positive/, /blocks? (a )?(legit|valid|normal|safe)/, /shouldn'?t (have )?block/,
      /too aggressive/, /over.?block/, /can'?t work/],
    ask: '`usewarden policy` — it prints the effective policy and where each rule came from — plus the '
      + 'exact command that was blocked.',
    evidence: 'Spec §3A.6 names over-guarding as a failure mode with its own test. D-081 records a '
      + 'deliberate narrowing after exactly this kind of report.',
    labels: ['bug', 'triage:false-positive'],
    route: 'possible-regression',
  },
];

/** Labels the bot is permitted to apply. Anything outside this list is a bug in the bot. */
export const ALLOWED_LABELS: string[] = [
  ...new Set([
    'bug', 'security', 'question', 'documentation', 'enhancement',
    'priority:high', 'needs-info', 'unmatched', 'docs-gap',
    'agent:claude', 'agent:cursor', 'agent:gemini', 'agent:copilot', 'agent:codex', 'agent:opencode',
    ...FAILURE_MODES.flatMap((m) => m.labels),
  ]),
];

/** Agent names worth labelling when the reporter names one. */
export const AGENT_SIGNALS: [string, RegExp][] = [
  ['agent:claude', /claude code|claude-code|\bclaude\b/],
  ['agent:cursor', /\bcursor\b/],
  ['agent:gemini', /gemini/],
  ['agent:copilot', /copilot/],
  ['agent:codex', /codex/],
  ['agent:opencode', /opencode/],
];
