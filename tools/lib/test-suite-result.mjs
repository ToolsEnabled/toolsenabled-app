// TAP escapes "#" as "\#" and "\" as "\\" inside descriptions.
function unescapeTapName(name) {
  return name.replace(/\\(.)/g, "$1");
}

// These are named behavioral contracts, not a blanket ban on skips. This
// cross-platform DOM test supplies its own bridge and enables the write flag:
// a missing Start control or failed mount is missing coverage, not an OS
// precondition. Add another control only after reviewing its prerequisites.
// Keep names synchronized when intentionally renaming a required test.
export const REQUIRED_APP_CONTROLS = Object.freeze([
  Object.freeze({
    id: "agent-session-stop-during-start",
    testName: 'a Stop that lands while the session is starting is not overwritten by "refused"',
    stages: Object.freeze(["promotion", "release"]),
  }),
]);

// A SKIP IS AN UNEXECUTED TEST, AND AT RELEASE EVERY ONE OF THEM IS NAMED HERE.
//
// THE DEFECT THIS EXISTS TO END, measured 2026-09-07 at an earlier app commit. The
// strict path above refuses failures and requires its named controls, but it
// said nothing at all about skips: `--strict` returned EXIT_PASS on any run
// whose `# fail` was 0, however many tests had been skipped. Twenty-eight
// suite files carry a `{ skip: !HAS_PAYLOAD }`-shaped guard, so a checkout
// with a capability/ directory that EXISTS but is incomplete -- which
// tools/check-test-inputs.mjs admits, because it can only see that the
// directory is non-empty -- silently skips its product tests and reports a
// green release verification. That is the same "absence read as consent"
// failure check-test-inputs.mjs was written against, one layer further in.
//
// So: at release, a skipped test must appear below by name, or it BLOCKS and
// is reported by name. Nothing is tolerated by count, by file, or by pattern
// -- a pattern would re-admit the next unrelated skip that happens to match
// it, which is how a tolerance list stops being read.
//
// `class` says what kind of claim the entry makes, because they are not the
// same promise and must not be reviewed as if they were:
//
//   nightly     the test needs a real interactive desktop, a real window, or
//               real wall-clock timing. It is NOT deleted and NOT weakened --
//               it runs under `TOOLSENABLED_NIGHTLY=1`. The release run counts
//               it as unexecuted coverage, by name.
//   product-gap the test asserts behaviour the product does not have yet. The
//               skip reason names the missing work. This is a debt entry: it
//               is here so the debt is counted at every release instead of
//               being invisible, and it comes out when the work lands.
//   platform    the behaviour does not exist on this operating system. A
//               requiredPlatform entry admits skips only on OTHER platforms;
//               on its native host, missing prerequisites remain a blocker.
//               Registration is not evidence of native execution.
//   artifact    the test reads a build output that a test run does not
//               produce -- `npm run build`, `npm run dist`, a packaged
//               tree. It executes in the pipeline stage that has one.
//   owner-data  the test reads data a clean checkout deliberately does not
//               carry: an owner's private catalogue, an owner's engine
//               checkout, a document kept outside the repository. Absent is
//               the CORRECT state for a released source tree, so this can
//               never be "fixed" by adding the file to the repository.
//   decided     a limitation decided against building, with the
//               argument recorded in the design documents. Not debt: a
//               decision. It comes out if the decision is reversed.
//
// LIKE THE FAILURE BASELINE, THIS ONLY COMES DOWN. A `product-gap` entry whose
// test actually EXECUTED is reported as retired and blocks, so the register
// cannot quietly outlive the reason it was written -- the same rule
// tools/test-ratchet.mjs already applies to a baselined failure that starts
// passing.
//
// The other classes are exempt from that check, and the exemption is the whole
// reason `class` is a field rather than a comment: each of them describes a
// test that is SUPPOSED to execute somewhere else. A nightly test executes
// under TOOLSENABLED_NIGHTLY=1, a platform test executes on the other
// operating system, an artifact test executes after a build, an owner-data
// test executes on a machine that has the owner's data. Retiring an entry
// because the run that was meant to execute it did would delete the register
// every time it worked.
export const RELEASE_SKIP_REGISTER = Object.freeze([
  Object.freeze({
    id: "linux-qa-private-directory-mode",
    testName: "a QA directory that will hold a launch is created private, whatever the operator umask is",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason: "Measures the 0700 POSIX mode required by the Linux account-state fence. Windows ignores mkdir mode and reports synthetic POSIX bits; the separate portable test still checks the requested mode and absolute-path refusal on every host.",
  }),
  // Individually reviewed native Windows cases. requiredPlatform prevents a
  // missing Windows prerequisite from being hidden by its Linux disposition.
  // These literal names do not admit future tests by file, pattern or count.
  Object.freeze({
    id: "windows-accessibility-desktop-blocked-names-1",
    testName: "every excluded window class is refused by name, and an ordinary window is still admitted",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-blocked-names.test.mjs: PowerShell window-class matching has no Linux implementation. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-1",
    testName: "Windows helper preserves UTF-8 across every byte boundary",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-2",
    testName: "Windows helper waits for pipe closure and accepts output arriving after root exit",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-3",
    testName: "Windows helper rejects invalid UTF-8 instead of silently changing an observed label",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-4",
    testName: "Windows helper rejects nonzero and malformed completion without stopping an exited helper",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-5",
    testName: "Windows helper enforces its output limit in bytes and does not revive after overflow",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-6",
    testName: "Windows helper cancellation keeps its first failure and only stops a still-running root",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-accessibility-desktop-streams-7",
    testName: "Windows helper retains its deadline while exited output pipes remain open",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/accessibility-desktop-streams.test.mjs: The real Windows adapter's pipe path is platform-selected even when its stream source is scripted; this is not UI Automation proof. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-confinement-provider-1",
    testName: "the real planner still refuses a services path through a junction",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-confinement-provider.test.mjs: The real planner is exercised through a native Windows junction. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-host-readiness-1",
    testName: "the bootstrap account fence accepts redirected profiles and rejects their siblings",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-host-readiness.test.mjs: The bootstrap fence's redirected drive-profile branch requires native Windows path semantics. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-host-real-start-cancellation-1",
    testName: "real host and engine Stop during version confirms an empty Windows job",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-host-real-start-cancellation.test.mjs: The real host and selected engine must observe cancellation and empty Windows Job Objects; Linux has no Win32 Job Object. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-host-real-start-cancellation-2",
    testName: "real version cleanup refusal survives the engine-to-host handoff and can be retried",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-host-real-start-cancellation.test.mjs: The real host and selected engine must observe cancellation and empty Windows Job Objects; Linux has no Win32 Job Object. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-host-real-start-cancellation-3",
    testName: "real host and engine Stop during initialize confirms an empty Windows job",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-host-real-start-cancellation.test.mjs: The real host and selected engine must observe cancellation and empty Windows Job Objects; Linux has no Win32 Job Object. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-agent-host-real-start-cancellation-4",
    testName: "real initialize cleanup refusal survives the engine-to-host handoff and can be retried",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/agent-host-real-start-cancellation.test.mjs: The real host and selected engine must observe cancellation and empty Windows Job Objects; Linux has no Win32 Job Object. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-bootstrap-fence-link-inside-the-profile-1",
    testName: "a junction inside the owned profile, landing inside that same profile, is admitted",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/bootstrap-fence-link-inside-the-profile.test.mjs: These real junction fixtures exercise Windows reparse-point resolution inside a disposable owned root. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-bootstrap-fence-link-inside-the-profile-2",
    testName: "a junction inside the owned profile that lands OUTSIDE it is still refused",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/bootstrap-fence-link-inside-the-profile.test.mjs: These real junction fixtures exercise Windows reparse-point resolution inside a disposable owned root. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-bootstrap-fence-link-inside-the-profile-3",
    testName: "a junction inside the owned profile that lands in a SIBLING account is still refused",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/bootstrap-fence-link-inside-the-profile.test.mjs: These real junction fixtures exercise Windows reparse-point resolution inside a disposable owned root. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-bootstrap-fence-link-inside-the-profile-4",
    testName: "a link nested behind an admitted link is judged too",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/bootstrap-fence-link-inside-the-profile.test.mjs: These real junction fixtures exercise Windows reparse-point resolution inside a disposable owned root. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-canonical-presence-fixture-1",
    testName: "Windows fixture preflight fails at the missing account-boundary dependency before projections can hide it",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/canonical-presence-fixture.test.mjs: The missing account-boundary dependency is reached only through the native Windows engine branch; missing source still blocks on Windows. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-capability-source-git-1",
    testName: "a source path spelled through its 8.3 short name is accepted, not refused as \"not the root\"",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/capability-source-git.test.mjs: The positive case needs a native 8.3 short-name alias; Windows must provide an alias-capable proof volume, not accept this skip. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-check-download-wire-1",
    testName: "check-download-wire refuses an undeclared extra installer in the candidate inventory",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/check-download-wire.test.mjs: The healthy candidate uses a real Windows PE version-resource reader and trusted OS PE fixture. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-check-download-wire-2",
    testName: "check-download-wire still passes a healthy declared candidate and matching offer",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/check-download-wire.test.mjs: The healthy candidate uses a real Windows PE version-resource reader and trusted OS PE fixture. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-diff-file-fence-1",
    testName: "the same file typed in a different case is still the same file",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/diff-file-fence.test.mjs: The native case-insensitive drive-path fence is Windows-specific. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-diff-file-fence-2",
    testName: "a path on another drive is refused rather than treated as relative",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/diff-file-fence.test.mjs: The native case-insensitive drive-path fence is Windows-specific. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-download-wire-1",
    testName: "PASSES a complete declaration whose bytes verify",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/download-wire.test.mjs: The positive declaration is checked against real PE bytes by the native Windows version-resource reader. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-download-wire-2",
    testName: "does NOT cry wolf when the declared file is served from another directory or CDN",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/download-wire.test.mjs: The positive declaration is checked against real PE bytes by the native Windows version-resource reader. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-electron-node-handoff-1",
    testName: "Windows drive and directory casing do not turn a shipped legacy command into a GUI launch",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/electron-node-handoff.test.mjs: The native Windows drive-casing branch must distinguish Node handoff from GUI launch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-harness-credential-fence-1",
    testName: "a foreign-profile PATH entry cannot reach a packaged drive, while legitimate tools remain",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/harness-credential-fence.test.mjs: Windows PATH parsing must exclude other profiles before starting a packaged drive. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-launch-live-1",
    testName: "control: without the wrapper, a detached grandchild OUTLIVES its killed root (so the tests below measure the job, not libuv)",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/launch-live.test.mjs: Real Windows process generations and Job Object lifetimes are measured against owned child/grandchild fixtures, not LIVE. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-launch-live-2",
    testName: "real fixture cleanup leaves a mismatched creation generation alive and stops only the authenticated generation",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/launch-live.test.mjs: Real Windows process generations and Job Object lifetimes are measured against owned child/grandchild fixtures, not LIVE. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-launch-live-3",
    testName: "job object: killing the ROOT by pid ends the grandchild within 5 s and records the exit",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/launch-live.test.mjs: Real Windows process generations and Job Object lifetimes are measured against owned child/grandchild fixtures, not LIVE. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-launch-live-4",
    testName: "job object: killing the HOLDER first leaves the root running; the root dying still ends the grandchild",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/launch-live.test.mjs: Real Windows process generations and Job Object lifetimes are measured against owned child/grandchild fixtures, not LIVE. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-paths-1",
    testName: "native Windows junction cannot redirect input traversal",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-paths.test.mjs: A native Windows junction must not redirect the Page 2 input boundary. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-1",
    testName: "native picker accepts an owned PID with an explicit contained user-data path",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-2",
    testName: "native picker refuses another profile before reading the request or writing a result",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-3",
    testName: "native picker refuses a PID without the owned user-data command-line argument",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-4",
    testName: "native picker refuses an ended PID",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-5",
    testName: "native picker rejects sibling-prefix paths before testing their existence",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-6",
    testName: "native picker refuses an out-of-scope result path without writing it",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-7",
    testName: "native picker refuses junctions even when their target is also owned",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-8",
    testName: "native picker refuses hard-linked files",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-9",
    testName: "native picker accepts cancel and inspection as validation-only operations",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-page2-native-picker-10",
    testName: "native picker refuses unsupported operations",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/page2-native-picker.test.mjs: The Windows PowerShell picker boundary is driven in ValidateOnly mode with real owned process/file identities; this is not native dialog acceptance. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-process-tree-1",
    testName: "taskkill /T does NOT reach an orphaned grandchild",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/process-tree.test.mjs: Windows taskkill/CIM process-tree behavior is tested against owned detached process fixtures. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-process-tree-2",
    testName: "descendantPids finds a live descendant, and reapPids kills it",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/process-tree.test.mjs: Windows taskkill/CIM process-tree behavior is tested against owned detached process fixtures. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-provider-cli-presence-1",
    testName: "the ambient walk happens once per search path, and again after an install",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/provider-cli-presence.test.mjs: Only the Windows provider resolver uses the cached machine-search-path branch measured by this case. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-provider-cli-presence-2",
    testName: "the launch path is served the resolution the presence probe already walked",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/provider-cli-presence.test.mjs: Only the Windows provider resolver uses the cached machine-search-path branch measured by this case. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-release-gates-1",
    testName: "Windows path casing cannot bypass the command-line gate",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/release-gates.test.mjs: Native Windows command-line path casing must not bypass the gate. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-release-packager-1",
    testName: "verify-candidate.ps1 independently accepts exact bytes and refuses byte-count or hash mismatches",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/release-packager.test.mjs: The candidate verifier is a Windows PowerShell driver over real candidate bytes. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-release-provenance-1",
    testName: "Windows path casing cannot turn a refused cutter invocation into success",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/release-provenance.test.mjs: Native Windows path casing must not bypass the cutter invocation refusal. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-1",
    testName: "an explicit engine in a sibling Windows profile is refused before loading",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-2",
    testName: "a namespaced engine in a sibling Windows profile is refused before loading",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-3",
    testName: "unsupported Windows device and UNC engine paths refuse before access",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-4",
    testName: "a namespaced sibling-profile cwd is refused before the host performs a filesystem stat",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-5",
    testName: "a per-session UNC cwd cannot bypass the bootstrap fence that guarded the default cwd",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-6",
    testName: "owned namespaced drive paths are normalized before engine load and cwd use",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-7",
    testName: "the real staged planner permits Windows PUBLIC only because the shell removes it, and still refuses a sibling profile",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-session-launch-environment-8",
    testName: "a resumed thread cannot return a UNC cwd around the installation-account fence",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/session-launch-environment.test.mjs: The native Windows engine/cwd boundary checks drive namespaces, UNC paths and the PUBLIC projection; foreign paths must be refused before access. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-shell-port-scan-contract-1",
    testName: "contract #7b: an OS-excluded port is advanced past, and the next free candidate really binds",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/shell-port-scan-contract.test.mjs: The native test discovers Windows netsh exclusions and requires a real OS EACCES; Linux has no WinNAT exclusion table. A Windows host without a usable exclusion remains unmeasured and blocked. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-shell-port-scan-contract-2",
    testName: "contract #7c: with every candidate OS-excluded, the real code survives and nobody is told the ports are busy",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/shell-port-scan-contract.test.mjs: The native test discovers Windows netsh exclusions and requires a real OS EACCES; Linux has no WinNAT exclusion table. A Windows host without a usable exclusion remains unmeasured and blocked. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-sterile-launch-1",
    testName: "F1c - state-root identity survives a different machine root and conflicting product identities fail before reads",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/sterile-launch.test.mjs: The native Windows state-root branch must preserve product identity across drive-root changes. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-tree-node-command-1",
    testName: "default Windows spool creation installs and verifies the exact private ACL",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/tree-node-command.test.mjs: The Windows spool uses real private ACL/reparse checks and a bounded PowerShell interpreter dispatch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-tree-node-command-2",
    testName: "a writable identity outside the account, SYSTEM and Administrators is still refused on the request file",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/tree-node-command.test.mjs: The Windows spool uses real private ACL/reparse checks and a bounded PowerShell interpreter dispatch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-tree-node-command-3",
    testName: "a request id with no file on disk is unavailable, never relabelled an ACL failure",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/tree-node-command.test.mjs: The Windows spool uses real private ACL/reparse checks and a bounded PowerShell interpreter dispatch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-tree-node-command-4",
    testName: "a request file that is a link keeps its reparse refusal ahead of the folded ACL read",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/tree-node-command.test.mjs: The Windows spool uses real private ACL/reparse checks and a bounded PowerShell interpreter dispatch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-tree-node-command-5",
    testName: "one off-process dispatch stays inside its interpreter budget",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/tree-node-command.test.mjs: The Windows spool uses real private ACL/reparse checks and a bounded PowerShell interpreter dispatch. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-vault-host-payload-1",
    testName: "the actual staged client reads synthetic data through one persistent OS process",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/vault-host-payload.test.mjs: The actual staged vault client uses a persistent native Windows worker; synthetic rows are fixture data, not owner-vault evidence. Registration admits this skip only off Windows, and is not evidence of execution.",
  }),
  Object.freeze({
    id: "windows-release-owner-account-fence",
    testName: "Windows release boundaries reject another profile before any path inspection",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/release-owner-account.test.mjs drives the real native Windows release-reader path boundary with a no-I/O refusal sentinel. A skip is admitted only off Windows.",
  }),
  Object.freeze({
    id: "windows-owned-job-native-token-profile",
    testName: "native Windows owned-job paths bind the OS token profile and retain ordinary file handles",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/owned-job-native-profile.test.mjs compiles the actual Win32 token-profile and retained-file-handle reader. It must execute on Windows; Linux has no Win32 token or file lease.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-decoder-relocation",
    testName: "the native decoder remains the exact registered 7-Zip 24.08 pair after relocation",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-decoder-executable-bytes",
    testName: "changed executable decoder bytes are rejected by actual file measurement",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-decoder-library-bytes",
    testName: "changed library decoder bytes are rejected by actual file measurement",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-decoder-incomplete-pair",
    testName: "an incomplete selected decoder pair cannot fall back to a different installation",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-decoder-extra-modules",
    testName: "unregistered extra decoder modules cannot enter through the portable cache",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-artifact-toolchain-subject-replay",
    testName: "artifact subject replay requires the exact registered runtime and policy binding",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/artifact-toolchain.test.mjs: measures the registered portable 7-Zip 24.08 decoder pair and the artifact-subject replay binding that Windows artifact qualification uses (skip: 'Windows artifact qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-owned-job-native-installed-reader",
    testName: "native installed reader and VM authority use the OS token before path access",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/owned-job-native-profile.test.mjs compiles the actual Win32 token-profile reader for the native installed reader and VM authority. It must execute on Windows; Linux has no Win32 token.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-portable-node",
    testName: "native toolchain binds the selected portable Node and reviewed system binaries",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-child-path",
    testName: "registered child PATH resolves the selected Node and refuses environment redirection",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-changed-executable",
    testName: "an executable changed after selection is rejected by real byte measurement",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-path-mutation",
    testName: "later process-path mutation cannot redirect the captured runtime selection",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-policy-bytes",
    testName: "changed loaded policy bytes cannot redefine runtime approval",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "windows-registered-toolchain-relocated-node",
    testName: "a relocated genuine Node keeps its byte approval without the legacy machine directory",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/registered-toolchain.test.mjs: binds Windows qualification to the reviewed portable Node and system binaries under the owner's AppData tool root (skip: 'Windows qualification toolchain'). Linux has no such installation. Registration admits this skip only off Windows.",
  }),
  Object.freeze({
    id: "installed-archive-provenance",
    testName: "the installed application is held to the provenance rule",
    class: "artifact",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/asar-provenance.test.mjs reads an installed resources/app.asar, which a source run does not create. Its absence is unexecuted installed-artifact coverage, not proof; the exact new installer still requires post-cut provenance and native qualification.",
  }),
  Object.freeze({
    id: "screen-control-interactive-input",
    testName: "actual desktop input and capture",
    class: "nightly",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/screen-control-native.test.mjs delivers real native input. Linux runs automatically on a new private X11 server. Windows requires an allocated interactive proof desktop and MC_SCREEN_CONTROL_NATIVE_TEST=1; a source skip is not desktop acceptance.",
  }),
  Object.freeze({
    id: "accessibility-desktop-native-visibility",
    testName: "the owned native fixture becomes visible before readiness even from an explicitly hidden launch",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "compiles a WinForms fixture with csc.exe and asserts real native window visibility. Needs an " +
      "interactive desktop and an unloaded machine; run it with TOOLSENABLED_NIGHTLY=1.",
  }),
  Object.freeze({
    id: "accessibility-desktop-uia-control",
    testName: "real Windows UI Automation: opaque targets, confirmed click/text, stale and stopped refusal",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "drives real UI Automation against a real window. Measured 2026-09-07: the same " +
      "commit timed out after 60000ms in one whole-suite run and passed in the next, with three other " +
      "test runs on the machine. Run it with TOOLSENABLED_NIGHTLY=1.",
  }),
  Object.freeze({
    id: "accessibility-desktop-window-management",
    testName: "real Windows window management is owner-confirmed and normal close never force-terminates",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "minimises, maximises, restores and closes a real window and waits on the window manager. " +
      "Measured 2026-09-07: failed with the product's own 'Windows could not safely " +
      "complete this request' in one whole-suite run and passed in the next. Run it with " +
      "TOOLSENABLED_NIGHTLY=1.",
  }),
  Object.freeze({
    id: "canonical-audit-thread-main-thread-stall",
    testName: "a record that blocks its thread for half a second does not stop the main thread",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "measures REAL scheduler behaviour: a 10ms setInterval on the main thread across a 500ms hold on " +
      "the ledger thread. It cannot take an injected clock, because whether the main thread stalls is " +
      "the entire subject. It already refuses to rule on a reading it could not take -- MEASURED " +
      "2026-09-07 under three concurrent test runs, it reported \"the main thread's timer " +
      "did not fire often enough to prove anything (12 ticks)\", needing 20 -- but at release that " +
      "refusal reads as a product defect. Run it on a quiet machine with TOOLSENABLED_NIGHTLY=1.",
  }),
  Object.freeze({
    id: "chat-surface-agent-page-panelization",
    testName:
      "SKIP until agent direct-line panelization lands: mounts data-chat-panel and spreads one-mode config whole",
    class: "product-gap",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "src/views/agent.js still builds its direct-line chat from an inline, two-mode object with no " +
      "named config. MEASURED 2026-09-07, not assumed: the file's '// chat panel' anchor " +
      "is present and the mount contains no `const ...chatConfig =`, so the guard is a real gap and " +
      "not an obsolete skip. Owned by the chat surface lane, not by test hardening.",
  }),
  Object.freeze({
    id: "chat-surface-agent-session-panelization",
    testName:
      "SKIP until agent-session whole-config panelization lands: the transcript panel spreads one-mode config whole",
    class: "product-gap",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "src/agent-session.js mountSessionControls still hand-picks its buildChat fields. MEASURED " +
      "2026-09-07, not assumed: the mountSessionControls anchor is present and its " +
      "buildChat call contains no `...config` spread, so the guard is a real gap and not an obsolete " +
      "skip. Owned by the chat surface lane, not by test hardening.",
  }),
  Object.freeze({
    id: "hand-controls-native-renderer-check",
    testName: "native camera permissions, pinch clicks, background pause, and complete off cleanup",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "launches a real Electron process and waits for a real renderer to answer. MEASURED 2026-09-07: " +
      "in a whole-suite run under load the child hit its own 25000ms limit at 27031ms and " +
      "reported only \"Command failed\"; run alone on the same commit it passed. Run it on a quiet " +
      "machine with TOOLSENABLED_NIGHTLY=1.",
  }),
  Object.freeze({
    id: "composer-scope-chip",
    testName: "composer names explicit and implicit context actually in scope",
    class: "product-gap",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "buildChat does not yet render a scope chip from chips.scope, and implicit session cwd and tree " +
      "context remain unbuilt. Owned by the chat surface lane, not by test hardening.",
  }),
  Object.freeze({
    // The only entry here whose testName is COMPUTED: the suite builds it as
    // `SKIP until built: ... instrument — ${missingReason}`, so the moment the
    // product moves, the name moves and this entry stops matching -- and the
    // gate blocks with the new name in the unnamed list. That is the correct
    // outcome and not a bug to design around: a changed reason is exactly when
    // a debt entry should be looked at again by a person.
    id: "chat-one-popover-mention-picker",
    testName:
      "SKIP until built: slash and mention open the same popover instrument — mention still invokes " +
      "a separate picker instead of the actions popover",
    class: "product-gap",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "mention still invokes a separate picker instead of the actions popover, so the one-instrument " +
      "claim is unbuilt. Owned by the chat surface lane, not by test hardening.",
  }),
  Object.freeze({
    id: "speech-gpu-webrtc-native-proof",
    testName: "real CUDA speech, WebRTC, local consent broker and native controls",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "drives real CUDA speech, a real WebRTC path and real native controls with a 600000ms timeout. " +
      "It carries its own opt-in guard and runs under TOOLSENABLED_RUN_GPU_SPEECH_PROOF=1 on a " +
      "machine with the hardware; nothing in a release run supplies that.",
  }),
  // TEN PLATFORM ENTRIES. Each of these is a Linux or POSIX behaviour whose
  // Windows counterpart executes in the same run, so the coverage is not
  // missing -- it is on the other host. They are listed one by one rather than
  // as "the Linux ones" because a pattern would silently adopt the next Linux
  // test somebody writes, including one that should have been failing.
  Object.freeze({
    id: "linux-account-launch-named-account",
    testName: "paired Linux prepares only the selected named account before binding authority",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-explicit-default",
    testName: "paired Linux explicitly prepares default after explicit default",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-default-after-not-configured",
    testName: "paired Linux explicitly prepares default after ACCOUNTS_NOT_CONFIGURED",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-default-after-none-for-provider",
    testName: "paired Linux explicitly prepares default after ACCOUNTS_NONE_FOR_PROVIDER",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-selection-refusals",
    testName:
      "Linux refuses uncertain, malformed and foreign-provider selection before authority or provider launch",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-preflight-is-not-a-plan",
    testName: "preflight is never accepted as a complete provider launch plan",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-account-launch-legacy-preflight-version",
    testName: "unrecognized preflight version preserves legacy synchronous preparation",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/linux-account-launch.test.mjs.",
  }),
  Object.freeze({
    id: "linux-codex-executable-from-resolver",
    testName: "Linux Codex launches the exact executable from the current provider resolver",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason: "guarded by `process.platform !== 'linux'` in tools/test/no-tier-provider-routing.test.mjs.",
  }),
  Object.freeze({
    id: "posix-login-argument-preservation",
    testName: "real POSIX env/bash preserve hostile-looking arguments and remove inherited selectors",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/provider-login-linux.test.mjs; it shells " +
      "out to real env/bash, which Windows does not have.",
  }),
  Object.freeze({
    id: "linux-login-terminal-completion",
    testName: "Linux sign-in closes on success with an open terminal input and keeps a failure readable until Enter",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason: "tools/test/provider-login-linux.test.mjs executes the Linux env/bash launcher with a real child and open stdin. Linux is required; a missing Linux prerequisite still blocks.",
  }),
  Object.freeze({
    id: "posix-case-distinct-userdata-adoption",
    testName: "distinct POSIX directories whose names differ only by case are adopted",
    class: "platform",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `path.sep === '\\\\'` in tools/test/userdata-adoption.test.mjs: two directories " +
      "differing only by case cannot both exist on this filesystem, so the case has no subject here.",
  }),
  // THREE ARTIFACT ENTRIES. `npm test` does not build and does not package, so
  // these are unexecuted in every test run by construction. They execute in the
  // `dist` pipeline, which builds before it checks.
  Object.freeze({
    id: "release-build-provenance",
    testName: "the release build is held to the provenance rule",
    class: "artifact",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "reads release/win-unpacked, which only `npm run dist` produces. Executed by the packaging " +
      "pipeline, which runs this check against the tree it just built.",
  }),
  Object.freeze({
    id: "built-payload-carries-no-purchase-list",
    testName: "the built payload carries no purchase list and none of its words",
    class: "artifact",
    stages: Object.freeze(["promotion", "release"]),
    reason: "reads dist/, which only `npm run build` produces.",
  }),
  Object.freeze({
    id: "packaged-archive-carries-no-purchase-list",
    testName: "the packaged archive a stranger downloads carries neither",
    class: "artifact",
    stages: Object.freeze(["promotion", "release"]),
    reason: "reads the packaged archive, which only `npm run dist` produces.",
  }),
  // SIX OWNER-DATA ENTRIES. ABSENT IS THE CORRECT STATE. These read a private
  // catalogue, an owner's own engine checkout, or a document kept deliberately
  // outside this repository. A released source tree that HAD these files would
  // be a defect -- so none of these can ever be closed by adding the file, and
  // reading them as missing coverage misreads what they check.
  Object.freeze({
    id: "operator-catalogue-boundary",
    testName: "the operator catalogue passes the same boundary the screen puts it through",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason: "needs private/purchase-catalog.owner.json, which a clean checkout deliberately does not carry.",
  }),
  Object.freeze({
    id: "operator-catalogue-spend-cap",
    testName: "the operator catalogue carries a readable spend cap, so the screen can cite one",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason: "needs private/purchase-catalog.owner.json, which a clean checkout deliberately does not carry.",
  }),
  Object.freeze({
    id: "operator-catalogue-category-ids",
    testName: "every operator category id is one the screen knows how to render",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason: "needs private/purchase-catalog.owner.json, which a clean checkout deliberately does not carry.",
  }),
  Object.freeze({
    id: "provider-position-document-warning-text",
    testName: "the adopted warning text has not changed under the paraphrase that ships",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "compares shipped copy against a position document kept outside this repository. Point " +
      "TOOLSENABLED_PROVIDER_POSITION_DOC at it to execute this check.",
  }),
  Object.freeze({
    id: "provider-position-document-four-specifics",
    testName: "the source still carries four numbered specifics, which is what the shipped list mirrors",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "reads the same out-of-repository position document. Point TOOLSENABLED_PROVIDER_POSITION_DOC " +
      "at it to execute this check.",
  }),
  Object.freeze({
    id: "owner-real-queue-projection",
    testName: "the owner’s real queue projects without inventing anything",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "reads the engine checkout named in private/capability-source.owner.json. It skips at RUNTIME " +
      "via t.skip() rather than by a declared guard, so it is a skip a reader can easily take for a " +
      "pass; naming it here is what stops that.",
  }),
  Object.freeze({
    id: "fleet-trees-cross-tree-isolation",
    testName: "two trees would keep out of each other's files",
    class: "decided",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "docs/design/FLEET-TREES.md section 8 records that this was decided against for this release, " +
      "with the argument for building it attached so the owner can weigh it. The suite's own skip " +
      "reason says DO NOT implement this to make the skip go away -- so this entry is a decision on " +
      "the record, not debt, and it comes out only if the owner reverses the decision.",
  }),
  Object.freeze({
    id: "linux-packet-archive-binding",
    testName: "packet staging verifies archive bytes and signature presence before writing the note",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason: "Exercises the native Linux ar inspection used by the .deb cutter; executes on Linux and remains unexecuted on other hosts.",
  }),
  // Named by the .46 release censuses, 2026-09-23 (Linux unit te46-linux-full-dist-21 and the
  // Windows offline qualification guest on an earlier commit). Each entry says what guards the test and
  // where the behaviour executes instead; a requiredPlatform entry still blocks on its own host.
  Object.freeze({
    id: "check-artifact-private-a-machine-sid-that-could-not",
    testName: "a machine SID that could not be read REFUSES instead of reporting clean",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `windowsOnly` in tools/test/check-artifact-private.test.mjs: the Windows machine " +
      "SID it measures does not exist off Windows; on the Windows build host it executes.",
  }),
  Object.freeze({
    id: "check-artifact-private-the-refusal-says-what-it-tried",
    testName: "the refusal says what it tried, so the fix is on the build host and not in this file",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `windowsOnly` in tools/test/check-artifact-private.test.mjs: the Windows machine " +
      "SID it measures does not exist off Windows; on the Windows build host it executes.",
  }),
  Object.freeze({
    id: "check-artifact-private-a-sid-that-is-present-outranks",
    testName: "a SID that IS present outranks \"could not look\" in the same run",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `windowsOnly` in tools/test/check-artifact-private.test.mjs: the Windows machine " +
      "SID it measures does not exist off Windows; on the Windows build host it executes.",
  }),
  Object.freeze({
    id: "check-artifact-private-on-a-sound-host-the-exact",
    testName: "on a sound host the exact-value check runs, and the log says so before it says clean",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `windowsOnly` in tools/test/check-artifact-private.test.mjs: the Windows machine " +
      "SID it measures does not exist off Windows; on the Windows build host it executes.",
  }),
  Object.freeze({
    id: "cut-powershell-module-path-get-acl-and-convertto-securestring-succeed",
    testName: "Get-Acl and ConvertTo-SecureString succeed under the built environment and fail under a pwsh 7 parent",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== \"win32\"` in " +
      "tools/test/cut-powershell-module-path.test.mjs: Windows PowerShell 5.1 module resolution " +
      "under the built cut environment is measured on Windows.",
  }),
  Object.freeze({
    id: "cut-windows-short-temp-root-createshortwindowstemproot-refuses-a-base-it-cannot",
    testName: "createShortWindowsTempRoot refuses a base it cannot fit, and removes what it made",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'win32'` in " +
      "tools/test/cut-windows-short-temp-root.test.mjs: the short Windows temp root the dist chain " +
      "needs is measured on Windows.",
  }),
  Object.freeze({
    id: "cut-windows-short-temp-root-createcutscratch-hands-the-dist-chain-a",
    testName: "createCutScratch hands the dist chain a Windows temp root that satisfies the rule",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'win32'` in " +
      "tools/test/cut-windows-short-temp-root.test.mjs: the short Windows temp root the dist chain " +
      "needs is measured on Windows.",
  }),
  Object.freeze({
    id: "cut-windows-short-temp-root-createcutscratch-is-idempotent-under-its-own",
    testName: "createCutScratch is idempotent under its own dist-chain environment",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'win32'` in " +
      "tools/test/cut-windows-short-temp-root.test.mjs: the short Windows temp root the dist chain " +
      "needs is measured on Windows.",
  }),
  Object.freeze({
    id: "disposable-guest-contract-admission-refuses-a-caller-supplied-mode",
    testName: "admission refuses a caller-supplied mode constant by its own name",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `OFF_WINDOWS_SKIP` in tools/test/disposable-guest-contract.test.mjs: off Windows " +
      "x64 the admission refuses at the qualification-host check before any clause these cases " +
      "assert, and those off-Windows codes are deliberately unmeasured rather than assumed.",
  }),
  Object.freeze({
    id: "disposable-guest-contract-admission-refuses-a-guest-whose-declared",
    testName: "admission refuses a guest whose declared surface is incomplete, naming the missing methods",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `OFF_WINDOWS_SKIP` in tools/test/disposable-guest-contract.test.mjs: off Windows " +
      "x64 the admission refuses at the qualification-host check before any clause these cases " +
      "assert, and those off-Windows codes are deliberately unmeasured rather than assumed.",
  }),
  Object.freeze({
    id: "disposable-guest-contract-admission-refuses-a-vmid-hyper-v",
    testName: "admission refuses a vmId Hyper-V cannot resolve, and an RPC channel with no machine behind it",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `OFF_WINDOWS_SKIP` in tools/test/disposable-guest-contract.test.mjs: off Windows " +
      "x64 the admission refuses at the qualification-host check before any clause these cases " +
      "assert, and those off-Windows codes are deliberately unmeasured rather than assumed.",
  }),
  Object.freeze({
    id: "disposable-guest-contract-admission-never-reaches-attest-when-the",
    testName: "admission never reaches attest() when the machine does not resolve",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `OFF_WINDOWS_SKIP` in tools/test/disposable-guest-contract.test.mjs: off Windows " +
      "x64 the admission refuses at the qualification-host check before any clause these cases " +
      "assert, and those off-Windows codes are deliberately unmeasured rather than assumed.",
  }),
  Object.freeze({
    id: "release-packager-windows-packet-signing-measurement-uses-its",
    testName: "Windows packet signing measurement uses its native PowerShell modules",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'win32'` in tools/test/release-packager.test.mjs: the " +
      "packet signing measurement runs the native Windows PowerShell modules, present only on " +
      "Windows.",
  }),
  Object.freeze({
    id: "session-diff-access-windows-common-account-fence-rejects-a",
    testName: "Windows common account fence rejects a foreign profile before any filesystem call",
    class: "platform",
    requiredPlatform: "win32",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform!=='win32'` in tools/test/session-diff-access.test.mjs: the " +
      "Windows common account fence compares Windows profile paths; on Windows it executes.",
  }),
  Object.freeze({
    id: "check-electron-runtime-files-linux-floor-elf-identity-and-renamed",
    testName: "Linux floor, ELF identity and renamed-distribution parity are independent of Windows DLLs",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform === 'win32'` in " +
      "tools/test/check-electron-runtime-files.test.mjs: the Linux executable-mode and ELF identity " +
      "proof needs a POSIX filesystem.",
  }),
  Object.freeze({
    id: "cut-dist-chain-environment-the-packager-s-short-temp-root",
    testName: "the packager's short temp root fits the budget, builds green, and the gates block records its byte length",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform === \"win32\"` in " +
      "tools/test/cut-dist-chain-environment.test.mjs: it builds under a short POSIX /tmp and " +
      "Unix-socket qualification root; the Windows refusal is verified by its own cases.",
  }),
  Object.freeze({
    id: "development-socket-temp-deep-linux-dev-workspaces-bind-real",
    testName: "deep Linux DEV workspaces bind real short private sockets; cleanup requires custody and leaves the peer alive",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/development-socket-temp.test.mjs: binds real short private Unix " +
      "sockets under the Linux path limit and takes temporary-directory custody, which has no " +
      "Windows subject.",
  }),
  Object.freeze({
    id: "home-screen-qa-the-actual-linux-home-owner-closes",
    testName: "the actual Linux Home owner closes a disposable detached grandchild before returning",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "runtime `t.skip` in tools/test/home-screen-qa.test.mjs when `process.platform !== 'linux'`: " +
      "the proof uses the Linux subreaper and pidfd; the Windows Job object path is qualified " +
      "separately.",
  }),
  Object.freeze({
    id: "image-retention-cleanup-approved-fixture-only-capacity-reuse-beyond",
    testName: "approved fixture only: capacity reuse beyond 12 assets and 256 revisions preserves unknown bytes",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "executes only with IMAGE_CLEANUP_TEST_ROOT naming a precreated, explicitly approved cleanup " +
      "fixture (tools/test/image-retention-cleanup.test.mjs); a clean checkout carries no approved " +
      "deletion target on purpose, so this skips on every release host.",
  }),
  Object.freeze({
    id: "image-retention-cleanup-approved-fixture-only-interrupted-compaction-preserves",
    testName: "approved fixture only: interrupted compaction preserves prior entries and resumes exact operation",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "executes only with IMAGE_CLEANUP_TEST_ROOT naming a precreated, explicitly approved cleanup " +
      "fixture (tools/test/image-retention-cleanup.test.mjs); a clean checkout carries no approved " +
      "deletion target on purpose, so this skips on every release host.",
  }),
  Object.freeze({
    id: "installed-lifecycle-adapters-executable-rows-never-pass-off-the",
    testName: "executable rows never pass off the Windows x64 qualification host",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "runtime `t.skip` in tools/test/installed-lifecycle-adapters.test.mjs on win32 x64: the " +
      "off-platform refusal of executable rows is exercised on non-Windows runners, where it " +
      "executes.",
  }),
  Object.freeze({
    id: "linux-account-state-fresh-linux-account-directories-are-private",
    testName: "fresh Linux account directories are private under a permissive umask",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-previous-permissive-account-directories-are-narrowed",
    testName: "previous permissive account directories are narrowed without reading records or visiting siblings",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-an-unsafe-ancestor-outside-the-profile",
    testName: "an unsafe ancestor outside the profile is refused without changing it",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-a-symlink-at-any-private-directory",
    testName: "a symlink at any private directory is refused without touching its target",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-missing-owner-access-is-not-silently",
    testName: "missing owner access is not silently granted",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-broad-or-ambiguous-storage-roots-are",
    testName: "broad or ambiguous storage roots are refused before mutation",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-account-state-a-replaced-directory-is-refused-after",
    testName: "a replaced directory is refused after open and its replacement is not chmodded",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` (linux = Linux x64) in tools/test/linux-account-state.test.mjs: " +
      "real umask, POSIX modes and ownership of the Linux account directories.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-whole-debian-accounting-binds-stage-source",
    testName: "whole Debian accounting binds stage, source scripts, desktop, icon, dependencies and md5sums",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-outside-app-changes-never-qualify-merely",
    testName: "outside-app changes never qualify merely because the complete app subtree still matches",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-linux-debian-dispatch-accepts-a-real",
    testName: "Linux Debian dispatch accepts a real XZ Debian envelope instead of selecting Windows NSIS tools",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-xz-identities-options-environment-and-large",
    testName: "XZ identities, options, environment and large-output privilege cannot be substituted",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-native-xz-enforces-decoded-byte-budget",
    testName: "native XZ enforces decoded-byte budget and refuses trailing compressed junk with cleanup",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-deb-a-compressed-input-generation-changed-during",
    testName: "a compressed input generation changed during real decoding cannot earn a successful receipt",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-deb.test.mjs: real Debian archive accounting with the native XZ " +
      "decoder.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-linux-normal-packaging-removes-writable-by",
    testName: "Linux normal packaging removes writable-by-other bits, preserves executable/content, and is idempotent",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-root-project-scope-and-absent-artifact",
    testName: "root/project scope and absent artifact markers refuse",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-symlink-into-owner-source-data-refuses",
    testName: "symlink into owner/source data refuses before any chmod",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-hardlink-into-a-shared-dependency-refuses",
    testName: "hardlink into a shared dependency refuses without touching its mode",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-unexpected-setuid-is-refused-never-normalized",
    testName: "unexpected setuid is refused, never normalized into approved privilege",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-permissions-actual-afterpack-invokes-normalization-before-attempting",
    testName: "actual afterPack invokes normalization before attempting executable fuse changes",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-artifact-permissions.test.mjs: Linux packaging " +
      "normalises POSIX mode bits, setuid and link kinds that Windows does not carry.",
  }),
  Object.freeze({
    id: "linux-artifact-source-real-native-git-binds-exact-committed",
    testName: "real native Git binds exact committed bytes and records the retained ELF dependency closure",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-real-wrong-commit-dirty-worktree-hidden",
    testName: "real wrong commit, dirty worktree, hidden index input and committed links refuse",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-metadata-links-partial-clones-and-includes",
    testName: "metadata links, partial clones and includes refuse before creating native execution evidence",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-native-git-independently-refuses-omitted-filter",
    testName: "native Git independently refuses omitted filter neutralization and never launches the configured helper",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-a-repository-metadata-mutation-during-an",
    testName: "a repository metadata mutation during an actual query invalidates its receipt with confirmed cleanup",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-a-real-file-write-after-the",
    testName: "a real file write after the final Git query cannot pass the shared byte snapshot",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-git-tool-dependency-identities-environment-and",
    testName: "Git tool/dependency identities, environment and command roles reject substitutions",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-artifact-source-a-failed-native-git-query-stops",
    testName: "a failed native Git query stops later jobs and preserves its real cleanup evidence",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-artifact-source.test.mjs: real native Git execution with the retained ELF " +
      "dependency closure.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-maintainer-bash-syntax-and-fixed-exact",
    testName: "maintainer bash syntax and fixed exact policy are valid",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-actual-configure-repeat-configure-upgrade-postrm",
    testName: "actual configure, repeat configure, upgrade postrm and remove preserve safe ownership lifecycle",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-administrator-changes-and-foreign-existing-policy",
    testName: "administrator changes and foreign existing policy are preserved on configure/remove",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-missing-parser-failing-restricted-kernel-is",
    testName: "missing/parser-failing restricted kernel is a hard failure with no SUID fallback",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-unrestricted-kernel-reports-not-needed-offline",
    testName: "unrestricted kernel reports not needed; offline profile activation is honestly deferred",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-symlink-targets-hardlinks-writable-resources-and",
    testName: "symlink targets, hardlinks, writable resources and unexpected policy bytes refuse",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-unload-failure-preserves-policy-and-receipt",
    testName: "unload failure preserves policy and receipt; no profile/userData deletion beyond own paths",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-kernel-activation-failure-is-reported-and",
    testName: "kernel activation failure is reported and leaves managed retryable receipt",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-non-apparmor-system-with-absent-profile",
    testName: "non-AppArmor system with absent profile directory is honestly not-needed",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-deb-maintainer-uninstall-observes-absent-loaded-name-after",
    testName: "uninstall observes absent loaded name after activation failure; unknown state remains failure",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/linux-deb-maintainer.test.mjs (`process.platform !== 'linux'`): the " +
      "Debian maintainer scripts and AppArmor policy lifecycle run under Linux bash and the Linux " +
      "kernel.",
  }),
  Object.freeze({
    id: "linux-signing-signed-repository-accepted-by-gpgv-and-apt",
    testName: "a configured key produces a signed repository that gpgv and apt both accept, and apt refuses under another key",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/code-signing-linux.test.mjs (`process.platform !== 'linux'`): signing an " +
      "apt repository needs gpg, apt-ftparchive, dpkg-deb and apt-get, which exist on the Linux release host.",
  }),
  Object.freeze({
    id: "linux-signing-owner-key-script-plan",
    testName: "the owner key script plans an offline primary and a signing subkey, and creates nothing in plan mode",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded in tools/test/code-signing-linux.test.mjs (`process.platform !== 'linux'`): the owner's " +
      "key-generation script is a bash script for the Linux signing host.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-fpm-packages-the-fixed-apparmor-policy",
    testName: "FPM packages the fixed AppArmor policy as 0644 without chmodding its generated input",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-linked-or-unexpected-generated-policy-is",
    testName: "linked or unexpected generated policy is refused before any FPM descriptor is changed",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-fpm-retained-icon-descriptors-use-private0644",
    testName: "FPM retained icon descriptors use private0644 copies; dependency bytes and modes remain untouched",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-noncanonical-output-and-parent-replacement-while",
    testName: "noncanonical output and parent replacement while icons resolve refuse",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-missing-helper-or-linked-source-refuses",
    testName: "missing helper or linked source refuses without changing descriptors",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-desktop-icons-actual-afterpack-stages-icons-before-fuse",
    testName: "actual afterPack stages icons before fuse failure, never changes the shared source",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `skip: !linux` in tools/test/linux-desktop-icons.test.mjs: FPM descriptors, " +
      "AppArmor policy staging and icon modes for the Linux package.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-actual-node-and-python-owner-extensions",
    testName: "actual Node and Python owner extensions have a closed measured system ELF graph",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-fixed-identities-loader-profiles-and-unresolved",
    testName: "fixed identities, loader profiles and unresolved dependency names are refused",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-real-native-addons-disclose-extra-elf",
    testName: "real native addons disclose extra ELF dependencies without registering arbitrary addons",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-malformed-elf-headers-search-paths-symlinks",
    testName: "malformed ELF headers, search paths, symlinks and parsing-generation substitutions refuse",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-direct-retained-execution-preserves-node-child",
    testName: "direct retained execution preserves Node child/fork and real native addon loading",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-elf-inputs-same-byte-executable-rename-during-a",
    testName: "same-byte executable rename during a real owned execution invalidates its retained generation",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-elf-inputs.test.mjs: measures the closed system ELF graph and loader of the " +
      "Linux owner extensions.",
  }),
  Object.freeze({
    id: "linux-installed-manifest-real-binary-deb-archives-produce-exact",
    testName: "real binary deb archives produce exact ref-bound manifest and externally pinned binding",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/linux-installed-manifest.test.mjs: " +
      "produces and verifies the ref-bound manifest of a real binary .deb.",
  }),
  Object.freeze({
    id: "linux-installed-manifest-producer-refuses-wrong-digest-source-ref",
    testName: "producer refuses wrong digest, source ref/dirty state and unreviewed control or data paths",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/linux-installed-manifest.test.mjs: " +
      "produces and verifies the ref-bound manifest of a real binary .deb.",
  }),
  Object.freeze({
    id: "linux-installed-manifest-producer-refuses-symlink-and-writable-archive",
    testName: "producer refuses symlink and writable archive entries before any extraction",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/linux-installed-manifest.test.mjs: " +
      "produces and verifies the ref-bound manifest of a real binary .deb.",
  }),
  Object.freeze({
    id: "linux-installed-manifest-fpm-changelog-is-a-bounded-exact",
    testName: "FPM changelog is a bounded exact documentation path, not arbitrary documentation admission",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/linux-installed-manifest.test.mjs: " +
      "produces and verifies the ref-bound manifest of a real binary .deb.",
  }),
  Object.freeze({
    id: "linux-installed-manifest-strict-schema-refuses-unknown-fields-duplicates",
    testName: "strict schema refuses unknown fields, duplicates, path escapes, wrong owners/modes and marker omissions",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/linux-installed-manifest.test.mjs: " +
      "produces and verifies the ref-bound manifest of a real binary .deb.",
  }),
  Object.freeze({
    id: "linux-owned-job-real-linux-qualification-captures-binary-stdout",
    testName: "real Linux qualification captures binary stdout/stderr from the retained executable",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-real-nonzero-command-stops-a-batch",
    testName: "real nonzero command stops a batch and records the later command as not run",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-mutating-caller-arguments-after-admission-cannot",
    testName: "mutating caller arguments after admission cannot change a later real command",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-the-native-owner-executes-captured-reviewed",
    testName: "the native owner executes captured reviewed bytes despite a stale CommonJS cache entry",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-a-real-detached-leftover-is-reaped",
    testName: "a real detached leftover is reaped but never qualifies a zero-exit root",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-a-descendant-that-works-and-exits",
    testName: "a descendant that works and exits after root death cannot disappear between native polls",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-the-exact-helper-counts-an-already",
    testName: "the exact helper counts an already-finished adopted child before emitting its empty-tree receipt",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-real-timeout-preserves-cleanup-proof-and",
    testName: "real timeout preserves cleanup proof and refuses the preceding green output",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-real-output-limit-cancels-the-owner",
    testName: "real output limit cancels the owner and keeps raw files within the declared bound",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-a-real-command-cannot-rewrite-captured",
    testName: "a real command cannot rewrite captured stdout and still publish complete evidence",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-real-abortsignal-cancellation-confirms-ownership-cleanup",
    testName: "real AbortSignal cancellation confirms ownership cleanup before releasing admission",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-linux-qualification-inherits-no-ambient-loader",
    testName: "Linux qualification inherits no ambient loader or Node injection variables",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-linux-tool-identities-and-static-only",
    testName: "Linux tool identities and static-only support cannot be replaced by caller policy",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-linux-native-grace-cannot-record-a",
    testName: "Linux native grace cannot record a budget the shared owner does not implement",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-the-shared-durable-admission-rejects-competition",
    testName: "the shared durable admission rejects competition and retains unresolved cleanup across objects",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-shared-linux-admission-refuses-a-writable",
    testName: "shared Linux admission refuses a writable scope or mutable ancestor before acquiring a ledger",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "linux-owned-job-old-shared-owner-receipt-shape-stays",
    testName: "old shared-owner receipt shape stays compatible while new native facts are additive",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux' || process.arch !== 'x64'` in " +
      "tools/test/linux-owned-job.test.mjs: real Linux owned-job execution, process-tree reaping " +
      "and shared admission ledger.",
  }),
  Object.freeze({
    id: "owner-administration-process-linux-actual-owned-lifetime-delivers-bounded",
    testName: "Linux actual owned lifetime delivers bounded private input and writes only metadata terminal receipts",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in " +
      "tools/test/owner-administration-process.test.mjs: the Linux owned administration lifetime " +
      "with private input and metadata receipts.",
  }),
  Object.freeze({
    id: "owner-administration-trusted-native-actions-read-fixed-private",
    testName: "trusted native actions read fixed private context and a matching signed-reply inbox",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxFilesystem` in tools/test/owner-administration.test.mjs: native Linux " +
      "dirfd, UID and private-mode filesystem boundary for the trusted native actions.",
  }),
  Object.freeze({
    id: "owner-administration-native-pairing-reads-current-consent-instead",
    testName: "native pairing reads current consent instead of accepting it from the renderer",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxFilesystem` in tools/test/owner-administration.test.mjs: native Linux " +
      "dirfd, UID and private-mode filesystem boundary for the trusted native actions.",
  }),
  Object.freeze({
    id: "owner-administration-missing-malformed-wrong-profile-unknown-field",
    testName: "missing malformed wrong-profile unknown-field and unsafe-permission configs refuse without calls",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxFilesystem` in tools/test/owner-administration.test.mjs: native Linux " +
      "dirfd, UID and private-mode filesystem boundary for the trusted native actions.",
  }),
  Object.freeze({
    id: "owner-administration-symlink-hardlink-directory-and-oversized-inbox",
    testName: "symlink hardlink directory and oversized inbox refuse without reading their contents into replies",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxFilesystem` in tools/test/owner-administration.test.mjs: native Linux " +
      "dirfd, UID and private-mode filesystem boundary for the trusted native actions.",
  }),
  Object.freeze({
    id: "owner-administration-native-identity-discovery-permits-only-a",
    testName: "native identity discovery permits only a null public-key pin",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxFilesystem` in tools/test/owner-administration.test.mjs: native Linux " +
      "dirfd, UID and private-mode filesystem boundary for the trusted native actions.",
  }),
  Object.freeze({
    id: "packaged-platform-the-reap-is-measured-against-a",
    testName: "the reap is measured against a real orphaned grandchild, not only against a fixture",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/packaged-platform.test.mjs: measures " +
      "the real Linux reap of an orphaned grandchild and this host's own launcher confinement.",
  }),
  Object.freeze({
    id: "packaged-platform-confining-a-launch-does-not-hide",
    testName: "confining a launch does not hide the pid the driver reaps",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/packaged-platform.test.mjs: measures " +
      "the real Linux reap of an orphaned grandchild and this host's own launcher confinement.",
  }),
  Object.freeze({
    id: "packaged-platform-this-host-is-measured-as-it",
    testName: "this host is measured as it is, so the receipt is not a claim about a different machine",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/packaged-platform.test.mjs: measures " +
      "the real Linux reap of an orphaned grandchild and this host's own launcher confinement.",
  }),
  Object.freeze({
    id: "packaged-qa-suite-3j-only-on-a-driver-whose",
    testName: "3j. --only on a driver whose subject is not on this platform answers with the reason, never with a 0/0 pass",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "platform-guarded in tools/test/packaged-qa-suite.test.mjs: the Linux tree and Linux-launcher " +
      "answers of the packaged QA driver have no Windows subject.",
  }),
  Object.freeze({
    id: "page2-native-linux-picker-linux-native-picker-validates-its-actual",
    testName: "Linux native picker validates its actual owning process and QA paths before any desktop input",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/page2-native-linux-picker.test.mjs: " +
      "the Linux native file picker validates its X11 owning process and QA paths.",
  }),
  Object.freeze({
    id: "page2-native-picker-ownership-native-x11-picker-ownership-accepts-only",
    testName: "native X11 picker ownership accepts only the bound process and its actual transient chain",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in " +
      "tools/test/page2-native-picker-ownership.test.mjs: X11 picker ownership, path readback and " +
      "the GTK/GDK clipboard backend.",
  }),
  Object.freeze({
    id: "page2-native-picker-ownership-native-picker-requires-exact-path-readback",
    testName: "native picker requires exact path readback before accepting, including a lost leading slash",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in " +
      "tools/test/page2-native-picker-ownership.test.mjs: X11 picker ownership, path readback and " +
      "the GTK/GDK clipboard backend.",
  }),
  Object.freeze({
    id: "page2-native-picker-ownership-native-clipboard-imports-matching-gtk-and",
    testName: "native clipboard imports matching GTK and GDK versions when the optional desktop backend is installed",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in " +
      "tools/test/page2-native-picker-ownership.test.mjs: X11 picker ownership, path readback and " +
      "the GTK/GDK clipboard backend.",
  }),
  Object.freeze({
    id: "provider-cli-presence-on-a-real-machine-it-reports",
    testName: "on a real machine it reports the programs that are really there",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "runtime `t.skip` in tools/test/provider-cli-presence.test.mjs when no agent CLI is installed " +
      "on the host; the control measures the owner's installed programs, which the offline " +
      "qualification guest does not carry.",
  }),
  Object.freeze({
    id: "provider-cli-presence-an-owned-copy-is-chosen-first",
    testName: "an owned copy is chosen first, and the app and the engine start the same copy",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/provider-cli-presence.test.mjs: " +
      "owned provider copies need POSIX links and execute bits.",
  }),
  Object.freeze({
    id: "provider-cli-presence-settings-learns-which-copy-is-used",
    testName: "Settings learns which copy is used, whose it is, its version and how many there are, and never a path",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/provider-cli-presence.test.mjs: " +
      "owned provider copies need POSIX links and execute bits.",
  }),
  Object.freeze({
    id: "provider-login-provider-install-stop-owns-a-real",
    testName: "provider install Stop owns a real private fixture process tree through confirmed cleanup",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "skips at RUNTIME via t.skip in tools/test/provider-login.test.mjs: on Linux when the " +
      "engine's hidden-spawn seam is not checked out beside this app tree (an owner sibling " +
      "checkout), and off Linux because the fixture tree uses Linux process containment.",
  }),
  Object.freeze({
    id: "provider-login-an-install-goes-into-toolsenabled-s",
    testName: "an install goes into ToolsEnabled's own folder, is checked, then used, and nothing else is written",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/provider-login.test.mjs: the owned " +
      "install lives on a POSIX filesystem with Linux process containment.",
  }),
  Object.freeze({
    id: "provider-login-a-new-copy-that-lacks-an",
    testName: "a new copy that lacks an option ToolsEnabled needs is kept aside and never used",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/provider-login.test.mjs: the owned " +
      "install lives on a POSIX filesystem with Linux process containment.",
  }),
  Object.freeze({
    id: "refuse-install-while-electron-runs-linux-observes-a-real-executable-holder",
    testName: "Linux observes a real executable holder and ignores a same-prefix sibling",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in " +
      "tools/test/refuse-install-while-electron-runs.test.mjs: observes a real Linux executable " +
      "holder through /proc.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-durable-profile-and-per-user-slot",
    testName: "durable profile and per-user slot exclude another app instance and another profile",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-known-prebuild-failure-releases-unknown-build",
    testName: "known prebuild failure releases; unknown build survives app restart without PID-based unlock",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-successful-verification-releases-both-slots-changed",
    testName: "successful verification releases both slots; changed kernel boot safely recovers interrupted build",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-symlink-journal-or-root-never-follows",
    testName: "symlink journal or root never follows another directory",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-modified-journal-token-refuses-release-instead",
    testName: "modified journal token refuses release instead of deleting another attempt",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-real-child-preflight-release-allows-a",
    testName: "real child preflight release allows a second process without reboot",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-incomplete-malformed-journal-refuses-distinctly-even",
    testName: "incomplete/malformed journal refuses distinctly even after simulated reboot",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-retained-descriptors-cannot-authorize-build-after",
    testName: "retained descriptors cannot authorize build after named state root replacement",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-created-journal-directories-and-files-have",
    testName: "created journal directories and files have exact private ownership/modes",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "sandbox-setup-lease-unsafe-mode-substituted-immediately-after-mkdir",
    testName: "unsafe mode substituted immediately after mkdir refuses before record write",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linuxTest` in tools/test/sandbox-setup-lease.test.mjs: Linux ownership, POSIX " +
      "modes, kernel boot identity and real child crash recovery of the sandbox lease.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-installed-proof-requires-fixed-root-and",
    testName: "installed proof requires fixed root and both externally selected digest bindings without weakening unpacked mode",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-installed-pre-and-post-independently-verify",
    testName: "installed pre and post independently verify package binding and read-only tree; no missing phase is fabricated",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-sealed-harness-demands-exact-references-and",
    testName: "sealed harness demands exact references and refuses escape hatches/duplicates",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-only-currentness-gate-receives-an-explicit",
    testName: "only currentness gate receives an explicit clean exact engine source; GUI stays sterile",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-linux-launch-temp-is-short-private",
    testName: "Linux launch temp is short, private and unique; no owner temp/profile is shared",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-private-account-profile-ancestry",
    testName: "sealed account state stays usable when evidence has a group-writable checkout ancestor",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: " +
      "verifies Linux descriptor-based account custody, Unix directory modes and sticky /tmp ancestry; " +
      "a skip on Linux remains a release blocker.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-runtime-evidence-must-prove-packaged-exact",
    testName: "runtime evidence must prove packaged exact identity and actual secure visible window",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-process-identity-is-real-linux-generation",
    testName: "process identity is real Linux generation metadata, not arbitrary PID liveness",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "smoke-linux-sealed-owner-socket-shutdown-proof-distinguishes-a",
    testName: "owner socket shutdown proof distinguishes a real listener from gone socket",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `process.platform !== 'linux'` in tools/test/smoke-linux-sealed.test.mjs: the " +
      "sealed Linux smoke uses Linux paths, launch environment and process generation metadata.",
  }),
  Object.freeze({
    id: "t842-retained-fixture-root-actual-native-mounted-suite-leaves-generation",
    testName: "actual native mounted suite leaves generation source clean and smoke still refuses untracked dirt",
    class: "owner-data",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "needs the root tooling clone inputs T842_CLEAN_SOURCE_ROOT, T842_TOOLING_ROOT, " +
      "T842_ENGINE_ROOT and T842_DEPENDENCY_ROOT (tools/test/t842-retained-fixture-root.test.mjs); " +
      "a source checkout does not carry the mounted generation source, so it executes only in the " +
      "dedicated T842 native run.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-mutable-linux",
    testName: "strict release refuses a mutable Linux scratch ancestor (775) before mutation",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-mutable-linux-2",
    testName: "strict release refuses a mutable Linux scratch ancestor (777) before mutation",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-mutable-linux-3",
    testName: "strict release refuses a mutable Linux scratch ancestor (1777) before mutation",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-linked-ancestor",
    testName: "strict release refuses a linked ancestor without visiting or changing its target",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-non-directory",
    testName: "strict release refuses a non-directory ancestor before creating scratch",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-refuses-a-foreign-owner",
    testName: "strict release refuses a foreign-owner stat result even when its mode is private",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-checks-inherited-tmpdir-before",
    testName: "strict release checks inherited TMPDIR before creating its default scratch",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-strict-release-preserves-the-native-root",
    testName: "strict release preserves the native root-owned sticky ancestor exception",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "test-strict-linux-prerequisites-a-trusted-linux-ancestor-chain-reaches",
    testName: "a trusted Linux ancestor chain reaches the next real prerequisite with no release measurement",
    class: "platform",
    requiredPlatform: "linux",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "guarded by `linux` in tools/test/test-strict-linux-prerequisites.test.mjs: the strict " +
      "release scratch ancestry rules measure POSIX modes, owners and sticky bits.",
  }),
  Object.freeze({
    id: "accessibility-ui-native-app-controls",
    testName: "real native app controls: owner opt-in, exact confirmation, click/type/select, stale refusal and stop",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "drives a real Electron window through the native app-control adapter " +
      "(tools/test/accessibility-ui.test.mjs). Linux executes it in the release census under its " +
      "private Xvfb display. On Windows it needs an interactive desktop: measured 2026-09-23 " +
      "in the session-0 qualification guest it only timed out after 30000ms, so there it " +
      "runs under TOOLSENABLED_NIGHTLY=1 on a real desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-harness",
    testName: "the harness stayed hidden, sandboxed and offline",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-overflow",
    testName: "the seeded transcript really overflows, so reading position is a real measurement",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-follow",
    testName: "a reader at the bottom is followed by the live stream, in BOTH surfaces",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-reply",
    testName: "a supplied unfinished reply is visible immediately in both surfaces",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-open",
    testName: "opening onto a live stream leaves the live turn in view, not below the fold",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "fix-stream-follow-desktop-parked",
    testName: "a reader who scrolled up on purpose is left alone, and keeps the pill, in BOTH surfaces",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/fix-stream-follow.test.mjs drives a hidden 1600x1000 Electron window and " +
      "measures reading position in it. Windows clamps that window to the desktop work area, and " +
      "the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "harness records displayTooSmall and every check here skips instead of judging a layout the " +
      "product never showed anyone. It executes wherever the desktop is at least 1600x1000: the " +
      "1920x1080 census Xvfb on Linux, the Windows qualification host desktop.",
  }),
  Object.freeze({
    id: "role-functions-ui-desktop",
    testName: "native role editor filters visible functions, preserves drafts, and persists into the real engine role store",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/role-functions-ui.test.mjs opens the real role studio in a 1440x960 Electron window " +
      "and measures its workspace. Windows clamps that window to the desktop work area, and the " +
      "session-0 qualification guest offers 1024x768 (measured 2026-09-23: the workspace " +
      "could not escape the narrow rail), so the helper reports the desktop and the test skips. It " +
      "executes wherever the desktop is at least 1440x960: the census Xvfb on Linux, the Windows " +
      "qualification host desktop.",
  }),
  Object.freeze({
    id: "screen-control-ui-desktop",
    testName: "Settings binds actual host grants, exclusive turns and visible stop",
    class: "nightly",
    stages: Object.freeze(["promotion", "release"]),
    reason:
      "tools/test/screen-control-ui.test.mjs runs three real Electron processes with a shown 1200x900 " +
      "Settings window and the screen-control indicator. Windows clamps those windows to the desktop " +
      "work area, and the session-0 qualification guest offers 1024x768 (measured 2026-09-23), so the " +
      "helper reports the desktop and the test skips. It executes wherever the desktop is at least " +
      "1200x900: the census Xvfb on Linux, the Windows qualification host desktop.",
  }),
]);

// Only a `product-gap` entry retires when its test starts executing. See the
// paragraph above the register for why the other classes are exempt: each of
// them names a test that is supposed to execute in some OTHER run, and
// retiring on that would empty the register every time it did its job.
export const RETIRABLE_CLASSES = new Set(["product-gap"]);

// Named here, and read by the suites themselves, so "which tests are nightly"
// has ONE answer rather than one per file.
export const NIGHTLY_ENVIRONMENT_VARIABLE = "TOOLSENABLED_NIGHTLY";

export function nightlySuitesEnabled(environment = process.env) {
  return environment[NIGHTLY_ENVIRONMENT_VARIABLE] === "1";
}

// The skip reason a nightly-quarantined test carries. It names the register
// entry and the way to run it, so the reason a reader sees in TAP and the
// reason review sees here cannot drift apart.
export function nightlySkipReason(id) {
  const entry = RELEASE_SKIP_REGISTER.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no RELEASE_SKIP_REGISTER entry with id ${JSON.stringify(id)}`);
  if (entry.class !== "nightly") throw new Error(`register entry ${id} is not a nightly entry`);
  return `nightly suite ${id}: ${entry.reason}`;
}

// A BARE `# SKIP` IS A SILENT SKIP, AND NODE PRODUCES ONE BY DEFAULT.
//
// `{ skip: someBoolean }` renders in TAP as `# SKIP` with no words after it.
// MEASURED 2026-09-07 at an earlier app commit: 11 of the run's 25 unexecuted tests said
// nothing at all about why, and a reader of the raw TAP had no way to tell an
// intended platform guard from a test that had quietly stopped working. The
// release register names every skip at the GATE; this names it in the TAP line
// too, so both readers get an answer.
//
// Returns `false` when the test applies here, so it can be used directly as
// `{ skip: platformSkipReason('linux') }` -- one expression that both decides
// and explains, rather than a condition in one place and a sentence in another
// that can drift apart from it.
export function platformSkipReason(required, actual = process.platform) {
  if (actual === required) return false;
  return (
    `requires ${required}; this host is ${actual}. The behaviour has no subject on this platform ` +
    "and remains unexecuted here. Its native run must be measured separately."
  );
}

export function skipEntryAppliesOnPlatform(entry, actual = process.platform) {
  return !entry.requiredPlatform || entry.requiredPlatform !== actual;
}

function classifySkips(tests, stage) {
  const skipped = tests.filter((entry) => entry.skipped);
  if (stage === "development") {
    return { unexecuted: skipped.map((entry) => entry.name), named: [], unnamed: [], retired: [] };
  }
  const registered = new Map(
    RELEASE_SKIP_REGISTER.filter((entry) => entry.stages.includes(stage) && skipEntryAppliesOnPlatform(entry))
      .map((entry) => [entry.testName, entry]),
  );
  const named = [];
  const unnamed = [];
  for (const result of skipped) {
    const entry = registered.get(result.name);
    if (entry) named.push({ name: result.name, id: entry.id, class: entry.class, reason: entry.reason });
    else unnamed.push(result.name);
  }
  const executedNames = new Set(tests.filter((entry) => !entry.skipped).map((entry) => entry.name));
  const retired = [...registered.values()]
    .filter((entry) => RETIRABLE_CLASSES.has(entry.class) && executedNames.has(entry.testName))
    .map((entry) => ({ id: entry.id, name: entry.testName }));
  return { unexecuted: skipped.map((entry) => entry.name), named, unnamed, retired };
}

function requiredControlsForStage(tests, stage) {
  if (!["development", "promotion", "release"].includes(stage)) {
    throw new Error(`unknown test verification stage: ${stage}`);
  }
  return REQUIRED_APP_CONTROLS.filter((control) => control.stages.includes(stage)).map((control) => {
    const matches = tests.filter((entry) => entry.name === control.testName);
    if (matches.length !== 1) {
      throw new Error(`${stage} requires control ${control.id} to execute exactly once; ` +
        `found ${matches.length} results for ${JSON.stringify(control.testName)}`);
    }
    const result = matches[0];
    if (result.skipped || result.failed) {
      throw new Error(`${stage} requires control ${control.id} to pass, but it ${result.skipped ? "was skipped" : "failed"}`);
    }
    return { id: control.id, testName: control.testName, status: "pass" };
  });
}

function parseTap(output) {
  const lines = output.split(/\r?\n/);
  const results = [];
  const summaries = new Map();
  const groups = [{ indent: 0, count: 0, plan: null }];
  function groupFor(indent, isResult) {
    let group = groups.at(-1);
    if (indent < group.indent) {
      // Node emits a child's plan before its parent's result. Closing a group
      // without that result, or jumping past its parent, loses test coverage.
      if (!isResult || group.plan !== group.count || group.indent !== indent + 4) {
        throw new Error("TAP nested plan is incomplete or has no parent result");
      }
      groups.pop();
      group = groups.at(-1);
    }
    if (indent > group.indent) {
      if (group.plan !== null) throw new Error("TAP result appears after its group plan");
      group = { indent, count: 0, plan: null };
      groups.push(group);
    }
    if (group.plan !== null) throw new Error("TAP duplicate plan or result after a completed plan");
    return group;
  }
  /* A node:test FILE-level result names the suite file that died, with the
   * platform's own separator. Anchored at both ends so a TEST whose
   * description merely ends in ".test.mjs" cannot be mistaken for one. */
  const SUITE_FILE_RESULT = /^[^ ].*\.(?:test|spec)\.(?:mjs|cjs|js)$/;
  let current = null;
  let diagnosticIndent = null;
  for (const line of lines) {
    // Node's YAML diagnostics can quote arbitrary program output, including
    // text that looks exactly like another TAP result or a bailout. Only the
    // reporter's structural lines outside this block can change coverage.
    if (diagnosticIndent !== null) {
      const prefix = ' '.repeat(diagnosticIndent);
      if (line === `${prefix}...`) { diagnosticIndent = null; continue; }
      if (line.trim() && !line.startsWith(prefix)) throw new Error('TAP diagnostic is unterminated or incorrectly indented');
      if (line === `${prefix}type: 'suite'`) current.suite = true;
      continue;
    }
    if (current && line === `${' '.repeat(current.indent + 2)}---`) {
      diagnosticIndent = current.indent + 2;
      continue;
    }
    if (/^\s*Bail out!(?:\s|$)/i.test(line)) throw new Error("TAP bail out cannot certify a completed suite");
    const result = /^( *)(not ok|ok) (\d+) - (.*)$/.exec(line);
    if (result) {
      const group = groupFor(result[1].length, true);
      const ordinal = Number(result[3]);
      const outOfOrder = !Number.isSafeInteger(ordinal) || ordinal !== group.count + 1;
      /* A FILE THAT DIES AT IMPORT COSTS THE WHOLE RUN ITS VERDICT, AND IT
       * SHOULD ONLY COST ITSELF.
       *
       * When a suite file throws before its first test runs, node:test emits a
       * FILE-level result at the top level -- "not ok 703 - tools\test\x.test.mjs"
       * -- numbered from the file counter, while this group is counting TESTS.
       * Measured on the 1.0.45 run of 2026-09-17: 14151 tests reported against a
       * plan of 1..13901, one ordinal break at the file-level line for
       * paste-picture-reaches-the-turn.test.mjs, and the ratchet exited 2 having
       * measured nothing. Exit 2 is its documented measured-nothing path, so the
       * gate worked -- but a cut that meets this at seal time stops with neither
       * a pass nor a fail, which is the worst of the three answers.
       *
       * So a file-level result is admitted on its own counter and recorded as a
       * NAMED red. Strictly fail-closed, and the three conditions are what make
       * it safe: it must be `not ok`, it must be at the top level, and its name
       * must be a suite file path. A file-level PASS with a broken ordinal is
       * still refused, because admitting an unexplained GREEN is the failure
       * this ordinal rule exists to prevent; admitting an extra RED can only
       * block a release, never wave one through. */
      const fileLevel = outOfOrder
        && result[2] === 'not ok'
        && result[1].length === 0
        && SUITE_FILE_RESULT.test(result[4]);
      if (outOfOrder && !fileLevel) {
        throw new Error("TAP result ordinal is missing, duplicated, or out of order");
      }
      /* Counted like any other result. Measured against real node:test output:
       * two passing tests in one file and a second file that throws at import
       * produce `ok 1`, `ok 2`, `not ok 2`, plan `1..3`, `# tests 3`, `# fail 1`.
       * The file-level result IS in the plan and in the summary counts, so only
       * its ORDINAL is untrustworthy -- it comes from the file counter. Skipping
       * the increment would leave count at 2 against a plan of 3 and trade this
       * refusal for the plan one. */
      group.count += 1;
      current = {
        indent: result[1].length,
        failed: result[2] === "not ok",
        // Strip the reporter's directive before unescaping a literal "\\#" in
        // a test description. A skip reason is not part of the test identity.
        name: unescapeTapName(result[4].replace(/ # (?:SKIP|TODO)(?:\s.*)?$/i, "")).trim(),
        skipped: / # SKIP(?:\s|$)/i.test(result[4]),
        todo: / # TODO(?:\s|$)/i.test(result[4]),
        suite: false,
        fileLevel,
      };
      results.push(current);
      continue;
    }
    if (/^\s*(?:not ok|ok)\b/.test(line)) throw new Error("TAP test result is malformed");
    const plan = /^( *)1\.\.(\d+)$/.exec(line);
    if (plan) {
      const group = groupFor(plan[1].length, false);
      group.plan = Number(plan[2]);
      if (!Number.isSafeInteger(group.plan) || group.plan !== group.count) {
        throw new Error("TAP group plan does not reconcile with its observed results");
      }
      continue;
    }
    if (/^\s*\d+\.\./.test(line)) throw new Error("TAP test plan is malformed");
    const summary = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (summary) {
      if (summaries.has(summary[1])) throw new Error(`duplicate TAP # ${summary[1]} summary`);
      const value = Number(summary[2]);
      if (!Number.isSafeInteger(value)) throw new Error(`invalid TAP # ${summary[1]} count`);
      summaries.set(summary[1], value);
    }
  }

  if (diagnosticIndent !== null) throw new Error('TAP diagnostic is unterminated');
  const required = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
  const missing = required.filter((field) => !summaries.has(field));
  if (missing.length) throw new Error(`incomplete TAP summary: missing ${missing.map((field) => `# ${field}`).join(", ")}`);
  const counts = Object.fromEntries(summaries);
  if (groups.length !== 1 || groups[0].plan !== groups[0].count) {
    throw new Error("TAP plan is missing or a nested group has no parent result");
  }
  if (counts.cancelled || counts.todo || results.some((entry) => entry.todo)) {
    throw new Error(`the suite is incomplete: ${counts.cancelled} cancelled, ${counts.todo} TODO test(s)`);
  }
  if (counts.tests === 0 || counts.pass + counts.fail === 0) {
    throw new Error("the runner measured ZERO completed tests; skipped/TODO tests are not executed coverage");
  }
  const tests = results.filter((entry) => !entry.suite);
  if (counts.tests !== tests.length
      || counts.suites !== results.length - tests.length
      || counts.tests !== counts.pass + counts.fail + counts.skipped
      || counts.fail !== tests.filter((entry) => entry.failed).length
      || counts.skipped !== tests.filter((entry) => entry.skipped).length) {
    throw new Error("runner disagrees with itself: TAP summary counts do not reconcile with the reported results");
  }
  const failures = results.filter((entry) => entry.failed && entry.indent === 0).map((entry) => entry.name);
  return { failures, counts, tests };
}

// Read-only measurement validation for callers which already ran the suite.
// A reconciled failure is valid evidence, but is never a promotion verdict;
// promotion/release callers must also require counts.fail === 0.
export function validateSuiteResult({ code, signal = null, stdout, stage = "development" }) {
  const { tests, ...measurement } = parseTap(stdout);
  const expectedExit = measurement.counts.fail > 0 ? 1 : 0;
  if (signal || code !== expectedExit) {
    throw new Error(
      `suite process exit ${code} (${signal || "no signal"}) disagrees with TAP # fail ${measurement.counts.fail}; ` +
        "a failed check outside the test runner cannot be accepted as a passing suite",
    );
  }
  return {
    ...measurement,
    stage,
    requiredControls: requiredControlsForStage(tests, stage),
    skips: classifySkips(tests, stage),
  };
}
