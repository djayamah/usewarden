Thanks for asking — here is the answer from the documentation.

Here is what this repository says. I am quoting it directly rather than summarising, so you can check every word against the source:

**From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md) — *Is it free?*:**

> **Is it free?**
> Yes. usewarden is free and open source under the MIT licence, and there is no paid tier, no
> account, and nothing to sign up for. The blocking — Layer 1 — costs nothing to run: it is
> deterministic pattern and scope matching, so it makes no API calls and consumes no tokens. The
> only thing that can ever cost money is the optional Layer 2 drift judge, and only if you point it
> at a paid API with **your own key**; leave it unconfigured and usewarden says so and keeps
> blocking. See *Do I need an API key?* below.

**From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md) — *Do I need an API key?*:**

> **Do I need an API key?**
> No. **Layer 1 — the blocking — needs no key and costs nothing.** It is deterministic pattern and
> scope matching: zero tokens, every event, and it catches 15 of the 17 scenarios in the project's
> own sabotage suite on its own. Layer 2, the semantic drift judge, is optional and **you bring your
> own key**; it will also use an already-authenticated `claude` or `gemini` CLI on your PATH, which
> costs no extra money. With nothing configured at all, Layer 2 announces itself as off and Layer 1
> runs unchanged — verified, not assumed.

**From [`README.md`](https://github.com/djayamah/usewarden/blob/main/README.md) — *Does this send my code anywhere?*:**

> **Does this send my code anywhere?**
> No. Layer 1 is entirely local and never leaves your machine. Telemetry is off by default and this
> version ships **no endpoint at all** — there is nowhere for a payload to go even if it were built
> ([docs/TELEMETRY.md](docs/TELEMETRY.md)). The only thing that can ever leave is an optional Layer 2
> judge call, which you switch on yourself, to a provider you choose, with your own key. Its input is
> redacted and length-capped first.

---
_🤖 **Automated triage — I am a bot.** I match the issue text against this project's own recorded defects and quote from its documents. **Everything substantive above is a direct quotation from a file in this repository, linked so you can check it.** I do not answer from general knowledge, I have not reproduced anything, I cannot fix anything, I never close issues, and I never promise a timeline. A human reads every issue._
