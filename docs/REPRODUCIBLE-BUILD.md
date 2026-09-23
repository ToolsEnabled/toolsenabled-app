# Rebuilding a ToolsEnabled installer

The supported release path is the release cutter. Run it from a clean, private
checkout of this app repository and bind both repositories to exact commits:

```powershell
node tools/release-packager/cut-release-candidate.mjs `
  --source-ref <exact-40-character-app-commit> `
  --engine-source-ref <exact-40-character-engine-commit>
```

`npm run dist` is a build primitive, not a complete release cut. The cutter
adds the isolated checkout, exact engine payload, clean-tree checks, packaged
QA, artifact hashing, PE identity verification, immutable build tag, and
declaration artifacts required for a publishable candidate.

## Required inputs

Use two private Git repositories:

- the app repository containing this cutter;
- the engine repository containing the capability layer.

Both inputs must be regular Git roots at the exact commits declared to the
cutter. The engine checkout must be clean and must not contain untracked files,
replacement refs, grafts, assume-unchanged entries, or skip-worktree entries.
The packer checks the engine again after copying its bytes so a source change
during staging fails closed.

Create the ignored app setting `private/capability-source.owner.json`:

```json
{
  "path": "C:\\path\\to\\the-private-engine-checkout",
  "ref": "<exact-40-character-engine-commit>"
}
```

The setting's `ref`, `--engine-source-ref`, and the engine checkout's `HEAD`
must agree. `TOOLSENABLED_SOURCE` and `TOOLSENABLED_SOURCE_REF` are supported
for controlled automation, but conflicting declarations are refused.

The owner-data scan also requires the ignored file
`private/owner-data-patterns.owner.json`. Start with
`config/owner-data-patterns.example.json` and add every builder-specific name,
account alias, home path, and private host identifier that must not ship.

Set release attribution before cutting:

```powershell
$env:TOOLSENABLED_CUT_MODEL = '<cutter identity>'
$env:TOOLSENABLED_CUT_EMAIL = '<valid cutter email>'
$env:TOOLSENABLED_CUT_SESSION = '<unique-session-id>'
$env:TOOLSENABLED_CUT_LANE = '<optional-lane-name>'
```

The cutter uses this identity for the version commit and DCO trailer. It does
not invent an identity from the machine or repository owner.

## Rehearsal and real cut

First run a rehearsal from the exact commits intended for release:

```powershell
node tools/release-packager/cut-release-candidate.mjs `
  --test `
  --source-ref <exact-app-commit> `
  --engine-source-ref <exact-engine-commit> `
  --version <version>
```

Then run the real cut with the same inputs:

```powershell
node tools/release-packager/cut-release-candidate.mjs `
  --source-ref <exact-app-commit> `
  --engine-source-ref <exact-engine-commit> `
  --version <version>
```

Useful options are:

| Option | Effect |
| --- | --- |
| `--test` | Uses temporary staging, disables branch advancement, and marks all declarations as test-only. |
| `--version X.Y.Z` | Uses an explicit version. Without it, the configured bump is applied. |
| `--staging <dir>` | Selects the durable candidate root explicitly. |
| `--build-dir <dir>` | Selects the isolated detached worktree location. |
| `--keep-worktree` | Retains the isolated worktree for inspection. |
| `--advance-branch` | Fast-forwards the current source branch after a successful cut. It is never implicit. |
| `--replace-staged` | Replaces an already occupied version slot, with a logged and recoverable swap. |
| `--known-fix "text::both::evidence"` | Adds a measured fix to the declaration. `source-only` and `observed` are also accepted evidence classes. |

Run `node tools/release-packager/cut-release-candidate.mjs --help` for the
complete current interface. Release automation may also pass `--seal-control`
to require ordered, bounded acknowledgements at each materialization boundary.

## What the cutter proves

The cutter performs these operations in order:

1. resolves the exact app commit and validates the requested version;
2. creates a detached Git worktree and proves it clean;
3. copies only the required ignored private build inputs;
4. stages the engine payload from its exact clean commit;
5. commits the version transition in the isolated app worktree;
6. provisions a complete `node_modules`, using `npm ci` when reuse is unsafe;
7. runs the full `npm run dist` verification and build pipeline;
8. independently validates `dist/build-info.json` and clean-tree provenance;
9. copies the installer to durable staging and re-hashes the copied bytes;
10. runs exact packaged QA against that candidate's unpacked application;
11. verifies the staged executable's product name and version information;
12. creates or confirms the immutable `build/<version>` tag;
13. writes `DECLARATION.md`, `declaration-facts.json`, and the download manifest;
14. removes the isolated worktree only after the candidate is preserved.

A failure before preservation leaves the isolated worktree available for
postmortem. An occupied staging slot is refused unless `--replace-staged` is
explicit. The normal cut never transfers an installer or pushes a branch.

## Verification before publication

Before pushing or publishing a candidate:

1. confirm both GitHub repositories are private using an authenticated remote
   query, and verify the exact remotes being pushed;
2. confirm both source worktrees are clean and their `HEAD` values match the
   declaration;
3. run the full engine and app suites from the same committed trees used by the
   cutter, including FRA and packaged-runtime acceptance;
4. compare the staged installer's byte count and SHA-256 with
   `declaration-facts.json`;
5. verify that the declaration records the exact app source ref, engine source
   ref, build ref, candidate filename, PE identity, and QA result;
6. install and exercise the candidate as a normal user. A whole-app elevated
   launch under that same Windows account is measured, warned about once, and
   then allowed to start. The owner struck the former refusal on 2026-09-02 --
   "the whole point of this software is the user decides and we give them the
   choice ... we can warn them, and a check box not to warn again" -- so a
   candidate that refuses to open under an elevated token is a regression, not a
   passing gate. Confirm instead that the "Running as administrator" warning is
   shown once with its "Do not warn me again" checkbox and that the app then
   starts either way. `shell/install-profile-guard.cjs` holds that contract in
   `checkWindowsRuntimeIntegrity`, `elevatedRunWarning` and
   `ELEVATED_APP_RUNTIME`; `tools/test/install-profile-guard.test.mjs` proves it
   in "main measures an elevated token early, warns once with a checkbox, and
   never refuses it". Individual privileged operations still go through the
   separately declared, narrowly scoped elevated helper rather than this
   process's token. Launching the per-user install under a different principal
   must still refuse before touching either account's tree;
7. push only after all gates are green, then re-read the remote refs to confirm
   the intended commits and immutable build tag landed.

The installer wrapper is not promised to be byte-reproducible: PE and NSIS
metadata can vary between builds. Reproducibility here means that the declared
app and engine commits identify the exact source inputs and that the preserved
candidate's own hash identifies the exact output bytes. To compare capability
payloads, retain the worktree and compare `release/win-unpacked/resources` and
`PAYLOAD.json` from the two cuts.

## Environment note

Some automation environments export `ELECTRON_RUN_AS_NODE=1`. Electron then
runs as plain Node and can exit successfully without opening the application.
ToolsEnabled launch and packaged-smoke paths remove this variable before
starting Electron. Any new Electron spawn path must preserve that invariant.
