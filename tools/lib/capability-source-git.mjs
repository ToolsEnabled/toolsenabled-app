import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const EXACT_GIT_COMMIT = /^[0-9a-f]{40}$/

const SOURCE_SETTING_RELATIVE = 'private/capability-source.owner.json'
const AMBIENT_GIT_PATHS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

function gitEnvironment(environment) {
  const clean = { ...environment }
  for (const name of Object.keys(clean)) {
    const folded = name.toUpperCase()
    if (AMBIENT_GIT_PATHS.includes(folded)
        || folded === 'GIT_CONFIG_COUNT'
        || folded === 'GIT_NO_REPLACE_OBJECTS'
        || folded === 'GIT_OPTIONAL_LOCKS'
        || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(folded)) delete clean[name]
  }
  clean.GIT_NO_REPLACE_OBJECTS = '1'
  clean.GIT_OPTIONAL_LOCKS = '0'
  return clean
}

function environmentValue(environment, wanted) {
  const found = Object.keys(environment || {}).find(name => name.toUpperCase() === wanted)
  return found ? environment[found] : undefined
}

function git(source, args, { allowFailure = false, environment = process.env } = {}) {
  const safeDirectory = path.resolve(source).split(path.sep).join('/')
  const disabledHooks = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const result = spawnSync(
    'git',
    [
      '--no-replace-objects',
      '-c', `core.hooksPath=${disabledHooks}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', `safe.directory=${safeDirectory}`,
      '-C', source,
      ...args,
    ],
    { encoding: 'utf8', windowsHide: true, env: gitEnvironment(environment) },
  )
  if (result.error) throw new Error(`Git could not inspect the capability source: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `Git could not inspect the capability source (git ${args.join(' ')} exited ${result.status}): `
      + String(result.stderr || result.stdout || '').trim(),
    )
  }
  return result
}

function declaredExactRef(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !EXACT_GIT_COMMIT.test(value)) {
    throw new Error(`${label} must be one exact 40-character lowercase Git commit id`)
  }
  return value
}

export function readCapabilitySourceSetting(repoRoot) {
  const file = path.join(repoRoot, SOURCE_SETTING_RELATIVE)
  if (!existsSync(file)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${SOURCE_SETTING_RELATIVE} is present but unreadable: ${error.message}`)
  }
  if (typeof parsed?.path !== 'string' || !parsed.path.trim()) {
    throw new Error(`${SOURCE_SETTING_RELATIVE} must contain a non-empty "path" string`)
  }
  if (Object.hasOwn(parsed, 'ref')) declaredExactRef(parsed.ref, `${SOURCE_SETTING_RELATIVE} "ref"`)
  return { path: parsed.path.trim(), ref: parsed.ref ?? null }
}

/* IS THE ROOT, REPORTED AS IS NOT -- a false negative, not a false positive.
 *
 * MEASURED 2026-09-03. `git -C <source> rev-parse --show-toplevel` resolves
 * every 8.3 short-name segment in `source` to its long form before printing
 * it -- confirmed directly: a fixture built under this machine's own
 * os.tmpdir() (`C:\Users\TOOLSE~2\AppData\Local\Temp\...`) came back from Git
 * as `C:/Users/ToolsEnabled-Dev/AppData/Local/Temp/...`. `path.resolve(source)`
 * does no such resolution -- it is a lexical join, not a filesystem lookup --
 * so the two sides of the comparison below were two different spellings of the
 * identical directory, and every one of them failed with "capability source
 * must be the root of its Git repository". Six tests in
 * tools/test/capability-source-git.test.mjs were red for this and only this:
 * every one of them builds its fixture the same way, under os.tmpdir(), and
 * every one of them hit this line before reaching the check it meant to
 * exercise.
 *
 * fs.realpathSync (the default, JS-implemented walk) reproduces the same miss
 * -- measured returning the short form unchanged. fs.realpathSync.native calls
 * the OS directly and resolves it, matching what Git already does, so THIS
 * function canonicalizes `source` the same way before comparing rather than
 * asking Git to stop canonicalizing its own answer. A source that is a
 * symlink or junction onto the true root now compares equal too, which is the
 * correct answer to "is this directory the repository's root", not a
 * loosening of it: everything the rest of this function checks -- the exact
 * HEAD, the clean tree, the absence of replace refs -- still runs against
 * that same resolved root regardless of which spelling was passed in. */
function canonicalSourcePath(source) {
  const resolved = path.resolve(source)
  try {
    return path.resolve(realpathSync.native(resolved))
  } catch {
    // A source Git already opened but this process cannot realpath is not
    // silently treated as a match: fall back to the untranslated form, which
    // still fails the comparison honestly instead of throwing a second,
    // unrelated error out of a check whose job is one true/false answer.
    return resolved
  }
}

/* Bind a source directory to bytes Git can identify, rather than trusting that
 * a clean-looking directory happens to be the engine commit named by the
 * release controller. All Git reads disable replacement objects. The separate
 * replacement-ref inventory makes that disabling observable: a source with a
 * dormant or unrelated replacement is refused, not silently interpreted under
 * whichever environment reached this process. */
export function assertCapabilitySourceGitBinding({ source, expectedRef, environment = process.env }) {
  const exactRef = declaredExactRef(expectedRef, 'capability source ref')
  if (!exactRef) throw new Error('a capability source ref is required')
  const replacementNamespace = environmentValue(environment, 'GIT_REPLACE_REF_BASE')
  if (typeof replacementNamespace === 'string' && replacementNamespace.length > 0) {
    throw new Error('capability source Git replacement namespaces are forbidden')
  }

  const rootResult = git(source, ['rev-parse', '--show-toplevel'], { environment })
  const repositoryRoot = path.resolve(rootResult.stdout.trim())
  if (repositoryRoot.toLowerCase() !== canonicalSourcePath(source).toLowerCase()) {
    throw new Error('capability source must be the root of its Git repository')
  }

  const head = git(source, ['rev-parse', '--verify', 'HEAD^{commit}'], { environment }).stdout.trim()
  if (head !== exactRef) {
    throw new Error(`capability source HEAD ${head || '(unresolved)'} differs from declared ref ${exactRef}`)
  }

  const replacements = git(source, ['for-each-ref', '--format=%(refname)', 'refs/replace'], { environment }).stdout.trim()
  if (replacements) throw new Error(`capability source has forbidden Git replace refs: ${replacements.split(/\r?\n/).join(', ')}`)

  const commonResult = git(source, ['rev-parse', '--git-common-dir'], { environment })
  const commonDirectory = path.resolve(source, commonResult.stdout.trim())
  if (existsSync(path.join(commonDirectory, 'info', 'grafts'))) {
    throw new Error('capability source has a forbidden legacy Git graft file')
  }

  const status = git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { environment }).stdout
  if (status.length > 0) throw new Error('capability source is dirty or has untracked files')

  const flags = git(source, ['ls-files', '-v', '-z'], { environment }).stdout
  for (const entry of flags.split('\0').filter(Boolean)) {
    if (entry.length < 3 || entry[1] !== ' ') throw new Error('capability source emitted malformed Git index state')
    if (/[a-zS]/.test(entry[0])) {
      throw new Error('capability source has assume-unchanged or skip-worktree Git index state')
    }
  }

  const symbolic = git(source, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true, environment })
  if (symbolic.status !== 0 && symbolic.status !== 1) {
    throw new Error('capability source HEAD is neither detached nor a valid branch checkout')
  }
  const branchRef = symbolic.status === 0 ? symbolic.stdout.trim() : null
  if (branchRef) {
    const branchHead = git(source, ['rev-parse', '--verify', `${branchRef}^{commit}`], { environment }).stdout.trim()
    if (branchHead !== exactRef) throw new Error('capability source branch tip differs from its checked-out HEAD')
  }

  return { source: repositoryRoot, sourceRef: exactRef, head, detached: !branchRef, branchRef }
}

export function resolveCapabilitySourceBinding({
  repoRoot,
  explicitSource = null,
  explicitSourceRef = null,
  environment = process.env,
} = {}) {
  const configured = readCapabilitySourceSetting(repoRoot)
  const declarations = [
    ['--source', explicitSource],
    ['TOOLSENABLED_SOURCE', environmentValue(environment, 'TOOLSENABLED_SOURCE')],
    [SOURCE_SETTING_RELATIVE, configured?.path],
  ].filter(([, value]) => value !== undefined && value !== null)
  if (declarations.length === 0) {
    throw new Error(
      'the capability-layer source tree is not configured. Set it one of three ways:\n'
      + '  --source <path>\n'
      + '  TOOLSENABLED_SOURCE=<path>\n'
      + `  ${SOURCE_SETTING_RELATIVE}  ->  { "path": "<path>", "ref": "<40-char commit>" }\n`
      + 'None of the three was set.',
    )
  }
  const [sourceLabel, sourceValue] = declarations[0]
  if (typeof sourceValue !== 'string' || !sourceValue.trim()) {
    throw new Error(`${sourceLabel} must name one non-empty capability source path`)
  }
  const source = path.resolve(sourceValue.trim())
  if (!existsSync(path.join(source, 'tools', 'mission-bridge.js'))) {
    throw new Error(`${sourceLabel} selected ${source}, but it does not contain tools/mission-bridge.js; refusing to fall back to another checkout`)
  }

  const refs = [
    ['--source-ref', explicitSourceRef],
    ['TOOLSENABLED_SOURCE_REF', environmentValue(environment, 'TOOLSENABLED_SOURCE_REF')],
    [`${SOURCE_SETTING_RELATIVE} "ref"`, configured?.ref],
  ].filter(([, value]) => value !== undefined && value !== null)
    .map(([label, value]) => [label, declaredExactRef(value, label)])
  if (refs.length === 0) {
    throw new Error(
      'the capability source has no exact commit binding. Set --source-ref, TOOLSENABLED_SOURCE_REF, '
      + `or ${SOURCE_SETTING_RELATIVE} "ref"`,
    )
  }
  const distinct = new Set(refs.map(([, value]) => value))
  if (distinct.size !== 1) {
    throw new Error(`capability source ref declarations disagree: ${refs.map(([label, value]) => `${label}=${value}`).join(', ')}`)
  }
  return assertCapabilitySourceGitBinding({ source, expectedRef: refs[0][1], environment })
}

export { gitEnvironment }
