# Role-bound input verification, 2026-09-05

This supplements the earlier hosted-coordinator trial; it does not relabel that
older trial as a native-tool confinement proof.

## Actual hosted coordinator

The isolated application ran app commit
`de898e354729b2edf2e3c9f5e07367f3b86f5f32` with engine payload
`e42a699bc5572904dd310be7b9e235717c113a54`. The normal saved-node resume
flow started Luna with high effort, session
`4ebf5277-2721-4e7e-927a-ab04824d88ac`, using the authoritative coordinator
role and its generic function list. These were typed direct-person requests,
not a real microphone conversation. The test app was isolated from LIVE.

The generated provider configuration was inspected without displaying its
session credentials: native sandbox read-only, approval policy never, native
shell/apps/browser/computer/delegation disabled, code-mode host enabled, and
`default_tools_approval_mode = "approve"` only for the two generated registry
servers. Registry dispatch still enforces the role, permission tier, person-turn
provenance and local Accessibility consent. The code-mode host must remain on:
it executes the permitted MCP functions too.

Observed provider events and independent UI/fixture results:

- `app.navigate` succeeded to `/metrics`; `app.context` returned `/metrics` and
  the renderer independently showed that route.
- `accessibility.inspect` found the native Mechanical control test window.
  The model proposed Test press; the owner interface confirmed the exact
  preview. The native fixture logged exactly one `clicked` event.
- A fresh inspection and proposal replaced Notes with exactly
  `Hosted role control verified.`. Owner confirmation succeeded, and the native
  fixture logged that exact text change.
- After owner disable, an actual `accessibility.inspect` call failed with
  `ACCESSIBILITY_OFF`. No further action was proposed or executed.

The fixture log was retained at the explicitly owned temporary directory
`C:/Users/ToolsEnabled-Dev/AppData/Local/Temp/hosted-role-fixture-USkMia/fixture.log`.
The fixture process was subsequently observed absent. Accessibility was disabled
and the hosted session was closed through its normal owner interface.

## Discovery defect and repair

An initial tool-discovery search for dotted `app.context` returned no matches,
although the tools were available. Provider normalization exposed the name as
`mcp__toolsenabled__app_context`; the description did not contain the canonical
role-sheet id. This was not an unavailable MCP server. A subsequent provider
discovery and the actual calls above established that distinction.

The engine now includes `Function ID: <canonical id>.` in each advertised
description, generically for all registry functions. Names, schemas, annotations,
role intersection and dispatch authority are unchanged. A regression test first
failed on the missing dotted id and then passed with the repair. The combined
role/accessibility tests passed 9/9 with no skips; confinement passed 343 checks;
the MCP initialization tests passed. The capability index remained current for
228 registered tools. Engine commit `031879c21a96f06d0cc055385a1711c60f979b15`
includes this repair and the newer LIVE engine ancestry.

One separately attempted older `tests/mcp-contract.js` check failed because it
requires the word `arguments` in the schema-error message, while the server
actually returns code -32602 and `Invalid input: unexpected: additional property
is not allowed`. It is not reported as a pass. No error check or release gate
was weakened to hide it.

## Scope still requiring completion

Subsequent native Windows coverage adds window minimize, maximize, restore and
normal close through `accessibility.propose` (`kind: "window"`, `windowId` and
an inspected `windowActions` value). All use the existing local owner
confirmation. Close returns `close-requested`, not a fabricated exit receipt;
a native fixture that canceled closing remained running. No process termination
or automatic unsaved-work dialog handling is added.

`accessibility.inspect` also accepts `includeText: true` for one selected desktop
window. Ordinary inspection still omits values; requested text is bounded to
2000 characters per field and 12000 total, with explicit truncation. Password
fields remain excluded, read-only fields have no typing/key actions, and returned
text is not kept in executable target identities. The owner opt-in disclosure
names this read capability. It is UI Automation text, not OCR or screenshots;
text in an ordinary document is not claimed to be automatically secret-redacted.

The final real desktop/consent/app-control batch passed 10/10 with no failures,
skips or cancellations in 48088.3138 ms. This independently measured actual native
window states, normal close and canceled close, exact text output, read-only
controls, 12000-character total truncation, password exclusion and non-persistence
of the text option, including a read-only rich-text document. An intermediate
window-state check failed because the native provider acknowledged before the
transition completed. The adapter now observes the requested state for at most
one second after issuing the command once; it never repeats the command. The
final batch above includes that repair. The engine schema/role tests passed 11/11, with no failures,
skips or cancellations, in 691.0959 ms. These new operations have not yet had a
separate real hosted-model trial. The earlier hosted proof above remains scoped
to its exact recorded source pair.

The current opt-in desktop control is experimental, not complete whole-computer
access. It supports UI Automation controls for click, text, selection, toggle,
expand, scroll, focus, window management and a small key set. It excludes ToolsEnabled's own native
window, terminals, file managers, credential dialogs and raw path entry. App
screens have a separate generic control surface. Broader owner-authorized
workflows remain necessary to meet the requested full Accessibility mode.

Motion and voice controls default off independently. The physical USB Blink
camera remains deferred at the owner's request; synthetic/fixture hand tracking
does not prove that camera works. Provider-native negative checks and focused
feature tests do not establish an unrestricted whole-computer safety guarantee.

This document is feature evidence, not a LIVE publication receipt. Exact-pair
acceptance and the supported promoter must succeed before claiming that this
candidate is queued for the next LIVE launch. The current LIVE session must not
be restarted as part of that publication.

## Concurrent release integration

The candidate incorporates app `aec0dae47096b15e97d1eff3ce4e8509d5684dae`
and engine `5cbaa1caa0529d9e0d7cf4fb51b1fff23181b82a`, preserving the
resource controls alongside hand settings and generic role functions. Both
function additions are retained in the reviewed fixed inventory: 230 tools.
The resource-dispatch test now supplies the same bound role policy production
requires, and independently refuses missing policy and unassigned functions.

The real role-editor test found that the newer installed role-file reader
mistook a no-base custom role for a shipped role because both have a null base.
Engine `4076dd9858acafd86393b2265181a51acbda0484` uses the role store's
shipped identity set instead. Canonical and legacy no-base regression tests
first failed 0/2, then the complete related batch passed 28/28 in 5411.9141 ms.
No role history is moved or rewritten by this repair. After repacking, the
real app role-editor/organisation batch passed 22/22 in 21196.0873 ms, including
fresh reads, saved function choices and native route remounts. All counts above
had zero skips or cancellations. Native desktop tests also passed after the
integration; they do not establish whole-computer coverage.

The preceding exact-pair judge run passed 33/33 at ledger entry 145, hash
`36d5ca9b8c2915473094a745772f6a907aadeb0928f754af8149a3353cc5e217`.
It covers app `0176c0c7d2fee493d59097ac96560c756ea004ed` and engine
`b8547e3ae29810fad70eecef56601b5be97fc99f`, not this later integration.
Fresh exact-pair acceptance and publication remain required.

## Full-suite integration repairs

The unchanged integrated pair (app `970972546866f23bd69d76541c945d39f9805ac6`,
engine `4076dd9858acafd86393b2265181a51acbda0484`) completed the normal full
app data command in an independent retained native Job: 6982 tests, 6956 passes,
11 failures, 15 skips, no cancellations, 1141329.9629 ms. Root exit was 1 and
the authenticated Job measured zero remaining processes. This was qualification,
not publication, and is not a passing gate receipt.

Repairs defer optional tracker URL resolution until enable, make accessibility
IPC registrations explicit without changing sender validation, add missing role
and app-data-path refusal copy, preserve accessibility history during adoption,
and bound both control panels at every Text size. The hand settings fallback now
gives an action. No plain-language or zoom baseline was expanded.

The debug scan had identified two comments in the byte-identical MediaPipe 1.0.1
WASM loader. Only those exact comments in the SHA-256-pinned file are classified
as upstream maintenance notes. Every changed vendor byte now fails independently;
the scanner still rejects added debug globals and the same comments anywhere else.
The upstream asset itself and the asset provisioner's pins were not edited.

The focused startup/IPC/scan/zoom/adoption batch passed 64 tests, with one declared
POSIX-only skip on Windows, no failures or cancellations, in 8754.7446 ms. The
native hand and app accessibility/consent batch passed 9/9, no skips or failures,
in 6728.6055 ms, including small-window bounds at all three text zoom levels.
Tree and local-communications fixtures now bind explicit role policies while
retaining downstream tier/identity checks and new missing-policy negatives:
17/17 passed in 10802.9724 ms. The production role-policy guard was not changed.

These repairs still require fresh exact-pair acceptance and the ordinary full
promoter. They do not establish physical Blink camera or whole-computer coverage.

The subsequently selected LIVE app `f2eca39ab4a2894a515694935a7b52225375c7c9`
was merged as `a9ff9a6cdc7877377ad05c163d0ebedaf69df6c2` without conflicts,
preserving its release-qualification tooling and explicit TAP reporter alongside
hand-asset verification. The 13 changed tooling suites ran 224 tests: 221 passed
and 3 declaration-privacy cases failed, with no skips, in 104245.2137 ms.
The document scanner now checks both original text and a separately labelled
decoded-backslash view through the same existing payload scanner. It neither
changes public documents nor reads paths named in their text. The new fixture's
bare-root exception was removed to preserve the existing scanner policy.
The complete affected privacy batch then passed 29/29, no skips or cancellations,
in 13718.7715 ms. No privacy pattern or public-release readiness gate was relaxed.

The full promoter for app `bc7ebf4e8f63913ea97bcd5ebd635371005ebc8e` and
engine `3378038e8533bb78e3e53bd63db8e7a730499c42` completed all five structural
checks, then the full app command: 7056 tests, 7040 pass, one failure, 15 skips,
zero cancellations, 1069109.5717 ms. Original command exit 1 and authenticated
native Job EMPTY were recorded at 2026-09-05T23:50:34.698Z; the publication lease
was released normally. Nothing was promoted, and the engine lifecycle did not
run in that attempt.

The sole failure was an incoming contract that called the compose-layout driver
exact-candidate proof. Inspection confirmed it reads candidate CSS but renders
hand-authored HTML in a synthetic page. Its explicit classification is now
instrumented-copy; the scope-count regression requires it to contribute zero
exact-artifact passes. Release argument forwarding and candidate-only CSS tests
remain required. No default proof scope or geometry assertion was weakened.
The complete affected four-suite batch passed 54/54, zero skips or cancellations,
in 3404.5987 ms, with original command exit 0 and authenticated Job EMPTY.

While another publisher held the lease, its committed candidate app
`3e81c4efdfb95242812d26af9271311823fcfb1a` and engine
`62602e2d4d8365b613b332ab0784703b971f4449` were integrated in the accessibility
worktrees, without changing that publisher's inputs. The only textual conflicts
were equivalent compose-proof comments/test names; both branches independently
classified it as instrumented-copy. Engine merge
`933edabd6d61118c8215aafb73cb8748ae21b411` retains role-scoped functions and adds
the incoming cancellation, API-contract and platform changes. The index remains
current for 230 tools. Nine focused engine files completed successfully with
native command exit 0 and authenticated Job EMPTY, including authority,
retirement, role assignment, cancellation and authenticated contract access.

The combined renderer built 816 modules in 13.09 seconds. All five hand assets
were verified unchanged. The new payload contains 374 staged files; the
currentness check compared 375 including its record. Renderer classification,
payload source-currentness, unbound identifiers and composed-output checks passed.
The 29-suite integration batch completed 280 tests: 279 pass, zero fail/cancel,
one opt-in CUDA speech test skipped, 66761.4777 ms. Native desktop, role editor,
hand UI, permission, phone-layout and asynchronous ledger checks passed. The
original command exited 0 and its native Job was EMPTY. This does not replace
the separate GPU, physical-camera, hosted-provider or full publication proofs.

That preceding combined pair (app `0c8b9f978b40425b71f5dea0d1ca1bc4713c54cd`,
engine `933edabd6d61118c8215aafb73cb8748ae21b411`) then passed the opt-in real
CUDA speech and simultaneous hand fixture test, 1/1 with no skips in
86286.7594 ms, native root 0 and Job EMPTY. On the RTX 5060 Ti it detected
400/400 frames; 390 warm samples had median 11.7 ms and p95 19.3 ms. Actual
generated TTS/WebRTC/STT exercised local consent, wrong/bare codes, exactly-one
native click, exact text entry, stop, formatting and no code forwarding. No
physical camera/microphone/speaker or actual LLM was used.

The LIVE source selector had subsequently received shared app
`c27e9e5e6c1660b9a8286b99045051963ed1ef13` and engine
`f767b60f2bd698c700e953f584eab11ed7ff992f`. Integration preserves their mobile
ring stage and our persistent voice contact; the only conflict was the home
mount. A constructed-DOM regression requires voice to remain outside the ring's
clipped decoration. The 16-suite home/voice/hand batch passed 167/167, zero skips
or cancellations, 11411.5966 ms. Six focused engine files passed with native
root 0/Job EMPTY, including real bounded loopback HTTP and role authorization.
The new engine merge is `cb4140b60389301d33480cfb26c510e35ccd2479`; payload375
files, renderer816modules/13.32s. This later merge still needs fresh acceptance
and full promotion; the preceding GPU measurement is not relabeled for it.

The full app gate for854ed861a4f7b77b5e8e62b8a578ebb7f5ad502a and
cb4140b60389301d33480cfb26c510e35ccd2479 completed7085tests:7070pass,
0fail/cancel,15skip,1160696.0888ms, with original command0/nativeJobEMPTY.
That attempted promotion subsequently failed engine pretest and published
nothing. Later engine repairs explicitly wire the local-owner regression,
reconcile the five generic core tool identities and their effects, and correct
the cancellation peer's advertised protocol fixture. They do not relax the
production role boundary, orphan ceiling or historical identity snapshot.

The separate engine strict preflight on
bd398118ad1f2db0f78c388ead75c98014b577a9 passed all15preteststeps, then
finished its48-step main chain with37pass/11fail. Actual npm exited1 at
2026-09-06T01:49:24.986Z; it did not reach a successful complete lifecycle.
Its native Job still contained a descendant after the chain finished. An
explicit authenticated request stopped only that owned Job, measured EMPTY,
and closed its wrapper/pipes at01:50:47.528Z. The controller termination
status124 does not establish the original gate root's exit code or a pass.
That engine preserves the current
shared native root-completion correction and the reviewed typed research
reference repair; ordinary free-text credential rejection remains unchanged.

During that unchanged engine-only preflight, the existing app document-binding
fix6eb8e8fba00c7498cf2a32f8c551da67b679a103 was integrated as
b8136c0a3c2d6d04a4ed315d0d1edff5f1adfa7f. App actions now check the trusted
origin and a private isolated-world document nonce at execution. Main-document
navigation revokes controls and pending consent even when voice is inactive;
hash navigation preserves the session. A same-URL replacement cannot inherit
a queued action. Eight focused suites passed33/33, no skips/cancellations,
8367.6058ms, original command0/nativeJobEMPTY. This includes actual Electron
same-URL and untrusted-document replacements alongside consent, voice, hand and
home controls. It is not a physical camera test. This newer app source still
requires fresh exact-pair acceptance and ordinary full LIVE publication.

## Release repair checkpoint, 2026-09-06 UTC

Engine39d463c85e41aec83d9e9c115814aa636d3c3153 includes the compatibility
repair and native lane-process containment. The package manifest now claims
the four previously unmapped JavaScript modules, while the Python custody
helper stays in the payload and its charter, outside the JavaScript-only
manifest. Linux helper launches declare hidden-window behavior. Role tests
require the intended on-demand coordinator and exact custom-role fields;
vault test seams use the current Windows-only guard without removing it.

The bounded lane runner creates each workload suspended, assigns its retained
non-breakaway Windows Job before execution, and measures root completion and
Job emptiness separately. Cleanup uses retained handles, never taskkill or a
later PID-tree lookup. Native tests observe a detached child inside its Job,
then zero members after cleanup, and a separate living Job surviving that
stop. The earlier PID-only fixture failure does not prove PID reuse; the new
proof names the actual owned process group instead of guessing from a PID.

The newly verified app baseline e8440d49b241131d0220ab4203ee6215273fa6c3 was
reviewed and merged. Consent-ledger verification now uses the audit worker,
preserving ordering and refusal behavior without blocking the main UI thread.
The combined consent, audit-worker and document-navigation batch passed35/35,
no failed/skipped/cancelled tests,2920.5703ms, original command0/JobEMPTY.
These are focused proofs, not a full LIVE publication or physical-camera test.

## Windows helper response completion, 2026-09-06 UTC

A separate follow-up from app d7bf57f reproduced two response defects using
scripted pipe events against the actual desktop adapter: split UTF-8 bytes
changed labels, and root exit could reject output before its pipes drained.
The adapter now buffers at most 512 KiB of bytes, decodes complete UTF-8
strictly, and parses on process/stdio closure. Cancellation, overflow and the
unchanged 12-second deadline remain failures even if later output looks valid.
Already-exited roots receive no later stop request. No Windows focus guard,
desktop scope, role permission, local confirmation or control action changed.

Seven new regression tests failed on the original implementation, then passed
after the repair. An initial five-file follow-up run had 22 passes, one real
Windows foreground-focus refusal before text insertion, and one explicit GPU
opt-in skip. That failed batch remains nonpassing. After the concurrent full
app suite closed, the four relevant stream/native-control/document/host suites
passed 23/23, zero failed/skipped/cancelled, in 45092.0228 ms. Original command
exit was zero, native Job EMPTY, and wrapper/pipes closed at
2026-09-06T02:46:26.878Z. Evidence under the literal Dev Temp root:
`toolsenabled-accessibility-dev-SHKk2b/qualification/1788662740866-stream-repair-native-after-app-gate-closed-1d66afd8-3324-4b93-9e7f-65ddad43e8f2`.
This does not establish why Windows denied focus in the earlier run, prove
physical camera/audio operation, or qualify the follow-up for LIVE publication.

The unchanged d7bf57f/39d463c candidate separately passed the full app gate:
7081 passes, zero failures/cancellations, 15 explicit skips, 1167238.8007 ms,
original command zero/Job EMPTY/wrapper and pipes closed at02:44:55.640Z.
Its subsequent engine lifecycle was externally terminated before pretest
completed; the promoter recorded no timeout, cancellation or stop request.
The TERMINATED/zero-member receipt establishes cleanup, not an engine pass or
the identity of whoever requested termination. That candidate was not fully
promoted by this lane, and its app result does not qualify this changed source.
