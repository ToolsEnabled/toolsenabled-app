// Protocol decisions of record. Every decision LeanBench had to make before a
// draw ran, as a field the next study decides again: the value LeanBench
// settled on is offered beside each field as an example, never applied
// silently. The reasons behind LeanBench's values are documented outside this
// page, so fields carry no reason text. The decided fields
// compose into the study's frozen decisions text (spec.decisions); undecided
// ones are listed there by name so the frozen text never implies a choice
// that was not made.
//
// Sources: the study's decisions of record, the clean-room and canary
// instruments, the codebook, the bank specification and data freeze, the model
// notes and run manifests, the cloud collection notes, the audit plan, the
// legacy decision log, and the methods draft's decision markers.

const choice = (id, label, options, lb) => ({ id, label, kind: 'choice', options, lb })
const yesno = (id, label, yes, no, lb) => ({ id, label, kind: 'yesno', yes, no, lb })
const number = (id, label, unit, lb, extra = {}) => ({ id, label, kind: 'number', unit, lb, ...extra })
const text = (id, label, lb, placeholder = '') => ({ id, label, kind: 'text', lb, placeholder })
const note = (id, label, lb, placeholder = '') => ({ id, label, kind: 'note', lb, placeholder })
const list = (id, label, lb, placeholder = '') => ({ id, label, kind: 'list', lb, placeholder })

const PROTOCOL_REGISTRY = Object.freeze([
  { id: 'scope', title: 'Study scope and registration', intro: 'What kind of study this is, what is fixed before the first draw, and what waits for the owner.', fields: [
    choice('study-kind', 'Kind of study', [['exploratory', 'Exploratory: small cells, findings feed a later confirmation'], ['confirmatory', 'Confirmatory: registered cells, hypotheses committed first'], ['apparatus', 'Apparatus check: unqualified computations, never scientific admission']], 'confirmatory'),
    yesno('hypotheses-first', 'Hypotheses committed before the confirmatory draws', 'A one-page hypotheses list is written and committed before the first confirmatory draw; no registration theater.', 'Hypotheses may be stated after the draws.', 'yes'),
    yesno('scope-closed', 'Scope closed once the design is registered', 'No new arms, conditions or dimensions without an owner ruling; additive extensions are recorded as such.', 'Scope stays open during collection.', 'yes'),
    yesno('push-daily', 'Every commit pushed the day it is made', 'A day with local commits and no push is a provenance defect and is reported as one.', 'Pushes happen when convenient.', 'yes'),
    yesno('keep-everything', 'Nothing is deleted', 'Superseded draws, quarantined rows and old history are kept, checksummed and disclosed; excluded rows stay recoverable.', 'Bad rows may be deleted.', 'yes'),
    yesno('dated-amendments', 'Governing artifacts hashed; changes are dated amendments', 'Prompts, codebook, bank specification and instruments are hashed pre-lock; any later change is a dated amendment with the prior hash kept, never a silent refresh.', 'Instruments may change without a record.', 'yes'),
    list('owner-gates', 'Actions that wait for the owner\'s word', ['Releasing the remaining draws of an arm', 'Scaling up to the confirmatory cell sizes', 'Any metered spend (subscriptions only otherwise)', 'Retiring or re-adding a lane', 'Growing the prompt set', 'A new arm, condition or dimension'], 'One action per line'),
    yesno('approval-loop', 'Owner approves every semantic snippet by content digest', 'The owner agrees semantics and adversarial examples before code, reviews wording and every lifecycle fragment line by line, then approves an exact content digest; any change makes the approval stale and the runner refuses unapproved dependencies.', 'Agents may admit snippets without owner review.', 'yes'),
  ] },
  { id: 'prompt', title: 'The prompt as input', intro: 'What the model receives, byte for byte, and how the prompt set may grow.', fields: [
    choice('input-shape', 'What the model receives', [['prompt-only', 'The frozen prompt only: single turn, no system prompt, no injections'], ['minimal-line', 'The frozen prompt plus one identical minimal system line for every vendor'], ['harness', 'The vendor-native harness layer, disclosed, with the frozen prompt']], 'harness'),
    text('system-line', 'System line for bare cells', 'Complete the task.', 'Leave empty for none'),
    number('max-turns', 'Turns per draw', 'turn', 1, { min: 1 }),
    yesno('frozen-hash', 'Prompts byte-frozen and hash-verified per draw', 'Every prompt carries a SHA-256; a draw refuses on a hash mismatch and records the hash it sent.', 'Prompts are read from the working copy.', 'yes'),
    yesno('noask', 'A no-ask condition is included', 'Yes: append the no-ask instruction below to the prompt, identically across models and lanes.', 'No: do not include a no-ask condition.', 'yes'),
    text('noask-text', 'The no-ask instruction, verbatim', 'You will NOT return anything except for the program.'),
    list('conditions', 'Prompt conditions', ['base', 'noask'], 'One condition per line'),
    choice('growth-rule', 'How the prompt set may grow', [['mechanical-reviewed', 'Only through the mechanical atom system, and only after the owner personally reviews the prompts and their fair-reading sets'], ['reviewed', 'Any source, after owner review'], ['free', 'Freely during the study']], 'mechanical-reviewed'),
    yesno('admission-gate', 'Degenerate and contaminated prompts are excluded before draws', 'A prompt whose answer bank shows one behavior class at every conditioning tuple is excluded (it cannot distinguish anything); a contaminated prompt is killed; a refrozen fix gets a new id.', 'Every prompt is drawn.', 'yes'),
    yesno('fair-readings', 'Each withheld atom has an owner-reviewed set of fair readings', 'Every void enumerates the concrete conventions a competent implementation could adopt; a supplied answer is judged against that set, not only the hidden original.', 'Readings are judged case by case.', 'yes'),
  ] },
  { id: 'cleanroom', title: 'Clean room and canary', intro: 'Where generation runs, what can reach it, and the test that proves the room is clean.', fields: [
    yesno('cleanroom', 'Generation runs in an instruction-bare clean room', 'A dedicated root with blank home directories, an allowlisted environment and a fresh empty working directory per draw; no instruction file reachable.', 'Generation runs in the working environment.', 'yes'),
    yesno('canary-required', 'No generation without a same-day passed canary', 'The generator refuses to spawn anything without today\'s canary certificate; no flag bypasses it.', 'The canary is advisory.', 'yes'),
    choice('canary-cadence', 'Canary cadence', [['batch', 'Before and after every batch, same UTC day'], ['day', 'Once per UTC day before generation'], ['study', 'Once per study']], 'batch'),
    choice('canary-scope', 'Canary scope', [['surface', 'Per surface: each surface generates only with its own same-day two-sided pass'], ['all', 'All-or-nothing: every surface must pass before any generates']], 'surface'),
    choice('canary-sides', 'What the canary proves', [['two-sided', 'Two-sided: a planted marker must fire, and a clean room must give a substantive silent answer'], ['one-sided', 'One-sided: the clean room stays silent']], 'two-sided'),
    yesno('certificate', 'The canary certificate ships beside every batch', 'Every lane writes the day\'s pass file into its batch folder; a certificate that cannot be shipped is fatal.', 'Certificates stay in the room.', 'yes'),
    list('env-allowlist', 'Environment variables allowed into a draw', ['SystemRoot', 'windir', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'COMSPEC'], 'One name per line'),
    yesno('isolation-record', 'An isolation record is kept per draw', 'Every ancestor profile file (CLAUDE.md, AGENTS.md, CODEX.md, GEMINI.md, .claude settings, .codex config) found and hashed; global profiles present; whether the working directory was empty.', 'No per-draw isolation record.', 'yes'),
    choice('funding', 'Funding fence', [['subscriptions', 'Subscriptions only: every billing and routing variable stripped from the child environment and the stripping recorded'], ['metered-approved', 'Metered API allowed for named cells with the owner\'s word'], ['metered', 'Metered API']], 'subscriptions'),
    yesno('direct-cli', 'Generation and collection never route through orchestration tools', 'Local draws go through the clean-room generator and cloud draws through the vendor CLI directly under an explicit home; never through a dispatch or routing system.', 'Orchestration tools may launch study draws.', 'yes'),
    yesno('second-home', 'A second account is a second clean-room home', 'Each account gets its own home holding only its credential, certified by the canary under its own label.', 'Accounts share a home.', 'yes'),
  ] },
  { id: 'surfaces', title: 'Surfaces, models, efforts', intro: 'Which systems answer, through which surface, with what recorded per draw.', fields: [
    yesno('exact-ids', 'Exact model ids only', 'Never a bare alias, never a newer model silently; a lane whose recorded model differs from the pin is quarantined, not graded.', 'Aliases and defaults are acceptable.', 'yes'),
    list('models', 'Pinned models', ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5', 'gemini-3.6-flash (bare Vertex only)'], 'One exact id per line'),
    list('surfaces', 'Surfaces', ['codex CLI (exec, read-only sandbox, ephemeral)', 'claude CLI (print mode, tools off, settings off)', 'bare OpenAI API', 'bare Vertex REST', 'claude near-bare (system prompt replaced)', 'codex cloud (one task per draw)'], 'One surface per line'),
    yesno('symmetric', 'Surfaces symmetric across vendors within a claim', 'A claim compares like with like: every vendor through its native CLI, or every vendor bare; a CLI-versus-bare delta is reported per family as the harness contribution.', 'Mixed surfaces may be compared.', 'yes'),
    list('efforts', 'Effort ladder', ['low', 'medium', 'high', 'xhigh', 'max'], 'One level per line'),
    yesno('argv-record', 'Exact invocation recorded per draw', 'CLI version, exact argv, raw stdout and stderr (tails masked for tokens), auth mode, served model from structural telemetry, tool events, wall time, isolation record and canary certificate name.', 'Only the response is kept.', 'yes'),
    yesno('no-shell', 'Children spawned without a shell', 'The argument vector reaches the child exactly; an argv self-test proves it.', 'Commands may go through a shell.', 'yes'),
    number('output-cap', 'Output token ceiling', 'tokens', 64000, { min: 1 }),
    number('draw-timeout', 'Per-draw timeout', 'minutes', 40, { min: 1 }),
    yesno('served-model', 'Served model recorded from structural telemetry', 'The model the provider reports (codex session_configured, claude modelUsage, gemini stats, Vertex modelVersion) is recorded per draw; analysis stratifies on it when pinning is not honoured.', 'The requested model is assumed served.', 'yes'),
    choice('dead-surface', 'When a provider retires a surface', [['document', 'Document the remaining cells as unrunnable by provider retirement; a legitimate finding'], ['substitute', 'Substitute another surface, labelled as its own surface, never spliced in']], 'document'),
  ] },
  { id: 'schedule', title: 'Scheduling, quota and concurrency', intro: 'The order lanes run in, how many run at once, and what a start refuses.', fields: [
    choice('quota-order', 'Quota ordering', [['cheapest-first', 'Scheduling only, never design: cheapest effort first, alternating models to spread quota'], ['registered', 'The registered lane order'], ['convenient', 'Whatever is convenient']], 'cheapest-first'),
    list('lane-order', 'Lane order of record', ['Core lanes first', 'Parity lanes serially, cheapest effort first, alternating models', 'Bare cells', 'Cloud attempts ladder last, launched manually'], 'One lane or group per line'),
    number('in-flight', 'Cells in flight at once', 'cells', 10, { min: 1 }),
    yesno('per-cell', 'Concurrency per cell, never within a cell', 'Each child owns its own lane file and per-draw temp directory, so two children cannot write the same row.', 'Draws within a cell may run concurrently.', 'yes'),
    number('engine-workers', 'Engine workers', 'workers', 1, { min: 1 }),
    yesno('drop-concurrency', 'Concurrency that causes any issue is dropped, not debugged', 'A race or crash under concurrency lowers the concurrency; the one exception (the certificate copy) was made race-safe under a dated amendment.', 'Concurrency issues are debugged in place.', 'yes'),
    yesno('single-entry', 'One entry point, no double starts', 'A start refuses if any study process is already running or the engine daemon does not answer; a pause kills by command-line match; everything is resume-safe.', 'Jobs may be launched ad hoc.', 'yes'),
    yesno('cloud-one-task', 'One cloud task per draw', 'A task asked for N programs yields N correlated outputs from one context, not N draws; launches run concurrently inside the quota window, collection later costs nothing, and a wave of failed launches aborts.', 'One task may return several draws.', 'yes'),
    list('cloud-attempts', 'Cloud attempts ladder', ['1', '2', '4', '8', '16'], 'One value per line'),
  ] },
  { id: 'draws', title: 'Draw statuses, retries and fairness', intro: 'What a draw can be, which ones count, and what happens to the rest.', fields: [
    list('statuses', 'Status vocabulary before matching', ['program', 'no-program', 'harness-error (transport, CLI or spawn failure; retried; never a model result)', 'harness-truncation (output ceiling hit, no program)', 'provider-blocked (quota, sign-in or rate-limit notice; never counted; always retried)', 'non-runnable (nonzero exit, timeout or runtime error; final)', 'EMPTY-TAPE', 'NO-IMPLEMENTATION'], 'One status per line'),
    yesno('fairness', 'Unfinished draws do not count and are retried', 'A draw the model never finished is excluded and redrawn; everything is kept on disk regardless.', 'Unfinished draws count as failures.', 'yes'),
    choice('provider-notices', 'Provider notices', [['never', 'Never observations: marked provider-blocked, the lane stops, rows are quarantined and redrawn after recovery'], ['no-program', 'Recorded as no-program']], 'never'),
    yesno('shape-test', 'A short, fast, program-less reply is a provider notice (claude)', 'Under 400 characters in under 60 seconds with no program is a notice whatever it says; codex and gemini rely on wording because a genuine low-effort draw finishes in 30–90 seconds.', 'Only wording is tested.', 'yes'),
    choice('truncation', 'Truncated responses', [['harness-error', 'Harness error: redrawn, never graded'], ['no-program', 'Graded as no-program']], 'harness-error'),
    choice('resume-key', 'Resume matches', [['hash', 'The prompt hash per row, never the index'], ['index', 'The row index']], 'hash'),
    choice('batch-pooling', 'Batch folders', [['pooled', 'Targets counted across all date folders; analysis selects one folder per cell; superseded folders kept and excluded'], ['single', 'One folder per lane']], 'pooled'),
    choice('engine-retry', 'Engine results retried', [['harness-error', 'Only harness errors: a non-zero exit with error text is the program failing and is final; without error text it is the harness flaking'], ['all', 'Every failure']], 'harness-error'),
    choice('late-response', 'Several responses for one trial', [['fixed-rule', 'A selection rule fixed before grading picks one; a completed answer is never replaced because another could score better'], ['best', 'The best available response']], 'fixed-rule'),
    yesno('unreachable', 'Unreachable is not data', 'A task queried under the wrong account, a sign-in notice or a path warning is unreachable: skipped and queued, never an envelope; per-cell distributions pass a magnitude smell test before grading.', 'Error text may be recorded as a response.', 'yes'),
    yesno('cleanup-nonfatal', 'Cleanup failure never kills a cell', 'The draw row is durably appended before cleanup; a locked temp directory costs a leftover folder and nothing else.', 'Cleanup errors abort the cell.', 'yes'),
  ] },
  { id: 'cells', title: 'Cells and sample sizes', intro: 'What a cell is, how many draws each gets, and how completion is judged.', fields: [
    list('cell-factors', 'A cell is crossed by', ['prompt', 'model', 'effort', 'condition', 'surface'], 'One factor per line'),
    number('n-eligible', 'Draws per eligible cell', 'draws', 30, { min: 1 }),
    number('n-anchor', 'Draws per anchor or control cell', 'draws', 20, { min: 1 }),
    number('n-donor', 'Draws per donor, placebo or pin cell', 'draws', 10, { min: 1 }),
    number('n-exploratory', 'Draws per exploratory cell', 'draws', 10, { min: 1 }),
    choice('completion', 'Completion is judged', [['cell', 'Cell by cell against the registration; a row total is not evidence a lane finished'], ['total', 'By lane row totals']], 'cell'),
    choice('overdraw', 'Overdrawn cells', [['kept', 'Kept as extra data; completion still judged against the registration'], ['trimmed', 'Trimmed to the target']], 'kept'),
    note('tests', 'Pre-stated tests and thresholds', 'One-sided exact test per model at alpha .05; exact binomial upper bounds where a rate is predicted to be zero; total-variation distance at or above 0.3 for a descent difference.'),
  ] },
  { id: 'truth', title: 'Answer key, data freeze and engine', intro: 'How a program is judged right, and what is frozen before the key exists.', fields: [
    choice('grader', 'What grades a program', [['mechanical', 'A mechanical answer key: the program executes in a pinned engine and is compared to a precomputed, hash-verified oracle bank; no language model grades anything'], ['judge-diagnostic', 'The mechanical key, with a language-model judge as a separate diagnostic that never overrides it'], ['judge', 'A language-model judge']], 'mechanical'),
    yesno('bank-method', 'The answer bank is built from registered degrees of freedom', 'One completely pinned donor; every free implementation choice registered with its levels, reference first; full factorial inside the conditioning set; one-at-a-time runs plus a spot check for every excluded choice; classes pre-registered with absorption priority; counts derived in code.', 'The answer key is a single reference program.', 'yes'),
    choice('matching', 'Matching a program to the bank', [['tuple-free', 'Tuple-free: the projection is matched against every registered oracle run; none is DRIFT; several across tuples is AMBIGUOUS, never a picked winner'], ['nearest', 'Nearest match']], 'tuple-free'),
    choice('extractor-role', 'The code extractor', [['never-gates', 'Never gates matching: it feeds a validity report and the numeric codes; anything it cannot decide is unresolved, never a guess'], ['decides', 'Decides the code']], 'never-gates'),
    yesno('bank-verify', 'Bank integrity verified at import and per run', 'Source copy equals manifest, the in-container nonce equals the source nonce, parameters equal the job; each run records data hash, engine image digest, CLI version, git revision, source hash, exit code and a completion marker; stale or partial outputs are refused.', 'The bank is trusted as built.', 'yes'),
    yesno('execution-control', 'Positive controls run through the grader', 'Oracle runs graded through the grader must code to their own reading; every 25th draw per stratum runs twice and a differing tape raises a nondeterminism flag.', 'No execution control.', 'yes'),
    number('stride', 'Re-execution stride', 'draws', 25, { min: 1 }),
    yesno('data-freeze', 'Data frozen before the bank runs', 'Window, tickers, resolution, vendor and provenance, adjustment policy, per-file SHA-256 and an aggregate hash are recorded first; the runner verifies the aggregate before any engine run.', 'Data may be refreshed during the study.', 'yes'),
    choice('freeze-change', 'Changing frozen data after lock', [['rerun-all', 'Requires re-running and re-hashing the entire bank with an appendix record'], ['partial', 'Affected cells only']], 'rerun-all'),
    list('engine-pins', 'Engine pins', ['LEAN image digest', 'lean CLI version', 'engine build number', 'container Python version', 'per-backtest timeout', 'worker count'], 'One pin per line'),
    number('engine-timeout', 'Per-backtest timeout', 'seconds', 600, { min: 1 }),
    choice('completion-detect', 'Run completion is detected from', [['result', 'The result JSON or log; a zero-order run is an empty tape, never "not run" and never "ok" by file presence'], ['files', 'Output file presence']], 'result'),
    yesno('bank-gate', 'Bank execution needs independent review and explicit owner authorization', 'An approval selects a rerun but does not authorize it; a content-addressed implementation and data freeze are independently reviewed, then the owner authorizes engine execution.', 'The bank runs when ready.', 'yes'),
  ] },
  { id: 'grading', title: 'Grading and classification', intro: 'The rules that turn a response into a code.', fields: [
    choice('extraction', 'Program extraction', [['one-rule', 'One rule for every surface: the largest fenced block naming the algorithm class, else the largest fence, else raw text declaring the class'], ['per-surface', 'Per-surface rules']], 'one-rule'),
    note('ask-rule', 'Ask rule', 'A draw with no extractable program counts as asks-clarifying if its text ends with a question mark or states a need naming the withheld quantity; empty text is unfinished and retried.'),
    choice('refusals', 'Refusals and questions', [['together', 'Classified together as asks-clarifying: same behavior for the study\'s purpose'], ['separate', 'Separate codes']], 'together'),
    choice('pass-def', 'A pass requires', [['behavior', 'Successful execution and agreement on the specified observations; trade activity is necessary evidence, never sufficient; a zero-trade program can be correct'], ['any-trade', 'Execution with any trade']], 'behavior'),
    yesno('infra-not-model', 'Infrastructure failures are never model failures', 'A docker outage, a dead binary or a network fault is a harness error, retried and reported separately.', 'Failures count against the model.', 'yes'),
    yesno('no-best-of-k', 'No reprompting until a judge passes', 'One response per scheduled attempt; a retry loop that resubmits until the grader passes makes every rate a best-of-k against a noisy instrument.', 'Retries until pass are allowed.', 'yes'),
    yesno('strict-and', 'Overall pass is the strict AND of every gate', 'Compile, runtime, trade, schema and judge each keep their own label; the reported rate and its N share one denominator.', 'Overall pass may collapse to one gate.', 'yes'),
    number('judge-threshold', 'Judge threshold when a judge is used', 'score', 0.7, { min: 0, max: 1, step: 0.05 }),
    choice('judge-pool', 'Judges and contestants', [['disjoint', 'Judges come from outside the contestant pool'], ['disclosed', 'Overlap disclosed, with judge–human agreement reported']], 'disjoint'),
    yesno('hitl', 'Human validation sample drawn deterministically', 'A fixed seed, stratified by model and condition, never reused to tune the judge; judge–human agreement is reported.', 'No human validation.', 'yes'),
    yesno('stage-instrumentation', 'Per-stage instrumentation on every row', 'First failed stage, failure classes and the harness revision are populated for every call.', 'Stage fields may stay empty.', 'yes'),
  ] },
  { id: 'analysis', title: 'Analysis and reporting', intro: 'What is counted, how uncertainty is stated, and what is kept apart.', fields: [
    choice('primary-measure', 'Primary measure', [['scheduled', 'Behavioral success per scheduled trial'], ['completed', 'Behavioral success per completed trial']], 'scheduled'),
    yesno('counts-reported', 'The funnel is reported beside the rate', 'Attempted, collected, extracted, executable, graded and successful trials are reported separately; conditional success among executables separately; infrastructure failures identifiable.', 'Only the rate is reported.', 'yes'),
    choice('uncertainty', 'Uncertainty procedure', [['wilson', 'Wilson 95% interval'], ['exact', 'Exact binomial'], ['bootstrap', 'Family bootstrap'], ['descriptive', 'Descriptive tables only']], 'wilson'),
    yesno('family-units', 'Related variants keep their family identity', 'Repetitions and related variants are not treated as independent observations; dependence handling is fixed before inspection.', 'Every draw is independent.', 'yes'),
    yesno('separation', 'Exploratory, confirmatory and qualification records kept apart', 'Exploratory arms, pilots and qualification cohorts are reported separately from the main cohort unless their inclusion was specified in advance.', 'Cohorts may be pooled.', 'yes'),
    yesno('resources', 'Resource measurements recorded separately', 'Generation time, engine time, latency, tokens and tool calls are separate measurements; retries stay in the resource record; provider-reported and estimated cost are distinguished and an unavailable cost is never zero.', 'Resources are not measured.', 'yes'),
    choice('subsets', 'Primary subsets are defined', [['metadata', 'From prompt metadata only, never by an outcome'], ['outcome-secondary', 'Outcome-conditioned subsets allowed as secondary analyses only']], 'metadata'),
    yesno('deviations', 'Deviations logged with reasons', 'Any change to a pre-registered decision after collection starts is logged with its reason; threats and mitigations are enumerated in the report.', 'Deviations need no log.', 'yes'),
    choice('formal-claims', 'Formal claims', [['computed', 'Computed or omitted: a formalism earns its place only if it computes from the graded draws'], ['narrative', 'Narrative allowed']], 'computed'),
  ] },
  { id: 'audit', title: 'External judge audit', intro: 'Only when the study audits another benchmark\'s ground truth or judge.', fields: [
    yesno('audit-included', 'A judge audit is part of the study', 'A frozen source study\'s judge is compared with a declared reference criterion.', 'No judge audit.', 'yes'),
    number('refs-k', 'Independent references per task', 'references', 3, { min: 1 }),
    choice('determinacy', 'Determinacy criterion', [['unanimous', 'All references agree; two of three adjudicate the dissenter'], ['majority', 'Majority']], 'unanimous'),
    choice('repair', 'Reference repairs', [['one-round', 'One repair round, only for an implementation that contradicts explicit spec text'], ['unlimited', 'Repairs until convergence']], 'one-round'),
    yesno('canonical-defaults', 'Canonical environment defaults fixed before references', 'Bench-canonical defaults (sizing, exits, one position, warm-up) are fixed so determinacy measures whether the spec pins behavior, not whether implementers share conventions.', 'Implementers choose defaults.', 'yes'),
    list('ambiguity-taxonomy', 'Pre-registered ambiguity classes', ['unpinned-sizing', 'unpinned-indicator-params', 'unpinned-entry-trigger', 'unpinned-exit', 'orphaned-price-levels', 'timeframe-mismatch', 'goal-directed', 'external-data-required', 'multi-asset-required', 'other'], 'One class per line'),
    yesno('judge-replication', 'The audited judge is replicated verbatim', 'Prompt template, parsing rules, gate order and fallbacks reproduced exactly; every deviation (model family, unpinned temperature) disclosed.', 'An equivalent judge is acceptable.', 'yes'),
    number('stability', 'Stability re-judgements per spot-checked candidate', 'repeats', 3, { min: 1 }),
    yesno('paid-budget', 'Paid judging runs under a hard budget', 'Serialized requests, a reservation written before each request, a run-once lock, no automatic resume after a paid attempt, prices re-checked before execution, no cache writes.', 'Paid calls run freely.', 'yes'),
  ] },
  { id: 'ops', title: 'Operational rules learned the hard way', intro: 'Each of these was a failure once; as a rule it is a setting.', fields: [
    choice('decoding-contract', 'When a model rejects the pinned decoding parameters', [['lower-tier', 'Run the tier where the parameter contract holds and disclose that the frontier is unavailable on the protocol\'s terms'], ['drop-pin', 'Drop the pin for those models and disclose it'], ['exclude', 'Exclude those models']], 'lower-tier'),
    yesno('quota-attrition', 'Quota and rate limits stop the lane', 'A 429, an exhausted quota or a depleted balance stops the lane, quarantines the row and retries after recovery; stranded "started" rows are cleared, never scored.', 'Rate-limited rows are scored as failures.', 'yes'),
    yesno('auth-outage', 'An auth outage is read off the data', 'A revoked token makes every draw return in seconds with no text; failure evidence per row makes that visible, and a catch-up queue reruns the registered order after re-authentication.', 'Blank lanes are read as model behavior.', 'yes'),
    yesno('safe-paths', 'Configuration paths written as forward slashes, never through a heredoc', 'A shell heredoc once collapsed backslashes so the account home pointed nowhere and every status call answered "Not signed in".', 'Any path style.', 'yes'),
    yesno('single-parse', 'Each response is parsed once', 'A collector parses the diff or the raw text, never both; phantom duplicates are a defect.', 'Double parsing is tolerated.', 'yes'),
    yesno('safe-ids', 'File names cannot collide across prompts', 'Quote-like characters in prompt ids map to distinct safe names; resume is keyed by hash.', 'Ids are stripped freely.', 'yes'),
    yesno('data-coverage', 'Pre-run data-coverage assertion', 'Before any run, the data the tasks need is asserted present and the engine\'s failed-data requests are parsed into the runtime stage.', 'Data coverage is assumed.', 'yes'),
    yesno('version-bump', 'Any scoring-affecting change bumps the version stamp', 'Two halves of a grid must never carry one version stamp across a harness change.', 'Versions change on release only.', 'yes'),
    yesno('visible-input-frozen', 'What the model sees is frozen and recorded', 'A hidden schema or context is never disclosed in one build and hidden in another; the visible input is part of the frozen study.', 'Context may vary between builds.', 'yes'),
    yesno('docs-current', 'Documentation describes the system that exists', 'Retired tools and shims are documented as retired; a stale README is a defect.', 'Documentation may lag.', 'yes'),
  ] },
])

// Where each rule came from. A ruling is a recorded decision in the decisions
// of record or an arm manifest; a measured rule is an instrument change made
// after a failure; a registry rule came in with registry artifacts that were
// kept when that process was set aside; a proposal is a
// marker or an audit finding nobody decided; an assumption is something run
// with while a question stayed open.
export const ORIGIN_LABELS = Object.freeze({ owner: 'Your ruling', measured: 'Rule from a measured failure', registry: 'Council-era registry', proposal: 'Open proposal', assumed: 'Agent assumption' })
const ORIGIN = {
  'study-kind': ['owner', 'Recorded decision: the exploratory arm and the clean-room confirmation are separate studies.'],
  'hypotheses-first': ['owner', 'Recorded decision: a one-page hypotheses list is written and committed first.'],
  'scope-closed': ['owner', 'Recorded decision: scope closes at registration; later arms are recorded as additive extensions.'],
  'push-daily': ['measured', 'Rule adopted after a provenance review found commits that were never pushed.'],
  'keep-everything': ['owner', 'Recorded decision: nothing is thrown away or deleted; history is sealed, not erased.'],
  'dated-amendments': ['registry', 'Imported registry rule for hashed governing artifacts and dated amendments.'],
  'owner-gates': ['owner', 'Recorded decision: releasing further draws, scaling up and new prompt batches wait for explicit approval.'],
  'approval-loop': ['assumed', 'Working assumption recorded in a handoff note; the underlying decision is not in the files.'],
  'input-shape': ['measured', 'Rule adopted after a verification pass of how the field accesses each vendor.'],
  'system-line': ['assumed', 'Working assumption from the hypotheses draft; the line itself was never separately approved.'],
  'max-turns': ['assumed', 'Working assumption from the run manifest: single turn kept, with a salvage pass still proposed.'],
  'frozen-hash': ['measured', 'Rule adopted after the generator detected a frozen-prompt mismatch.'],
  'noask': ['owner', 'Recorded decision: the no-ask condition uses the LiveCodeBench instruction line.'],
  'noask-text': ['owner', 'Recorded decision: the LiveCodeBench instruction line, as recorded in the run manifest.'],
  'conditions': ['owner', 'Recorded decision: a no-ask arm beside the vendor-default baseline.'],
  'growth-rule': ['owner', 'Recorded decision: the prompt set grows only through the mechanical atom system, after review of the prompts and their fair-reading sets.'],
  'admission-gate': ['owner', 'Recorded decision: killed prompts stay killed, excluded prompts stay out, and refrozen prompts get new ids.'],
  'fair-readings': ['assumed', 'Working assumption: the fair-readings file was drafted and its review gate read as satisfied.'],
  'cleanroom': ['owner', 'Recorded decision: no model generation without a same-day passed canary test in the clean room.'],
  'canary-required': ['owner', 'Recorded decision: the runner refuses to generate without that canary.'],
  'canary-cadence': ['measured', 'Rule from the canary instrument: run before and after every batch.'],
  'canary-scope': ['owner', 'Recorded decision: each surface generates only with its own same-day pass.'],
  'canary-sides': ['measured', 'Rule adopted after a crashed or empty canary output was once read as clean.'],
  'certificate': ['measured', 'Rule adopted after a race while copying the certificate into a batch folder.'],
  'env-allowlist': ['measured', 'Rule from the clean-room environment manifest.'],
  'isolation-record': ['registry', 'Imported registry rule for per-draw isolation records.'],
  'funding': ['owner', 'Recorded decision: subscriptions only; nothing metered without explicit approval.'],
  'direct-cli': ['owner', 'Recorded decision, kept as a standing rule: study draws never go through orchestration tools.'],
  'second-home': ['measured', 'Rule added for running a second account under its own canary-certified home.'],
  'exact-ids': ['owner', 'Recorded decision to pin the models; the quarantine mechanism is an instrument rule.'],
  'models': ['owner', 'Recorded decision: use the models the benchmark already used.'],
  'surfaces': ['measured', 'Rule from the hypotheses design of the legs, with the API spend approved separately.'],
  'symmetric': ['measured', 'Rule adopted after a verification pass of field practice.'],
  'efforts': ['owner', 'Recorded decision: every effort level across the models.'],
  'argv-record': ['measured', 'Rule adopted after draws were found that could not be read back.'],
  'no-shell': ['registry', 'Imported registry rule: children are spawned without a shell.'],
  'output-cap': ['measured', 'Rule adopted after draws were truncated at the previous output ceiling.'],
  'draw-timeout': ['measured', 'Rule adopted after draws died at the previous timeout.'],
  'served-model': ['measured', 'Rule adopted after model pinning was found not to be honoured on one surface.'],
  'dead-surface': ['proposal', 'Open proposal from a planning question that was never answered.'],
  'quota-order': ['owner', 'Recorded decision: quota ordering is scheduling, never a design change, and lanes run in order.'],
  'lane-order': ['assumed', 'Working assumption: a queue script encodes the recorded lane order.'],
  'in-flight': ['assumed', 'Working assumption: the ceiling is recorded in a resume script, not in a decision.'],
  'per-cell': ['measured', 'Rule from the resume script design.'],
  'engine-workers': ['measured', 'Rule adopted after a second engine worker showed no clean gain and doubled machine load.'],
  'drop-concurrency': ['owner', 'Recorded decision: concurrency that causes any issue is dropped, not debugged.'],
  'single-entry': ['measured', 'Rule adopted after double-launch collisions.'],
  'cloud-one-task': ['measured', 'Rule from the cloud lane design.'],
  'cloud-attempts': ['measured', 'Rule from the cloud lanes as run.'],
  'statuses': ['registry', 'Imported registry rule from the codebook status vocabulary.'],
  'fairness': ['owner', 'Recorded decision: draws the model never finished do not count and are retried; everything is kept on disk.'],
  'provider-notices': ['measured', 'Rule adopted after provider session-limit notices were banked as observations.'],
  'shape-test': ['measured', 'Rule adopted after literal notice patterns missed a real block.'],
  'truncation': ['measured', 'Rule adopted after truncated responses were graded.'],
  'resume-key': ['measured', 'Rule adopted after index-keyed resume picked up the wrong rows.'],
  'batch-pooling': ['measured', 'Rule adopted after a midnight rollover split a lane across date folders.'],
  'engine-retry': ['measured', 'Rule adopted after engine outcomes were compared against the bank ledger.'],
  'late-response': ['proposal', 'Open proposal from the methods draft: freeze retry eligibility and late-response handling.'],
  'unreachable': ['measured', 'Rule adopted after unreachable responses were found in a cloud collection.'],
  'cleanup-nonfatal': ['measured', 'Rule adopted after concurrent cells crashed on cleanup.'],
  'cell-factors': ['assumed', 'Working assumption: the arm design as run, never stated as a rule.'],
  'n-eligible': ['owner', 'Recorded decision: the cells a paper relies on get at least 30 draws each in the clean room.'],
  'n-anchor': ['assumed', 'Working assumption from a planning question that was never answered.'],
  'n-donor': ['assumed', 'Working assumption from a planning question that was never answered.'],
  'n-exploratory': ['owner', 'Recorded decision: smaller earlier cells count as exploratory only.'],
  'completion': ['measured', 'Rule from the lane status instrument.'],
  'overdraw': ['measured', 'Rule from a model-notes amendment.'],
  'tests': ['assumed', 'Working assumption: the hypotheses draft awaits review.'],
  'grader': ['registry', 'Imported registry rule: a mechanical answer bank, re-verified on import.'],
  'bank-method': ['registry', 'Imported registry rule from the bank specification.'],
  'matching': ['registry', 'Imported registry rule from the codebook matching section and its cross-tuple rule.'],
  'extractor-role': ['registry', 'Imported registry rule from the codebook extractor sections.'],
  'bank-verify': ['registry', 'Imported registry rule from the bank verification and provenance import checks.'],
  'execution-control': ['registry', 'Imported registry rule from the grader control and stride options.'],
  'stride': ['registry', 'Imported registry rule from the grader stride option.'],
  'data-freeze': ['registry', 'Imported registry rule from the data-freeze record.'],
  'freeze-change': ['registry', 'Imported registry rule from the same data-freeze record.'],
  'engine-pins': ['measured', 'Rule from the bank runner and its setup plan.'],
  'engine-timeout': ['measured', 'Rule from the data-freeze runner timeout per backtest.'],
  'completion-detect': ['registry', 'Imported registry rule from the bank runner.'],
  'bank-gate': ['proposal', 'Open proposal: a review gate that awaits explicit authorization.'],
  'extraction': ['registry', 'Imported registry rule: one extraction rule for every surface.'],
  'ask-rule': ['measured', 'Rule from the grading header, with the classifier calls validated by review.'],
  'refusals': ['owner', 'Recorded decision: refusals and questions are classified together.'],
  'pass-def': ['proposal', 'Open proposal from the methods draft evaluation section.'],
  'infra-not-model': ['proposal', 'Open proposal from the audit findings.'],
  'no-best-of-k': ['proposal', 'Open proposal from the audit findings.'],
  'strict-and': ['proposal', 'Open proposal from the audit findings.'],
  'judge-threshold': ['registry', 'Imported registry rule from the legacy decision log.'],
  'judge-pool': ['proposal', 'Open proposal from the audit findings.'],
  'hitl': ['registry', 'Imported registry rule from the legacy decision log; built and never run.'],
  'stage-instrumentation': ['proposal', 'Open proposal from the audit findings.'],
  'primary-measure': ['proposal', 'Open proposal from the methods draft primary measure.'],
  'counts-reported': ['proposal', 'Open proposal from the methods draft variance section.'],
  'uncertainty': ['measured', 'Rule from the audit report and the hypotheses exact tests.'],
  'family-units': ['proposal', 'Open proposal from the methods draft on dependence handling.'],
  'separation': ['owner', 'Recorded decision: the exploratory arm is kept apart from its clean-room confirmation.'],
  'resources': ['proposal', 'Open proposal from the methods draft resource measurements.'],
  'subsets': ['registry', 'Imported registry rule from the legacy decision log.'],
  'deviations': ['measured', 'Rule from the audit plan and report deviations log.'],
  'formal-claims': ['owner', 'Recorded decision: a formalism that computes is a result; otherwise plain language.'],
  'audit-included': ['owner', 'Recorded decision: all three legs run (lattice, audit, benchmark).'],
  'refs-k': ['owner', 'Recorded decision: three independent references, one per model family.'],
  'determinacy': ['owner', 'Recorded decision: determinacy is checked by three references, two of three adjudicating.'],
  'repair': ['measured', 'Rule pre-registered in the audit plan.'],
  'canonical-defaults': ['measured', 'Rule from the audit plan.'],
  'ambiguity-taxonomy': ['measured', 'Rule from the audit plan.'],
  'judge-replication': ['measured', 'Rule from the audit plan.'],
  'stability': ['measured', 'Rule from the audit plan.'],
  'paid-budget': ['measured', 'Rule from the rejudge budget rules.'],
  'decoding-contract': ['proposal', 'Open proposal from the completion plan.'],
  'quota-attrition': ['measured', 'Rule from the generator provider-blocked handling and the completion plan.'],
  'auth-outage': ['measured', 'Rule adopted after an authentication outage blanked a lane.'],
  'safe-paths': ['measured', 'Rule adopted after a heredoc collapsed backslashes in a configuration path.'],
  'single-parse': ['measured', 'Rule adopted after phantom duplicate rows were quarantined.'],
  'safe-ids': ['measured', 'Rule adopted after prompt ids collided as file names.'],
  'data-coverage': ['proposal', 'Open proposal from the audit plan.'],
  'version-bump': ['proposal', 'Open proposal from the audit findings.'],
  'visible-input-frozen': ['proposal', 'Open proposal from the audit findings.'],
  'docs-current': ['proposal', 'Open proposal from the audit findings.'],
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
  // Since the judge and recording builders: the threshold lives with the judge
  // verdict format; what a draw records is chosen per field in the pipeline.
  'judge-threshold': 'Judge audit: Judge verdicts (format, threshold and rule)',
  'argv-record': 'Decisions & pipeline: What each draw records',
  'served-model': 'Decisions & pipeline: What each draw records',
})
// The managed set as it was before the judge and recording builders, so a
// record written then is still recognized rather than turned into notes.
const PREVIOUS_MANAGED = new Set(['input-shape', 'system-line', 'noask', 'noask-text', 'conditions', 'models', 'surfaces', 'efforts', 'draw-timeout', 'n-eligible', 'grader', 'approval-loop', 'engine-pins', 'visible-input-frozen'])

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
// Take only the recorded rulings, in every section or one.
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
export function decisionsText(state, { includeManaged = false, managed = null } = {}) {
  const current = normalizeProtocolDecisions(state)
  const blocks = [], undecided = []
  const hidden = id => includeManaged ? false : managed ? managed.has(id) : !!FIELD_BY_ID.get(id).managedBy
  for (const section of PROTOCOL_REGISTRY) {
    const lines = []
    for (const field of section.fields) {
      if (hidden(field.id)) continue
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
  if (!Object.keys(current.values).some(id => !hidden(id))) return notes
  const parts = ['DECISIONS OF RECORD\n\n' + blocks.join('\n\n')]
  if (notes) parts.push('NOTES\n\n' + notes)
  if (undecided.length) parts.push(`NOT YET DECIDED (${undecided.length})\n${undecided.join('; ')}`)
  return parts.join('\n\n')
}

// Recognize a previously generated record without turning its retired fields
// into freeform notes. Handwritten decisions still keep the existing path.
export function matchesDecisionsText(state, text) {
  const legacy = decisionsText(state, { includeManaged: true })
  return text === decisionsText(state) || text === decisionsText(state, { managed: PREVIOUS_MANAGED }) || text === legacy || text === legacy
    .replace('Yes: append the no-ask instruction below to the prompt, identically across models and lanes.', 'A registered instruction is appended to the prompt in one condition, byte-identical across models and lanes.')
    .replace('No: do not include a no-ask condition.', 'No instruction condition.')
}
