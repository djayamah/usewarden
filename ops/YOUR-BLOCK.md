# SUPERSEDED — see ops/MANUAL-STEPS.md

> **This file is no longer maintained.** `ops/MANUAL-STEPS.md` is the single canonical
> list of things only the founder can do, rebuilt from scratch on 2026-08-24 with a dated
> primary source proving each remaining item cannot be automated (CLAUDE.md §8).
>
> Several items on this page were **never constraints** — the dist-tag step and the GitHub
> deployment approval among them. Do not work from it.

---

<details><summary>Historical contents, kept as the record</summary>

# Your block — one sitting, no context switching

**Everything I can do is done before you sit down.** This page is only the part that needs your
browser or your security key. It is written to be read top to bottom once, in a single session of
about **17 minutes**, with no point where you have to come back to me for anything.

**Before you start, open two tabs:**

- `https://www.npmjs.com` — signed in
- a terminal in any directory (you will not need the repo until Part B)

**One rule for the whole page:** every prompt asking for a password, a code, or a key is for you
and your browser. Do not type any of them anywhere else — not into a file, not into a chat, not
into a terminal that is being recorded.

---

## Part A — your npm account (browser only, ~6 min)

### A1. Two-factor → security key

**npmjs.com → your avatar → Account → Two-factor authentication**

- It must be **enabled**, using a **security key or passkey**. Not an authenticator-app code you
  type by hand. Never SMS.
- The mode must be **"Authorization and writes"**, not "Authorization only".

**You should see:** a security key listed, and "Authorization and writes" selected.

### A2. Tokens → empty

**Account → Tokens**

Delete anything in the list. With this plan no token needs to exist at any point, which is the
whole point of it — there is nothing to leak and nothing to remember to revoke.

**You should see:** "You don't seem to have any tokens" or an empty table.

---

## Part B — bring the package into existence (terminal + key, ~6 min)

This is the one step that exists purely to defeat a chicken-and-egg: **you cannot configure a
trusted publisher for a package that does not exist**, and npm's docs say so outright. So version
`0.0.0` goes up once, tagged `bootstrap`, which means nobody typing `npm install usewarden` will
ever receive it.

### B1. Log in through the browser

```bash
npm login --auth-type=web
```

Press Enter when it offers to open your browser; authenticate with your key.

**You should see:** `npm whoami` prints your username.

### B2. Get a clean copy and check it builds

```bash
cd ~/Desktop
git clone https://github.com/djayamah/usewarden.git usewarden-release
cd usewarden-release
npm ci --ignore-scripts && npm run build && npm test
```

**You should see:** the last line of the test output says `fail 0`. Ignore the total; it is a
property of the tree, not a number to match.

### B3. Send the bootstrap version

```bash
npm version 0.0.0 --no-git-tag-version
npm publish --tag bootstrap --access public
```

Authenticate with your key when asked.

```bash
git checkout -- package.json package-lock.json
npm view usewarden dist-tags
```

**You should see:** a `bootstrap` tag and **no `latest` tag**.

> **If it shows `latest`:** the `--tag` flag did not take. Not dangerous — you made it and you know
> what is in it — but it is not what should be installed by default. It is fixed later in one line
> (`npm dist-tag add usewarden@0.1.0 latest`) once `0.1.0` exists. Carry on; note it and move to B4.

### B4. Configure the trusted publisher — stage only

```bash
npm trust github usewarden \
  --repo djayamah/usewarden \
  --file release.yml \
  --env release \
  --allow-stage-publish
```

**Read that once more before running it.** `--allow-stage-publish` is present and `--allow-publish`
is absent, and that is the entire point: with stage permission only, the registry refuses a direct
release even from a workflow later rewritten to attempt one. It is the control that does not depend
on the workflow file staying honest.

```bash
npm trust list usewarden
```

**You should see:** one entry, `djayamah/usewarden`, `release.yml`, stage permission only.

---

## Part C — lock it down (browser only, ~2 min)

Now that the package exists, it has its own settings page.

**npmjs.com → usewarden → Settings → Publishing access** → select:

> **Require two-factor authentication and disallow tokens**

**You should see:** that option selected, and the page saved.

This is safe alongside what you just did in B4, and that question is no longer open — npm's own
documentation says:

> *"The 'disallow tokens' setting only affects traditional token authentication. Your trusted
> publishers will continue to work normally, as they use OIDC tokens."*

---

## Part D — the release itself (~3 min, and this is the irreversible bit)

**Do this part whenever you like — it does not have to be the same sitting.** Between Part C and
here, I stage the release. You will know it is ready because `npm stage list usewarden` shows
something.

### D1. Look at what is waiting

```bash
npm stage list usewarden
npm stage view <the-stage-id-from-the-list>
```

Note: `list` takes the package name. **`view`, `download`, `approve` and `reject` take the stage id
and nothing else** — no package name. (The runbook had that wrong until it was dry-run.)

### D2. Run the actual bytes before you approve them

```bash
mkdir -p ~/Desktop/usewarden-check && cd ~/Desktop/usewarden-check
npm stage download <stage-id>
tar -xzf usewarden-0.1.0.tgz
node package/dist/src/cli.js --version
node package/dist/src/cli.js demo
```

**You should see:** `0.1.0`, and then incident cards. That is the thing a stranger would install,
running from the exact file that would be published.

### D3. Approve

```bash
npm stage approve <stage-id>
```

You will be asked for two-factor. **This prompt is the release.** Everything before it was
reversible; this is not.

**If anything looked wrong in D1 or D2, do not just walk away** — the staged package sits in the
queue. Clear it with `npm stage reject <stage-id>`. Rejecting costs nothing; nothing was ever
installable.

---

## That is your whole part

Everything else — merging the workflow and bot PRs, running the release workflow in dry-run and
stage mode, approving the environment gate, reading the file list, checking provenance, deprecating
the bootstrap version, deploying the aggregator — is mine, and is either done or waiting on Part B.

**The one thing to check afterwards, and it takes ten seconds:** open
`npmjs.com/package/usewarden`, find the **provenance** section, and confirm the commit hash matches
the one in my report. Provenance proves which commit was built, not that the commit was a good
idea; reading the badge without reading the hash gets you nothing.

</details>
