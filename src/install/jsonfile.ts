import * as fs from 'node:fs';

/**
 * Least-privilege JSON config editing (docs/THREAT-MODEL.md T-04).
 *
 * Usewarden writes into files the user owns and other tools also write to. The rules:
 *   - Never reformat. Indentation width, tab-vs-space, and the trailing newline are detected
 *     from the existing file and reproduced exactly.
 *   - Never reorder. `JSON.parse` preserves insertion order for string keys, and usewarden only
 *     appends or replaces its own subtree, so unrelated keys come out in the order they went in.
 *   - Never write when nothing changed. A no-op `usewarden init` must leave the file byte-identical,
 *     which is also what makes `init` idempotent.
 *   - Treat CREATION of a previously-absent protected file as a mutation (CVE-2026-25725), so a
 *     caller can see `existed: false` and report it rather than silently conjuring a config.
 */

export interface JsonFile {
  path: string;
  existed: boolean;
  /** Raw bytes as read, or '' when the file did not exist. */
  raw: string;
  value: Record<string, unknown>;
  /** Indent string inferred from the file: '  ', '    ', '\t', ... */
  indent: string;
  trailingNewline: boolean;
}

export class JsonParseError extends Error {
  constructor(readonly file: string, readonly detail: string) {
    super(`${file}: not valid JSON (${detail})`);
    this.name = 'JsonParseError';
  }
}

export function readJsonFile(p: string): JsonFile {
  if (!fs.existsSync(p)) {
    return { path: p, existed: false, raw: '', value: {}, indent: '  ', trailingNewline: true };
  }
  const raw = fs.readFileSync(p, 'utf8');
  if (raw.trim() === '') {
    return { path: p, existed: true, raw, value: {}, indent: '  ', trailingNewline: raw.endsWith('\n') };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new JsonParseError(p, (e as Error).message);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JsonParseError(p, 'top level is not an object');
  }
  return {
    path: p,
    existed: true,
    raw,
    value: value as Record<string, unknown>,
    indent: detectIndent(raw),
    trailingNewline: raw.endsWith('\n'),
  };
}

export function detectIndent(raw: string): string {
  const m = /\n([ \t]+)\S/.exec(raw);
  if (!m) return '  ';
  return m[1]!;
}

export function serialize(f: JsonFile): string {
  const body = JSON.stringify(f.value, null, f.indent);
  return f.trailingNewline ? body + '\n' : body;
}

/** Returns true when the serialized form differs from what is on disk. */
export function isDirty(f: JsonFile): boolean {
  return serialize(f) !== f.raw;
}

/**
 * A unified-ish diff good enough for a human to read in a terminal before approving a config
 * write. Deliberately dependency-free and deliberately not clever: full-line adds and removes.
 */
export function previewDiff(before: string, after: string, label: string): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after.split('\n');
  const out: string[] = [`--- ${label} (current)`, `+++ ${label} (after usewarden init)`];
  // Longest-common-subsequence over lines. Config files are small; O(n*m) is fine.
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0, j = 0;
  const lines: string[] = [];
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push(`  ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { lines.push(`- ${a[i]}`); i++; }
    else { lines.push(`+ ${b[j]}`); j++; }
  }
  while (i < n) { lines.push(`- ${a[i]}`); i++; }
  while (j < m) { lines.push(`+ ${b[j]}`); j++; }

  // Collapse long unchanged runs so the preview stays one screen.
  const compact: string[] = [];
  let run = 0;
  for (const l of lines) {
    if (l.startsWith('  ')) {
      run++;
      if (run <= 3) compact.push(l);
      else if (run === 4) compact.push('  ...');
    } else {
      run = 0;
      compact.push(l);
    }
  }
  return out.concat(compact).join('\n');
}
