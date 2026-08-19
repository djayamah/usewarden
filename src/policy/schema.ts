import type { YamlValue } from './yaml.js';

/**
 * Strict schema for `usewarden.yaml`.
 *
 * Rules that exist for security, not tidiness (docs/THREAT-MODEL.md T-06):
 *   - UNKNOWN KEYS ARE REJECTED. A policy file that usewarden only partly understands is a policy
 *     file whose author believes they configured something they did not.
 *   - Values are data. Nothing here is ever executed, shell-interpolated, or eval'd.
 *   - Parse failure is a loud halt (POLICY_INVALID), never a silent default-allow (T-12).
 */

export interface CommandRule {
  /** Human-readable id used in incident cards and `rule` fields. */
  id: string;
  /** JS regular expression source, matched case-insensitively against the command line. */
  pattern: string;
  /** One line the agent can self-correct from. */
  reason: string;
  /** `block` refuses the call; `warn` records an incident and allows. */
  action: 'block' | 'warn';
  /** When true the rule only fires if the command's target is outside allowed_paths. */
  outsideRepoOnly?: boolean;
}

export interface Policy {
  version: 1;
  scope: {
    allowed_paths: string[];
    forbidden_paths: string[];
  };
  commands: {
    deny: CommandRule[];
  };
  invariants: string[];
  session: { goal_required: boolean };
  context: { warn_pct: number };
  checkpoint: { auto: boolean };
  protected_branches: string[];
  judge: {
    enabled: boolean;
    every_n_events: number;
    max_calls_per_session: number;
    model: string | null;
  };
  telemetry: { enabled: boolean };
}

export class PolicyError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = 'PolicyError';
  }
}

/**
 * Default deny list. Every entry is a regex over the raw command string plus a human reason.
 * Ordering matters only for which rule id gets reported first.
 */
export function defaultCommandDeny(): CommandRule[] {
  return [
    {
      id: 'rm-rf-outside-repo',
      pattern: String.raw`\brm\s+(-[A-Za-z]*\s+)*-[A-Za-z]*[rR][A-Za-z]*f|\brm\s+(-[A-Za-z]*\s+)*-[A-Za-z]*f[A-Za-z]*[rR]`,
      reason: 'Recursive force-delete outside the allowed paths. Delete inside the repo, or ask the human.',
      action: 'block',
      outsideRepoOnly: true,
    },
    {
      id: 'force-push-protected',
      pattern: String.raw`\bgit\s+push\b[^\n]*\s(--force\b|--force-with-lease\b|-f\b)`,
      reason: 'Force-push to a protected branch rewrites shared history. Push to a feature branch and open a PR.',
      action: 'block',
    },
    {
      id: 'git-reset-hard',
      pattern: String.raw`\bgit\s+reset\s+(--\w+\s+)*--hard\b`,
      reason: 'git reset --hard discards uncommitted work. Usewarden takes a checkpoint first; re-run after the checkpoint exists.',
      action: 'block',
    },
    {
      id: 'curl-pipe-shell',
      pattern: String.raw`\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|da|fi)?sh\b`,
      reason: 'Piping a downloaded script straight into a shell executes unreviewed remote code. Download, read, then run.',
      action: 'block',
    },
    {
      id: 'sudo',
      pattern: String.raw`(^|[;&|]\s*)sudo\s`,
      reason: 'Usewarden does not let an agent escalate privileges. Run privileged steps yourself.',
      action: 'block',
    },
    {
      id: 'drop-table',
      pattern: String.raw`\bDROP\s+(TABLE|DATABASE|SCHEMA)\b`,
      reason: 'Destructive schema change. Write a reversible migration instead.',
      action: 'block',
    },
    {
      id: 'dotenv-access',
      pattern: String.raw`(^|[\s;&|"'=])(cat|less|more|head|tail|bat|strings|xxd|od|cp|mv|scp|rsync|source|\.)\s+[^\s;&|]*\.env(\.[A-Za-z0-9_-]+)?\b`,
      reason: 'Reading or copying a .env file exposes credentials to the model context. Usewarden blocks all .env access.',
      action: 'block',
    },
    {
      id: 'history-rewrite',
      pattern: String.raw`\bgit\s+(filter-branch|filter-repo)\b|\bgit\s+rebase\b[^\n]*\s(-i|--interactive)\b`,
      reason: 'History rewriting is not reversible from the agent side. Do it yourself with a backup ref.',
      action: 'warn',
    },
    {
      id: 'chmod-777',
      pattern: String.raw`\bchmod\s+(-[A-Za-z]+\s+)*0?777\b`,
      reason: 'World-writable permissions are almost never what you want.',
      action: 'warn',
    },
    {
      id: 'npm-publish',
      pattern: String.raw`\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b`,
      reason: 'Publishing to a registry is an outward-facing, irreversible action. A human runs this.',
      action: 'block',
    },
  ];
}

export function defaultPolicy(repoRoot: string): Policy {
  return {
    version: 1,
    scope: {
      allowed_paths: [repoRoot],
      forbidden_paths: [
        '~/.ssh',
        '~/.aws',
        '~/.gnupg',
        '~/.config/gh',
        '~/Library/Keychains',
        '**/.env',
        '**/.env.*',
        '**/id_rsa',
        '**/id_ed25519',
        '**/*.pem',
      ],
    },
    commands: { deny: defaultCommandDeny() },
    invariants: [],
    session: { goal_required: false },
    context: { warn_pct: 60 },
    checkpoint: { auto: true },
    protected_branches: ['main', 'master', 'release', 'production'],
    judge: { enabled: true, every_n_events: 15, max_calls_per_session: 8, model: null },
    telemetry: { enabled: false },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Obj = Record<string, YamlValue>;

function isObj(v: YamlValue): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknown(o: Obj, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      throw new PolicyError(
        `unknown key ${JSON.stringify(k)}. Allowed here: ${allowed.join(', ')}`,
        where,
      );
    }
  }
}

function strArray(v: YamlValue, where: string): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new PolicyError('expected a list of strings', where);
  return v.map((x, i) => {
    if (typeof x !== 'string') throw new PolicyError('expected a string', `${where}[${i}]`);
    return x;
  });
}

function bool(v: YamlValue, where: string, dflt: boolean): boolean {
  if (v === null || v === undefined) return dflt;
  if (typeof v !== 'boolean') throw new PolicyError('expected true or false', where);
  return v;
}

function int(v: YamlValue, where: string, dflt: number, min: number, max: number): number {
  if (v === null || v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new PolicyError('expected a number', where);
  if (v < min || v > max) throw new PolicyError(`must be between ${min} and ${max}`, where);
  return v;
}

const TOP_KEYS = [
  'version', 'scope', 'commands', 'invariants', 'session', 'context',
  'checkpoint', 'protected_branches', 'judge', 'telemetry',
] as const;

/**
 * Validates a parsed document against the schema and merges it over `base`.
 * Any key absent from the document keeps the base value.
 */
export function validatePolicy(doc: YamlValue, base: Policy): Policy {
  if (!isObj(doc)) throw new PolicyError('top level must be a mapping', 'usewarden.yaml');
  rejectUnknown(doc, TOP_KEYS, 'usewarden.yaml');

  const version = doc['version'];
  if (version !== undefined && version !== null && version !== 1) {
    throw new PolicyError(`unsupported policy version ${String(version)}; this usewarden understands version 1`, 'version');
  }

  const out: Policy = structuredClone(base);

  if (doc['scope'] !== undefined && doc['scope'] !== null) {
    const s = doc['scope'];
    if (!isObj(s)) throw new PolicyError('expected a mapping', 'scope');
    rejectUnknown(s, ['allowed_paths', 'forbidden_paths'], 'scope');
    if (s['allowed_paths'] !== undefined) out.scope.allowed_paths = strArray(s['allowed_paths'], 'scope.allowed_paths');
    if (s['forbidden_paths'] !== undefined) out.scope.forbidden_paths = strArray(s['forbidden_paths'], 'scope.forbidden_paths');
  }

  if (doc['commands'] !== undefined && doc['commands'] !== null) {
    const c = doc['commands'];
    if (!isObj(c)) throw new PolicyError('expected a mapping', 'commands');
    rejectUnknown(c, ['deny'], 'commands');
    if (c['deny'] !== undefined && c['deny'] !== null) {
      const list = c['deny'];
      if (!Array.isArray(list)) throw new PolicyError('expected a list', 'commands.deny');
      out.commands.deny = list.map((raw, i) => parseCommandRule(raw, `commands.deny[${i}]`));
    }
  }

  if (doc['invariants'] !== undefined) out.invariants = strArray(doc['invariants'], 'invariants');

  if (doc['session'] !== undefined && doc['session'] !== null) {
    const s = doc['session'];
    if (!isObj(s)) throw new PolicyError('expected a mapping', 'session');
    rejectUnknown(s, ['goal_required'], 'session');
    out.session.goal_required = bool(s['goal_required'] ?? null, 'session.goal_required', out.session.goal_required);
  }

  if (doc['context'] !== undefined && doc['context'] !== null) {
    const c = doc['context'];
    if (!isObj(c)) throw new PolicyError('expected a mapping', 'context');
    rejectUnknown(c, ['warn_pct'], 'context');
    out.context.warn_pct = int(c['warn_pct'] ?? null, 'context.warn_pct', out.context.warn_pct, 1, 99);
  }

  if (doc['checkpoint'] !== undefined && doc['checkpoint'] !== null) {
    const c = doc['checkpoint'];
    if (!isObj(c)) throw new PolicyError('expected a mapping', 'checkpoint');
    rejectUnknown(c, ['auto'], 'checkpoint');
    out.checkpoint.auto = bool(c['auto'] ?? null, 'checkpoint.auto', out.checkpoint.auto);
  }

  if (doc['protected_branches'] !== undefined) {
    out.protected_branches = strArray(doc['protected_branches'], 'protected_branches');
  }

  if (doc['judge'] !== undefined && doc['judge'] !== null) {
    const j = doc['judge'];
    if (!isObj(j)) throw new PolicyError('expected a mapping', 'judge');
    rejectUnknown(j, ['enabled', 'every_n_events', 'max_calls_per_session', 'model'], 'judge');
    out.judge.enabled = bool(j['enabled'] ?? null, 'judge.enabled', out.judge.enabled);
    out.judge.every_n_events = int(j['every_n_events'] ?? null, 'judge.every_n_events', out.judge.every_n_events, 1, 1000);
    out.judge.max_calls_per_session = int(j['max_calls_per_session'] ?? null, 'judge.max_calls_per_session', out.judge.max_calls_per_session, 0, 1000);
    const m = j['model'];
    if (m !== undefined && m !== null) {
      if (typeof m !== 'string') throw new PolicyError('expected a string', 'judge.model');
      out.judge.model = m;
    }
  }

  if (doc['telemetry'] !== undefined && doc['telemetry'] !== null) {
    const t = doc['telemetry'];
    if (!isObj(t)) throw new PolicyError('expected a mapping', 'telemetry');
    rejectUnknown(t, ['enabled'], 'telemetry');
    out.telemetry.enabled = bool(t['enabled'] ?? null, 'telemetry.enabled', out.telemetry.enabled);
  }

  return out;
}

function parseCommandRule(raw: YamlValue, where: string): CommandRule {
  if (!isObj(raw)) throw new PolicyError('expected a mapping with id/pattern/reason/action', where);
  rejectUnknown(raw, ['id', 'pattern', 'reason', 'action', 'outsideRepoOnly'], where);
  const id = raw['id'];
  const pattern = raw['pattern'];
  const reason = raw['reason'];
  const action = raw['action'] ?? 'block';
  if (typeof id !== 'string' || id === '') throw new PolicyError('id is required', `${where}.id`);
  if (typeof pattern !== 'string' || pattern === '') throw new PolicyError('pattern is required', `${where}.pattern`);
  if (typeof reason !== 'string' || reason === '') throw new PolicyError('reason is required', `${where}.reason`);
  if (action !== 'block' && action !== 'warn') throw new PolicyError('action must be "block" or "warn"', `${where}.action`);
  // Compile now so a bad regex is a loud policy error at load time, not a silent no-op later.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'i');
  } catch (e) {
    throw new PolicyError(`invalid regular expression: ${(e as Error).message}`, `${where}.pattern`);
  }
  const rule: CommandRule = { id, pattern, reason, action };
  const o = raw['outsideRepoOnly'];
  if (o !== undefined && o !== null) {
    if (typeof o !== 'boolean') throw new PolicyError('expected true or false', `${where}.outsideRepoOnly`);
    rule.outsideRepoOnly = o;
  }
  return rule;
}
