# commit-msg provenance hook — installation record and self-test

Installed 2026-08-11 into `wt-capability` (branch `packaging/capability-layer`).
Source of truth: the engine repository's own `.githooks/commit-msg`,
copied byte-for-byte — the staged blob hash is `f9912c4ddf9b75873be3ec2b63b942bc3116d766`,
identical to the engine's, so the rules and the refusal text are not a paraphrase.

## What was unattributable

Every commit on this machine reads `author=Josh Pinckard` — the owner's, every
agent's, every lane's, identically. The git author field cannot distinguish them,
so the `Lane:` trailer is the only thing that can.

Measured 2026-08-11, counting COMMITS (not lines) over the last 200:

| tree / branch | commits with `^Lane:` | with `^Co-Authored-By:` |
|---|---|---|
| engine `toolsenabled-current` | **200 / 200** | 200 / 200 |
| this branch `packaging/capability-layer` | **114 / 200** | 179 / 200 |
| `mission-control` HEAD (`r1198/page2-functional`) | **3 / 167** | not measured |

86 of the last 200 commits on this branch cannot be attributed to a seat. The
engine's 200/200 is not diligence — it is this hook, which the engine has and
this repository did not.

The `3 / 167` line is the more alarming number and this hook does **not** fix it;
see Coverage below.

## History was deliberately NOT rewritten

Those 86 commits stay unattributable. Adding trailers retroactively means
rewriting hashes that other lanes already hold — this repository has 24
worktrees sharing it — and a back-filled trailer would be a guess about who
wrote something, which is a fabricated signature rather than a recovered one.
The information is simply gone. The hook stops the 87th.

## Self-test — proof it blocks AND allows

Run against real `git commit` invocations in this worktree. Exit codes captured
without a pipe (`cmd > file 2>&1; echo "EXIT=$?"`), so they are git's status and
not some downstream command's.

| # | commit message | exit | result |
|---|---|---|---|
| 1 | no trailers at all | **1** | REFUSED |
| 2 | `Co-Authored-By:` only, no `Lane:` | **1** | REFUSED |
| 3 | `Lane: app-tree (packaging work)` — no session id | **1** | REFUSED |
| 4 | both trailers, `Lane: ... (session 6f84bf9b)` | **0** | ALLOWED — it is the commit that added this file |

All three refusals printed the hook's own banner
(`[provenance] REFUSED: this commit does not say who wrote it.`) and left HEAD
unmoved. None was a pathspec error masquerading as a refusal — that was checked
explicitly, because a hook that "fails" for the wrong reason tests nothing.

Test 3 is the one worth keeping: `Lane:` alone is not enough. The hook requires
the literal word `session` plus an id of 4+ characters, because a lane NAME
describes the work and two seats doing the same work write the same name.

## The line-ending trap this repository had waiting

`core.autocrlf=true` here and, until now, no `.gitattributes` at all. Git would
have rewritten the hook to CRLF on the next checkout, giving it a `#!/bin/sh\r`
shebang that cannot be resolved. Git skips a hook it cannot execute **without
reporting anything** — the hook would have looked installed and enforced nothing.

Measured, not assumed: a control file committed alongside it came back from
checkout with CRs; `.githooks/commit-msg` came back with 0 CRs and the same md5
as the engine's copy, because `/.githooks/** text eol=lf` in `/.gitattributes`
pins it. That one line is load-bearing — do not drop it.

## Coverage — read this before trusting it

- `core.hooksPath=.githooks` is **per-repository**, written to the shared
  `mission-control/.git/config`, so all 24 worktrees now read it.
- The path is **relative**, so each worktree resolves it against its own working
  tree root. Only branches that actually contain `.githooks/commit-msg` are
  enforced — today that is this branch alone. The other 23 worktrees are
  unaffected in behaviour, and no hook was disabled by the change (the shared
  `.git/hooks` held only `.sample` files, and there is no husky/prepare script).
- Consequence: the branch measured at **3/167** is not covered. Merging this
  branch carries the hook to wherever it lands; until then those lanes are
  unenforced. Repo-wide coverage would need an absolute `core.hooksPath` outside
  the working tree, which changes every lane's commit behaviour at once and is a
  decision for whoever owns this repository, not for this lane.

Bypass remains possible with `--no-verify`. This is a guard against forgetting,
which is what produced the 86, not a guard against intent.
