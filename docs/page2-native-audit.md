# Repeat the native Page 2 audit

Run `npm run qa:page2-native -- --list` to see the executable scenario inventory.
Select a case with `--case queue-after-late-result`; prerequisites are included
in order. An omitted case is never counted as coverage. This runner complements
the unit and mounted UI tests and the normal installed-release qualification.
It does not replace those checks or label a source snapshot as installer proof.

Build and commit the app source, record its renderer identity, and pack the exact
clean engine source through the normal packer. Then run on the owning account's
interactive desktop:

```sh
npm run build
node tools/check-dist-current.mjs dist --record
node tools/pack-capability-layer.mjs --source /absolute/engine --source-ref EXACT_ENGINE_COMMIT
npm run qa:page2-native -- --real-provider --engine-source /absolute/engine
```

`--real-provider` uses the account's existing provider sign-in and spends provider
budget. Without it the setup checks can run, but provider-dependent cases are
reported as unavailable. `--level standard` is the default; `--level guided`
exercises that permission level and records unavailable positive command cases
honestly. The audit creates only isolated QA state and bounded QA workspace files.
Its provider prompts prohibit unrelated changes and agent launches.

Optional `--app`, `--out`, `--electron`, `--modules` and `--playwright` arguments
select the source/artifact, private evidence parent, Electron binary, installed
dependency directory and Playwright module. Every run receives a unique private
directory; it does not reuse or attach to an owner app. Linux native dialogs need
the owning X11 desktop, `xdotool`, `xprop` and Python 3. The
helper binds the chooser to the exact QA PID before sending native input. See
[the Windows notes](page2-native-windows-audit.md) for the interactive task and
native dialog requirements there.

When using an isolated Linux Xvfb display, pass `--linux-dialog-backend gtk`.
This uses Electron's documented `--xdg-portal-required-version` fallback to the
real native chooser in the QA process. The normal `desktop` default preserves
the system's portal choice. A shared desktop portal may otherwise open its
dialog on the owner's display, where this runner correctly refuses to input.
The selected backend is recorded in `report.json`. QA storage and its ancestors
must also be private enough for the product's Linux account-state guard; a
group-writable working directory is refused before setup can open.

On each cold launch, the runner inspects the actual QA-owned main window and
dismisses a blocking update prompt with **Not now**. Current Linux builds do
not offer the Windows installer updater. The runner leaves the remember
checkbox untouched. Before every renderer input it verifies that the real main
window is enabled, so a native modal cannot silently consume the intended input.
The Linux picker pastes the approved absolute path through the native clipboard
and copies it back to verify the exact entry before accepting it.

On Linux, the runner also creates a private, short `/tmp/te-page2-*` directory for
Chromium's Unix sockets, whose address length is limited. Its path is recorded
and it is removed after the owned application closes; evidence remains in the
selected output directory.

The runner refuses dirty source, stale renderer inputs, changed capability
payloads and manifest paths that escape an input artifact. It snapshots the
committed application and built payload before launching. `PAGE2-NATIVE-INPUTS.json`
inside the resulting `runtime` directory binds the app commit, engine commit,
renderer source identity, file hashes and modes. That directory can be archived
and supplied as `--app` on the other platform, with that platform's own
dependencies; it does not include provider credentials or dependency binaries.

`report.json` distinguishes passed, failed, unavailable and not-run cases.
`actions.jsonl` records inputs, steps and native helper receipts. Screenshots,
rendered QA text, runtime identity and stderr remain beside the report. The
outside-write fence is active throughout the run, including cold reopening.
Exit 0 means all selected cases and cleanup checks passed; exit 1 means a failure;
exit 2 means no complete verdict. A failed prerequisite prevents its dependent
case from running. A harness failure lists the selected cases it could not reach.

The bounded-command interruption case deliberately waits through a late provider
tool result before sending a retained queued message. It verifies connection and
queue recovery. A turn interrupt alone does not prove every background command
was terminated; full session cleanup is measured separately. Synthetic protocol
and UI fixtures remain useful regression checks but are never native provider
evidence.

Five additional cases exercise bounded Launch, Team, Loop, time-cap cleanup,
and selected-parent Stop through visible controls. Their saved node IDs, actual
sessions, work-status receipts and signed start/end records must agree. The
loop case navigates to Metrics for its second iteration, returns to recover
and stop the loop, then waits a full interval to prove a third iteration did
not start. A listed scenario is not a native pass until its report says so.

The child-history cases reopen the saved child after the real app restart,
then submit a second message while the first message's automatic replacement
is still connecting. Both inputs must land while the saved session identity
still names the old child. The real queue, both completed provider replies,
unchanged parent and one verified replacement start must all agree. If the
natural connecting interval closes too early to observe it, the case reports
unavailable; it does not substitute a delayed host response. Separate slash
and Actions cases interrupt a working child and verify its next reply uses
the same session.

Run the harness and native-helper boundary tests with:

```sh
node --test tools/test/page2-native-*.test.mjs
```

The platform-specific guard tests skip on the other operating system. Their
passing assertions concern actual process/filesystem boundaries and send no
desktop input. Native scenario results come only from executing the audit.
