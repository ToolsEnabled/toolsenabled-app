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

### R-001 — Page 2 buttons reportedly unusable in a Windows beta

- Report: a beta user could not press any page 2 button.
- Keyboard checks exercised several controls; they do not prove pointer hit
  testing. The reported native pointer failure remains unreproduced and open.
- Missing seam: actual installed renderer input, overlay/hit testing, and action
  completion on Windows. Repeat after every final cut before publication.

### R-002 — A native Codex turn aborted by a worker event

- The agent started and emitted assistant text, then reported
  `item/started did not match an active Codex thread`.
- Reproduced with a real installed Codex CLI: a validated parent emits
  `subAgentActivity`, then the same pipe carries its worker's events. The
  adapter incorrectly treated those worker events as an unknown host turn.
- Source repair records the parent/worker relationship and keeps worker output
  separate. Worker events cannot create host approval authority; unknown parent
  and turn identities still refuse. The existing lifecycle test now includes
  this native sequence and worker approval refusal.
- A saved-session resume then failed because history had been planned into a
  compact per-home directory that the resume resolver did not consult. The
  resolver now recomputes that trusted planner location, retaining account,
  ordinary-file, database identity, and replacement checks.
- Missing seam: real native provider start, streamed reply, tool/delegation
  activity, completion, and resume through the adapter in the promoted build.
  A simple mocked event stream or version check cannot establish compatibility.

### R-003 — A provider looked available but refused a turn

- The provider refused turns for accounts whose organization had disabled
  subscription access, while another model on an existing account worked.
- The host never passed the selected model into account admission, so a
  model-specific limit excluded an account the selected model could use.
- Host, main, and paired engine now carry the selected model, and both
  supported spellings of a model id are normalized before the allowance
  decision. An explicit paired-engine contract prevents an older engine
  silently ignoring this input.
- Missing seam: readiness must distinguish executable presence, authentication,
  account permission, and a successful actual provider turn.

### R-004 — Removal slows down as archived conversations accumulate

- Removal waits for archival and cleanup; quota enforcement scans every file in
  every completed archive. Branch removal repeats that work for each node.
- Status: bottleneck identified; no verified performance fix yet.
- Missing seam: removal with realistic pre-existing history, branch scaling,
  timely visible progress, retained conversation safety, and bounded cleanup.

### R-005 — Windows/Linux publication must prove one tested source pair

- Installers for different platforms must be built from the same app/engine
  refs. A package inventory is not lifecycle approval.
- Signed admission still needs its trusted producer, fixed validator, exact
  artifact binding, and real native receipts on both operating systems.

### R-006 — Fresh Linux install reports an audit-vault failure

- A fresh installed build initialized MCP and answered a read, but stderr
  reported that the audit signing key could not be read in the current
  operating-system identity or vault context.
- Status: fresh-install bootstrap/custody investigation remains open.

## Repairs that still constrain future testing

### R-007 — The restart watchdog never reached its production entrypoint

- A top-level dynamic import awaited the supervisor, which imports the
  watchdog, so the watchdog exited before stopping anything.
- The existing survival test substituted its own worker and missed the import
  cycle. Preserve the real entrypoint test.

### R-008 — Source and harness identity gaps produced misleading cut results

- Cutter now refuses implicit dirty HEAD; explicit immutable refs remain valid.
- Windows artifact verification hashes through .NET rather than relying on a
  PowerShell module lookup. Same-size tampering checks stay enforced.
- Linux source tests are provisioned with the real generated inputs instead of
  weakening checks.
- A native fixture cleanup race now waits for both receipts; product custody is
  unchanged. New suites must be wired into a default runner, not exempted.

### R-009 — Built-in role revision zero prevented Interrupt and Stop

- The role library reports built-in roles at revision `0`, accepted by the
  app's start parser, while continuation storage required at least `1`. Stop
  persists a descriptor even with the continuation preset disabled, so this
  mismatch broke Interrupt and Stop.
- Nonnegative revisions are accepted at the storage boundary, and the
  thread-transition test passes the real built-in binding through the paired
  engine's real SQLite store.

### R-010 — A native Codex worker reply killed its parent conversation

- A worker calling `send_message` to its root emits `subAgentActivity`, kind
  `interacted`, naming the existing root; the adapter treated it as a new
  worker declaration.
- Only that bound worker-to-its-own-root interaction is recognized, without
  changing either thread's ownership. An unrelated owned root is still
  refused. Keep native worker communication in the core compatibility check,
  alongside spawn and completion.

## Evidence rule

Green component suites do not qualify a live installation or an installer.
Track verified behavior, not test counts. For each update, record the exact
artifact/ref, environment, observed result, and remaining gap in the relevant
issue. Close an issue only after its actual failure path passes in the
resulting cut on the required operating systems.
