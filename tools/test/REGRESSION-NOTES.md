# Living regression notes

This is the running record of failures that escaped testing. Update it when an
issue is reported, reproduced, fixed, cut, or verified. A passing component test
is not evidence that the installed application or LIVE works end to end.

Before changing a test or making a cut:

1. Read the open issues below and identify which real boundary the change uses.
2. Reproduce against the exact loaded or installed app/engine pair and provider
   CLI version. Record the failing operation and observed result.
3. Check source selection, payload contents, generated inputs, runtime identity,
   and the test harness before attributing a failure to application code.
4. Improve the smallest existing core contract that can catch the failure.
   Exercise real entrypoints and native boundaries; avoid tests that restate the
   implementation or substitute the process whose compatibility is in question.
5. Retest the actual cut, including fresh install and upgrade on Windows and
   Linux. Evidence from a source tree, another commit, or another platform does
   not qualify the artifact. Missing or skipped required proof blocks publication.

## Writing a source-shape pin

A pin that reads source text and asserts its shape is the only way to protect some
invariants — a rule with no import to follow, an object held by reference, a statement
whose ORDER is the contract. They are worth having. They are also the largest single
source of reds that nobody owns, because they fail on correct work.

Three did in one week: `chat-composer` (the typing fix moved a rule out of a
700-character window), the drained-stamp test in `b3-turnstamp-real-send-paths` (a hoist
gave two surfaces one shared const), and test 5 of that same file (the attachment work
added a `pictures` spread to an object literal). In all three the behaviour was
unchanged, the change was correct, and the red had to be argued about before it could be
dismissed.

**Ask one question before you write the assertion:**

> **Can this text change while the behaviour this test protects stays true?**

If yes, the pin is brittle by construction and will go red on correct work, forever. That
is always the case for a composite — an object literal, an argument list, a whole
statement — because those grow fields legitimately.

If no, the exact literal **earns its cost and should stay**: a channel name, a storage
key, a refusal code, a field another module reads by that name. This is not a rule
against literals.

**Three ways to pin the invariant instead.** All three are in
`b3-turnstamp-real-send-paths.test.mjs`, which is the worked example:

1. **Capture the identifier out of the source, then assert relationships against the
   captured name.** Survives renames and hoists; what it cannot survive is the
   relationship being broken, which is the thing you meant.
2. **Slice to a NAMED stable neighbour, never a character count.** A fixed `3000` in that
   file went stale when a guard clause grew above the target, and the miss read as "the
   target never existed" rather than as a failure.
3. **Extract the statements and EXECUTE them** with `new Function`, asserting on
   behaviour. Immune to spelling entirely. Use it wherever the statements can be run.

**And check the pin can still fail.** Re-point, then break the real rule in the product
file and confirm the suite goes red with the right message, then restore. A pin that
cannot fail is worse than the red it replaced.

## Open failures

### R-001 — Page 2 buttons reportedly unusable in Windows beta 1.0.44

- Report: the owner says a beta user cannot press any page 2 button.
- Exact public Windows installer SHA-256:
  `7c7c21d6ed1325d32b6546de0d9aa4b36ddb4334704e94ee17c26ca749023474`.
- Keyboard checks exercised several controls; they do not prove pointer hit
  testing. The reported native pointer failure remains unreproduced and open.
- Missing seam: actual installed renderer input, overlay/hit testing, and action
  completion on Windows. Repeat after every final cut before publication.

### R-002 — Actual LIVE Astra turn aborted by a Codex event

- Observed 2026-09-13 07:08:41 UTC, app `7193616`, engine `8726d35`, Windows.
- The agent started and emitted assistant text, then reported
  `item/started did not match an active Codex thread`; turn duration 26,272 ms.
- Reproduced with the real installed `codex-cli 0.154.0`: a validated parent
  emits `subAgentActivity`, then the same pipe carries its worker's events.
  The adapter incorrectly treated those worker events as an unknown host turn.
- Source repair records the parent/worker relationship and keeps worker output
  separate. Worker events cannot create host approval authority; unknown parent
  and turn identities still refuse. The existing lifecycle test now includes
  this native sequence and worker approval refusal.
- Native before/after probe: the same one-worker arithmetic task failed before
  and completed with answer `2` after. Evidence is retained in the controller's
  `work/codex-native-child-probe-before.log`, `codex-native-child-events-before.json`,
  `codex-native-child-probe.log`, and `codex-native-child-events.json`.
- Worker-event repair was quick-promoted at app `7c64daad` / engine `3848f6d`.
  Actual saved-session Resume then failed before starting at 07:56 UTC.
- The planner had put paginated history into the compact Windows
  `agent-db/<sha256(generated home)>` directory, but the resume resolver looked
  only in the long generated config home. The rollout existed; its required
  SQLite history was in the planner's other directory.
- Resolver now recomputes that trusted planner location, retaining account,
  ordinary-file, database identity, and replacement checks. Actual owner
  source verification fails before and succeeds after. Existing native-resume
  test covers this directory shape and database replacement.
- Status: both source repairs verified; actual recovery in the next promoted
  generation and Windows/Linux installed-cut checks remain outstanding.
- Missing seam: real native provider start, streamed reply, tool/delegation
  activity, completion, and resume through the adapter in the promoted build.
  A simple mocked event stream or version check cannot establish compatibility.

### R-003 — Claude looked available but the provider refused a turn

- Observed 2026-09-13 07:09:50 UTC on the same LIVE pair.
- Provider response: organization disabled Claude subscription access for
  Claude Code; use an allowed API key or ask its administrator to enable access.
- All four configured Fable accounts were tried through the actual native CLI:
  two organization refusals and two model allowance refusals. An Opus turn
  succeeded on an existing account. The owner authorized the same conversation
  to continue with Opus.
- Actual UI continuation selected Opus but still chose an organization-disabled
  account. The host never passed the selected model into account admission;
  the default CLI's active Fable limit (100%) excluded a working Opus account
  whose shared weekly limit was 97%.
- Host, main, and paired engine now carry the selected model. Live and cached
  usage apply shared and selected-model ceilings together, retaining unknown
  scopes conservatively. An explicit paired-engine contract prevents an older
  engine silently ignoring this input.
- Real account probe after repair: Opus selectable at shared 97%; Fable refused
  at its model-specific 100%. Existing host recovery and live/cache allowance
  tests cover the boundary. Actual saved conversation reply after the cut is
  still required; the free account probe is not that proof.
- Post-cut continuation at app `2932f299` / engine `65d1a71` still failed:
  the app supplied `claude/opus`, while the classifier recognized only the
  `claude-opus` form used by the isolated probe. This was a repair defect.
  The actual routing record still applied Fable100% and selected another
  organization-disabled account. Normalize both supported forms and exercise
  the exact app model value through the engine's allowance decision; a regex
  assertion that the request merely contains "opus" is insufficient.
- Status: provider restrictions remain enforced; owner conversation recovery
  and Windows/Linux installed-cut validation remain open.
- Missing seam: readiness must distinguish executable presence, authentication,
  account permission, and a successful actual provider turn.

### R-004 — Removal slows down as archived conversations accumulate

- Removal waits for archival and cleanup; quota enforcement scans every file in
  every completed archive. Branch removal repeats that work for each node.
- Owner state measured 2026-09-13: 141 archives, 29,194 files, 19,825,753 bytes.
  A read-only metadata scan took 2,574 ms. Recent removed node had just 46 files.
- Status: bottleneck identified; no verified performance fix yet.
- Missing seam: removal with realistic pre-existing history, branch scaling,
  timely visible progress, retained conversation safety, and bounded cleanup.

### R-005 — Windows/Linux publication was not proving one tested source pair

- Public 1.0.44 Windows and Linux installers contain different app/engine refs.
- Windows package manifest reports `lifecycleQualified: false` despite most
  packaging checks being green. A package inventory is not lifecycle approval.
- Status: cut backend/publisher admission work is ongoing. No new installer is
  qualified for publication. Signed admission still needs its trusted producer,
  fixed validator, exact artifact binding, and real native receipts on both OSes.

### R-006 — Fresh Linux installed MCP reports an audit-vault failure

- The actual installed 1.0.44 bundled Electron initialized MCP, listed 98 tools,
  and answered a read. Stderr also reported that the audit signing key could not
  be read in the current operating-system identity or vault context.
- Status: fresh-install bootstrap/custody investigation remains open; this is
  not a full feature pass. Existing engine vault-test intermittency is also open.

## Repairs that still constrain future testing

### R-007 — LIVE restart watchdog never reached its production entrypoint

- Actual restart failed before stopping LIVE: watchdog exited 13 while a
  top-level dynamic import awaited the supervisor, which imports the watchdog.
- Existing survival test substituted its own worker and missed the import cycle.
- Fixed development tooling by starting async main without top-level await.
  One actual CLI regression test failed before and passed after; 18 targeted
  watchdog/controller tests passed, followed by a successful real LIVE restart.
- Preserve that real entrypoint test. Cancellation, custody, deadlines, and
  restart permission were not relaxed. This repair is development tooling only.

### R-008 — Source and harness identity gaps produced misleading cut results

- Cutter now refuses implicit dirty HEAD; explicit immutable refs remain valid.
- Windows artifact verification now hashes through .NET rather than relying on
  a PowerShell module lookup. Existing same-size tampering checks stay enforced.
- Linux source tests initially lacked generated capability/owner-pattern inputs;
  provisioned the real inputs instead of weakening checks or changing product code.
- An older LIVE judge clicked to select a circle but never opened its conversation.
  Gesture repair is committed; independent review and full rerun remain required.
- The recovery merge exposed two Windows ACP fixture cleanup failures: a native
  zero-process receipt arrived before the retained wrapper released its working
  directory. The test now waits for both receipts; product custody is unchanged.
- The normal invocation gate then refused the new ACP isolation suite because
  no default runner invoked it. Wired it into the existing page 2 core regression
  list rather than exempting it. The cut gate caught this missing test connection.
- The rotation fixture reached an installed Grok executable despite using fake
  account homes; its native cleanup failed on both unchanged engine `3848f6d`
  and the candidate. The fixture now runs the unavailable-billing path with
  Node rejecting the inspection arguments under real native custody. Dedicated
  Grok protocol tests remain responsible for the billing exchange; no product
  admission or cleanup rule was loosened.

### R-009 — Built-in role revision zero prevented Interrupt and Stop

- Actual Administrator LIVE app `2932f299` / engine `65d1a71` resumed the
  original Astra native thread and performed real search/browser work. Both
  visible Interrupt and Stop controls then failed; the supported close API
  returned `CONTINUATION_INVALID` before reaching the native process.
- The actual role library reports built-in roles at revision `0`, accepted by
  the app's start parser. Continuation storage required revisions of at least
  `1`. Stop persists a descriptor even with the continuation preset disabled,
  so this mismatch broke ordinary owner controls as well as persistence.
- Accept nonnegative revisions at the storage boundary. The existing app
  thread-transition test now passes the real built-in binding through the
  paired engine's real SQLite store and stops the host session with the preset
  off. It failed before and passed after the schema correction; no cancellation
  or native custody requirement was weakened.
- The engine continuation tests also exposed two Windows fixture teardown
  failures: an additional SQLite connection was closed after directory removal.
  Close all owned connections before removing the fixture, retaining the real
  competing-host storage checks.
- Evidence: `builtin-role-stop-before.log`, `builtin-role-stop-after.log`, and
  `builtin-role-engine-after.log` in the controller work directory; the last
  file records the initial fixture failures. Actual Stop/Interrupt after the
  resulting cut, saved conversation recovery, and both OS installer checks
  remain required. This issue is still open.

### R-010 — A native Codex worker reply killed its parent conversation

- Administrator LIVE app `2932f299` / engine `65d1a71` performed 104 actual
  tools in the resumed Astra conversation, then failed at 08:56Z with
  `Codex worker activity conflicts with an owned thread`. Initial progress was
  insufficient evidence of reliable recovery.
- A disposable real Codex 0.154.0 probe reproduced the exact failure: a worker
  calling `send_message` to `/root` emits `subAgentActivity`, kind `interacted`,
  on the worker thread with `agentThreadId` naming the existing root. The
  adapter wrongly treated this communication as a new worker declaration.
- Recognize only that bound worker-to-its-own-root interaction without changing
  either thread's ownership. The existing parent/worker lifecycle test now
  includes the real packet and a next parent turn; an unrelated owned root is
  still refused. All 25 targeted checks pass. The same native probe then
  completed and delivered the worker's answer, with confirmed process cleanup.
- Evidence: `codex-native-worker-message-events-before.json`,
  `codex-native-worker-message-events-after.json`,
  `codex-native-worker-message-before.log`,
  `codex-native-worker-message-after.log`, and
  `codex-worker-message-seam-after.log` in the controller work directory.
- Status: actual saved owner conversation after the resulting cut and Windows/
  Linux installer qualification remain open. Keep native worker communication
  in the core compatibility check, alongside spawn and completion.

## Latest evidence boundary

Windows owner hand check, 2026-09-13 09:24–09:34Z:

- Actual elevated main process `6492` loaded app `a521a369` / engine `5fb0e275`
  from generation `gen-2abcb1c2-5cf8-4943-9063-1f908178c57e`; the process
  command line and token were checked, not just the selected runtime pointer.
- Real page 2 pointer/keyboard controls navigated the saved trees, selected the
  configured Claude account, and continued the original Claude node with Opus.
  The host registry confirmed the intended account. A real reply completed at
  09:28:54Z and the next request was accepted at 09:32:05Z. This validates the
  model-format/account-admission repair in Windows LIVE (R-003).
- Real Interrupt changed Astra to `interrupted` at 09:29:51Z. Real Stop finished
  at 09:30:15Z and removed the host session. Reopening the same saved node
  resumed its native conversation; a short contextual reply completed at
  09:32:57Z, and its original task was continued. This validates the built-in
  revision repair in Windows LIVE (R-009), without replacing the user's node.
- The exact staged pair passed 47 app and 70 engine recovery checks with no
  skips. The native worker-to-parent probe also passed. The resumed owner's
  longer Astra turn spawned a native worker, waited for it, used real web tools,
  and completed at 09:37:22Z. Opus's follow-up used real searches and completed
  at 09:36:15Z. Both final replies were inspected in their actual conversation
  tabs, and both host sessions remained open for further messages. This proves
  Windows LIVE recovery; full R-010 Windows/Linux installed qualification is
  still outstanding.
- Remaining observed UI defects: an open Actions menu retains stale enabled/
  disabled state after Interrupt/Stop until reopened, and the account header
  reports Fable's `0% left` while the selected Opus has shared allowance. These
  are forwarded to the existing Linux app collaborator for shared UI repair.
- Evidence: `windows45-live-running.json`, `worker-message-cut-app-tests.log`,
  `worker-message-cut-engine-tests.log`, `repaired-live-page2.png`, and
  `claude-opus-restored-reply.png`, `astra-followup-completed.png`, and
  `claude-opus-followup-completed.png` in the controller work directory. This is
  LIVE recovery evidence, not a Windows/Linux installer qualification receipt.

The broader Windows health suite also found a pre-existing Antigravity timeout/
Stop fixture failure: `CODEX_PROCESS_CLEANUP_UNPROVEN`. It fails identically on
unchanged engine `3848f6d` and candidate `65d1a71`; Grok protocol checks pass.
Evidence: `baseline-antigravity-health.log` and
`grok-native-health-fixture-tests.log` in the controller's work directory.
Keep native startup/cleanup and harness investigation open as a publication
blocker. The owner's quick LIVE recovery is not full release qualification.

At app `7193616` / engine `8726d35`, Windows core suites passed 67 checks with
6 platform skips; Linux Docker source suites passed 73 with no skips. LIVE
nevertheless failed actual Astra and Claude turns. Therefore those green suites
do not qualify LIVE or either installer. Track verified behavior, not test counts.

For each update, append the exact artifact/ref, environment, observed result,
evidence location, and remaining gap to the relevant issue. Close an issue only
after its actual failure path passes in the resulting cut on the required OSes.
