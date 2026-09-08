# PUBLIC REPO: an identifying string is live right now

**Found:** 2026-08-20, by running `SCAN_REF=triage-bot-fix ./scripts/pre-public-scan.sh`.
**Where:** `ops/BOT-SCOPE.md`, line 7, on `djayamah/usewarden` — the PUBLIC repo.
**Status:** already corrected on the private `main`. The correction has never reached the
public repo, because pushing there is exception 1.

## The line as it stands publicly

*The identifying word is REDACTED below rather than reproduced — writing it into this file would
put it right back into a repository, which is the mistake this document exists to report.*

```
A **separate, isolated service.** It is not an <REDACTED-IDENTITY>/OpenClaw skill, it shares no code path with
the founder's personal agent setup, and it has no route to any personal system. It runs as a
GitHub Actions job in this repository, from this repository's checkout, and nowhere else.
```

It names your personal agent setup. That is the string `scripts/scan-identity.txt` exists to
catch, and the scan catches it — it has simply never been run against the public repo's own
current contents until tonight.

## The corrected text, already on private main

```
A **separate, isolated service.** It is not a plugin or a skill inside the founder's personal
agent setup, shares no code path with it, and has no route to any personal system. It runs as a
GitHub Actions job in this repository, from this repository's checkout, and nowhere else.
```

## To fix it (about two minutes, all yours)

```bash
cd /path/to/your/clone/of/usewarden      # the PUBLIC repo
git checkout -b fix-identity-string
# edit ops/BOT-SCOPE.md line 7 to the corrected text above
git commit -am 'docs: remove an identifying string from BOT-SCOPE'
git push -u origin fix-identity-string
gh pr create --fill && gh pr merge --squash
```

Note that this only changes the current file. The old text stays reachable in the public
repository's history, and on a public repo GitHub keeps unreachable objects fetchable by SHA
for a long time. Whether that matters is your call — the string is your first name next to a
tool name, in a sentence saying the bot is ISOLATED from it. It is not a credential and it is
not a private path. It is simply more identifying than the rest of the repository is.
