/* Refuse a staged payload whose bytes are older than the source they came from.
 *
 * THE GAP THIS CLOSES. Everything that inspects the capability payload checks
 * that files are PRESENT, never that they are CURRENT. check-asar-manifest.mjs
 * verifies every declared entrypoint and hostModule exists in the built package;
 * check-payload-boundary.mjs verifies every staged file is classified;
 * check-no-owner-data.mjs scans the staged bytes. All three pass on a payload
 * staged an hour ago from code that has since changed.
 *
 * And the tests do not cover it either, because tests import from the SOURCE
 * tree while the installer ships the STAGED tree. When those two disagree, every
 * suite is green and the shipped bytes are something nobody tested.
 *
 * MEASURED WHEN THIS WAS WRITTEN: 215 of 218 staged files matched source, and
 * the three that did not were src/lib/providers/cli-provider-gateway.js,
 * src/lib/providers/subscription-launch-env.js and src/lib/tool-registry.js --
 * the authoritative credential scrub, the module that delegates into it, and the
 * permission-tier dispatch chokepoint. The three most security-critical files in
 * the payload were the stale ones, every gate reported clean, and the staged
 * copy of the scrub was the pre-fix version with a known Windows bypass.
 *
 * That is not a coincidence, it is the mechanism: the files that get fixed are
 * the files that go stale, so staleness selects for exactly the code someone
 * just decided was worth changing.
 *
 * WHY THIS IS NOT ALREADY SAFE. `npm run dist` runs pack:capability before
 * electron-builder, so the ordinary ship path restages and self-heals -- a lane
 * initially reported this as "anything cut now ships the bypass" and corrected
 * itself, rightly. The danger is narrower and worse: a check run BY HAND against
 * an existing staged directory returns green over the wrong bytes, and a green
 * from a gate is what people quote. This guard makes that impossible to do
 * quietly.
 *
 * NEUTRAL DEFAULTS ARE VERIFIED, NOT SKIPPED. Some files are deliberately not
 * their source versions: the packer substitutes capability-defaults/<path> for
 * files whose source versions describe the builder or otherwise are not valid
 * customer defaults. Skipping them would leave the files most likely to carry
 * owner data unchecked by this guard, so they are compared against
 * capability-defaults/ instead. A guard with a hole where the sensitive files
 * are is worse than no guard, because it reports on them.
 */
import { collectProviderRuntimePayload } from './lib/provider-runtime-payload.mjs'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { resolveCapabilitySourceBinding } from './lib/capability-source-git.mjs'

const PAYLOAD_RECORD = 'PAYLOAD.json'

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const stagedDirectory = path.resolve(process.argv[2] || path.join(repoRoot, 'capability'))

  if (!existsSync(stagedDirectory) || !statSync(stagedDirectory).isDirectory()) {
    console.error(`[check-payload-current] no staged payload at ${stagedDirectory}`)
    process.exitCode = 1
    return
  }

  const payloadFile = path.join(stagedDirectory, PAYLOAD_RECORD)
  if (!existsSync(payloadFile)) {
    console.error('[check-payload-current] the staged directory has no PAYLOAD.json, so it cannot state what it is.')
    process.exitCode = 1
    return
  }

  // The staged record is part of what ships, so it cannot be the authority for
  // deciding where the other staged files came from. That made an old record's
  // neutralDefaults list capable of routing a newly-neutralized file back to
  // the engine source and reporting the wrong bytes current. The pack manifest
  // is the packer's authority and lives outside the derived payload.
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'tools', 'capability-manifest.json'), 'utf8'))
  const neutralDefaults = manifest.neutralDefaults ?? []
  const neutral = new Set(neutralDefaults)

  let binding
  try {
    binding = resolveCapabilitySourceBinding({ repoRoot })
  } catch (error) {
    // Unknown is not current. This mirrors require-clean-tree.mjs: a provenance
    // gate that cannot reach what it compares against must refuse, not pass.
    console.error(`[check-payload-current] ${error.message}`)
    console.error('[check-payload-current] refusing rather than reporting current without exact source provenance.')
    process.exitCode = 1
    return
  }
  const { source, sourceRef } = binding
  const providerRuntimes = collectProviderRuntimePayload(source, manifest.providerRuntimes || [])
  const stagedRuntimes = collectProviderRuntimePayload(stagedDirectory, manifest.providerRuntimes || [])
  if (JSON.stringify(providerRuntimes.records) !== JSON.stringify(stagedRuntimes.records)) throw Error('staged provider runtime provenance differs')

  const defaultsDirectory = path.join(repoRoot, 'capability-defaults')
  const stale = []
  const orphaned = []
  let compared = 0
  const stagedFiles = walk(stagedDirectory).sort()

  for (const relative of stagedFiles) {
    if (relative === PAYLOAD_RECORD) continue
    const staged = path.join(stagedDirectory, relative)
    const counterpart = neutral.has(relative)
      ? path.join(defaultsDirectory, relative)
      : path.join(source, relative)

    if (!existsSync(counterpart)) { orphaned.push(relative); continue }
    compared += 1
    if (sha256(staged) !== sha256(counterpart)) {
      stale.push({ relative, from: neutral.has(relative) ? 'capability-defaults' : 'source' })
    }
  }

  // PAYLOAD.json is generated, but generated does not mean uncheckable. Rebuild
  // its deterministic contract from the authoritative manifest and the bytes
  // actually beside it. This accounts for the record itself, detects stale
  // provenance lists, and also makes an UNSHIPPABLE marker a named orphan
  // instead of silently excluding a file that would reach the installer.
  const recordedFiles = stagedFiles.filter((relative) => relative !== PAYLOAD_RECORD)
  let byteCount = 0
  const digest = createHash('sha256')
  for (const relative of recordedFiles) {
    const file = path.join(stagedDirectory, relative)
    const bytes = readFileSync(file)
    byteCount += bytes.length
    digest.update(relative)
    digest.update('\0')
    digest.update(bytes)
  }
  const expectedRecord = {
    schemaVersion: 1,
    sourceRef,
    entrypoints: manifest.entrypoints,
    bridgeEntrypoint: manifest.entrypoints[0],
    ownerHostModule: 'src/owner-host.js',
    hostModules: manifest.hostModules || [],
    spawnedPrograms: manifest.spawnedPrograms || [],
    helperPrograms: manifest.helperPrograms || [],
    ...(providerRuntimes.records.length ? { providerRuntimes: providerRuntimes.records } : {}),
    fileCount: recordedFiles.length,
    byteCount,
    payloadSha256: digest.digest('hex'),
    neutralDefaults,
    ownerDataClean: true,
  }
  compared += 1
  if (readFileSync(payloadFile, 'utf8') !== `${JSON.stringify(expectedRecord, null, 2)}\n`) {
    stale.push({ relative: PAYLOAD_RECORD, from: 'generated payload metadata' })
  }

  if (!stale.length && !orphaned.length) {
    try {
      resolveCapabilitySourceBinding({ repoRoot, explicitSource: source, explicitSourceRef: sourceRef })
    } catch (error) {
      console.error(`[check-payload-current] source provenance changed while files were compared: ${error.message}`)
      process.exitCode = 1
      return
    }
    console.log(`[check-payload-current] staged payload is current: ${compared} files match their source bytes exactly.`)
    return
  }

  console.error('[check-payload-current] REFUSING: the staged payload does not match the code it came from.')
  if (stale.length) {
    console.error('')
    console.error('These staged files differ from their current counterpart. Tests read the')
    console.error('source tree; the installer ships these bytes. Every other gate passes on them:')
    for (const entry of stale) console.error(`  ${entry.relative}   (vs ${entry.from})`)
  }
  if (orphaned.length) {
    console.error('')
    console.error('These staged files have no counterpart at all, so nothing can vouch for them:')
    for (const relative of orphaned) console.error(`  ${relative}`)
  }
  console.error('')
  console.error('Re-stage before trusting any result taken from this directory:')
  console.error('  npm run pack:capability')
  process.exitCode = 1
}

main()
