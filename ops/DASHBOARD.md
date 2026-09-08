# Your dashboard — how to look at it

No setup. One command.

```bash
cd ~/dev/warden
npm run dashboard:web
```

Then open **http://127.0.0.1:7777** in your browser. That is the one you want — a proper page,
refreshing itself every minute, readable in five seconds.

If you would rather have it in the terminal, `npm run dashboard` prints the same thing as text.

**There are two modes and one page.** The toggle is top right.

- **Founder** — everything, including the reason each missing number is missing.
- **Presentation** — what you can put in front of someone. `http://127.0.0.1:7777/?mode=present`
  is a direct link to it, so you can open straight into it without toggling in front of anyone.

The two modes read the *same* data — the toggle is styling, not a second version of the page — so
presentation mode can never show a figure that the founder view would contradict. What it hides is
the scaffolding: diagnostics, source URLs, caveat boxes, and **anything that is currently at zero
or unknown**. A panel whose every value is unknown collapses entirely rather than showing a row of
dashes. That is not hiding a bad number; there is no number yet, and five empty bars read to an
audience as a result.

That page shows one screen. It takes a few seconds because it is asking GitHub and npm live rather
than showing you something it saved earlier.

## What you are looking at

**The big number at the top is the only one that really matters.** It is *installs that produced
a first catch* — people who installed usewarden and whose agent then actually did something it
stopped. Not downloads. Not stars. The thing the product exists to do, happening to a real person.

Right now that number shows a dash and says why: it can only be counted once the telemetry
aggregator is running, and it is not. **You do not need to do anything for it to appear.** The
moment the aggregator exists, this fills in by itself.

**Everything below it is secondary and labelled as such.** Downloads especially: they count
robots, build servers and caches as well as people, so they are a traffic number, not a user
number. The dashboard says so every time it prints one, so neither of us starts believing it.

**Every single number tells you where it came from and how old it is.** If something could not be
fetched, it says `unavailable` and explains why — it never shows you a zero that means "we didn't
manage to ask". You never have to wonder whether a figure is real.

## What works today

- **GitHub stars, forks, watchers, open issues** — working now.
- **Clones and visitors, last 14 days** — working now, with a small trend line each. GitHub only
  keeps 14 days, so this is a rolling window, not a total.
- **A caution on the clone number.** Right now it reads 35 unique cloners against 1 unique
  visitor. That is almost certainly robots — mirrors, crawlers, dependency scanners — because a
  person nearly always looks at the page before cloning. GitHub gives no way to filter bots out,
  so the dashboard prints that caution next to the figure rather than letting you quote it.
  **Never show the clone number to an investor as if it were people.** Anyone who knows GitHub
  will discount it in one second, and you will have spent credibility for nothing.
- **Top referrers** — where people came from. Working now.
- **npm downloads** — will say "not published to npm yet", which is correct. It starts working
  by itself on the day you publish.
- **Impact metrics** — waiting on the aggregator, as above.
- **Week-over-week change** on the North Star, clones and visitors. Shown as a rate with its sign,
  or not at all. It needs 14 days of history to compare two weeks against each other; until then
  it says so in words. **It will never draw a flat line to fill the space** — a flat line reads as
  "measured, and steady", which is a different claim from "not known yet", and the second one is
  the true one. If a week rises from zero you get both counts rather than a percentage, because a
  rise from nothing is not a percentage.
- **What it has stopped** — the incident wall. Real catches from this machine, each one a fixed
  sentence in plain English: what an agent tried, and why it was stopped.
  **Nothing identifying can appear here, and that is enforced by construction rather than by
  filtering.** The wall never sees an incident's text. Each catch is reduced to a category, and the
  sentence shown is a constant looked up from a table in the code — so the only per-incident data
  that reaches your screen is a timestamp and the word blocked or warned. Two different catches of
  the same kind produce identical sentences, which is the proof: an identical sentence cannot be
  carrying a path. The test for it stuffs a home directory, an API key, a corporate hostname and a
  credentials command into every field of an incident, checks they really are stored, and then
  checks that none of them survives to the page. Screenshot this panel freely.
- **From install to habit** — the funnel: installed → ran a protected session → had a first catch →
  still active at week 2 → still active at week 4, each stage carrying the drop from the one before
  it. Every stage but the first needs the aggregator, so today the whole panel is unknown and it
  collapses in presentation mode. It appears by itself once there is data.

## If it says a GitHub number is unavailable

It needs to be logged in as you to read traffic numbers — that is GitHub's rule, not ours. If you
have ever run `gh auth login` on this machine, it already works and you can ignore this. If not:

```bash
gh auth login
```

Then run `npm run dashboard` again. **Nothing is stored and no token is ever pasted anywhere** —
it borrows the login you already have.

## For your own agent

```bash
npm run briefing
```

Same information as JSON, so an agent can read it and summarise for you. Includes the list of open
issues with their labels.

**Both commands are read-only.** They make requests that *ask* for information and never send any.
They cannot post, comment, change a setting, or write a file — not to GitHub, not to the repo, not
anywhere. There is no code in them that writes anything.

## The one thing to be careful about

When the impact numbers do light up, they will be a **floor, not a total**: they only count people
who opted in to telemetry, and thin groups are deliberately suppressed so nobody can be identified.
The real number will always be higher than what you see, and unknowable. The dashboard prints that
caveat next to the figure so it is never quietly forgotten.
