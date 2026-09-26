'use strict'
/* WINDOWS CODE SIGNING: OFF UNTIL IT IS CONFIGURED, THEN ALL OR NOTHING.
 *
 * Windows builds before the 1.0.46 re-release of 2026-09-25 shipped unsigned;
 * that release is signed by the configured publisher. The product says which it is
 * (download.json "codeSigned", the release notes' measured "Signed" row). This module is the one place that decides whether a build is signed,
 * so that the answer cannot drift between the electron-builder configuration,
 * the signing hook and the release declaration.
 *
 * THE SIGNING SERVICE is Microsoft Azure Artifact Signing (formerly Trusted
 * Signing), used through SignTool plus the Artifact Signing dlib -- the
 * integration Microsoft documents first:
 *   https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations
 * electron-builder 26.15.3's own `azureSignOptions` path was not used: it runs
 * `Install-Module -Name TrustedSigning -Force` from the PowerShell Gallery on
 * every build (an unpinned download inside the ship path), and TrustedSigning
 * is the pre-rename module (last published 2025-07-11; Microsoft now points at
 * the ArtifactSigning module). SignTool and the dlib are installed once, by the
 * owner, from Microsoft (`winget install -e --id
 * Microsoft.Azure.ArtifactSigningClientTools`), and named here by path.
 *
 * THE RULES, each pinned by tools/test/code-signing-windows.test.mjs:
 *   1. Nothing configured -> `signExecutable: false`, exactly the unsigned
 *      build this project has always shipped. A stray CSC_LINK / WIN_CSC_LINK
 *      cannot sign anything, because signExecutable:false stops electron-builder
 *      before it looks for a certificate.
 *   2. Anything configured -> everything must be configured, or the build
 *      REFUSES with the missing names. A half-configured machine must not
 *      quietly produce an unsigned installer that someone believes is signed.
 *   3. Configured -> signExecutable:true, forceCodeSigning:true, one SHA-256
 *      signature per file through tools/code-signing/artifact-signing-sign.cjs,
 *      and every signature is read back (Valid, expected publisher,
 *      timestamped) before the build may continue.
 *   4. Endpoint, account, profile and tool paths never enter the
 *      electron-builder configuration (which electron-builder may write to
 *      release/builder-effective-config.yaml); only the public publisher name
 *      does. The hook re-reads them from the environment.
 *   5. Secrets never enter the optional configuration file. Authentication is
 *      Microsoft Entra ID through `az login` (azure-cli) or the standard
 *      AZURE_* service-principal environment (service-principal).
 *   6. Vendor binaries whose bytes are pinned by a manifest keep their bytes:
 *      the packed speech bundle (resources/voice-runtime/bundle) is verified
 *      file-by-file against sha256 pins in afterPack
 *      (tools/after-pack-strip-litter.cjs -> verifyVoiceBundle), and its
 *      python.exe already carries its vendor's signature. Re-signing it would
 *      break that verification and the signed build with it.
 */

const fs = require('node:fs')
const path = require('node:path')

const ENV = Object.freeze({
  config: 'TOOLSENABLED_ARTIFACT_SIGNING_CONFIG',
  endpoint: 'TOOLSENABLED_ARTIFACT_SIGNING_ENDPOINT',
  account: 'TOOLSENABLED_ARTIFACT_SIGNING_ACCOUNT',
  profile: 'TOOLSENABLED_ARTIFACT_SIGNING_PROFILE',
  publisher: 'TOOLSENABLED_ARTIFACT_SIGNING_PUBLISHER',
  auth: 'TOOLSENABLED_ARTIFACT_SIGNING_AUTH',
  signtool: 'TOOLSENABLED_ARTIFACT_SIGNING_SIGNTOOL',
  dlib: 'TOOLSENABLED_ARTIFACT_SIGNING_DLIB',
})

// Keys the optional JSON configuration file may carry, mapped to settings.
// The names follow Microsoft's metadata.json / electron-builder spelling.
const FILE_KEYS = Object.freeze({
  endpoint: 'endpoint',
  codeSigningAccountName: 'account',
  certificateProfileName: 'profile',
  publisherName: 'publisher',
  auth: 'auth',
  signtoolPath: 'signtool',
  dlibPath: 'dlib',
})

const SETTING_ORDER = Object.freeze(['endpoint', 'account', 'profile', 'publisher', 'auth', 'signtool', 'dlib'])

// Region endpoints exactly as published in the Artifact Signing quickstart
// ("Azure regions that support Artifact Signing"). A region/endpoint mismatch
// is documented to fail as 403 at signing time; refusing an unknown value
// here names the problem before a build starts. If Microsoft adds a region,
// add its row here from that table.
const REGION_ENDPOINTS = Object.freeze([
  'https://brs.codesigning.azure.net',
  'https://cus.codesigning.azure.net',
  'https://eus.codesigning.azure.net',
  'https://jpe.codesigning.azure.net',
  'https://krc.codesigning.azure.net',
  'https://ncus.codesigning.azure.net',
  'https://neu.codesigning.azure.net',
  'https://plc.codesigning.azure.net',
  'https://scus.codesigning.azure.net',
  'https://swn.codesigning.azure.net',
  'https://wcus.codesigning.azure.net',
  'https://weu.codesigning.azure.net',
  'https://wus.codesigning.azure.net',
  'https://wus2.codesigning.azure.net',
  'https://wus3.codesigning.azure.net',
])

// Microsoft's documented RFC 3161 timestamp authority for Artifact Signing.
// Certificates are valid for about three days, so an untimestamped signature
// stops validating almost immediately; the hook refuses one.
const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com'
const FILE_DIGEST = 'SHA256'

// DefaultAzureCredential's chain, as listed in the signing-integrations page.
// Each auth mode keeps exactly one and excludes the rest, so a build never
// authenticates as whichever identity happens to be lying around.
const CREDENTIAL_CHAIN = Object.freeze([
  'EnvironmentCredential',
  'WorkloadIdentityCredential',
  'ManagedIdentityCredential',
  'SharedTokenCacheCredential',
  'VisualStudioCredential',
  'VisualStudioCodeCredential',
  'AzureCliCredential',
  'AzurePowerShellCredential',
  'AzureDeveloperCliCredential',
  'InteractiveBrowserCredential',
])
const AUTH_MODES = Object.freeze({
  'azure-cli': 'AzureCliCredential',
  'service-principal': 'EnvironmentCredential',
})

// The electron-builder custom sign hook, relative to the project directory.
// Relative (and "./"-prefixed) on purpose: electron-builder then checks that it
// resolves inside the workspace, and no build machine's absolute path is
// written into the configuration electron-builder may print.
const SIGN_HOOK = './tools/code-signing/artifact-signing-sign.cjs'
const GATE = './tools/code-signing/electron-builder-signing.cjs'

// Trees whose bytes are pinned by a manifest that a later build step verifies.
const VENDOR_PINNED_TREES = Object.freeze([
  Object.freeze({
    segments: Object.freeze(['resources', 'voice-runtime', 'bundle']),
    reason: 'the packed speech bundle is verified against sha256 pins in afterPack (verifyVoiceBundle); its python.exe keeps its vendor signature',
  }),
])

const SECRET_KEY = /secret|password|passphrase|token|credential|private|key$/i

class SigningConfigurationError extends Error {
  constructor(problems) {
    super(
      'Windows code signing is partly configured, so the build refuses rather than ship an unsigned installer ' +
        'someone believes is signed. Configure every value or none:\n  - ' + problems.join('\n  - '),
    )
    this.name = 'SigningConfigurationError'
    this.problems = Object.freeze([...problems])
  }
}

const present = (value) => typeof value === 'string' && value.trim() !== ''

function readConfigFile(file, readFile, problems) {
  if (!path.isAbsolute(file) && !path.win32.isAbsolute(file)) {
    problems.push(`${ENV.config} must be an absolute path to a JSON file; got ${JSON.stringify(file)}`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(String(readFile(file, 'utf8')))
  } catch (error) {
    problems.push(`${ENV.config} could not be read as JSON (${error.code || error.name}: ${error.message.split('\n')[0]})`)
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    problems.push(`${ENV.config} must contain a JSON object`)
    return {}
  }
  const settings = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(FILE_KEYS, key)) {
      problems.push(
        SECRET_KEY.test(key)
          ? `${ENV.config} carries "${key}": secrets do not belong in the signing configuration file; sign in with \`az login\` or use the AZURE_* service-principal environment`
          : `${ENV.config} carries an unknown key "${key}" (allowed: ${Object.keys(FILE_KEYS).join(', ')})`,
      )
      continue
    }
    if (!present(value)) {
      problems.push(`${ENV.config} "${key}" must be a non-empty string`)
      continue
    }
    settings[FILE_KEYS[key]] = value.trim()
  }
  return settings
}

/* Decide whether this build signs, from an environment (process.env by
 * default). Returns { enabled: false, reason } when nothing is configured,
 * { enabled: true, settings } when everything is, and THROWS
 * SigningConfigurationError for anything in between. */
function resolveWindowsSigning(env = process.env, { readFile = fs.readFileSync } = {}) {
  const requested = Object.values(ENV).filter((name) => present(env[name]))
  if (requested.length === 0) {
    return Object.freeze({
      enabled: false,
      reason: `no Artifact Signing configuration is present (none of ${Object.values(ENV).join(', ')} is set)`,
    })
  }

  const problems = []
  const fromFile = present(env[ENV.config]) ? readConfigFile(env[ENV.config].trim(), readFile, problems) : {}
  const fileKeyFor = (setting) => Object.keys(FILE_KEYS).find((key) => FILE_KEYS[key] === setting)
  const settings = {}
  for (const setting of SETTING_ORDER) {
    const value = present(env[ENV[setting]]) ? env[ENV[setting]].trim() : fromFile[setting]
    if (!present(value)) {
      problems.push(`${ENV[setting]} (or "${fileKeyFor(setting)}" in ${ENV.config}) is not set`)
      continue
    }
    settings[setting] = value
  }

  if (settings.endpoint !== undefined) {
    const endpoint = settings.endpoint.replace(/\/+$/, '').toLowerCase()
    if (!REGION_ENDPOINTS.includes(endpoint)) {
      problems.push(
        `the endpoint ${JSON.stringify(settings.endpoint)} is not one of the documented Artifact Signing region endpoints ` +
          '(https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart); it must be the region the account was created in',
      )
    } else {
      settings.endpoint = endpoint
    }
  }
  // Naming constraints from the quickstart: accounts 3-24 characters, profiles
  // 5-100; alphanumerics (hyphens allowed, never doubled), starting with a
  // letter and ending with a letter or digit.
  const named = (value, min, max) =>
    new RegExp(`^[A-Za-z][A-Za-z0-9-]{${min - 2},${max - 2}}[A-Za-z0-9]$`).test(value) && !value.includes('--')
  if (settings.account !== undefined && !named(settings.account, 3, 24)) {
    problems.push(`the account name ${JSON.stringify(settings.account)} does not meet Artifact Signing account naming rules`)
  }
  if (settings.profile !== undefined && !named(settings.profile, 5, 100)) {
    problems.push(`the certificate profile name ${JSON.stringify(settings.profile)} does not meet Artifact Signing profile naming rules`)
  }
  if (settings.publisher !== undefined && /[\u0000-\u001f\u007f]/.test(settings.publisher)) {
    problems.push('the publisher name contains control characters')
  }
  if (settings.auth !== undefined && !Object.hasOwn(AUTH_MODES, settings.auth)) {
    problems.push(`the auth mode ${JSON.stringify(settings.auth)} is not one of: ${Object.keys(AUTH_MODES).join(', ')}`)
  }
  if (settings.auth === 'service-principal') {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID']) {
      if (!present(env[name])) problems.push(`service-principal authentication needs ${name}`)
    }
    if (!present(env.AZURE_CLIENT_SECRET) && !present(env.AZURE_CLIENT_CERTIFICATE_PATH)) {
      problems.push('service-principal authentication needs AZURE_CLIENT_CERTIFICATE_PATH (preferred) or AZURE_CLIENT_SECRET')
    }
  }
  const tool = (setting, basename) => {
    const value = settings[setting]
    if (value === undefined) return
    if (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) {
      problems.push(`${ENV[setting]} must be an absolute path; got ${JSON.stringify(value)}`)
    } else if (path.win32.basename(value).toLowerCase() !== basename.toLowerCase()) {
      problems.push(`${ENV[setting]} must name ${basename}; got ${JSON.stringify(path.win32.basename(value))}`)
    }
  }
  tool('signtool', 'signtool.exe')
  tool('dlib', 'Azure.CodeSigning.Dlib.dll')

  if (problems.length > 0) throw new SigningConfigurationError(problems)
  return Object.freeze({ enabled: true, settings: Object.freeze(settings) })
}

/* The `win` fragment electron-builder merges beneath package.json's own. */
function electronBuilderWindowsConfig(resolution) {
  if (!resolution || resolution.enabled !== true) return { signExecutable: false }
  return {
    signExecutable: true,
    forceCodeSigning: true,
    signtoolOptions: {
      sign: SIGN_HOOK,
      publisherName: resolution.settings.publisher,
      signingHashAlgorithms: ['sha256'],
    },
  }
}

/* The metadata.json SignTool's /dmdf reads, in Microsoft's documented shape. */
function signingMetadata(settings, { correlationId } = {}) {
  const keep = AUTH_MODES[settings.auth]
  if (!keep) throw new Error(`unknown auth mode ${JSON.stringify(settings.auth)}`)
  return {
    Endpoint: settings.endpoint,
    CodeSigningAccountName: settings.account,
    CertificateProfileName: settings.profile,
    ...(present(correlationId) ? { CorrelationId: correlationId } : {}),
    ExcludeCredentials: CREDENTIAL_CHAIN.filter((name) => name !== keep),
  }
}

/* Microsoft's documented invocation: SignTool with the dlib, SHA-256 file
 * digest, RFC 3161 timestamp from the Artifact Signing TSA. */
function signtoolSignArgs(settings, metadataPath, file) {
  return ['sign', '/v', '/fd', FILE_DIGEST, '/tr', TIMESTAMP_URL, '/td', FILE_DIGEST, '/dlib', settings.dlib, '/dmdf', metadataPath, file]
}

/* Whether a file electron-builder hands the hook is ours to sign. */
function classifyFileForSigning(file) {
  const segments = String(file).split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLowerCase())
  for (const tree of VENDOR_PINNED_TREES) {
    for (let index = 0; index + tree.segments.length <= segments.length - 1; index += 1) {
      if (tree.segments.every((segment, offset) => segments[index + offset] === segment)) {
        return Object.freeze({ sign: false, reason: tree.reason })
      }
    }
  }
  return Object.freeze({ sign: true, reason: null })
}

// PowerShell 5.1, reading the signature back. The file path travels in an
// environment variable, never inside the command string. PSModulePath is reset
// to the host's own modules for the same reason tools/release-packager/
// cut-release-candidate.mjs readInstallerSignature does: an inherited pwsh 7
// module path makes 5.1 discover Security cmdlets it cannot load.
const VERIFY_FILE_VARIABLE = 'TOOLSENABLED_SIGNATURE_READBACK_FILE'
const VERIFY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  `$s=Get-AuthenticodeSignature -LiteralPath $env:${VERIFY_FILE_VARIABLE}`,
  '$c=$s.SignerCertificate',
  "$simple=[System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName",
  '[pscustomobject]@{status=$s.Status.ToString();signer=$(if($c){$c.GetNameInfo($simple,$false)}else{$null});issuer=$(if($c){$c.GetNameInfo($simple,$true)}else{$null});timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress',
].join('; ')

/* Judge the read-back. Throws unless the file is Valid, signed by exactly the
 * configured publisher, and timestamped. */
function interpretSignatureReadback(output, settings, file = 'file') {
  let record
  try {
    record = JSON.parse(String(output).trim().split(/\r?\n/).filter(Boolean).at(-1))
  } catch {
    throw new Error(`the signature of ${path.win32.basename(file)} could not be read back after signing`)
  }
  const problems = []
  if (record?.status !== 'Valid') problems.push(`Authenticode status is ${JSON.stringify(record?.status)}, not "Valid"`)
  if (record?.signer !== settings.publisher) {
    problems.push(`signed by ${JSON.stringify(record?.signer)}, expected ${JSON.stringify(settings.publisher)}`)
  }
  if (record?.timestamped !== true) problems.push('the signature carries no timestamp, so it stops validating when the three-day certificate expires')
  if (problems.length) throw new Error(`${path.win32.basename(file)} failed signature read-back: ${problems.join('; ')}`)
  return Object.freeze({ status: record.status, signer: record.signer, issuer: record.issuer ?? null, timestamped: true })
}

const normalizeModulePath = (value) => './' + String(value).replace(/\\/g, '/').replace(/^\.\//, '')

/* What electron-builder will do for `package.json`, applying its merge order:
 * package.json's own `build.win.signExecutable` wins over a parent config; the
 * gate supplies it otherwise. null means "not decided here" (electron-builder's
 * default would then sign only if some certificate happened to be found),
 * which the release declaration reports as unverified rather than unsigned. */
function effectiveSignExecutable(packageJson, env = process.env, options = {}) {
  const build = packageJson?.build ?? {}
  if (typeof build.win?.signExecutable === 'boolean') return build.win.signExecutable
  const parents = Array.isArray(build.extends) ? build.extends : build.extends == null ? [] : [build.extends]
  if (parents.some((parent) => normalizeModulePath(parent) === GATE)) {
    return electronBuilderWindowsConfig(resolveWindowsSigning(env, options)).signExecutable
  }
  return null
}

module.exports = {
  ENV,
  FILE_KEYS,
  REGION_ENDPOINTS,
  TIMESTAMP_URL,
  CREDENTIAL_CHAIN,
  AUTH_MODES,
  SIGN_HOOK,
  GATE,
  VENDOR_PINNED_TREES,
  VERIFY_FILE_VARIABLE,
  VERIFY_SCRIPT,
  SigningConfigurationError,
  resolveWindowsSigning,
  electronBuilderWindowsConfig,
  signingMetadata,
  signtoolSignArgs,
  classifyFileForSigning,
  interpretSignatureReadback,
  effectiveSignExecutable,
}
