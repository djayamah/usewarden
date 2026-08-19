/**
 * Terminal output. Spec section 3B: terminal-first, colour used semantically only, degrades
 * cleanly under NO_COLOR and when stdout is not a TTY, and every command supports --json.
 */

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] === '1') return true;
  return Boolean(stream.isTTY);
}

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type Colour = keyof typeof CODES;

export function paint(s: string, ...styles: Colour[]): string {
  if (!colorEnabled()) return s;
  return styles.map((c) => CODES[c]).join('') + s + CODES.reset;
}

/** Semantic helpers. Colour is never the only signal - the word is always there too. */
export const ok = (s: string) => paint(s, 'green');
export const bad = (s: string) => paint(s, 'red', 'bold');
export const warn = (s: string) => paint(s, 'yellow');
export const dim = (s: string) => paint(s, 'gray');
export const head = (s: string) => paint(s, 'bold');

export function stateBadge(state: string): string {
  switch (state) {
    case 'PROTECTED': return ok('PROTECTED');
    case 'UNPROTECTED': return bad('UNPROTECTED');
    case 'TAMPERED': return bad('TAMPERED');
    case 'POLICY_INVALID': return bad('POLICY_INVALID');
    default: return state;
  }
}

/**
 * The incident card is the product's screenshot (spec 3.6), so a long command must WRAP inside
 * the frame rather than blow the right-hand border out past the terminal. Continuation lines are
 * indented under the label so the card still scans as a table.
 */
export function box(title: string, lines: string[], maxWidth = 84): string {
  const width = Math.min(maxWidth, Math.max(title.length + 4, ...lines.map((l) => stripAnsi(l).length + 4)));
  const inner = width - 4;
  const wrapped: string[] = [];
  for (const l of lines) wrapped.push(...wrapLine(l, inner));
  const bar = '─'.repeat(width - 2);
  const out = [`┌${bar}┐`, `│ ${head(title.slice(0, inner))}${' '.repeat(Math.max(0, inner - title.length))} │`, `├${bar}┤`];
  for (const l of wrapped) {
    const pad = Math.max(0, inner - stripAnsi(l).length);
    out.push(`│ ${l}${' '.repeat(pad)} │`);
  }
  out.push(`└${bar}┘`);
  return out.join('\n');
}

/**
 * Wraps on visible width, ignoring ANSI. Colour is only ever applied to a whole label here, so
 * a naive slice cannot split an escape sequence: everything past the label is plain text.
 */
export function wrapLine(line: string, width: number): string[] {
  if (stripAnsi(line).length <= width) return [line];
  // Preserve the leading label + spacing as the hanging indent.
  const m = /^(\S+\s+|\u001b\[[0-9;]*m\S+\u001b\[0m\s+)/.exec(line);
  const indentWidth = m ? Math.min(stripAnsi(m[1]!).length, Math.floor(width / 3)) : 0;
  const indent = ' '.repeat(indentWidth);
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (stripAnsi(rest).length > width) {
    const budget = first ? width : width - indentWidth;
    const [take, remainder] = splitVisible(rest, budget);
    out.push(first ? take : indent + take);
    rest = remainder;
    first = false;
  }
  if (stripAnsi(rest).length > 0) out.push(first ? rest : indent + rest);
  return out;
}

/** Splits `s` after `n` VISIBLE characters, keeping ANSI sequences with the first half. */
function splitVisible(s: string, n: number): [string, string] {
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < n) {
    if (s[i] === '\u001b') {
      const end = s.indexOf('m', i);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    visible++; i++;
  }
  return [s.slice(0, i), s.slice(i)];
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function checkbox(done: boolean): string {
  return done ? ok('[x]') : dim('[ ]');
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => c + ' '.repeat(Math.max(0, widths[i]! - stripAnsi(c).length))).join('  ').trimEnd()).join('\n');
}
