'use strict'

/* Read and compare the three PE VersionInfo fields that identify an installer.
 *
 * SHA-256 proves that downloaded bytes match a manifest. It does not prove that
 * the manifest and the bytes describe the release the update prompt named. A
 * stale installer can be hashed faithfully and still install the wrong product
 * or version. Both the in-app updater and the website publication gate use this
 * module so they ask the same question of the actual PE resource.
 */
const { execFile: nodeExecFile } = require('node:child_process')
const { promisify } = require('node:util')

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const PE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/
const IDENTITY_FIELDS = Object.freeze(['productName', 'fileVersion', 'productVersion'])

/* THE INTERPRETER THIS GATE RUNS IS NOT SELECTABLE THROUGH PATH.
 *
 * This reader is the last identity check before shell/update-check.cjs spawns
 * a downloaded installer and quits the application; shell/main.cjs hands it in
 * as `inspectInstaller`. Launched as a bare `powershell.exe` it resolves
 * through PATH, and shell/bridge-env-path.cjs already records the measurement
 * that decides this: HKCU\Environment is writable by the user with no
 * elevation and no consent prompt. Whatever can write that key can put its own
 * powershell.exe ahead of Windows' and have it executed here, with this
 * process’s token, at the one moment the app is about to install software --
 * and a gate whose interpreter somebody else chose can be made to answer ok
 * for the wrong bytes. The SHA-256 that ran before this does not cover it:
 * this check exists precisely because bytes can hash faithfully and still be
 * the wrong release.
 *
 * So the interpreter is addressed the way shell/install-profile-guard.cjs
 * already addresses whoami.exe and cmd.exe -- through the object manager’s
 * GLOBALROOT namespace, which reaches the real Windows directory without
 * consulting PATH or any environment variable a user can set. That last part
 * is why this is not path.join(process.env.SystemRoot, ...): SystemRoot is
 * itself settable from HKCU\Environment, so deriving the path from it would
 * keep the same hole in a longer spelling. Measured working under execFile on
 * Windows 10.0.19045, 2026-09-09. */
const WINDOWS_POWERSHELL = String.raw`\\.\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/* Windows resources sometimes render a release as X.Y.Z.0. That is the same
 * release number for the manifest consistency check, but the measured value is
 * still compared byte-for-byte with the manifest field below. A non-zero fourth
 * component is a different version and is refused. */
function releaseVersionFromPe(value) {
  const match = PE_VERSION.exec(trimmed(value))
  if (!match || (match[4] !== undefined && Number(match[4]) !== 0)) return null
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
}

function peIdentityManifestIsSane(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const version = trimmed(manifest.version)
  if (!RELEASE_VERSION.test(version)) return false
  if (!trimmed(manifest.productName)) return false
  if (!releaseVersionFromPe(manifest.fileVersion) || releaseVersionFromPe(manifest.fileVersion) !== version) return false
  if (!releaseVersionFromPe(manifest.productVersion) || releaseVersionFromPe(manifest.productVersion) !== version) return false
  return true
}

function comparePeIdentity(manifest, measured) {
  if (!peIdentityManifestIsSane(manifest)) {
    return { ok: false, reason: 'manifest PE identity is unusable', mismatches: [] }
  }
  if (!measured || typeof measured !== 'object' || Array.isArray(measured)) {
    return { ok: false, reason: 'installer PE identity is unreadable', mismatches: [] }
  }

  const mismatches = []
  for (const field of IDENTITY_FIELDS) {
    const expected = trimmed(manifest[field])
    const actual = trimmed(measured[field])
    if (!actual || actual !== expected) mismatches.push({ field, expected, actual: actual || null })
  }
  return mismatches.length === 0
    ? { ok: true, identity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, trimmed(measured[field])])) }
    : { ok: false, reason: 'installer PE identity differs from manifest', mismatches }
}

function createExeVersionInfoReader({ execFile = nodeExecFile, powershell = WINDOWS_POWERSHELL } = {}) {
  const execFileAsync = promisify(execFile)
  return async function readExeVersionInfo(exePath) {
    if (typeof exePath !== 'string' || exePath.trim() === '') {
      throw new Error('exePath must be a non-empty string')
    }
    /* -LiteralPath plus a single-quoted, quote-doubled path prevents wildcard
     * expansion and PowerShell expression interpolation. */
    const literalPath = exePath.replace(/'/g, "''")
    const script =
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `$ErrorActionPreference = 'Stop'; ` +
      `$info = (Get-Item -LiteralPath '${literalPath}').VersionInfo; ` +
      `$info | Select-Object CompanyName,ProductName,FileVersion,ProductVersion,FileDescription,LegalCopyright,OriginalFilename | ConvertTo-Json -Compress`

    const { stdout } = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout.trim())
    const identity = {
      companyName: parsed?.CompanyName ?? null,
      productName: parsed?.ProductName ?? null,
      fileVersion: parsed?.FileVersion ?? null,
      productVersion: parsed?.ProductVersion ?? null,
      fileDescription: parsed?.FileDescription ?? null,
      legalCopyright: parsed?.LegalCopyright ?? null,
      originalFilename: parsed?.OriginalFilename ?? null,
    }
    if (!trimmed(identity.productName) || !trimmed(identity.fileVersion) || !trimmed(identity.productVersion)) {
      throw new Error(`Could not read ProductName, FileVersion and ProductVersion from ${exePath}`)
    }
    return identity
  }
}

const readExeVersionInfo = createExeVersionInfoReader()

module.exports = {
  IDENTITY_FIELDS,
  WINDOWS_POWERSHELL,
  comparePeIdentity,
  createExeVersionInfoReader,
  peIdentityManifestIsSane,
  readExeVersionInfo,
  releaseVersionFromPe,
}
