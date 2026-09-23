#!/usr/bin/env node
/* CF27: COMMITTED CAPTURES MUST NOT FREEZE A REAL MACHINE'S PATH.
 *
 * check-no-owner-data.mjs guards the packaged bytes (release/dist). It never
 * looks at the repository itself, so nothing stopped a QA capture -- a real
 * Electron run's log, a DOM-measurement JSON, a screenshot fixture -- from
 * being committed with the absolute checkout path of whoever happened to run
 * it baked into the text. Measured at an earlier ref: 6 files under
 * captures-w16e/, evidence/ and tools/ carried one. This gate is the census
 * turned into code (evidence/controller5-cf27-20260908/census.md has the
 * full 132-file audit this allowlist is drawn from) so the next capture is
 * caught before it is committed, not the next time someone happens to grep.
 *
 * THIS IS NOT check-no-owner-data.mjs's job to absorb. That gate's whole
 * design is "run against a build output directory, using an identity profile
 * that names the CURRENT builder" -- pointing it at the source tree finds
 * every FENCE LITERAL below and reports the account-isolation code itself as
 * a leak, the exact mistake its own header spends thirty lines warning
 * against repeating. This gate asks a narrower, unrelated question: does a
 * TRACKED FILE contain an absolute user-profile path at all, regardless of
 * whose account it names. A fence literal answers yes on purpose; this gate
 * has to know about those on purpose too, by an explicit list, not by asking
 * whose name it is.
 *
 * THE ALLOWLIST IS FILES, NOT ACCOUNT NAMES. Rows M8/R83 sanction the
 * ToolsEnabled-Dev builder-fence literal appearing throughout tools/lib/* and
 * tools/test/*: that is deliberate, load-bearing (some of it IS the fence
 * boundary check) and must stay. Two vendored third-party files (a compiled
 * MediaPipe WASM module and its JS glue) carry Google's OWN build server's
 * path, baked into bytes this repository did not produce and cannot safely
 * rewrite without corrupting the binary; they are vendored, not authored, so
 * they are listed rather than "fixed". A handful of report/doc files use the
 * literal placeholder "example-user", which is documentation, not a leak.
 * Every one of those is named exactly, not by directory prefix, so a NEW file
 * dropped into tools/ or tools/test/ -- fence-shaped directory or not -- is
 * still scanned. Only the specific files this audit actually read are exempt.
 *
 * THE REDACTED MARKER IS A VALUE, NOT A FILE EXEMPTION. The captures under
 * captures-w16e/ and evidence/ are deliberately NOT on the allowlist: they
 * are exactly the shape of file this gate exists to keep honest, so a future
 * re-capture that reintroduces a real account name must still fail here. Where
 * this task could not avoid an absolute path in what a real Electron run
 * actually produced, the account segment was replaced with the fixed token
 * REDACTED_MARKER instead of a real name. That one value is recognised
 * wherever it appears, in any file, because it identifies nobody -- so the
 * fixed files pass without needing a file-level exemption that would also
 * cover a real leak landing in the same path later.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const REDACTED_MARKER = 'redacted-profile'

const PATTERNS = [
  // CF27 review finding 1: these four carried no `i` flag, so a leak whose
  // drive/segment prefix happened to differ only in case from the label
  // above (all-lowercase Windows drive+segment, "Home" capitalized instead
  // of "home", or a lowercase macOS "users") was completely invisible even
  // though the account-name capture group already accepted any case. Adding
  // `i` closes that gap; the captured account-name group itself is
  // unchanged, so classification/allowlist behavior for existing matches is
  // unaffected.
  //
  // T339 review finding 4: with `i` and no anchor, the Linux pattern matched
  // the middle of a page path in prose ("Chat/Home/Messages/tree") and a
  // sentence of a review document was rewritten to get past the gate. The
  // /home/ and /Users/ forms now refuse a path-ish character (letter, digit,
  // dot, dash, underscore) immediately before the slash, so a segment inside a
  // longer relative path cannot match while a path that starts at a space,
  // quote, equals sign, parenthesis or line start still does.
  { label: 'Windows C:\\Users\\<account>', regex: /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)/gi },
  { label: 'Windows C:/Users/<account>', regex: /[A-Za-z]:\/Users\/([A-Za-z0-9._-]+)/gi },
  { label: 'Linux /home/<account>', regex: /(?<![A-Za-z0-9._-])\/home\/([A-Za-z0-9._-]+)/gi },
  { label: 'macOS /Users/<account>', regex: /(?<![A-Za-z0-9._-])\/Users\/([A-Za-z0-9._-]+)/gi },
]

// Exact tracked paths audited in evidence/controller5-cf27-20260908/census.md
// and classified there as FENCE LITERAL, DOC PLACEHOLDER or VENDORED
// THIRD-PARTY BUILD ARTEFACT. See that file for the account name/reasoning
// behind each entry. Kept as file paths, not patterns, so nothing outside
// this exact list is ever silently exempted.
const ALLOWLIST = new Set([
  // Audited during .45 recovery: these source drivers enforce the permitted
  // Dev account, or exercise synthetic foreign/malformed profile refusals.
  // No captured evidence is exempted; its originals are retained separately
  // and its committed account segments use redacted-profile.
  'auxiliary/scribe/test/test_research_delegation.js',
  'tools/research-data-contrast-qa.mjs',
  'tools/research-data-open-qa.mjs',
  'tools/research-data-quality-qa.mjs',
  'tools/research-data-quality-real-qa.mjs',
  'tools/research-snippets-qa.mjs',
  'tools/test/a11y-reparse-probe-diagnostics.test.mjs',
  'tools/test/image-composer-durable.test.mjs',
  'tools/test/page2-native-launch-arguments.test.mjs',
  'tools/test/source-fixture-root.test.mjs',
  'tools/test/tree-standalone-binding-start-order.test.mjs',
  'docs/accessibility-role-tool-verification.md',
  // This task's own mutation-check transcript: it captures the gate's RED
  // output verbatim, which necessarily quotes the synthetic offending path
  // ("SomeoneElse") planted to prove detection works. Same reasoning as the
  // test-fixture entries below -- a demonstration, not a real leak.
  'evidence/controller5-cf27-20260908/red.log',
  // CF27 independent review follow-up: the same reasoning as red.log above,
  // for the case-insensitivity fix's own required plant/remove mutation
  // check (an all-lowercase Windows drive-and-account path, planted in
  // tools/ and removed again) and its RED-side transcript, which
  // necessarily quotes the synthetic offending path verbatim.
  'evidence/controller5-cf27-20260908/red-case-plant.log',
  // This task's own audit documents: they quote the exact matched strings
  // from the census (including the redacted files' pre-fix account name and
  // the vendored WASM finding's real-but-not-ours vrabaud/web_user paths) as
  // evidence of what was found, not as new leaks of their own.
  'evidence/controller5-cf27-20260908/census.md',
  'evidence/controller5-cf27-20260908/REPORT.md',
  'public/hand-controls/vendor/vision_wasm_internal.js',
  'public/hand-controls/vendor/vision_wasm_internal.wasm',
  'reports/context-window/after/measurements.json',
  'reports/context-window/real-codex/measurements.json',
  'reports/context-window/wider/measurements.json',
  'reports/lanes/checkout-live.md',
  'reports/lanes/nsis-upgrade.md',
  'reports/lanes/oauth-signin.md',
  'reports/lanes/page2-full-view.md',
  'reports/lanes/performance-no-lag.md',
  'reports/lanes/qa-drivers.md',
  'reports/lanes/qa-drivers-run1.txt',
  'reports/lanes/qa-drivers-run2.txt',
  'reports/lanes/qa-drivers-run3.txt',
  'reports/lanes/ratchet-regression-fix.md',
  'reports/lanes/red-qa-drivers.md',
  'reports/lanes/setup-deadend.md',
  'reports/lanes/steering-controls.md',
  'reports/lanes/team1-a1.md',
  'reports/lanes/team1-a2.md',
  'reports/lanes/team1-a3.md',
  'reports/lanes/team2-b10.md',
  'reports/lanes/team2-b10-review.md',
  'reports/lanes/team2-b1.md',
  'reports/lanes/team2-b2.md',
  'reports/lanes/team2-b3-implementation.md',
  'reports/lanes/team2-b3.md',
  'reports/lanes/team2-b3-review.md',
  'reports/lanes/team2-b5.md',
  'reports/lanes/team2-b6.md',
  'reports/lanes/team2-b6-review.md',
  'reports/lanes/team2-b7.md',
  'reports/lanes/team2-b8.md',
  'reports/lanes/team2-b9.md',
  'reports/lanes/team4-d10.md',
  'tools/benchmark-hand-controls.mjs',
  'tools/check-artifact-private.mjs',
  'tools/check-no-owner-data.mjs',
  'tools/first-run-contract-qa.mjs',
  // Added when the CF27 review's case-insensitivity fix (finding 1) was
  // applied: both call .toLowerCase() on a path before checking its prefix
  // against the Dev profile fence, so the drive/segment literal in source is
  // deliberately all-lowercase -- the same load-bearing containment-
  // assertion shape as tools/w16e-card-lines-check.mjs below, not a captured
  // leak. Case-sensitive matching missed these; the case-insensitive
  // regexes now correctly see them, and they belong here.
  'tools/hand-controls-practice.cjs',
  'tools/prepare-hand-controls.mjs',
  'tools/inside-agents-drive.mjs',
  'tools/ledger-page-measure.ps1',
  'tools/lib/adapters/artifact-files.mjs',
  'tools/lib/capability-source-git.mjs',
  'tools/lib/drivers/desktop-journeys.mjs',
  'tools/lib/drivers/installer-lifecycle.mjs',
  'tools/lib/guest/Read-InstalledState.ps1',
  'tools/lib/release-readiness.mjs',
  'tools/lib/test-scratch-root.mjs',
  'tools/lib/transport/owned-job.mjs',
  'tools/lib/transport/QualificationVm.psm1',
  'tools/queue-strip-controls-qa.mjs',
  'tools/release-packager/lib/gate-quarantine.mjs',
  'tools/release-packager/lib/portable-paths.mjs',
  'tools/release-packager/lib/readiness-handoff.mjs',
  'tools/send-actually-sends-qa.mjs',
  'tools/test/accessibility-desktop-streams.test.mjs',
  'tools/test/accessibility-desktop.test.mjs',
  'tools/test/accessibility-document.test.mjs',
  'tools/test/accessibility-speech.test.mjs',
  'tools/test/account-registry.test.mjs',
  'tools/test/account-reset-copy.test.mjs',
  'tools/test/account-session-recovery.test.mjs',
  'tools/test/agent-availability-copy.test.mjs',
  'tools/test/agent-close-is-not-a-failed-turn.test.mjs',
  'tools/test/agent-compose-panel.test.mjs',
  'tools/test/agent-dispatch-packaged-qa.test.mjs',
  'tools/test/agent-facade.test.mjs',
  'tools/test/agent-files-panel.test.mjs',
  'tools/test/agent-history-read.test.mjs',
  'tools/test/agent-host-answer-approval-refusal.test.mjs',
  'tools/test/agent-host-real-start-cancellation.test.mjs',
  'tools/test/agent-host-start-cancellation.test.mjs',
  'tools/test/agent-session-end-record.test.mjs',
  'tools/test/bootstrap-fence-link-inside-the-profile.test.mjs',
  'tools/test/chat-queue-doors.test.mjs',
  'tools/test/check-artifact-private.test.mjs',
  'tools/test/check-drivers-discovered.test.mjs',
  'tools/test/check-no-owner-data.test.mjs',
  // This gate's own test: it plants synthetic offender paths (SomeoneElse,
  // someone-real) as fixture strings to prove detection works. Same shape as
  // every other SYNTHETIC TEST FIXTURE entry above, added by this task rather
  // than the original census.
  'tools/test/check-no-profile-paths.test.mjs',
  'tools/test/cloud-account-setup.test.mjs',
  'tools/test/codex-astra-tier.test.mjs',
  'tools/test/control-state.test.mjs',
  'tools/test/declaration-preflight.test.mjs',
  'tools/test/declaration-privacy.test.mjs',
  'tools/test/device-claim.test.mjs',
  'tools/test/download-wire.test.mjs',
  'tools/test/durable-storage.test.mjs',
  'tools/test/electron-node-handoff.test.mjs',
  'tools/test/empty-envelopes.test.mjs',
  'tools/test/fixtures/page2-layout-README.md',
  'tools/test/fixtures/run-page2-layout.mjs',
  'tools/test/fixtures/run-research-report-integrity.mjs',
  'tools/test/gate-quarantine.test.mjs',
  'tools/test/google-signin.test.mjs',
  'tools/test/harness-credential-fence.test.mjs',
  'tools/test/installer-registration-fence.test.mjs',
  'tools/test/install-profile-guard.test.mjs',
  'tools/test/launch-live.test.mjs',
  'tools/test/ledger-words-wrap.test.mjs',
  'tools/test/local-data-reset.test.mjs',
  'tools/test/machine-search-path.test.mjs',
  'tools/test/no-owner-data.test.mjs',
  'tools/test/packaged-qa-suite.test.mjs',
  'tools/test/provider-cli-presence.test.mjs',
  'tools/test/rail-said-markdown.test.mjs',
  'tools/test/relay-supervisor.test.mjs',
  'tools/test/release-qualification.test.mjs',
  'tools/test/require-clean-tree.test.mjs',
  'tools/test/role-function-provenance.test.mjs',
  'tools/test/session-launch-environment.test.mjs',
  'tools/test/settings-recovery-notice.test.mjs',
  'tools/test/setup-profile.test.mjs',
  'tools/test/slash-commands.test.mjs',
  'tools/test/smoke-linux-sealed.test.mjs',
  'tools/test/sterile-launch.test.mjs',
  'tools/test/subscribe-endpoint.test.mjs',
  'tools/test/test-ratchet.test.mjs',
  'tools/test/test-suite-result.test.mjs',
  'tools/test/tree-address-saved-tree-wins.test.mjs',
  'tools/test/tree-graph-card-copy-wrap.test.mjs',
  'tools/test/tree-node-command-handoff-driver.test.mjs',
  'tools/test/tree-node-command.test.mjs',
  'tools/test/uninstall-retention.test.mjs',
  'tools/test/usage-record.test.mjs',
  'tools/test/voice-bundle.test.mjs',
  'tools/test/voice-runtime-paths.test.mjs',
  'tools/w16e-card-lines-check.mjs',
  // T339 (1.0.45 cut): the gate was RED at 232 and nothing ran it. Every
  // occurrence outside tools/ was a captured artefact and had its account
  // segment replaced with REDACTED_MARKER instead. The entries below are the
  // remainder: files under tools/ whose path literals are deliberate.
  //
  // DOC PLACEHOLDER: a comment describing the profile layout with a "<profile>"
  // template prefix before a home segment; no account is named.
  'tools/lib/packaged-platform.mjs',
  // BUILDER-FENCE LITERAL (rows M8/R83): the Dev profile's temp directory is
  // the boundary this preinit check refuses to cross.
  'tools/nsis-preinit-boundary.mjs',
  // SYNTHETIC FIXTURE: a single-letter "x" account stands in for the owner's
  // live tree so the vault-fence purity check can prove it never reads it.
  'tools/vault-fence-purity-qa.mjs',
  // BUILDER-FENCE FIXTURES: these tests spell the Dev profile as the
  // fixture cwd/profile they hand the code under test; the literal is the
  // fence itself (rows M8/R83), not a captured run.
  'tools/test/chat-mention-refusal.test.mjs',
  'tools/test/disposable-guest-contract.test.mjs',
  'tools/test/session-profile-compose-refresh.test.mjs',
  'tools/test/tree-rail-draft-navigation.test.mjs',
  'tools/test/tree-rail-transcript-hydration.test.mjs',
  // MEASURED-LENGTH FIXTURE: REHEARSAL_03_TMPDIR reproduces a real Linux
  // cutter rehearsal path whose exact byte length (asserted as 112) is the
  // case under test; substituting the marker would change the length and
  // silently retire the case. The other literals in the file are the
  // synthetic "operator" account under a Linux home prefix.
  'tools/test/cut-dist-chain-environment.test.mjs',
  // SYNTHETIC FIXTURES: invented accounts (Someone, SomebodyWithAVeryLong
  // AccountName, fixture, private, Forbidden-Fixture, FixtureOwner, Another,
  // AuditOwner, Unowned, qa, current, other, Current, someone, somebody,
  // DiffFixtureForeign) planted to prove ownership/fence refusals fire.
  'tools/test/cut-powershell-module-path.test.mjs',
  'tools/test/cut-windows-short-temp-root.test.mjs',
  'tools/test/desktop-journeys-toolsenabled.test.mjs',
  'tools/test/desktop-sessions-renderer.test.mjs',
  'tools/test/lifecycle-input-check.test.mjs',
  'tools/test/local-agent-native-journey.test.mjs',
  'tools/test/owned-fixture-temp.test.mjs',
  'tools/test/page2-native-paths.test.mjs',
  'tools/test/page2-native-picker-ownership.test.mjs',
  'tools/test/page2-native-provider-account.test.mjs',
  'tools/test/prefs-refusal-is-visible.test.mjs',
  'tools/test/provider-client-presence-gate.test.mjs',
  'tools/test/scratch-fence.test.mjs',
  'tools/test/session-diff-access.test.mjs',
  'tools/test/update-check.test.mjs',
  // STORED ENGINE PATCH AND ITS PROOF (T339 review finding 5): the paths
  // inside are the engine test's own fixture -- a synthetic "owner" account
  // beside USERNAME: 'owner', and a synthetic stderr string -- and the patch
  // must stay byte-identical to the engine commit it documents
  // (index cf8583d8..98198a23) or it no longer reproduces that commit.
  // Redacting inside a patch changes what the patch applies; listing the
  // file leaves the evidence honest.
  'reports/engine-patches/uac-phase-b-fix.patch',
  'reports/engine-patches/uac-phase-b-linux-proof.js',
])

export function scanRepository(root = REPO_ROOT) {
  // --cached (tracked) AND --others --exclude-standard (untracked, not
  // gitignored): a capture written to disk and never `git add`ed is still
  // about to become a committed artefact the moment someone runs `git add .`,
  // and CF27 is exactly about not discovering the leak after that happens.
  // Listed in two calls, not one, so each offender can say which kind of file
  // it is: a tracked leak is already in history, an untracked one is about to be.
  const listed = (args) => {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z', ...args], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) {
      throw new Error(`git ls-files failed: ${result.stderr || result.status}`)
    }
    return result.stdout.split('\0').filter(Boolean)
  }
  const kinds = new Map()
  for (const relPath of listed(['--cached'])) kinds.set(relPath, 'tracked')
  for (const relPath of listed(['--others', '--exclude-standard'])) {
    if (!kinds.has(relPath)) kinds.set(relPath, 'untracked-not-ignored')
  }
  const files = [...kinds.keys()]
  const offenders = []
  for (const relPath of files) {
    if (ALLOWLIST.has(relPath)) continue
    let text
    try {
      // latin1 is a lossless byte<->char roundtrip: every byte value 0-255
      // maps to exactly one code unit, so an ASCII-range pattern still
      // matches correctly inside a binary file without needing to know its
      // real encoding first.
      text = readFileSync(path.join(root, relPath)).toString('latin1')
    } catch (cause) {
      throw new Error(`PROFILE_PATH_SCAN_UNREADABLE: could not scan ${relPath}`, { cause })
    }
    const hits = []
    for (const { label, regex } of PATTERNS) {
      regex.lastIndex = 0
      let match
      while ((match = regex.exec(text)) !== null) {
        if (match[1] === REDACTED_MARKER) continue
        hits.push({ label, match: match[0], start: match.index, end: match.index + match[0].length })
      }
    }
    // One string, one offender. A forward-slash Windows profile path satisfies
    // both the forward-slash Windows pattern and the macOS pattern over
    // overlapping spans; before T339 it was counted twice, so every total this
    // gate printed was inflated.
    // Patterns are tried in declaration order, so the more specific Windows
    // form wins the span.
    hits.sort((a, b) => a.start - b.start || b.end - a.end)
    let lastEnd = -1
    for (const hit of hits) {
      if (hit.start < lastEnd) continue
      lastEnd = hit.end
      offenders.push({ file: relPath, kind: kinds.get(relPath), label: hit.label, match: hit.match })
    }
  }
  return { scanned: files.length, offenders }
}

function main() {
  // T339: defaults to the repository THIS FILE lives in, not the caller's
  // cwd. The gate is wired into the `test` and release chains and must scan
  // the same checkout those chains are cutting from wherever the shell
  // happens to be. A test fixture points it at a throwaway repository by
  // passing that path as the first argument instead of relying on cwd.
  const root = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT
  const { scanned, offenders } = scanRepository(root)
  if (scanned === 0) {
    console.error('check-no-profile-paths: scanned 0 files, so this proved nothing.')
    process.exit(2)
  }
  if (offenders.length > 0) {
    const untracked = offenders.filter(({ kind }) => kind !== 'tracked').length
    console.error(
      `check-no-profile-paths: ${offenders.length} absolute profile path(s) in tracked or untracked-not-ignored `
      + `file(s) outside the allowlist (${offenders.length - untracked} in tracked, ${untracked} in untracked-not-ignored):`,
    )
    for (const { file, kind, label, match } of offenders) {
      console.error(`  ${file} [${kind}]: ${label} -- "${match}"`)
    }
    console.error(
      '\nA tracked file carries a real machine\'s absolute account path, or an untracked one is about '
      + 'to the moment it is added. If this is a genuinely new fence-literal use (rows M8/R83), add the '
      + 'exact file to ALLOWLIST in tools/check-no-profile-paths.mjs with a reason. If it is a captured '
      + 'artefact, replace the account segment with the fixed redacted-profile token instead. If it is '
      + 'scratch that was never meant for the repository, delete it or ignore it.',
    )
    process.exit(1)
  }
  console.log(`check-no-profile-paths: scanned ${scanned} tracked or untracked-not-ignored file(s), 0 absolute profile paths outside the allowlist.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
