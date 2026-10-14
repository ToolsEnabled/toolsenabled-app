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

/* THE PATH TRAVELS IN AN ENVIRONMENT VARIABLE (1.0.50 platform review, U7).
 * It used to be spliced into the command as a single-quoted literal with only
 * the ASCII apostrophe doubled. PowerShell also treats U+2018, U+2019, U+201A
 * and U+201B as single quotes, so a profile folder named like D’Angelo
 * ended the string early, the script did not parse, and every update on that
 * account was refused as "did not match". The signature reader below already
 * passed its path this way; now both do, and the command is one fixed string.
 *
 * NO `[Console]::OutputEncoding = ...` (1.0.50 review of fixes, 3.10). Under
 * a Constrained Language Mode policy that assignment is refused ("Cannot set
 * property. Property setting is supported only on core types in this language
 * mode."); it came before $ErrorActionPreference = 'Stop', so the script went
 * on and the read succeeded only because the error was non-fatal and nothing
 * read stderr. It was never needed: Windows PowerShell's ConvertTo-Json
 * escapes every non-ASCII character, so the output is ASCII either way. */
const VERSION_INFO_FILE_VARIABLE = 'TOOLSENABLED_VERSIONINFO_FILE'
const VERSION_INFO_SCRIPT =
  `$ErrorActionPreference = 'Stop'; ` +
  `$info = (Get-Item -LiteralPath $env:${VERSION_INFO_FILE_VARIABLE}).VersionInfo; ` +
  `$info | Select-Object CompanyName,ProductName,FileVersion,ProductVersion,FileDescription,LegalCopyright,OriginalFilename | ConvertTo-Json -Compress`

function createExeVersionInfoReader({ execFile = nodeExecFile, powershell = WINDOWS_POWERSHELL, env = process.env } = {}) {
  const execFileAsync = promisify(execFile)
  return async function readExeVersionInfo(exePath) {
    if (typeof exePath !== 'string' || exePath.trim() === '') {
      throw new Error('exePath must be a non-empty string')
    }
    /* -LiteralPath prevents wildcard expansion; the value arrives through the
     * environment, so nothing in it is ever parsed as PowerShell. */
    const { stdout } = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_INFO_SCRIPT],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...env, [VERSION_INFO_FILE_VARIABLE]: exePath } },
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

/* THE INSTALLER'S SIGNATURE, READ THE WAY THE SIGNING STEP READS IT BACK.
 *
 * shell/update-check.cjs told a person "Check that the publisher is
 * ToolsEnabled, Inc." while no screen in its flow showed a publisher and
 * nothing in it checked one. Size, SHA-256 and the VersionInfo above all come
 * from the same site as the installer, so whoever controlled that site could
 * have every installed copy run any program whose hash and VersionInfo matched
 * the manifest (1.0.50 release review, release-ops F4). The signature is the
 * one fact about the file that the site cannot write.
 *
 * The script is the read-back tools/code-signing/windows-signing.cjs runs on
 * every file it signs (VERIFY_SCRIPT), with only the variable renamed; for the
 * 1.0.50 installer it reported Valid, signed by ToolsEnabled, Inc., timestamped.
 * tools/test/update-check.test.mjs holds the two scripts equal, so the check
 * at install time is the check that was measured at signing time. It runs
 * through the same GLOBALROOT Windows PowerShell as the VersionInfo reader,
 * for the same reason, and the path travels in an environment variable, never
 * inside the command string. PSModulePath is reset inside the script because
 * an inherited PowerShell 7 module path makes 5.1 find Security cmdlets it
 * cannot load.
 *
 * THE TIMESTAMP IS REQUIRED. The signing certificates are short-lived (days);
 * the RFC 3161 timestamp is what keeps a signature Valid after its certificate
 * expires, so an untimestamped installer would stop verifying within days.
 *
 * THE SCRIPT RUNS UNDER CONSTRAINED LANGUAGE MODE TOO (1.0.50 platform review,
 * U3). On a machine with an App Control (WDAC) or AppLocker script policy,
 * Windows PowerShell runs this command in ConstrainedLanguage, which refuses
 * method calls on .NET types ([IO.Path]::Combine, GetNameInfo) and the
 * [pscustomobject] cast. The earlier script stopped at its second statement
 * there, and every update on such a machine was refused as unsigned, forever.
 * This one uses only cmdlets, property reads, string expansion and a
 * hashtable, all of which CLM allows, and sends the certificate's subject and
 * issuer as Windows prints them. The signer is the subject's CN, read here in
 * JavaScript (commonNameFromDistinguishedName); the comparison is unchanged. */
const EXPECTED_PUBLISHER = 'ToolsEnabled, Inc.'
const SIGNATURE_FILE_VARIABLE = 'TOOLSENABLED_UPDATE_SIGNATURE_FILE'
const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$env:PSModulePath="$PSHOME\\Modules"',
  `$s=Get-AuthenticodeSignature -LiteralPath $env:${SIGNATURE_FILE_VARIABLE}`,
  '$c=$s.SignerCertificate',
  '@{status="$($s.Status)";subject=$(if($c){$c.Subject}else{$null});issuer=$(if($c){$c.Issuer}else{$null});timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress',
].join('; ')

/* The CN of a distinguished name as .NET prints it (X500DistinguishedName.Name):
 * `CN="ToolsEnabled, Inc.", O="ToolsEnabled, Inc.", C=US` on Windows, the
 * reverse order elsewhere. A value holding a comma, plus, quote or similar is
 * wrapped in double quotes, with a quote inside written twice. Exactly one CN
 * is an answer; none, two, or text this cannot read is null, which the
 * comparison below refuses. */
function commonNameFromDistinguishedName(value) {
  if (typeof value !== 'string') return null
  const text = value
  const names = []
  let index = 0
  const skipSpaces = () => { while (index < text.length && /\s/.test(text[index])) index += 1 }
  while (true) {
    skipSpaces()
    if (index >= text.length) break
    const equals = text.indexOf('=', index)
    if (equals < 0) return null
    const type = text.slice(index, equals).trim()
    if (!type || /[,+"]/.test(type)) return null
    index = equals + 1
    skipSpaces()
    let attributeValue = ''
    if (text[index] === '"') {
      index += 1
      let closed = false
      while (index < text.length) {
        if (text[index] === '"') {
          if (text[index + 1] === '"') { attributeValue += '"'; index += 2; continue }
          index += 1
          closed = true
          break
        }
        attributeValue += text[index]
        index += 1
      }
      if (!closed) return null
      skipSpaces()
      if (index < text.length && text[index] !== ',' && text[index] !== '+') return null
    } else {
      const start = index
      while (index < text.length && text[index] !== ',' && text[index] !== '+') {
        if (text[index] === '"') return null
        index += 1
      }
      attributeValue = text.slice(start, index).trim()
    }
    if (/^(?:CN|OID\.2\.5\.4\.3|2\.5\.4\.3)$/i.test(type)) names.push(attributeValue)
    if (index < text.length) index += 1 // the separator
  }
  return names.length === 1 && names[0] ? names[0] : null
}

function createInstallerSignatureReader({ execFile = nodeExecFile, powershell = WINDOWS_POWERSHELL, env = process.env } = {}) {
  const execFileAsync = promisify(execFile)
  return async function readInstallerSignature(exePath) {
    if (typeof exePath !== 'string' || exePath.trim() === '') {
      throw new Error('exePath must be a non-empty string')
    }
    const { stdout } = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SIGNATURE_SCRIPT],
      /* Hashing a 100 MB installer while antivirus also reads it can take
         longer than the VersionInfo read, so the bound is wider. */
      { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...env, [SIGNATURE_FILE_VARIABLE]: exePath } },
    )
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)
    const parsed = JSON.parse(line)
    const issuer = typeof parsed?.issuer === 'string' ? parsed.issuer : null
    return {
      status: typeof parsed?.status === 'string' ? parsed.status : null,
      signer: commonNameFromDistinguishedName(parsed?.subject),
      issuer: commonNameFromDistinguishedName(issuer) ?? (issuer && issuer.trim() ? issuer.trim() : null),
      timestamped: parsed?.timestamped === true,
    }
  }
}

/* Valid, signed by exactly the publisher, and timestamped -- the same three
   conditions the signing step's own read-back requires. Anything else,
   including a reader that could not answer, is a refusal. */
function compareInstallerSignature(measured, { publisher = EXPECTED_PUBLISHER } = {}) {
  if (!measured || typeof measured !== 'object' || Array.isArray(measured)) {
    return { ok: false, reason: 'installer signature is unreadable' }
  }
  if (measured.status !== 'Valid') return { ok: false, reason: `installer signature status is ${JSON.stringify(measured.status ?? null)}` }
  if (measured.signer !== publisher) return { ok: false, reason: 'installer is not signed by the publisher' }
  if (measured.timestamped !== true) return { ok: false, reason: 'installer signature is not timestamped' }
  return { ok: true, signer: measured.signer }
}

const readInstallerSignature = createInstallerSignatureReader()

module.exports = {
  EXPECTED_PUBLISHER,
  IDENTITY_FIELDS,
  SIGNATURE_FILE_VARIABLE,
  SIGNATURE_SCRIPT,
  VERSION_INFO_FILE_VARIABLE,
  VERSION_INFO_SCRIPT,
  WINDOWS_POWERSHELL,
  commonNameFromDistinguishedName,
  compareInstallerSignature,
  comparePeIdentity,
  createExeVersionInfoReader,
  createInstallerSignatureReader,
  peIdentityManifestIsSane,
  readExeVersionInfo,
  readInstallerSignature,
  releaseVersionFromPe,
}
