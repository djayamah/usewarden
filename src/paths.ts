import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { mkdirpSafe } from './util.js';

/**
 * All usewarden state lives under one root so `usewarden uninstall` is a single, auditable removal.
 * USEWARDEN_HOME exists so the whole test suite (and the Phase 7 clean-machine simulation) can run
 * against a temp dir without touching the real user's files.
 */
export function usewardenHome(): string {
  const override = process.env['USEWARDEN_HOME'];
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.usewarden');
}

export function dbPath(): string { return path.join(usewardenHome(), 'usewarden.db'); }
export function backupsDir(): string { return path.join(usewardenHome(), 'backups'); }
export function globalPolicyPath(): string { return path.join(usewardenHome(), 'usewarden.yaml'); }
export function logPath(): string { return path.join(usewardenHome(), 'usewarden.log'); }

/**
 * The frozen label set, if this machine has one.
 *
 * Looked for in the REPOSITORY rather than in `~/.usewarden`, because a label set is a judgement
 * about a particular corpus made by a particular person and belongs beside the code it describes.
 * Most machines will not have one, and that is not an error: precision then reports as unavailable
 * with a reason, which is the honest rendering of "nobody has said whether these blocks were
 * right". See docs/PRECISION.md.
 */
export function defaultLabelsFile(): string | undefined {
  const override = process.env['USEWARDEN_LABELS'];
  if (override && override.trim() !== '') return path.resolve(override);
  const local = path.join(process.cwd(), 'corpus-labels', 'blocks-2026-09-08.json');
  return fs.existsSync(local) ? local : undefined;
}

export function ensureHome(): string {
  const h = usewardenHome();
  mkdirpSafe(h);
  mkdirpSafe(backupsDir());
  return h;
}

/** Home dir used to locate AGENT config files. Separate override so tests can sandbox it. */
export function agentHome(): string {
  const override = process.env['USEWARDEN_AGENT_HOME'];
  if (override && override.trim() !== '') return path.resolve(override);
  return os.homedir();
}

/**
 * The SEALED policy — a verbatim copy of the machine-wide policy as it stood when usewarden was
 * installed, or when the user last deliberately re-sealed it.
 *
 * A copy, not a hash. The hook-entry integrity records store only a hash, which answers "did this
 * change" and cannot answer the question that matters: **did it get weaker.** Answering that needs
 * the old rules themselves, so that both rulesets can be run against the same actions and
 * compared by what they CATCH rather than by how their text differs. See src/policy/drift.ts.
 */
export function policySealPath(): string { return path.join(usewardenHome(), 'policy-seal.yaml'); }
export function policySealMetaPath(): string { return path.join(usewardenHome(), 'policy-seal.json'); }
