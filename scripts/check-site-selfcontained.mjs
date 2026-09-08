#!/usr/bin/env node
/**
 * THE SITE MUST FETCH NOTHING. ONE IMPLEMENTATION, READ BY EVERYONE WHO ASKS.
 *
 * `site/*.html` ships a `default-src 'none'` CSP and the whole point of the page is that it never
 * wants an external asset. A `<script>` or a CDN reference arriving later would not break the
 * build; it would quietly stop the CSP from being true.
 *
 * WHY THIS FILE EXISTS RATHER THAN THE CHECK LIVING IN TWO PLACES
 *
 * It lived in two places and they drifted, exactly as `internal-only-paths.txt` did before it
 * became one file with three readers. `tests/site.test.ts` had the rule right — its comment reads
 * "A FETCH IS NOT A LINK, AND THE ORIGINAL FORM OF THIS TEST CONFLATED THEM" — and allowlisted the
 * two primary sources the page cites. The copy inside `.github/workflows/pages.yml` still refused
 * every absolute URL in any `src` OR `href`, so when 2026-08-26 added two citation links the test
 * passed and the workflow went red. The private repository's `pages` run has been failing on it
 * ever since and nobody noticed, because the public one publishes an older page that predates the
 * links (D-272).
 *
 * THE DISTINCTION THAT MATTERS
 *
 *   FETCHED    `src`, `action`, `data`, `poster`, a stylesheet `<link href>`, `url()`, `@import`.
 *              The browser goes and gets these without asking. They are what the CSP stops, and
 *              the rule for them is ZERO external references - not "only from hosts we like".
 *   NAVIGATED  `<a href>`. Nothing is fetched until a reader clicks. These may point at surfaces
 *              the founder owns, or at a PRIMARY SOURCE the page cites for a claim about someone
 *              else's product - a claim a reader cannot check is worse than no claim.
 *
 * Conflating them is how a documentation hyperlink got treated as a CDN asset.
 *
 * EXIT CODES
 *   0  every page is self-contained
 *   1  something is fetched from off-host, or an anchor points somewhere unlisted
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Surfaces the founder owns. An anchor to one of these is navigation within the product's own
 * world and needs no justification.
 */
export const OWNED_ORIGINS = /^https:\/\/(github\.com\/djayamah|djayamah\.github\.io)\//;

/**
 * PRIMARY SOURCES the page cites, by exact origin.
 *
 * Added 2026-08-26 with the honest native-controls comparison: the page states what Claude Code's
 * own permission system does and does not do, and a claim about someone else's product that a
 * reader cannot check against that product's own documentation asks to be trusted on exactly the
 * point where trust is least available. By exact origin rather than "external links are fine", so
 * a new citation stays a deliberate edit to this line.
 */
export const CITED_ORIGINS = /^https:\/\/(code\.claude\.com|www\.anthropic\.com)\//;

/** Hosts that are never acceptable, in any attribute, because none of them is a citation. */
const NEVER = /fonts\.googleapis|cdn\.|unpkg|jsdelivr|google-analytics|googletagmanager/i;

/** `rel` values that make the browser go and get something without being asked. */
const FETCHING_REL = /\b(stylesheet|preload|prefetch|icon|manifest|preconnect|dns-prefetch|modulepreload)\b/;

const isAbsolute = (u) => /^(https?:)?\/\//.test(u);

/** Every finding in one page. Pure, so the self-test can drive it with a string. */
export function checkHtml(html, label = '<inline>') {
  const bad = [];

  for (const m of html.matchAll(/\b(?:src|action|data|poster)\s*=\s*"([^"]*)"/gi)) {
    if (isAbsolute(m[1])) bad.push(`${label}: fetches off-host: ${m[1]}`);
  }
  // A <link> IS NOT AUTOMATICALLY A FETCH, and the first version of this rule said it was.
  //
  // `rel="canonical"` is metadata: the browser fetches nothing, and it is the entire reason this
  // site exists rather than a Discussion thread (D-222 - a page we own can carry a canonical URL
  // and a Discussion cannot). `rel="stylesheet"`, `preload`, `prefetch`, `icon`, `manifest`,
  // `preconnect` and `dns-prefetch` all cause the browser to go and get something. Only the second
  // group is what the CSP exists to stop, so only the second group is refused - plus any <link>
  // at all whose href leaves origins we own.
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    const rel = (/\brel\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '').toLowerCase().trim();
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    if (FETCHING_REL.test(rel)) { bad.push(`${label}: <link rel="${rel}"> is fetched - the stylesheet must stay inline`); continue; }
    if (isAbsolute(href) && !OWNED_ORIGINS.test(href)) bad.push(`${label}: <link rel="${rel}"> points off-host: ${href}`);
  }
  if (/<script\b/i.test(html)) bad.push(`${label}: contains a <script> tag`);
  if (/\bon[a-z]+\s*=\s*"/i.test(html)) bad.push(`${label}: has an inline event handler`);
  if (/url\(\s*['"]?(https?:)?\/\//i.test(html)) bad.push(`${label}: a stylesheet url() reaches off-host`);
  if (/@import/i.test(html)) bad.push(`${label}: uses @import`);
  if (NEVER.test(html)) bad.push(`${label}: references a CDN or analytics host`);
  if (!/content-security-policy/i.test(html)) bad.push(`${label}: has no Content-Security-Policy`);
  if (!/default-src 'none'/.test(html)) bad.push(`${label}: CSP does not say default-src 'none'`);

  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = m[1];
    if (!isAbsolute(href)) continue;
    if (OWNED_ORIGINS.test(href) || CITED_ORIGINS.test(href)) continue;
    bad.push(`${label}: links to a surface we neither own nor cite as a primary source: ${href}`);
  }

  return bad;
}

/**
 * A check that cannot fail is not a check. Each case plants exactly one violation in a page that
 * is otherwise clean, and asserts it is caught — and the clean page itself must produce nothing,
 * or the whole suite is just returning findings for everything.
 */
function selfTest() {
  const CLEAN = `<meta http-equiv="content-security-policy" content="default-src 'none'">
    <a href="https://github.com/djayamah/usewarden">repo</a>
    <a href="https://code.claude.com/docs/en/permissions">their docs</a>
    <a href="writeups/">local</a><img src="data:image/png;base64,AA">`;
  const cases = [
    ['a clean page is clean', CLEAN, 0],
    ['a script tag', CLEAN + '<script>x()</script>', 1],
    ['an off-host src', CLEAN + '<img src="https://evil.example/x.png">', 1],
    ['a CDN reference', CLEAN + '<a href="https://cdn.example.com/x">x</a>', 2],
    ['a stylesheet link', CLEAN + '<link rel="stylesheet" href="a.css">', 1],
    ['a canonical link to an owned origin', CLEAN + '<link rel="canonical" href="https://djayamah.github.io/usewarden/x.html">', 0],
    ['a canonical link pointing off-host', CLEAN + '<link rel="canonical" href="https://example.org/x.html">', 1],
    ['a preload', CLEAN + '<link rel="preload" as="font" href="f.woff2">', 1],
    ['an off-host url()', CLEAN + '<style>a{background:url(https://x.example/i.png)}</style>', 1],
    ['an unlisted anchor', CLEAN + '<a href="https://example.org/blog">x</a>', 1],
    ['an inline handler', CLEAN + '<button onclick="x()">go</button>', 1],
    ['a missing CSP', '<a href="writeups/">local</a>', 2],
  ];
  let failed = 0;
  for (const [name, html, expected] of cases) {
    const got = checkHtml(html, 'probe').length;
    const ok = got === expected;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` — expected ${expected} finding(s), got ${got}`}`);
    if (!ok) failed++;
  }
  return failed;
}

function main() {
  if (process.argv.includes('--self-test-only')) {
    console.log('site self-containment check — self-test:');
    return selfTest() === 0 ? 0 : 1;
  }

  console.log('=== site self-containment check ===');
  console.log('  self-test (a checker that finds nothing would otherwise report clean):');
  if (selfTest() !== 0) {
    console.error('\nFAIL  the checker failed its own self-test. Its verdict below means nothing.');
    return 1;
  }

  const dir = path.join(REPO, 'site');
  const pages = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) pages.push(p);
    }
  };
  if (!fs.existsSync(dir)) { console.error('\nFAIL  there is no site/ directory to check'); return 1; }
  walk(dir);

  if (pages.length === 0) {
    console.error('\nFAIL  site/ contains no HTML at all - either the site is gone or this check is blind');
    return 1;
  }

  const findings = pages.flatMap((p) => checkHtml(fs.readFileSync(p, 'utf8'), path.relative(REPO, p)));
  console.log(`\n  ${pages.length} page(s) checked`);

  if (findings.length > 0) {
    console.error(`\n=== REFUSING TO PUBLISH: the site is no longer self-contained ===\n`);
    for (const f of findings) console.error(`FAIL  ${f}`);
    return 1;
  }
  console.log('\nPASS  every page fetches nothing off-host, runs no script, and carries the CSP');
  return 0;
}

process.exit(main());
