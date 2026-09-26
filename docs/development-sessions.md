# Independent DEV and CUT sessions

Use `node tools/dev-environment.mjs` to create independent native workspaces.
A session copies exact committed app and engine sources into new ordinary Git
repositories. Source checkouts may be dirty, move to newer commits, or continue
running. The command does not reset them, change a LIVE selection, advance a
source branch, or stop an existing app.

Normal `npm run app` launches a new DEV session; `npm run dev` also watches its
renderer. Both use the source repository's explicit engine binding and native
Node/npm installation. Each launch prints the directory to edit. Reopen that
same workspace with `npm run app -- --session ABSOLUTE_SESSION_PATH`; add
`--refresh` to prepare it again after its window has closed. `--engine` and
`--directory` select explicit source/storage paths for a new session.

Create a separate session directory for each DEV window and each CUT:

```sh
node tools/dev-environment.mjs create --kind dev \
  --directory /absolute/dev-one --app /absolute/source-app \
  --engine /absolute/source-engine \
  --privacy-profile /absolute/private/owner-data-patterns.owner.json

node tools/dev-environment.mjs prepare --session /absolute/dev-one \
  --npm-cli /absolute/native-node/lib/node_modules/npm/bin/npm-cli.js

node tools/dev-environment.mjs open --session /absolute/dev-one --watch
```

The commands and options also work in Windows PowerShell; use drive-absolute
paths inside the owning Windows account. Its npm entry point is typically
`node_modules\npm\bin\npm-cli.js` beside the selected native Node executable.
Invoke these tools with that native Node. No shell command string is used to
pass paths to Node or Electron.

Repeat `create` with a new directory to open another DEV window. Edit that
session's `app` directory for renderer development. `--watch` writes only its
own renderer output; press Ctrl+R in that window after a rebuild to reload it.
Its window must close before `prepare` may rebuild that
session. Commit engine changes and create a new session to select them: the
payload packer retains its clean, exact engine-source contract.

Each session owns:

- App and engine working copies plus frozen `control-app` and `control-engine`
  repositories for the controller, watcher and native process custody;
  Git objects and worktree metadata are not borrowed from DEV or LIVE.
  Frozen tracked files are checked against committed blob bytes and file types,
  independently of Git's filtered status/index cache. Tracked links refuse.
- Native dependencies installed from the committed locks, with full dependency
  types and lifecycle scripts. External dependency links and hardlinks refuse.
- Build and runtime profiles, app state, temporary files, npm/Electron/browser
  caches, build outputs, candidate staging, and private evidence.
- One operation admission record and retained native process scopes. Linux
  uses the engine's subreaper/pidfd supervisor; Windows uses its Job wrapper.
  Closing or cancelling a session targets only those owned descendants.

Schema 3 freezes both controller repositories. Editing or moving the original
source checkout cannot change an existing session's controller. The controller
can also be invoked directly at `SESSION/control-app/tools/dev-environment.mjs`
with `--session SESSION`. Older snapshots are retained, but require a new snapshot
to use this workflow; their previous evidence is not upgraded.

An operation with unknown cleanup retains `operation.json`. Do not erase it
based on elapsed time or a missing PID. The exact native scope must be inspected
and its cleanup established first. Other session directories remain independent.
`status --session PATH` reports admission records as records; their presence is
not itself a live-process observation or a release verdict.

Only the explicitly selected privacy profile is copied from private builder
inputs. A new engine-source binding points inside the session. Other private
files, provider credentials, mutable profiles and uncommitted source bytes are
not copied. Keep all session directories private and outside distributables.

## Frozen release preparation

Select the latest integrated committed pair whose intended changes have been
reviewed, then qualify that snapshot. Do not wait for an unrelated LIVE build or
an editable checkout to become clean. New development commits belong to a later
snapshot; a previous snapshot's test results do not qualify them.

```sh
node tools/dev-environment.mjs create --kind cut \
  --directory /absolute/cut-1.0.42-attempt-one \
  --app /absolute/source-app --app-ref EXACT_APP_COMMIT \
  --engine /absolute/source-engine --engine-ref EXACT_ENGINE_COMMIT \
  --privacy-profile /absolute/private/owner-data-patterns.owner.json
```

`prepare` may provision a CUT session too. It checks generated bridge-contract
agreement instead of rewriting frozen source. Source disagreement requires a
reviewed source correction and a new snapshot.

The CUT entry point retains explicit source refs, private build/staging/evidence
paths and no branch advancement. Its full qualification form is:

```text
node tools/dev-environment.mjs cut --session ABSOLUTE_CUT_DIRECTORY
  --version 1.0.42 --npm-cli ABSOLUTE_NATIVE_NPM_CLI_JS
  --readiness-context ABSOLUTE_PRIVATE_CONTEXT_JSON
```

**Full CUT currently refuses in this shared-host session workflow.** The
disposable-worker dispatch adapter is not implemented. File/profile separation
alone cannot authorize installer changes or a qualification helper that refreshes
the OS owner's provider account. The shared-session marker is propagated through
build and runtime operations; owner-authenticated smoke and costly QA refuse
before reading that account or launching a driver. A caller-supplied flag or
evidence file does not override this boundary.

The underlying cutter still requires explicit cutter attribution, the exact
qualification context or receipt, every release gate, and installed acceptance.
If committed source already carries the unshipped release version, the existing
explicit `--allow-same-version` option can be passed; it does not replace an
occupied candidate slot or move a build tag. Publication is a subsequent action
against the qualified artifact's exact hashes.

The Linux full release producer and qualification contract still need
implementation. Snapshots, private preparation, and DEV execution are supported
on Linux and Windows; those operations do not constitute release qualification.

## Remaining native environment requirements

Isolation of files and process ownership is not separate physical hardware.
Host memory, CPU, desktop access and Docker capacity remain finite. Existing
resource admission remains enabled. Before a new prepare/open/CUT operation,
the launcher observes free memory and keeps the normal 2 GiB host reserve plus
an estimated allowance for the new operation (2 GiB/512 MiB/4 GiB respectively).
It records the observation and refuses insufficient capacity without stopping
existing work. This observation is not a hardware reservation. Allocate a dedicated CUT worker or
disposable guest where concurrent development leaves insufficient headroom.
Installer lifecycle tests belong in disposable native environments, since
installation and provider/system integration can change account-wide state.

On Ubuntu with restricted unprivileged user namespaces, `start` loads an exact
AppArmor attachment for the new private Electron executable with `sudo -n`.
`sandbox --session PATH` performs the same configuration explicitly, including
for a CUT worker. It records the policy inside the session and loads that one
attachment without editing global restrictions, restarting AppArmor, changing
another profile, or bypassing Chromium's sandbox. If native policy setup is
unavailable, the session and policy remain available for its administrator.

The app already chooses a free loopback port within its declared shell and
bridge ranges. `open --inspect` enables a loopback debugging endpoint with an
OS-assigned port recorded by Electron in this session's userData directory.
It does not reuse LIVE's debugging port or UI-drive lock.

Linux keeps Chromium's transient socket files in a short private directory
under `/tmp`, bound to the session and its current operation. This avoids the
Unix socket path limit in deeply nested workspaces. The launcher removes it
only after its native process scope confirms cleanup; uncertain cleanup retains
both the admission and temporary files. Durable state remains in the session.

DEV requires the paired app and engine provider-isolation protocol. Older
snapshots must be recreated from updated sources before opening a window.
Create named accounts through Accounts and sign in separately inside each
session. The app uses only private provider installations and homes, pins
provider credential storage to files there, and refuses a missing private
installation or account instead of discovering the owner's default sign-in.
No existing credentials are copied into a session. Provider installation uses
the session's npm prefix and cache; operations that modify machine-wide
runtimes or services require a dedicated worker.

Linux private sign-in terminals require `/usr/bin/xterm`. Each terminal remains
inside its DEV process scope and closes with that scope. Windows uses a fresh
command window inside the retained Job, with command processor AutoRun disabled.
Docker resources carry the owning state/context identity, while physical
resource admission remains shared. Exercise the full provider, installer and
revocation lifecycle on a dedicated CUT worker; DEV coexistence is not release
qualification.
