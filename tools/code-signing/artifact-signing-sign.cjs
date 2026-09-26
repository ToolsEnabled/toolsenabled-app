'use strict'
/* electron-builder custom sign hook: Azure Artifact Signing through SignTool
 * and the Artifact Signing dlib.
 *
 * electron-builder reaches this only when tools/code-signing/
 * electron-builder-signing.cjs found a complete configuration and set
 * `win.signtoolOptions.sign` to this file. It is called once per file
 * (signingHashAlgorithms is ["sha256"]): the application executable, the NSIS
 * uninstaller before it is embedded, the installer, and any other .exe the
 * build copies.
 *
 * For each file it
 *   1. leaves manifest-pinned vendor binaries byte-identical (see
 *      classifyFileForSigning in windows-signing.cjs);
 *   2. writes Microsoft's metadata.json (endpoint, account, profile and the
 *      credential exclusions for the chosen auth mode) into a private
 *      temporary directory, and removes it afterwards;
 *   3. runs the documented command
 *        signtool sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com
 *                 /td SHA256 /dlib <Azure.CodeSigning.Dlib.dll> /dmdf <metadata.json> <file>
 *   4. reads the signature back with Get-AuthenticodeSignature and refuses
 *      unless it is Valid, signed by the configured publisher, and
 *      timestamped.
 * Any failure throws, and with forceCodeSigning set the build stops. */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const {
  VERIFY_FILE_VARIABLE,
  VERIFY_SCRIPT,
  classifyFileForSigning,
  interpretSignatureReadback,
  resolveWindowsSigning,
  signingMetadata,
  signtoolSignArgs,
} = require('./windows-signing.cjs')

const SIGN_TIMEOUT_MS = 5 * 60_000
const READBACK_TIMEOUT_MS = 60_000

function runProcess(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk) => { output += chunk.toString() }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
}

function windowsPowerShell(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const tail = (text, lines = 12) => String(text).trim().split(/\r?\n/).slice(-lines).join('\n')

function createSigner({
  env = process.env,
  platform = process.platform,
  run = runProcess,
  exists = fs.existsSync,
  tmpdir = os.tmpdir,
  log = (line) => console.log(line),
} = {}) {
  return async function sign(configuration, packager) {
    const file = configuration?.path
    if (typeof file !== 'string' || file === '') throw new Error('[artifact-signing] electron-builder passed no file to sign')
    const resolution = resolveWindowsSigning(env)
    if (!resolution.enabled) {
      throw new Error(
        '[artifact-signing] the sign hook ran with no Artifact Signing configuration; the gate should have set ' +
          'signExecutable:false. Refusing rather than guessing.',
      )
    }
    const { settings } = resolution
    const name = path.win32.basename(file)
    const decision = classifyFileForSigning(file)
    if (!decision.sign) {
      log(`[artifact-signing] left ${name} byte-identical: ${decision.reason}`)
      return
    }
    if (configuration.hash != null && String(configuration.hash).toLowerCase() !== 'sha256') {
      throw new Error(`[artifact-signing] asked for a ${configuration.hash} signature; Artifact Signing is configured for SHA-256 only`)
    }
    if (platform !== 'win32') {
      throw new Error('[artifact-signing] SignTool with the Artifact Signing dlib runs on Windows; build the Windows installer on Windows')
    }
    for (const [label, file_] of [['SignTool', settings.signtool], ['Artifact Signing dlib', settings.dlib]]) {
      if (!exists(file_)) {
        throw new Error(`[artifact-signing] ${label} not found at ${file_}; install Microsoft.Azure.ArtifactSigningClientTools and correct the path`)
      }
    }

    const version = packager?.appInfo?.version
    const correlationId = `ToolsEnabled${version ? ' ' + version : ''} ${name}`.slice(0, 128)
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'te-artifact-signing-'))
    const metadataPath = path.join(directory, 'metadata.json')
    try {
      fs.writeFileSync(metadataPath, JSON.stringify(signingMetadata(settings, { correlationId }), null, 2) + '\n', { mode: 0o600 })
      log(`[artifact-signing] signing ${name} with profile ${settings.profile} (${settings.auth})`)
      const signed = await run(settings.signtool, signtoolSignArgs(settings, metadataPath, file), { env, timeoutMs: SIGN_TIMEOUT_MS })
      if (signed.code !== 0) {
        throw new Error(`[artifact-signing] SignTool exited ${signed.code ?? signed.signal} for ${name}:\n${tail(signed.output)}`)
      }
      const readback = await run(
        windowsPowerShell(env),
        ['-NoProfile', '-NonInteractive', '-Command', VERIFY_SCRIPT],
        { env: { ...env, [VERIFY_FILE_VARIABLE]: file }, timeoutMs: READBACK_TIMEOUT_MS },
      )
      if (readback.code !== 0) {
        throw new Error(`[artifact-signing] the signature of ${name} could not be read back (exit ${readback.code ?? readback.signal}):\n${tail(readback.output)}`)
      }
      const verified = interpretSignatureReadback(readback.output, settings, file)
      log(`[artifact-signing] ${name}: Valid, signed by ${verified.signer}${verified.issuer ? ` (issuer ${verified.issuer})` : ''}, timestamped`)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

module.exports = { sign: createSigner(), createSigner, runProcess }
