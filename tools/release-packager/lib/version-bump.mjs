/* Version bump logic, kept separate from npm's own `npm version` command.
 *
 * `npm version` is avoidable complexity here: it wants to manage its own git
 * commit/tag (turned off with --no-git-tag-version, but then it still
 * shells out and can behave differently across npm versions), and this only
 * needs to change the package and lock root versions together. Doing it
 * directly means the exact bytes written are visible in this file, not implied
 * by a flag.
 *
 * THE POINT OF THIS FILE: two different binaries must never silently share
 * a version number. The release protocol treats "any changed byte is a new
 * candidate" as a rule because a same-version rebuild makes candidate
 * identity ambiguous. So computeNextVersion() always
 * changes the version unless the caller passes allowSameVersion explicitly
 * -- the same "explicit override, never a silent default" shape as
 * require-clean-tree.mjs's MC_ALLOW_DIRTY_BUILD.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertPackageLockParity } from './package-lock-parity.mjs'

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

export function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version.trim())
  if (!match) throw new Error(`not a plain major.minor.patch version: ${JSON.stringify(version)}`)
  const [, major, minor, patch] = match
  const components = { major: Number(major), minor: Number(minor), patch: Number(patch) }
  for (const [name, value] of Object.entries(components)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${name} component in version ${JSON.stringify(version)} exceeds JavaScript's safe integer range; ` +
          'refusing to compute a rounded release version',
      )
    }
  }
  return components
}

export function formatSemver({ major, minor, patch }) {
  for (const [name, value] of Object.entries({ major, minor, patch })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`cannot format unsafe ${name} version component: ${JSON.stringify(value)}`)
    }
  }
  return `${major}.${minor}.${patch}`
}

export function bumpSemver(version, kind) {
  const { major, minor, patch } = parseSemver(version)
  if (kind === 'major') return formatSemver({ major: major + 1, minor: 0, patch: 0 })
  if (kind === 'minor') return formatSemver({ major, minor: minor + 1, patch: 0 })
  if (kind === 'patch') return formatSemver({ major, minor, patch: patch + 1 })
  throw new Error(`unknown bump kind: ${JSON.stringify(kind)} (expected major, minor, or patch)`)
}

/**
 * Decide the version for the new candidate. Never returns the same string as
 * currentVersion unless allowSameVersion is true -- and when it is, the
 * caller is expected to log that just as loudly as require-clean-tree.mjs
 * logs MC_ALLOW_DIRTY_BUILD, because a same-version rebuild is exactly the
 * "second, different 1.0.1" this whole file exists to prevent by default.
 */
export function computeNextVersion({ currentVersion, explicitVersion, bump, allowSameVersion }) {
  const nextVersion = explicitVersion ? explicitVersion.trim() : bumpSemver(currentVersion, bump ?? 'patch')

  if (!SEMVER_PATTERN.test(nextVersion)) {
    throw new Error(`computed/explicit version ${JSON.stringify(nextVersion)} is not major.minor.patch`)
  }

  if (nextVersion === currentVersion && !allowSameVersion) {
    throw new Error(
      `next version (${nextVersion}) is identical to the current version (${currentVersion}). ` +
        'Two different builds must never silently share a version number -- pass --allow-same-version ' +
        'if this is deliberate (e.g. re-cutting after fixing a build-only defect with no source change), ' +
        'and expect the declaration to say so explicitly.',
    )
  }

  return nextVersion
}

/** Rewrite package.json and package-lock.json as one version operation. The
 * lock root is also checked for exact dependency parity before either file is
 * written, so a candidate cannot preserve an old dependency declaration under
 * a fresh release number. */
export async function writePackageVersion(packageJsonPath, newVersion) {
  const raw = await readFile(packageJsonPath, 'utf8')
  const parsed = JSON.parse(raw)
  const packageLockPath = path.join(path.dirname(packageJsonPath), 'package-lock.json')
  const lockRaw = await readFile(packageLockPath, 'utf8')
  const lock = JSON.parse(lockRaw)
  assertPackageLockParity(parsed, lock)
  const previousVersion = parsed.version
  parsed.version = newVersion
  lock.version = newVersion
  if (!lock.packages || !lock.packages['']) {
    throw new Error(`package-lock.json has no root packages[""] entry: ${packageLockPath}`)
  }
  lock.packages[''].version = newVersion
  const trailingNewline = raw.endsWith('\n') ? '\n' : ''
  const lockTrailingNewline = lockRaw.endsWith('\n') ? '\n' : ''
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}${trailingNewline}`, 'utf8')
  await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}${lockTrailingNewline}`, 'utf8')
  return {
    previousVersion,
    newVersion,
    path: path.resolve(packageJsonPath),
    packageLockPath: path.resolve(packageLockPath),
  }
}
