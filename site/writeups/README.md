# site/writeups/ — the canonical home for the write-up series

**Live at <https://djayamah.github.io/usewarden/writeups/>**, served by GitHub Pages from this
repository. Free, no domain purchased, no hosting account, no interactive login.

## Why this exists rather than publishing straight to Discussions

Decided 2026-08-24, D-222. GitHub Discussions **are** crawlable — `/*/*/discussions` does not
appear in <https://github.com/robots.txt> — so indexability was never the issue. Control is.

A page we own can carry `<link rel="canonical">` pointing at itself, and a Discussion can then
syndicate an excerpt that links back. A Discussion can carry nothing: we do not control its
`<head>`, and there is no way to redirect it later. So an owned home can always adopt Discussions,
and Discussions can never hand the authority back. With one piece published that is a free change;
after seven it is a set of URLs competing with our own that cannot be redirected.

## Why it did not need a hosting account after all

`ops/MANUAL-STEPS.md` listed "a hosting login" as a founder step, on the assumption that owning a
site means renting a server. It does not (D-227).

- GitHub Pages is free for public repositories.
- It is enabled through the REST API: `POST /repos/{owner}/{repo}/pages`, which
  [documents](https://docs.github.com/en/rest/pages/pages) that "OAuth app tokens and personal
  access tokens (classic) need the `repo` scope" — the token already in use here.
- The legacy source only accepts `/` or `/docs` as a directory. `site/` is neither, so the site is
  published by `.github/workflows/pages.yml` using `build_type: workflow`, which takes any path.
  Nothing was rearranged to fit the deployment mechanism.

That step is now deleted from the founder's list rather than explained on it.

## The rule for every page in here

1. `<link rel="canonical">` pointing at the page's own URL. **Emitted by the generator, never
   typed**, so it cannot be forgotten on piece five — and asserted by `tests/site.test.ts`.
2. Self-contained: no script, no CDN, no external font, no analytics. The deploy workflow refuses
   to publish a page that breaks this, and that gate was proven against a sabotaged copy before it
   shipped.
3. Only **published** pieces are rendered. A page for an unpublished draft would be a live URL for
   something nobody decided to release.
4. Published as the canonical first; the Discussion is a shorter version that links home.

## Adding the next piece

Write it in `launch/writeups/` (internal-only — the markdown source does not ship), add its
Discussion URL to `DISCUSSIONS` in `scripts/build-writeups.mjs`, then:

```bash
node scripts/build-writeups.mjs
npm test                          # asserts the rendered pages match their source
```

Push to `main` and the `pages` workflow deploys it. `--check` fails if a rendered page has drifted
from its markdown, because a stale canonical copy is a lie with a date on it.
