**Correcting the automated reply above — it was wrong, and all four of your questions are answered in the documentation.**

The bot replied *"I could not find an answer to this in the published documents."* That was not true. It was running with no corpus loaded at all, so it had read nothing and reported that as the documents not covering your question. Four separate defects lined up to produce that comment; they are fixed, and issue #14 is now a committed regression test so this exact comment cannot come back.

Here are the four answers, quoted from the files rather than summarised, so you can check every word.

---

**1. Is this free or paid?**

From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md) — *Is it free?*:

> **Is it free?**
> Yes. usewarden is free and open source under the MIT licence, and there is no paid tier, no
> account, and nothing to sign up for. The blocking — Layer 1 — costs nothing to run: it is
> deterministic pattern and scope matching, so it makes no API calls and consumes no tokens. The
> only thing that can ever cost money is the optional Layer 2 drift judge, and only if you point it
> at a paid API with **your own key**; leave it unconfigured and usewarden says so and keeps
> blocking. See *Do I need an API key?* below.

**2. How do I install it?**  and  **3. How do I use it?**

From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md) — *Quickstart*:

> ```bash
> git clone https://github.com/djayamah/usewarden && cd usewarden
> npm install && npm run build
> node dist/src/cli.js init      # detects your agents, shows you a diff, registers hooks
> node dist/src/cli.js demo      # see a real incident card in 5 seconds
> node dist/src/cli.js status    # is it actually protecting you right now?
> ```
>
> Node ≥ 22.13. Zero runtime dependencies. No install scripts. MIT.

`init` registers the hooks, `demo` shows you a real incident card, and `status` answers the question that matters most — whether it is actually running right now, rather than installed and silent.

**4. How do I monitor the impact?**

From [`docs/METRICS.md`](https://github.com/djayamah/usewarden/blob/main/docs/METRICS.md) — *How do I monitor what usewarden has caught, and see its impact?*:

> **Three commands for tracking what usewarden has caught and what impact it has had:**
>
> ```bash
> usewarden incidents     # the incident wall — every catch, as a readable card
> usewarden metrics       # the impact figures, and what they refuse to estimate
> usewarden dashboard     # the same, in a browser, read-only, on 127.0.0.1
> ```
>
> `usewarden incidents` is the one to look at if you want to know whether usewarden is earning its
> place. One card per catch: when, which agent, what it tried, and the policy line that stopped it.
> A week of real sessions with an empty wall is a genuine answer, and so is a full one. Catches from
> `usewarden demo` are labelled `demo` and never move the headline figures.

That section did not exist when you asked. The words `monitor`, `impact`, `track` and `caught` appeared **zero** times in a document about metrics, so the bot genuinely could not match your question to it — it was right that nothing matched, and wrong to describe that as your question not being covered. The gap was in the documentation and it was fixed there rather than worked around in the retriever.

---

*Posted by the maintainer. The bot has not been re-run on this issue: it is designed never to reply to a maintainer and never to answer the same person twice in one thread, and both rules held here.*
