import { ROLE_STUDIO_SOURCE_ACTION } from './role-studio-source.mjs';
import { ENGINE_PERFORMANCE_ACTIONS } from './engine-performance-source.mjs';

// Fixed named source-suite inventory. The app census includes the reviewed
// 1.0.45 tree, chat, provider, Ledger-reset and Linux-launch repair suites
// (2026-09-12). These are required executions, never baseline exclusions.
// App and Engine inventories include the reviewed role, provider and custody
// repairs (2026-09-14). Contextual runners remain required command obligations
// until their fixed qualification executors exist; file selection is not proof.
// Website components retain their 2026-09-05 census.
// Update this policy deliberately when adding/removing a suite or
// changing an entry point; a candidate cannot silently shrink its own obligation.
// Exclusions are named helpers/runners, never inferred from a future filename.
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const MODEL_DECLARATION_INPUTS = freeze([
  'src/lib/fleet-supervisor/lane-models.js',
  'src/lib/fleet-supervisor/planning.js',
  'src/lib/providers/cli-provider-gateway.js',
  'src/lib/providers/gemini-agentic.js',
  'src/lib/providers/vertex-gemini-strong.js',
  'src/lib/providers/vertex-gemini.js',
  'src/lib/providers/vertex-gemini-seat.js',
  'tools/gemini-fleet.js',
]);
// Actual supplemental invocations, not a list of names to waive. Arguments are
// part of each identity: the generated-file writers and baseline mutators are
// intentionally absent. Each action is executed in addition to the leaf census.
// Named terminal reports from assertion programs, each executed through run-isolated.
export const SOURCE_LEAF_REPORTS = freeze({
  "engine": [
    {
      "file": "tests/agent-engine/claude-native-mode-launch.test.js",
      "footer": {
        "exact": "Claude trusted launch/resume mode policy GREEN"
      }
    },
    {
      "file": "tests/agent-engine/claude-native-modes.test.js",
      "footer": {
        "exact": "Claude native mode behavioral checks GREEN"
      }
    },
    {
      "file": "tests/agent-engine/codex-collaboration-modes.test.js",
      "footer": {
        "exact": "Codex collaboration catalog behavior passed: metadata, optional fields, immutable results, malformed/bounded refusals, unavailable RPC, no turn or mutation."
      }
    },
    {
      "file": "tests/agent-engine/codex-native-mode-launch.test.js",
      "footer": {
        "exact": "Native mode launch binding passed: config/start/select identical instructions, actual settings, no widening, named unavailable recovery, bounded timeout/late reply, explicit overrides, empty/null, resume no guessing."
      }
    },
    {
      "file": "tests/agent-engine/codex-native-mode-selection.test.js",
      "footer": {
        "exact": "Codex native mode selection passed: retained settings, advertised modes, missing-data refusals, provider errors, concurrent clicks/send/resume/effort, close settlement."
      }
    },
    {
      "file": "tests/agent-engine/codex-thread-settings-shape.test.js",
      "footer": {
        "exact": "Codex thread settings shape passed: installed nested read, legacy top-level, explicit null, absent values, mixed fields, malformed nested refusals."
      }
    }
  ]
});
export const SOURCE_COMMAND_ACTIONS = freeze({
  app: [
    ROLE_STUDIO_SOURCE_ACTION,
    { id: 'app:node-version', command: ['node', 'tools/check-node-version.mjs'], reporter: 'app:node-version' },
    { id: 'app:benchmark-core', command: ['node', 'tools/check-benchmark-core-independent.mjs'], reporter: 'app:benchmark-core' },
    { id: 'app:profile-paths', command: ['node', 'tools/check-no-profile-paths.mjs'], reporter: 'app:profile-paths' },
    { id: 'app:shipped-source-privacy', command: ['node', 'tools/check-shipped-source-owner-data.mjs'], reporter: 'app:shipped-source-privacy' },
    { id: 'app:payload-reconciliation', command: ['node', 'tools/check-payload-boundary-reconciled.mjs'], reporter: 'app:payload-reconciliation' },
    { id: 'app:test-inputs', command: ['node', 'tools/check-test-inputs.mjs'], reporter: 'app:test-inputs' },
    // The app/engine settings-row agreement gate (T61 landing). It reads the
    // PACKED registry, so it is an action rather than a leaf suite: a pair that
    // disagrees must refuse the tree, not one checkout's sources.
    { id: 'app:settings-rows-declared', command: ['node', 'tools/check-settings-rows-declared.mjs'],
      reporter: 'app:settings-rows-declared' },
    { id: 'app:suite-discovery', command: ['node', 'tools/check-suites-discovered.mjs'], reporter: 'app:suite-discovery' },
    { id: 'app:driver-discovery', command: ['node', 'tools/check-drivers-discovered.mjs'], reporter: 'app:driver-discovery' },
    {
      // Browser-proof drivers (tools/test/fixtures/run-*.mjs, T58): the receipts
      // mode verifies every required proof's attributable receipt at the fixed
      // private location and is red without one. It also discharges the plain
      // discovery gate npm test runs; declaration alone is never coverage.
      id: 'app:browser-proofs', command: ['node', 'tools/check-browser-proofs-discovered.mjs', '--receipts', 'private/browser-proof-receipts'],
      reporter: 'app:browser-proofs', satisfies: [['node', 'tools/check-browser-proofs-discovered.mjs']],
      measuredInputs: ['tools/test/fixtures/browser-proofs.json'],
    },
    { id: 'app:unbound-identifiers', command: ['node', 'tools/check-unbound-identifiers.mjs'], reporter: 'app:unbound-identifiers' },
    { id: 'app:composed-output', command: ['node', 'tools/check-composed-output.mjs'], reporter: 'app:composed-output' },
    /* The chat-control coverage gate. It could not run against the real
       src/components.js until T288 and was wired into no chain, so nothing
       ever invoked it; it is a required step now. */
    { id: 'app:chat-control-coverage', command: ['node', 'tools/check-chat-control-coverage.mjs'],
      reporter: 'app:chat-control-coverage' },
    {
      id: 'app:strict-release', command: ['node', 'tools/test-strict.mjs'], reporter: 'app:strict-release',
      context: 'app-strict-engine-scratch',
      // The wrapper really invokes verify:release with its isolated environment.
      // Reconcile both ratchet aliases through that child, never a baseline run.
      satisfies: [['node', 'tools/test-ratchet.mjs', '--strict'], ['node', 'tools/test-ratchet.mjs']],
      measuredInputs: ['package-lock.json'], timeoutMs: 30 * 60 * 1000,
    },
  ],
  engine: [
    ...ENGINE_PERFORMANCE_ACTIONS,
    { id: 'engine:native-custody', command: ['node', 'tests/key-custody/run.js'],
      context: 'engine-native-custody-scratch', reporter: 'engine:native-custody',
      requiredFiles: ['tests/linux-vault.test.js', 'tests/vault-native.test.js'],
      measuredInputs: ['tests/key-custody/run.js', 'tests/linux-vault.test.js', 'tests/vault-native.test.js',
        'tests/run-isolated.js', 'tests/lib/isolated-child.js', 'tests/lib/isolated-environment.js',
        'tests/lib/linux-keyring-fixture.py', 'tests/lib/linux-vault-boundary.py',
        'tools/lib/vault-acl.ps1', 'tools/lib/strict-lifecycle-record.js',
        'src/lib/linux-process-control.js', 'src/lib/windows-job-control.js'],
    },
    // Fixed package-owned commands. Every child must complete in order;
    // aggregate observations contribute no duplicate leaf assertion counts.
    {
      id: "engine:controller-runner", command: ["node", "tests/controller/run.js"], reporter: "engine:isolated-transcript",
      isolatedReports: [
        {"file": "tests/controller/controller-cost-attribution.js", "footer": {"exact": "Controller cost attribution tests passed (provider amounts only; unknowns never priced)."}},
        {"file": "tests/controller/controller-escalation.js", "footer": {"exact": "Controller escalation contract tests passed."}},
        {"file": "tests/controller/controller-focus.js", "footer": {"exact": "Controller focus tests passed (closed owner display preference and safe persistence)."}},
        {"file": "tests/controller-launch-record.js", "footer": {"exact": "Controller launch record tests passed."}},
        {"file": "tests/controller/controller-launch-scope.js", "footer": {"exact": "controller-launch-scope: 26 checks passed"}},
        {"file": "tests/controller/controller-metering.js", "footer": {"exact": "Controller metering account-roster tests passed (live resolution, named absence, fail-closed declaration)."}, "requiredLines": ["Controller mechanical metering tests passed."]},
        {"file": "tests/controller/controller-meter-isolation.js", "footer": {"exact": "Controller meter isolation tests passed (single-record and batch malformed-record isolation, three-way state distinction, regression proof)."}},
        {"file": "tests/controller/controller-meter-ledger.js", "footer": {"exact": "Controller meter ledger tests passed."}, "requiredLines": ["Controller meter ledger end-to-end regression passed (real audit ledger, real state store)."]},
        {"file": "tests/controller/controller-projection.js", "footer": {"exact": "Controller projection account-roster tests passed (declared configuration, honest empty-roster projection)."}, "requiredLines": ["Controller projection tests passed (redaction, invalid-audit fail-closed behavior, and meter truthfulness)."]},
        {"file": "tests/controller/controller-savings-ledger.js", "tap": true},
        {"file": "tests/controller/controller-tool-meter.js", "footer": {"exact": "Asynchronous meter ordering, concurrent flush, and invalid-receipt checks passed."}, "requiredLines": ["Controller tool-meter unit checks passed (record shape, batching, age flush, periodic flush, and failure isolation)."]},
        {"file": "tests/controller/controller-tool-meter-e2e.js", "footer": {"exact": "Controller tool-meter end-to-end check passed (success, failure, projection read, and write-failure isolation)."}},
        {"file": "tests/controller/controller-tool-meter-production-wiring.js", "footer": {"exact": "Controller tool-meter production wiring checks passed (worker receives the batch; the caller's thread never touches the ledger)."}},
        {"file": "tests/controller/custom-roles.js", "footer": {"pattern": "^Custom\\ role\\ store\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ assertions\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/controller/gemini-account-lane-binding.js", "footer": {"pattern": "^Gemini account lane binding tests passed \\(no provider require in the projection, load\\(\\) contract intact, (?:both lanes configured and bound|no Vertex lane configured on this installation \\(a normal state; the drift check had nothing to compare\\)|1 of 2 lanes configured; the rest are unconfigured, which is a normal state)\\)\\.$"}},
        {"file": "tests/agent-org-store.test.js", "footer": {"pattern": "^Agent\\ org\\ store\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ assertions;\\ every\\ persistence\\ case\\ reopens\\ the\\ files\\ rather\\ than\\ trusting\\ an\\ in\\-memory\\ cache\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/agent-presence.test.js", "footer": {"pattern": "^agent\\ presence:\\ ([1-9][0-9]*)\\ assertions\\ passed$", "positiveGroups": [1]}},
        {"file": "tests/agent-lane-verdict-normalization.test.js", "footer": {"pattern": "^agent\\ lane\\ verdict\\ normalization:\\ ([1-9][0-9]*)\\ assertions\\ passed$", "positiveGroups": [1]}},
        {"file": "tests/spawn-record.js", "tap": true},
        {"file": "tests/spawn-hygiene.test.js", "footer": {"exact": "SPAWN-HYGIENE passed: every scanned process launch is hidden/noninteractive or explicitly allowlisted."}, "requiredLines": ["SPAWN-HYGIENE unscannable: 0"]},
      ],
    },
    {
      id: "engine:google-suite-runner", command: ["node", "tests/providers.google.suite/run.js"], reporter: "engine:isolated-transcript",
      isolatedReports: [
        {"file": "tests/providers.google.suite/google-inputs.js", "footer": {"exact": "Google input hardening tests passed."}},
        {"file": "tests/providers.google.suite/google-oauth-access-token.js", "footer": {"exact": "google-oauth access-token absence: 7 checks passed"}},
        {"file": "tests/providers.google.suite/gcloud-account-inspector.js", "footer": {"exact": "Google Cloud selected-account inspector tests passed."}},
        {"file": "tests/providers.google.suite/firebase-account-login.js", "footer": {"exact": "Firebase account login tests passed."}},
        {"file": "tests/providers.google.suite/gmail-attachments.js", "footer": {"pattern": "^Gmail\\ attachment\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks\\)\\.$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/providers.google.suite/drive-upload-containment.js", "footer": {"pattern": "^Drive\\ upload\\ containment\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks\\)\\.$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/providers.google.suite/gmail-send-failure.js", "footer": {"exact": "gmailSend failure-path audit tests passed (typed code classification, safe details, original error preserved, audit-write failure isolation, success regression)."}},
        {"file": "tests/providers.google.suite/personal-calendar.js", "footer": {"exact": "Personal Calendar tests passed."}},
        {"file": "tests/providers.google.suite/provider-untrusted-content.js", "footer": {"exact": "Provider untrusted-content envelope tests passed."}},
      ],
    },
    {
      id: "engine:audit-runner", command: ["node", "tests/kernel.audit/run.js"], reporter: "engine:isolated-transcript",
      isolatedReports: [
        {"file": "tests/audit-fresh-install.js", "footer": {"exact": "Fresh-install audit verification tests passed (6 cases)."}},
        {"file": "tests/kernel.audit/vault-hardening.js", "footer": {"exact": "vault hardening tests passed"}},
        {"file": "tests/vault-batched-read.test.js", "footer": {"pattern": "^vault\\-batched\\-read:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/kernel.audit/audit-store.js", "footer": {"exact": "Canonical audit-store tests passed."}},
        {"file": "tests/kernel.audit/audit-reliability.js", "footer": {"exact": "Audit durability and recovery tests passed."}},
        {"file": "tests/kernel.audit/audit-concurrency.js", "footer": {"exact": "Cross-process audit projection tests passed."}},
        {"file": "tests/kernel.audit/audit-contention.js", "footer": {"exact": "Cross-process audit contention tests passed."}},
        {"file": "tests/kernel.audit/audit-projection-batching.js", "footer": {"pattern": "^audit\\-projection\\-batching:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/kernel.audit/audit-durability-multiprocess.js", "footer": {"pattern": "^Cross\\-process\\ audit\\ durability\\ test\\ passed:\\ ([1-9][0-9]*)\\ durable\\ writes,\\ 0\\ breaches\\.$", "positiveGroups": [1]}},
        {"file": "tests/kernel.audit/audit-legacy-scale.js", "footer": {"pattern": "^Bulk legacy audit migration test passed \\(([1-9][0-9]*) records in [0-9]+ms\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/kernel.audit/audit-anchor-cross-process.js", "footer": {"exact": "Cross-process protected-head cache test passed."}},
        {"file": "tests/kernel.audit/audit-ledger-vault-binding.js", "footer": {"exact": "Audit ledger/vault binding test passed (control, guard, fork outage, tamper alarm)."}},
        {"file": "tests/audit-archive-boundary.test.js", "footer": {"pattern": "^audit\\-archive\\-boundary:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/audit-archive-segment.test.js", "footer": {"pattern": "^audit\\-archive\\-segment:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/audit-archive-roll.test.js", "footer": {"pattern": "^audit\\-archive\\-roll:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/audit-retention.test.js", "footer": {"pattern": "^audit\\-retention:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/kernel.audit/audit-intent.js", "footer": {"exact": "Durable external-intent gating tests passed."}},
        {"file": "tests/audit-durability-classification-provenance.test.js", "footer": {"pattern": "^audit\\-durability\\-classification\\-provenance:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/audit-durability-current-vs-historical.test.js", "footer": {"pattern": "^audit\\-durability\\-current\\-vs\\-historical:\\ ([1-9][0-9]*)/\\1 checks passed$", "countPattern": "^ok - ", "countGroup": 1}},
        {"file": "tests/audit-projection-total-render.test.js", "footer": {"pattern": "^Audit\\ projection\\ total\\-render\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ cases\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/kernel.audit/audit-logs-retention.js", "footer": {"pattern": "^audit\\-logs\\-retention:\\ ([1-9][0-9]*)\\ checks\\ passed\\.$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/audit-spool-batch-durability.test.js", "footer": {"pattern": "^Audit\\ emergency\\-spool\\ batch\\ durability\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ cases\\)$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
      ],
    },
    {
      id: "engine:fleet-runner", command: ["node", "tests/fleet/run.js"], reporter: "engine:isolated-transcript",
      isolatedReports: [
        {"file": "tests/agent-wake.test.js", "footer": {"pattern": "^agent\\ wake/sweep:\\ ([1-9][0-9]*)\\ assertions\\ passed$", "positiveGroups": [1]}},
        {"file": "tests/agent-sweep-task.test.js", "footer": {"pattern": "^agent\\ sweep\\ task:\\ ([1-9][0-9]*)\\ assertions\\ passed$", "positiveGroups": [1]}},
        {"file": "tests/resource-alerts.test.js", "footer": {"pattern": "^resource\\-alerts:\\ ([1-9][0-9]*)\\ checks\\ passed$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/fleet/fleet-supervisor.js", "footer": {"pattern": "^fleet\\-supervisor\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/fleet/fleet-summary.js", "footer": {"pattern": "^fleet\\-summary\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/fleet/fleet-supervisor-model-receipt.js", "footer": {"pattern": "^Fleet\\ model\\-receipt\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks;\\ per\\-call\\ served\\-model\\ evidence\\ is\\ fail\\-closed\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/fleet/fleet-supervisor-direct-vertex-receipt.js", "footer": {"pattern": "^Direct\\-Vertex\\ receipt\\ adapter\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks;\\ raw\\ completion\\ content\\ remains\\ redacted\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/fleet/fleet-supervisor-worktree-lease-state.js", "footer": {"pattern": "^Fleet\\ worktree\\ lease\\-state\\ tests\\ passed\\ \\(([1-9][0-9]*)\\ checks;\\ temp\\ paths\\ only,\\ no\\ worktrees\\)\\.$", "positiveGroups": [1]}},
        {"file": "tests/status-injection.test.js", "footer": {"pattern": "^status-injection tests passed: ([1-9][0-9]*)/\\1$", "positiveGroups": [1]}},
        {"file": "tests/health-invariants.test.js", "footer": {"pattern": "^health\\-invariants:\\ ([1-9][0-9]*)\\ checks\\ passed$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/backup-duty.test.js", "footer": {"pattern": "^passed\\ ([1-9][0-9]*)$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
        {"file": "tests/supervision-policy.test.js", "footer": {"pattern": "^supervision\\-policy:\\ ([1-9][0-9]*)\\ checks\\ passed$", "positiveGroups": [1], "countPattern": "^  ok  ", "countGroup": 1}},
      ],
    },
    {
      id: 'engine:delegation-runner', command: ['node', 'tests/delegation/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/delegation/adapter-contracts.js', footer: { exact: 'delegation adapter contracts: all tests passed' } },
        { file: 'tests/delegation/uac-delegation.js',
          footer: { exact: 'OK: owner principal accepts real Windows account names (non-ASCII) and still refuses argv-breaking characters' },
          requiredLines: [
            'OK: elevated helper pipe explicitly permits transport across the owner integrity boundary',
            'OK: allowlist parse rejects unknown keys, unknown executables, and stray placeholders',
            'OK: shipped config/uac-delegation-allowlist.json is an empty fail-closed authority set',
            'OK: accept executes the allowlisted op and writes a signed decision + outcome audit',
            'OK: wrong token is refused, never executes, and is audited',
            'OK: a valid token with a non-allowlisted operation is refused and audited',
            'OK: the kill switch blocks an otherwise-valid operation and is audited',
            'OK: fail-closed when the decision audit cannot be written',
            'OK: per-boot token mints (owner-only ACL), reads back for the same boot, and refuses a stale one',
            'OK: a token read failure is refused rather than collapsed into an absent token',
            'OK: named-pipe listener collision reports a sanitized code and nonzero task result',
            'OK: named-pipe round trip accepts/refuses correctly and audits every request',
            'OK: Full UAC Bypass integration point -- kill switch gate, fail-closed decision audit, best-effort outcome audit, not on the standing allowlist',
          ] },
        { file: 'tests/delegation/uac-delegation-client.js', footer: { pattern: '^UAC delegation client tests passed \\(([1-9][0-9]*) checks\\)\\.$', countPattern: '^OK: ', countGroup: 1 } },
      ],
    },
    {
      id: 'engine:digest-runner', command: ['node', 'tests/owner.digest/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/agent-digest-schedule.js', footer: { pattern: '^Agent digest schedule tests passed \\(([1-9][0-9]*) checks: never-double-send and no-backlog-replay proven directly\\)\\.$', countPattern: '^  ok ', countGroup: 1 } },
        { file: 'tests/agent-digest-lock.js', footer: { pattern: '^Agent digest lock tests passed \\(([1-9][0-9]*) checks: the cross-process double-tick race is closed\\)\\.$', countPattern: '^  ok ', countGroup: 1 } },
        { file: 'tests/agent-digest.js', footer: { pattern: '^Agent digest tests passed \\(([1-9][0-9]*) checks: tick invariants, honest meters, declared-vs-observed, in-process Gmail\\)\\.$', countPattern: '^  ok ', countGroup: 1 } },
        { file: 'tests/owner-delivery.js', footer: { pattern: '^Owner delivery tests passed \\(([1-9][0-9]*) checks: one channel setting, one surviving channel, honest-unknown, truncation, failure surfacing, Duo relay credential discipline\\)\\.$', countPattern: '^  ok ', countGroup: 1 } },
        { file: 'tests/agent-digest-config-absence.test.js', footer: { pattern: '^Agent digest config-absence tests passed \\(([1-9][0-9]*) checks\\)\\.$', countPattern: '^  ok ', countGroup: 1 } },
      ],
    },
    {
      id: 'engine:iphone-readiness-runner', command: ['node', 'tests/providers.iphone.handoff/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/providers.iphone.handoff/iphone-handoff.js', footer: { exact: 'iPhone handoff status tests passed.' } },
        { file: 'tests/iphone-handoff-runtime-boundary.test.js', tap: true },
      ],
    },
    {
      id: 'engine:billing-runner', command: ['node', 'tests/providers.billing/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/providers.billing/billing-provider.js', footer: { exact: 'Billing provider tests passed.' } },
        { file: 'tests/providers.billing/license-provider.js', footer: { pattern: '^license-provider: ([1-9][0-9]*) passed, 0 failed$', countPattern: '^PASS ', countGroup: 1 } },
        { file: 'tests/providers.billing/hosted-relay-entitlement.js', footer: { pattern: '^hosted-relay-entitlement: ([1-9][0-9]*) passed, 0 failed$', countPattern: '^PASS ', countGroup: 1 } },
      ],
    },
    {
      id: 'engine:code-intel-runner', command: ['node', 'tests/code.intel/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/code.intel/code-intel.js', footer: { pattern: '^Semantic code intelligence \\(LSP\\) tests passed: ([1-9][0-9]*) assertions in [0-9]+ ms\\.$', positiveGroups: [1] } },
        { file: 'tests/code-intel-containment.test.js', tap: true },
        { file: 'tests/mcp-contract.js', footer: { pattern: '^mcp contract: ([1-9][0-9]*) checks passed$', positiveGroups: [1] } },
        { file: 'tests/code.intel/allowlist.test.js', tap: true },
        { file: 'tests/capability-recall/allowlist.test.js', footer: { exact: 'capability-recall allowlist behavior tests passed' } },
        { file: 'tests/code.intel/gemini-mcp-profile.js', footer: { pattern: '^Gemini MCP profile tests passed \\(([1-9][0-9]*) exposed tools, ([1-9][0-9]*) semantic code tools\\)\\.$', positiveGroups: [1, 2] } },
      ],
    },
    {
      id: 'engine:gateway-runner', command: ['node', 'tests/providers.gateway/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/providers.gateway/cli-provider-gateway-state.js', footer: { exact: 'Provider executable lookup uncertainty and cache distinction test passed.' }, requiredLines: ['Provider state absence versus unreadability distinction test passed.'] },
        { file: 'tests/providers.gateway/gemini-agentic.js', footer: { exact: 'Gemini agentic lane tests passed.' } },
        { file: 'tests/providers.gateway/vertex-gemini.js', footer: { exact: 'vertex-gemini silent-catch distinction test passed (no provider was invoked).' } },
        { file: 'tests/providers.gateway/vertex-gemini-strong.js', footer: { pattern: '^vertex-gemini-strong contract tests passed \\(([1-9][0-9]*) assertions; no provider was invoked\\)\\.$', positiveGroups: [1] } },
        { file: 'tests/providers.gateway/vertex-gemini-seat.js', footer: { pattern: '^Vertex Gemini seat provider contract tests passed \\(([1-9][0-9]*) assertions; no provider was invoked\\)\\.$', positiveGroups: [1] } },
      ],
    },
    {
      id: 'engine:browser-contract-runner', command: ['node', 'tests/desktop.browser/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/desktop.browser/agent-browser-contract.js', footer: { exact: 'agent-browser-contract tests passed.' } },
        { file: 'tests/desktop.browser/agent-browser-operations.js', footer: { exact: 'agent-browser-operations tests passed.' } },
        { file: 'tests/desktop.browser/agent-browser-lifecycle.js', footer: { exact: 'agent-browser-lifecycle tests passed.' } },
        { file: 'tests/desktop.browser/agent-browser-shell.js', footer: { exact: 'agent-browser-shell tests passed.' } },
        { file: 'tests/desktop.browser/browser-owner.js', tap: true },
        { file: 'tests/desktop.browser/browser-account-selection.test.js', footer: { exact: 'Dedicated browser Google-account routing tests passed.' } },
        { file: 'tests/desktop.browser/playwright-gateway.js', footer: { exact: 'Playwright gateway intent/outcome tests passed.' } },
        { file: 'tests/desktop.browser/playwright-call.js', footer: { exact: 'Playwright one-shot fallback client tests passed.' } },
      ],
    },
    {
      id: 'engine:state-runner', command: ['node', 'tests/kernel.state/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/kernel.state/state-store.js', footer: { exact: 'state-store tests passed' } },
        { file: 'tests/kernel.state/task-state.js', footer: { exact: 'task state tests passed' } },
        { file: 'tests/kernel.state/state-concurrency.js', footer: { exact: 'Transactional state cross-process tests passed.' } },
        { file: 'tests/kernel.state/task-concurrency.js', footer: { exact: 'task cross-process tests passed' } },
        { file: 'tests/kernel.state/scheduler-state.js', footer: { exact: 'scheduler-state tests passed' } },
        { file: 'tests/kernel.state/scheduler-legacy.js', footer: { exact: 'scheduler-legacy tests passed' } },
        { file: 'tests/kernel.state/scheduler-adapter.js', footer: { exact: 'scheduler adapter tests passed' } },
        { file: 'tests/kernel.state/scheduler-provider.js', footer: { exact: 'scheduler provider tests passed' } },
        { file: 'tests/kernel.state/scheduler-runner.js', footer: { exact: 'scheduler runner tests passed' } },
        { file: 'tests/kernel.state/provider-state.js', footer: { exact: 'Provider transactional-state tests passed.' } },
        { file: 'tests/kernel.state/instagram-saga.js', footer: { exact: 'Instagram saga tests passed.' } },
        { file: 'tests/kernel.state/agent-coord-integrity.js', footer: { exact: 'agent-coord-integrity proof passed' } },
      ],
    },
    {
      id: 'engine:misc-provider-runner', command: ['node', 'tests/providers.misc/run.js'], reporter: 'engine:isolated-transcript',
      isolatedReports: [
        { file: 'tests/providers.misc/doc-intel.js', footer: { pattern: '^doc-intel tests passed \\(([1-9][0-9]*) checks\\)\\.$', positiveGroups: [1] } },
        { file: 'tests/providers.misc/host-control.js', footer: { exact: 'host-control tests passed.' } },
        { file: 'tests/canonical-path.js', footer: { exact: 'canonical-path tests passed.' } },
      ],
    },
    {
      id: 'engine:naming-policy', command: ['node', 'tools/check-naming.js'], reporter: 'engine:naming-policy',
      // This preserves the existing named interface/naming policy. It is not
      // an assertion-failure baseline and contributes no executed test cases.
      measuredInputs: ['config/naming-baseline.json'],
    },
    {
      id: 'engine:invocation-policy', command: ['node', 'tools/invocation-guard.js'], reporter: 'engine:invocation-policy',
      measuredInputs: ['config/invocation-registry.json', 'config/invocation-production-classification.json'],
      optionalMeasuredInputs: ['state/test-runs/latest.json'],
    },
    {
      id: 'engine:generated-mirrors', command: ['node', 'tools/generate-mirrors.js', '--check'], reporter: 'engine:generated-mirrors',
      measuredInputs: ['adapters/claude/mcp.json.example', 'adapters/gemini/settings.json.example', 'config/managed-processes.json'],
    },
    {
      id: 'engine:capability-index', command: ['node', 'tools/build-capability-index.js', '--check'], reporter: 'engine:capability-index',
      measuredInputs: ['config/capability-index.json', 'config/actions.json', 'config/objects.json', 'config/phrases.json'],
    },
    {
      id: 'engine:memory-runner', isolatedRunner: true, command: ['node', 'tests/memory/run.js'], reporter: 'engine:memory-assertion-file',
      requiredFiles: ['tests/memory/memory-provider.js'],
    },
    {
      id: 'engine:evidence-runner', isolatedRunner: true, command: ['node', 'tests/evidence/run.js'], reporter: 'engine:evidence-assertion-file',
      requiredFiles: ['tests/evidence/evidence-store.js'],
    },
    {
      id: 'engine:kernel-runtime-runner', isolatedRunner: true, command: ['node', 'tests/kernel.runtime/run.js'], reporter: 'engine:kernel-runtime-runner',
      leafReports: [
        { file: 'tests/kernel.runtime/schema-validator.js', markers: [{ exact: 'Schema validator tests passed.' }] },
        { file: 'tests/proc-run.js', markers: [{ pattern: '^proc-run tests passed \\((\\d+) checks\\)\\.$', positiveGroups: [1] }] },
      ],
    },
    {
      id: 'engine:kernel-policy-runner', isolatedRunner: true, command: ['node', 'tests/kernel.policy/run.js'], reporter: 'engine:kernel-policy-runner',
      leafReports: [
        { file: 'tests/kernel.policy/runtime-security.js', markers: [{ exact: 'Runtime security tests passed.' }] },
        { file: 'tests/vault-platform-unsupported.test.js', markers: [
          { exact: 'PASS platform boundary refuses Linux (actual platform: win32)' },
          { exact: 'PASS runtime.getSecret -> SECRET_VAULT_PLATFORM_UNSUPPORTED' },
          { exact: 'PASS runtime.secretExists -> SECRET_VAULT_PLATFORM_UNSUPPORTED' },
          { exact: 'PASS runtime.readSecretsFromVault -> SECRET_VAULT_PLATFORM_UNSUPPORTED' },
          { exact: 'PASS vaultRecordPresence -> unsupported unknown (never absent)' },
          { exact: 'PASS secretStore.inventory -> SECRET_VAULT_PLATFORM_UNSUPPORTED' },
          { exact: 'PASS all five seams attempted zero process spawns' },
        ] },
      ],
    },
    {
      id: 'engine:auth-duo-runner', isolatedRunner: true, command: ['node', 'tests/auth.duo/run.js'], reporter: 'engine:auth-duo-runner',
      measuredInputs: ['tools/duo-desktop-approve.ps1', 'tools/ucr-login.js'],
      leafReports: [
        { file: 'tests/auth.duo/duo-desktop.js', markers: [{ exact: 'Duo Desktop provider tests passed.' }] },
        { file: 'tests/auth.duo/ucr-sso.js', markers: [{ exact: 'UCR SSO Duo Desktop tests passed.' }] },
      ],
    },
    {
      id: 'engine:auth-google-runner', isolatedRunner: true, command: ['node', 'tests/auth.google/run.js'], reporter: 'engine:auth-google-runner',
      // doctor() still uses the real diagnostic and isolated vault. Do not
      // supply an account profile, admit extra CLIs, or replace its dependencies.
      measuredInputs: ['tools/google-oauth-login.js', 'config/toolsenabled.policy.json', 'config/model-floor.json', 'config/settings-registry.json'],
      leafReports: [
        { file: 'tests/auth.google/google-oauth-login.test.js', markers: [{ exact: 'Google OAuth default-account routing tests passed.' }] },
        { file: 'tests/auth.google/google-account-readiness.test.js', markers: [{ exact: 'Google account-aware doctor/status readiness tests passed.' }] },
      ],
    },
    {
      id: 'engine:github-runner', isolatedRunner: true, command: ['node', 'tests/providers.github/run.js'], reporter: 'engine:github-runner',
      leafReports: [{ file: 'tests/providers.github/github-provider.js', markers: [{ exact: 'GitHub provider tests passed.' }] }],
    },
    {
      id: 'engine:provider-inputs-runner', isolatedRunner: true, command: ['node', 'tests/providers.infrastructure/run.js'], reporter: 'engine:provider-inputs-runner',
      leafReports: [{ file: 'tests/providers.infrastructure/provider-inputs.js', markers: [{ exact: 'Provider input tests passed.' }] }],
    },
    {
      id: 'engine:service-control-runner', isolatedRunner: true, command: ['node', 'tests/providers.launch/run.js'], reporter: 'engine:service-control-runner',
      measuredInputs: ['config/uac-delegation-allowlist.json'],
      leafReports: [{ file: 'tests/providers.launch/service-control.js', markers: [
        { exact: 'OK: a clean restart is verified against the NEW pid and its start time' },
        { exact: 'OK: a port still served by the pre-restart pid is reported as SERVICE_STALE_LISTENER, not success' },
        { exact: 'OK: a listener whose start time predates the restart is refused even though its pid is new' },
        { exact: 'OK: an unprovable listener identity is reported as inconclusive, not success' },
        { exact: 'OK: a port that cannot be reclaimed fails loudly with the full diagnosis and never starts on top of the orphan' },
        { exact: 'OK: an active kill switch blocks the elevated reap and the restart fails loudly' },
        { exact: 'OK: a measured JARVIS orphan uses its fixed elevated reap then proves a new listener owns port 3888' },
        { exact: 'OK: elevation can be disabled and is then never attempted' },
        { exact: 'OK: elevation omitted by the caller is withheld, and the report says so in those words' },
        { exact: 'OK: only the literal boolean true permits the elevated rung' },
        { exact: 'OK: an unknown elevated outcome stops the ladder instead of guessing' },
        { exact: 'OK: a failed observation is reported as a failure rather than assumed to be a free port' },
        { exact: 'OK: two listeners after a restart is ambiguous and therefore not success' },
        { exact: 'OK: the neutral shipped allowlist grants no elevated service operation' },
        { exact: 'OK: only the known services can be restarted' },
        { pattern: '^Service control tests passed \\(([1-9][0-9]*) checks\\)\\.$', positiveGroups: [1], previousMarkersGroup: 1 },
      ] }],
    },
    {
      id: 'engine:sandbox-runner', isolatedRunner: true, command: ['node', 'tests/providers.sandbox/run.js'], reporter: 'engine:sandbox-runner',
      // contextDigest reads this entire fixed image source, not just JS files
      // under tests/tools/src. Missing source is not an absent Docker skip.
      measuredInputs: ['tools/build-agent-sandbox.ps1', 'docker/agent-sandbox/Dockerfile',
        'docker/agent-sandbox/package.json', 'docker/agent-sandbox/package-lock.json',
        'docker/agent-sandbox/bounded-exec.js', 'docker/agent-sandbox/fixture-server.js', 'docker/agent-sandbox/hold-open.js'],
      leafReports: [{ file: 'tests/providers.sandbox/agent-sandbox.js', markers: [{ exact: 'Agent sandbox provider tests passed.' }] }],
    },
    {
      id: 'engine:research-runner', isolatedRunner: true, command: ['node', 'tests/providers.research/run.js'], reporter: 'engine:research-runner',
      leafReports: [
        { file: 'tests/providers.research/research-hermes.js', markers: [{ exact: 'Hermes research provider tests passed.' }] },
        { file: 'tests/providers.research/research-strong.js', markers: [{ exact: 'Strong local research provider tests passed.' }] },
        { file: 'tests/providers.research/injection-test-suite.js', markers: [
          { exact: 'ok   R5: adversarial injection fixtures processed safely' },
          { exact: 'all injection & measurement tests passed' },
        ] },
      ],
    },
    {
      id: 'engine:web-runner', isolatedRunner: true, command: ['node', 'tests/providers.web/run.js'], reporter: 'engine:web-runner',
      measuredInputs: ['config/toolsenabled.policy.json', 'config/model-floor.json', 'config/settings-registry.json'],
      leafReports: [
        { file: 'tests/providers.web/web.js', markers: [{ exact: 'Web research adapter tests passed (robots, SSRF, redirects, byte cap, kill switch, evidence, SearX retries/provenance).' }] },
        { file: 'tests/providers.web/research-hardening.test.js', markers: [
          { exact: 'ok   H2: shipped research policy validates without error' },
          { exact: 'ok   H2: SearXNG endpoint comes from policy' },
          { exact: 'ok   H4: query intent classifier maps intents correctly' },
          { exact: 'all research hardening tests passed' },
        ] },
      ],
    },
    {
      id: 'engine:retrieval-runner', isolatedRunner: true, command: ['node', 'tests/retrieval/run.js'], reporter: 'engine:retrieval-runner',
      // The reviewed test copies production code into a disposable program
      // root and supplies literal ledger, SQLite and docs fixtures. These
      // source bytes and the shipped settings registry are measured; no owner
      // corpus or persistent checkout cache is a qualification input.
      // Require every observed assertion, including the actual CLI HIT/MISS/
      // UNKNOWN and relocated-ledger path. The old conditional report cannot
      // satisfy this mapping, even if it retains its green terminal count.
      measuredInputs: ['config/settings-registry.json'],
      leafReports: [{ file: 'tests/retrieval/honest-retrieval.test.js', markers: [
        { exact: "  ok  no settings file at all withholds the surface and touches nothing" },
        { exact: "  ok  a non-boolean in the settings FILE is refused by name, and the surface stays withheld" },
        { exact: "  ok  the GATE itself withholds anything that is not exactly true, without trusting the loader" },
        { exact: "  ok  a registry DEFAULT of true cannot enable the surface -- only a user or installer choice can" },
        { exact: "  ok  a source with no settings-registry entry is UNCLASSIFIED and withheld, master toggle notwithstanding" },
        { exact: "  ok  settings-gate blindness census fails closed for every reproduced shape" },
        { exact: "  ok  a real hit cites the exact ledger request that carries the wording" },
        { exact: "  ok  a genuine gap is MISS with exit 3, and says every source was read in full" },
        { exact: "  ok  a source switched OFF turns an empty answer into UNKNOWN, never MISS" },
        { exact: "  ok  a source that cannot be READ turns an empty answer into UNKNOWN, and names the code" },
        { exact: "  ok  a hit still declares what was NOT searched" },
        { exact: "  ok  no outcome other than hit can ever produce exit 0" },
        { exact: "  ok  tools/recall.js exits 5 when the surface is withheld, 2 with no topic" },
        { exact: "  ok  tools/recall.js proves HIT, MISS and UNKNOWN using a disposable real CLI corpus" },
        { exact: "  ok  the CLI renders a withheld answer as WITHHELD and never as an empty result list" },
        { exact: "  ok  tools/recall-index.js refuses to index a withheld source and exits 5" },
        { exact: "  ok  tools/recall-index.js reports 4, not 0, when an enabled source cannot be indexed" },
        { exact: "  ok  tools/recall-index.js refuses a refresh report that omits an enabled source" },
        { exact: "  ok  the ledger is indexed one document PER REQUEST, not as one file" },
        { exact: "  ok  a secret-shaped line in a verbatim never reaches the index" },
        { exact: "  ok  the index self-heals: a request added after the first query is found by the second" },
        { exact: "  ok  an unwritable index falls back to memory and still answers correctly" },
        { exact: "  ok  the query tokenizer splits the way FTS5 unicode61 splits, so a term can never be unfindable" },
        { exact: "  ok  docs results come from the prior-work index and are NOT copied into the FTS store" },
        { exact: "  ok  an UNKNOWN from the delegated index propagates as UNKNOWN, not as an empty docs corpus" },
        { exact: "  ok  meaning search OFF says so, and keyword ranking is what ran" },
        { exact: "  ok  meaning search ON with no backend installed reports UNAVAILABLE in the answer, and still answers" },
        { exact: "  ok  a registered, available backend actually re-ranks and is named" },
        { exact: "  ok  a backend that invents a result is refused and the baseline order is kept" },
        { exact: "  ok  a backend that duplicates one result and drops another is refused" },
        { exact: "  ok  registerBackend refuses a backend that is not gated by a retrieval.* control" },
        { exact: "  ok  surface-off and every-source-off are reported as DIFFERENT reasons" },
        { exact: "  ok  the master toggle is a fence: an ON source under an OFF surface is still withheld" },
        { exact: "  ok  decideToggle distinguishes unclassified from withheld" },
        { exact: "  ok  every registered source names a control that exists in the shipped settings registry" },
        { pattern: '^R1246 retrieval: all ([1-9][0-9]*) behavioural checks passed\\.$', positiveGroups: [1], previousMarkersGroup: 1 },
      ] }],
    },
    {
      id: 'engine:search-runner', isolatedRunner: true, command: ['node', 'tests/search/run.js'], reporter: 'engine:search-runner',
      measuredInputs: ['config/toolsenabled.policy.json', 'config/model-floor.json', 'config/settings-registry.json'],
      leafReports: [{ file: 'tests/search/search.js', markers: [{ exact: 'Semantic search tests passed (search.index, search.query, search.status).' }] }],
    },
    {
      id: 'engine:vertex-report-shim', command: ['node', 'tests/run-vertex-report-wave.js'], reporter: 'engine:vertex-report-shim',
      measuredInputs: ['docs/GEMINI-FLEET-REPORT-CONTRACT.md'],
      // The compatibility shim executes this actual local assertion program.
      // Its reported counter is 100; count one leaf, not 100 invented cases.
      leafReports: [{ file: 'tests/tools.misc/run-vertex-report-wave.js', markers: [
        { pattern: '^run-vertex-report-wave tests passed \\(([1-9][0-9]*) checks\\)\\.$', positiveGroups: [1], exactGroups: { 1: 100 } },
      ] }],
    },
    {
      id: 'engine:models-runner', isolatedRunner: true, command: ['node', 'tests/models/run.js'], reporter: 'engine:models-runner',
      measuredInputs: ['config/model-floor.json', 'config/agent-allotment.json', 'src/lib/tool-registry.js', ...MODEL_DECLARATION_INPUTS],
      // checkDeclarationDrift reads the file paths in the real floor document.
      // Reconcile that closed source-input set before a product child can read
      // it; never resolve an arbitrary path supplied by candidate JSON.
      declaredPathInputs: [{ file: 'config/model-floor.json', property: 'declarationSites', paths: MODEL_DECLARATION_INPUTS }],
      leafReports: [
        { file: 'tests/models/model-floor.js', markers: [
          { pattern: '^Model-floor tests passed \\(([1-9][0-9]*) checks; below-floor \\+ unknown \\+ non-servable models refuse, no purpose including planning buys an exception, and zero live sites contradict the floor\\)\\.$', positiveGroups: [1], exactGroups: { 1: 21 } },
        ] },
        { file: 'tests/models/model-picker.js', markers: [{ exact: 'Model picker tests passed.' }] },
        { file: 'tests/models/model-provider.js', markers: [{ exact: 'Model provider tests passed.' }] },
        { file: 'tests/models/model-role.js', markers: [
          { pattern: '^Model role tests passed \\(([1-9][0-9]*) assertions\\)\\.$', positiveGroups: [1], exactGroups: { 1: 68 } },
        ] },
        { file: 'tests/models/cli-session-usage.js', markers: [{ exact: 'CLI session usage tests passed (dedup, cumulative-total, incremental cursor, content containment).' }] },
      ],
    },
  ],
  shared: [{ id: 'shared:runner', command: ['node', 'run-tests.js'], reporter: 'source-tests' }],
  scribe: [{ id: 'scribe:runner', command: ['node', 'test/run-tests.js'], reporter: 'source-tests' }],
  'web-editor': [{ id: 'web-editor:runner', command: ['node', 'run-tests.js'], reporter: 'source-tests' }],
  'presentation-suite': [{ id: 'presentation-suite:runner', command: ['node', 'run-tests.js'], reporter: 'source-tests' }],
});
// Fixed child inputs of reviewed package runners. A runner that names an
// absent assertion file retains that defect independently of its command
// mapping; an unrelated replacement file cannot discharge the obligation.
export const SOURCE_RUNNER_REQUIREMENTS = freeze({
  engine: [{ runner: 'tests/code.intel/run.js', requiredFiles: ['tests/code.intel/code-intel.js',
    'tests/code-intel-containment.test.js', 'tests/mcp-contract.js', 'tests/code.intel/allowlist.test.js',
    'tests/capability-recall/allowlist.test.js', 'tests/code.intel/gemini-mcp-profile.js'] },
  // One host executes one fixed leaf. Both remain exact-source inputs and
  // required paired acceptance; this census does not qualify the dispatcher.
  { runner: 'tests/key-custody/run.js', requiredFiles: [
    'tests/linux-vault.test.js', 'tests/vault-native.test.js',
  ], requiredPlatforms: {
    linux: ['tests/linux-vault.test.js'], win32: ['tests/vault-native.test.js'],
  } },
  // The retired Telegram relay is not a native desktop contract. Retain every
  // current platform's actual desktop suites, even on the companion OS. This
  // inventory is a prerequisite, not evidence of native execution; the runner
  // remains an unmapped required action until its native observer is qualified.
  { runner: 'tests/desktop.native/run.js', requiredFiles: [
    'tests/linux-desktop.test.js', 'tests/linux-desktop-ask.test.js', 'tests/linux-desktop-temp.test.js',
    'tests/desktop-advanced.js', 'tests/desktop-app-capture.js', 'tests/desktop-window-close-guard.js',
  ], requiredPlatforms: {
    linux: ['tests/linux-desktop.test.js', 'tests/linux-desktop-ask.test.js', 'tests/linux-desktop-temp.test.js'],
    win32: ['tests/desktop-advanced.js', 'tests/desktop-app-capture.js', 'tests/desktop-window-close-guard.js'],
  } }],
});
export const SOURCE_MANIFESTS = freeze({
  "app": {
    "inventory": [
      {
        "file": "tools/test/a11y-name-and-focus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/a11y-reparse-probe-diagnostics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-desktop-blocked-names.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-desktop-streams.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-desktop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-document.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-shell.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-speech.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-ui-display-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/accessibility-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-allowance-buckets-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-allowance-buckets.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-browser-wait.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-cart-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-field-contrast.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-first-run-guidance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-first-run-release-census.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-form-refusal-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-isolation-leak-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-isolation-qa-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-markup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-mutation-finalization-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-panel-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-recovery-coordinator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-recovery-retirement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-registry-list-async.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-registry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-reset-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-reset-main.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-reset-platform-guidance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-retry-regressions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-session-recovery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-switcher-dom.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-switcher-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-usage-signin-invalidation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account-view-refresh-ownership.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/account.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/action-path-execution-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/action-permission-profile-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/action-permission-settings-default.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/actions-interrupt-result.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/active-route-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-api-setting-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-api-setting.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-availability-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-chat-column-floor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-chat-floor-drag-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-close-is-not-a-failed-turn.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-codex-cli-precondition.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-command-surface.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-compose-panel.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-confinement-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-confinement-provider.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-confinement-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-control-target.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-detail-selection-timing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-dispatch-packaged-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-event-main-lag-attribution.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-facade.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-files-panel.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-files-unstatable-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-files-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-files.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-history-channel.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-history-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-acp-tier.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-answer-approval-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-bounded-work.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-goal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-interrupt-cleanup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-local-instructions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-local-tier.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-local-turn-completion-ordering.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-modes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-provider-spawn-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-readiness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-real-start-cancellation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-requires-resume.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-research-restriction.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-smoke.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-start-admission.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-start-cancellation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host-thread-transitions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-lifecycle-caller-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-lifecycle-tree-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-local-message-host-seam.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-loops.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-manager-outage-continuation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-memory-admission.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-message-delivery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-notifications.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-org-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-page-paste-attachment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-page-paste-send.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-page-session-owner.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-qa-machine-record-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-really-starts-proof.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-removal-rule.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-reset-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-resource-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-roster.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-route-self-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-runtime-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-end-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-events.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-failure-details.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-panel.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-registry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-rejected-start-retry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-resource.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-standalone-approvals.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-steering.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-stop-during-start.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-stop-progress-indicator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-surface.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session-transcript.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-start-audit-race.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-start-chosen-workspace.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-start-flow-launch-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-start-flow-session-attachment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-start-outcome.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-teams.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-thinking-aside.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-tool-allowlist.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-tool-states.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-tools-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-tools-save-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-tree-parent-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent-turn-options.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/agent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/app-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/app-shutdown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/appearance-persistence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approval-cancellation-display.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approval-flow-answerable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approval-outcomes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approval-transcript-persistence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals-banner-clears.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals-example-marking.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals-example-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals-example.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals-screen.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/approvals.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/arm-press.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-adapter-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-asar-sidecar.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-dependencies.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-seal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-source-offline.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/artifact-toolchain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/asar-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/assistant-config-chosen-only.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/assistant-config-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/astra-native-acceptance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/audit-identity-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/audit-identity-settings-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/audit-performance-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/audit-repair-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/audit-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/automatic-image-recovery-boundary-registration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/automatic-image-recovery-owner-cleanup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/b3-approval-two-doors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/b3-rail-chat-buildchat-fork.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/b3-turnstamp-real-send-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/b3-working-step-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/blank-tree-role.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bob-end-to-end.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bootstrap-fence-link-inside-the-profile.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bounded-child-thinking-depth.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bounded-work-manual-stop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bounded-work-stop-not-completed.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/brand-mark.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bridge-api-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bridge-env-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bridge-prep-retries.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bridge-proof.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/bridge-retry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/build-receipt.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-audit-cache.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-audit-thread.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-audit-unreadable-is-not-absent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-ledger-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-presence-fixture.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/canonical-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-index-pack-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-layer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-path-environment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-probes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-recall-injection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capability-source-git.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/capture-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-action-run-overlap.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-action-stream.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-actions-back-focus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-actions-open-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-actions-palette-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-actions-substage-focus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-actions-typed-command.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-activity-durations-collapse.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-agent-bridge-gated.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-approval-strip.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-approvals-inline.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-attachment-chips.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-code-fence-language-label.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-common-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-composer-chips.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-composer-queue-recall.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-composer-shift-tab.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-composer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-context-chips.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-context-row-shrink-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-control-coverage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-dense-card-css.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-diffs-durable-storage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-drive-module.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-drive-selectors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-enter-repeat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-expand-full.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-final-after-tools.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-fold-clusters.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-formatting-bar.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-handler-forwarding.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-history-drive-painted-check.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-history-drive-start-selector.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-history-shadowing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-image-delivery-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-image-queue-presentation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-inline-diff-card.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-markdown-list-breathing-room.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-markdown-list-start-number.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-markdown-mark-bounded.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-markdown-nested-lists.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-markdown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-mention-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-message-body.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-message-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-message-timestamps.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-msg-footer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-msg-markdown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-msg-text-newlines.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-msg-trailing-margin.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-one-popover.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-output-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-owner-line-precedes-its-reply.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-panel-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-paste-attachment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-paste-file-item.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-patch-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-pending-start-reason.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-preformatted-bounds.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-queue-doors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-queue-required.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-queued-model-switch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-readable-chunks.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-readable-stream.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-reading-measure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-real-data-header.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-rail-live-replay.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-reply-user-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-search-escape.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-stream-code-blocks.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-stream-live-mark.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-stream-min-height.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-stream-pending-conversion.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-streaming-stability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-agent-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-agent-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-behaviors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-phone-sheet.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-rail-chat-tab.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-rail-chat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-surface-tree-card.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-token-ratchet.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-transcript-negative-margin-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-turn-stamps.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-whole-output-currentness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-working-live-counters.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chat-working-row-step.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chatbox-feed.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/chatbox-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-artifact-private.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-asar-manifest.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-browser-proofs-discovered.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-composed-output.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-data-schemas.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-dco.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-declaration-privacy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-deep-walk-due.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-dist-current.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-download-wire.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-drivers-discovered.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-electron-runtime-files.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-environment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-github-claims.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-install-dir-immutable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-license-notices.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-no-owner-data.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-no-profile-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-payload-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-payload-current.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-plain-language.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-preview-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-product-naming.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-release-notes-platform-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-release-notes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-renderer-payload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-research-queue.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-settings-rows-declared.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-subscription-claims.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-suites-discovered.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-test-inputs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/check-unbound-identifiers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-catalog.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-principal-vault.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-principal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-privacy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-selection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout-visibility.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/checkout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/claim-lifetime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/claude-warning-tracks-legal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-account-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-command-actions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-command.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-launch-binding.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-mirror-core.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-mirror-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-task-diff.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-tasks-controller.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cloud-tasks.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/codex-astra-tier.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-channel-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-chat-scroll.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-poll-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-preview-metadata.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-quiet-notice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms-view-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comms.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/comp-rail-default-width.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/components.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/compose-layout-css.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/compose-repeat-start-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/compose-start-rail-preservation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/compose-turn-it-on-drive-outcome.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/compose-turn-it-on.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composed-output.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composer-error-clarity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composer-queue-failure-code.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composer-queue-recall.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composer-send-failure-code.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composer-status-tick-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/composited-page-measure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers-account-door.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers-image-recovery-one-send.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers-image-selection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers-manual-move-org-sync.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers-press-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/computers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/confinement-subject.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/connect-computer-repairs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/connect-computer-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/connect-computer-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/console-window-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/control-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/corona-gl.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/crash-dumps.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/create-and-start-node.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/crescent-field.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/crescent-mount.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/crescent-render.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/crescent-worker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/css-custom-property-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/custom-packaged-stage-routing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-account-home-exemption.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-check-drive-hung-provider.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-decision-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-dist-chain-environment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-environment-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-linux-release-candidate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-linux-release-platform-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-payload-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-powershell-module-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-qualification-context-preflight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-seal-record-exit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/cut-windows-short-temp-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/data-schema-coverage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/data-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/dead-session-recovery-blocked-replacement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/dead-session-recovery-second-send.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/declaration-preflight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/declaration-privacy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/declared-fleet.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/declared-function-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desk-phrase-remote-twin.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-file-opener.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-journeys-toolsenabled.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-late-person-turn-order.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-person-turn-display.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-session-nonce-roundtrip-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-sessions-relay-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-sessions-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-stop-consumer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-tree-authority.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/desktop-tree-live-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/dev-hotload-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/development-build-temp.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/development-process.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/development-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/development-socket-temp.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim-flow.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim-owned-completion.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim-owned-process.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim-process-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim-reservation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/device-claim.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diagnostic-files-reach-the-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diagnostic-files-real-service.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diagnostic-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diagnostic-retention-integration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diagnostic-retention-row-says-what-cleanup-does.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-content-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-editor-pick-click.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-editor-settings-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-editor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-file-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-file-selection-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-file-selection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-presentation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-review-content.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/diff-session-scope-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/dispatch-assistant-config.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/disposable-guest-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/disposable-guest-toolchain-routing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/disposal-teardown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/dom-stand-in.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/download-wire.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/draft-image-coordinator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/draft-image-main-integration-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/drag-cannot-get-stuck.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/drain-outbox-after-removal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/drawer-body-scroll.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/durable-image-custody.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/durable-storage-enumeration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/durable-storage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/echarts-theme.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/editor-attachment-drafts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/editor-session-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/electron-fuse-policy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/electron-node-handoff.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/electron-run-as-node-harness-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/empty-envelopes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/engine-model-catalog.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/engine-performance-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ensure-seat-for-node-manager.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/exact-amount.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/example-reparent-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/false-success-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feature-guide-names-every-profile.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feature-guides-a11y.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feature-guides-resolve.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feature-guides.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feedback-compose.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/feedback-proxy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/file-identity-large-inode.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/filed-rule-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/filed-rule-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-run-contract-errors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-run-needs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-run-recovery-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-run-tier-screen.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-turn-notes-survive-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/first-use-intro-placement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-declared-note.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-every-tree-clears-focused-branch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-node-presser.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-overview.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-page-draws-started-sessions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-profile-preload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-profile-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-profile.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-circle-name.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-display-name-collision.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-name-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-persistence-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-persistence-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-tree-projection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-trees-multi.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-trees-save-cost.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fleet-trees.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/focus-keep.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/font-choice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/forced-colors-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/four-defects-drive-recorded-tier.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/frameless-animation-safety.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/free-payload-licensing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/fresh-start-brief-send.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/gate-quarantine.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/generator-failures.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/generic-role-graph.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/getting-started-availability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/github-claims.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/gnome-terminal-acknowledgement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/goal-command.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/goal-indicator-box.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/goal-send-races.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-account.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-oidc.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-signin-config.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-signin-disabled-control.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-signin-erase.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/google-signin.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/guide-route-alias.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/guide-wire-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/guided-step.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/halt-does-not-fire-the-queue.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/halt-standalone-agent-real-interrupt.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/halt-tree-conversation-real-interrupt.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hand-controls-platform-errors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hand-controls-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hand-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/harness-credential-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/heap-guard-erase.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/held-start-waits-and-retries.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/help-page-pages.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/help-page-version-currency.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/helpers/account-buckets-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/account-buckets-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/account-field-contrast-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/account-field-contrast-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/chat-readable-stream-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/chat-readable-stream-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/page2-role-studio-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/risk-gate-focus-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/risk-gate-focus-globals.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/risk-gate-focus-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/role-studio-empty-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/role-studio-empty-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/t844-retry-layout-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/t844-retry-layout-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/setup-account-fields-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/setup-account-fields-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/tree-card-compact-electron.cjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/helpers/tree-card-compact-renderer.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/hidden-display-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hidden-rows.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-activity-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-activity-filter-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-activity-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-agent-board.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-agent-workspace.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-composer-draft-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-composer-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-draft-handoff.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-reading.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-route-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-structure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-takeover-scroll.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-takeover.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-chat-window-geometry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-action.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-choice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-finish.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-fluid-cadence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-motion-measure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-motion-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-circle-picture-measure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-composer-redraw-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-composer-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-coordinator-chat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-feed-dense-tokens.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-first-run-full-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-glance-figures.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-glance-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-ledger-poll-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-ledger-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-message-update.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-new-chat-handoff.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-panel-chat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-reading-width.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-remote-session-owner.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-roster-filter.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-screen-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/history-off-is-not-a-failure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-screen.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-status-colors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-tree-filter-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-tree-filter.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-tree-pick.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-turn-surfaces.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-turns.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-workspace-mount-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home-workspace-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/home.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/host-fallback-sentence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/host-transport-race.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-account-client.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-account-controller.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-account-erase.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-account-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-browser-signin.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-device-settings-access.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-session-storage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/hosted-source-recovery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/identity-profile-ownership.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-backend-current.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-backend-custody-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-busy-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-composer-capture.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-composer-durable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-conversation-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-conversation-transfer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-draft-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-host-draft-ingress.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-outbox.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-owner-client.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-owner-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-owner-preparation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-queue-client.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-queue-drain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-recovery-census.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retained-preview.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retention-cleanup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retention-dispatch-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retention-ipc-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retention-service-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/image-retired-source-review-W16.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/install-dir-log-redirect.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/install-immutability-baseline.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/install-operator-purchase-list.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/install-profile-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installed-lifecycle-adapters.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-elevation-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-preflight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-product-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-registration-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/installer-shortcut-launch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/interrupted-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ipc-handler-sync-io.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lane-marks.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lanew-fix-large-thinking.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lanew-fix-stream-follow.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lanew-t20-unqueue-returns-text.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/last-exit-notice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/launch-live.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/launch-outcome-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/launch-readiness-fence-probe.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/launch-readiness-sync-packed-payload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/launch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-archive-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-custody.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-data.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-file-box.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-page-filing-persistence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-purchases.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-read-concurrency.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-reset-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-reset-delayed-outcomes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-row-actions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-rows-remove.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-status-colors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-view-dom.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-words-wrap.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger-write-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ledger.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lib/retained-gate-fixture-root.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/lib/t842-retained-fixture-root.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/license-notices.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/license-trust-anchor-payload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lifecycle-input-check.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-account-launch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-account-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-artifact-deb.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-artifact-permissions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-artifact-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-deb-maintainer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-desktop-icons.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-elf-inputs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-installed-manifest.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-live-dependency-link.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-owned-job.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/linux-terminal-instructions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/literal-template-placeholder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/live-agent-clock.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/live-flags.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/live-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/lo-2b-role-agent-refusal-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-activity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-agent-native-journey.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-data-reset.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-lane-completion-posts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-metrics-usage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-metrics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-model-bridge.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-address-field.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-chooser.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-gpu-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-live-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-placement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-models-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/local-tiers-memo.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-search-path-async-startup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-search-path-unread-registry-retries.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-search-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-steadiness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-switch-remount.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-switch-transaction.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/machine-tabs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-heap-bounds.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-async-span.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-cpu-discriminator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-cpu-gaps.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-monitor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-reset.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main-lag-thread-cpu.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/main.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/managed-slot-choice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/manual-continuation-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mcp-action-row-detail.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-activity-picker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-analysis.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-charts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-footer-history-off.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-history.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-live-charts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-preferences.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-account-observation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-records.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-routing-outcomes-about.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-startup-attribution.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics-usage-attribution.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/metrics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mission-bridge-http.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mission-bridge.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mobile-gap-dead-route-links.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mobile-size-floor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/mock-liveness-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-desktop-stop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-driver-dependencies.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-person-stop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-session-reconnect-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-stop-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/native-stop-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/no-debug-diagnostics-in-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/no-owner-data.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/no-tier-provider-routing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-card-latest-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-chatbox.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-recovery-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-remove.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-session-start-shared-lock.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-transcript-bind-capability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-transcript-client.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-transcript-history.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-transcript-terminal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/node-transcript-turn-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/notification-settings-rows.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/nsis-directed-install-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/nsis-legacy-userdata-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/nsis-upgrade-rescue.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/nsis-upgrade-roundtrip-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/offline-send-recovery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/open-door-follows-selection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/optimized-api-provider-reach.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/orchestration-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/order-variation-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/org-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/org-limit-setting-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/orphaned-node-seat-sweep-loop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/orphaned-node-seat-sweep.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/os-keystore.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/outside-control.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/outside-driver.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owned-fixture-temp.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owned-job-native-profile.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-administration-fixture.mjs",
        "reason": "imported-fixture-helper"
      },
      {
        "file": "tools/test/owner-administration-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-administration-main-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-administration-process.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-administration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-popup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-turn-spool.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/owner-walkthrough-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/pack-capability-layer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/pack-out-directory-reuse.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/pack-owner-profile-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/package-lock-parity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/packaged-platform.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/packaged-profile-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/packaged-qa-current-contracts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/packaged-qa-proof-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/packaged-qa-suite.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page-frames.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page-width-columns.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-account-handoff-fold.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-keep-trying-accounts-menu.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-bounded-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-compose-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-continuation-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-first-use.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-guided-first-use.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-input.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-inputs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-interrupt-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-launch-arguments.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-ledger-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-linux-picker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-permission-readback.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-picker-ownership.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-picker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-preference-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-profile-posture.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-provider-account.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-provider-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-replacement-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-report.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-resource-readiness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-role-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-native-state-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-qa-current-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/page2-saved-conversation-header.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/palette-keyboard-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/palette-rows.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/paste-before-live-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/paste-picture-reaches-the-turn.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/paste-resume-native-acceptance-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/paste-resume-native-acceptance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/pasted-picture-shows-in-your-own-bubble.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-boundary-ship.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-boundary-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-manifest-refs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-self-sufficiency.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/payload-sync-first-build.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/performance-attribution-observation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/performance-retained-compare.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/permission-guidance-tiers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/permission-guidance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phase2-label-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phase2-live-data.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-canvas-ledger-override.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-canvas-stage-box.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-canvas.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-demo-notice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-ledger-sign-in-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/phone-ledger.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/picture-refusal-reaches-the-person.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/picture-too-large-is-refused-before-the-send.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/plain-language.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/port-scan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preflight-dependencies-declared.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/prefs-record-ceiling.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/prefs-refusal-is-visible.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preload-mouse-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preload-namespace-parity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preview-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/preview-simulated-marker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/process-tree.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-account-erase.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-account-surface.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-account.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-setting-rows.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-settings-batch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-settings-unreadable-is-not-absent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/product-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/projection-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/projection-reader-uncertain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-cli-presence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-client-presence-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-free-local-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-image-support.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-login-linux.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-login.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/permission-tier-menu.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/permission-tier-state-handler.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-mode-menu.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-runtime-payload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/provider-session-isolation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/purchase-cart-changes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/purchase-cart-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/qa-driver-process.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/qa-renderer-dist.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/qa-services-root-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/qualification-cmdlet-parameter-sets.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/queue-for-session-ended-session-eager-drain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/quick-settings-build-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/quick-settings-storage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/quick-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/r1238-switch-model-providers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-chat-reading-window-height.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-chrome.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-follows-canvas.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-panel-order.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-resume-tail-keystrokes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-said-markdown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-status-repaint.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rail-title.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/reach-words-are-live.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/read-deadline.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/reader-remedy-coverage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/readiness-adapter-profiles.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recommended-path-packaged-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-handoff-bridge.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-migration-is-wired.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-migration-safety.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-migration-windows-preservation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-upgrade-acceptance-late-drain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-upgrade-acceptance-native-request.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/recovery-upgrade-acceptance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/refusal-copy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/refusal-engine-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/refuse-install-while-electron-runs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/refused-leave-history.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/registered-toolchain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/relay-bridge-transport.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/relay-supervisor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-dependency-isolation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-gates.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-owner-account.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-packager.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-preflight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-qualification.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-readiness-plan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-seal-protocol.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-source-continuation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/release-version-agreement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-account-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-connection-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-connection-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-connection-main-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-desktop-sessions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-desktop-tree-snapshot.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-desktop-tree.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-metrics-facade.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-metrics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-org-snapshot.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-session-history.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-session-reconnect-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-session-reconnect.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/remote-workspace.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-idle-poll.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-ipc-production-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-prefs-maintenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-prefs-remove-many.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-prefs-tree-removal-backup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/renderer-prefs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/request-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/request-contract-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/request-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/require-clean-tree.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-agent-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-assignment-control.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-assignments-local-write-refused.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-assignments.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-activation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-analysis.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-archive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-browser-sources.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-canonical.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-citation-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-composition-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-composition-fields-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-composition-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-composition.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-concurrency.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-fields-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-fields-command-editor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-fields-command.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-fields-editor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-condition-freeze.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-conventions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-corpus-alias.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-corpus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-design.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-dispatch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-endpoint-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-endpoints.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-execution-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-execution-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-execution.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-export-bytes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-exported-project.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-family-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-family-fields-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-family-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-format-violation-classification.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-generator-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-grade-proof.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-hand-test-strings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-information-context-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-information-fields-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-information.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-journal-report-agreement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-journal-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-journal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-layer-map.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-lean.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-model-prices.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-native-admission-limitation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-native-evidence-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-native-preparation-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-node-editing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-observations.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-open-exported-run.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-open-exported.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-operational-study.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-page-execution-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-page-walkthrough.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-pinned-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-population-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-preparation-portable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-preparation-report.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-preparation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-preview-walk.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-price-estimates.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-primary-population.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-proportion-intervals.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-prose-wrapped-program.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-qualification-import.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-readiness-portable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-readiness-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-readiness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-receipts-cli.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-receipts-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-receipts-report.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-recorded-reset-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-recorded-reset.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-registry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-replay-response-grader.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-archive-integrity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-manifest.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-paper.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-protocol-apparatus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-statistics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-report-table-notes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-requirement-fields-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-requirement-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-requirements.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-adversarial.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-effects.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-portable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-template-editor.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-resource-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-runtime-integrity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-runtime.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-scalar-requirements.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-schema-versions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-semantic-answer-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-shrink-proof.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-source-draft-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-source-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-study-version-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-study-version.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-template-allow-lists.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-template-citation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-template-compiler.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-template-preparation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-third-party-admission.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-tool-policy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-topology-fields-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-topology-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-trading.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-v2-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-verification-strings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-versioned-extraction.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-workflow-setup-builder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-workflow-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark-workflow.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-benchmark.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-clean-room-flow.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-compose-routing-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-conditions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-data-chart.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-data-package.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-data-quality.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-data-workspace-arrival.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-delegation-authority.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-delegation-main.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-examples-lazy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-examples.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-experiments.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-finding-details.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-findings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-generator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-generic-docs-links.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-grid.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-information-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-information-fields.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-modules.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-native-evidence-cli.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-native-evidence-verification.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-native-information-observation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-native-preparation-plan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-node-editing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-owner-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-pinned-inputs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-project-activity-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-project-activity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-projects.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-queue-degradation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-queue-schema.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-queue-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-queue-writable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-report-integrity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-result-charts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-routing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-run-completeness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-run.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-runs.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-save-refusal-sentence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-service-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-setting-titles.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-shutdown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-snippets.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-start-consent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-tree-launch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-tree-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-tree-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-view-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-walkthrough-directory-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-workbench.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research-workspace-pointer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/research.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/reset-browser-storage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/reset-cleanup-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resource-basic-mode.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resource-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resource-tree-scale.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/respawn-drops-the-picture.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/restart-getnode-null-after-teardown.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/restart-transcript-reset-real-client.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resume-destroyed-session-leak.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resume-keeps-the-conversation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resume-refuse-by-provider-app.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resume-restart-share-replacement-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/resume-shows-the-conversation-already-running.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/retained-gate-fixture-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/retry-unstarted-node.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rewind-thread-persists.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rewind-thread-resume-integration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/risk-gate-focus.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-colors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-directions-injection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-dispatch-guidance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-function-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-functions-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-studio-empty-directions.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-studio-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-studio-model.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/role-studio-source.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/roster-names-a-declared-solo-agent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/rules-panel-edit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/runtime-clock.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/runtime-duration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/runtime-identity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-accounts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-activity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-comms.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-fleet.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-ledger.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-simulation-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-simulation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-trees.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sample-usage.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sandbox-setup-lease.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sandbox-setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-census.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-composition.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-engine-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-ipc.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-data-maintenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-draft-graph-reader.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-node-status-repair.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/saved-tree-maintenance-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/scratch-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-access-refusal-names-the-cause.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-control-boundaries.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-control-desktop-custody.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-control-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-control-native.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-control-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/screen-stop-chord-agreement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/seal-artifact-provenance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/seal-artifact.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/send-now-reservation-composer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/send-now-reservation-e2e.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/send-now-reservation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/send-refusal-says-what-happened.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-account-report.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-account-rows.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-bridge-control.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-changes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-confinement-plan-order.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-console-history.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-diff-access.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-end-record-drive-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-goal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-launch-environment.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-model-switch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-outbox-durability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-outbox.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-profile-compose-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-profile-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-profile-panel-rendering.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-profiles.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-recovery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-reply-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-roles.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-start-audit-reason.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-surface-paste-hold.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-tier-binding.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-transcript-store.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-basic-numeric-diagnostics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-category-router.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-compare-files-row-reaches-the-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-draft-readback.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-draft-unknown-write.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-enterprise.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-mode.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-multiword-search.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-one-click.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-place-marker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-policy-drafts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-presentation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-profile-applies-whole-preset.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-profile-policy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-profile-reload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-quick-drawer-wins.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-quick-sliders.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-rail-cascade.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-range-touch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-readability-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-recovery-notice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-rows-do-something.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-service-address.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-survive-the-sign-in.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-tier-reachability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings-tool-policy-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-account-field-visibility.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-account-storage-poke.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-cross-control-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-docker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-finish-router-events.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-intent-commit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-permission-level-control.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-phone-fit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-place-loss.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-policy-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-profile-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-profile.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-review-readiness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-skip-confirms.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-unrestricted-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup-workspace-picker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/setup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shared-host-qa-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shell-frame-ancestors.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shell-payload-modules-declared.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shell-port-preferred.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shell-port-scan-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/shell-port-scan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/ship-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/silent-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sim.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/single-flight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/single-instance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/single-start-resource-wait.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/slash-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/smoke-linux-sealed.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/smoke-packaged-capability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/smoke-packaged-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/smoke-packaged-fence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/smoke-packaged.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/source-fixture-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/source-native-custody-action.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/source-retrieval-report.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-text-consumers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/session-text-reader.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/source-role-integration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/spawn-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/spawn-tail-post-open-await.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/spine-defects-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/spine-first-run-defects.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/staged-renderer-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standalone-agent-tools.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standalone-image-consumer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standalone-seat-identity-injection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standalone-switch-coordinator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standalone-switch-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/standing-requests-read.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-control-flag-gates-the-tree.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-doors-gated.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-draft-node-anonymous-reason.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-draft-node-single-flight.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-refusal-copy-honesty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/start-stall-watchdog.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/started-sessions-are-released.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/startup-failure-message.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/startup-fatal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/startup-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sterile-launch-short-tmpdir.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/sterile-launch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/stop-node-race-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/stop-node-session.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/streaming-turn-delivery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/streaming-words-visible.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/strip-build-diagnostics.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscribe-endpoint.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscribe-service.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscribe-view.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscribe.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscription-availability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscription-catalog.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/subscription-signup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/switch-and-continue-target-chat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/switch-model-rows-visible.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t124-account-limit-failover-loop.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1343-draft-retry-policy.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1308-engine-presence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1308-orphan-empty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1308-status-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1308-tree-hints.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1391-computers-details.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1391-computers-geometry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t1391-drop-admission.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t158-cross-provider-model-switch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t158-model-switch-chip-visible.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t158-model-switch-transcript-carry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t17-limit-continuation-notification.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t180-exit-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t52-header-cover.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t52-metrics-width.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t52-tips-control-reachable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t542-pending-model-choice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-catalog.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-cli-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-command-census.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-identity-currentness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-memory.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-mobile-fra-journeys.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-orchestration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-plan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-browser-lifecycle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-journeys.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-release-census.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-result-integrity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-results.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/surface-tests-user-path-evidence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t545-claude-mode-integration-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t545-mode-integration-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t545-native-mode-integration-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t545-standalone-image-binding-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t545-standalone-start-boundary-review.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t59-platform-ipc-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t59-renderer-resume-entry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t775-popup-user-path.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-computers-image-recovery-boundary.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-coordinator-owned-recovery-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-image-recovery-flight-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-image-recovery-handoff-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-image-recovery-real-coordinator-no-image.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t839-image-recovery-real-coordinator.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t842-image-dispatch-guard.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t842-native-mounted-composition.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t842-retained-fixture-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t842-strict-fixture-join.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t843-computers-remount.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t843-navigation-continuity.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t844-retry-compact.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t844-retry-durability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t844-retry-keyboard-readonly.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/t844-retry-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tap-file-level-failure.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/task-ask-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/task-controls-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/task-difficulty.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/terminate-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/terse-detail.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-account-harness-machine-record-product-directory.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-account-harness-process-ownership.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-account-harness-read-json.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-account-harness-staging-mode.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-ratchet.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-scratch-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-strict-linux-prerequisites.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/test-suite-result.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/text-size-window-fit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/theme-choice.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/theme-token-readability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/thinking-transcript-pipeline.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/this-computer-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tier-consent-shell.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tier-consent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tier-session-actor-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tool-summary-injection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tools-account-read-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/topbar-pixel-snap.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/transcript-append-cost.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/transcript-archive-folder.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/transcript-envelope-loss.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/transcript-records-pictures.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-address-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-address-saved-tree-wins.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-approval-pending.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-bounded-audit.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-bounded-controller.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-bounded-work.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-box-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-card-box-height-agreement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-card-compact-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-card-selected-chat-currentness-real-mount.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-card-thinking-slot.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-chat-drafts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-chat-palette-draft.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-chat-resume-stream.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-chat-surfaces.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-chat-transcript.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-child-capacity-affordance.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-child-capacity-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-clamp-reachability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-command-projection-ready.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-command-refusal-reason.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-compose-retry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-connector-bus-radius.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-context-box-memory.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-context-box-persistence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-context-box-storage-events.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-context-cards.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-context-size.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-courier-batch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-courier-main-lag-attribution.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-courier-round.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-default-draft-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-delegation-authority.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-delegation-cleanup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-delivery-failure-receipt.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-delivery-out-of-chat.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-directory-tree-key.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-drag-autopan-fetch.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-drag-autopan-off-axis.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-drag-band.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-drag-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-drag-edge-pan.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-edges-name-stability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-edit-detach.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-edit-picker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-edit-roundtrip.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-empty-turn-transcript.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-engine-row.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-folder-menu-missing.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-folder-not-saved.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-graph-card-copy-wrap.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-graph-chat-card-width.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-graph.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-handoff-transient-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-heartbeat-recovery.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-identity-real-directory.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-interactions-vite-config.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-keyboard-pan-steering.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-launch-queue.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-layout-contract.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-layout.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-lifecycle-authority.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-lifecycle-main.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-link-cleanup.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-link-marker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-manager-brief-drive.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-brief.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-broker.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-clean-gate.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-drain.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-fresh-start-behavior.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-handoff-driver.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-projection-bound.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-recovery-wait.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-command.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-keyboard-click-race.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-name-fallback.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-removal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-run-clock.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-node-settle-wait.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-predecessor-inbox.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-preview-tail.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-queue-retirement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-rail-details-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-rail-draft-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-rail-rebind.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-rail-transcript-hydration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-readability.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-register-retry.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-remove-runtime-readback.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-reply-surface.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-request-refresh.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-decision-names-both.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-decision-renderer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-decision.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-rebind.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-reparent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-resume-transcript.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-retry-start-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-reusable-slots.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-runtime-controls.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-session-liveness.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-set-then-start.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-shared-strokes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-account-selection.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-admission.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-configuration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-managed-commands.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-native-integration.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-slot-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-smart-navigation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-adoption.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-agent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-binding-start-order.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-draft-registration-context.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-page-binding.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standalone-placement.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-standing-requests.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-start-cleanup-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-start-persistence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-start-route-outcome.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-turn-busy-race.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-turn-marks-running.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-turn-priority.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-width-four.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-windows-restore.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-zoom-controls-linux.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/tree-zoom-drill-reachable.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/turn-failure-status.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/turn-interrupts.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/uac-neutral-default.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/unbound-identifiers.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/uninstall-removes-service-root.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/uninstall-retention-account-scope.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/uninstall-retention.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/unrestricted-consent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/update-check.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/update-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/usage-record-async.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/usage-record-wiring.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/usage-record-write-async.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/usage-record.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/userdata-adoption.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-credential-approval.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-credential-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-credentials-settings.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-host-payload.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-manager-staged.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-page.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-presence.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vault-redesign-regression.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/verify-version-transition.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vocab-role-badges.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vocab.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/vocabulary-derivation.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-audio-visualizer.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-bundle.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-controller.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-duplex.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-host.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-races.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-relay.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-runtime-paths.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-speech-text.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/voice-ui.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/web-drive-consent.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/web-drive-refusal.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/website-account-route.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/window-options.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/window-size-sweep-qa.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/window-size-sweep-text-scale.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/window-state.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/window-zoom.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/windows-toolchain-prerequisites.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/workspace-recovery-mounted.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/write-flags-fail-closed.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/write-flags.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/write-outcomes.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/write-surfaces.test.mjs",
        "reason": null
      },
      {
        "file": "tools/test/zombie-session.test.mjs",
        "reason": null
      }
    ],
    "aliases": {
      "test": "node tools/check-node-version.mjs && node tools/check-test-inputs.mjs && node tools/check-settings-rows-declared.mjs && node tools/check-suites-discovered.mjs && node tools/check-benchmark-core-independent.mjs && node tools/check-drivers-discovered.mjs && node tools/check-browser-proofs-discovered.mjs && node tools/check-unbound-identifiers.mjs && node tools/check-composed-output.mjs && node tools/check-chat-control-coverage.mjs && node tools/check-no-profile-paths.mjs && node tools/check-shipped-source-owner-data.mjs && node tools/check-payload-boundary-reconciled.mjs && npm run test:data",
      "test:boundary-ship": "node --test tools/test/payload-boundary-ship.test.mjs",
      "test:chatbox": "node --test tools/test/chatbox-feed.test.mjs",
      "test:data": "node tools/check-node-version.mjs && node --test --import=./tools/test/lib/isolate-native-state-root.mjs --test-reporter=tap --test-concurrency=1 tools/test/*.test.mjs",
      "test:role-studio-component": "node tools/qa/page2-role-studio-interaction.cjs",
      "test:surface-runner": "node --test tools/test/surface-tests-*.test.mjs",
      "verify": "node tools/test-ratchet.mjs",
      "verify:release": "node tools/test-ratchet.mjs --strict",
      "verify:strict": "node tools/test-strict.mjs"
    }
  },
  "engine": {
    "inventory": [
      {
        "file": "tests/accessibility-functions.test.js",
        "reason": null
      },
      {
        "file": "tests/account-boundary-merge.test.js",
        "reason": null
      },
      {
        "file": "tests/account-choice-proven-before-recorded.test.js",
        "reason": null
      },
      {
        "file": "tests/account-fence-short-names.test.js",
        "reason": null
      },
      {
        "file": "tests/account-handover.test.js",
        "reason": null
      },
      {
        "file": "tests/account-profile-zero-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/account-usage-canonical-consumers.test.js",
        "reason": null
      },
      {
        "file": "tests/action-guards.js",
        "reason": null
      },
      {
        "file": "tests/action-permission-profiles.test.js",
        "reason": null
      },
      {
        "file": "tests/adversarial/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/agent-activity-contracts.js",
        "reason": null
      },
      {
        "file": "tests/agent-api-census-reasons-hold.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-api-mode-compatibility.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-api-modes.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-api-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-approval-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-attribution-projection.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-attribution.js",
        "reason": null
      },
      {
        "file": "tests/agent-browser-lifecycle-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-browser-operation-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-browser-shell-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms-cutover-gate.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms-tool-surface.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker-deferred-handoff.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker-delivered-dead-letter.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker-state-recovery.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker-state-retention.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/broker.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/channel-contract-refusal-reachability.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/channel-contract.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/claims.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/compat-bridge.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/control-plane.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/courier-read-lock-bound.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/cutover-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/delivery-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/delivery.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/fabric-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/fabric.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/helpers/comms-harness.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/agent-comms/helpers/hold-broker-lock.cjs",
        "reason": "Owned broker-lock child; invoked by courier-read-lock-bound.test.js with its lock path and IPC parent."
      },
      {
        "file": "tests/agent-comms/history-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/history-secret-refusal-names-action.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/history.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/home-node.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/identifiers-are-not-credentials.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-deferred-handoff.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-delivery-failure-receipts.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-message-runtime-reuse.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-runtime-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-runtime.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/local-tree-delivery.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/orphan-manager.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/provider-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/provider.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/read-position.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/relay-edge.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/transport-adapter-conformance.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/transport-adapter-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/transport-relay-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/transport-relay.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-address-historical-sender.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-direct-links.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-node-identity.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-recovery-successor.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-refusal-names-the-row.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-restart-supersedes-stale-rows.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-rewind-resume-seam.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-risk-pins.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-scale.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-directory-scope.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-edges-manager-roster.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-node-directory.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-comms/tree-roster-agent-id.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-continuation-acp-success-status.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-continuation-persist-silence.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-continuation-person-stop.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-contract-discovery.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-coord-channel-map.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-channel-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-collect.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-config-absence.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-index.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-lock.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-lock.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-render-digest-kind.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-render-image.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-render.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-schedule.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest-scheduling-status.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest.js",
        "reason": null
      },
      {
        "file": "tests/agent-digest/schedule.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-approval-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-exit-diagnostics.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-mode-selection-races-review.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-mode-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-process.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-provider-isolation.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-shared-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-terminal-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-thinking-stream.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/acp-turn-identity.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/adapter-lifecycle-settlement.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/astra-native-acceptance-structured.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-adapter-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-adapter.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-ambient-key-default.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-cli-adapter-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-cli-adapter.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-cli-image-turn.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-cli-process.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-cli-stderr-durable.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-live-turn.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-mcp-args.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-native-mode-launch.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-native-modes.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-process.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-session-environment.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-start-timeout.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-subscription-credential-fence.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/claude-thinking-stream.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-adapter.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-approval-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-collaboration-modes.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-interrupted-late-events.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-live-turn.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-native-mode-launch.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-native-mode-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-process.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-startup-cancellation.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-steer.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-thread-settings-shape.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/codex-turn-failure-details.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/editor-fork.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/engine-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/fixtures/codex-late-command-peer.js",
        "reason": "Local Codex protocol peer; parent codex-interrupted-late-events.test.js owns its child lifetime and assertions."
      },
      {
        "file": "tests/agent-engine/hidden-spawn-fence.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/hidden-spawn-provider-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/local-node-adapter.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/local-node-tools.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/provider-probe-closure.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/resume-refuse-by-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/root-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-engine/turn-image-bytes.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-lane-dispatch.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-lane-provider-spawn-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-lane-verdict-normalization.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-lane.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-launch-audit.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-lifecycle-tools-registered.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-msg.js",
        "reason": null
      },
      {
        "file": "tests/agent-onboarding-hook-contract.js",
        "reason": null
      },
      {
        "file": "tests/agent-onboarding.js",
        "reason": null
      },
      {
        "file": "tests/agent-org-root-seat.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-org-store.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-org.js",
        "reason": null
      },
      {
        "file": "tests/agent-parity.js",
        "reason": null
      },
      {
        "file": "tests/agent-preflight-single-copy.js",
        "reason": null
      },
      {
        "file": "tests/agent-preflight.js",
        "reason": null
      },
      {
        "file": "tests/agent-presence.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-recent-work.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-channel.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-direct-root.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-host.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-lanes.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-revalidation.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-resource-settings.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-roles.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-roster-events-and-attribution.js",
        "reason": null
      },
      {
        "file": "tests/agent-roster-scoreboard-and-decisions.js",
        "reason": null
      },
      {
        "file": "tests/agent-sandbox-live-smoke.js",
        "reason": null
      },
      {
        "file": "tests/agent-sandbox.js",
        "reason": null
      },
      {
        "file": "tests/agent-session-confinement.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-session-observer.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-slot-functions.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-spawn-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-spawn-refusals-name-the-action.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-spawn-tree-surface.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-subagent-route.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-sweep-task.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-territory-claim.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-tool-summary-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-tool-summary.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-tree-spawn.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake-windows-job.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake/executor.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake/liveness-receiver.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake/wake-request.test.js",
        "reason": null
      },
      {
        "file": "tests/agent-wake/worker-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/antigravity-confinement.test.js",
        "reason": null
      },
      {
        "file": "tests/anywhere-netbird-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/anywhere-netbird.test.js",
        "reason": null
      },
      {
        "file": "tests/anywhere-transport-refused.test.js",
        "reason": null
      },
      {
        "file": "tests/anywhere-transport.js",
        "reason": null
      },
      {
        "file": "tests/approval-boundary-bypasses.test.js",
        "reason": null
      },
      {
        "file": "tests/approval-prompt-completeness.test.js",
        "reason": null
      },
      {
        "file": "tests/argv-drift.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-activity.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-admission-error-boundary.test.cjs",
        "reason": "Canonical regression body imported by its selected .test.js wrapper."
      },
      {
        "file": "tests/audit-admission-error-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-admission-fallback-sink.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-admission-queue.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-advance-cache-after-roll.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-anchor-cross-process.js",
        "reason": null
      },
      {
        "file": "tests/audit-anchor-fork-heals.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-archive-append-idempotent.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-archive-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-archive-roll.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-archive-segment.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-batch-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-boundary-race.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-cause-chain-rendering.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-checkpoint-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-checkpoint-wiring.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-checkpoint.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/audit-digest-streaming.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-driven-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-durability-classification-provenance.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-durability-current-vs-historical.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-durability-newest-breach.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-durability.js",
        "reason": null
      },
      {
        "file": "tests/audit-error-classification.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-fresh-install.js",
        "reason": null
      },
      {
        "file": "tests/audit-identity-maintenance.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-intent.js",
        "reason": null
      },
      {
        "file": "tests/audit-legacy-archive-idempotency.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-legacy-scale.js",
        "reason": null
      },
      {
        "file": "tests/audit-lock-scope.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-logs-retention.js",
        "reason": null
      },
      {
        "file": "tests/audit-lost-race-keeps-prefix.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-diverged-retry.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-divergence-reason.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-parse-memo.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-total-render.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-verify-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-projection-window-overhang.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-rebuild-seeds-parse-memo.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-refusal-persistence.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-refusal-sentence-names-action.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-reliability.js",
        "reason": null
      },
      {
        "file": "tests/audit-retention-roll-fault-recovery.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-retention.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-signing-key-cause-fixture.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-signing-key-cause.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-spool-batch-durability.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-spool-ingestion.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-store-identity-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-store-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-store.js",
        "reason": null
      },
      {
        "file": "tests/audit-unanchored-suffix.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-verify-cached-health-read.test.js",
        "reason": null
      },
      {
        "file": "tests/audit-verify-include-archive.test.js",
        "reason": null
      },
      {
        "file": "tests/auth.duo/duo-desktop.js",
        "reason": null
      },
      {
        "file": "tests/auth.duo/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/auth.duo/ucr-sso.js",
        "reason": null
      },
      {
        "file": "tests/auth.google/google-account-readiness.test.js",
        "reason": null
      },
      {
        "file": "tests/auth.google/google-oauth-login.test.js",
        "reason": null
      },
      {
        "file": "tests/auth.google/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/backup-duty.test.js",
        "reason": null
      },
      {
        "file": "tests/batch-target.test.js",
        "reason": null
      },
      {
        "file": "tests/billing-provider.js",
        "reason": null
      },
      {
        "file": "tests/blank-role-continuation.test.js",
        "reason": null
      },
      {
        "file": "tests/blank-tree-role.test.js",
        "reason": null
      },
      {
        "file": "tests/board-split-readonly-pin.js",
        "reason": null
      },
      {
        "file": "tests/bridge-server-error-handling.test.js",
        "reason": null
      },
      {
        "file": "tests/bridge-status.js",
        "reason": null
      },
      {
        "file": "tests/broker-durable-write.test.js",
        "reason": null
      },
      {
        "file": "tests/broker-sender-on-receipt.test.js",
        "reason": null
      },
      {
        "file": "tests/browser-account-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/browser-agent-usability.test.js",
        "reason": null
      },
      {
        "file": "tests/browser-owner-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/browser-owner.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-authority.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-consumers.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-corpus-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-corpus.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-intent-consumer.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-migrate-cli.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-migration-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-migration.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-package-contract-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-package-contract.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-projection.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-provenance-live.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-provenance-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-provenance.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-slice-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-slice.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-tool-context.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-tools.test.js",
        "reason": null
      },
      {
        "file": "tests/build-queue-writer.js",
        "reason": null
      },
      {
        "file": "tests/builtin-assertion-evidence.test.js",
        "reason": null
      },
      {
        "file": "tests/builtin-assertion-scope.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority-process.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority-recovery.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority-release-contention.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority-write-recovery.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority-write.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/byte-exposure-receipt.test.js",
        "reason": null
      },
      {
        "file": "tests/canonical-path.js",
        "reason": null
      },
      {
        "file": "tests/canvas-session-preflight.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-elevation-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-features-manifest-unreadable.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-features.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-find-tool.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-manifest-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-manifests.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-compose.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-demo.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-eval.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-grammar.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-index.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-score-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-score.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall-text.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall/allowlist.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-recall/artifact.test.js",
        "reason": null
      },
      {
        "file": "tests/capability-settings-honest.test.js",
        "reason": null
      },
      {
        "file": "tests/check-capability-mirror.test.js",
        "reason": null
      },
      {
        "file": "tests/check-chain-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/check-comms-names.test.js",
        "reason": null
      },
      {
        "file": "tests/check-cross-repo-boundaries.test.js",
        "reason": null
      },
      {
        "file": "tests/check-dco.test.js",
        "reason": null
      },
      {
        "file": "tests/check-live-task-roots.test.js",
        "reason": null
      },
      {
        "file": "tests/check-owner-attribution.test.js",
        "reason": null
      },
      {
        "file": "tests/check-single-copy-work.js",
        "reason": null
      },
      {
        "file": "tests/clarify-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/claude-auth-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/claude-confined-home.test.js",
        "reason": null
      },
      {
        "file": "tests/claude-dispatch-seat-home.test.js",
        "reason": null
      },
      {
        "file": "tests/claude-session-autoregister.test.js",
        "reason": null
      },
      {
        "file": "tests/cli-provider-gateway-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/cli-session-usage-ingest.test.js",
        "reason": null
      },
      {
        "file": "tests/cli-session-usage.js",
        "reason": null
      },
      {
        "file": "tests/cloud-account-registration.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-batch-harvest.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-batch-journal.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-session-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-session.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent-state-machine.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-agent/contract.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-harvest-findings.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-harvest-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-harvest-run-vs-code.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-plan.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-runner-dispatch-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-batch-target.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-lane-batch-cli.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-lane.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-mirror-boundary-truth.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-mirror-bridge.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-mirror-network-containment.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-mirror-one-repository-many-projects.test.js",
        "reason": null
      },
      {
        "file": "tests/cloud-mirror.test.js",
        "reason": null
      },
      {
        "file": "tests/code-intel-containment.test.js",
        "reason": null
      },
      {
        "file": "tests/code-intel-handshake.js",
        "reason": null
      },
      {
        "file": "tests/code-intel-live.js",
        "reason": null
      },
      {
        "file": "tests/code-intel-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/code-intel.js",
        "reason": null
      },
      {
        "file": "tests/code.intel/allowlist.test.js",
        "reason": null
      },
      {
        "file": "tests/code.intel/code-intel.js",
        "reason": null
      },
      {
        "file": "tests/code.intel/gemini-mcp-profile.js",
        "reason": null
      },
      {
        "file": "tests/code.intel/helpers/fake-lsp-server.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/code.intel/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/codex-astra-tier.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cli-transport-cursor-roundtrip.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cli-transport-process-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cli-transport.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cloud-environments.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cloud-launch.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-cloud-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-dispatch-profile.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-dispatcher.test.js",
        "reason": null
      },
      {
        "file": "tests/codex-native-pair.test.js",
        "reason": null
      },
      {
        "file": "tests/cold-start-response-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/comms-naming-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/configure-editor-perf.test.js",
        "reason": null
      },
      {
        "file": "tests/configured-project-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/confined-tool-surface-workspace-path-refused.test.js",
        "reason": null
      },
      {
        "file": "tests/confined-tool-surface.test.js",
        "reason": null
      },
      {
        "file": "tests/confined-tree-delegation.test.js",
        "reason": null
      },
      {
        "file": "tests/continuation-pending-recoveries-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/continuation-prune.test.js",
        "reason": null
      },
      {
        "file": "tests/contract-header-repair.test.js",
        "reason": null
      },
      {
        "file": "tests/controller-cost-attribution.js",
        "reason": null
      },
      {
        "file": "tests/controller-escalation-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/controller-escalation.js",
        "reason": null
      },
      {
        "file": "tests/controller-focus.js",
        "reason": null
      },
      {
        "file": "tests/controller-launch-record-could-not-look.js",
        "reason": null
      },
      {
        "file": "tests/controller-launch-record.js",
        "reason": null
      },
      {
        "file": "tests/controller-launch-scope-adversarial.js",
        "reason": null
      },
      {
        "file": "tests/controller-launch-scope.js",
        "reason": null
      },
      {
        "file": "tests/controller-meter-isolation.js",
        "reason": null
      },
      {
        "file": "tests/controller-meter-ledger.js",
        "reason": null
      },
      {
        "file": "tests/controller-metering-version-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/controller-metering.js",
        "reason": null
      },
      {
        "file": "tests/controller-projection-worker-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/controller-projection.js",
        "reason": null
      },
      {
        "file": "tests/controller-savings-ledger.js",
        "reason": null
      },
      {
        "file": "tests/controller-savings-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/controller-tool-meter-e2e.js",
        "reason": null
      },
      {
        "file": "tests/controller-tool-meter.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-cost-attribution.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-escalation.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-focus.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-launch-scope.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-meter-isolation.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-meter-ledger.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-metering.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-projection.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-savings-ledger.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-tool-meter-e2e.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-tool-meter-production-wiring.js",
        "reason": null
      },
      {
        "file": "tests/controller/controller-tool-meter.js",
        "reason": null
      },
      {
        "file": "tests/controller/custom-roles.js",
        "reason": null
      },
      {
        "file": "tests/controller/gemini-account-lane-binding.js",
        "reason": null
      },
      {
        "file": "tests/controller/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/coordinator-audit-events.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-audit-write-async.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-activation-request.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-age-status-adversarial.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-age-status.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-artifact-plan-firsttest2.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-artifact-plan.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-duty.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-execution-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-observer-adversarial.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-observer-firsttest2.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-observer.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-retention-selector.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-test-writer-adversarial.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-test-writer-verification-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-test-writer.behavior.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-backup-test-writer.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-duty-host-timeout-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-duty-host.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-duty-registry-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-duty-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalate.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalation-policy.firsttest.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalation-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalation-resend.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalation-sink-compose-message.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-escalation-sink.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-heartbeat.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-owner-alarm-channel.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-owner-alarm-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-status-observation.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-workflow-trusted-artifacts.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-workflow/broker-verification.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator-workflow/verification-manifest.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator.workflow/coordinator-workflow-common.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator.workflow/event-envelope.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator.workflow/mission-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator.workflow/review-packet.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator.workflow/token-savings-benchmark.test.js",
        "reason": null
      },
      {
        "file": "tests/coordinator/owner-alarm-channel.behavior.test.js",
        "reason": null
      },
      {
        "file": "tests/council-ballot.test.js",
        "reason": null
      },
      {
        "file": "tests/council-slate-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/council-slate.test.js",
        "reason": null
      },
      {
        "file": "tests/council-tally.test.js",
        "reason": null
      },
      {
        "file": "tests/council.js",
        "reason": null
      },
      {
        "file": "tests/credential-capture.js",
        "reason": null
      },
      {
        "file": "tests/credential-metadata.test.js",
        "reason": null
      },
      {
        "file": "tests/custom-role-store-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/custom-role-store.test.js",
        "reason": null
      },
      {
        "file": "tests/customer-model-input-invalid.test.js",
        "reason": null
      },
      {
        "file": "tests/customer-model-local-load.test.js",
        "reason": null
      },
      {
        "file": "tests/customer-model-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/customer-payload-privacy.test.js",
        "reason": null
      },
      {
        "file": "tests/dashboard-task-port-guard.js",
        "reason": null
      },
      {
        "file": "tests/delegation-adapter-contracts.js",
        "reason": null
      },
      {
        "file": "tests/delegation-contract-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/delegation-contracts.js",
        "reason": null
      },
      {
        "file": "tests/delegation-enforcement.test.js",
        "reason": null
      },
      {
        "file": "tests/delegation-fake-adapters.js",
        "reason": null
      },
      {
        "file": "tests/delegation-readonly-qualification.js",
        "reason": null
      },
      {
        "file": "tests/delegation-task-attempt-projection.js",
        "reason": null
      },
      {
        "file": "tests/delegation-task-observation.js",
        "reason": null
      },
      {
        "file": "tests/delegation-task-projection.js",
        "reason": null
      },
      {
        "file": "tests/delegation/adapter-contracts.js",
        "reason": null
      },
      {
        "file": "tests/delegation/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/delegation/uac-delegation-client.js",
        "reason": null
      },
      {
        "file": "tests/delegation/uac-delegation.js",
        "reason": null
      },
      {
        "file": "tests/dependency-acceptance.test.js",
        "reason": null
      },
      {
        "file": "tests/dependency-graph.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop-advanced.js",
        "reason": null
      },
      {
        "file": "tests/desktop-app-capture.js",
        "reason": null
      },
      {
        "file": "tests/desktop-captures-short-names.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop-focus-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop-silent-catch.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop-window-close-guard.js",
        "reason": null
      },
      {
        "file": "tests/desktop-worker-image-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/agent-browser-contract.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/agent-browser-lifecycle.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/agent-browser-operations.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/agent-browser-shell.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/browser-account-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/browser-owner.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/playwright-call.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/playwright-gateway.js",
        "reason": null
      },
      {
        "file": "tests/desktop.browser/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/desktop.native/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/device-credential-clear-outcome.test.js",
        "reason": null
      },
      {
        "file": "tests/diagnostic-retention.test.js",
        "reason": null
      },
      {
        "file": "tests/digest-lock-half-published.test.js",
        "reason": null
      },
      {
        "file": "tests/direct-link.test.js",
        "reason": null
      },
      {
        "file": "tests/dispatch-permission-session.test.js",
        "reason": null
      },
      {
        "file": "tests/doc-intel.js",
        "reason": null
      },
      {
        "file": "tests/docker-drive-catalogue.test.js",
        "reason": null
      },
      {
        "file": "tests/docker-precondition-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/doctor.test.js",
        "reason": null
      },
      {
        "file": "tests/drive-upload.test.js",
        "reason": null
      },
      {
        "file": "tests/duo-desktop-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/duo-desktop.js",
        "reason": null
      },
      {
        "file": "tests/duo-owner-relay.test.js",
        "reason": null
      },
      {
        "file": "tests/durable-memory-file.test.js",
        "reason": null
      },
      {
        "file": "tests/egress-credential-name-gaps.test.js",
        "reason": null
      },
      {
        "file": "tests/egress-preflight-uncovered-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/egress-preflight.js",
        "reason": null
      },
      {
        "file": "tests/elevation-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/elevation-surface.test.js",
        "reason": null
      },
      {
        "file": "tests/elevation-writability.js",
        "reason": null
      },
      {
        "file": "tests/empty-role-directions.test.js",
        "reason": null
      },
      {
        "file": "tests/enforcement-gaps.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-activation-audit.test.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-enforcement-points.test.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-refusal-codes.test.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-report.test.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-reserved-plans.test.js",
        "reason": null
      },
      {
        "file": "tests/entitlement-sold-surface.test.js",
        "reason": null
      },
      {
        "file": "tests/entry/mcp-call.js",
        "reason": null
      },
      {
        "file": "tests/entry/mcp-handshake-probe.js",
        "reason": null
      },
      {
        "file": "tests/entry/mcp-owner-proxy-lifecycle.js",
        "reason": null
      },
      {
        "file": "tests/entry/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/entry/task-stdio.js",
        "reason": null
      },
      {
        "file": "tests/env-scrub.test.js",
        "reason": null
      },
      {
        "file": "tests/error-taxonomy-bridge-actor-refused.test.js",
        "reason": null
      },
      {
        "file": "tests/error-taxonomy-refusal-rescue.test.js",
        "reason": null
      },
      {
        "file": "tests/error-taxonomy-secret-input.test.js",
        "reason": null
      },
      {
        "file": "tests/error-taxonomy-unmentioned-source-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/escalation-sink-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/every-module-parses.test.js",
        "reason": null
      },
      {
        "file": "tests/evidence-store.js",
        "reason": null
      },
      {
        "file": "tests/evidence/evidence-store.js",
        "reason": null
      },
      {
        "file": "tests/evidence/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/failover-setting-error-boundary.test.cjs",
        "reason": "Canonical regression body imported by its selected .test.js wrapper."
      },
      {
        "file": "tests/failover-setting-error-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/file-tool-invocation.test.js",
        "reason": null
      },
      {
        "file": "tests/finished-queue/finished-queue.js",
        "reason": null
      },
      {
        "file": "tests/firebase-account-login.js",
        "reason": null
      },
      {
        "file": "tests/firebase-refusal-coverage.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest-coordinator-duty-host.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest-mission-bridge-termination.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest2-coordinator-backup-activation-request.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest2-coordinator-backup-age-status.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest2-coordinator-backup-execution-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest2-coordinator-duty-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/firsttest2-coordinator-heartbeat.test.js",
        "reason": null
      },
      {
        "file": "tests/fixtures/acp-exit-reporter.cjs",
        "reason": "Spawned ACP exit/diagnostic process fixture; assertions and lifetime cleanup belong to tests/agent-engine/acp-exit-diagnostics.test.js."
      },
      {
        "file": "tests/fixtures/acp-protocol-poison.cjs",
        "reason": "Spawned malformed ACP response fixture; assertions and lifetime cleanup belong to tests/agent-engine/acp-terminal-lifecycle.test.js."
      },
      {
        "file": "tests/fixtures/agent-wake-lane.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/claude-argv-peer.cjs",
        "reason": "Harmless CLI argv peer; claude-dispatch-seat-home.test.js supplies and checks its isolated output."
      },
      {
        "file": "tests/fixtures/codex-quota-peer.cjs",
        "reason": "Spawned local JSON-RPC peer and detached child; assertions and owned cleanup belong to tests/multi-account/codex-probe-native-lifetime.test.js."
      },
      {
        "file": "tests/fixtures/elevation-shared-writes-child.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/fake-grok-acp.cjs",
        "reason": "Spawned fixed Grok billing protocol fixture; assertions and lifetime cleanup belong to tests/multi-account-health.test.js."
      },
      {
        "file": "tests/fixtures/fake-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/fixtures/gemini-quota-sdk-preload.mjs",
        "reason": "Synthetic network and storage preload for the real pinned SDK worker; assertions belong to tests/providers/gemini-quota-sdk-native.test.js."
      },
      {
        "file": "tests/fixtures/legacy-dotted-ledger.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/legacy-ledger-gate-writer.cjs",
        "reason": "Imported legacy ledger compatibility fixture; invoked with disposable ledger paths by tests/ledger-gate-writer.js and tests/owner-request-store.test.js."
      },
      {
        "file": "tests/fixtures/legacy-owner-request-store-pre-adopt.cjs",
        "reason": "Frozen pre-adopt owner-request-store; tests/owner-request-store.test.js loads it for the adopt rollback rule case and owns every assertion."
      },
      {
        "file": "tests/fixtures/loop-confinement-lane.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/mission-bridge-checkpoint-lane.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/reconciliation-fail.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/reconciliation-pass.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/fixtures/research-lifecycle-peer.js",
        "reason": "Isolated research IPC peer driven by research-lifecycle-channel.test.js, not a standalone assertion suite."
      },
      {
        "file": "tests/fixtures/research-supervised-worker.js",
        "reason": "Finite research worker fixture driven by research-worker-supervisor.test.js."
      },
      {
        "file": "tests/fixtures/resource-channel-child.js",
        "reason": "Resource IPC child fixture; resource-channel/host/direct-root suites own its requests and assertions."
      },
      {
        "file": "tests/fixtures/root-admission-peer.cjs",
        "reason": "Local admission marker child driven by agent-engine/root-admission.test.js."
      },
      {
        "file": "tests/fixtures/strict-lifecycle-peer.cjs",
        "reason": "Strict lifecycle failure/protocol child; strict lifecycle suites select the mode and assert its result."
      },
      {
        "file": "tests/fleet-summary.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-custody.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-direct-vertex-receipt.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-direct-vertex-report.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-input-existence.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-lane-models.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor/descendant-containment.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor/evidence-durability.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor/process-group-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor/reservation-overlap-replay.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-luna-executor/restart-reconciliation.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-model-receipt-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-model-receipt.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-planning-paths.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-planning.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-refusal-coverage.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-review-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-review.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-allotment.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-attribution.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-backfill.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-decisions.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-events.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-scoreboard.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-roster-statistics.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-startup-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease-path-claimed.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease-state-firsttest2.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease-state-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease-state.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree-lease.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor-worktree.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/direct-vertex-receipt.behaviour.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/direct-vertex-report-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/direct-vertex-report.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/evidence-process-lifetime.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/evidence-terminated-by-signal.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/gemini-report-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/lane-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet-supervisor/model-receipt.test.js",
        "reason": null
      },
      {
        "file": "tests/fleet/fleet-summary.js",
        "reason": null
      },
      {
        "file": "tests/fleet/fleet-supervisor-direct-vertex-receipt.js",
        "reason": null
      },
      {
        "file": "tests/fleet/fleet-supervisor-model-receipt.js",
        "reason": null
      },
      {
        "file": "tests/fleet/fleet-supervisor-worktree-lease-state.js",
        "reason": null
      },
      {
        "file": "tests/fleet/fleet-supervisor.js",
        "reason": null
      },
      {
        "file": "tests/fleet/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/fork-ledger.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-audit-admission-cache.js",
        "reason": null
      },
      {
        "file": "tests/fra-bridge-vault-poll-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-byte-mediation.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-capability-manifest-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-capability-manifest.js",
        "reason": null
      },
      {
        "file": "tests/fra-doctor.js",
        "reason": null
      },
      {
        "file": "tests/fra-endpoint-manifests.js",
        "reason": null
      },
      {
        "file": "tests/fra-keeper-heartbeat-log.js",
        "reason": null
      },
      {
        "file": "tests/fra-keeper-linux-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-lifecycle-guards.js",
        "reason": null
      },
      {
        "file": "tests/fra-lifecycle-tunnel-notice.js",
        "reason": null
      },
      {
        "file": "tests/fra-listener-detached-launch.js",
        "reason": null
      },
      {
        "file": "tests/fra-machine-identity.js",
        "reason": null
      },
      {
        "file": "tests/fra-manifest-permission-tier.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-manifest-repin.js",
        "reason": null
      },
      {
        "file": "tests/fra-paired-machine-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-peer-heartbeat.js",
        "reason": null
      },
      {
        "file": "tests/fra-readiness-gates.js",
        "reason": null
      },
      {
        "file": "tests/fra-real-ledger-slo.js",
        "reason": null
      },
      {
        "file": "tests/fra-root-access-control.js",
        "reason": null
      },
      {
        "file": "tests/fra-root-access-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-root-access.js",
        "reason": null
      },
      {
        "file": "tests/fra-runtime-integrity.js",
        "reason": null
      },
      {
        "file": "tests/fra-secure-session-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-secure-session.js",
        "reason": null
      },
      {
        "file": "tests/fra-surface-security.js",
        "reason": null
      },
      {
        "file": "tests/fra-token-enrollment-lifecycle.js",
        "reason": null
      },
      {
        "file": "tests/fra-token-enrollment-operator.js",
        "reason": null
      },
      {
        "file": "tests/fra-token-enrollment-protocol.js",
        "reason": null
      },
      {
        "file": "tests/fra-token-enrollment-vault.js",
        "reason": null
      },
      {
        "file": "tests/fra-transport-binding-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-transport-binding.js",
        "reason": null
      },
      {
        "file": "tests/fra-vault-key-binding.js",
        "reason": null
      },
      {
        "file": "tests/fra-workspace-handles.js",
        "reason": null
      },
      {
        "file": "tests/fra-workspace-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/fra-workspace-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-bridge.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-control-contract.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-enroll-peer.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-enroll-token.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-lifecycle.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-listener-host.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-mcp-proxy.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-preflight.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-access-release-enroll.js",
        "reason": null
      },
      {
        "file": "tests/full-remote-playwright-mcp-proxy.js",
        "reason": null
      },
      {
        "file": "tests/gcloud-account-inspector.js",
        "reason": null
      },
      {
        "file": "tests/gcloud-account-login-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/gcloud-account-login.js",
        "reason": null
      },
      {
        "file": "tests/gemini-agentic-run.test.js",
        "reason": null
      },
      {
        "file": "tests/gemini-agentic.js",
        "reason": null
      },
      {
        "file": "tests/gemini-fleet.js",
        "reason": null
      },
      {
        "file": "tests/gemini-mcp-profile.js",
        "reason": null
      },
      {
        "file": "tests/gen-third-party-licenses.test.js",
        "reason": null
      },
      {
        "file": "tests/generate-agent-activity-contracts.test.js",
        "reason": null
      },
      {
        "file": "tests/generate-delegation-contract-schema.test.js",
        "reason": null
      },
      {
        "file": "tests/generate-error-taxonomy-bindings.test.js",
        "reason": null
      },
      {
        "file": "tests/generate-evidence-store.js",
        "reason": null
      },
      {
        "file": "tests/generic-role-authority-hostile.test.js",
        "reason": null
      },
      {
        "file": "tests/git-destructive-reflog-check.test.js",
        "reason": null
      },
      {
        "file": "tests/git-push-destination.test.js",
        "reason": null
      },
      {
        "file": "tests/github-mutation-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/github-provider.js",
        "reason": null
      },
      {
        "file": "tests/gmail-attachments.js",
        "reason": null
      },
      {
        "file": "tests/gmail-send-failure.js",
        "reason": null
      },
      {
        "file": "tests/google-account-readiness.test.js",
        "reason": null
      },
      {
        "file": "tests/google-accounts-installation.test.js",
        "reason": null
      },
      {
        "file": "tests/google-accounts.test.js",
        "reason": null
      },
      {
        "file": "tests/google-inputs.js",
        "reason": null
      },
      {
        "file": "tests/google-oauth-login.test.js",
        "reason": null
      },
      {
        "file": "tests/google-provider-prerequisites.test.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver-orient.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver-tooldigest.test.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver/grepsaver.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver/orient.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver/reindex.js",
        "reason": null
      },
      {
        "file": "tests/grepsaver/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/grepsaver/tooldigest.js",
        "reason": null
      },
      {
        "file": "tests/grok-mcp-wire-names.test.js",
        "reason": null
      },
      {
        "file": "tests/guarded-permission-tier.test.js",
        "reason": null
      },
      {
        "file": "tests/health-invariants.test.js",
        "reason": null
      },
      {
        "file": "tests/health-observer-listener-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/health-observer.test.js",
        "reason": null
      },
      {
        "file": "tests/helpers/agent-msg-runtime-stub.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/byte-authority-child.js",
        "reason": "Byte publication process fixture with mandatory parent-supplied resource/span inputs."
      },
      {
        "file": "tests/helpers/byte-authority-fixture.js",
        "reason": "Imported byte-authority fixture construction and inspection functions; assertions run in importing suites."
      },
      {
        "file": "tests/helpers/byte-authority-v1-fixture.js",
        "reason": "Imported v1 interrupted-publication fixture; no standalone suite entrypoint."
      },
      {
        "file": "tests/helpers/declared-org.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/diagnostic-memory-fs.js",
        "reason": "Imported in-memory diagnostic filesystem; assertions run in the Engine and App diagnostic retention suites."
      },
      {
        "file": "tests/helpers/dispatch.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/fra-binding-fixture.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/fra-workspace-authority-fixture.js",
        "reason": "Imported local FRA byte-authority fixture and teardown functions."
      },
      {
        "file": "tests/helpers/isolated-state-root.js",
        "reason": "Imported source-test scratch guard; independently tested by helpers/isolated-state-root.test.js."
      },
      {
        "file": "tests/helpers/isolated-state-root.test.js",
        "reason": null
      },
      {
        "file": "tests/helpers/loopback-webrtc-fixture.js",
        "reason": "Imported guarded loopback transport fixture; assertions and cleanup are invoked by the paired-machine suite."
      },
      {
        "file": "tests/helpers/online-fra-browser-authority-fixture.js",
        "reason": "Imported offline browser-authority harness; its caller owns execution and teardown."
      },
      {
        "file": "tests/helpers/online-fra-claim-cli-vault.cjs",
        "reason": "Preloaded claim-CLI fake vault module; mandatory isolated parent environment, not a standalone test."
      },
      {
        "file": "tests/helpers/online-fra-reference-fixture.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/paired-service-registry.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/scratch-state-root.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/helpers/scripted-provider.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/hidden-spawn-native-containment.test.js",
        "reason": null
      },
      {
        "file": "tests/hidden-spawn-root-guard.test.js",
        "reason": null
      },
      {
        "file": "tests/host-byte-mediation.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control-credential-name-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control-entry-point-fence.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control-product-source-writes.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control-relative-path-anchor.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control-write-fence-anchor.test.js",
        "reason": null
      },
      {
        "file": "tests/host-control.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-audit-off-thread.test.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-cancellation-native.test.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-cancellation.test.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-kill-switch-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-timeout-tree.test.js",
        "reason": null
      },
      {
        "file": "tests/host-exec-vault-process-budget.test.js",
        "reason": null
      },
      {
        "file": "tests/http-core-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/http-core-redirect.js",
        "reason": null
      },
      {
        "file": "tests/http-request.js",
        "reason": null
      },
      {
        "file": "tests/ide-session-consent-writer.js",
        "reason": null
      },
      {
        "file": "tests/ide-session-consent.js",
        "reason": null
      },
      {
        "file": "tests/import-purity.test.js",
        "reason": null
      },
      {
        "file": "tests/infrastructure-espawn-timeout-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/injection-test-suite.js",
        "reason": null
      },
      {
        "file": "tests/instagram-saga.js",
        "reason": null
      },
      {
        "file": "tests/install-tier-enforcement.test.js",
        "reason": null
      },
      {
        "file": "tests/installed-role-memory.test.js",
        "reason": null
      },
      {
        "file": "tests/intent-check-starvation.js",
        "reason": null
      },
      {
        "file": "tests/intent-fidelity-live.js",
        "reason": null
      },
      {
        "file": "tests/intent-fidelity.js",
        "reason": null
      },
      {
        "file": "tests/invocation-guard.test.js",
        "reason": null
      },
      {
        "file": "tests/iphone-handoff-runtime-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/iphone-handoff.js",
        "reason": null
      },
      {
        "file": "tests/isolated-runner-owned-process.test.js",
        "reason": null
      },
      {
        "file": "tests/isolated-runner-retained-state.test.js",
        "reason": null
      },
      {
        "file": "tests/isolation-contract.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-anchor-cross-process.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-anchor-writer.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-contention-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.audit/audit-contention.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-durability-multiprocess.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-durability-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.audit/audit-intent.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-ledger-vault-binding.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-legacy-scale.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-logs-retention.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-process-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.audit/audit-projection-batching.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-reliability.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/audit-store-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.audit/audit-store.js",
        "reason": null
      },
      {
        "file": "tests/kernel.audit/legacy-run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.audit/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.audit/vault-hardening.js",
        "reason": null
      },
      {
        "file": "tests/kernel.policy/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.policy/runtime-security.js",
        "reason": null
      },
      {
        "file": "tests/kernel.runtime/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.runtime/schema-validator.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/agent-coord-attest-migrate.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/agent-coord-integrity.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/instagram-saga.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/legacy-run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.state/provider-state.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kernel.state/scheduler-adapter.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/scheduler-legacy.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/scheduler-provider.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/scheduler-runner.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/scheduler-state-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.state/scheduler-state.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/state-concurrency-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/kernel.state/state-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/state-store.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/task-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/task-state.js",
        "reason": null
      },
      {
        "file": "tests/kernel.state/task-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/key-custody-dispatch.test.js",
        "reason": null
      },
      {
        "file": "tests/key-custody/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/kill-switch-runtime-state.test.js",
        "reason": null
      },
      {
        "file": "tests/kill-switch.test.js",
        "reason": null
      },
      {
        "file": "tests/lane-cap-tree-kill.test.js",
        "reason": null
      },
      {
        "file": "tests/lane-scope.test.js",
        "reason": null
      },
      {
        "file": "tests/lane-territory-check.test.js",
        "reason": null
      },
      {
        "file": "tests/lane-territory-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/launch-outcome.test.js",
        "reason": null
      },
      {
        "file": "tests/launch-terminal-race-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/launch-terminal-race.js",
        "reason": null
      },
      {
        "file": "tests/ledger-archive.js",
        "reason": null
      },
      {
        "file": "tests/ledger-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/ledger-category-reset.test.js",
        "reason": null
      },
      {
        "file": "tests/ledger-cold-storage-boot-lists.js",
        "reason": null
      },
      {
        "file": "tests/ledger-gate-names-an-unreadable-settings-layer.test.js",
        "reason": null
      },
      {
        "file": "tests/ledger-gate-writer.js",
        "reason": null
      },
      {
        "file": "tests/ledger-merge.js",
        "reason": null
      },
      {
        "file": "tests/ledger-query.js",
        "reason": null
      },
      {
        "file": "tests/ledger-verbatim-migration.js",
        "reason": null
      },
      {
        "file": "tests/legacy-dotted-migration.js",
        "reason": null
      },
      {
        "file": "tests/lib/admin-enrollment-fixture.js",
        "reason": "Imported signed local enrollment fixture; no standalone assertion entrypoint."
      },
      {
        "file": "tests/lib/agent-api-mode-fixture.js",
        "reason": "Imported isolated API-mode setup helper, not an assertion suite."
      },
      {
        "file": "tests/lib/cloud-agent/batch-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/lib/isolated-child.js",
        "reason": "Imported native process-custody runner helper; assertions belong to tests/isolated-runner-owned-process.test.js and other selected isolation suites."
      },
      {
        "file": "tests/lib/isolated-environment.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/lib/linux-credential-vault-case.js",
        "reason": "Native assertion component executed by tests/linux-credential-prompt.test.js through the disposable GNOME/D-Bus fixture in tests/linux-vault.test.js; unsafe to schedule outside that fixture."
      },
      {
        "file": "tests/lib/multi-account/registry-write-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/lib/multi-account/registry-write.test.js",
        "reason": null
      },
      {
        "file": "tests/lib/platform-contract-fixture.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/lib/shipped-tool-inventory.js",
        "reason": "Imported fixed inventory assertion helper; invoked by selected tool-surface suites."
      },
      {
        "file": "tests/lib/strict-lifecycle-fixture.js",
        "reason": "Imported Git/npm lifecycle fixture factory; caller owns the actual assertions and cleanup."
      },
      {
        "file": "tests/lib/suite-list.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/lib/suite-timeouts.js",
        "reason": "helper-directory"
      },
      {
        "file": "tests/lib/task-waiting-memory-fixture.cjs",
        "reason": "Imported in-memory Ledger fixture used by the selected task suites."
      },
      {
        "file": "tests/license-store.test.js",
        "reason": null
      },
      {
        "file": "tests/line-endings.test.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-enroll-token.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-revocation-withdraws-token.test.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-smoke-test.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-store-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-token-rotation-operator.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-token-rotation-protocol.js",
        "reason": null
      },
      {
        "file": "tests/link-bus-token-rotation-vault.js",
        "reason": null
      },
      {
        "file": "tests/link-bus.js",
        "reason": null
      },
      {
        "file": "tests/link.bus/link-bus.js",
        "reason": null
      },
      {
        "file": "tests/linux-agent-launch.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-bridge-first-run.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-claude-discovery.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-credential-prompt.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-desktop-ask.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-desktop-temp.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-desktop.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-keyring-fixture-root.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-native-environment.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-native.js",
        "reason": "Native Linux aggregate runner; its named source command remains separately required."
      },
      {
        "file": "tests/linux-process-control.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-research-worker.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-sandbox-sterile-live-smoke.js",
        "reason": null
      },
      {
        "file": "tests/linux-sandbox-workspace-live.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-sandbox-workspace.test.js",
        "reason": null
      },
      {
        "file": "tests/linux-vault.test.js",
        "reason": null
      },
      {
        "file": "tests/loads-on-a-customer-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/local-fleet-identity.test.js",
        "reason": null
      },
      {
        "file": "tests/local-model-settings-gpu.test.js",
        "reason": null
      },
      {
        "file": "tests/local-node-dispatch.test.js",
        "reason": null
      },
      {
        "file": "tests/local-node-reasoning-answer.test.js",
        "reason": null
      },
      {
        "file": "tests/local-node-runtime.test.js",
        "reason": null
      },
      {
        "file": "tests/local-node-tier.test.js",
        "reason": null
      },
      {
        "file": "tests/local-owner-session-binding.test.js",
        "reason": null
      },
      {
        "file": "tests/local-thread-recovery.test.js",
        "reason": null
      },
      {
        "file": "tests/local-tiers-absence.test.js",
        "reason": null
      },
      {
        "file": "tests/local-tool-discovery.test.js",
        "reason": null
      },
      {
        "file": "tests/local-user-profile.test.js",
        "reason": null
      },
      {
        "file": "tests/loop-guided-child-confinement.test.js",
        "reason": null
      },
      {
        "file": "tests/lsp-client.test.js",
        "reason": null
      },
      {
        "file": "tests/luna-executor-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/luna-worktree-lane.test.js",
        "reason": null
      },
      {
        "file": "tests/machine-probe-unmeasured-is-not-zero.test.js",
        "reason": null
      },
      {
        "file": "tests/machine-profile.js",
        "reason": null
      },
      {
        "file": "tests/machine-record-hostname.test.js",
        "reason": null
      },
      {
        "file": "tests/machine-record-integrity.test.js",
        "reason": null
      },
      {
        "file": "tests/machine-record-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/managed-native-tunnel-hostile.test.js",
        "reason": null
      },
      {
        "file": "tests/managed-processes.test.js",
        "reason": null
      },
      {
        "file": "tests/manifest-namespace-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-actor-binding.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-call-exit-code-honesty.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-call-permission-session.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-call.js",
        "reason": null
      },
      {
        "file": "tests/mcp-contract.js",
        "reason": null
      },
      {
        "file": "tests/mcp-handshake-probe-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-handshake-probe.js",
        "reason": null
      },
      {
        "file": "tests/mcp-initialize-instructions.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-line-dispatcher.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-public-message-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-server-footprint.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-server-shutdown-forensics.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-session-scope-dispatch.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-tool-surface-read-failure.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-tool-surface-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mcp-tool-surface.js",
        "reason": null
      },
      {
        "file": "tests/measurement-honesty.js",
        "reason": null
      },
      {
        "file": "tests/memory-audit-off-thread.test.js",
        "reason": null
      },
      {
        "file": "tests/memory-provider.js",
        "reason": null
      },
      {
        "file": "tests/memory/memory-provider.js",
        "reason": null
      },
      {
        "file": "tests/memory/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/minor-ledger-agent-gate-ap-tools.test.js",
        "reason": null
      },
      {
        "file": "tests/minor-ledger-agent-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-action-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-agent-lane-dispatch-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-agent-lane.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-api-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-bench.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-bootstrap-auth.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-claude-mcp-config.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-cloud-binding.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-errors-unauth.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-errors.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-killswitch.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-ledger-archive.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-machines-actions.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-machines.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-no-origin-clients.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-no-paid-provider-switch.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-owner-prompt-http.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-owner-prompts.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-owner-tier-refresh.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-queue-open.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-refusal-reason.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-research-actions.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-seat-pool.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-server-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-server.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-session-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-spawn-coordinator.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-task-list-filter.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-termination-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-termination.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge-uncovered-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-bridge.test.js",
        "reason": null
      },
      {
        "file": "tests/mission-role-binding-hostile.test.js",
        "reason": null
      },
      {
        "file": "tests/model-error-sentences.test.js",
        "reason": null
      },
      {
        "file": "tests/model-floor-uncovered-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/model-floor.js",
        "reason": null
      },
      {
        "file": "tests/model-picker.js",
        "reason": null
      },
      {
        "file": "tests/model-provider.js",
        "reason": null
      },
      {
        "file": "tests/model-role-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/model-role.js",
        "reason": null
      },
      {
        "file": "tests/models/cli-session-usage.js",
        "reason": null
      },
      {
        "file": "tests/models/f47-vram-probe.js",
        "reason": null
      },
      {
        "file": "tests/models/model-floor.js",
        "reason": null
      },
      {
        "file": "tests/models/model-picker.js",
        "reason": null
      },
      {
        "file": "tests/models/model-provider.js",
        "reason": null
      },
      {
        "file": "tests/models/model-role.js",
        "reason": null
      },
      {
        "file": "tests/models/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/multi-account-codex-schema.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-failover.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-health.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-launch-scrub.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-registry-remove.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-registry-write.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-rotation.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-switcher-json-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account-usage-binding-filter.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/claude-allowance.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/codex-probe-lifetime.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/codex-probe-native-lifetime.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/provider-probe-receipt.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/rotation.behavior.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/selection-modes.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/switcher.test.js",
        "reason": null
      },
      {
        "file": "tests/multi-account/usage-windows.test.js",
        "reason": null
      },
      {
        "file": "tests/naming-ratchet.test.js",
        "reason": null
      },
      {
        "file": "tests/native-agent-launcher-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/native-agent-local-config-hostile.test.js",
        "reason": null
      },
      {
        "file": "tests/native-agent-probe-shell.test.js",
        "reason": null
      },
      {
        "file": "tests/native-agent-worker-failed-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/native-agent-worker-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/no-blocking-prompt-hook.test.js",
        "reason": null
      },
      {
        "file": "tests/no-blocking-prompt-registration.test.js",
        "reason": null
      },
      {
        "file": "tests/no-owner-data.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-account-native-http.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-admin-enrollment.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-admin-linux-vault.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-bridge-native-http.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-browser-authority-clock.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-browser-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-browser-authorization.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-claim-cli-consent.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-claim-cli-usage.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-claim-cli.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-composite-bridge.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-desktop-controller.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-device-claim-refused.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-device-claim.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-device-identity.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-direct-signalling.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-direct-transport.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-e2e-session-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-e2e-session.interop.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-e2e-session.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-local-bridge.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-peer-introduction.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-reference-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-client.edge.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-client.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-close-process.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-close.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-renewal.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-shell-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-shell-silent-catch.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-shell-solo.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-shell-vault-errors.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-relay-shell.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-renewal.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-web-client-seal-error-translation.test.js",
        "reason": null
      },
      {
        "file": "tests/online-fra-web-client.js",
        "reason": null
      },
      {
        "file": "tests/online-maintenance-broker-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/online-maintenance-broker.js",
        "reason": null
      },
      {
        "file": "tests/online-maintenance-contract.js",
        "reason": null
      },
      {
        "file": "tests/online-tools-profile-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/online-tools-profile.js",
        "reason": null
      },
      {
        "file": "tests/online-tunnel-adapter.js",
        "reason": null
      },
      {
        "file": "tests/online-tunnel-contract-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/online-tunnel-contract.js",
        "reason": null
      },
      {
        "file": "tests/open-gates-digest-contract.test.js",
        "reason": null
      },
      {
        "file": "tests/open-gates-freshness-check.js",
        "reason": null
      },
      {
        "file": "tests/outside-control.test.js",
        "reason": null
      },
      {
        "file": "tests/overnight-advisory-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/overnight-advisory-worker-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/overnight-advisory.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-alert.js",
        "reason": null
      },
      {
        "file": "tests/owner-attribution-guard.js",
        "reason": null
      },
      {
        "file": "tests/owner-authorization-malformed-lists.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-capture-audit.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-capture-spool.js",
        "reason": null
      },
      {
        "file": "tests/owner-capture.js",
        "reason": null
      },
      {
        "file": "tests/owner-chat.js",
        "reason": null
      },
      {
        "file": "tests/owner-data-account-fixtures-redacted.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-delivery-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-delivery.js",
        "reason": null
      },
      {
        "file": "tests/owner-directive-inbox.js",
        "reason": null
      },
      {
        "file": "tests/owner-directive-notification.js",
        "reason": null
      },
      {
        "file": "tests/owner-form-contract.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-agent-actors.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-cancellation-cleanup.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-idle-timeout.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-linux.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-named-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-per-line-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-per-line-unknown-vs-denied.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-root-assertion.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-session-cancel.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-session-retirement-observer.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-socket-path-refusal.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-start-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-tool-mode.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-host-workspace-ceiling.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-identity-purpose-gate-adversarial-g9.js",
        "reason": null
      },
      {
        "file": "tests/owner-identity-purpose-gate.js",
        "reason": null
      },
      {
        "file": "tests/owner-identity-reader-audit-adversarial-g9.js",
        "reason": null
      },
      {
        "file": "tests/owner-identity-reader-audit.js",
        "reason": null
      },
      {
        "file": "tests/owner-ingress-spool.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-contract.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-gate-batch-adversarial-g8.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-gate-batch-request-entries-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-gate-batch.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-gate-sweep.js",
        "reason": null
      },
      {
        "file": "tests/owner-ledger-open-gates.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-launch-environment.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-platform-psmodulepath.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-platform-results.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-provenance.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-purchase-wiring.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-queue-refusals-name-their-condition.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-queue-uncovered-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-queue.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-shared-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-theme.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-prompt-windows-capture.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-public-prompts.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-archive-resolution.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-lifecycle-projection.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-provenance-required.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-provenance.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-adversarial.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-event.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-production-store.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-proposal-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-proposal.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-store-adversarial.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-store-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-store.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope-version-refusal.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-scope.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-status-projection.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-status-writer.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-request-store.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-requirement-descope.test.js",
        "reason": null
      },
      {
        "file": "tests/owner-spool-review.test.js",
        "reason": null
      },
      {
        "file": "tests/owner.digest/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/owner.ledger/ledger-query.js",
        "reason": null
      },
      {
        "file": "tests/p13-policy-approval-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/p14-scoped-approval-worker.js",
        "reason": "worker"
      },
      {
        "file": "tests/package-check-adversarial-g8.js",
        "reason": null
      },
      {
        "file": "tests/package-check.js",
        "reason": null
      },
      {
        "file": "tests/package-manifest-contract-adversarial.js",
        "reason": null
      },
      {
        "file": "tests/package-manifest-contract.js",
        "reason": null
      },
      {
        "file": "tests/paddle-environment.test.js",
        "reason": null
      },
      {
        "file": "tests/paddle-installed-environment.test.js",
        "reason": null
      },
      {
        "file": "tests/pay-record-durable-intent.test.js",
        "reason": null
      },
      {
        "file": "tests/peer-enroll-cli.js",
        "reason": null
      },
      {
        "file": "tests/peer-enrollment-uncovered-refusals.js",
        "reason": null
      },
      {
        "file": "tests/peer-enrollment.js",
        "reason": null
      },
      {
        "file": "tests/peer-link-rotation.js",
        "reason": null
      },
      {
        "file": "tests/permission-session-chokepoint.test.js",
        "reason": null
      },
      {
        "file": "tests/permission-tier-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/personal-calendar.js",
        "reason": null
      },
      {
        "file": "tests/pipe-redirection.test.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/package-check-adversarial-g8.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/package-check-baseline.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/package-check.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/package-manifest-contract-adversarial.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/package-manifest-contract.js",
        "reason": null
      },
      {
        "file": "tests/pkg.tree/packages-manifest-writer.js",
        "reason": null
      },
      {
        "file": "tests/playwright-call.js",
        "reason": null
      },
      {
        "file": "tests/playwright-gateway.js",
        "reason": null
      },
      {
        "file": "tests/playwright-session-live.test.js",
        "reason": null
      },
      {
        "file": "tests/playwright-session.test.js",
        "reason": null
      },
      {
        "file": "tests/playwright-smoke.js",
        "reason": null
      },
      {
        "file": "tests/policy-authorizations-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/policy-evaluator-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/policy-evaluator.test.js",
        "reason": null
      },
      {
        "file": "tests/policy-invalid-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/policy-task-retirement.test.js",
        "reason": null
      },
      {
        "file": "tests/policy.test.js",
        "reason": null
      },
      {
        "file": "tests/port-listener-probe.js",
        "reason": null
      },
      {
        "file": "tests/proc-run.js",
        "reason": null
      },
      {
        "file": "tests/process-cpu-sample.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-consumer.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-controller-route.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-live-wiring.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-producer.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-refresh.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-snapshot.test.js",
        "reason": null
      },
      {
        "file": "tests/process-visibility-writer.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-autonomy-regressions.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-charters.js",
        "reason": null
      },
      {
        "file": "tests/provider-inputs.js",
        "reason": null
      },
      {
        "file": "tests/provider-launch-scrub-selfcheck.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-launch-scrub.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-name-presentation.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-safety.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-session-isolation.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-state.js",
        "reason": null
      },
      {
        "file": "tests/provider-toolchain.test.js",
        "reason": null
      },
      {
        "file": "tests/provider-untrusted-content.js",
        "reason": null
      },
      {
        "file": "tests/providers-capability-manifest-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers-capability-manifests.test.js",
        "reason": null
      },
      {
        "file": "tests/providers-paddle.test.js",
        "reason": null
      },
      {
        "file": "tests/providers-stripe.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.billing/billing-provider.js",
        "reason": null
      },
      {
        "file": "tests/providers.billing/hosted-relay-entitlement.js",
        "reason": null
      },
      {
        "file": "tests/providers.billing/license-provider.js",
        "reason": null
      },
      {
        "file": "tests/providers.billing/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.gateway/cli-provider-gateway-state.js",
        "reason": null
      },
      {
        "file": "tests/providers.gateway/gemini-agentic.js",
        "reason": null
      },
      {
        "file": "tests/providers.gateway/npm-global-prefix-discovery.js",
        "reason": null
      },
      {
        "file": "tests/providers.gateway/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.gateway/vertex-gemini-seat.js",
        "reason": null
      },
      {
        "file": "tests/providers.gateway/vertex-gemini-strong.js",
        "reason": null
      },
      {
        "file": "tests/providers.gateway/vertex-gemini.js",
        "reason": null
      },
      {
        "file": "tests/providers.github/github-provider.js",
        "reason": null
      },
      {
        "file": "tests/providers.github/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.google.gmail-message-too-large.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/drive-upload-containment.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/firebase-account-login.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/gcloud-account-inspector.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/gmail-attachments.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/gmail-send-failure.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/google-inputs.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/google-oauth-access-token.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/personal-calendar.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/provider-untrusted-content.js",
        "reason": null
      },
      {
        "file": "tests/providers.google.suite/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.infrastructure/infrastructure.js",
        "reason": null
      },
      {
        "file": "tests/providers.infrastructure/provider-inputs.js",
        "reason": null
      },
      {
        "file": "tests/providers.infrastructure/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.iphone.handoff/iphone-handoff.js",
        "reason": null
      },
      {
        "file": "tests/providers.iphone.handoff/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.launch/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.launch/service-control.js",
        "reason": null
      },
      {
        "file": "tests/providers.misc/doc-intel.js",
        "reason": null
      },
      {
        "file": "tests/providers.misc/host-control.js",
        "reason": null
      },
      {
        "file": "tests/providers.misc/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.research/injection-test-suite.js",
        "reason": null
      },
      {
        "file": "tests/providers.research/research-hermes.js",
        "reason": null
      },
      {
        "file": "tests/providers.research/research-strong.js",
        "reason": null
      },
      {
        "file": "tests/providers.research/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.sandbox/agent-sandbox-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.sandbox/agent-sandbox.js",
        "reason": null
      },
      {
        "file": "tests/providers.sandbox/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.sandbox/sandbox-admission-lock.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/lookup-direct-refusal-diagnostic.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/refusal-coverage.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/research-hardening.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/robots-indeterminate.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/providers.web/searxng-partial-failure.test.js",
        "reason": null
      },
      {
        "file": "tests/providers.web/web.js",
        "reason": null
      },
      {
        "file": "tests/providers/agent-comms-local-caller-session.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/agent-comms-local-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/agent-comms-local-tool-context.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/chrome-web-store-oauth.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/chrome-web-store.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/claude-auth-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/claude-probe-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/claude-usage-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/credential-scrub-round2.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/deployment.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/duo-desktop-approval.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/durable-worker-runtime.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/extension.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/gemini-account-usage.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/gemini-quota-identity.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/gemini-quota-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/gemini-quota-sdk-native.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/gemini-quota-storage.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/instagram-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/launch-environment-case.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/local-execution-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/overnight-advisory-runtime-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/overnight-advisory-runtime.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/owned-browser-cdp.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/pay.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/psmodulepath-vault-autoload.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/reminders.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/sensitive-local-input.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/subscription-launch-env.test.js",
        "reason": null
      },
      {
        "file": "tests/providers/tasks.test.js",
        "reason": null
      },
      {
        "file": "tests/publish-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/purchase-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/purchase-cart-view.test.js",
        "reason": null
      },
      {
        "file": "tests/purchase-recording.test.js",
        "reason": null
      },
      {
        "file": "tests/purchase-request-tool.test.js",
        "reason": null
      },
      {
        "file": "tests/quarantine-preflight.test.js",
        "reason": null
      },
      {
        "file": "tests/queue-from-ledger.js",
        "reason": null
      },
      {
        "file": "tests/r-ledger-agent-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/r-ledger-check.test.js",
        "reason": null
      },
      {
        "file": "tests/r-ledger-proposals.test.js",
        "reason": null
      },
      {
        "file": "tests/r-ledger-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/r-ledger.test.js",
        "reason": null
      },
      {
        "file": "tests/r1152-sandbox-progress.test.js",
        "reason": null
      },
      {
        "file": "tests/redteam/mediation-fence.test.js",
        "reason": null
      },
      {
        "file": "tests/redteam/tier-escalation.test.js",
        "reason": null
      },
      {
        "file": "tests/refusals-reach-the-agent.test.js",
        "reason": null
      },
      {
        "file": "tests/reminders-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/remote-agent-bridge.js",
        "reason": null
      },
      {
        "file": "tests/remote-bridge-enroll-token.js",
        "reason": null
      },
      {
        "file": "tests/remote-byte-scope.test.js",
        "reason": null
      },
      {
        "file": "tests/remote-playwright-provider.js",
        "reason": null
      },
      {
        "file": "tests/remote-surface-tier-parity.test.js",
        "reason": null
      },
      {
        "file": "tests/repo-byte-transport.test.js",
        "reason": null
      },
      {
        "file": "tests/repo-files-content-invalid.test.js",
        "reason": null
      },
      {
        "file": "tests/repo-files-tool-registry.js",
        "reason": null
      },
      {
        "file": "tests/repo-files.js",
        "reason": null
      },
      {
        "file": "tests/repo-protocol/build-queue-corpus.js",
        "reason": null
      },
      {
        "file": "tests/repo-protocol/build-queue-migration.js",
        "reason": null
      },
      {
        "file": "tests/repo-protocol/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/repo-sync-status.test.js",
        "reason": null
      },
      {
        "file": "tests/repo-sync.test.js",
        "reason": null
      },
      {
        "file": "tests/request-context.test.js",
        "reason": null
      },
      {
        "file": "tests/request-id.js",
        "reason": null
      },
      {
        "file": "tests/request-version/legacy-dotted-disposition.js",
        "reason": null
      },
      {
        "file": "tests/request-version/legacy-dotted-refusals.js",
        "reason": null
      },
      {
        "file": "tests/request-version/version-chain.js",
        "reason": null
      },
      {
        "file": "tests/research-access-owner-host-transport.test.js",
        "reason": null
      },
      {
        "file": "tests/research-access-t605.test.js",
        "reason": null
      },
      {
        "file": "tests/research-bridge-actions.test.js",
        "reason": null
      },
      {
        "file": "tests/research-collectors.test.js",
        "reason": null
      },
      {
        "file": "tests/research-delegation.test.js",
        "reason": null
      },
      {
        "file": "tests/research-finding-save-id-schema.test.js",
        "reason": null
      },
      {
        "file": "tests/research-generated-result-digests.test.js",
        "reason": null
      },
      {
        "file": "tests/research-hardening.test.js",
        "reason": null
      },
      {
        "file": "tests/research-lifecycle-channel.test.js",
        "reason": null
      },
      {
        "file": "tests/research-lifecycle-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/research-process-policy-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/research-provenance.test.js",
        "reason": null
      },
      {
        "file": "tests/research-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/research-queued-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/research-run-pages.test.js",
        "reason": null
      },
      {
        "file": "tests/research-runners-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/research-runners.behavior.test.js",
        "reason": null
      },
      {
        "file": "tests/research-runners.test.js",
        "reason": null
      },
      {
        "file": "tests/research-runs-runtime.test.js",
        "reason": null
      },
      {
        "file": "tests/research-runs-worker.test.js",
        "reason": null
      },
      {
        "file": "tests/research-scoped-byte-mediation.test.js",
        "reason": null
      },
      {
        "file": "tests/research-settings-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/research-strong.js",
        "reason": null
      },
      {
        "file": "tests/research-study-protocol.test.js",
        "reason": null
      },
      {
        "file": "tests/research-worker-protocol.test.js",
        "reason": null
      },
      {
        "file": "tests/research-worker-supervisor.test.js",
        "reason": null
      },
      {
        "file": "tests/reset-delayed-consumers.test.js",
        "reason": null
      },
      {
        "file": "tests/resource-alerts-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/resource-alerts.test.js",
        "reason": null
      },
      {
        "file": "tests/retrieval/honest-retrieval.test.js",
        "reason": null
      },
      {
        "file": "tests/retrieval/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/rfc3339-schema-maxlength-matches-pattern.test.js",
        "reason": null
      },
      {
        "file": "tests/role-functions.test.js",
        "reason": null
      },
      {
        "file": "tests/role-library.test.js",
        "reason": null
      },
      {
        "file": "tests/role-mission-capability-hostile.js",
        "reason": null
      },
      {
        "file": "tests/rules-filing-from.test.js",
        "reason": null
      },
      {
        "file": "tests/rules-turn-snapshot.test.js",
        "reason": null
      },
      {
        "file": "tests/run-isolated-config-integrity.js",
        "reason": null
      },
      {
        "file": "tests/run-isolated-retained-state.test.cjs",
        "reason": "Canonical retained-state regression imported by the selected isolated-runner-retained-state.test.js wrapper."
      },
      {
        "file": "tests/run-isolated-socket-path-budget.test.js",
        "reason": null
      },
      {
        "file": "tests/run-isolated-suite-timeouts.js",
        "reason": null
      },
      {
        "file": "tests/run-isolated.js",
        "reason": "runner"
      },
      {
        "file": "tests/run-vertex-report-wave.js",
        "reason": "runner"
      },
      {
        "file": "tests/runtime-basic-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-command-fallback-scan.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-command-lookup-cache.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-command-lookup.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-refusal-coverage.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-security.js",
        "reason": null
      },
      {
        "file": "tests/runtime-state-root-adoption-indeterminate.test.js",
        "reason": null
      },
      {
        "file": "tests/runtime-state-root.test.js",
        "reason": null
      },
      {
        "file": "tests/sandbox-image-provisioning.test.js",
        "reason": null
      },
      {
        "file": "tests/sched/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/sched/service-control.js",
        "reason": null
      },
      {
        "file": "tests/scheduled-task-registrars.test.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-adapter.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-legacy-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-legacy.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-provider.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-runner.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-state.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-windows-legacy-mutation.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-windows-mutation.js",
        "reason": null
      },
      {
        "file": "tests/scheduler-windows-xml.js",
        "reason": null
      },
      {
        "file": "tests/schema-validator.js",
        "reason": null
      },
      {
        "file": "tests/scoped-approvals-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/scoped-approvals.test.js",
        "reason": null
      },
      {
        "file": "tests/screen-control-workflow.test.js",
        "reason": null
      },
      {
        "file": "tests/search-containment.test.js",
        "reason": null
      },
      {
        "file": "tests/search-query-revocation.test.js",
        "reason": null
      },
      {
        "file": "tests/search.js",
        "reason": null
      },
      {
        "file": "tests/search/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/search/search.js",
        "reason": null
      },
      {
        "file": "tests/secret-store-powershell-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/secret-store-requirements.test.js",
        "reason": null
      },
      {
        "file": "tests/secret-store.js",
        "reason": null
      },
      {
        "file": "tests/secret-store/doctor-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/secret-store/never-configured-is-not-broken.test.js",
        "reason": null
      },
      {
        "file": "tests/secret-store/powershell.test.js",
        "reason": null
      },
      {
        "file": "tests/secrets/credential-capture.js",
        "reason": null
      },
      {
        "file": "tests/secrets/credential-removal.js",
        "reason": null
      },
      {
        "file": "tests/secrets/device-credential-clear.js",
        "reason": null
      },
      {
        "file": "tests/secrets/payment-card-security-code-never-stored.js",
        "reason": null
      },
      {
        "file": "tests/secrets/payment-card-vault-safety.js",
        "reason": null
      },
      {
        "file": "tests/secrets/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/secrets/secret-exists-unreadable.js",
        "reason": null
      },
      {
        "file": "tests/secrets/vault-access-log-never-resurrects-store.js",
        "reason": null
      },
      {
        "file": "tests/secrets/vault-path-agreement.js",
        "reason": null
      },
      {
        "file": "tests/secrets/vault-presence.js",
        "reason": null
      },
      {
        "file": "tests/secrets/vault-write-crash-safety.js",
        "reason": null
      },
      {
        "file": "tests/secrets/vault-write-visibility.js",
        "reason": null
      },
      {
        "file": "tests/secrets/windows-device-credential-clear.js",
        "reason": null
      },
      {
        "file": "tests/servercontrol-mechanical-connect.test.js",
        "reason": null
      },
      {
        "file": "tests/service-control-listener-liveness.test.js",
        "reason": null
      },
      {
        "file": "tests/service-control-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/service-control.js",
        "reason": null
      },
      {
        "file": "tests/service-registry-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/service-registry-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/service-registry.js",
        "reason": null
      },
      {
        "file": "tests/session-workspace-ceiling.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-api-key-never-stored.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-elevation-shared-writes.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-enforcement-honesty.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-machine-record-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-pick-control.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-readonly-reason-is-read.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-registry-cache.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-registry-explanations.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-reset.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-rows-inert.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-selection.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-surface-readonly.test.js",
        "reason": null
      },
      {
        "file": "tests/settings-text-control.test.js",
        "reason": null
      },
      {
        "file": "tests/settings.test.js",
        "reason": null
      },
      {
        "file": "tests/setup-plan-step-invalid.test.js",
        "reason": null
      },
      {
        "file": "tests/setup-plan.test.js",
        "reason": null
      },
      {
        "file": "tests/setup-probe.test.js",
        "reason": null
      },
      {
        "file": "tests/setup-workspace.test.js",
        "reason": null
      },
      {
        "file": "tests/setup/first-run-setup.test.js",
        "reason": null
      },
      {
        "file": "tests/setup/pairing.test.js",
        "reason": null
      },
      {
        "file": "tests/setup/provider-auth.test.js",
        "reason": null
      },
      {
        "file": "tests/shared-write-guard-fail-closed.test.js",
        "reason": null
      },
      {
        "file": "tests/shared-write-guard-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/shipped-registry-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/short-code.js",
        "reason": null
      },
      {
        "file": "tests/source-freeze-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/source-freeze.js",
        "reason": null
      },
      {
        "file": "tests/source-license-drift.test.js",
        "reason": null
      },
      {
        "file": "tests/spawn-env-scrub-gate.test.js",
        "reason": null
      },
      {
        "file": "tests/spawn-hygiene.test.js",
        "reason": null
      },
      {
        "file": "tests/spawn-record.js",
        "reason": null
      },
      {
        "file": "tests/special-session-sealed-transport.js",
        "reason": null
      },
      {
        "file": "tests/ssrf-guard-uncovered-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/ssrf-guard.test.js",
        "reason": null
      },
      {
        "file": "tests/standing-orders-hook-dirty-tree.test.js",
        "reason": null
      },
      {
        "file": "tests/standing-orders-hook-git-destructive.test.js",
        "reason": null
      },
      {
        "file": "tests/standing-orders-inconsistent.test.js",
        "reason": null
      },
      {
        "file": "tests/standing-orders-protected-write.js",
        "reason": null
      },
      {
        "file": "tests/standing-orders.js",
        "reason": null
      },
      {
        "file": "tests/startup-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/state-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/state-store-close.test.js",
        "reason": null
      },
      {
        "file": "tests/state-store-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/state-store-research.test.js",
        "reason": null
      },
      {
        "file": "tests/state-store.js",
        "reason": null
      },
      {
        "file": "tests/status-injection-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/status-injection.test.js",
        "reason": null
      },
      {
        "file": "tests/status-visibility-hook.js",
        "reason": null
      },
      {
        "file": "tests/strict-lifecycle-record.test.js",
        "reason": null
      },
      {
        "file": "tests/strict-test-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "tests/supervision-lock.test.js",
        "reason": null
      },
      {
        "file": "tests/supervision-policy-firsttest2.test.js",
        "reason": null
      },
      {
        "file": "tests/supervision-policy-state-unreadable.test.js",
        "reason": null
      },
      {
        "file": "tests/supervision-policy.test.js",
        "reason": null
      },
      {
        "file": "tests/supervision/observer.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/action-guards.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/argv-drift.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/egress-preflight.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/enforcement-gaps.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/intent-fidelity.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/owner-authorization-surfaces.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/pipe-redirection.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/quarantine-preflight.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/surface.policy/standing-orders-hook.js",
        "reason": null
      },
      {
        "file": "tests/surface.policy/standing-orders.js",
        "reason": null
      },
      {
        "file": "tests/surface.registry/approvals.js",
        "reason": null
      },
      {
        "file": "tests/surface.registry/lane-scope-tool-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/surface.registry/mcp-tool-surface.js",
        "reason": null
      },
      {
        "file": "tests/surface.registry/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/surface.registry/tool-registry-egress-guard.js",
        "reason": null
      },
      {
        "file": "tests/swarm-presets.test.js",
        "reason": null
      },
      {
        "file": "tests/system-binaries-resolve-under-system-root.test.js",
        "reason": null
      },
      {
        "file": "tests/system-status-approvals-effective.test.js",
        "reason": null
      },
      {
        "file": "tests/system-status-entitlement-failure.test.js",
        "reason": null
      },
      {
        "file": "tests/system-status-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/t545-permission-provider-separation.test.js",
        "reason": null
      },
      {
        "file": "tests/task-concurrency.js",
        "reason": null
      },
      {
        "file": "tests/task-difficulty-adapters.test.js",
        "reason": null
      },
      {
        "file": "tests/task-difficulty-assignment.test.js",
        "reason": null
      },
      {
        "file": "tests/task-difficulty-store.test.js",
        "reason": null
      },
      {
        "file": "tests/task-difficulty.test.js",
        "reason": null
      },
      {
        "file": "tests/task-state.js",
        "reason": null
      },
      {
        "file": "tests/task-stdio.js",
        "reason": null
      },
      {
        "file": "tests/task-waiting-api-map.test.cjs",
        "reason": null
      },
      {
        "file": "tests/task-waiting-composition.test.js",
        "reason": null
      },
      {
        "file": "tests/task-waiting-ledger-lockout.test.js",
        "reason": null
      },
      {
        "file": "tests/task-waiting-legacy-core.test.js",
        "reason": null
      },
      {
        "file": "tests/task-waiting-schema.test.cjs",
        "reason": null
      },
      {
        "file": "tests/task-waiting.test.js",
        "reason": null
      },
      {
        "file": "tests/terminal-suppression.test.js",
        "reason": null
      },
      {
        "file": "tests/test-census.test.js",
        "reason": null
      },
      {
        "file": "tests/test-chain-short-circuit.test.js",
        "reason": null
      },
      {
        "file": "tests/test-ratchet.test.js",
        "reason": null
      },
      {
        "file": "tests/test-run-reconciliation.test.js",
        "reason": null
      },
      {
        "file": "tests/token-savings-benchmark.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-dispatch-policy-refresh.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-dispatch-scheduler.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-effect-classification.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-pack-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-registry-deferred-providers.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-registry-model-floor.js",
        "reason": null
      },
      {
        "file": "tests/tool-registry-r-ledger.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-registry-unique-items-enforced.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-surface-product-outcome.test.js",
        "reason": null
      },
      {
        "file": "tests/tool-surface-runner.test.js",
        "reason": null
      },
      {
        "file": "tests/tools-agent-preflight.test.js",
        "reason": null
      },
      {
        "file": "tests/tools-agent-sweep-js.test.js",
        "reason": null
      },
      {
        "file": "tests/tools-build-queue-migrate-js.test.js",
        "reason": null
      },
      {
        "file": "tests/tools.misc/run-vertex-report-wave.js",
        "reason": null
      },
      {
        "file": "tests/tools.misc/run.js",
        "reason": "runner"
      },
      {
        "file": "tests/tree-directory-durable-write.test.js",
        "reason": null
      },
      {
        "file": "tests/tree-directory-identity-and-naming.test.js",
        "reason": null
      },
      {
        "file": "tests/tree-directory-lock-contention.test.js",
        "reason": null
      },
      {
        "file": "tests/tree-identity.js",
        "reason": null
      },
      {
        "file": "tests/uac-delegation-client.js",
        "reason": null
      },
      {
        "file": "tests/uac-delegation-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/uac-delegation.js",
        "reason": null
      },
      {
        "file": "tests/uac-posture.test.js",
        "reason": null
      },
      {
        "file": "tests/uac-token-custody.test.js",
        "reason": null
      },
      {
        "file": "tests/ucr-sso-credential-interaction-required.test.js",
        "reason": null
      },
      {
        "file": "tests/ucr-sso.js",
        "reason": null
      },
      {
        "file": "tests/uncoded-refusals-carry-codes.test.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p02-inventory.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p04-boundaries.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p06-contracts.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p07-identifiers.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p08-provenance.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p09-redaction.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p10-evidence.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p11-audit.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p12-capability-manifests.js",
        "reason": null
      },
      {
        "file": "tests/unified-agent-p15-error-taxonomy.js",
        "reason": null
      },
      {
        "file": "tests/unit/config/config.test.js",
        "reason": null
      },
      {
        "file": "tests/unit/providers/provider-registry.test.js",
        "reason": null
      },
      {
        "file": "tests/usage-lifetime-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/allowance-buckets.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/claude-cached-utilization.js",
        "reason": null
      },
      {
        "file": "tests/usage/claude-usage-source.js",
        "reason": null
      },
      {
        "file": "tests/usage/codex-chatgpt.js",
        "reason": null
      },
      {
        "file": "tests/usage/dispatch-readiness.js",
        "reason": null
      },
      {
        "file": "tests/usage/gemini-quota.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/lifetime.js",
        "reason": null
      },
      {
        "file": "tests/usage/local-ledger.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/machine-load.js",
        "reason": null
      },
      {
        "file": "tests/usage/usage-contract-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/usage-contract.js",
        "reason": null
      },
      {
        "file": "tests/usage/usage-reader-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/usage/usage-reader.js",
        "reason": null
      },
      {
        "file": "tests/vault-access-policy-dispatch.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-access-policy-enforced.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-atomic-sharing.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-batched-read.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-hardening.js",
        "reason": null
      },
      {
        "file": "tests/vault-host-missing-worker.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-host-retirement.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-host.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-live-acl.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-location-authority.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-location-is-the-only-decider.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-location-parity.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-native.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-platform-unsupported.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-presence-cache-linux.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-presence-cache.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-read-cache.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-setter-error-boundary.test.cjs",
        "reason": "Canonical regression body imported by its selected .test.js wrapper."
      },
      {
        "file": "tests/vault-setter-error-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-shipped-acl.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-spawn-cost.test.js",
        "reason": null
      },
      {
        "file": "tests/vault-unreadable-is-not-absent.test.js",
        "reason": null
      },
      {
        "file": "tests/vertex-gemini-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/vertex-gemini-seat-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/video-artifacts.test.js",
        "reason": null
      },
      {
        "file": "tests/video-provider.test.js",
        "reason": null
      },
      {
        "file": "tests/web-inspector.test.js",
        "reason": null
      },
      {
        "file": "tests/web.js",
        "reason": null
      },
      {
        "file": "tests/window-thresholds.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-control.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-host-settlement-review-W16.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-owner-handshake.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-pre-ready-settlement.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-resource-admission.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-root-signal-native.test.js",
        "reason": null
      },
      {
        "file": "tests/windows-job-root-signal.test.js",
        "reason": null
      },
      {
        "file": "tests/workspace-boundary-path-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/workspace-boundary.test.js",
        "reason": null
      },
      {
        "file": "tests/workstation-refusals.test.js",
        "reason": null
      },
      {
        "file": "tests/workstation-resolution-indeterminate.test.js",
        "reason": null
      },
      {
        "file": "tests/workstation.js",
        "reason": null
      },
      {
        "file": "tests/worktree-commit-guard.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-conpty-relay.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-conpty-resize.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-conpty-space-paths.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal-commands.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal-e2e.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal-preview-race.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal-resize.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal-timing.test.js",
        "reason": null
      },
      {
        "file": "tests/zed-context-terminal.test.js",
        "reason": null
      },
      {
        "file": "tools/gemini-fleet.test.js",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/branch-disposal-audit.selftest.mjs",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/clean-env-launch.selftest.mjs",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/electron-run-as-node-guard.selftest.mjs",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/installer-identity-audit.selftest.mjs",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/invoked-directly.selftest.mjs",
        "reason": null
      },
      {
        "file": "tools/launch-readiness/toolchain-independence-audit.selftest.mjs",
        "reason": null
      }
    ],
    "aliases": {
      "posttest": "node tools/check-chain-runner.js --name posttest --then --id dashboard-task-port-guard node tests/run-isolated.js tests/dashboard-task-port-guard.js --then --id test-ratchet npm run test:ratchet:check",
      "pretest": "node tools/check-chain-runner.js --name pretest --then --id naming-ratchet node tools/check-naming.js --then node tools/invocation-guard.js --then node tests/run-isolated.js tests/invocation-guard.test.js tests/iphone-handoff-runtime-boundary.test.js tests/gemini-fleet.js tests/owner-identity-purpose-gate.js tests/coordinator-backup-age-status.test.js --then --id unwired-campaign-suites node tests/run-isolated.js --continue tests/fork-ledger.test.js tests/lane-territory-gate.test.js tests/pkg.tree/package-check-baseline.js tests/settings-registry.test.js tests/settings-surface-readonly.test.js tests/settings.test.js tools/launch-readiness/branch-disposal-audit.selftest.mjs tools/launch-readiness/clean-env-launch.selftest.mjs tools/launch-readiness/electron-run-as-node-guard.selftest.mjs tools/launch-readiness/installer-identity-audit.selftest.mjs tools/launch-readiness/toolchain-independence-audit.selftest.mjs --from tests/suites/page2-runtime-regressions.txt --then --id adversarial-orphans npm run test:adversarial --then --id test-chain-short-circuit node tests/run-isolated.js tests/test-chain-short-circuit.test.js --then --id red-gates-orphans npm run test:red-gates-orphans --then --id test-run-reconciliation node tests/run-isolated.js tests/test-run-reconciliation.test.js --then npm run test:dependency-acceptance --then npm run test:repo-protocol --then npm run test:claude-credential-fence --then npm run test:agent-engine --then npm run test:agent-engine:process --then --id research-subsystem npm run test:research-subsystem --then --id orphans-wired-0905 node tests/run-isolated.js --continue --from tests/suites/orphans-wired-0905.txt",
      "test": "node tools/check-chain-runner.js --name test --then --id root-suite node tests/run-isolated.js --from tests/suites/root-suite.txt --then --id agent-comms-orphans node tests/run-isolated.js --from tests/suites/agent-comms-orphans.txt --then --id agent-roster-orphans node tests/run-isolated.js --from tests/suites/agent-roster-orphans.txt --then --id agent-wake-orphans node tests/run-isolated.js --from tests/suites/agent-wake-orphans.txt --then --id build-queue-orphans node tests/run-isolated.js --from tests/suites/build-queue-orphans.txt --then --id coordinator-backup-orphans node tests/run-isolated.js --from tests/suites/coordinator-backup-orphans.txt --then --id fleet-supervisor-orphans node tests/run-isolated.js --from tests/suites/fleet-supervisor-orphans.txt --then --id luna-worktree-orphans node tests/run-isolated.js --from tests/suites/luna-worktree-orphans.txt --then --id link-bus-orphans node tests/run-isolated.js --from tests/suites/link-bus-orphans.txt --then --id online-surface-orphans node tests/run-isolated.js --from tests/suites/online-surface-orphans.txt --then --id remote-surface-orphans node tests/run-isolated.js --from tests/suites/remote-surface-orphans.txt --then --id special-session-orphans node tests/run-isolated.js --from tests/suites/special-session-orphans.txt --then --id ledger-and-evidence-orphans node tests/run-isolated.js --from tests/suites/ledger-and-evidence-orphans.txt --then --id entitlement-redteam-orphans node tests/run-isolated.js --from tests/suites/entitlement-redteam-orphans.txt --then --id intent-and-council-orphans node tests/run-isolated.js --from tests/suites/intent-and-council-orphans.txt --then --id controller-and-model-orphans node tests/run-isolated.js --from tests/suites/controller-and-model-orphans.txt --then --id usage-orphans node tests/run-isolated.js --from tests/suites/usage-orphans.txt --then --id process-visibility-orphans node tests/run-isolated.js --from tests/suites/process-visibility-orphans.txt --then --id package-tree-orphans node tests/run-isolated.js --from tests/suites/package-tree-orphans.txt --then --id surface-policy-orphans node tests/run-isolated.js --from tests/suites/surface-policy-orphans.txt --then --id local-node-orphans node tests/run-isolated.js --from tests/suites/local-node-orphans.txt --then --id workstation-and-launch-orphans node tests/run-isolated.js --from tests/suites/workstation-and-launch-orphans.txt --then --id google-suite-orphans node tests/run-isolated.js --from tests/suites/google-suite-orphans.txt --then --id zed-terminal-orphans node tests/run-isolated.js --from tests/suites/zed-terminal-orphans.txt --then npm run test:fra --then npm run test:coverage-audit --then npm run test:settings-registry-explanations --then npm run test:invocation-orphans --then --id orphans-wired-0823 npm run test:orphans-wired-0823 --then npm run test:generated-mirrors --then --id capability-index npm run test:capability-index --then --id capability-recall npm run test:capability-recall --then npm run test:idle-cpu --then npm run test:spawn-env-scrub --then npm run test:shipped-registry-boundary --then npm run test:role-library --then --id retrieval-orphans npm run test:retrieval --then --id finished-queue-orphans npm run test:finished-queue --then --id key-custody npm run test:key-custody --then --id plan-identities npm run test:plan-identities --then --id system-binaries node tests/run-isolated.js tests/system-binaries-resolve-under-system-root.test.js --then --id orphans-wired-0824 node tests/run-isolated.js --from tests/suites/orphans-wired-0824.txt --then --id orphans-wired-0826 node tests/run-isolated.js --from tests/suites/orphans-wired-0826.txt --then --id orphans-wired-0826b node tests/run-isolated.js --from tests/suites/orphans-wired-0826b.txt --then --id tools-coverage-0826 node tests/run-isolated.js --from tests/suites/tools-coverage-0826.txt --then --id orphans-wired-0901 node tests/run-isolated.js --from tests/suites/orphans-wired-0901.txt --then --id orphans-wired-0903 node tests/run-isolated.js --from tests/suites/orphans-wired-0903.txt --then --id orphans-wired-0907 node tests/run-isolated.js --from tests/suites/orphans-wired-0907.txt --then --id orphans-wired-0911 node tests/run-isolated.js --from tests/suites/orphans-wired-0911.txt --then --id orphans-wired-0916 node tests/run-isolated.js --from tests/suites/orphans-wired-0916.txt --then --id config-integrity-guard npm run test:config-integrity-guard",
      "test:action-permission-profiles": "node tests/run-isolated.js tests/action-permission-profiles.test.js",
      "test:adversarial": "node tests/run-isolated.js --continue --from tests/suites/adversarial.txt",
      "test:agent-comms-transport": "node tests/run-isolated.js tests/agent-comms/transport-adapter-conformance.js",
      "test:agent-contract-discovery": "node tests/run-isolated.js tests/agent-contract-discovery.test.js",
      "test:agent-digest": "node tests/run-isolated.js tests/agent-digest-schedule.js tests/agent-digest-lock.js tests/agent-digest.js tests/owner-delivery.js",
      "test:agent-engine": "node tests/run-isolated.js tests/agent-engine/codex-adapter.js tests/agent-engine/codex-turn-failure-details.test.js tests/agent-engine/claude-adapter.js tests/agent-engine/hidden-spawn-fence.test.js tests/hidden-spawn-root-guard.test.js tests/agent-engine/astra-native-acceptance-structured.test.js tests/blank-role-continuation.test.js tests/provider-autonomy-regressions.test.js",
      "test:agent-engine:live": "node tests/run-isolated.js tests/agent-engine/codex-live-turn.js tests/agent-engine/claude-live-turn.js",
      "test:agent-engine:process": "node tests/run-isolated.js tests/agent-engine/codex-process.test.js tests/agent-engine/codex-startup-cancellation.test.js tests/agent-engine/claude-process.test.js tests/agent-engine/claude-cli-process.test.js tests/agent-engine/claude-mcp-args.test.js tests/agent-engine/root-admission.test.js",
      "test:agent-lane-provider-spawn-gate": "node tests/run-isolated.js tests/agent-lane-provider-spawn-gate.test.js",
      "test:agent-lane-verdict-normalization": "node tests/run-isolated.js tests/agent-lane-verdict-normalization.test.js",
      "test:agent-presence": "node tests/run-isolated.js tests/agent-presence.test.js",
      "test:all": "node tools/test-run.js --all",
      "test:anywhere-transport": "node tests/run-isolated.js tests/anywhere-transport.js tests/anywhere-netbird.test.js",
      "test:audit": "node tests/kernel.audit/run.js",
      "test:audit-lock-scope": "node tests/run-isolated.js tests/audit-lock-scope.test.js",
      "test:auth.duo": "node tests/auth.duo/run.js",
      "test:auth.google": "node tests/auth.google/run.js",
      "test:backup-duty": "node tests/run-isolated.js tests/backup-duty.test.js",
      "test:bridge-status": "node tests/run-isolated.js tests/bridge-status.js",
      "test:browser": "node tests/run-isolated.js tests/browser-owner.js tests/playwright-gateway.js tests/playwright-smoke.js",
      "test:canonical-path": "node tests/run-isolated.js tests/canonical-path.js",
      "test:capability-index": "node tools/check-chain-runner.js --name test:capability-index --then node tools/build-capability-index.js --check",
      "test:capability-mirror": "node tools/check-chain-runner.js --name test:capability-mirror --then node tests/run-isolated.js tests/check-capability-mirror.test.js",
      "test:capability-recall": "node tools/check-chain-runner.js --name capability-recall --then node tests/run-isolated.js tests/capability-recall.test.js --then node tests/capability-recall-eval.js --ratchet",
      "test:census": "node tests/run-isolated.js tests/test-census.test.js",
      "test:claude-credential-fence": "node tests/run-isolated.js tests/agent-engine/claude-subscription-credential-fence.test.js tests/agent-engine/claude-session-environment.test.js tests/providers/launch-environment-case.test.js tests/agent-engine/claude-ambient-key-default.test.js tests/providers/credential-scrub-round2.test.js",
      "test:cloud-agent": "node tests/run-isolated.js tests/cloud-agent-contract.test.js tests/codex-cloud-provider.test.js tests/codex-cli-transport.test.js tests/cloud-lane.test.js tests/codex-cloud-launch.test.js tests/codex-cloud-environments.test.js tests/cloud-mirror.test.js tests/cloud-mirror-network-containment.test.js",
      "test:code-intel": "node tests/code.intel/run.js",
      "test:code-intel:live": "node tests/code-intel-live.js",
      "test:code.intel": "node tests/code.intel/run.js",
      "test:cold-start": "node tools/cold-start-check.js",
      "test:config-integrity-guard": "node tests/run-isolated.js --from tests/suites/config-integrity-guard.txt",
      "test:controller": "node tests/controller/run.js",
      "test:coordinator": "node tests/run-isolated.js tests/coordinator-heartbeat.test.js tests/coordinator-duty-registry.test.js tests/coordinator-duty-host.test.js tests/coordinator-escalation-policy.test.js tests/coordinator-escalation-sink.test.js tests/argv-drift.test.js tests/fleet-supervisor-startup-refusal.test.js tests/managed-processes.test.js tests/process-visibility-refresh.test.js tests/scheduled-task-registrars.test.js tests/health-observer.test.js",
      "test:coverage-audit": "node tests/run-isolated.js tests/agent-activity-contracts.js tests/grepsaver-orient.js tests/iphone-handoff.js tests/ucr-sso.js tests/owner-chat.js tests/owner-directive-inbox.js tests/owner-prompt-theme.test.js tests/owner-public-prompts.test.js tests/owner-prompt-provenance.test.js tests/purchase-recording.test.js tests/owner-prompt-purchase-wiring.test.js tests/owner-form-contract.js tests/owner-prompt-queue.js tests/provider-untrusted-content.js tests/terminal-suppression.test.js tests/unified-agent-p04-boundaries.js tests/unified-agent-p06-contracts.js tests/unified-agent-p07-identifiers.js tests/unified-agent-p08-provenance.js tests/unified-agent-p09-redaction.js tests/unified-agent-p10-evidence.js tests/unified-agent-p11-audit.js tests/unified-agent-p12-capability-manifests.js tests/unified-agent-p15-error-taxonomy.js",
      "test:crossrepo": "node tools/check-chain-runner.js --name test:crossrepo --then node tests/online-fra-relay-shell.js --then node tests/online-fra-web-client.js --then node tests/online-fra-renewal.test.js --then node tests/online-fra-relay-shell-solo.js",
      "test:delegation": "node tests/delegation/run.js",
      "test:delegation-adapters": "node tests/run-isolated.js tests/delegation-contracts.js tests/delegation-adapter-contracts.js tests/delegation-fake-adapters.js tests/delegation-task-projection.js tests/delegation-task-observation.js tests/delegation-task-attempt-projection.js",
      "test:delegation-readonly": "node tests/run-isolated.js tests/delegation-contracts.js tests/delegation-adapter-contracts.js tests/delegation-readonly-qualification.js",
      "test:dependency-acceptance": "node tests/run-isolated.js tests/dependency-acceptance.test.js",
      "test:desktop": "node tests/run-isolated.js tests/approval-prompt-completeness.test.js tests/desktop-silent-catch.test.js tests/desktop-advanced.js tests/desktop-window-close-guard.js tests/desktop-app-capture.js",
      "test:desktop.browser": "node tests/desktop.browser/run.js",
      "test:desktop.native": "node tests/desktop.native/run.js",
      "test:entry": "node tests/entry/run.js",
      "test:error-taxonomy-secret-input": "node tests/run-isolated.js tests/error-taxonomy-secret-input.test.js",
      "test:evidence": "node tests/evidence/run.js",
      "test:finished-queue": "node tests/run-isolated.js --continue tests/build-queue-provenance.test.js tests/build-queue-provenance-live.test.js",
      "test:firebase": "node tests/run-isolated.js tests/firebase-account-login.js",
      "test:fleet": "node tests/fleet/run.js",
      "test:fra": "node tests/run-isolated.js tests/direct-link.test.js tests/startup-policy.test.js tests/fra-audit-admission-cache.js tests/fra-capability-manifest.js tests/fra-doctor.js tests/fra-endpoint-manifests.js tests/fra-keeper-heartbeat-log.js tests/fra-lifecycle-guards.js tests/fra-machine-identity.js tests/fra-manifest-permission-tier.test.js tests/fra-manifest-repin.js tests/fra-lifecycle-tunnel-notice.js tests/fra-peer-heartbeat.js tests/fra-readiness-gates.js tests/fra-real-ledger-slo.js tests/fra-root-access-control.js tests/fra-root-access.js tests/fra-runtime-integrity.js tests/fra-secure-session.js tests/fra-token-enrollment-lifecycle.js tests/fra-token-enrollment-operator.js tests/fra-token-enrollment-protocol.js tests/fra-token-enrollment-vault.js tests/fra-transport-binding.js tests/fra-vault-key-binding.js tests/fra-workspace-handles.js tests/full-remote-access-bridge.js tests/full-remote-access-control-contract.js tests/full-remote-access-enroll-peer.js tests/full-remote-access-enroll-token.js tests/full-remote-access-lifecycle.js tests/full-remote-access-mcp-proxy.js tests/full-remote-access-preflight.js tests/full-remote-access-release-enroll.js tests/fra-surface-security.js tests/servercontrol-mechanical-connect.test.js",
      "test:gateway": "node tests/run-isolated.js tests/playwright-gateway.js",
      "test:gcloud": "node tests/run-isolated.js tests/gcloud-account-inspector.js tests/gcloud-account-login.js tests/firebase-account-login.js",
      "test:gemini-agentic": "node tests/run-isolated.js tests/gemini-agentic.js",
      "test:gemini-fleet-selection": "node tools/gemini-fleet.test.js",
      "test:gemini-quota": "node tests/run-isolated.js tests/usage/allowance-buckets.test.js tests/usage/gemini-quota.test.js",
      "test:generated-mirrors": "node tools/check-chain-runner.js --name test:generated-mirrors --then node tools/generate-mirrors.js --check",
      "test:grepsaver": "node tests/run-isolated.js tests/grepsaver/grepsaver.js tests/grepsaver/reindex.js",
      "test:health-invariants": "node tests/run-isolated.js tests/health-invariants.test.js",
      "test:idle-cpu": "node tools/check-chain-runner.js --name test:idle-cpu --then node tools/idle-cpu-check.js",
      "test:intent-fidelity:live": "node tests/intent-fidelity-live.js --live",
      "test:invocation-orphans": "node tests/run-isolated.js tests/configure-editor-perf.test.js tests/cold-start-response-contract.test.js tests/permission-session-chokepoint.test.js tests/entitlement-sold-surface.test.js tests/purchase-cart-view.test.js tests/check-live-task-roots.test.js tests/multi-account-failover.test.js tests/owner-request-provenance.js",
      "test:isolation": "node tests/run-isolated.js tests/isolation-contract.js tests/audit-intent.js",
      "test:kernel.audit": "node tests/kernel.audit/run.js",
      "test:kernel.policy": "node tests/kernel.policy/run.js",
      "test:kernel.runtime": "node tests/kernel.runtime/run.js",
      "test:kernel.state": "node tests/kernel.state/run.js",
      "test:key-custody": "node tools/check-chain-runner.js --name test:key-custody --then node tests/key-custody/run.js",
      "test:lane-scope": "node tests/run-isolated.js tests/lane-scope.test.js",
      "test:lane-territory-check": "node tests/run-isolated.js tests/lane-territory-check.test.js",
      "test:ledger-gate-writer": "node tests/run-isolated.js tests/ledger-gate-writer.js",
      "test:license-trust": "node tests/run-isolated.js tests/providers.billing/license-provider.js tests/license-store.test.js",
      "test:linux-native": "node tests/linux-native.js",
      "test:linux-sandbox-live": "node tests/run-isolated.js tests/linux-sandbox-sterile-live-smoke.js",
      "test:linux-sandbox-workspace-live": "node tests/run-isolated.js tests/linux-sandbox-workspace-live.test.js",
      "test:memory": "node tests/memory/run.js",
      "test:models": "node tests/models/run.js",
      "test:orphans-wired-0823": "node tests/run-isolated.js tests/agent-comms/relay-edge.js tests/capability-recall-demo.js tests/coordinator-escalation-resend.test.js tests/coordinator-owner-alarm-channel.test.js tests/every-module-parses.test.js tests/loads-on-a-customer-registry.test.js tests/mission-bridge-bench.test.js tests/mission-bridge-machines.test.js tests/no-blocking-prompt-hook.test.js tests/online-fra-e2e-session.interop.test.js tests/provider-charters.js tests/zed-context-terminal-e2e.test.js --from tests/suites/orphans-wired-0824.txt --from tests/suites/orphans-wired-w2.txt",
      "test:owner.digest": "node tests/owner.digest/run.js",
      "test:owner.ledger": "node tests/run-isolated.js tests/owner.ledger/ledger-query.js tests/ledger-authority.test.js tests/owner-capture-audit.test.js tests/owner-ingress-spool.test.js tests/owner-spool-review.test.js",
      "test:personal-calendar": "node tests/run-isolated.js tests/personal-calendar.js",
      "test:pkg.tree": "node tests/run-isolated.js tests/pkg.tree/package-manifest-contract.js tests/pkg.tree/package-manifest-contract-adversarial.js tests/pkg.tree/package-check.js tests/pkg.tree/package-check-adversarial-g8.js",
      "test:plan-identities": "node tests/run-isolated.js tests/entitlement-reserved-plans.test.js",
      "test:proc-run": "node tests/proc-run.js",
      "test:provider-release": "npm run test:providers && npm run test:providers.billing && npm run test:providers.gateway && npm run test:providers.github && npm run test:providers.google.suite && npm run test:providers.infrastructure && npm run test:providers.iphone.handoff && npm run test:providers.launch && npm run test:providers.misc && npm run test:providers.research && npm run test:providers.sandbox && npm run test:providers.web",
      "test:provider-session-isolation": "node tests/run-isolated.js tests/provider-session-isolation.test.js",
      "test:providers": "node tests/run-isolated.js tests/controller-focus.js tests/controller-projection.js tests/cli-session-usage.js",
      "test:providers.billing": "node tests/providers.billing/run.js",
      "test:providers.gateway": "node tests/providers.gateway/run.js",
      "test:providers.github": "node tests/providers.github/run.js",
      "test:providers.google.suite": "node tests/providers.google.suite/run.js",
      "test:providers.infrastructure": "node tests/providers.infrastructure/run.js",
      "test:providers.iphone.handoff": "node tests/providers.iphone.handoff/run.js",
      "test:providers.launch": "node tests/providers.launch/run.js",
      "test:providers.misc": "node tests/providers.misc/run.js",
      "test:providers.research": "node tests/providers.research/run.js",
      "test:providers.sandbox": "node tests/providers.sandbox/run.js",
      "test:providers.web": "node tests/providers.web/run.js",
      "test:ratchet": "node tools/test-ratchet.mjs",
      "test:ratchet:check": "node tools/check-chain-runner.js --name test:ratchet:check --then node tools/test-ratchet.mjs --from-summary state/test-runs/latest.json --max-age-hours 24",
      "test:ratchet:ship": "node tools/test-ratchet.mjs --ship",
      "test:red-gates-orphans": "node tests/run-isolated.js --continue tests/agent-onboarding-hook-contract.js tests/agent-onboarding.js tests/r-ledger.test.js tests/r-ledger-check.test.js tests/r-ledger-agent-gate.test.js tests/r-ledger-proposals.test.js tests/tool-registry-r-ledger.test.js tests/mcp-actor-binding.test.js tests/agent-lane.test.js tests/build-queue-corpus.js tests/build-queue-migration.js tests/link-bus.js tests/sched/service-control.js tests/audit-spool-ingestion.test.js tests/cloud-agent-contract.test.js tests/cloud-lane.test.js tests/codex-cli-transport.test.js tests/codex-cloud-provider.test.js tests/comms-naming-contract.test.js tests/link.bus/link-bus.js tests/ledger-archive.js tests/ledger-verbatim-migration.js tests/legacy-dotted-migration.js tests/mission-bridge-bootstrap-auth.test.js tests/mission-bridge-refusal-reason.test.js tests/mission-bridge-killswitch.test.js tests/mission-bridge-cloud-binding.test.js tests/mission-bridge-termination.test.js tests/mission-bridge-ledger-archive.test.js tests/owner-directive-notification.js tests/owner-request-archive-resolution.js tests/owner-request-lifecycle-projection.js tests/owner-request-scope-proposal.js tests/owner-request-status-projection.js tests/request-id.js tests/request-version/legacy-dotted-disposition.js tests/tool-effect-classification.test.js",
      "test:remote-surface-tier": "node tests/run-isolated.js tests/remote-surface-tier-parity.test.js",
      "test:repo-protocol": "node tests/run-isolated.js --continue --from tests/suites/repo-protocol.txt",
      "test:research-subsystem": "node tests/run-isolated.js tests/research-provider.test.js tests/research-bridge-actions.test.js tests/research-runners.test.js tests/research-process-policy-admission.test.js tests/research-queued-policy.test.js tests/research-provenance.test.js tests/research-study-protocol.test.js tests/research-runs-worker.test.js tests/research-runs-runtime.test.js tests/research-worker-supervisor.test.js tests/research-worker-protocol.test.js tests/research-lifecycle-channel.test.js tests/state-store-research.test.js tests/research-generated-result-digests.test.js tests/research-run-pages.test.js",
      "test:resume-refuse-by-provider": "node tests/run-isolated.js tests/agent-engine/resume-refuse-by-provider.test.js",
      "test:retrieval": "node tests/run-isolated.js tests/retrieval/honest-retrieval.test.js",
      "test:role-library": "node tests/run-isolated.js tests/role-library.test.js tests/blank-tree-role.test.js tests/empty-role-directions.test.js",
      "test:sandbox": "node tests/run-isolated.js tests/agent-sandbox.js",
      "test:sandbox-image-provisioning": "node tests/run-isolated.js tests/sandbox-image-provisioning.test.js",
      "test:sandbox:live": "node tests/agent-sandbox-live-smoke.js",
      "test:sched": "node tests/sched/run.js",
      "test:scheduler": "node tests/run-isolated.js tests/scheduler-state.js tests/scheduler-legacy.js tests/scheduler-adapter.js tests/scheduler-provider.js tests/scheduler-runner.js tests/scheduler-windows-xml.js tests/scheduler-windows-mutation.js tests/scheduler-windows-legacy-mutation.js",
      "test:scheduler:mutation": "node tests/run-isolated.js tests/scheduler-windows-mutation.js tests/scheduler-windows-legacy-mutation.js",
      "test:search": "node tests/search/run.js",
      "test:secrets": "node tests/secrets/run.js",
      "test:settings-registry-explanations": "node tests/run-isolated.js tests/settings-registry-explanations.test.js",
      "test:shipped-registry-boundary": "node tests/run-isolated.js tests/shipped-registry-boundary.test.js",
      "test:spawn-env-scrub": "node tests/run-isolated.js tests/spawn-env-scrub-gate.test.js",
      "test:spawn-hygiene": "node tests/run-isolated.js tests/spawn-hygiene.test.js",
      "test:spawn-record": "node tests/run-isolated.js tests/spawn-record.js",
      "test:standing-orders-git-destructive": "node tests/run-isolated.js tests/standing-orders-hook-git-destructive.test.js",
      "test:state": "node tests/kernel.state/run.js",
      "test:strict": "node tools/test-strict.js",
      "test:supervision-policy": "node tests/run-isolated.js tests/supervision-policy.test.js",
      "test:surface.policy": "node tests/surface.policy/run.js",
      "test:surface.registry": "node tests/surface.registry/run.js",
      "test:task": "node tests/run-isolated.js tests/task-state.js tests/task-concurrency.js tests/task-stdio.js",
      "test:unified-agent-inventory": "node tests/run-isolated.js tests/unified-agent-p02-inventory.js",
      "test:unified-agent-p14": "node tests/run-isolated.js tests/scoped-approvals.test.js tests/scoped-approvals-refusals.test.js"
    }
  },
  "scribe": {
    "inventory": [
      {
        "file": "test/test_agent_live.js",
        "reason": null
      },
      {
        "file": "test/test_agent_state.js",
        "reason": null
      },
      {
        "file": "test/test_boot.js",
        "reason": null
      },
      {
        "file": "test/test_codex_agent_state.js",
        "reason": null
      },
      {
        "file": "test/test_current_content.py",
        "reason": null
      },
      {
        "file": "test/test_customer_smoke.js",
        "reason": null
      },
      {
        "file": "test/test_docmodel.py",
        "reason": null
      },
      {
        "file": "test/test_docmodel_fuzz.py",
        "reason": null
      },
      {
        "file": "test/test_flow_live.js",
        "reason": null
      },
      {
        "file": "test/test_format.js",
        "reason": null
      },
      {
        "file": "test/test_format_batch.py",
        "reason": null
      },
      {
        "file": "test/test_guard.js",
        "reason": null
      },
      {
        "file": "test/test_http_agent.js",
        "reason": null
      },
      {
        "file": "test/test_lane.js",
        "reason": null
      },
      {
        "file": "test/test_mcp_transport.js",
        "reason": null
      },
      {
        "file": "test/test_model.js",
        "reason": null
      },
      {
        "file": "test/test_orchestration_robustness.js",
        "reason": null
      },
      {
        "file": "test/test_perf.js",
        "reason": null
      },
      {
        "file": "test/test_pid_registry.js",
        "reason": null
      },
      {
        "file": "test/test_predict.js",
        "reason": null
      },
      {
        "file": "test/test_propose.js",
        "reason": null
      },
      {
        "file": "test/test_python_hosts.py",
        "reason": null
      },
      {
        "file": "test/test_research.js",
        "reason": null
      },
      {
        "file": "test/test_resolve.js",
        "reason": null
      },
      {
        "file": "test/test_runtime_boundaries.js",
        "reason": null
      },
      {
        "file": "test/test_server.js",
        "reason": null
      },
      {
        "file": "test/test_ui_regressions.js",
        "reason": null
      },
      {
        "file": "test/test_viewer.js",
        "reason": null
      },
      {
        "file": "test/test_voice.js",
        "reason": null
      },
      {
        "file": "test/test_watch.js",
        "reason": null
      }
    ],
    "aliases": {
      "test": "node test/run-tests.js",
      "test:current": "python test/test_current_content.py",
      "test:live": "node test/test_agent_live.js && node test/test_flow_live.js"
    }
  },
  "web-editor": {
    "inventory": [
      {
        "file": "accessibility.test.js",
        "reason": null
      },
      {
        "file": "agent-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "boot.test.js",
        "reason": null
      },
      {
        "file": "fresh-install.test.js",
        "reason": null
      },
      {
        "file": "history-preview.test.js",
        "reason": null
      },
      {
        "file": "mcp-web.test.js",
        "reason": null
      },
      {
        "file": "publish.test.js",
        "reason": null
      },
      {
        "file": "security.test.js",
        "reason": null
      },
      {
        "file": "setup.test.js",
        "reason": null
      },
      {
        "file": "web-agent.test.js",
        "reason": null
      }
    ],
    "aliases": {
      "test": "node run-tests.js"
    }
  },
  "presentation-suite": {
    "inventory": [
      {
        "file": "agent-chat-visibility.test.js",
        "reason": null
      },
      {
        "file": "agent-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "agent-lock-release.test.js",
        "reason": null
      },
      {
        "file": "agent-reply-board.test.js",
        "reason": null
      },
      {
        "file": "agents.test.js",
        "reason": null
      },
      {
        "file": "animation-preview.test.js",
        "reason": null
      },
      {
        "file": "applyop.test.js",
        "reason": null
      },
      {
        "file": "backend-robustness.test.js",
        "reason": null
      },
      {
        "file": "board-hook.test.js",
        "reason": null
      },
      {
        "file": "board-persistence.test.js",
        "reason": null
      },
      {
        "file": "cdp-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "codex-agent-protocol.test.js",
        "reason": null
      },
      {
        "file": "codex-agent.test.js",
        "reason": null
      },
      {
        "file": "com-host.test.js",
        "reason": null
      },
      {
        "file": "configurable-house-rules.test.js",
        "reason": null
      },
      {
        "file": "control-contract.test.js",
        "reason": null
      },
      {
        "file": "current_content.test.py",
        "reason": null
      },
      {
        "file": "dashboard-composer.test.js",
        "reason": null
      },
      {
        "file": "element-history.test.js",
        "reason": null
      },
      {
        "file": "export_scripts.test.ps1",
        "reason": null
      },
      {
        "file": "fast-mode-ui.test.js",
        "reason": null
      },
      {
        "file": "final_deck_acceptance.test.py",
        "reason": null
      },
      {
        "file": "frontend-actions.test.js",
        "reason": null
      },
      {
        "file": "frontend-browser-smoke.test.js",
        "reason": null
      },
      {
        "file": "frontend-download.test.js",
        "reason": null
      },
      {
        "file": "frontend-history.test.js",
        "reason": null
      },
      {
        "file": "frontend-state.test.js",
        "reason": null
      },
      {
        "file": "looprunner.test.js",
        "reason": null
      },
      {
        "file": "mcp-ppt-media.test.js",
        "reason": null
      },
      {
        "file": "mcp-ppt.test.js",
        "reason": null
      },
      {
        "file": "model-persistence.test.js",
        "reason": null
      },
      {
        "file": "pause-persistence.test.js",
        "reason": null
      },
      {
        "file": "pause-transition.test.js",
        "reason": null
      },
      {
        "file": "pdf-export-race.test.js",
        "reason": null
      },
      {
        "file": "ppt-guard.test.js",
        "reason": null
      },
      {
        "file": "presence-beacon.test.js",
        "reason": null
      },
      {
        "file": "protections.test.js",
        "reason": null
      },
      {
        "file": "reaper-safety.test.js",
        "reason": null
      },
      {
        "file": "reaper.test.js",
        "reason": null
      },
      {
        "file": "render-pipeline.test.js",
        "reason": null
      },
      {
        "file": "render_tools.test.py",
        "reason": null
      },
      {
        "file": "setup.test.js",
        "reason": null
      },
      {
        "file": "spend-persistence.test.js",
        "reason": null
      },
      {
        "file": "sse-lifecycle.test.js",
        "reason": null
      },
      {
        "file": "state-control-persistence.test.js",
        "reason": null
      },
      {
        "file": "studio-composer.test.js",
        "reason": null
      },
      {
        "file": "studio-escape.test.js",
        "reason": null
      },
      {
        "file": "studio-keyboard.test.js",
        "reason": null
      },
      {
        "file": "studio-provider.test.js",
        "reason": null
      },
      {
        "file": "task-recovery.test.js",
        "reason": null
      },
      {
        "file": "task-update-cli.test.js",
        "reason": null
      },
      {
        "file": "test-boot.js",
        "reason": null
      },
      {
        "file": "test/customer-smoke.test.js",
        "reason": null
      },
      {
        "file": "thumbs-deferred.test.js",
        "reason": null
      },
      {
        "file": "thumbs-snapshot.test.js",
        "reason": null
      }
    ],
    "aliases": {
      "test": "node run-tests.js",
      "test:agents": "node reaper.test.js && node looprunner.test.js",
      "test:core": "npm run test:core:server && npm run test:core:state && npm run test:core:agents && npm run test:core:frontend",
      "test:core:agents": "node agents.test.js && node task-recovery.test.js && node reaper-safety.test.js && node task-update-cli.test.js && node agent-lock-release.test.js && node agent-reply-board.test.js && node agent-lifecycle.test.js && node codex-agent.test.js && node mcp-ppt.test.js && node mcp-ppt-media.test.js",
      "test:core:frontend": "node thumbs-snapshot.test.js && node thumbs-deferred.test.js && node presence-beacon.test.js && node studio-composer.test.js && node dashboard-composer.test.js && node studio-keyboard.test.js && node studio-escape.test.js && node sse-lifecycle.test.js && node studio-provider.test.js && node fast-mode-ui.test.js && node animation-preview.test.js",
      "test:core:server": "node configurable-house-rules.test.js && node ppt-guard.test.js && node applyop.test.js",
      "test:core:state": "node pause-transition.test.js && node pause-persistence.test.js && node state-control-persistence.test.js && node spend-persistence.test.js && node model-persistence.test.js && node board-persistence.test.js && node protections.test.js && node element-history.test.js",
      "test:loops": "node looprunner.test.js",
      "test:reaper": "node reaper.test.js",
      "test:recovery": "node task-recovery.test.js",
      "test:robustness": "npm run test:robustness:server && npm run test:robustness:protocol && npm run test:robustness:frontend && npm run test:robustness:render",
      "test:robustness:frontend": "node frontend-state.test.js && node frontend-history.test.js && node frontend-actions.test.js && node frontend-download.test.js && node cdp-lifecycle.test.js && node frontend-browser-smoke.test.js",
      "test:robustness:powershell": "powershell -NoProfile -ExecutionPolicy Bypass -File export_scripts.test.ps1",
      "test:robustness:protocol": "node codex-agent-protocol.test.js",
      "test:robustness:python": "python render_tools.test.py && python current_content.test.py && python ..\\assets\\slide1-neon\\test_neon_overlay.py",
      "test:robustness:render": "node com-host.test.js && npm run test:robustness:python && npm run test:robustness:powershell",
      "test:robustness:server": "node backend-robustness.test.js && node control-contract.test.js && node pdf-export-race.test.js && node render-pipeline.test.js && node diagnostics\\beast-restart-preservation-smoke.js"
    }
  },
  "shared": {
    "inventory": [
      {
        "file": "connect-page.test.js",
        "reason": null
      },
      {
        "file": "design-tools/image-generate.test.js",
        "reason": null
      },
      {
        "file": "design-tools/test.js",
        "reason": null
      },
      {
        "file": "first-run-setup.test.js",
        "reason": null
      },
      {
        "file": "provider-connections.test.js",
        "reason": null
      },
      {
        "file": "provider-runtime.test.js",
        "reason": null
      }
    ],
    "aliases": {
      "test": "node run-tests.js"
    }
  },
  "shell": {
    "inventory": [],
    "aliases": {}
  }
}
);
