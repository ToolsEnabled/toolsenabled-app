# Native Windows Page 2 audit support

`tools/lib/page2-native-picker.ps1` supplies real Windows picker input to
`tools/page2-native-audit.cjs`. It is an audit driver, not an app capability or a
provider substitute. Run the shared audit on the owning interactive desktop.
An SSH process in session 0 cannot drive that desktop: start the whole audit
runner through an explicitly owned interactive task when remote execution is
necessary. Do not attach the audit to an existing owner application.

The helper requires these arguments:

| Argument | Meaning |
|---|---|
| `QaRoot` | Existing owned scratch directory under the current account profile. |
| `ExpectedProfileRoot` | Assertion of the current account profile; another account is rejected before filesystem access. |
| `QaProcessId` | Exact main process PID returned by the audit's own Electron launch. |
| `RequestPath` | Bounded JSON request file beneath `QaRoot`. |
| `ResultPath` | JSON result file beneath `QaRoot`. Its parent must already exist. |
| `ValidateOnly` | Check account, filesystem and process boundaries without loading UI Automation or sending input. |

The recorded process must belong to the current account, share the helper's
desktop session, and carry exactly one explicit `--user-data-dir` argument
pointing beneath `QaRoot`. The helper never searches another profile, enumerates
unrelated process owners, launches an app, terminates a PID tree, or adjusts
provider permissions. It checks path components for reparse points and hard
links before selecting a file. Lexical containment is checked before any access
to a requested path, including the result path.

The request format is:

```json
{"operation":"select-path","selectedPath":"<absolute owned QA file or folder>"}
```

Supported operations are `inspect`, `select-path`, `cancel`, `dismiss-update`,
`close-app` and `confirm-close`. `title` can optionally narrow a picker to its
exact dialog caption. Selection uses Windows' file/folder edit control and
confirmation button. Cancellation presses the native Cancel button. Every
candidate dialog comes from the exact QA PID; the helper examines all its modal
windows and refuses an ambiguous selection. It does not click through unrelated
prompts or use a DOM file-input shortcut.

`dismiss-update` chooses the QA app's “Not now” button without changing its
persistent update preference. `close-app` closes the exact QA main window and,
if present, confirms that app's “Close and end them” warning. It does not disable
future warnings. `confirm-close` is available for a close already requested by
the runner. Successful native input is an input receipt, not evidence that the
application accepted an attachment or that a provider saw it. The shared runner
must separately check the resulting UI and provider answer.

Results are written both to `ResultPath` and stdout as one JSON object. A refusal
returns exit 1, `ok:false`, a stable `code`, and `nativeInputSent`. The latter can
be true if a later step fails after an input was sent; callers must retain that
fact. Exit 0 reports the action, PID, owned user-data directory and desktop
session. No credentials or provider environment are written to the receipt.

Before renderer input, `inspect` supplies each same-PID window's `class`,
`enabled` state and native `buttons` (`name`, `enabled`, `automationId`). If
exactly one enabled native button is named `Not now`, call `dismiss-update`,
then inspect again. Require the QA `Chrome_WidgetWin_1` window to be enabled and
refuse unhandled `#32770` dialogs; CDP can otherwise click behind a native modal.

The Node runner also uses `tools/lib/page2-native-paths.cjs` before resolving,
creating, reading or passing Windows input paths to child tools. `guardWindowsPath`
rejects foreign profiles and ambiguous namespaces lexically, then checks each
existing component before advancing to its child. Output parents use
`requireProfile:true` and may use `allowMissing:true`. Supply actual directories
for app and module inputs: junction inputs are refused. `guardWindowsTree`
checks nested dependency links before Node module resolution can follow them.
These guards assume the owning machine is not concurrently replacing checked
path components; they do not claim protection from a hostile filesystem race.

The existing same-PID helper was measured manually against native Windows
Electron during the 2026-09-08 audit. The maintained helper's boundary tests use
real Windows process and filesystem APIs with an owned Node child. Run them with:

```sh
node --test tools/test/page2-native-picker.test.mjs
node --test tools/test/page2-native-paths.test.mjs
```

They make no provider calls and send no native input. On other operating systems
the cases explicitly skip; those skips are not Windows evidence. Real dialog
coverage comes from the shared native audit and the Windows supplements.

`tools/lib/page2-native-windows-scenarios.cjs` exports:

- `metadata`: replay steps and expected outcomes for the manually driven Windows
  workflow. It is a coverage specification, so its presence never counts as a
  passing test. Entries marked `shared-provider` need a real provider receipt;
  `shared-gate` entries record the actual refusal/unavailable state.
- `executableIds`: the six Windows supplement IDs.
- `run({page,picker,check,step,paths,provider})`: actual native dialog and clipboard
  checks. It makes no new provider request, and restores the unsent draft when
  finished. The shared runner supplies a live, idle, already-verified agent with
  an empty attachment strip before calling it.

The context contract is:

```js
{
  page,                              // the owned QA Playwright page
  picker: async request => receipt,   // executes the helper in the same desktop
  check: (condition, message) => {},  // throws when condition is false
  step: async (id, action) => {},     // awaits action and records its outcome
  paths: { qaRoot, workspace, mentionFile, imageA, imageB },
  provider: { agentName, originalBrief, latestReply }
}
```

`originalBrief` and `latestReply` are the actual text already verified by the
shared runner, preferably its short unique response tokens. The module derives
the conversation locator from `agentName`; it has no fixed node IDs, endpoint,
account profile or provider credentials. Its checks cover native image-picker
cancellation, Actions file mention, toolbar mention cancellation, image removal,
and both clipboard commands. The shared runner lists its executable coverage
through `--list`. Other entries in `metadata` remain a replay specification until
an executable scenario implements them and a native run produces a result.
Missing or unexecuted entries must not be counted as passes.
