import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlError } from '../src/policy/yaml.js';

describe('yaml subset parser', () => {
  test('parses nested maps, lists, and scalar types', () => {
    const doc = parseYaml(`
version: 1
scope:
  allowed_paths:
    - /tmp/a
    - "/tmp/b c"
  forbidden_paths: []
session:
  goal_required: true
context:
  warn_pct: 60
judge:
  model: null
  ratio: 0.5
`.replace('forbidden_paths: []', 'forbidden_paths:\n    - "**/.env"'));
    assert.deepEqual(doc, {
      version: 1,
      scope: { allowed_paths: ['/tmp/a', '/tmp/b c'], forbidden_paths: ['**/.env'] },
      session: { goal_required: true },
      context: { warn_pct: 60 },
      judge: { model: null, ratio: 0.5 },
    });
  });

  test('parses a list of mappings', () => {
    const doc = parseYaml(`
commands:
  deny:
    - id: one
      pattern: "rm -rf"
      action: block
    - id: two
      pattern: "sudo"
      action: warn
`) as Record<string, { deny: Record<string, string>[] }>;
    assert.equal(doc['commands']!.deny.length, 2);
    assert.deepEqual(doc['commands']!.deny[0], { id: 'one', pattern: 'rm -rf', action: 'block' });
    assert.deepEqual(doc['commands']!.deny[1], { id: 'two', pattern: 'sudo', action: 'warn' });
  });

  test('strips comments but keeps # inside quotes', () => {
    const doc = parseYaml('a: 1 # trailing\n# whole line\nb: "has # hash"\n');
    assert.deepEqual(doc, { a: 1, b: 'has # hash' });
  });

  // --- the security-relevant rejections (THREAT-MODEL T-06) -------------------
  const rejections: [string, string, string][] = [
    ['anchors', 'a: &anchor v\nb: 1\n', 'anchors'],
    ['aliases', 'a: v\nb: *anchor\n', 'aliases'],
    ['tags', "a: !!python/object/apply:os.system ['id']\n", 'tags'],
    // `<<: *base` trips the alias rule first; `<<:` alone trips the merge-key rule. Both reject.
    ['merge keys with alias', 'base:\n  x: 1\nchild:\n  <<: *base\n', 'alias'],
    ['merge keys bare', 'child:\n  <<: other\n', 'merge keys'],
    ['multi-document', '---\na: 1\n---\nb: 2\n', 'multi-document'],
    ['tabs', 'a:\n\tb: 1\n', 'tab'],
    ['non-empty flow map', 'a: {b: 1}\n', 'flow collections'],
    ['non-empty flow seq', 'a: [1, 2]\n', 'flow collections'],
    ['block scalar', 'a: |\n  text\n', 'block scalars'],
  ];
  for (const [name, src, expect] of rejections) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parseYaml(src), (e: unknown) => {
        assert.ok(e instanceof YamlError, `expected YamlError, got ${String(e)}`);
        assert.match(e.message, new RegExp(expect, 'i'));
        return true;
      });
    });
  }

  test('rejects duplicate keys instead of silently taking the last', () => {
    assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  });

  test('refuses prototype-polluting keys', () => {
    assert.throws(() => parseYaml('__proto__: 1\n'), /prototype-polluting/);
  });

  test('empty document is an empty map, not null', () => {
    assert.deepEqual(parseYaml('# only a comment\n'), {});
  });

  test('EMPTY flow collections are allowed (no nesting, no tags, no aliases)', () => {
    assert.deepEqual(parseYaml('a: []\nb: {}\n'), { a: [], b: {} });
  });
});
