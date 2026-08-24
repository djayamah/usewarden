# site/ — the landing page

> ## THIS PAGE IS NOT DEPLOYED.
>
> It is a local artifact. There is no host, no DNS record, no CI publish job, no CDN, and no
> deploy config anywhere in this repository. Putting it somewhere is a founder decision and a
> founder action.

One file, `index.html`. Open it directly:

```bash
open site/index.html          # macOS
xdg-open site/index.html      # Linux
```

## Constraints it is built under

- **Self-contained.** No external stylesheet, script, font, image, or analytics. The
  `content-security-policy` meta tag blocks all of it, and the page is written so that it never
  wants any: `default-src 'none'`, `style-src 'unsafe-inline'` for the single inline stylesheet,
  and no `<script>` at all.
- **No tracking.** No analytics, no beacons, no cookies, no third-party embeds. `referrer` is
  `no-referrer`. A landing page for a privacy-preserving tool that phoned home would be an
  argument against the product.
- **Theme-aware.** Light is the base palette; dark redefines only the tokens under
  `prefers-color-scheme`.
- **Responsive.** Wide content (the tables, the incident card, the code block) scrolls inside its
  own container. The page body never scrolls sideways.

## Every claim on it is sourced

The page is built from evidence already in this repository, not from copywriting:

| Claim on the page | Where it comes from |
|---|---|
| the incident card and the agent's reply | `verification/live/01-env-read.txt`, verbatim from a real Claude Code session |
| layer 1 catches 15 of 17 | SAB-13, `verification/phase6-sabotage.txt` |
| hooks removed → the attack succeeds → UNPROTECTED | SAB-08, the A/B proof in `verification/live/08-ab-removal.txt` |
| zero runtime dependencies, no install scripts | T-01 and T-03 in `tests/packaging.test.ts` |
| uninstall restores byte-identically | Phase 7 clean-machine simulation, sha256-verified |
| how the numbers are counted | `docs/METRICS.md` |

`tests/site.test.ts` re-checks the checkable ones against the repository on every run, so the
page cannot quietly drift away from what the product actually does — and asserts the
self-contained and no-tracking properties above rather than trusting them.

The page also states plainly, in its own text, that usewarden is not yet published, so nobody
reads it as an invitation to `npm install` something that is not there.

## If you ever deploy this

1. Nothing needs a build step. It is one file.
2. Serve it over HTTPS with the same CSP as a real response header, not only as a meta tag.
3. Do not add analytics. If you must measure something, measure it in a way you would be happy to
   describe in the "Telemetry" section of this very page.
