# Codex Cloud interface — shipping feature spec

Owner ruling (2026-08-09): *"the cloud interface for codex we are building is a feature we
need to have in the shipment."* This document is the build spec. It is written by the
session that ran ~2,400 cloud lanes through the raw CLI in one day, and every requirement
below exists because its absence cost real time today. Treat the WHY notes as contract,
not color.

## What it is

A ToolsEnabled surface for running work on Codex Cloud: compose a task, bind it to an
environment, dispatch in waves, watch status, read results, and stage diffs for apply.
The product already runs LOCAL codex through the mission bridge; this is the remote
counterpart. Nothing here invents new backend capability — it productizes the proven CLI:

    codex cloud exec --env <ENV_ID> --branch <branch> [--attempts N] "<prompt>"
    codex cloud list / status <task> / diff <task> / apply <task>

## Ground truths the UI must encode (each one burned us today)

1. **An environment is bound to ONE repo, created in the Codex web UI.** There is no
   `--repo` flag. The UI must treat env↔repo binding as data (name, repo, env id) the
   user configures once, and must refuse a dispatch whose target files are not in the
   bound repo. Today a 95-lane wave burned because jobs for repo B went to an env bound
   to repo A's tree expectations.
2. **`--branch` is mandatory in practice.** Lanes must also self-verify: a brief carries
   an expected HEAD pin; a mismatched pin means the lane STOPS. The UI must (a) resolve
   the remote tip at dispatch time, never cache it, and (b) surface stopped-on-stale-pin
   as its own status — 111 lanes stopped on one stale pin today, and telling that apart
   from failure is the difference between re-pinning and re-writing.
3. **There is no cancel.** Once sent, a task runs. The UI must say this before dispatch
   (confirm on wave launch) and must never render a "cancel" affordance it cannot honor.
4. **`apply` STAGES; nothing auto-applies.** The UI's apply action stages a diff into the
   working tree. It must show staged-vs-committed state explicitly, and never describe a
   staged diff as "applied."
5. **Results arrive by polling, and silence is ambiguous.** A quiet task is either
   running, rate-limited (429), or lost. The status view must distinguish
   RUNNING / READY(diff) / REPORT-ONLY / STOPPED(reason) / NO-OUTPUT / NO-HARVEST(retry
   later) — these verdicts exist because a binary done/failed model misreads half the
   real states. NO-HARVEST is transport, not failure; it retries on later polls.
6. **A failure reported as a success is the product's named enemy.** Every wrapper today
   that returned exit 0 while the underlying dispatch died (bad path, dead env, mangled
   quoting) cost a detection cycle. The UI must verify a task EXISTS on the cloud side
   after dispatch (list/status roundtrip) before showing it as sent.
7. **Waves, not floods.** Dispatch N per interval (default 5–15 per 60s, user-set) with
   a live counter, an abort-remaining control (aborting the *queue* is possible; the
   already-sent are not), and a visible reason when the queue pauses.
8. **Briefs are templates.** A task = brief template + per-file substitution
   ({{FILE}}, {{HEAD}}, {{SLUG}}...). The UI should ship with the concept of reusable
   brief classes (audit/harden/testgap/cleanup...) and let users author their own. The
   brief carries the ground-check contract (pin + tree marker) — see #2.
9. **Harvest merges; resolved entries are immutable.** The results store must be
   append/merge, never overwrite, so a partial poll can never un-resolve a lane.
10. **Secrets never enter prompts or task bodies.** The CLI is already authenticated;
    the UI must never ask for or display tokens, and task bodies must be linted for
    credential-shaped content before send (the engine's egress preflight is precedent).

## Minimum shippable surface (V1 of the feature)

- **Environments panel**: list configured envs (name, repo, env id, last-used). Add/edit
  is manual entry of an env id with a "test binding" button (runs a trivial cloud exec or
  list and shows the true result). Env ids are user settings, not constants.
- **Dispatch panel**: pick env, branch (default = current remote tip, shown resolved),
  brief class, file list (paste or picker), wave size/interval. Preflight shows: N tasks,
  repo binding check, pin resolved. Launch = confirm dialog stating no-cancel.
- **Tasks panel**: live list with the status taxonomy from #5, filterable; per-task
  detail = prompt, status history, diff (rendered), report text.
- **Apply flow**: stage diff → show staged files → hand off to the user's own
  commit workflow. No auto-commit in V1.
- **All state local and durable** (userData), surviving restart mid-wave: a wave in
  flight resumes its queue on relaunch instead of forgetting it.

## Explicitly NOT in V1 of the feature

- No adjudication/verification pipeline in-app (that stays operational tooling).
- No multi-account juggling; one authenticated codex CLI is assumed.
- No auto-apply, no auto-commit, no auto-push. Ever, without a separate owner decision.

## Build notes

- Backend: shell (Electron main) spawns the codex CLI exactly as the bridge spawns local
  codex today — `windowsHide: true`, no shell:true, bounded timeouts, output captured to
  files not pipes. Exit codes read directly, never through a pipe.
- The engine repo's `C:\lanes\dispatch-swarm.js` + `cloud-harvest.js` are the proven
  reference implementations of wave dispatch and merge-harvest. Port their *behavior*
  (including the missing-manifest hard-fail and the HEAD-pin auto-resolve), not their
  file layout.
- Candidate builder: Machine B's app development system, after installer validation
  completes. This spec is written to be read cold.

---

*ToolsEnabled — created by Joshua Pinckard, sole founder.
Published by ToolsEnabled, Inc. (in formation). Copyright © 2026 Joshua Pinckard.*
