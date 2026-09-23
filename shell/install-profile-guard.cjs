'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const CODE = 'PACKAGED_INSTALL_PROFILE_MISMATCH'
const DEV_USER_DATA_CODE = 'DEV_USER_DATA_OUTSIDE_ACCOUNT_FENCE'
const DEV_RUNTIME_PROFILE_CODE = 'DEV_RUNTIME_PROFILE_MISMATCH'
const ACCOUNT_ENVIRONMENT_CODE = 'ACCOUNT_ENVIRONMENT_OUTSIDE_PROFILE_FENCE'
const ELEVATED_RUNTIME_CODE = 'ELEVATED_APP_RUNTIME'
/* The durable-prefs key under which "Do not warn me again" is remembered for
   the administrator warning; same store and shape as the close warning. */
const ELEVATED_WARNING_KEY = 'mc.warn.elevated-run'
const INTEGRITY_UNAVAILABLE_CODE = 'WINDOWS_RUNTIME_INTEGRITY_UNAVAILABLE'
const PER_USER_MARKER = `${path.win32.sep}AppData${path.win32.sep}Local${path.win32.sep}Programs${path.win32.sep}`.toLowerCase()
const STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES = Object.freeze([
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
])
const PROVIDER_HOME_ENVIRONMENT_NAMES = Object.freeze([
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_DIR',
])
const NODE_LOADER_ENVIRONMENT_NAMES = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
])

function usesUnsupportedWindowsPathNamespace(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  let selected = value.trim()
  if (selected.length >= 2 && selected.startsWith('"') && selected.endsWith('"')) {
    selected = selected.slice(1, -1).trim()
  }
  selected = selected.replace(/\//g, '\\')
  /* A generic UNC share has no trustworthy lexical relationship to the
     selected profile. It may be a second spelling of another account, and
     discovering what it serves would itself require touching the path. Refuse
     every caller-supplied UNC form before lstat/readlink. The one device path
     this module intentionally executes is the hard-coded GLOBALROOT cmd.exe in
     resolveWindowsShortPath(); it is never accepted from one of these inputs. */
  return /^\\\\/.test(selected)
    || /^\\\\\?\?\\/.test(selected)
    || /^\\\?\?\\/.test(selected)
    || /^\\(?:device|globalroot|global\?\?|dosdevices|systemroot)(?:\\|$)/i.test(selected)
}

function cleanWindowsPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let selected = value.trim()
  if (selected.length >= 2 && selected.startsWith('"') && selected.endsWith('"')) {
    selected = selected.slice(1, -1).trim()
  }
  if (!selected) return null
  if (usesUnsupportedWindowsPathNamespace(selected)) return null
  const normalized = path.win32.normalize(selected)
  return normalized.replace(/[\\/]+$/, '')
}

function profileRootFromInstallPath(execPath) {
  /* process.execPath is identity evidence, not permission to walk a reparse
     target. Derive the owner from the lexical per-user install layout; an 8.3
     or otherwise ambiguous spelling safely falls outside this classification. */
  const executable = cleanWindowsPath(execPath)
  if (!executable) return null
  const folded = executable.toLowerCase()
  const markerAt = folded.indexOf(PER_USER_MARKER)
  if (markerAt <= 2) return null
  return executable.slice(0, markerAt)
}

/* A runtime below the ordinary Windows profile tree selects that profile
 * without embedding the account name in shipped source. This is the fallback
 * for development/staged copies; a per-user packaged install has the stronger
 * AppData/Local/Programs derivation above. */
function profileRootFromWindowsUserPath(value) {
  const selected = cleanWindowsPath(value)
  if (!selected) return null
  const match = /^([a-z]:\\Users\\[^\\]+)(?:\\|$)/i.exec(selected)
  return match ? match[1] : null
}

/* Windows does not require profiles to live below <drive>:\Users. Corporate
 * images commonly redirect ProfilesDirectory to a different drive or parent,
 * and a staged build inside that profile is still owned by the token whose
 * known-folder path Electron returned. Use that already-known current profile
 * as a lexical anchor; no runtime path is opened or resolved here.
 *
 * A path below a different first child of the same non-root parent is retained
 * as a distinct profile candidate. That is the refusal half of this rule: a
 * mixed D:\Profiles\Alice source plus D:\Profiles\Bob executable must not look
 * account-neutral merely because neither path contains the literal `\Users`.
 * When the profile itself is directly below a drive root, do not classify all
 * other top-level directories as accounts. An unbound shipped runtime still
 * fails separately when requireBoundProfile is true. */
function profileRootFromRuntimePath(value, currentProfilePath = null) {
  const selected = cleanWindowsPath(value)
  if (!selected) return null
  const conventional = profileRootFromWindowsUserPath(selected)
  if (conventional) return conventional

  const current = cleanWindowsPath(currentProfilePath)
  if (!current || !path.win32.isAbsolute(current)) return null
  if (insideWindowsPath(selected, current)) return current

  const parent = cleanWindowsPath(path.win32.dirname(current))
  const parentRoot = parent ? cleanWindowsPath(path.win32.parse(parent).root) : null
  if (!parent || !parentRoot || sameWindowsPath(parent, parentRoot)
      || !insideWindowsPath(selected, parent)) return null
  const relative = path.win32.relative(parent, selected)
  const first = relative.split(/[\\/]+/).filter(Boolean)[0]
  if (!first || first === '..') return null
  return cleanWindowsPath(path.win32.join(parent, first))
}

/* A checkout or staged Electron runtime below a Windows profile is owned by
 * that profile just as surely as a per-user install is. app.isPackaged cannot
 * be the whole account boundary: launching another account's checkout under a
 * different token otherwise selects the caller's APPDATA and creates the
 * misleading second tree the fence exists to prevent.
 *
 * This check is deliberately lexical. A mismatched profile is refusal input,
 * never a filesystem target to stat, resolve or enumerate. */
function checkRuntimeProfileOwner({
  platform = process.platform,
  runtimePaths = [process.execPath],
  currentProfilePath,
  requireBoundProfile = false,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ ok: true, reason: 'non-windows', runtimeProfile: null })
  const paths = Array.isArray(runtimePaths) ? runtimePaths : []
  if (paths.some(usesUnsupportedWindowsPathNamespace)
      || usesUnsupportedWindowsPathNamespace(currentProfilePath)) {
    return Object.freeze({
      ok: false,
      code: DEV_RUNTIME_PROFILE_CODE,
      runtimeProfile: null,
      currentProfile: null,
      message: 'This fenced ToolsEnabled copy refused an unsupported Windows device or UNC runtime identity before startup.',
    })
  }
  const currentProfile = cleanWindowsPath(currentProfilePath)
  const runtimeProfiles = paths
    .map(candidate => profileRootFromRuntimePath(candidate, currentProfile))
    .filter(Boolean)
  const runtimeProfile = runtimeProfiles[0] || null
  const conflictingRuntimeProfile = runtimeProfiles.find((candidate) => !sameWindowsPath(candidate, runtimeProfile))
  if (conflictingRuntimeProfile) {
    return Object.freeze({
      ok: false,
      code: DEV_RUNTIME_PROFILE_CODE,
      runtimeProfile,
      currentProfile,
      message: 'This ToolsEnabled runtime refused components owned by more than one Windows account before any profile or agent state was opened.',
    })
  }
  if (!runtimeProfile) {
    if (requireBoundProfile) {
      return Object.freeze({
        ok: false,
        code: DEV_RUNTIME_PROFILE_CODE,
        runtimeProfile: null,
        currentProfile,
        message: [
          'This ToolsEnabled runtime is not inside the Windows account that owns this copy.',
          '',
          'Launch the installed copy from that account, or run the development checkout from inside that account\'s profile.',
          'A copied portable runtime is not an installed ToolsEnabled identity.',
        ].join('\n'),
      })
    }
    return Object.freeze({ ok: true, reason: 'runtime-outside-profile', runtimeProfile: null })
  }
  if (currentProfile && sameWindowsPath(runtimeProfile, currentProfile)) {
    return Object.freeze({ ok: true, reason: 'same-runtime-profile', runtimeProfile, currentProfile })
  }
  return Object.freeze({
    ok: false,
    code: DEV_RUNTIME_PROFILE_CODE,
    runtimeProfile,
    currentProfile,
    message: currentProfile
      ? refusalMessage({ installProfile: runtimeProfile, currentProfile })
      : [
          `This ToolsEnabled runtime belongs to the Windows account "${profileName(runtimeProfile)}", but Windows did not identify the account running it.`,
          '',
          `Close this copy and launch it normally while signed in as "${profileName(runtimeProfile)}".`,
          'Do not run another account\'s checkout or staged copy as Administrator.',
        ].join('\n'),
  })
}

/* The profile name does not distinguish a normal token from "Run as
 * administrator" under the SAME Windows account. Both app.getPath('home') and
 * every profile environment variable still name the owner, while the elevated
 * process can observe a different mapped-drive, credential, child-process and
 * policy world. That is a second runtime identity even though its pathname is
 * identical.
 *
 * Ask the kernel-owned whoami.exe for the token's mandatory integrity SID. SID
 * values are stable and language-neutral; group display names are not. High
 * (12288) and above are MEASURED, not refused: this used to end the launch,
 * and the owner struck that on 2026-09-02 -- "the whole point of this software
 * is the user decides and we give them the choice ... we can warn them, and a
 * check box not to warn again". So the answer carries `elevated` (true,
 * false, or null when the probe could not say) and the words of a warning;
 * main shows the warning once, with the checkbox, and starts either way.
 * Individual privileged operations still use the narrow elevated-helper path
 * and never need this process to carry a high-integrity token. */
function checkWindowsRuntimeIntegrity({
  platform = process.platform,
  spawnSync = null,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ ok: true, reason: 'non-windows' })
  const run = spawnSync || require('node:child_process').spawnSync
  const executable = String.raw`\\.\GLOBALROOT\SystemRoot\System32\whoami.exe`
  let result
  try {
    result = run(executable, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    result = null
  }
  const stdout = result && result.status === 0 && typeof result.stdout === 'string'
    ? result.stdout
    : ''
  const integrityLevels = [...stdout.matchAll(/S-1-16-(\d+)/ig)]
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger)
  if (integrityLevels.length === 0) {
    /* Not proof of an ordinary token, and not grounds for a warning either:
       nothing is known, so nothing is said to the person. Logged by main. */
    return Object.freeze({
      ok: true,
      elevated: null,
      code: INTEGRITY_UNAVAILABLE_CODE,
      message: 'ToolsEnabled could not tell whether this process has administrator rights, so it did not warn either way.',
    })
  }
  if (integrityLevels.some((level) => level >= 12288)) {
    return Object.freeze({
      ok: true,
      elevated: true,
      code: ELEVATED_RUNTIME_CODE,
      message: 'ToolsEnabled is running with administrator rights.',
    })
  }
  return Object.freeze({ ok: true, elevated: false, reason: 'ordinary-windows-token' })
}

/* THE WARNING THAT REPLACED A REFUSAL. The words a person reads when the app
 * runs with administrator rights, or null when it does not (or when nothing
 * could be measured). Pure, so the sentence is a value a test can hold: one
 * fact, one consequence, one way out, and the checkbox that says "I know". */
function elevatedRunWarning(check) {
  if (!check || check.elevated !== true) return null
  return Object.freeze({
    title: 'Running as administrator',
    message: 'ToolsEnabled is running with administrator rights.',
    detail: 'Everything it starts, including agents, has those rights too. If you did not mean to, close it and open it normally.',
    checkboxLabel: 'Do not warn me again',
  })
}

function profileRootFromEnvironment(env = process.env, homedir = os.homedir) {
  /* These values identify the account whose token owns this process. Keep the
     comparison lexical: resolving an untrusted current-account path before we
     know it matches the installed owner would itself probe the foreign profile
     that this guard exists to avoid. Windows' known-folder/environment answers
     are already absolute account declarations; aliases safely refuse as a
     mismatch instead of being followed. */
  const declared = cleanWindowsPath(env && env.USERPROFILE)
  if (declared) return declared

  const localAppData = cleanWindowsPath(env && env.LOCALAPPDATA)
  if (localAppData) {
    const suffix = `${path.win32.sep}AppData${path.win32.sep}Local`.toLowerCase()
    if (localAppData.toLowerCase().endsWith(suffix)) {
      return localAppData.slice(0, -suffix.length)
    }
  }

  try { return cleanWindowsPath(homedir()) }
  catch { return null }
}

function sameWindowsPath(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

function insideWindowsPath(candidate, root) {
  const selected = cleanWindowsPath(candidate)
  const boundary = cleanWindowsPath(root)
  if (!selected || !boundary) return false
  const folded = selected.toLowerCase()
  const foldedBoundary = boundary.toLowerCase()
  return folded === foldedBoundary || folded.startsWith(`${foldedBoundary}${path.win32.sep}`)
}

/* Resolve reparse points one existing ancestor at a time. `realpath()` on the
 * whole path cannot resolve a missing leaf, which is exactly how a userData
 * directory is normally supplied on first launch. Walking from the drive root
 * also lets us stop as soon as a link names somewhere outside the fence: its
 * target text is enough to refuse, so no directory in another profile needs to
 * be opened or enumerated.
 *
 * The filesystem calls are injectable because a hard account boundary must be
 * tested with an invented junction, never by probing another Windows profile. */
function canonicalWindowsPathThroughExistingAncestors(value, {
  lstatSync = fs.lstatSync,
  readlinkSync = fs.readlinkSync,
  stopOutsideRoot = null,
  stopAtTarget = null,
} = {}) {
  const cleaned = cleanWindowsPath(value)
  if (!cleaned || !path.win32.isAbsolute(cleaned)) return cleaned
  const initial = path.win32.parse(cleaned)
  let pieces = cleaned.slice(initial.root.length).split(/[\\/]+/).filter(Boolean)
  let resolved = initial.root
  const seenLinks = new Set()

  while (pieces.length > 0) {
    const component = pieces.shift()
    const candidate = cleanWindowsPath(path.win32.join(resolved, component))
    let stat
    try {
      stat = lstatSync(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null
      return cleanWindowsPath(path.win32.join(candidate, ...pieces))
    }
    if (!stat || typeof stat.isSymbolicLink !== 'function' || !stat.isSymbolicLink()) {
      resolved = candidate
      continue
    }

    const linkKey = candidate.toLowerCase()
    if (seenLinks.has(linkKey) || seenLinks.size >= 32) return null
    seenLinks.add(linkKey)
    let target
    try { target = readlinkSync(candidate) } catch { return null }
    if (typeof target !== 'string' || target.trim() === '') return null
    const linkTarget = cleanWindowsPath(path.win32.isAbsolute(target)
      ? target
      : path.win32.resolve(path.win32.dirname(candidate), target))
    if (!linkTarget) return null
    if (stopOutsideRoot && !insideWindowsPath(linkTarget, stopOutsideRoot)) {
      return cleanWindowsPath(path.win32.join(linkTarget, ...pieces))
    }
    if (typeof stopAtTarget === 'function' && stopAtTarget(linkTarget)) {
      return cleanWindowsPath(path.win32.join(linkTarget, ...pieces))
    }
    /* The link may itself target a path containing another reparse ancestor.
       Put every target component back through lstat rather than treating the
       link's textual destination as canonical. */
    const targetParts = path.win32.parse(linkTarget)
    pieces = [
      ...linkTarget.slice(targetParts.root.length).split(/[\\/]+/).filter(Boolean),
      ...pieces,
    ]
    resolved = targetParts.root
  }
  return cleanWindowsPath(resolved)
}

function explicitUserDataDirectories(argv = process.argv) {
  const values = []
  const args = Array.isArray(argv) ? argv : []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (typeof argument !== 'string') continue
    const inline = /^--user-data-dir=(.*)$/i.exec(argument)
    if (inline) {
      values.push(inline[1])
      continue
    }
    if (/^--user-data-dir$/i.test(argument)) {
      const next = args[index + 1]
      values.push(typeof next === 'string' && !next.startsWith('--') ? next : '')
      index += 1
    }
  }
  return values
}

function deleteEnvironmentNames(environment, names) {
  const selected = new Set(names.map(name => name.toUpperCase()))
  for (const name of Object.keys(environment || {})) {
    if (selected.has(name.toUpperCase())) delete environment[name]
  }
  return environment
}

function electronNodeHandoffEnvironment(environment) {
  const selected = { ...(environment || {}), ELECTRON_RUN_AS_NODE: '1' }
  deleteEnvironmentNames(selected, NODE_LOADER_ENVIRONMENT_NAMES)
  return selected
}

function windowsProfileReferences(value, fence = null) {
  if (typeof value !== 'string' || value.length === 0) return []
  const selected = value.replace(/\//g, '\\')
  const references = []
  const remember = candidate => {
    const normalized = cleanWindowsPath(candidate?.replace(/^([a-z])\$/i, '$1:'))
    if (normalized && !references.some(value => value.toLowerCase() === normalized.toLowerCase())) references.push(normalized)
  }
  /* A profile directory is one complete path component. Spaces and apostrophes
     are valid in that component; only a path separator or compound-value
     delimiter ends it. */
  for (const match of selected.matchAll(/(?:[a-z]:|[a-z]\$)\\Users\\[^\\;"]+/ig)) {
    remember(match[0].trimEnd())
  }

  /* Windows may place profiles below a custom ProfilesDirectory. Once the
     selected profile is known, siblings below that same parent are profile
     references too. Do not apply this rule when the profile is directly below
     a drive root, where every ordinary directory would otherwise look like an
     account. */
  const boundary = cleanWindowsPath(fence)
  const parent = boundary ? cleanWindowsPath(path.win32.dirname(boundary)) : null
  const parentRoot = parent ? cleanWindowsPath(path.win32.parse(parent).root) : null
  if (parent && parentRoot && !sameWindowsPath(parent, parentRoot)) {
    const escapedParent = parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escapedParent}\\\\[^\\\\;"]+`, 'ig')
    for (const match of selected.matchAll(pattern)) remember(match[0].trimEnd())
  }
  return references
}

function foreignWindowsProfileReferences(value, fence) {
  return windowsProfileReferences(value, fence).filter(reference => !sameWindowsPath(reference, fence))
}

/* Ask the running Windows kernel for its own cmd.exe through the global
 * SystemRoot device route. This path trusts neither inherited environment nor
 * the runtime's possibly portable volume. The command receives only the
 * already-authorized long profile through a dedicated environment value; no
 * candidate alias is opened, resolved or enumerated. */
function resolveWindowsShortPath(value, {
  platform = process.platform,
  spawnSync = null,
} = {}) {
  const selected = cleanWindowsPath(value)
  if (platform !== 'win32' || !selected || !path.win32.isAbsolute(selected)) return null
  const run = spawnSync || require('node:child_process').spawnSync
  const executable = String.raw`\\.\GLOBALROOT\SystemRoot\System32\cmd.exe`
  const variable = 'TOOLSENABLED_TRUSTED_LONG_PROFILE'
  let result
  try {
    result = run(executable, [
      '/d', '/s', '/v:off', '/e:on', '/c', `for %I in ("%${variable}%") do @echo("%~sI"`,
    ], {
      env: { [variable]: selected },
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { return null }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return null
  const firstLine = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return cleanWindowsPath(firstLine)
}

/* Turn a resolver answer into the ONE short profile root normalization may
 * trust. The resolver is called only with the authorized long profile. An
 * unchanged result means 8.3 naming is unavailable; an unexpected parent or
 * a non-alias basename is refused rather than guessed. */
function trustedProfileShortAliasRoot(fencedProfile, {
  platform = process.platform,
  resolveShortPath = value => resolveWindowsShortPath(value, { platform }),
} = {}) {
  const boundary = cleanWindowsPath(fencedProfile)
  if (platform !== 'win32' || !boundary || !path.win32.isAbsolute(boundary)) return null
  let resolved
  try { resolved = cleanWindowsPath(resolveShortPath(boundary)) } catch { return null }
  if (!resolved || sameWindowsPath(resolved, boundary)) return null
  if (!sameWindowsPath(path.win32.dirname(resolved), path.win32.dirname(boundary))) return null
  const aliasName = path.win32.basename(resolved)
  if (aliasName.length > 8 || !/^[a-z0-9_$%'-]{1,6}~[1-9][0-9]*$/i.test(aliasName)) return null
  return resolved
}

function profileTempShortAliasSuffix(value, trustedAliasRoot) {
  const selected = cleanWindowsPath(value)
  const aliasRoot = cleanWindowsPath(trustedAliasRoot)
  if (!selected || !aliasRoot || !path.win32.isAbsolute(selected) || !insideWindowsPath(selected, aliasRoot)) return null
  const relative = path.win32.relative(aliasRoot, selected)
  if (!relative || path.win32.isAbsolute(relative) || relative.startsWith(`..${path.win32.sep}`) || relative === '..') return null
  const pieces = relative.split(/[\\/]+/)
  if (pieces.length < 3) return null
  const [appData, local, temp] = pieces
  if (appData.toLowerCase() !== 'appdata'
      || local.toLowerCase() !== 'local'
      || temp.toLowerCase() !== 'temp') return null
  return pieces.slice(3)
}

function normalizeProfileTempShortAlias(value, fence, {
  trustedAliasRoot = null,
  safeTempRoot = null,
  allowDescendants = true,
} = {}) {
  const selected = cleanWindowsPath(value)
  const boundary = cleanWindowsPath(fence)
  if (!selected || !boundary) return selected
  const suffix = profileTempShortAliasSuffix(selected, trustedAliasRoot)
  if (!suffix || (!allowDescendants && suffix.length > 0)) return selected
  const trustedRoot = cleanWindowsPath(safeTempRoot)
    || path.win32.join(boundary, 'AppData', 'Local', 'Temp')
  return cleanWindowsPath(path.win32.join(trustedRoot, ...suffix))
}

function escapedFencedPath(value, fence, filesystem, {
  allowSystemPath = false,
  cwd = process.cwd(),
} = {}) {
  let lexical = cleanWindowsPath(value)
  if (!lexical) return true
  if (!path.win32.isAbsolute(lexical)) {
    if (!allowSystemPath) return true
    const base = cleanWindowsPath(cwd)
    if (!base || !path.win32.isAbsolute(base)) return true
    lexical = cleanWindowsPath(path.win32.resolve(base, lexical))
  }
  if (!insideWindowsPath(lexical, fence)) {
    if (!allowSystemPath) return true
    if (foreignWindowsProfileReferences(lexical, fence).length > 0) return true
    const canonical = canonicalWindowsPathThroughExistingAncestors(lexical, {
      ...(filesystem || {}),
      /* Inspect ordinary system/external link chains, but stop on the textual
         target before a foreign profile is opened or enumerated. */
      stopAtTarget: target => foreignWindowsProfileReferences(target, fence).length > 0,
    })
    return !canonical || foreignWindowsProfileReferences(canonical, fence).length > 0
  }
  const canonical = canonicalWindowsPathThroughExistingAncestors(lexical, {
    ...(filesystem || {}),
    stopOutsideRoot: fence,
  })
  return !insideWindowsPath(canonical, fence)
}

/* Build the environment the interactive shell and the compatibility Node
 * handoff may inherit. Provider homes are account selectors, not ambient
 * launch facts, so they are removed and may only be reapplied later from a
 * validated account record. Windows profile roots must stay inside the
 * selected profile. Node loader controls are removed too: a packaged build
 * disables NODE_OPTIONS in the executable itself, before JavaScript can run,
 * and this second boundary prevents either loader variable from reaching a
 * supervised Node child or a development handoff after startup. PATH and TEMP
 * keep legitimate system locations, but any entry naming a different Windows
 * profile is refused without opening it. */
function fencedAccountEnvironment({
  platform = process.platform,
  environment = process.env,
  fencedProfile,
  trustedProfileAliasRoot = null,
  filesystem = undefined,
  cwd = process.cwd(),
} = {}) {
  const selected = { ...(environment || {}) }
  deleteEnvironmentNames(selected, PROVIDER_HOME_ENVIRONMENT_NAMES)
  deleteEnvironmentNames(selected, NODE_LOADER_ENVIRONMENT_NAMES)
  deleteEnvironmentNames(selected, ['PUBLIC'])
  if (platform !== 'win32') return Object.freeze({ ok: true, environment: selected, reason: 'non-windows' })
  const valueFor = wanted => {
    const found = Object.keys(selected).find(name => name.toUpperCase() === wanted)
    return found ? selected[found] : null
  }
  const replaceValue = (wanted, value) => {
    for (const existing of Object.keys(selected)) {
      if (existing.toUpperCase() === wanted) delete selected[existing]
    }
    selected[wanted] = value
  }

  const unsupportedGuardInputs = []
  if (usesUnsupportedWindowsPathNamespace(fencedProfile)) unsupportedGuardInputs.push('PROFILE_FENCE')
  if (usesUnsupportedWindowsPathNamespace(trustedProfileAliasRoot)) unsupportedGuardInputs.push('PROFILE_ALIAS')
  if (usesUnsupportedWindowsPathNamespace(cwd)) unsupportedGuardInputs.push('CWD')
  if (unsupportedGuardInputs.length > 0) {
    return Object.freeze({
      ok: false,
      code: ACCOUNT_ENVIRONMENT_CODE,
      variables: Object.freeze(unsupportedGuardInputs),
      fencedProfile: null,
      message: `This copy of ToolsEnabled refused unsupported Windows device or UNC guard paths. Variables: ${unsupportedGuardInputs.join(', ')}`,
    })
  }

  const unsupportedEnvironmentPaths = []
  for (const name of [...STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES, 'TEMP', 'TMP']) {
    if (usesUnsupportedWindowsPathNamespace(valueFor(name))) unsupportedEnvironmentPaths.push(name)
  }
  const inheritedPathForNamespaceCheck = valueFor('PATH')
  if (typeof inheritedPathForNamespaceCheck === 'string'
      && inheritedPathForNamespaceCheck.split(path.win32.delimiter).some(usesUnsupportedWindowsPathNamespace)) {
    unsupportedEnvironmentPaths.push('PATH')
  }
  if (usesUnsupportedWindowsPathNamespace(valueFor('HOMEDRIVE'))
      || usesUnsupportedWindowsPathNamespace(valueFor('HOMEPATH'))) {
    unsupportedEnvironmentPaths.push('HOMEDRIVE/HOMEPATH')
  }
  if (unsupportedEnvironmentPaths.length > 0) {
    return Object.freeze({
      ok: false,
      code: ACCOUNT_ENVIRONMENT_CODE,
      variables: Object.freeze([...new Set(unsupportedEnvironmentPaths)].sort()),
      fencedProfile: cleanWindowsPath(fencedProfile),
      message: `This copy of ToolsEnabled refused unsupported Windows device or UNC environment paths. Variables: ${[...new Set(unsupportedEnvironmentPaths)].sort().join(', ')}`,
    })
  }

  const fence = cleanWindowsPath(fencedProfile)
  if (!fence) return Object.freeze({ ok: true, environment: selected, reason: 'no-profile-fence' })
  const violations = []

  /* A sterile Dev launch can place its entire scratch account below Windows'
     exact short spelling of this account's real Temp directory. These names
     are already declared to be paths, so rewrite only them -- and each
     independent PATH entry -- from that explicitly derived alias root to the
     trusted long fence. Arbitrary compound variables are not rewritten. */
  for (const name of [...STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES, 'TEMP', 'TMP']) {
    const value = valueFor(name)
    if (!profileTempShortAliasSuffix(value, trustedProfileAliasRoot)) continue
    replaceValue(name, normalizeProfileTempShortAlias(value, fence, { trustedAliasRoot: trustedProfileAliasRoot }))
  }
  const inheritedPath = valueFor('PATH')
  if (typeof inheritedPath === 'string' && inheritedPath) {
    let changed = false
    const entries = inheritedPath.split(path.win32.delimiter).map(entry => {
      if (!profileTempShortAliasSuffix(entry, trustedProfileAliasRoot)) return entry
      changed = true
      return normalizeProfileTempShortAlias(entry, fence, { trustedAliasRoot: trustedProfileAliasRoot })
    })
    if (changed) replaceValue('PATH', entries.join(path.win32.delimiter))
  }

  for (const name of STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES) {
    const value = valueFor(name)
    if (typeof value === 'string' && value.trim() && escapedFencedPath(value, fence, filesystem)) violations.push(name)
  }
  const homeDrive = valueFor('HOMEDRIVE')
  const homePath = valueFor('HOMEPATH')
  if (typeof homeDrive === 'string' && homeDrive && typeof homePath === 'string' && homePath) {
    if (escapedFencedPath(path.win32.join(homeDrive, homePath), fence, filesystem)) {
      violations.push('HOMEDRIVE/HOMEPATH')
    }
  }

  for (const name of ['PATH', 'TEMP', 'TMP']) {
    const value = valueFor(name)
    if (typeof value !== 'string' || !value) continue
    const entries = name === 'PATH' ? value.split(path.win32.delimiter) : [value]
    if (entries.some(entry => entry.trim() && escapedFencedPath(entry.trim(), fence, filesystem, {
      allowSystemPath: true,
      cwd,
    }))) violations.push(name)
  }

  /* Catch account paths embedded in compound variables which are not themselves
     named like paths. This is lexical and never probes the referenced profile. */
  for (const [name, value] of Object.entries(selected)) {
    if (typeof value !== 'string' || violations.includes(name.toUpperCase())) continue
    if (foreignWindowsProfileReferences(value, fence).length > 0) {
      violations.push(name.toUpperCase())
    }
  }

  if (violations.length > 0) {
    return Object.freeze({
      ok: false,
      code: ACCOUNT_ENVIRONMENT_CODE,
      variables: Object.freeze([...new Set(violations)].sort()),
      fencedProfile: fence,
      message: `This copy of ToolsEnabled refused inherited account paths outside the selected Windows profile. Variables: ${[...new Set(violations)].sort().join(', ')}`,
    })
  }
  return Object.freeze({ ok: true, environment: selected, fencedProfile: fence, reason: 'inside-profile-fence' })
}

/* Electron's --user-data-dir bypasses APPDATA and therefore bypasses every
 * ordinary account-home redirect. A runtime below a Windows user profile is
 * fenced to the profile selected by its installed/runtime path before startup
 * storage is adopted or written. */
function checkFencedDevUserDataDirectory({
  platform = process.platform,
  argv = process.argv,
  commandLineUserDataPath = null,
  cwd = process.cwd(),
  userDataPath,
  runtimePaths = [process.execPath],
  fencedProfile = null,
  trustedProfileAliasRoot = null,
  filesystem = undefined,
} = {}) {
  if (platform !== 'win32') return Object.freeze({ ok: true, reason: 'non-windows' })
  const declared = explicitUserDataDirectories(argv)
  if (commandLineUserDataPath !== null && commandLineUserDataPath !== undefined) {
    declared.push(typeof commandLineUserDataPath === 'string' ? commandLineUserDataPath : '')
  }
  const unsupportedPath = [
    fencedProfile,
    trustedProfileAliasRoot,
    cwd,
    userDataPath,
    ...(Array.isArray(runtimePaths) ? runtimePaths : []),
    ...declared,
  ].find(usesUnsupportedWindowsPathNamespace)
  if (unsupportedPath) {
    return Object.freeze({
      ok: false,
      code: DEV_USER_DATA_CODE,
      userDataPath: '(unsupported Windows path namespace)',
      fencedProfile: cleanWindowsPath(fencedProfile),
      message: 'This fenced ToolsEnabled copy refused an unsupported Windows device or UNC path before startup.',
    })
  }
  const declaredFence = cleanWindowsPath(fencedProfile)
  const fence = declaredFence
    || (Array.isArray(runtimePaths)
      ? runtimePaths.map(profileRootFromWindowsUserPath).find(Boolean) || null
      : null)
  if (!fence) return Object.freeze({ ok: true, reason: 'not-fenced-dev-runtime' })
  const normalizeTempAlias = value => normalizeProfileTempShortAlias(value, fence, {
    trustedAliasRoot: trustedProfileAliasRoot,
  })
  const normalizedRuntimePaths = Array.isArray(runtimePaths)
    ? runtimePaths.map(normalizeTempAlias)
    : []
  const normalizedCwd = normalizeTempAlias(cwd)
  const runtimeInsideFence = normalizedRuntimePaths.some(runtimePath => insideWindowsPath(runtimePath, fence))
  const strictInsideFence = runtimeInsideFence

  const canonicalInsideFence = value => {
    const lexical = cleanWindowsPath(value)
    if (!insideWindowsPath(lexical, fence)) return lexical
    return canonicalWindowsPathThroughExistingAncestors(lexical, {
      ...(filesystem || {}),
      stopOutsideRoot: fence,
    })
  }
  const canonicalPortablePath = value => {
    const lexical = cleanWindowsPath(value)
    if (!lexical || !path.win32.isAbsolute(lexical)) return lexical
    if (foreignWindowsProfileReferences(lexical, fence).length > 0) return lexical
    return canonicalWindowsPathThroughExistingAncestors(lexical, {
      ...(filesystem || {}),
      stopAtTarget: target => foreignWindowsProfileReferences(target, fence).length > 0,
    })
  }
  const resolved = declared.map(value => {
    if (typeof value !== 'string' || value.trim() === '') return null
    const cleaned = normalizeTempAlias(value)
    if (!cleaned) return null
    const candidate = path.win32.isAbsolute(cleaned)
      ? cleaned
      : path.win32.resolve(normalizedCwd, cleaned)
    const normalizedCandidate = normalizeTempAlias(candidate)
    return strictInsideFence ? canonicalInsideFence(normalizedCandidate) : canonicalPortablePath(normalizedCandidate)
  })
  const normalizedUserDataPath = normalizeTempAlias(userDataPath)
  const selected = strictInsideFence
    ? canonicalInsideFence(normalizedUserDataPath)
    : canonicalPortablePath(normalizedUserDataPath)
  const invalidPortablePath = value => !value || foreignWindowsProfileReferences(value, fence).length > 0
  const escapedIndex = strictInsideFence
    ? resolved.findIndex(value => !insideWindowsPath(value, fence))
    : resolved.findIndex(invalidPortablePath)
  const selectedIsValid = strictInsideFence ? insideWindowsPath(selected, fence) : !invalidPortablePath(selected)
  if (escapedIndex === -1 && selectedIsValid) {
    return Object.freeze({
      ok: true,
      reason: strictInsideFence
        ? (declared.length === 0 ? 'default-inside-fenced-dev-profile' : 'inside-fenced-dev-profile')
        : 'portable-or-system-user-data',
      userDataPath: selected,
      fencedProfile: fence,
    })
  }

  const target = escapedIndex >= 0 ? (resolved[escapedIndex] || '(missing path)') : (selected || '(missing path)')
  const source = declared.length > 0 ? '--user-data-dir' : 'the resolved userData directory'
  return Object.freeze({
    ok: false,
    code: DEV_USER_DATA_CODE,
    userDataPath: target,
    fencedProfile: fence,
    message: `This fenced ToolsEnabled development copy refused ${source} outside ${fence}. Requested: ${target}`,
  })
}

function profileName(root) {
  return root ? path.win32.basename(root) : 'another Windows account'
}

function refusalMessage({ installProfile, currentProfile }) {
  const owner = profileName(installProfile)
  const current = profileName(currentProfile)
  return [
    `This copy of ToolsEnabled is installed for the Windows account "${owner}", but it is running as "${current}".`,
    '',
    `Close this copy and launch ToolsEnabled normally while signed in as "${owner}".`,
    'Do not run the whole ToolsEnabled app as Administrator or under another Windows account.',
    'If an individual operation needs administrator approval, approve only that specific helper prompt.'
  ].join('\n')
}

/**
 * A per-user packaged application must execute as the profile that owns its
 * install. Running another profile's executable under an administrator account
 * changes APPDATA, LOCALAPPDATA, DPAPI, CLI sign-ins and every account-scoped
 * path while leaving the bytes under the original profile. That mixed identity
 * is refused before Electron resolves userData or writes startup state.
 *
 * Development Electron, test fixtures, non-Windows builds and paths that are
 * not the NSIS per-user <profile>\AppData\Local\Programs layout are unchanged.
 */
function checkPackagedInstallProfile({
  isPackaged,
  platform = process.platform,
  execPath = process.execPath,
  currentProfilePath,
} = {}) {
  if (isPackaged !== true) return Object.freeze({ ok: true, reason: 'development-or-test' })
  if (platform !== 'win32') return Object.freeze({ ok: true, reason: 'non-windows' })

  if (usesUnsupportedWindowsPathNamespace(execPath)) {
    return Object.freeze({
      ok: false,
      code: CODE,
      installProfile: null,
      currentProfile: cleanWindowsPath(currentProfilePath),
      message: 'This packaged copy of ToolsEnabled refused an unsupported Windows device or UNC executable path before startup.',
    })
  }

  const installProfile = profileRootFromInstallPath(execPath)
  if (!installProfile) return Object.freeze({ ok: true, reason: 'not-a-per-user-install' })

  /* Electron's Windows known-folder answer is the only process-owner evidence
     accepted here. Environment blocks can be inherited or constructed by the
     launcher, which is exactly the split this guard exists to catch. Unknown
     identity therefore refuses a classified per-user install rather than
     borrowing USERPROFILE/LOCALAPPDATA/homedir and guessing. */
  /* Never canonicalize the current profile here. A different account is the
     refusal input, not a filesystem target we are permitted to inspect. */
  const currentProfile = cleanWindowsPath(currentProfilePath)
  if (!currentProfile) {
    return Object.freeze({
      ok: false,
      code: CODE,
      installProfile,
      currentProfile: null,
      message: [
        `This copy of ToolsEnabled is installed for the Windows account "${profileName(installProfile)}", but Windows did not identify the account running it.`,
        '',
        `Close this copy and launch ToolsEnabled normally while signed in as "${profileName(installProfile)}".`,
        'Do not run the whole ToolsEnabled app as Administrator or under another Windows account.',
      ].join('\n'),
    })
  }
  if (sameWindowsPath(installProfile, currentProfile)) {
    return Object.freeze({ ok: true, reason: 'same-profile', installProfile, currentProfile })
  }

  return Object.freeze({
    ok: false,
    code: CODE,
    installProfile,
    currentProfile,
    message: refusalMessage({ installProfile, currentProfile }),
  })
}

module.exports = Object.freeze({
  ACCOUNT_ENVIRONMENT_CODE,
  CODE,
  DEV_RUNTIME_PROFILE_CODE,
  DEV_USER_DATA_CODE,
  ELEVATED_RUNTIME_CODE,
  ELEVATED_WARNING_KEY,
  INTEGRITY_UNAVAILABLE_CODE,
  NODE_LOADER_ENVIRONMENT_NAMES,
  PROVIDER_HOME_ENVIRONMENT_NAMES,
  STRICT_ACCOUNT_PATH_ENVIRONMENT_NAMES,
  canonicalWindowsPathThroughExistingAncestors,
  checkPackagedInstallProfile,
  checkRuntimeProfileOwner,
  checkWindowsRuntimeIntegrity,
  checkFencedDevUserDataDirectory,
  deleteEnvironmentNames,
  electronNodeHandoffEnvironment,
  elevatedRunWarning,
  explicitUserDataDirectories,
  fencedAccountEnvironment,
  insideWindowsPath,
  profileRootFromEnvironment,
  profileRootFromInstallPath,
  profileRootFromRuntimePath,
  profileRootFromWindowsUserPath,
  resolveWindowsShortPath,
  refusalMessage,
  trustedProfileShortAliasRoot,
  usesUnsupportedWindowsPathNamespace,
  windowsProfileReferences,
})
