/**
 * A deliberately tiny, strict YAML subset parser.
 *
 * This is a SECURITY control, not a convenience (docs/THREAT-MODEL.md T-06). `usewarden.yaml` can
 * arrive from a cloned, untrusted repository, so usewarden must not hand it to a full YAML engine
 * whose feature surface includes tags, anchors, merge keys and multi-document streams. The
 * supported subset is:
 *
 *   - `# comments` (whole-line and trailing on scalar lines)
 *   - nested mappings, indentation by spaces only
 *   - block sequences of scalars (`- item`) and of mappings (`- key: value`)
 *   - scalars: plain, 'single-quoted', "double-quoted"
 *   - typed scalars: integers, floats, true/false, null/~/empty
 *
 * Everything else is a hard parse error. In particular the following are REJECTED by name so the
 * failure message is honest rather than a silent misparse: `!`/`!!` tags, `&`anchors, `*`aliases,
  * `<<` merge keys, `---`/`...` document markers, tab indentation, and NON-EMPTY flow
 * collections. Empty `[]` and `{}` are permitted - they carry no nesting or aliases.
 */

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

interface Line { indent: number; text: string; n: number; }

const REJECT: readonly { re: RegExp; why: string }[] = [
  { re: /^---\s*$|^\.\.\.\s*$/, why: 'multi-document YAML is not supported' },
  { re: /(^|\s)&[A-Za-z0-9_-]+/, why: 'YAML anchors are not supported' },
  { re: /(^|\s)\*[A-Za-z0-9_-]+\s*$/, why: 'YAML aliases are not supported' },
  { re: /(^|\s)!!?[A-Za-z0-9_/-]+/, why: 'YAML tags are not supported' },
  { re: /^\s*<<\s*:/, why: 'YAML merge keys are not supported' },
];

export function parseYaml(source: string): YamlValue {
  if (source.includes('\t')) {
    const n = source.slice(0, source.indexOf('\t')).split('\n').length;
    throw new YamlError('tab characters are not valid YAML indentation', n);
  }
  const raw = source.split(/\r?\n/);
  const lines: Line[] = [];
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i]!;
    const n = i + 1;
    for (const r of REJECT) {
      if (r.re.test(original)) throw new YamlError(r.why, n);
    }
    const noComment = stripComment(original);
    if (noComment.trim() === '') continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, text: noComment.trim(), n });
  }
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next !== lines.length) {
    throw new YamlError('inconsistent indentation', lines[next]!.n);
  }
  return value;
}

/** Strips a `#` comment, honouring quotes so a `#` inside a string survives. */
function stripComment(line: string): string {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) {
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

function parseBlock(lines: Line[], i: number, indent: number): [YamlValue, number] {
  if (i >= lines.length) return [null, i];
  return lines[i]!.text.startsWith('- ') || lines[i]!.text === '-'
    ? parseSeq(lines, i, indent)
    : parseMap(lines, i, indent);
}

function parseMap(lines: Line[], i: number, indent: number): [Record<string, YamlValue>, number] {
  const out: Record<string, YamlValue> = {};
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('unexpected indentation', ln.n);
    if (ln.text.startsWith('- ')) break;
    const m = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:(?:\s+(.*))?$/.exec(ln.text);
    if (!m) throw new YamlError(`expected "key: value", got ${JSON.stringify(ln.text)}`, ln.n);
    const key = unquote(m[1]!);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`duplicate key ${JSON.stringify(key)}`, ln.n);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new YamlError(`refusing prototype-polluting key ${JSON.stringify(key)}`, ln.n);
    }
    const inline = (m[2] ?? '').trim();
    if (inline !== '') {
      out[key] = scalar(inline, ln.n);
      i++;
      continue;
    }
    // Nested block, or an explicit null.
    const child = lines[i + 1];
    if (!child || child.indent <= indent) {
      // `key:` with a sibling/dedent next means empty. A sequence at the SAME indent is a
      // valid YAML block sequence child, so allow that one case.
      if (child && child.indent === indent && child.text.startsWith('- ')) {
        const [v, next] = parseSeq(lines, i + 1, indent);
        out[key] = v; i = next; continue;
      }
      out[key] = null; i++; continue;
    }
    const [v, next] = parseBlock(lines, i + 1, child.indent);
    out[key] = v;
    i = next;
  }
  return [out, i];
}

function parseSeq(lines: Line[], i: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('unexpected indentation in sequence', ln.n);
    if (!ln.text.startsWith('- ') && ln.text !== '-') break;
    const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
    if (rest === '') {
      const child = lines[i + 1];
      if (!child || child.indent <= indent) { out.push(null); i++; continue; }
      const [v, next] = parseBlock(lines, i + 1, child.indent);
      out.push(v); i = next; continue;
    }
    // `- key: value` starts a mapping whose first line shares the dash's line.
    const asMap = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:(?:\s+(.*))?$/.exec(rest);
    if (asMap) {
      const key = unquote(asMap[1]!);
      const inline = (asMap[2] ?? '').trim();
      const itemIndent = indent + 2;
      const obj: Record<string, YamlValue> = {};
      obj[key] = inline === '' ? null : scalar(inline, ln.n);
      i++;
      if (i < lines.length && lines[i]!.indent >= itemIndent && !lines[i]!.text.startsWith('- ')) {
        const [more, next] = parseMap(lines, i, lines[i]!.indent);
        Object.assign(obj, more);
        i = next;
      }
      out.push(obj);
      continue;
    }
    out.push(scalar(rest, ln.n));
    i++;
  }
  return [out, i];
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function scalar(text: string, line: number): YamlValue {
  // Empty flow collections are allowed: they carry no nesting, no tags and no aliases, and
  // `key: []` is far too common in real config files to reject. Non-empty flow style is still
  // rejected so the parser's surface stays the documented block subset.
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('{') || text.startsWith('[')) {
    throw new YamlError('non-empty flow collections ({...} / [...]) are not supported; use block style', line);
  }
  if (text.startsWith('|') || text.startsWith('>')) {
    throw new YamlError('block scalars (| and >) are not supported', line);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}
