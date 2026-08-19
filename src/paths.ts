import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

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

export function ensureHome(): string {
  const h = usewardenHome();
  fs.mkdirSync(h, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupsDir(), { recursive: true, mode: 0o700 });
  return h;
}

/** Home dir used to locate AGENT config files. Separate override so tests can sandbox it. */
export function agentHome(): string {
  const override = process.env['USEWARDEN_AGENT_HOME'];
  if (override && override.trim() !== '') return path.resolve(override);
  return os.homedir();
}
