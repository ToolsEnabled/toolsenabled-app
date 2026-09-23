import nodeChildProcess from 'node:child_process'
import nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { performance } from 'node:perf_hooks'

const require_ = createRequire(import.meta.url)
const { trustedProfileShortAliasRoot } = require_('../../shell/install-profile-guard.cjs')

const MAX_AUTH_BYTES = 4n * 1024n * 1024n
const MAX_RECOVERY_ENTRIES = 4096
const MAX_RECOVERY_DEPTH = 16
const WIN32_REPARSE_PROBE = "$ErrorActionPreference='Stop';$raw=[Console]::In.ReadToEnd();$paths=ConvertFrom-Json -InputObject $raw;if($paths.Count -lt 1){throw 'empty reparse probe'};$bits=New-Object System.Collections.Generic.List[int];foreach($p in $paths){$a=[System.IO.File]::GetAttributes([string]$p);if(($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){$bits.Add(1);break}else{$bits.Add(0)}};[Console]::Out.Write('['+($bits -join ',')+']')"
const STAGE_GUARDS = new WeakMap()

function refused(reason = 'refused') {
  const error = new Error(`A11Y_CODEX_AUTH_STAGE_REFUSED:${reason}`)
  error.code = 'A11Y_CODEX_AUTH_STAGE_REFUSED'
  error.reason = reason
  return error
}

function cleanupFailed() {
  const error = new Error('A11Y_CODEX_AUTH_CLEANUP_FAILED')
  error.code = 'A11Y_CODEX_AUTH_CLEANUP_FAILED'
  return error
}

function samePath(left, right, platform) {
  return platform === 'win32'
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : String(left) === String(right)
}

function containedBy(pathApi, root, candidate) {
  const relative = pathApi.relative(root, candidate)
  return relative === '' || (!pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`))
}

function componentPaths(pathApi, target) {
  const absolute = pathApi.resolve(target)
  const parsed = pathApi.parse(absolute)
  const parts = absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)
  const output = [parsed.root]
  let current = parsed.root
  for (const part of parts) {
    current = pathApi.join(current, part)
    output.push(current)
  }
  return output
}

function safeLstat(fs, target, reason) {
  try {
    const stat = fs.lstatSync(target, { bigint: true })
    if (!stat || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' ||
        typeof stat.mode !== 'bigint' || typeof stat.nlink !== 'bigint' ||
        typeof stat.size !== 'bigint') {
      throw refused('metadata_unavailable')
    }
    return stat
  } catch (error) {
    if (error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED') throw error
    throw refused(reason)
  }
}

function fileSignature(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
}

function directorySignature(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode })
}

function sameSignature(left, right) {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}

function defaultWindowsReparseProbe(paths, { childProcess, pathApi, environment }) {
  const systemRoot = typeof environment.SystemRoot === 'string' && pathApi.win32.isAbsolute(environment.SystemRoot)
    ? environment.SystemRoot
    : 'C:\\Windows'
  const powershell = pathApi.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const budgetMs = 60_000
  const startedAt = performance.now()
  let output
  try {
    output = childProcess.execFileSync(powershell, [
      '-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', WIN32_REPARSE_PROBE,
    ], {
      input: JSON.stringify(paths),
      encoding: 'utf8',
      windowsHide: true,
      // Keep the existing startup budget; report the observed failure separately.
      timeout: budgetMs,
      maxBuffer: 16_384,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') {
      const failure = refused('reparse_probe_timed_out')
      failure.budgetMs = budgetMs
      failure.elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
      failure.message += ':elapsed_ms=' + failure.elapsedMs + ':budget_ms=' + budgetMs
      throw failure
    }
    if (error?.code === 'ENOENT') throw refused('reparse_probe_missing_executable')
    // Child output and error prose can contain paths; expose only a fixed reason.
    throw refused('reparse_probe_failed')
  }

  let bits
  try {
    bits = JSON.parse(String(output))
  } catch {
    throw refused('reparse_probe_bad_output')
  }
  if (!Array.isArray(bits) || bits.some(bit => bit !== 0 && bit !== 1) ||
      (!bits.includes(1) && bits.length !== paths.length)) {
    throw refused('reparse_probe_bad_output')
  }
  // The PowerShell probe intentionally stops at the first reparse component.
  return bits
}

function windowsProfileRoot(pathApi, value) {
  const normalized = pathApi.win32.normalize(String(value || ''))
  const match = /^([a-z]:\\users\\[^\\]+)(?:\\|$)/i.exec(normalized)
  return match ? match[1] : null
}

function defaultWindowsProfileAliases(accountRoot) {
  const trustedAlias = trustedProfileShortAliasRoot(accountRoot)
  return trustedAlias ? [accountRoot, trustedAlias] : [accountRoot]
}

function assertScratchProfileLexical(targets, accountHome, options) {
  if (options.platform !== 'win32') {
    if (targets.some(target => !containedBy(options.pathApi, accountHome, target))) {
      throw refused('scratch_outside_account')
    }
    return
  }
  const accountRoot = windowsProfileRoot(options.pathApi, accountHome)
  if (!accountRoot) throw refused('home_not_current')
  const selectedRoots = targets.map(target => windowsProfileRoot(options.pathApi, target))
  if (selectedRoots.some(root => !root)) throw refused('scratch_outside_account')
  if (selectedRoots.every(root => samePath(root, accountRoot, 'win32'))) return
  let aliases
  try {
    aliases = options.profileAliasProbe
      ? options.profileAliasProbe(accountRoot)
      : defaultWindowsProfileAliases(accountRoot, options)
  } catch (error) {
    if (error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED') throw error
    throw refused('profile_alias_probe_unavailable')
  }
  if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) {
    throw refused('profile_alias_probe_unavailable')
  }
  if (selectedRoots.some(root => !aliases.some(alias => samePath(root, alias, 'win32')))) {
    /* This decision is lexical and precedes every scratch lstat/attribute call,
       so a foreign Windows profile is never probed merely to reject it. */
    throw refused('scratch_outside_account')
  }
}

function scanPlainPath(target, finalType, options) {
  const paths = componentPaths(options.pathApi, target)
  let reparseBits = null
  if (options.platform === 'win32') {
    try {
      reparseBits = options.reparseProbe
        ? options.reparseProbe(Object.freeze([...paths]))
        : defaultWindowsReparseProbe(paths, options)
    } catch (error) {
      if (error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED') throw error
      throw refused('reparse_probe_unavailable')
    }
    if (!Array.isArray(reparseBits) || reparseBits.some(bit => bit !== 0 && bit !== 1)) {
      throw refused('reparse_probe_unavailable')
    }
    const firstReparse = reparseBits.indexOf(1)
    if (firstReparse !== -1) throw refused('source_reparse')
    if (reparseBits.length !== paths.length) throw refused('reparse_probe_unavailable')
  }

  const records = []
  for (let index = 0; index < paths.length; index += 1) {
    const stat = safeLstat(options.fs, paths[index], 'source_unavailable')
    if (stat.isSymbolicLink()) throw refused('source_reparse')
    const isFinal = index === paths.length - 1
    if (!isFinal || finalType === 'directory') {
      if (!stat.isDirectory()) throw refused('source_not_regular')
      records.push({ path: paths[index], signature: directorySignature(stat) })
      continue
    }
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > MAX_AUTH_BYTES) {
      throw refused('source_not_regular')
    }
    records.push({ path: paths[index], signature: fileSignature(stat) })
  }
  return records
}

function sameScan(left, right) {
  return left.length === right.length && left.every((record, index) =>
    record.path === right[index].path && sameSignature(record.signature, right[index].signature))
}

function nativeRealpath(fs, target) {
  try {
    return (fs.realpathSync.native || fs.realpathSync)(target)
  } catch {
    throw refused('canonicalization_failed')
  }
}

function targetExistsNoFollow(fs, target) {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw cleanupFailed()
  }
}

function bestEffortRemoveExact(fs, target) {
  try { fs.rmSync(target, { force: true }) } catch { /* caller fails closed below */ }
}

function createStage(target, guard) {
  const stage = Object.freeze({ target })
  STAGE_GUARDS.set(stage, Object.seal(guard))
  return stage
}

function assertScratchGuard(stage, fsOverride = null) {
  const guard = STAGE_GUARDS.get(stage)
  if (!guard) throw cleanupFailed()
  const options = fsOverride ? { ...guard.options, fs: fsOverride } : guard.options
  try {
    const current = scanPlainPath(guard.scratchHome, 'directory', options)
    const canonical = nativeRealpath(options.fs, guard.scratchHome)
    if (!sameScan(guard.scratchScan, current) ||
        !samePath(canonical, guard.canonicalScratch, options.platform)) {
      throw cleanupFailed()
    }
  } catch {
    /* A missing, replaced, or reparse-tagged parent is never followed to the
       child. Path-only cleanup cannot safely recover the original directory. */
    throw cleanupFailed()
  }
  return { guard, options }
}

function guardedTargetExists(stage, fsOverride = null) {
  const { guard, options } = assertScratchGuard(stage, fsOverride)
  return targetExistsNoFollow(options.fs, guard.target)
}

function guardedRemoveOnce(stage, fsOverride = null) {
  const first = assertScratchGuard(stage, fsOverride)
  if (!targetExistsNoFollow(first.options.fs, first.guard.target)) return
  /* Recheck the parent after the final-component lstat and immediately before
     unlinking. This is fail-closed race detection; Node path APIs do not offer
     a Windows directory-handle-relative unlink. */
  const second = assertScratchGuard(stage, fsOverride)
  bestEffortRemoveExact(second.options.fs, second.guard.target)
}

function exactPathIsReparse(target, options) {
  if (options.platform !== 'win32') {
    return safeLstat(options.fs, target, 'recovery_unavailable').isSymbolicLink()
  }
  let bits
  try {
    bits = options.reparseProbe
      ? options.reparseProbe(Object.freeze([target]))
      : defaultWindowsReparseProbe([target], options)
  } catch {
    throw cleanupFailed()
  }
  if (!Array.isArray(bits) || bits.length !== 1 || (bits[0] !== 0 && bits[0] !== 1)) {
    throw cleanupFailed()
  }
  return bits[0] === 1
}

function assertRecoveryGuard(stage, fsOverride = null) {
  const guard = STAGE_GUARDS.get(stage)
  if (!guard) throw cleanupFailed()
  const options = fsOverride ? { ...guard.options, fs: fsOverride } : guard.options
  try {
    const current = scanPlainPath(guard.recoveryRoot, 'directory', options)
    const canonical = nativeRealpath(options.fs, guard.recoveryRoot)
    if (!sameScan(guard.recoveryScan, current) ||
        !samePath(canonical, guard.canonicalRecoveryRoot, options.platform)) {
      throw cleanupFailed()
    }
  } catch {
    throw cleanupFailed()
  }
  return { guard, options }
}

function recoveryMatches(stage, fsOverride = null) {
  const first = assertRecoveryGuard(stage, fsOverride)
  if (!first.guard.copiedIdentity) throw cleanupFailed()
  const stack = [{ directory: first.guard.recoveryRoot, depth: 0 }]
  const matches = []
  let visited = 0
  while (stack.length) {
    const { directory, depth } = stack.pop()
    if (depth > MAX_RECOVERY_DEPTH) throw cleanupFailed()
    let entries
    try {
      scanPlainPath(directory, 'directory', first.options)
      const canonicalDirectory = nativeRealpath(first.options.fs, directory)
      if (!containedBy(first.options.pathApi, first.guard.canonicalRecoveryRoot, canonicalDirectory)) {
        throw cleanupFailed()
      }
      entries = first.options.fs.readdirSync(directory, { withFileTypes: true })
    }
    catch { throw cleanupFailed() }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_RECOVERY_ENTRIES || !entry || typeof entry.name !== 'string' ||
          !entry.name || entry.name === '.' || entry.name === '..' ||
          entry.name.includes(first.options.pathApi.sep)) {
        throw cleanupFailed()
      }
      const candidate = first.options.pathApi.join(directory, entry.name)
      if (exactPathIsReparse(candidate, first.options)) continue
      let stat
      try { stat = safeLstat(first.options.fs, candidate, 'recovery_unavailable') }
      catch { throw cleanupFailed() }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        stack.push({ directory: candidate, depth: depth + 1 })
      } else if (stat.isFile() && stat.nlink === 1n &&
                 stat.dev === first.guard.copiedIdentity.dev && stat.ino === first.guard.copiedIdentity.ino) {
        matches.push(candidate)
      }
    }
  }
  assertRecoveryGuard(stage, fsOverride)
  return matches
}

function removeRecoveredCredential(stage, fsOverride = null) {
  const found = recoveryMatches(stage, fsOverride)
  if (found.length === 0) return false
  if (found.length !== 1) throw cleanupFailed()
  const candidate = found[0]
  const first = assertRecoveryGuard(stage, fsOverride)
  try {
    const inspected = scanPlainPath(candidate, 'file', first.options)
    const signature = inspected[inspected.length - 1].signature
    if (signature.dev !== first.guard.copiedIdentity.dev ||
        signature.ino !== first.guard.copiedIdentity.ino || signature.nlink !== 1n) {
      throw cleanupFailed()
    }
  } catch {
    throw cleanupFailed()
  }
  assertRecoveryGuard(stage, fsOverride)
  bestEffortRemoveExact(first.options.fs, candidate)
  const remaining = recoveryMatches(stage, fsOverride)
  if (remaining.length !== 0) throw cleanupFailed()
  return true
}

export function stagedCodexCredentialPath(scratchCodexHome, { pathApi = nodePath } = {}) {
  if (typeof scratchCodexHome !== 'string' || !scratchCodexHome || !pathApi.isAbsolute(scratchCodexHome)) {
    throw refused('scratch_invalid')
  }
  return pathApi.join(pathApi.resolve(scratchCodexHome), 'auth.json')
}

export function prepareCurrentCodexCredentialStage(requestedHome, scratchCodexHome, overrides = {}) {
  const options = {
    fs: overrides.fs || nodeFs,
    childProcess: overrides.childProcess || nodeChildProcess,
    pathApi: overrides.pathApi || nodePath,
    platform: overrides.platform === undefined ? process.platform : overrides.platform,
    currentUserHome: overrides.currentUserHome || nodeOs.homedir(),
    environment: overrides.environment || process.env,
    reparseProbe: overrides.reparseProbe,
    profileAliasProbe: overrides.profileAliasProbe,
    afterCopy: overrides.afterCopy,
  }
  const { fs, pathApi, platform } = options
  if (typeof requestedHome !== 'string' || !requestedHome || !pathApi.isAbsolute(requestedHome) ||
      typeof options.currentUserHome !== 'string' || !pathApi.isAbsolute(options.currentUserHome)) {
    throw refused('home_not_current')
  }
  if (platform === 'win32' && (/^\\\\/.test(requestedHome) || /^\\\\/.test(options.currentUserHome))) {
    throw refused('home_not_current')
  }

  const accountHome = pathApi.resolve(options.currentUserHome)
  const expectedCodexHome = pathApi.resolve(accountHome, '.codex')
  const requested = pathApi.resolve(requestedHome)
  const scratchHome = pathApi.resolve(scratchCodexHome)
  const recoveryRoot = pathApi.resolve(overrides.recoveryRoot || pathApi.dirname(scratchHome))
  const source = pathApi.join(expectedCodexHome, 'auth.json')
  const target = stagedCodexCredentialPath(scratchHome, { pathApi })
  if (!samePath(requested, expectedCodexHome, platform) ||
      !containedBy(pathApi, accountHome, expectedCodexHome)) {
    throw refused('home_not_current')
  }
  if ((platform === 'win32' && (/^\\\\/.test(scratchHome) || /^\\\\/.test(recoveryRoot))) ||
      !containedBy(pathApi, recoveryRoot, scratchHome)) {
    throw refused('scratch_invalid')
  }

  /* The source is the only path touched before the lexical Windows-profile
     decision, and it was derived solely from the current account home. */
  const sourceBefore = scanPlainPath(source, 'file', options)
  assertScratchProfileLexical([recoveryRoot, scratchHome], accountHome, options)
  const recoveryBefore = scanPlainPath(recoveryRoot, 'directory', options)
  const scratchBefore = scanPlainPath(scratchHome, 'directory', options)
  const canonicalAccount = nativeRealpath(fs, accountHome)
  const canonicalCodex = nativeRealpath(fs, expectedCodexHome)
  const canonicalSource = nativeRealpath(fs, source)
  const canonicalRecoveryRoot = nativeRealpath(fs, recoveryRoot)
  const canonicalScratch = nativeRealpath(fs, scratchHome)
  if (!containedBy(pathApi, canonicalAccount, canonicalCodex) ||
      !containedBy(pathApi, canonicalAccount, canonicalRecoveryRoot) ||
      !containedBy(pathApi, canonicalAccount, canonicalScratch) ||
      !containedBy(pathApi, canonicalRecoveryRoot, canonicalScratch) ||
      !samePath(pathApi.dirname(canonicalCodex), canonicalAccount, platform) ||
      !samePath(pathApi.dirname(canonicalSource), canonicalCodex, platform) ||
      !samePath(pathApi.basename(canonicalSource), 'auth.json', platform)) {
    throw refused('canonicalization_failed')
  }
  const sourceStable = scanPlainPath(source, 'file', options)
  const recoveryStable = scanPlainPath(recoveryRoot, 'directory', options)
  const scratchStable = scanPlainPath(scratchHome, 'directory', options)
  if (!sameScan(sourceBefore, sourceStable) || !sameScan(recoveryBefore, recoveryStable) ||
      !sameScan(scratchBefore, scratchStable)) {
    throw refused('source_changed')
  }
  if (targetExistsNoFollow(fs, target)) throw refused('target_exists')

  return createStage(target, {
    target,
    source,
    sourceScan: sourceStable,
    scratchHome,
    scratchScan: scratchStable,
    canonicalScratch,
    recoveryRoot,
    recoveryScan: recoveryStable,
    canonicalRecoveryRoot,
    copyAttempted: false,
    copiedIdentity: null,
    options: Object.freeze({ ...options }),
  })
}

function captureCopiedIdentity(stage) {
  const checked = assertScratchGuard(stage)
  const targetAfter = scanPlainPath(checked.guard.target, 'file', checked.options)
  const signature = targetAfter[targetAfter.length - 1].signature
  checked.guard.copiedIdentity = Object.freeze({ dev: signature.dev, ino: signature.ino })
  return targetAfter
}

function cleanupStageSynchronously(stage) {
  let exactFailed = false
  try {
    if (guardedTargetExists(stage)) guardedRemoveOnce(stage)
  } catch {
    exactFailed = true
  }
  try {
    const recovered = removeRecoveredCredential(stage)
    if (exactFailed && !recovered) throw cleanupFailed()
    if (!exactFailed) {
      try {
        if (guardedTargetExists(stage)) throw cleanupFailed()
      } catch {
        /* A changed exact parent is acceptable only when identity recovery
           found and deleted the staged file under the guarded recovery root. */
        if (!STAGE_GUARDS.get(stage)?.copiedIdentity) throw cleanupFailed()
      }
    }
  } catch {
    throw cleanupFailed()
  }
}

export function copyPreparedCodexCredential(stage) {
  const guard = STAGE_GUARDS.get(stage)
  if (!guard || guard.copyAttempted) throw refused('stage_invalid')
  const { fs } = guard.options
  guard.copyAttempted = true

  try {
    fs.copyFileSync(guard.source, guard.target, fs.constants.COPYFILE_EXCL)
    const targetAfter = captureCopiedIdentity(stage)
    if (typeof guard.options.afterCopy === 'function') guard.options.afterCopy()
    const sourceAfter = scanPlainPath(guard.source, 'file', guard.options)
    if (!sameScan(guard.sourceScan, sourceAfter) ||
        targetAfter[targetAfter.length - 1].signature.size !== guard.sourceScan[guard.sourceScan.length - 1].signature.size) {
      throw refused('source_changed')
    }
  } catch (error) {
    if (!guard.copiedIdentity) {
      try { captureCopiedIdentity(stage) } catch { /* recovery below fails closed if a partial copy cannot be identified */ }
    }
    try { cleanupStageSynchronously(stage) } catch { throw cleanupFailed() }
    if (error?.code === 'A11Y_CODEX_AUTH_STAGE_REFUSED') throw error
    throw refused('copy_failed')
  }
  return stage
}

export function seedCurrentCodexCredential(requestedHome, scratchCodexHome, overrides = {}) {
  const stage = prepareCurrentCodexCredentialStage(requestedHome, scratchCodexHome, overrides)
  return copyPreparedCodexCredential(stage)
}

export async function removeStagedCodexCredential(stage, {
  fs = null,
  attempts = 5,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!stage || typeof stage !== 'object') throw cleanupFailed()
  let exactParentFailed = false
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (guardedTargetExists(stage, fs)) guardedRemoveOnce(stage, fs)
      if (!guardedTargetExists(stage, fs)) break
    } catch {
      exactParentFailed = true
      break
    }
    await pause(100)
  }
  try {
    const recovered = removeRecoveredCredential(stage, fs)
    if (exactParentFailed && !recovered) throw cleanupFailed()
    const leftovers = recoveryMatches(stage, fs)
    if (leftovers.length !== 0) throw cleanupFailed()
    if (!exactParentFailed) {
      try { if (guardedTargetExists(stage, fs)) throw cleanupFailed() }
      catch { throw cleanupFailed() }
    }
  } catch {
    throw cleanupFailed()
  }
}
