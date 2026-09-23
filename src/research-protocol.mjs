// Protocol decisions of record. Every decision LeanBench had to make before a
// draw ran, as a field the next study decides again: the value LeanBench
// settled on is offered beside each field with the measured reason, never
// applied silently. The decided fields compose into the study's frozen
// decisions text (spec.decisions); undecided ones are listed there by name so
// the frozen text never implies a choice that was not made.
//
// Sources (Desktop\LeanBench-Options-Research-20260914): LEAN-BENCH-DECISIONS.md,
// cleanroom/README + canary.js + generate.js + gen_drivers.js, CODEBOOK-v2,
// bank_spec/bank_runner/DATA-FREEZE, arm-options/MODELS.md, arm RUN-MANIFESTs,
// batches/cloud/COLLECTION, audit/PLAN.md, the legacy decision log, the Methods
// draft's [DECISION] markers, the 2026-09-04 audit and completion plan.

const choice = (id, label, options, lb, why) => ({ id, label, kind: 'choice', options, lb, why })
const yesno = (id, label, yes, no, lb, why) => ({ id, label, kind: 'yesno', yes, no, lb, why })
const number = (id, label, unit, lb, why, extra = {}) => ({ id, label, kind: 'number', unit, lb, why, ...extra })
const text = (id, label, lb, why, placeholder = '') => ({ id, label, kind: 'text', lb, why, placeholder })
const note = (id, label, lb, why, placeholder = '') => ({ id, label, kind: 'note', lb, why, placeholder })
const list = (id, label, lb, why, placeholder = '') => ({ id, label, kind: 'list', lb, why, placeholder })

const PROTOCOL_REGISTRY = Object.freeze([
  { id: 'scope', title: 'Study scope and registration', intro: 'What kind of study this is, what is fixed before the first draw, and what waits for the owner.', fields: [
    choice('study-kind', 'Kind of study', [['exploratory', 'Exploratory: small cells, findings feed a later confirmation'], ['confirmatory', 'Confirmatory: registered cells, hypotheses committed first'], ['apparatus', 'Apparatus check: unqualified computations, never scientific admission']], 'confirmatory', 'LeanBench: the August arm at n=10 was exploratory; the cells the paper leans on were redrawn at 30+ in the clean room as its confirmation.'),
    yesno('hypotheses-first', 'Hypotheses committed before the confirmatory draws', 'A one-page hypotheses list is written and committed before the first confirmatory draw; no registration theater.', 'Hypotheses may be stated after the draws.', 'yes', 'LeanBench: HYPOTHESES.md held H1–H6 with predictions and tests; its commit had to precede the first draw.'),
    yesno('scope-closed', 'Scope closed once the design is registered', 'No new arms, conditions or dimensions without an owner ruling; additive extensions are recorded as such.', 'Scope stays open during collection.', 'yes', 'LeanBench: "SCOPE IS CLOSED" 2026-08-23; reopened 2026-08-25 only for the options arm as an additive external-validity extension.'),
    yesno('push-daily', 'Every commit pushed the day it is made', 'A day with local commits and no push is a provenance defect and is reported as one.', 'Pushes happen when convenient.', 'yes', 'LeanBench: the public repository had not been pushed between 2026-07-16 and 2026-08-28 while the study continued; only public server-side timestamps support priority claims.'),
    yesno('keep-everything', 'Nothing is deleted', 'Superseded draws, quarantined rows and old history are kept, checksummed and disclosed; excluded rows stay recoverable.', 'Bad rows may be deleted.', 'yes', 'LeanBench: superseded folders kept beside the lane of record; quarantine files, never deletion; sealed history bundles with SHA-256, restorable on request.'),
    yesno('dated-amendments', 'Governing artifacts hashed; changes are dated amendments', 'Prompts, codebook, bank specification and instruments are hashed pre-lock; any later change is a dated amendment with the prior hash kept, never a silent refresh.', 'Instruments may change without a record.', 'yes', 'LeanBench: CODEBOOK-HASHES.txt, refreshed only pre-lock and re-verified before the probes and before signature; the 2026-08-26 generate.js and canary.js edits were recorded as an amendment ratified by the owner.'),
    list('owner-gates', 'Actions that wait for the owner\'s word', ['Releasing the remaining draws of an arm', 'Scaling up to the confirmatory cell sizes', 'Any metered spend (subscriptions only otherwise)', 'Retiring or re-adding a lane', 'Growing the prompt set', 'A new arm, condition or dimension'], 'LeanBench: "release the 53", "go scale-up", the gemini funding call, lane retirement and prompt-set growth were each an explicit owner ruling.', 'One action per line'),
    yesno('approval-loop', 'Owner approves every semantic snippet by content digest', 'The owner agrees semantics and adversarial examples before code, reviews wording and every lifecycle fragment line by line, then approves an exact content digest; any change makes the approval stale and the runner refuses unapproved dependencies.', 'Agents may admit snippets without owner review.', 'yes', 'LeanBench 2026-08-31 handoff: agents cannot grant owner approval; the compiler and experiment runner must reject any transitive dependency without a current approval record.'),
  ] },
  { id: 'prompt', title: 'The prompt as input', intro: 'What the model receives, byte for byte, and how the prompt set may grow.', fields: [
    choice('input-shape', 'What the model receives', [['prompt-only', 'The frozen prompt only: single turn, no system prompt, no injections'], ['minimal-line', 'The frozen prompt plus one identical minimal system line for every vendor'], ['harness', 'The vendor-native harness layer, disclosed, with the frozen prompt']], 'harness', 'LeanBench: harness cells ran each vendor\'s CLI as installed (its own instruction layer, disclosed); bare cells sent the prompt with one identical line, "Complete the task."; never multi-turn.'),
    text('system-line', 'System line for bare cells', 'Complete the task.', 'LeanBench: one identical minimal line for every bare surface, the BigCodeBench / Inspect / HELM pattern; LiveCodeBench ships per-family system messages instead, which is accepted practice when disclosed.', 'Leave empty for none'),
    number('max-turns', 'Turns per draw', 'turn', 1, 'LeanBench: --max-turns 1 on every CLI; more than one turn is recorded as an anomaly.', { min: 1 }),
    yesno('frozen-hash', 'Prompts byte-frozen and hash-verified per draw', 'Every prompt carries a SHA-256; a draw refuses on a hash mismatch and records the hash it sent.', 'Prompts are read from the working copy.', 'yes', 'LeanBench: FROZEN PROMPT MISMATCH aborts the lane; the combined hash of prompt plus any condition suffix is recorded per row.'),
    yesno('noask', 'A no-ask condition is included', 'Yes: append the no-ask instruction below to the prompt, identically across models and lanes.', 'No: do not include a no-ask condition.', 'yes', 'LeanBench: the LiveCodeBench line, owner-picked verbatim, appended after one blank line; the field already made that wording decision.'),
    text('noask-text', 'The no-ask instruction, verbatim', 'You will NOT return anything except for the program.', 'LeanBench: LiveCodeBench lcb_runner/prompts/code_generation.py line 83, verbatim.'),
    list('conditions', 'Prompt conditions', ['base', 'noask'], 'LeanBench: base and noask, crossed with every prompt, model and effort.', 'One condition per line'),
    choice('growth-rule', 'How the prompt set may grow', [['mechanical-reviewed', 'Only through the mechanical atom system, and only after the owner personally reviews the prompts and their fair-reading sets'], ['reviewed', 'Any source, after owner review'], ['free', 'Freely during the study']], 'mechanical-reviewed', 'LeanBench: no batch generates before the owner has reviewed each new prompt and its fair readings; the O1v0 review was an explicit waiver on record.'),
    yesno('admission-gate', 'Degenerate and contaminated prompts are excluded before draws', 'A prompt whose answer bank shows one behavior class at every conditioning tuple is excluded (it cannot distinguish anything); a contaminated prompt is killed; a refrozen fix gets a new id.', 'Every prompt is drawn.', 'yes', 'LeanBench: BL-06 and OM-A excluded (one class at all tuples), BL-02a and BL-09a/b killed, BL-02b\' refrozen under its own id after the hygiene screen.'),
    yesno('fair-readings', 'Each withheld atom has an owner-reviewed set of fair readings', 'Every void enumerates the concrete conventions a competent implementation could adopt; a supplied answer is judged against that set, not only the hidden original.', 'Readings are judged case by case.', 'yes', 'LeanBench: FAIR-READINGS.md per O1 void; the Methods draft records which requirements are withheld and the admissible readings.'),
  ] },
  { id: 'cleanroom', title: 'Clean room and canary', intro: 'Where generation runs, what can reach it, and the test that proves the room is clean.', fields: [
    yesno('cleanroom', 'Generation runs in an instruction-bare clean room', 'A dedicated root with blank home directories, an allowlisted environment and a fresh empty working directory per draw; no instruction file reachable.', 'Generation runs in the working environment.', 'yes', 'LeanBench: C:\\lbres with blank USERPROFILE/HOME/APPDATA/LOCALAPPDATA, TEMP inside the room; contamination settled two-sided on 2026-08-21.'),
    yesno('canary-required', 'No generation without a same-day passed canary', 'The generator refuses to spawn anything without today\'s canary certificate; no flag bypasses it.', 'The canary is advisory.', 'yes', 'LeanBench: "Rule forever"; generate.js exits before a single draw when CANARY-PASS-<today>.json is absent.'),
    choice('canary-cadence', 'Canary cadence', [['batch', 'Before and after every batch, same UTC day'], ['day', 'Once per UTC day before generation'], ['study', 'Once per study']], 'batch', 'LeanBench: run before (and after) every batch; the pass file is stamped by UTC day, which rolls at 17:00 local, and a fresh same-day canary is the safety rule, not an inconvenience.'),
    choice('canary-scope', 'Canary scope', [['surface', 'Per surface: each surface generates only with its own same-day two-sided pass'], ['all', 'All-or-nothing: every surface must pass before any generates']], 'surface', 'LeanBench: ratified 2026-08-26 after Google retired gemini-cli for individual accounts; all-or-nothing would have blocked codex and claude for no purpose of the rule, and a dead client cannot contaminate anything.'),
    choice('canary-sides', 'What the canary proves', [['two-sided', 'Two-sided: a planted marker must fire, and a clean room must give a substantive silent answer'], ['one-sided', 'One-sided: the clean room stays silent']], 'two-sided', 'LeanBench: a crashed or empty output is FAIL, never "clean"; an ENOENT\'d binary once scored as silent under the naive criterion. Claude is proved three ways: settings-on planted fires, lane flags planted silent, clean silent.'),
    yesno('certificate', 'The canary certificate ships beside every batch', 'Every lane writes the day\'s pass file into its batch folder; a certificate that cannot be shipped is fatal.', 'Certificates stay in the room.', 'yes', 'LeanBench: shipped atomically (temp file plus rename) after an EBUSY race between cells launched in the same millisecond killed three cells on 2026-08-29.'),
    list('env-allowlist', 'Environment variables allowed into a draw', ['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC'], 'LeanBench ENV-MANIFEST: eleven names; everything else, including every billing and routing variable, is absent from the child environment.', 'One name per line'),
    yesno('isolation-record', 'An isolation record is kept per draw', 'Every ancestor profile file (CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md, .claude settings, .codex config) found and hashed; global profiles present; whether the working directory was empty.', 'No per-draw isolation record.', 'yes', 'LeanBench gen_drivers: found files are recorded with their SHA-256, not just a boolean; channel forensics showed each CLI reads only its home and the working directory.'),
    choice('funding', 'Funding fence', [['subscriptions', 'Subscriptions only: every billing and routing variable stripped from the child environment and the stripping recorded'], ['metered-approved', 'Metered API allowed for named cells with the owner\'s word'], ['metered', 'Metered API']], 'subscriptions', 'LeanBench: "Money: subscriptions only"; never --bare (it forces API-key auth); an inherited ANTHROPIC_BASE_URL or a Bedrock/Vertex switch would route the same call to a metered endpoint, so every such name is stripped and listed.'),
    yesno('direct-cli', 'Generation and collection never route through orchestration tools', 'Local draws go through the clean-room generator and cloud draws through the vendor CLI directly under an explicit home; never through a dispatch or routing system.', 'Orchestration tools may launch study draws.', 'yes', 'LeanBench 2026-08-26: cloud task tools route through an entire dispatch system; study generation and collection never use them.'),
    yesno('second-home', 'A second account is a second clean-room home', 'Each account gets its own home holding only its credential, certified by the canary under its own label.', 'Accounts share a home.', 'yes', 'LeanBench: codex@<home> certified and merged into the day\'s pass file; cloud tasks are visible only to the account that launched them.'),
  ] },
  { id: 'surfaces', title: 'Surfaces, models, efforts', intro: 'Which systems answer, through which surface, with what recorded per draw.', fields: [
    yesno('exact-ids', 'Exact model ids only', 'Never a bare alias, never a newer model silently; a lane whose recorded model differs from the pin is quarantined, not graded.', 'Aliases and defaults are acceptable.', 'yes', 'LeanBench MODELS.md: pins taken from the measured lane inventory, not from memory.'),
    list('models', 'Pinned models', ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5', 'gemini-3.6-flash (bare Vertex only)'], 'LeanBench options arm: what the equity study actually used; the gemini-cli harness was retired by its provider, so the gemini family is a bare surface only.', 'One exact id per line'),
    list('surfaces', 'Surfaces', ['codex CLI (exec, read-only sandbox, ephemeral)', 'claude CLI (print mode, tools off, settings off)', 'bare OpenAI API', 'bare Vertex REST', 'claude near-bare (system prompt replaced)', 'codex cloud (one task per draw)'], 'LeanBench: the gradient bare API → one-shot CLI → full agent; SWE-agent and Terminal-Bench are the precedents for the same model moving between harnesses.', 'One surface per line'),
    yesno('symmetric', 'Surfaces symmetric across vendors within a claim', 'A claim compares like with like: every vendor through its native CLI, or every vendor bare; a CLI-versus-bare delta is reported per family as the harness contribution.', 'Mixed surfaces may be compared.', 'yes', 'LeanBench H5: bare models never ask; asking is a property of the harness layer, which only a symmetric design can show.'),
    list('efforts', 'Effort ladder', ['low', 'medium', 'high', 'xhigh', 'max'], 'LeanBench: codex model_reasoning_effort, claude --effort, Vertex thinkingBudget ladder (128 / 2,048 / 8,192 / 16,384 / 32,768 by model).', 'One level per line'),
    yesno('argv-record', 'Exact invocation recorded per draw', 'CLI version, exact argv, raw stdout and stderr (tails masked for tokens), auth mode, served model from structural telemetry, tool events, wall time, isolation record and canary certificate name.', 'Only the response is kept.', 'yes', 'LeanBench: 765 blank harness-error rows once made a 100%-failing lane unreadable; every failure row now carries exit code, signal, spawn error and bounded output tails.'),
    yesno('no-shell', 'Children spawned without a shell', 'The argument vector reaches the child exactly; an argv self-test proves it.', 'Commands may go through a shell.', 'yes', 'LeanBench: a shell path once word-split the system prompt and dropped the empty --tools "" and --setting-sources "" values.'),
    number('output-cap', 'Output token ceiling', 'tokens', 64000, 'LeanBench: the claude CLI default of 32,000 truncated 15 of 113 options draws and each was banked as no-program, read at grading as a refusal or an ask; a ceiling inside the response distribution makes the harness the measurement.', { min: 1 }),
    number('draw-timeout', 'Per-draw timeout', 'minutes', 40, 'LeanBench: claude-sonnet-5 at max effort needs 11–17 minutes even when it succeeds; a 20-minute ceiling killed 46 of 66 draws at exactly 1,200,000 ms. Twenty minutes elsewhere; cloud launch 8; cloud status and diff 5.', { min: 1 }),
    yesno('served-model', 'Served model recorded from structural telemetry', 'The model the provider reports (codex session_configured, claude modelUsage, gemini stats, Vertex modelVersion) is recorded per draw; analysis stratifies on it when pinning is not honoured.', 'The requested model is assumed served.', 'yes', 'LeanBench: gemini-cli pinning was broken (2.5-flash served 3.5-flash); cloud model and effort overrides are not verifiable in task records and are never claimed.'),
    choice('dead-surface', 'When a provider retires a surface', [['document', 'Document the remaining cells as unrunnable by provider retirement; a legitimate finding'], ['substitute', 'Substitute another surface, labelled as its own surface, never spliced in']], 'document', 'LeanBench: gemini-cli EOL (IneligibleTierError, 2026-08-24); Antigravity has no headless mode; Vertex is a bare surface, wrong for harness cells.'),
  ] },
  { id: 'schedule', title: 'Scheduling, quota and concurrency', intro: 'The order lanes run in, how many run at once, and what a start refuses.', fields: [
    choice('quota-order', 'Quota ordering', [['cheapest-first', 'Scheduling only, never design: cheapest effort first, alternating models to spread quota'], ['registered', 'The registered lane order'], ['convenient', 'Whatever is convenient']], 'cheapest-first', 'LeanBench: codex first, sol after luna and terra; "do it in order though so the things that can land immediately do"; ordering is scheduling, never a design change.'),
    list('lane-order', 'Lane order of record', ['Core lanes first', 'Parity lanes serially, cheapest effort first, alternating models', 'Bare cells', 'Cloud attempts ladder last, launched manually'], 'LeanBench arm-o1-parity-queue: the cloud ladder is never auto-launched because of the routing traps found in the equity study.', 'One lane or group per line'),
    number('in-flight', 'Cells in flight at once', 'cells', 10, 'LeanBench: the owner\'s ceiling, 2026-08-27; network-bound draws do not contend with the engine for CPU the way grading did.', { min: 1 }),
    yesno('per-cell', 'Concurrency per cell, never within a cell', 'Each child owns its own lane file and per-draw temp directory, so two children cannot write the same row.', 'Draws within a cell may run concurrently.', 'yes', 'LeanBench arm-o1-resume: default 1, capped at the owner\'s ceiling.'),
    number('engine-workers', 'Engine workers', 'workers', 1, 'LeanBench: LEAN at 2 workers measured no clean gain and doubled machine load.', { min: 1 }),
    yesno('drop-concurrency', 'Concurrency that causes any issue is dropped, not debugged', 'A race or crash under concurrency lowers the concurrency; the one exception (the certificate copy) was made race-safe under a dated amendment.', 'Concurrency issues are debugged in place.', 'yes', 'LeanBench decisions of record, 2026-08-21 and the 2026-08-29 amendment.'),
    yesno('single-entry', 'One entry point, no double starts', 'A start refuses if any study process is already running or the engine daemon does not answer; a pause kills by command-line match; everything is resume-safe.', 'Jobs may be launched ad hoc.', 'yes', 'LeanBench engine-start.sh: past collisions (a duplicate driver, the parity queue jumping ahead, a "stopped" build that kept writing) were all second launches.'),
    yesno('cloud-one-task', 'One cloud task per draw', 'A task asked for N programs yields N correlated outputs from one context, not N draws; launches run concurrently inside the quota window, collection later costs nothing, and a wave of failed launches aborts.', 'One task may return several draws.', 'yes', 'LeanBench cloud-lane: 12 simultaneous submissions; abort when six launches fail with none succeeding.'),
    list('cloud-attempts', 'Cloud attempts ladder', ['1', '2', '4', '8', '16'], 'LeanBench: the only knob verifiable in cloud task records.', 'One value per line'),
  ] },
  { id: 'draws', title: 'Draw statuses, retries and fairness', intro: 'What a draw can be, which ones count, and what happens to the rest.', fields: [
    list('statuses', 'Status vocabulary before matching', ['program', 'no-program', 'harness-error (transport, CLI or spawn failure; retried; never a model result)', 'harness-truncation (output ceiling hit, no program)', 'provider-blocked (quota, sign-in or rate-limit notice; never counted; always retried)', 'non-runnable (nonzero exit, timeout or runtime error; final)', 'EMPTY-TAPE', 'NO-IMPLEMENTATION'], 'LeanBench CODEBOOK-v2 §E and the graders; every status before matching is ineligible as an agreeing category.', 'One status per line'),
    yesno('fairness', 'Unfinished draws do not count and are retried', 'A draw the model never finished is excluded and redrawn; everything is kept on disk regardless.', 'Unfinished draws count as failures.', 'yes', 'LeanBench: the owner\'s fairness rule; the excluded quarantine keeps every row recoverable.'),
    choice('provider-notices', 'Provider notices', [['never', 'Never observations: marked provider-blocked, the lane stops, rows are quarantined and redrawn after recovery'], ['no-program', 'Recorded as no-program']], 'never', 'LeanBench: 59 of 62 claude-sonnet draws were once the single string "You\'ve hit your session limit", banked as observations; 1,673 cloud envelopes were once "Not signed in".'),
    yesno('shape-test', 'A short, fast, program-less reply is a provider notice (claude)', 'Under 400 characters in under 60 seconds with no program is a notice whatever it says; codex and gemini rely on wording because a genuine low-effort draw finishes in 30–90 seconds.', 'Only wording is tested.', 'yes', 'LeanBench: three literal patterns missed a real block in turn; catching it by shape survives the next new message.'),
    choice('truncation', 'Truncated responses', [['harness-error', 'Harness error: redrawn, never graded'], ['no-program', 'Graded as no-program']], 'harness-error', 'LeanBench: a response cut off by a ceiling is neither an answer nor a refusal.'),
    choice('resume-key', 'Resume matches', [['hash', 'The prompt hash per row, never the index'], ['index', 'The row index']], 'hash', 'LeanBench: a collided or mislabeled file once suppressed a different prompt\'s draws; harness-error and provider-blocked rows never satisfy the resume set.'),
    choice('batch-pooling', 'Batch folders', [['pooled', 'Targets counted across all date folders; analysis selects one folder per cell; superseded folders kept and excluded'], ['single', 'One folder per lane']], 'pooled', 'LeanBench: folders are stamped by UTC date, which rolls at 17:00 local, so an afternoon lane resumes into a new folder; pooling blindly would double-weight prompts.'),
    choice('engine-retry', 'Engine results retried', [['harness-error', 'Only harness errors: a non-zero exit with error text is the program failing and is final; without error text it is the harness flaking'], ['all', 'Every failure']], 'harness-error', 'LeanBench grade-o1: measured against the bank ledger; every blank-error non-zero exit later completed under the same name.'),
    choice('late-response', 'Several responses for one trial', [['fixed-rule', 'A selection rule fixed before grading picks one; a completed answer is never replaced because another could score better'], ['best', 'The best available response']], 'fixed-rule', 'Methods draft: infrastructure retries are a fixed policy and not additional model replicates.'),
    yesno('unreachable', 'Unreachable is not data', 'A task queried under the wrong account, a sign-in notice or a path warning is unreachable: skipped and queued, never an envelope; per-cell distributions pass a magnitude smell test before grading.', 'Error text may be recorded as a response.', 'yes', 'LeanBench cloud collection: a fully specified donor cannot be 100% no-program; 1,583 poisoned envelopes were purged by exact error-text match.'),
    yesno('cleanup-nonfatal', 'Cleanup failure never kills a cell', 'The draw row is durably appended before cleanup; a locked temp directory costs a leftover folder and nothing else.', 'Cleanup errors abort the cell.', 'yes', 'LeanBench: Windows EBUSY on the just-exited CLI\'s temp dir crashed 25 of 26 concurrent cells on 2026-08-27.'),
  ] },
  { id: 'cells', title: 'Cells and sample sizes', intro: 'What a cell is, how many draws each gets, and how completion is judged.', fields: [
    list('cell-factors', 'A cell is crossed by', ['prompt', 'model', 'effort', 'condition', 'surface'], 'LeanBench: prompt × model × effort × condition, per surface.', 'One factor per line'),
    number('n-eligible', 'Draws per eligible cell', 'draws', 30, 'LeanBench: the cells the paper leans on get 30+ in the clean room; hypotheses use one-sided exact tests at α .05 and exact binomial bounds at n=30.', { min: 1 }),
    number('n-anchor', 'Draws per anchor or control cell', 'draws', 20, 'LeanBench options arm registration.', { min: 1 }),
    number('n-donor', 'Draws per donor, placebo or pin cell', 'draws', 10, 'LeanBench options arm registration.', { min: 1 }),
    number('n-exploratory', 'Draws per exploratory cell', 'draws', 10, 'LeanBench: the professor\'s arm and the expansion ran n=10 per cell as exploratory work.', { min: 1 }),
    choice('completion', 'Completion is judged', [['cell', 'Cell by cell against the registration; a row total is not evidence a lane finished'], ['total', 'By lane row totals']], 'cell', 'LeanBench arm-o1-status: a total can look healthy while individual cells sit short.'),
    choice('overdraw', 'Overdrawn cells', [['kept', 'Kept as extra data; completion still judged against the registration'], ['trimmed', 'Trimmed to the target']], 'kept', 'LeanBench: luna medium overdrew to 60 from an earlier wrong resume target; kept.'),
    note('tests', 'Pre-stated tests and thresholds', 'One-sided exact test per model at alpha .05; exact binomial upper bounds where a rate is predicted to be zero; total-variation distance at or above 0.3 for a descent difference.', 'LeanBench HYPOTHESES.md H1–H4.'),
  ] },
  { id: 'truth', title: 'Answer key, data freeze and engine', intro: 'How a program is judged right, and what is frozen before the key exists.', fields: [
    choice('grader', 'What grades a program', [['mechanical', 'A mechanical answer key: the program executes in a pinned engine and is compared to a precomputed, hash-verified oracle bank; no language model grades anything'], ['judge-diagnostic', 'The mechanical key, with a language-model judge as a separate diagnostic that never overrides it'], ['judge', 'A language-model judge']], 'mechanical', 'LeanBench: deterministic grading is the repository\'s first rule; the QuantCode-Bench audit measured a 90% judge false-pass rate on determinate tasks.'),
    yesno('bank-method', 'The answer bank is built from registered degrees of freedom', 'One completely pinned donor; every free implementation choice registered with its levels, reference first; full factorial inside the conditioning set; one-at-a-time runs plus a spot check for every excluded choice; classes pre-registered with absorption priority; counts derived in code.', 'The answer key is a single reference program.', 'yes', 'LeanBench bank_spec v2: 4,086 oracle manifests; the conditioning argument is stated per projection.'),
    choice('matching', 'Matching a program to the bank', [['tuple-free', 'Tuple-free: the projection is matched against every registered oracle run; none is DRIFT; several across tuples is AMBIGUOUS, never a picked winner'], ['nearest', 'Nearest match']], 'tuple-free', 'LeanBench CODEBOOK-v2 §B; the cross-tuple rule of 2026-08-16.'),
    choice('extractor-role', 'The code extractor', [['never-gates', 'Never gates matching: it feeds a validity report and the numeric codes; anything it cannot decide is unresolved, never a guess'], ['decides', 'Decides the code']], 'never-gates', 'LeanBench: acceptance floor 0.90 on committed fixtures (88 of 88); unsupported levels cannot discard a draw.'),
    yesno('bank-verify', 'Bank integrity verified at import and per run', 'Source copy equals manifest, the in-container nonce equals the source nonce, parameters equal the job; each run records data hash, engine image digest, CLI version, git revision, source hash, exit code and a completion marker; stale or partial outputs are refused.', 'The bank is trusted as built.', 'yes', 'LeanBench: 4,086 of 4,086 verified fresh at import on 2026-08-21.'),
    yesno('execution-control', 'Positive controls run through the grader', 'Oracle runs graded through the grader must code to their own reading; every 25th draw per stratum runs twice and a differing tape raises a nondeterminism flag.', 'No execution control.', 'yes', 'LeanBench: execution control 97 of 97, label-wrong 0 of 2,017 before the arm launched.'),
    number('stride', 'Re-execution stride', 'draws', 25, 'LeanBench grade.py --stride.', { min: 1 }),
    yesno('data-freeze', 'Data frozen before the bank runs', 'Window, tickers, resolution, vendor and provenance, adjustment policy, per-file SHA-256 and an aggregate hash are recorded first; the runner verifies the aggregate before any engine run.', 'Data may be refreshed during the study.', 'yes', 'LeanBench DATA-FREEZE 2026-08-15: 2006-01-03 to 2015-12-31, five tickers, daily, LEAN sample data.'),
    choice('freeze-change', 'Changing frozen data after lock', [['rerun-all', 'Requires re-running and re-hashing the entire bank with an appendix record'], ['partial', 'Affected cells only']], 'rerun-all', 'LeanBench: the window is not a researcher degree of freedom.'),
    list('engine-pins', 'Engine pins', ['LEAN image digest', 'lean CLI version', 'engine build number', 'container Python version', 'per-backtest timeout', 'worker count'], 'LeanBench: image sha256 pinned; lean CLI 1.0.227; build 18057; each worker in its own project directory; a timeout kills the process tree and the container.', 'One pin per line'),
    number('engine-timeout', 'Per-backtest timeout', 'seconds', 600, 'LeanBench bank_runner.', { min: 1 }),
    choice('completion-detect', 'Run completion is detected from', [['result', 'The result JSON or log; a zero-order run is an empty tape, never "not run" and never "ok" by file presence'], ['files', 'Output file presence']], 'result', 'LeanBench bank_runner: the manifest must match the source hash.'),
    yesno('bank-gate', 'Bank execution needs independent review and explicit owner authorization', 'An approval selects a rerun but does not authorize it; a content-addressed implementation and data freeze are independently reviewed, then the owner authorizes engine execution.', 'The bank runs when ready.', 'yes', 'LeanBench O1 horizon-tail workspace README.'),
  ] },
  { id: 'grading', title: 'Grading and classification', intro: 'The rules that turn a response into a code.', fields: [
    choice('extraction', 'Program extraction', [['one-rule', 'One rule for every surface: the largest fenced block naming the algorithm class, else the largest fence, else raw text declaring the class'], ['per-surface', 'Per-surface rules']], 'one-rule', 'LeanBench gen_drivers; cloud diffs take the added lines first.'),
    note('ask-rule', 'Ask rule', 'A draw with no extractable program counts as asks-clarifying if its text ends with a question mark or states a need naming the withheld quantity; empty text is unfinished and retried.', 'LeanBench bench-grade.py header, stated before grading.'),
    choice('refusals', 'Refusals and questions', [['together', 'Classified together as asks-clarifying: same behavior for the study\'s purpose'], ['separate', 'Separate codes']], 'together', 'LeanBench: owner-validated 2026-08-23 from the hand-verification packet; not worth a definitional split.'),
    choice('pass-def', 'A pass requires', [['behavior', 'Successful execution and agreement on the specified observations; trade activity is necessary evidence, never sufficient; a zero-trade program can be correct'], ['any-trade', 'Execution with any trade']], 'behavior', 'Methods draft: the answer key and activation evidence decide which interpretation applies.'),
    yesno('infra-not-model', 'Infrastructure failures are never model failures', 'A docker outage, a dead binary or a network fault is a harness error, retried and reported separately.', 'Failures count against the model.', 'yes', '2026-09-04 audit: "please make sure Docker is running" rows were once marked completed and failed.'),
    yesno('no-best-of-k', 'No reprompting until a judge passes', 'One response per scheduled attempt; a retry loop that resubmits until the grader passes makes every rate a best-of-k against a noisy instrument.', 'Retries until pass are allowed.', 'yes', '2026-09-04 audit: a majority of multi-attempt calls contained byte-identical resubmissions.'),
    yesno('strict-and', 'Overall pass is the strict AND of every gate', 'Compile, runtime, trade, schema and judge each keep their own label; the reported rate and its N share one denominator.', 'Overall pass may collapse to one gate.', 'yes', '2026-09-04 audit: overall_pass collapsed to judge_pass and AVG skipped NULLs, so rate and N had different denominators.'),
    number('judge-threshold', 'Judge threshold when a judge is used', 'score', 0.7, 'Legacy decision log: 0.7 is the rubric anchor "mostly correct, core logic intact", fixed a priori; any change bumps the judge version.', { min: 0, max: 1, step: 0.05 }),
    choice('judge-pool', 'Judges and contestants', [['disjoint', 'Judges come from outside the contestant pool'], ['disclosed', 'Overlap disclosed, with judge–human agreement reported']], 'disjoint', '2026-09-04 audit: judges drawn from the contestant pool was the second-ranked validity issue; inter-judge disagreement measured 30.6%.'),
    yesno('hitl', 'Human validation sample drawn deterministically', 'A fixed seed, stratified by model and condition, never reused to tune the judge; judge–human agreement is reported.', 'No human validation.', 'yes', 'Legacy decision log 5; the 2026-09-04 audit found it built but never run.'),
    yesno('stage-instrumentation', 'Per-stage instrumentation on every row', 'First failed stage, failure classes and the harness revision are populated for every call.', 'Stage fields may stay empty.', 'yes', '2026-09-04 audit: first_failed_stage was NULL on all 77 rows and harness_sha on all 264.'),
  ] },
  { id: 'analysis', title: 'Analysis and reporting', intro: 'What is counted, how uncertainty is stated, and what is kept apart.', fields: [
    choice('primary-measure', 'Primary measure', [['scheduled', 'Behavioral success per scheduled trial'], ['completed', 'Behavioral success per completed trial']], 'scheduled', 'Methods draft; the app\'s analysis plan carries the denominator as a frozen field.'),
    yesno('counts-reported', 'The funnel is reported beside the rate', 'Attempted, collected, extracted, executable, graded and successful trials are reported separately; conditional success among executables separately; infrastructure failures identifiable.', 'Only the rate is reported.', 'yes', 'Methods draft, Statistical Variance.'),
    choice('uncertainty', 'Uncertainty procedure', [['wilson', 'Wilson 95% interval'], ['exact', 'Exact binomial'], ['bootstrap', 'Family bootstrap'], ['descriptive', 'Descriptive tables only']], 'wilson', 'LeanBench audit report: Wilson intervals throughout; hypotheses used exact tests and exact binomial bounds.'),
    yesno('family-units', 'Related variants keep their family identity', 'Repetitions and related variants are not treated as independent observations; dependence handling is fixed before inspection.', 'Every draw is independent.', 'yes', 'Methods draft; the app refuses designs without family units for the bootstrap.'),
    yesno('separation', 'Exploratory, confirmatory and qualification records kept apart', 'Exploratory arms, pilots and qualification cohorts are reported separately from the main cohort unless their inclusion was specified in advance.', 'Cohorts may be pooled.', 'yes', 'LeanBench: the arm is exploratory, the clean-room runs are its confirmation; the app binds purpose in the journal.'),
    yesno('resources', 'Resource measurements recorded separately', 'Generation time, engine time, latency, tokens and tool calls are separate measurements; retries stay in the resource record; provider-reported and estimated cost are distinguished and an unavailable cost is never zero.', 'Resources are not measured.', 'yes', 'Methods draft, Resource Measurements; subscriptions leave per-call cost unavailable.'),
    choice('subsets', 'Primary subsets are defined', [['metadata', 'From prompt metadata only, never by an outcome'], ['outcome-secondary', 'Outcome-conditioned subsets allowed as secondary analyses only']], 'metadata', 'Legacy decision log 7: conditioning a primary subset on an outcome turns the result into a tautology.'),
    yesno('deviations', 'Deviations logged with reasons', 'Any change to a pre-registered decision after collection starts is logged with its reason; threats and mitigations are enumerated in the report.', 'Deviations need no log.', 'yes', 'LeanBench audit: four deviations logged in results/deviations.md.'),
    choice('formal-claims', 'Formal claims', [['computed', 'Computed or omitted: a formalism earns its place only if it computes from the graded draws'], ['narrative', 'Narrative allowed']], 'computed', 'LeanBench 2026-08-26: the obstruction section stays only if it computes; the modulus claim needs fitted rates or comes out.'),
  ] },
  { id: 'audit', title: 'External judge audit', intro: 'Only when the study audits another benchmark\'s ground truth or judge.', fields: [
    yesno('audit-included', 'A judge audit is part of the study', 'A frozen source study\'s judge is compared with a declared reference criterion.', 'No judge audit.', 'yes', 'LeanBench: the QuantCode-Bench audit, pre-registered 2026-07-12.'),
    number('refs-k', 'Independent references per task', 'references', 3, 'LeanBench audit D4: three strict-fidelity implementations from fresh contexts, each with an explicit assumptions list; cross-model convergence is stronger than same-model.', { min: 1 }),
    choice('determinacy', 'Determinacy criterion', [['unanimous', 'All references agree; two of three adjudicate the dissenter'], ['majority', 'Majority']], 'unanimous', 'LeanBench: 3/3 agreement; the pilot-20 redone under the full-census criterion.'),
    choice('repair', 'Reference repairs', [['one-round', 'One repair round, only for an implementation that contradicts explicit spec text'], ['unlimited', 'Repairs until convergence']], 'one-round', 'LeanBench audit D4 classification rule.'),
    yesno('canonical-defaults', 'Canonical environment defaults fixed before references', 'Bench-canonical defaults (sizing, exits, one position, warm-up) are fixed so determinacy measures whether the spec pins behavior, not whether implementers share conventions.', 'Implementers choose defaults.', 'yes', 'LeanBench audit D4a, recorded before Phase 2 began.'),
    list('ambiguity-taxonomy', 'Pre-registered ambiguity classes', ['unpinned-sizing', 'unpinned-indicator-params', 'unpinned-entry-trigger', 'unpinned-exit', 'orphaned-price-levels', 'timeframe-mismatch', 'goal-directed', 'external-data-required', 'multi-asset-required', 'other'], 'LeanBench audit D5: one or more classes per indeterminate task, fixed before any reference was drafted so results could not be shaped post hoc.', 'One class per line'),
    yesno('judge-replication', 'The audited judge is replicated verbatim', 'Prompt template, parsing rules, gate order and fallbacks reproduced exactly; every deviation (model family, unpinned temperature) disclosed.', 'An equivalent judge is acceptable.', 'yes', 'LeanBench audit D8: judge errors scored as the source scores them and flagged.'),
    number('stability', 'Stability re-judgements per spot-checked candidate', 'repeats', 3, 'LeanBench audit D8: ten random judged candidates re-judged three times; 0 of 30 flips.', { min: 1 }),
    yesno('paid-budget', 'Paid judging runs under a hard budget', 'Serialized requests, a reservation written before each request, a run-once lock, no automatic resume after a paid attempt, prices re-checked before execution, no cache writes.', 'Paid calls run freely.', 'yes', 'LeanBench rejudge: at most 12 requests and $2, reservations never recycled.'),
  ] },
  { id: 'ops', title: 'Operational rules learned the hard way', intro: 'Each of these was a failure once; as a rule it is a setting.', fields: [
    choice('decoding-contract', 'When a model rejects the pinned decoding parameters', [['lower-tier', 'Run the tier where the parameter contract holds and disclose that the frontier is unavailable on the protocol\'s terms'], ['drop-pin', 'Drop the pin for those models and disclose it'], ['exclude', 'Exclude those models']], 'lower-tier', 'Completion plan: frontier models returned HTTP 400 for temperature=0 and max_tokens; a study whose determinism control is a pinned parameter cannot hold it across that lineup.'),
    yesno('quota-attrition', 'Quota and rate limits stop the lane', 'A 429, an exhausted quota or a depleted balance stops the lane, quarantines the row and retries after recovery; stranded "started" rows are cleared, never scored.', 'Rate-limited rows are scored as failures.', 'yes', 'Completion plan: 54 rows stranded in status started; 31% of one model\'s rows.'),
    yesno('auth-outage', 'An auth outage is read off the data', 'A revoked token makes every draw return in seconds with no text; failure evidence per row makes that visible, and a catch-up queue reruns the registered order after re-authentication.', 'Blank lanes are read as model behavior.', 'yes', 'LeanBench 2026-08-29/30: whole codex lanes read as "never worked" until the token was renewed.'),
    yesno('safe-paths', 'Configuration paths written as forward slashes, never through a heredoc', 'A shell heredoc once collapsed backslashes so the account home pointed nowhere and every status call answered "Not signed in".', 'Any path style.', 'yes', 'LeanBench cloud collection 2026-08-25.'),
    yesno('single-parse', 'Each response is parsed once', 'A collector parses the diff or the raw text, never both; phantom duplicates are a defect.', 'Double parsing is tolerated.', 'yes', 'LeanBench corpus quarantine: 804 phantom rejects.'),
    yesno('safe-ids', 'File names cannot collide across prompts', 'Quote-like characters in prompt ids map to distinct safe names; resume is keyed by hash.', 'Ids are stripped freely.', 'yes', 'LeanBench: BL-02b\' once collided with BL-02b and the resume silently skipped it.'),
    yesno('data-coverage', 'Pre-run data-coverage assertion', 'Before any run, the data the tasks need is asserted present and the engine\'s failed-data requests are parsed into the runtime stage.', 'Data coverage is assumed.', 'yes', '2026-09-04 audit: missing market data invalidated every v2 result.'),
    yesno('version-bump', 'Any scoring-affecting change bumps the version stamp', 'Two halves of a grid must never carry one version stamp across a harness change.', 'Versions change on release only.', 'yes', '2026-09-04 audit: a mid-experiment harness change under the same stamp.'),
    yesno('visible-input-frozen', 'What the model sees is frozen and recorded', 'A hidden schema or context is never disclosed in one build and hidden in another; the visible input is part of the frozen study.', 'Context may vary between builds.', 'yes', '2026-09-04 audit: an earlier build disclosed the hidden schema in the user message.'),
    yesno('docs-current', 'Documentation describes the system that exists', 'Retired tools and shims are documented as retired; a stale README is a defect.', 'Documentation may lag.', 'yes', '2026-09-04 audit issue 10.'),
  ] },
])

// Where each rule came from. A ruling is the owner's, in the owner's words in
// the decisions of record or an arm manifest; a measured rule is an instrument
// change an agent made after a counted failure; a registry rule came in with
// the PIN-v5 vetting-council artifacts the owner kept when the process was set
// aside; a proposal is a marker or an audit finding nobody decided; an
// assumption is something an agent attributed to the owner or ran with while a
// question stayed open.
export const ORIGIN_LABELS = Object.freeze({ owner: 'Your ruling', measured: 'Rule from a measured failure', registry: 'Council-era registry', proposal: 'Open proposal', assumed: 'Agent assumption' })
const ORIGIN = {
  'study-kind': ['owner', 'Decisions of record 2026-08-21: the August arm is the exploratory study; the clean-room runs are its confirmation.'],
  'hypotheses-first': ['owner', '2026-08-21: write a one-page list of the hypotheses and commit it first; no registration theater.'],
  'scope-closed': ['owner', '2026-08-23: SCOPE IS CLOSED; 2026-08-25: reopened for the options arm as an additive extension.'],
  'push-daily': ['measured', 'EVIDENCE-PROVENANCE.md: an agent\'s standing rule after finding no public push between 2026-07-16 and 2026-08-28.'],
  'keep-everything': ['owner', '2026-08-21: nothing gets thrown away; nothing is deleted; the history is sealed, not erased.'],
  'dated-amendments': ['registry', 'PIN-v5 §6/§8.2 rule in CODEBOOK-HASHES.txt; one amendment ratified by you on 2026-08-26.'],
  'owner-gates': ['owner', '2026-08-21: still yours to say: "release the 53" and "go scale-up"; the audit and the new prompt batch parked until your word.'],
  'approval-loop': ['assumed', '2026-08-31 handoff, written by an agent as your rule; your words are not in the file.'],
  'input-shape': ['measured', 'Lane-Equivalence Protocol and METHODS-SOURCES.md, an agent\'s verification pass of how the field accesses each vendor.'],
  'system-line': ['assumed', 'HYPOTHESES.md A2, an agent design; you approved the small API spend, not the line.'],
  'max-turns': ['assumed', 'RUN-MANIFEST-2: single turn kept, a salvage pass proposed and awaiting your word.'],
  'frozen-hash': ['measured', 'generate.js FROZEN PROMPT MISMATCH, an agent instrument.'],
  'noask': ['owner', '2026-08-19: "I am okay with using the LiveCodeBench line."'],
  'noask-text': ['owner', 'The LiveCodeBench line you picked, verbatim (RUN-MANIFEST-2).'],
  'conditions': ['owner', 'The don\'t-ask arm you ordered on 2026-08-19 beside the vendor-default baseline.'],
  'growth-rule': ['owner', '2026-08-21: only through your sentence-atom mechanical system, and only after you personally review the prompts and their fair-reading sets.'],
  'admission-gate': ['owner', '2026-08-21: BL-02a and BL-09a/b stay killed; BL-06 and OM-A stay out; BL-02b\' stays refrozen.'],
  'fair-readings': ['assumed', 'FAIR-READINGS.md was drafted by an agent; the review gate was read as satisfied by "you already have everything you need from me".'],
  'cleanroom': ['owner', '2026-08-21: "Rule forever: no model generation without a same-day passed canary test in the C:\\lbres clean room."'],
  'canary-required': ['owner', 'Same ruling: "The runner refuses otherwise."'],
  'canary-cadence': ['measured', 'canary.js header: run before (and after) every batch; an agent\'s instrument rule.'],
  'canary-scope': ['owner', 'QUESTIONS-FOR-JOSH 2, ratified 2026-08-26 with "ok".'],
  'canary-sides': ['measured', 'canary.js: a crashed or empty output is FAIL, never clean (the 2026-08-21 lesson).'],
  'certificate': ['measured', 'generate.js shipCertificate after the 2026-08-29 EBUSY race.'],
  'env-allowlist': ['measured', 'cleanroom/ENV-MANIFEST.json, written by the agent that certified the room.'],
  'isolation-record': ['registry', 'gen_drivers.js isolationRecord, PIN-v5 §7 hygiene (vetting council round 1).'],
  'funding': ['owner', '2026-08-21: "Money: subscriptions only ... Nothing metered without your word."'],
  'direct-cli': ['owner', '2026-08-26 caution, recorded as a standing rule.'],
  'second-home': ['measured', 'canary.js LB_CODEX_HOME_NAME, an agent addition on 2026-08-25.'],
  'exact-ids': ['owner', 'MODELS.md: your directive of 2026-08-26 to pin the models; the quarantine mechanism is the agent\'s.'],
  'models': ['owner', '2026-08-26: use what LEAN-Bench used, "that\'s essentially all we have available".'],
  'surfaces': ['measured', 'HYPOTHESES.md A2 and H6, an agent design of the legs; you approved the API spend.'],
  'symmetric': ['measured', 'METHODS-SOURCES.md, an agent\'s verification of field practice.'],
  'efforts': ['owner', '2026-08-19: "all effort levels" across the models.'],
  'argv-record': ['measured', 'gen_drivers envelope v2, and failureEvidence after 765 unreadable rows.'],
  'no-shell': ['registry', 'PIN-v5 §7 (vetting council round 1).'],
  'output-cap': ['measured', 'generate.js 2026-08-28: 15 of 113 options draws truncated at 32,000.'],
  'draw-timeout': ['measured', 'generate.js 2026-08-27: 46 of 66 sonnet draws died at exactly 1,200,000 ms.'],
  'served-model': ['measured', 'lattice-arm-gen.js: gemini pinning broken; MODELS.md cloud rule.'],
  'dead-surface': ['proposal', 'QUESTIONS-FOR-JOSH 1: the agent\'s lean was (d); no answer in the files.'],
  'quota-order': ['owner', '2026-08-21: quota ordering is scheduling, never a design change; 2026-08-28: "do it in order though".'],
  'lane-order': ['assumed', 'arm-o1-parity-queue.sh, an agent\'s encoding of your 2026-08-28 order.'],
  'in-flight': ['assumed', 'arm-o1-resume.js calls 10 "the owner\'s ceiling, 2026-08-27"; your words are not in the files.'],
  'per-cell': ['measured', 'arm-o1-resume.js, an agent design.'],
  'engine-workers': ['measured', 'engine-start.sh: LEAN at 2 workers measured no clean gain and doubled machine load.'],
  'drop-concurrency': ['owner', '2026-08-21: "Concurrency that causes any issue is dropped, not debugged."'],
  'single-entry': ['measured', 'engine-start.sh after three double-launch collisions.'],
  'cloud-one-task': ['measured', 'cloud-lane.js, an agent design.'],
  'cloud-attempts': ['measured', 'The cloud lanes as run; MODELS.md cloud rule.'],
  'statuses': ['registry', 'CODEBOOK-v2 §E (vetting council, 2026-08-16).'],
  'fairness': ['owner', '2026-08-21: "Your fairness rule: draws where the model never finished do not count and are retried; everything is kept on disk regardless."'],
  'provider-notices': ['measured', 'generate.js 2026-08-27: 59 of 62 sonnet draws were a session-limit notice banked as observations.'],
  'shape-test': ['measured', 'generate.js 2026-08-28: three literal patterns missed a real block in turn; codex low exempted after a real observation was flagged.'],
  'truncation': ['measured', 'generate.js 2026-08-28.'],
  'resume-key': ['measured', 'generate.js 2026-08-22 and 2026-08-23.'],
  'batch-pooling': ['measured', 'arm-o1-resume.js after the 2026-08-23 midnight rollover.'],
  'engine-retry': ['measured', 'grade-o1.py outcome(), measured against the bank ledger 2026-08-29.'],
  'late-response': ['proposal', 'Methods draft [DECISION]: freeze retry eligibility and late-response handling.'],
  'unreachable': ['measured', 'batches/cloud/COLLECTION-2026-08-25.md.'],
  'cleanup-nonfatal': ['measured', 'generate.js 2026-08-27: 25 of 26 concurrent cells crashed on cleanup.'],
  'cell-factors': ['assumed', 'The arm design as run (RUN-MANIFEST); never stated as a rule.'],
  'n-eligible': ['owner', '2026-08-21: "The cells the paper leans on get 30+ draws each in the clean room."'],
  'n-anchor': ['assumed', 'QUESTIONS-FOR-JOSH 3: "Assumption I\'m running with" (anchors 20); no answer in the files.'],
  'n-donor': ['assumed', 'QUESTIONS-FOR-JOSH 3 (donor and pins 10); no answer in the files.'],
  'n-exploratory': ['owner', '2026-08-21: "the old n=10 counts as exploratory".'],
  'completion': ['measured', 'arm-o1-status.py, an agent instrument.'],
  'overdraw': ['measured', 'MODELS.md amendment, an agent note.'],
  'tests': ['assumed', 'HYPOTHESES.md is marked "DRAFT for owner review"; no approval is in the files.'],
  'grader': ['registry', 'The README and the PIN-v5 bank (council era); you imported the bank re-verified on 2026-08-21.'],
  'bank-method': ['registry', 'bank_spec.py v2 (vetting council round 1).'],
  'matching': ['registry', 'CODEBOOK-v2 §B and the cross-tuple rule of 2026-08-16.'],
  'extractor-role': ['registry', 'CODEBOOK-v2 §4.4 and §4.7.'],
  'bank-verify': ['registry', 'verify_bank.py and the PROVENANCE import check.'],
  'execution-control': ['registry', 'grade.py --control and --stride (PIN-v5 §4.4 and §4.6).'],
  'stride': ['registry', 'grade.py --stride.'],
  'data-freeze': ['registry', 'DATA-FREEZE-2026-08-15.md (PIN-v5 §4.6.4).'],
  'freeze-change': ['registry', 'The same record.'],
  'engine-pins': ['measured', 'bank_runner.py and the 2026-09-11 SETUP-PLAN, both agent records.'],
  'engine-timeout': ['measured', 'DATA-FREEZE: runner timeout 600 s per backtest.'],
  'completion-detect': ['registry', 'bank_runner.py v2.'],
  'bank-gate': ['proposal', 'bank-staging README 2026-08-30, an agent-written gate awaiting your authorization.'],
  'extraction': ['registry', 'gen_drivers.js ONE rule (vetting council round 1).'],
  'ask-rule': ['measured', 'bench-grade.py header; you validated the classifier\'s calls on 2026-08-23.'],
  'refusals': ['owner', '2026-08-23: classified TOGETHER "with his explicit approval".'],
  'pass-def': ['proposal', 'Methods draft, Evaluation Methods, an agent\'s proposal.'],
  'infra-not-model': ['proposal', '2026-09-04 audit issue 7.'],
  'no-best-of-k': ['proposal', '2026-09-04 audit issue 8.'],
  'strict-and': ['proposal', '2026-09-04 audit issues 4 and 4b.'],
  'judge-threshold': ['registry', 'Legacy decision log 3, the v1.0 harness.'],
  'judge-pool': ['proposal', '2026-09-04 audit issue 2.'],
  'hitl': ['registry', 'Legacy decision log 5; built and never run.'],
  'stage-instrumentation': ['proposal', '2026-09-04 audit issue 5.'],
  'primary-measure': ['proposal', 'Methods draft: "the proposed primary measure".'],
  'counts-reported': ['proposal', 'Methods draft, Statistical Variance.'],
  'uncertainty': ['measured', 'Audit REPORT: Wilson intervals throughout; HYPOTHESES exact tests.'],
  'family-units': ['proposal', 'Methods draft [DECISION] on dependence handling.'],
  'separation': ['owner', '2026-08-21: the arm is exploratory; the clean-room runs are its confirmation.'],
  'resources': ['proposal', 'Methods draft, Resource Measurements.'],
  'subsets': ['registry', 'Legacy decision log 7.'],
  'deviations': ['measured', 'Audit PLAN and REPORT deviations log, an agent practice.'],
  'formal-claims': ['owner', '2026-08-26: "WE NEED TO DO THIS"; if it computes it is a result, otherwise plain language.'],
  'audit-included': ['owner', '2026-08-21: all three legs run (lattice, audit, benchmark).'],
  'refs-k': ['owner', '2026-08-21: three AIs, one per family; k=3 per task is the audit plan\'s D4.'],
  'determinacy': ['owner', '2026-08-21: determinacy checked by three AIs; 2/3 adjudicate (HYPOTHESES C).'],
  'repair': ['measured', 'Audit PLAN D4, pre-registered by the agent on 2026-07-12.'],
  'canonical-defaults': ['measured', 'Audit PLAN D4a.'],
  'ambiguity-taxonomy': ['measured', 'Audit PLAN D5.'],
  'judge-replication': ['measured', 'Audit PLAN D8.'],
  'stability': ['measured', 'Audit PLAN D8.'],
  'paid-budget': ['measured', 'Rejudge README, an agent\'s budget rules.'],
  'decoding-contract': ['proposal', 'COMPLETION-PLAN 1a and 13, an agent recommendation.'],
  'quota-attrition': ['measured', 'generate.js provider-blocked; COMPLETION-PLAN 1c.'],
  'auth-outage': ['measured', 'arm-o1-codex-catchup.sh, 2026-08-30.'],
  'safe-paths': ['measured', 'COLLECTION-2026-08-25 failure 2.'],
  'single-parse': ['measured', 'corpus/quarantine README, 2026-08-23.'],
  'safe-ids': ['measured', 'generate.js 2026-08-22.'],
  'data-coverage': ['proposal', '2026-09-04 audit Phase 0.'],
  'version-bump': ['proposal', '2026-09-04 audit issue 3.'],
  'visible-input-frozen': ['proposal', '2026-09-04 audit issue 3.'],
  'docs-current': ['proposal', '2026-09-04 audit issue 10.'],
}

// Settings are repeatable features: they carry LeanBench's value as a default
// that a study may change. Decisions carry no default; they are undecided
// until decided, and the frozen text names the undecided ones.
const SETTINGS = new Set(['cleanroom', 'canary-required', 'canary-cadence', 'canary-scope', 'canary-sides', 'certificate', 'env-allowlist', 'isolation-record', 'funding', 'direct-cli', 'second-home',
  'exact-ids', 'efforts', 'argv-record', 'no-shell', 'output-cap', 'draw-timeout', 'served-model', 'dead-surface',
  'quota-order', 'in-flight', 'per-cell', 'engine-workers', 'drop-concurrency', 'single-entry', 'cloud-one-task', 'cloud-attempts',
  'statuses', 'fairness', 'provider-notices', 'shape-test', 'truncation', 'resume-key', 'batch-pooling', 'engine-retry', 'late-response', 'unreachable', 'cleanup-nonfatal',
  'n-eligible', 'n-anchor', 'n-donor', 'n-exploratory', 'completion', 'overdraw',
  'bank-verify', 'execution-control', 'stride', 'engine-pins', 'engine-timeout', 'completion-detect',
  'extraction', 'infra-not-model', 'no-best-of-k', 'strict-and', 'stage-instrumentation',
  'decoding-contract', 'quota-attrition', 'auth-outage', 'safe-paths', 'single-parse', 'safe-ids', 'data-coverage', 'version-bump', 'visible-input-frozen', 'docs-current'])

// These old entries describe values already authored elsewhere. Keep their
// schema so saved drafts remain readable, but do not offer a second editor,
// seed them from an example, count them as decisions or freeze them as rules.
export const PROTOCOL_MANAGED_FIELDS = Object.freeze({
  'input-shape': 'Prompt design and Systems and conditions',
  'system-line': 'Prompt design and the selected collection adapter',
  noask: 'Prompt design',
  'noask-text': 'Prompt design',
  conditions: 'Systems and conditions',
  models: 'Pipeline models and Systems and conditions',
  surfaces: 'Pipeline surfaces and Systems and conditions',
  efforts: 'Pipeline efforts and Systems and conditions',
  'draw-timeout': 'Schedule and budgets: Attempt timeout (seconds)',
  'n-eligible': 'Schedule and budgets: Replicates',
  grader: 'Scoring',
  'approval-loop': 'Require current bundle and task reviews before freezing',
  'engine-pins': 'Environment and dependency pins',
  'visible-input-frozen': 'Prompts byte-frozen and hash-verified per draw',
})

export const PROTOCOL_FIELDS = Object.freeze(PROTOCOL_REGISTRY.flatMap(section => section.fields.map(field => {
  const [origin, source] = ORIGIN[field.id] || ['proposal', 'No source recorded.']
  return { ...field, section: section.id, setting: SETTINGS.has(field.id), origin, source, managedBy: PROTOCOL_MANAGED_FIELDS[field.id] || null }
})))
const FIELD_BY_ID = new Map(PROTOCOL_FIELDS.map(field => [field.id, field]))
export const protocolField = id => FIELD_BY_ID.get(id) || null
export const PROTOCOL_SECTIONS = Object.freeze(PROTOCOL_REGISTRY.map(section => ({ ...section, fields: section.fields.filter(field => !PROTOCOL_MANAGED_FIELDS[field.id]) })).filter(section => section.fields.length))
export const DECISION_FIELDS = Object.freeze(PROTOCOL_FIELDS.filter(field => !field.setting && !field.managedBy))
export const SETTING_FIELDS = Object.freeze(PROTOCOL_FIELDS.filter(field => field.setting && !field.managedBy))
export const previousProtocolEntries = state => PROTOCOL_FIELDS.filter(field => field.managedBy && state.values[field.id] !== undefined).map(field => ({ field, value: state.values[field.id] }))

export function emptyProtocolDecisions() { return { version: 1, values: {}, notes: '' } }

const trimmed = value => String(value ?? '').trim()
export function normalizeValue(field, raw) {
  if (raw === undefined || raw === null) return undefined
  switch (field.kind) {
    case 'choice': { const value = trimmed(raw); return field.options.some(([id]) => id === value) ? value : undefined }
    case 'yesno': return raw === 'yes' || raw === true ? 'yes' : raw === 'no' || raw === false ? 'no' : undefined
    case 'number': { const value = Number(raw); if (trimmed(raw) === '' || !Number.isFinite(value)) return undefined; return value }
    case 'text': case 'note': { const value = trimmed(raw); return value ? value.slice(0, 4000) : undefined }
    case 'list': { const items = (Array.isArray(raw) ? raw : String(raw).split('\n')).map(trimmed).filter(Boolean).slice(0, 64); return items.length ? items : undefined }
    default: return undefined
  }
}

// Anything stored is filtered through the registry: unknown ids and malformed
// values drop, so an old draft never carries a value the form cannot show.
export function normalizeProtocolDecisions(raw) {
  const state = emptyProtocolDecisions()
  if (!raw || typeof raw !== 'object') return state
  for (const [id, value] of Object.entries(raw.values || {})) {
    const field = FIELD_BY_ID.get(id); if (!field) continue
    const normalized = normalizeValue(field, value)
    if (normalized !== undefined) state.values[id] = normalized
  }
  state.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 20000) : ''
  return state
}

export const isDecided = (state, id) => state.values[id] !== undefined
// A setting always has a value: the study's own, or the default.
export const effectiveValue = (state, field) => state.values[field.id] !== undefined ? state.values[field.id] : field.setting ? structuredClone(field.lb) : undefined
export const atDefault = (state, field) => field.setting && (state.values[field.id] === undefined || JSON.stringify(state.values[field.id]) === JSON.stringify(field.lb))
export function decidedCount(state, sectionId = null) {
  const fields = DECISION_FIELDS.filter(field => !sectionId || field.section === sectionId)
  return { decided: fields.filter(field => isDecided(state, field.id)).length, total: fields.length }
}
export function settingsCount(state, sectionId = null) {
  const fields = SETTING_FIELDS.filter(field => !sectionId || field.section === sectionId)
  return { changed: fields.filter(field => !atDefault(state, field)).length, total: fields.length }
}

export function leanBenchValues(sectionId = null, origins = null) {
  return Object.fromEntries(PROTOCOL_FIELDS.filter(field => !field.managedBy && (!sectionId || field.section === sectionId) && (!origins || origins.includes(field.origin))).map(field => [field.id, structuredClone(field.lb)]))
}
export function withLeanBench(state, sectionId = null, { onlyUndecided = false, origins = null } = {}) {
  const next = normalizeProtocolDecisions(state)
  for (const [id, value] of Object.entries(leanBenchValues(sectionId, origins))) if (!onlyUndecided || !isDecided(next, id)) next.values[id] = value
  return next
}
// Take only the owner's own rulings, in every section or one.
export const withRulings = (state, sectionId = null) => withLeanBench(state, sectionId, { origins: ['owner'] })
export function withoutSection(state, sectionId = null, { settingsToo = true } = {}) {
  const next = normalizeProtocolDecisions(state)
  for (const field of PROTOCOL_FIELDS) if (!field.managedBy && (!sectionId || field.section === sectionId) && (settingsToo || !field.setting)) delete next.values[field.id]
  return next
}

export function valueText(field, value) {
  if (value === undefined) return ''
  switch (field.kind) {
    case 'choice': return field.options.find(([id]) => id === value)?.[1] || String(value)
    case 'yesno': return value === 'yes' ? field.yes : field.no
    case 'number': return `${Number(value).toLocaleString()} ${field.unit}`
    case 'list': return value.join('; ')
    default: return String(value)
  }
}

// The frozen decisions text: settings always (marked when at their default),
// decisions when decided, the study's own notes, then the names of every
// decision still undecided.
export function decisionsText(state, { includeManaged = false } = {}) {
  const current = normalizeProtocolDecisions(state)
  const blocks = [], undecided = []
  for (const section of includeManaged ? PROTOCOL_REGISTRY : PROTOCOL_SECTIONS) {
    const lines = []
    for (const field of section.fields) {
      const full = FIELD_BY_ID.get(field.id)
      if (full.setting) lines.push(`- ${field.label}: ${valueText(full, effectiveValue(current, full))}${atDefault(current, full) ? ' (default)' : ''}`)
      else if (isDecided(current, field.id)) lines.push(`- ${field.label}: ${valueText(full, current.values[field.id])}`)
      else undecided.push(field.label)
    }
    if (lines.length) blocks.push(`${section.title}\n${lines.join('\n')}`)
  }
  const notes = current.notes.trim()
  // Nothing decided and every setting at its default: the text is the notes
  // alone, so a draft written before this page existed freezes exactly what
  // it always did.
  if (!Object.keys(current.values).some(id => includeManaged || !FIELD_BY_ID.get(id).managedBy)) return notes
  const parts = ['DECISIONS OF RECORD\n\n' + blocks.join('\n\n')]
  if (notes) parts.push('NOTES\n\n' + notes)
  if (undecided.length) parts.push(`NOT YET DECIDED (${undecided.length})\n${undecided.join('; ')}`)
  return parts.join('\n\n')
}

// Recognize a previously generated record without turning its retired fields
// into freeform notes. Handwritten decisions still keep the existing path.
export function matchesDecisionsText(state, text) {
  const legacy = decisionsText(state, { includeManaged: true })
  return text === decisionsText(state) || text === legacy || text === legacy
    .replace('Yes: append the no-ask instruction below to the prompt, identically across models and lanes.', 'A registered instruction is appended to the prompt in one condition, byte-identical across models and lanes.')
    .replace('No: do not include a no-ask condition.', 'No instruction condition.')
}
