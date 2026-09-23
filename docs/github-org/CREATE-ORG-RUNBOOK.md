# Creating the ToolsEnabled GitHub organization

Status: **not created.** Blocked, with the blocking step named below. Everything the
organization needs on day one is already written and committed; this is the click path.

## Why this is not automated

There is no REST endpoint that creates an organization on github.com. The organizations
API exposes list, get, update and delete only — creation is web-only for github.com
accounts. (`POST /admin/organizations` exists, but only on GitHub Enterprise Server.)
So this is a browser task by GitHub's design, not by ours.

## What blocked it

Not permissions, not credentials, not GitHub. The local audit ledger.

Every ToolsEnabled MCP tool whose effect is `external-write` — which includes
`browser.start` — calls `requireRecord()` in `src/lib/audit.js`, which refuses when the
durable audit intent cannot be written:

```
Durable audit intent could not be recorded; the external mutation was not started.
```

Underneath that is `SQLITE_BUSY` on the audit database, after the 5000 ms
`BEGIN IMMEDIATE` retry budget is exhausted. External writes always force an anchor
write, and the anchor write runs a synchronous `powershell.exe` vault call *inside* the
held SQLite transaction, so each one holds the global audit write lock for ~8 seconds —
longer than the retry budget other callers are given. Under ~120 concurrent agent
processes it fails effectively every time.

The ledger itself is healthy: chain contiguous, anchor matching, signatures valid, spool
drained. This is contention, not corruption.

**Check whether it has cleared:**

```
node tools/audit-durability-check.js
```

`audit durability: OK` means retry the browser step. `CRITICAL` means it will fail again.

**What clears it:** fewer concurrent agent processes, or restarting the MCP server with
`TOOLSENABLED_AUDIT_TRANSACTION_RETRY_MS=30000`.

Do **not** work around this by driving the browser outside the audited path. Creating an
organization is an identity-bearing action taken under the owner's name, which is
precisely what the audit control exists to record.

## The click path

Signed in as the owner's GitHub account.

1. Go to **https://github.com/account/organizations/new?plan=free**
   (Or: profile menu → *Your organizations* → *New organization* → *Create a free
   organization*.)
2. **Organization name:** `ToolsEnabled`
   Verified available — `github.com/ToolsEnabled` and `github.com/toolsenabled` both
   return 404. GitHub names are case-insensitive for uniqueness, so this claims both.
3. **Contact email:** the owner's primary GitHub account email.
4. **This organization belongs to:** *My personal account.*
   Not "A business or institution" — that option is about billing and support
   attribution, and ToolsEnabled, Inc. does not exist yet. It can be changed after
   incorporation.
5. Complete the human-verification step if shown, then **Next**.
6. **Invite members:** skip. No outside developers yet.
7. Finish the optional survey or skip it.

## Immediately after creation

1. **Verify the name landed:** `https://github.com/ToolsEnabled` resolves.
2. **Create the profile repository.** In the organization: *New repository*, named
   exactly `.github`, **Public**, initialised with a README.
   This repository is public by design and contains only the profile page. It does not
   publish the product.
3. **Add the profile page.** Create `profile/README.md` in that repository and paste the
   content of [`profile-README.md`](profile-README.md) — everything below the HTML
   comment. GitHub renders it at `https://github.com/ToolsEnabled`.
4. **Organization settings → Member privileges:** set base permissions to *Read*, and
   turn off members' ability to create public repositories. Only approved code enters the
   official build, and this is the mechanical half of that.
5. **Enable two-factor requirement** for the organization.

## What must NOT happen yet

**Do not create, transfer or make public any product repository.**

The three items publication was originally gated on are **done**, verified in the staged
payload: the passport-MRZ module, the cloud-account-pinned provider routes, and the other
product's release automation are all gone. The boundary gate now exits 0.

**Exit 0 does not mean "safe to publish", and this is the trap.** Read what the gate
actually asserts:

```
node tools/check-payload-boundary.mjs capability
  Classified: open=<n> pending=<n> paid=0 excluded=0 unclassified=0
  Payload boundary: clean. Nothing paid, excluded or unclassified is present.
```

**The publication condition is `pending = 0`, read from the `Classified:` line — not exit
0, and not the last line of the output.** A `pending` file is one whose fate has been
decided but which *still ships today*; the guard deliberately does not fail on those.

**Nothing `pending` may still ship**, and it is now checkable by a command rather than by
a reader remembering it:

```
node tools/check-payload-boundary.mjs --ship capability
  NOT PUBLISHABLE -- N file(s) are still "pending" and still ship:
    <each path, named>                                            exit 1
```

`--ship` is the strict verdict: it fails while anything is `pending`. The permissive
default is deliberate, so development does not sit red.

**Read the named paths, not the tally.** That block enumerates the files; go fix or
reclassify the ones it names. Do not copy a number out of this guard into anything,
including into this page. **A count is a summary of a set, and a summary can be wrong in
ways the set cannot** — the paths stay unambiguous through every way the number can go
wrong.

Read the **refusal block itself**, and do not count path-shaped lines across the whole
output: a `--ship` run prints each pending file twice, once in the pending report and once
in the refusal, so grepping the output doubles it while the block alone lists each path
once.

*History, so nobody re-derives it: the summary line once counted findings rather than
distinct paths, and a payload seen under two roots reported double. Fixed in `70dad9f` —
it now reads `Classified (distinct paths across N root(s))`. Do not reproduce that
measurement; it no longer holds, and the reason this note carries its fix commit is that
the earlier version of this page cited the broken number as evidence.*

Pass the payload root explicitly anyway. A bare invocation answers a question about
whatever default roots it finds — which can include a stale build under `release/` that
nobody is shipping — and "which directory did this verdict describe?" is not a question
you want to be reconstructing at publish time.

### The third gate, and why "all three green" is not the fence

`check-payload-current` compares the staged bytes against the **working tree**. So it goes
red the moment any lane has an uncommitted edit to a payload file, which during active
work is most of the time. A gate that is permanently red in normal conditions is one that
gets waived, so do not write "all three green" into a checklist and expect it to survive.

The order that makes the third gate meaningful instead of noisy:

1. **`require-clean-tree`** green — this forces the tree clean, which is what makes the
   next two mean anything
2. **a fresh `npm run pack:capability`**
3. **all three payload gates** on that fresh stage
4. **`pending = 0`** via `--ship`

**When that gate is red, it is usually the ordinary case rather than an alarm.** Tell the
two apart before doing anything, because the instinct — re-stage until it goes green — is
wrong in one of them:

| What you find | What it is | What to do |
| --- | --- | --- |
| Staged file is byte-identical to its committed version, and the *source* has uncommitted changes | A lane is mid-edit. Normal. | **Wait.** Re-staging bakes half-finished work into the shared payload, which is worse than a red gate telling the truth |
| `payloadSha256` in `capability/PAYLOAD.json` does not reproduce on a fresh pack | The stage itself is wrong | Re-stage, and find out why the first one was bad |

The first row is what a healthy busy tree looks like all day. A partial or corrupted stage
announces itself through the hash, not through this gate — so check the hash before
concluding anything is broken. This page previously named a specific file as red, which
was true for about an hour; that is the failure this whole section is about, so the
diagnosis is given as a shape you can apply instead.

### The licence verifier must be able to refuse

There was a period when a fresh install could mint a licence and then accept its own —
the verifier treated an absent pinned key as permission to trust whatever signing material
was on the disk. A signature check answers *was this signed by key K*; only a pinned key
answers *should I trust K*.

**That is fixed, and this page is not the way to find out.** Ask the test:

```
node --test tests/license-trust-pinning.test.js        # in the engine tree
```

That is the durable form. This section originally read "do not cut a release until the
pinning lands", which was true when written and became **actively harmful the moment it
was fixed** — a fence that blocks a legitimate release, with nothing in it to tell the
reader the reason had been discharged. Staleness in that direction is worse than the kind
this page keeps warning about, because it looks responsible.

The general rule, and the one this whole page is now built on: **any statement about the
world that a command can answer should be replaced by the command.** A command
re-measures on every invocation and cannot be stale. Prose in the grammar of a rule —
"do not cut until X" — is a measurement of the world wearing a rule's clothes, and it
decays exactly like a count does.

**And a green reading expires.** Re-run the gate against the payload you are actually
about to ship. The full reasoning for both — why the guard does not fail on `pending`, and
why any lane's commit can turn a green reading red without anyone touching the boundary
file — is stated at the source, in the header of `config/payload-boundary.json`. **Read it
there, not here.** That is deliberate: this page used to restate the condition, the
restatement went stale the moment the underlying work moved, and a second copy that drifts
is how "exit 1 means excluded files" became a hazard in the first place. One statement, in
the file the gate reads.

What this page adds, and what is not in that file, is what the remaining `pending` files
actually cost you and in which order to touch them.

### Provenance for the publication record

An exit code names a moment; a hash names the bytes. The staged payload is
byte-reproducible — two consecutive stages produced an identical digest — so record
`payloadSha256` from `capability/PAYLOAD.json` alongside the gate result.

One gotcha before someone reports a drift that is not there: **`PAYLOAD.json`'s
`fileCount` is one lower than the number of files on disk, and that is correct.** The
packer computes the count and digest over the staged set and *then* writes `PAYLOAD.json`
into the same directory, so the record does not count itself. Verified in
`tools/pack-capability-layer.mjs` — `fileCount: all.length` is evaluated before the
`writeFileSync`. Comparing that number against `ls` or against the gate's `Files seen`
will always look off by one, by construction. A file count is not an integrity signal
here; the digest is. If you want to know whether the stage is sound, reproduce
`payloadSha256` with a fresh pack — that is a command, and it answers the question the
count only appears to.

### The files still shipping

This list is a
snapshot — the gate's own `pending` output is authoritative.

**The commercial model, in source form.** Publishing these discloses more of the
business than intended. Nothing operational breaks by publishing them; nothing is at risk
of abuse.

| Still shipping | What it discloses |
| --- | --- |
| `src/lib/entitlement.js` | The actual commercial tier table and prices — the business plan in source form |
| `src/lib/providers/license.js` | Licence-key issuance and verification |
| `src/lib/license-store.js` | The revocation store behind it |

**The condition for making a product repository public is `pending=0`,** not `exit 0`.
Publishing while any restricted modules are staged publishes them, because the installer *is* a
source distribution — 200-plus plain `.js` files next to a trivially extractable
`app.asar`. Whoever publishes must re-run the gate and read the `pending` count, not the
last line.

Note also that untracking a file does not remove it from git history. When the product
repository is eventually published, it needs a fresh repository or a history rewrite —
the existing private remote has history that predates any of this.

---

*ToolsEnabled — created by Joshua Pinckard, sole founder.
Published by ToolsEnabled, Inc. (in formation). Copyright © 2026 Joshua Pinckard.*
