# commit-msg provenance hook — installation record and self-test

The hook enforces the same rules as the engine repository's own
`.githooks/commit-msg`.

## What it closes

In a repository where many agents and lanes commit under one shared git author,
the author field cannot distinguish them, so the `Lane:` trailer (with a session
id) is the only thing that can. A repository without this hook accumulates
commits that cannot be attributed to a seat; a repository with it does not.

## History is deliberately NOT rewritten

Commits made before the hook existed stay as they are. Adding trailers
retroactively means rewriting hashes that other lanes already hold, and a
back-filled trailer would be a guess about who wrote something, which is a
fabricated signature rather than a recovered one.

## Self-test — proof it blocks AND allows

Run against real `git commit` invocations. Exit codes captured without a pipe
(`cmd > file 2>&1; echo "EXIT=$?"`), so they are git's status and not some
downstream command's.

| # | commit message | exit | result |
|---|---|---|---|
| 1 | no trailers at all | **1** | REFUSED |
| 2 | `Co-Authored-By:` only, no `Lane:` | **1** | REFUSED |
| 3 | `Lane: app-tree (packaging work)` — no session id | **1** | REFUSED |
| 4 | both trailers, `Lane: ... (session 1a2b3c4d)` | **0** | ALLOWED |

All three refusals printed the hook's own banner
(`[provenance] REFUSED: this commit does not say who wrote it.`) and left HEAD
unmoved. None was a pathspec error masquerading as a refusal — that was checked
explicitly, because a hook that "fails" for the wrong reason tests nothing.

Test 3 is the one worth keeping: `Lane:` alone is not enough. The hook requires
the literal word `session` plus an id of 4+ characters, because a lane NAME
describes the work and two seats doing the same work write the same name.

## The line-ending trap

With `core.autocrlf=true` and no `.gitattributes`, git would rewrite the hook to
CRLF on checkout, giving it a `#!/bin/sh\r` shebang that cannot be resolved. Git
skips a hook it cannot execute **without reporting anything** — the hook would
look installed and enforce nothing.

`/.githooks/** text eol=lf` in `/.gitattributes` pins it: a checked-out
`.githooks/commit-msg` has 0 CRs. That one line is load-bearing — do not drop
it.

## Coverage — read this before trusting it

- `core.hooksPath=.githooks` is **per-repository** configuration.
- The path is **relative**, so each worktree resolves it against its own working
  tree root, and only branches that actually contain `.githooks/commit-msg` are
  enforced.
- Repo-wide coverage would need an absolute `core.hooksPath` outside the working
  tree, which changes every lane's commit behaviour at once and is a decision for
  whoever owns the repository.

Bypass remains possible with `--no-verify`. This is a guard against forgetting,
not a guard against intent.
