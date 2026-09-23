/* Render a verifier-facing release declaration from MEASURED facts.
 *
 *   - Separate the CONFIGURED appId from the OS-observed AUMID. Configuration
 *     passing electron-builder's schema check is not the same claim as "the
 *     OS reports this AUMID"; metadata-only evidence cannot prove that gate.
 *   - List other same-version-pattern files on the machine that are NOT the
 *     candidate, built by SCANNING (see lib/scan-artifacts.mjs), not by a
 *     maintained list that goes stale.
 *   - State the unsigned/SmartScreen caveat plainly, driven by the actual
 *     `signExecutable` value read from package.json, not assumed.
 *   - Say which checks were NOT run (Phase 1/2 install testing, trust UX,
 *     etc.) as plainly as which were.
 *
 * Every field in the "measured" tables below comes from the caller-supplied
 * `facts` object, which cut-release-candidate.mjs populates from things it
 * actually measured (file hashes, VersionInfo read off the real exe, git
 * status output) -- never from what the pipeline was merely told to do.
 *
 * AND NEVER FROM WHO MEASURED THEM. This document is written into the transfer
 * directory to travel with the installer, which makes an absolute path in it a
 * leak of the builder's account name -- the same class as the appId that got an
 * earlier build rejected for carrying the builder's username in its namespace,
 * except here it is in the document that exists to be read by whoever verifies
 * the release. Every path rendered below goes through
 * lib/portable-paths.mjs (roles, %USERPROFILE%, repo-relative -- see that file
 * for which shape applies where), and writeDeclaration() will not put this
 * markdown on disk at all unless tools/check-declaration-privacy.mjs proves it
 * clean first.
 */
import { writeFile } from 'node:fs/promises'

import { assertNoOwnerData } from '../check-declaration-privacy.mjs'
import { assertReleaseReadiness, assertReadinessAdaptersAvailable, assertReceiptNamesRegisteredAdapters, readReleaseReadiness } from '../lib/release-readiness.mjs'
import {
  BUILD_WORKTREE_TOKEN,
  DAY_TO_DAY_WORKTREE,
  HOME_PLACEHOLDER,
  toDeclarableFacts,
} from './lib/portable-paths.mjs'

function fmtBytes(n) {
  return n.toLocaleString('en-US')
}

function bulletList(items) {
  return items.map((item) => `- ${item}`).join('\n')
}

function renderOtherCandidates(otherCandidates, stagingDir) {
  if (otherCandidates.length === 0) {
    return `No other \`ToolsEnabled Setup *.exe\` files were found in the scanned locations ` +
      `(${stagingDir} and its siblings). If one appears later, it is not this candidate unless its ` +
      `SHA-256 matches the value declared above.`
  }
  return (
    'Do not transfer or trust any of these if encountered:\n\n' +
    bulletList(
      otherCandidates.map(
        (item) =>
          `\`${item.path}\` (${fmtBytes(item.bytes)} bytes, SHA-256 \`${item.sha256}\`, mtime ${item.mtime}) -- ` +
          `not this candidate; different bytes.`,
      ),
    )
  )
}

function renderExcludedWip(excludedWip) {
  if (!excludedWip || excludedWip.dirtyFiles.length === 0) {
    return `${DAY_TO_DAY_WORKTREE[0].toUpperCase()}${DAY_TO_DAY_WORKTREE.slice(1)} had no uncommitted changes when ` +
      `this declaration was generated. Nothing was excluded on that account.`
  }
  return (
    `**Another lane's in-progress, uncommitted work exists in ${DAY_TO_DAY_WORKTREE} and is NOT in this build.** ` +
    `The list below is what it was, by repo-relative path -- which is the part that says what is missing; where ` +
    `that checkout sits on the build machine is not recorded. It was measured, by ` +
    `\`git status --porcelain\`, at declaration time (${excludedWip.measuredAt}):\n\n` +
    bulletList(excludedWip.dirtyFiles.map((line) => `\`${line}\``)) +
    `\n\nThis build was produced in an isolated, detached worktree checked out directly from git history ` +
    `(see "Tree state at build time" below); that worktree never contained these files on disk at all, so ` +
    `their exclusion is structural, not something the pipeline had to notice and filter.`
  )
}

function renderPipelineSection(pipeline) {
  const lines = []
  if (pipeline.resumed) {
    lines.push(
      `- \`npm run dist\` -> **did NOT exit 0 in the original run of this cut.** It built and sealed the artifact, then ` +
        `failed at a later post-packaging gate. This candidate was RESUMED from that worktree; see "Resumed cut" below for ` +
        `every post-packaging gate that was re-run against the sealed bytes, and which were accepted from bound evidence.`,
    )
  } else {
    lines.push(`- \`npm run dist\` -> **exit ${pipeline.distExitCode}**, single unbroken run.`)
  }
  if (pipeline.verifySummary) lines.push(`  - \`verify\` (test-ratchet.mjs): ${pipeline.verifySummary}`)
  if (pipeline.checkNoOwnerData) {
    lines.push(
      `  - \`check-no-owner-data.mjs\`: **\`Scanned ${pipeline.checkNoOwnerData.filesScanned} files ` +
        `(${pipeline.checkNoOwnerData.bytesScanned} bytes). Total matches: ${pipeline.checkNoOwnerData.totalMatches}.\`**`,
    )
  }
  if (pipeline.smokePackagedLine) lines.push(`  - \`smoke-packaged.mjs\`: \`${pipeline.smokePackagedLine}\``)
  if (pipeline.packagedQaEvidence) {
    lines.push(
      `- exact-candidate \`packaged-qa-suite.mjs --release <isolated build>/release/win-unpacked\` -> ` +
        `**not re-run in this resumed cut.** Accepted from gate-evidence record \`${pipeline.packagedQaEvidence.file}\`: ` +
        `exit 0 recorded ${pipeline.packagedQaEvidence.recordedAt} by harness commit \`${pipeline.packagedQaEvidence.gateSourceRef}\` ` +
        `against artifact seal SHA-256 \`${pipeline.packagedQaEvidence.sealSha256}\` -- the same seal this candidate re-verified.`,
    )
  } else {
    lines.push(
      `- exact-candidate \`packaged-qa-suite.mjs --release <isolated build>/release/win-unpacked\` -> ` +
        `**exit ${pipeline.packagedQaExitCode}** before the candidate tag or declaration was written.`,
    )
  }
  return lines.join('\n')
}

/* A resumed cut is not a fresh cut and must not read like one. This section
 * exists only when facts.gateRun says the post-packaging gates were re-run
 * outside `npm run dist`, and it lists every one of them with its verdict --
 * including the ones that were skipped, and exactly what evidence each skip
 * leaned on -- so a verifier can reproduce the chain gate by gate. */
function renderResumedCutSection(gateRun) {
  if (!gateRun || gateRun.mode !== 'resumed') return ''
  const rows = gateRun.gates.map((gate) => {
    if (gate.status === 'skipped-with-evidence') {
      return `| \`${gate.name}\` | skipped -- evidence-bound | record \`${gate.evidence.file}\`, exit 0 recorded ${gate.evidence.recordedAt} by harness commit \`${gate.evidence.gateSourceRef}\`; gate script SHA-256 \`${gate.gateScriptSha256}\` unchanged |`
    }
    return `| \`${gate.name}\` | ${gate.status} (exit ${gate.exitCode}) | gate script SHA-256 \`${gate.gateScriptSha256}\` |`
  })
  return `
## Resumed cut -- post-packaging gates re-run against the sealed artifact

The original \`npm run dist\` of this cut built and packaged the artifact, recorded its seal, and then failed at a later gate. ` +
    `Rather than rebuild from scratch, the cut was resumed with \`--resume-from\` against that worktree. Before any gate ran, the ` +
    `artifact seal recorded at ${gateRun.sealRecordedAt} (seal file SHA-256 \`${gateRun.sealSha256}\`) was re-verified: every ` +
    `file under \`release/win-unpacked\` was byte-identical to what packaging produced. The gates below then ran in dist order, ` +
    `from harness commit \`${gateRun.gateSourceRef}\`, with the seal verified again last. A gate marked "skipped -- evidence-bound" ` +
    `was not re-run here; it was accepted only because a gate-evidence record showed the same gate, by the same script bytes, ` +
    `from a clean harness checkout, exiting 0 against this same seal and installer.

| Gate | Result in this resumed cut | Binding |
|---|---|---|
${rows.join('\n')}

Overall: ${gateRun.ok ? '**every gate passed or was evidence-bound; none failed.**' : '**a gate failed -- this declaration should not exist; treat it as suspect.**'}
`
}

function renderAppIdSection(appId) {
  return (
    `\`build.appId: "${appId.configured}"\` in \`package.json\` was accepted by electron-builder's ` +
    `configuration-schema validation (build did not fail). **This declaration certifies the configured ` +
    `value only.** The matrix's actual requirement -- "OS-reported shortcut/running-window AUMID is ` +
    `${appId.configured}" -- requires installing and reading the resulting shortcut's property store, which ` +
    `is Phase 1 install-testing scope and was **not run by this tool**. Do not treat this declaration as ` +
    `satisfying the appId gate by itself; it satisfies the configuration half of it.`
  )
}

function renderUnsignedSection(unsigned) {
  if (unsigned.signExecutable === false) {
    return (
      `**This build is unsigned** -- \`signExecutable: false\` is set in \`package.json\`. Expect SmartScreen ` +
        `friction on first download; this is a known, separate gap from the identity fields this declaration ` +
        `covers, not something this tool attempted to close.`
    )
  }
  return (
    `\`package.json\` sets \`signExecutable: ${JSON.stringify(unsigned.signExecutable)}\`. This tool did not ` +
      `independently verify a valid Authenticode signature is present -- do not treat this line as trust-UX evidence; ` +
      `see the acceptance matrix's "Trust UX" row for what is actually required.`
  )
}

const VERIFICATION_LABELS = {
  'source-only': 'verified by source/history inspection only -- NOT observed against a running installed app',
  observed: 'observed directly against the built/running artifact',
  both: 'verified both by source inspection and by direct observation against the built/running artifact',
}

function renderKnownFixes(knownFixes) {
  if (!knownFixes || knownFixes.length === 0) {
    return (
      'No specific fix claims were declared for this candidate. This is not the same as "nothing changed" -- ' +
      `see the commit range from the previous build ref for what actually landed; nothing here should be read as ` +
      `an implicit claim that a particular defect is fixed.`
    )
  }
  return bulletList(
    knownFixes.map((fix) => {
      const label = VERIFICATION_LABELS[fix.verifiedBy] ?? `verification method not recognised: ${JSON.stringify(fix.verifiedBy)}`
      return `**${fix.description}** -- ${label}.${fix.evidence ? ` Evidence: ${fix.evidence}` : ''}`
    }),
  )
}

const NOT_RUN_ITEMS = [
  'Trust UX (SmartScreen / Defender / Authenticode) -- see unsigned caveat above.',
  'Install/uninstall UX, shortcut/Apps-entry correctness, first-run windows, navigation/configuration, ' +
    'live-vs-simulated indicators, reboot persistence, resource-compliance sampling, Phase 2 clean-VM protocol -- ' +
    'all Phase 1/2 testing scope per the acceptance matrix, not build-and-measure scope.',
  'Whole-product privacy/stranger-fit review. `check-no-owner-data.mjs` scanning the packaged bytes for known ' +
    'patterns is real evidence against the specific leaks it is designed to catch; it is not the matrix\'s ' +
    '"route-by-route captures... human inspection is mandatory" requirement.',
  'appId as an OS-observed AUMID (see appId section above) -- configuration only was verified.',
  'A full multi-cycle close/relaunch persistence test against the installed app -- Phase 1 scope.',
]

export function renderDeclaration(rawFacts) {
  // Applied here as well as at the call site (see lib/portable-paths.mjs): this
  // function is also reachable directly and from a facts file written by an
  // older version of this tool, and "clean depending on who called it" is not a
  // property worth claiming. Idempotent, so the double application costs nothing.
  const facts = toDeclarableFacts(rawFacts)
  const {
    test,
    date,
    version,
    previousVersion,
    branch,
    sourceRef,
    engineSourceRef,
    buildRef,
    branchAdvanced,
    candidate,
    treeState,
    versionInfo,
    appId,
    unsigned,
    pipeline,
    excludedWip,
    otherCandidates,
    stagingDir,
    privateInputsCopied,
    privateInputsSkippedTracked,
    knownFixes,
    gateRun,
  } = facts
  const resumed = gateRun?.mode === 'resumed'

  const header = test
    ? `# TEST BUILD -- NOT A DECLARED CANDIDATE -- DO NOT DISTRIBUTE\n\n` +
      `This file was produced by \`tools/release-packager/cut-release-candidate.mjs --test\` to prove the packager works. ` +
      `It is not an authorized release candidate and must not ` +
      `be transferred, referenced, or treated as satisfying any row of the acceptance matrix.\n\n---\n\n`
    : ''

  return `${header}# ToolsEnabled installer declaration -- ${version}

Date: ${date}
From: automated release packager (\`tools/release-packager/cut-release-candidate.mjs\`)
Governed by: the current ToolsEnabled release protocol's immutable declaration, product identity, and appId gates.

**Disposition: ${test ? 'TEST ARTIFACT -- not offered as a candidate.' : 'this is the immutable candidate. Do not treat any other `ToolsEnabled Setup *.exe` file as a candidate -- see "Artifacts that are NOT this candidate" below.'}**

## The fields the matrix names

This document renders candidate identity and diagnostic build facts. Rendering
or passing selected build checks is **not full release qualification**. Only
validated full-readiness evidence bound to this exact installer and app/engine
source pair can authorize release; absent proof remains NOT QUALIFIED.

| Field | Value |
|---|---|
| Filename | \`${candidate.filename}\` |
| Version | ${version}${previousVersion ? ` (previous candidate: ${previousVersion})` : ''} |
| Exact byte count | ${fmtBytes(candidate.bytes)} |
| SHA-256 | \`${candidate.sha256}\` |
| Build ref | commit \`${buildRef}\`, branch \`${branch}\`${branchAdvanced ? '' : ' (NOT YET the tip of that branch -- see "Branch state" below)'}, in the ToolsEnabled application repository |
${engineSourceRef ? `| Engine source ref | commit \`${engineSourceRef}\`, exactly bound to the staged capability payload |` : ''}
| Publisher (CompanyName) | \`${versionInfo.companyName}\` |
| ProductName | \`${versionInfo.productName}\` |
| appId | \`${appId.configured}\` (configured; see appId section below) |
| Immutable transfer location | \`${stagingDir}\\${candidate.filename}\` (blockmap alongside) |

### Paths in this document

Every path below identifies a location without identifying the builder, because this
document is written to travel with the installer:

- **\`${HOME_PLACEHOLDER}\`** is the build account's home directory, and it resolves as
  written -- paste it into Explorer, \`cmd\`, or PowerShell (\`$env:USERPROFILE\`) and you
  get the real directory. It is a working path, not a redaction.
- **\`${BUILD_WORKTREE_TOKEN}\`** is a throwaway \`git worktree add --detach\` checkout made
  for this build and removed after it. Any empty directory outside your own checkout
  works when reproducing; nothing about this build depends on where it was.
- **${DAY_TO_DAY_WORKTREE}** is the shared checkout other lanes work in. Its location is
  deliberately not recorded; what matters about it here is only what was uncommitted in
  it, listed by repo-relative path under "What this build deliberately excludes".
- Everything else is relative to the repository root.

The build ref above is the same kind of substitution: a commit hash identifies the
source exactly, and on any clone, which is more than a path on one machine ever did.
Nothing a verifier needs has been dropped -- hashes, byte counts, and the full
reproduction sequence are all below.

This is checked rather than intended: \`tools/check-declaration-privacy.mjs\` scanned
this document with \`check-no-owner-data.mjs\`'s own pattern set -- the same guard, the
same patterns as the packaged bytes -- and the file was written only because that scan
came back clean. There is no override for it.

## Branch state

${sourceRef === buildRef && previousVersion === version
  ? `Built from \`${sourceRef}\` in an isolated detached worktree. This explicit same-version cut retains that exact source as \`${buildRef}\`; it creates no additional version commit and requires no branch advancement.`
  : `Built from \`${sourceRef}\` (the tip of \`${branch}\` at build start), then one version-bump commit was added on top ` +
    `in an isolated detached worktree, producing \`${buildRef}\`. ${
      branchAdvanced
        ? `\`${branch}\` was fast-forwarded to \`${buildRef}\` after the build verified clean.`
        : `**\`${branch}\` was NOT advanced to \`${buildRef}\`.** The commit exists in git history and is fully ` +
          `reproducible (\`git show ${buildRef}:package.json\`), but is not yet reachable from \`${branch}\` -- land it ` +
          `deliberately with \`git branch -f ${branch} ${buildRef}\` (a fast-forward; safe by construction) when ready, ` +
          `or re-run with \`--advance-branch\`.`
    }`}

## Tree state at build time -- clean, and what that means

\`git status --porcelain\` was measured **empty** twice: immediately after the isolated detached worktree was ` +
    `created (before the version bump / dependency setup) and again immediately before \`npm run dist\`. Both ` +
    `measurements ran in that isolated build worktree -- a fresh checkout created with ` +
    `\`git worktree add --detach ${BUILD_WORKTREE_TOKEN} ${sourceRef}\`, never ${DAY_TO_DAY_WORKTREE} where ` +
    `other lanes' work happens. That distinction is the point: this candidate's bytes are reproducible from git ` +
    `history at \`${buildRef}\`, plus the local, gitignored inputs listed below -- not from any ` +
    `ambient working-tree state that cannot be recreated.

This is not only this tool's own claim: \`require-clean-tree.mjs\` -- the pipeline's own gate, wired into \`npm run ` +
    `dist\` between \`vite build\` and \`electron-builder\`, unmodified by this tool -- independently wrote ` +
    `\`dist/build-info.json\` inside this same worktree, and this tool read it back after the build succeeded rather ` +
    `than trusting the exit code alone. ${
      treeState.buildInfoConfirmedClean
        ? '**Confirmed: `dirty: false`, `overridden: false`.**'
        : '**DID NOT CONFIRM CLEAN -- this declaration should not have been produced; treat it as suspect.**'
    } \`MC_ALLOW_DIRTY_BUILD\` was also explicitly stripped from the build's environment before \`npm run dist\` ran, ` +
    `rather than trusting that it happened not to be inherited from this process's own shell.

Local, genuinely untracked inputs copied from ${DAY_TO_DAY_WORKTREE}'s \`private\\\` directory into the build ` +
    `worktree (these configure what the privacy scanner looks for; they do not change the code being built): ` +
    `${privateInputsCopied.length > 0 ? privateInputsCopied.map((f) => `\`${f}\``).join(', ') : '(none found)'}. ` +
    `${(privateInputsSkippedTracked?.length ?? 0) > 0
      ? `Left as their git-tracked, committed content and NOT overwritten with this machine's local copies (already ` +
        `part of the build ref, so this is what "reproducible from git history alone" means for them): ` +
        `${privateInputsSkippedTracked.map((f) => `\`${f}\``).join(', ')}.`
      : ''}

## What this build deliberately excludes

${renderExcludedWip(excludedWip)}

## Artifacts that are NOT this candidate

${renderOtherCandidates(otherCandidates, stagingDir)}

## How the declared candidate was produced and verified

1. \`git worktree add --detach ${BUILD_WORKTREE_TOKEN} ${sourceRef}\` -- clean checkout, ${DAY_TO_DAY_WORKTREE} untouched throughout.
2. \`git status --porcelain\` -> empty (captured as evidence, not assumed).
3. ${sourceRef === buildRef && previousVersion === version
  ? `Source already carries ${version}; the explicit same-version cut retains source/build ref \`${buildRef}\`. No version-bump commit was created.`
  : `Version bumped ${previousVersion ? `from ${previousVersion} ` : ''}to ${version} in \`package.json\` and \`package-lock.json\`, committed together (\`git commit -F - -- package.json package-lock.json\`) -> \`${buildRef}\`.`}
4. Dependencies provisioned (junctioned from an existing, lockfile-matched \`node_modules\` when possible; \`npm ci\` otherwise -- see the run log for which happened this time).
5. \`git status --porcelain\` -> empty again, immediately before the build.
6. \`npm run dist\`${resumed ? ' (original run, then resumed -- see "Resumed cut")' : ' -> single unbroken run'}:
${renderPipelineSection(pipeline)}
7. Setup exe and blockmap copied to the immutable transfer location **before** the build worktree was removed, and re-hashed at that location to confirm the copy is byte-identical to the measured build (SHA-256 \`${candidate.sha256}\`, re-verified after copy${treeState.worktreeRemoved ? ' and again after `git worktree remove`' : ''}).
8. ${pipeline.packagedQaEvidence
    ? `The packaged QA suite was NOT re-run in this resumed cut; its exit-0 verdict was accepted from gate-evidence record \`${pipeline.packagedQaEvidence.file}\` bound to this candidate's seal and installer hashes (see "Resumed cut").`
    : `The packaged QA suite was run against **this isolated build's own** \`release/win-unpacked\` and exited ${pipeline.packagedQaExitCode}; no shared or earlier build was accepted as evidence for this candidate.`}
9. ProductName, FileVersion and ProductVersion were read from that staged PE, then immutable tag \`build/${version}\` was created or confirmed at \`${buildRef}\`; an existing tag at another commit refuses instead of moving.
${treeState.worktreeRemoved ? `10. \`git worktree remove --force ${BUILD_WORKTREE_TOKEN}\` -- ${DAY_TO_DAY_WORKTREE} was never entered, touched, or referenced except for the one read-only copy of \`private/**\` described above.` : `10. The build worktree was **kept** (removal was skipped) for inspection; the run log on the build machine names where.`}

${renderResumedCutSection(gateRun)}
### VersionInfo, measured on the actual artifact (not intended metadata)

\`\`\`
CompanyName     : ${versionInfo.companyName}
ProductName     : ${versionInfo.productName}
FileVersion     : ${versionInfo.fileVersion}
ProductVersion  : ${versionInfo.productVersion}
LegalCopyright  : ${versionInfo.legalCopyright}
\`\`\`

### appId -- what is and is not verified here

${renderAppIdSection(appId)}

## Known fixes in this candidate -- and how each was verified

The release protocol requires each specific defect-fix claim to say whether it was verified by source review,
runtime observation, or both. That distinction is a first-class field here rather than prose someone has to
remember to add:

${renderKnownFixes(knownFixes)}

## Explicitly out of scope for this declaration

${renderUnsignedSection(unsigned)}

Not evaluated by this tool, and not implied by anything above:

${bulletList(NOT_RUN_ITEMS)}

---
${cuttingAttribution()}
`
}

/* WHO ACTUALLY CUT THIS, NOT WHO WROTE THE TOOL.
 *
 * These two lines were hardcoded to "Claude Sonnet 5 / session 6f84bf9b" --
 * the session that first wrote this generator. Every declaration since has
 * carried that name, including builds cut by other models in other sessions
 * months later, so a document whose entire purpose is honest provenance was
 * misreporting its own. Read from the environment the cutting session sets;
 * when nothing says, SAY nothing rather than inventing a name. An unnamed
 * cutter is a gap; a confidently wrong one is a false record. */
function parsedCuttingAttribution(environment) {
  const oneLine = (value, max, { brackets = true } = {}) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) return ''
    const trimmed = value.trim()
    if (!trimmed || (!brackets && /[<>]/.test(trimmed))) return ''
    return trimmed
  }
  const explicitModelDeclared = typeof environment.TOOLSENABLED_CUT_MODEL === 'string'
    && environment.TOOLSENABLED_CUT_MODEL.length > 0
  const explicitModel = oneLine(environment.TOOLSENABLED_CUT_MODEL, 160, { brackets: false })
  const claudeModel = explicitModelDeclared
    ? ''
    : oneLine(environment.CLAUDE_MODEL_NAME, 160, { brackets: false })
  const model = explicitModel || claudeModel
  const explicitEmail = oneLine(environment.TOOLSENABLED_CUT_EMAIL, 254)
  const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(explicitEmail)
    ? explicitEmail
    : (!explicitModelDeclared && claudeModel ? 'noreply@anthropic.com' : '')
  const rawSession = oneLine(environment.TOOLSENABLED_CUT_SESSION || environment.CLAUDE_SESSION_ID, 200)
  // Match the commit-msg hook's load-bearing seat discriminator, but use a
  // conservative full-string contract here: the hook searches for a valid
  // token inside the trailer, while the cutter should never accept trailing
  // prose or punctuation as part of the session identity.
  const session = /^[A-Za-z0-9_-]{4,200}$/.test(rawSession) ? rawSession : ''
  const lane = oneLine(environment.TOOLSENABLED_CUT_LANE, 160) || 'release-packager'
  const identity = model && email ? { name: model, email } : null
  return { explicitModelDeclared, identity, lane, session }
}

/* The same validated identity is consumed by both provenance rendering and
 * the automated Git commit. Keeping one parser prevents a declaration from
 * naming one cutter while Git/DCO records the workstation's default account. */
export function cuttingIdentity(environment = process.env) {
  return parsedCuttingAttribution(environment).identity
}

export function cuttingSession(environment = process.env) {
  return parsedCuttingAttribution(environment).session || null
}

export function cuttingAttribution(environment = process.env) {
  const { explicitModelDeclared, identity, lane, session } = parsedCuttingAttribution(environment)
  const who = identity
    ? `Co-Authored-By: ${identity.name} <${identity.email}>`
    : explicitModelDeclared
      ? 'Cut by: incomplete explicit attribution -- TOOLSENABLED_CUT_MODEL requires a valid TOOLSENABLED_CUT_EMAIL.'
      : 'Cut by: an unnamed session -- neither a complete TOOLSENABLED_CUT_MODEL/TOOLSENABLED_CUT_EMAIL pair nor CLAUDE_MODEL_NAME was set when this ran.'
  return `${who}\nLane: ${lane}${session ? ` (session ${session})` : ' (session not recorded)'}`
}

/* SAY IT BEFORE THE BUILD, NOT AFTER IT.
 *
 * The honest-attribution change above has a cost the first run paid in full:
 * with no cutter named (or no unique session recorded), the version-bump
 * commit lacks a required provenance trailer, the repo's commit-msg hook
 * refuses it, and the cut dies AT THE COMMIT --
 * after staging the payload, several minutes in, with a build worktree left
 * behind for postmortem. The refusal was correct and the timing was cruel.
 * So the caller asks this first and stops in a second instead of four minutes.
 */
export function attributionBlocksCommit(environment = process.env) {
  return cuttingIdentity(environment) === null || cuttingSession(environment) === null
}

/* THE GATE IS INSIDE THE WRITE, NOT BESIDE IT.
 *
 * Putting the check in cut-release-candidate.mjs instead would leave this
 * function -- the only function that puts a declaration on disk, and the one the
 * standalone `--out` CLI mode below also calls -- able to write an unchecked
 * document. Scan first, write second, and there is no ordering in which a
 * leaking declaration exists as a file: the failure path never reaches
 * writeFile(), so there is nothing half-written for a later step to pick up and
 * transfer. Same rule require-clean-tree.mjs learned about build-info.json.
 */
export async function writeDeclaration(filePath, facts) {
  const markdown = renderDeclaration(facts)
  assertNoOwnerData(filePath, markdown)
  await assertReleaseReadiness(facts.readiness, {
    product: 'toolsenabled', artifact: { sha256: facts.candidate?.sha256, bytes: facts.candidate?.bytes },
    sourceRefs: { app: facts.buildRef, engine: facts.engineSourceRef },
  })
  await writeFile(filePath, markdown, 'utf8')
  return markdown
}

// Standalone CLI mode: regenerate a declaration for an ALREADY-BUILT exe,
// reading what it can measure directly (VersionInfo, hash, bytes) and
// taking the rest of the facts (git ref, clean-tree state, pipeline log
// summaries) from a JSON file, since those cannot be re-derived after the
// fact from the exe alone. Used to test this renderer against a known-good
// artifact without running a new build.
async function main() {
  const args = process.argv.slice(2)
  const exeIndex = args.indexOf('--exe')
  const factsIndex = args.indexOf('--facts')
  const outIndex = args.indexOf('--out')
  const readinessIndex = args.indexOf('--readiness-evidence')
  if (exeIndex === -1 || factsIndex === -1) {
    console.error('usage: node generate-declaration.mjs --exe <path> --facts <json-file> --readiness-evidence <receipt> [--out <path>]')
    process.exitCode = 2
    return
  }
  if (readinessIndex === -1 || !args[readinessIndex + 1] || args[readinessIndex + 1].startsWith('--')
      || args.lastIndexOf('--readiness-evidence') !== readinessIndex) {
    throw new Error('--readiness-evidence requires exactly one full release-readiness receipt; rendering facts is not qualification')
  }
  assertReadinessAdaptersAvailable('toolsenabled')
  // Refuse a receipt naming an executor this build does not register
  // BEFORE any candidate input is opened or measured. The full check
  // below still binds the receipt to the exe this run actually measured.
  assertReceiptNamesRegisteredAdapters(args[readinessIndex + 1], 'toolsenabled')

  const { readFile } = await import('node:fs/promises')
  const { measureFile } = await import('./lib/hash.mjs')
  const { readExeVersionInfo } = await import('./lib/version-info.mjs')

  const exePath = args[exeIndex + 1]
  const factsPath = args[factsIndex + 1]
  const outPath = outIndex !== -1 ? args[outIndex + 1] : null

  const overrides = JSON.parse(await readFile(factsPath, 'utf8'))
  const measured = await measureFile(exePath)
  const versionInfo = await readExeVersionInfo(exePath)

  const facts = {
    ...overrides,
    // The executable is the authority for every value measured from it. Keep
    // supplemental facts, but never let stale JSON replace the artifact's
    // filename, byte count, hash, or embedded VersionInfo.
    candidate: { ...overrides.candidate, filename: measured.path.split(/[\\/]/).pop(), bytes: measured.bytes, sha256: measured.sha256 },
    versionInfo: { ...overrides.versionInfo, ...versionInfo },
    readiness: await readReleaseReadiness(args[readinessIndex + 1], {
      product: 'toolsenabled', artifact: { sha256: measured.sha256, bytes: measured.bytes },
      sourceRefs: { app: overrides.buildRef, engine: overrides.engineSourceRef },
    }),
  }

  if (outPath) {
    // Through writeDeclaration(), never writeFile() -- this path used to have
    // its own copy of the write and would have been the one way to put an
    // unscanned declaration on disk.
    await writeDeclaration(outPath, facts)
    console.log(`[generate-declaration] wrote ${outPath}`)
  } else {
    // Printing is not writing, but this is still the document, and stdout gets
    // redirected into files. Same gate.
    const markdown = renderDeclaration(facts)
    assertNoOwnerData('the declaration (stdout)', markdown)
    console.log(markdown)
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[generate-declaration] ${error.message}`)
    process.exitCode = 1
  })
}
