#!/usr/bin/env node
/* Owner-facing readiness check for Windows code signing.
 *
 *   node tools/code-signing/artifact-signing-preflight.mjs            status only, no signature spent
 *   node tools/code-signing/artifact-signing-preflight.mjs --probe X  also sign a COPY of X.exe and read it back
 *
 * Exit codes: 0 ready (or signing is OFF, which is a valid state), 1 the
 * configuration is incomplete or invalid, 2 the configuration is complete but
 * this machine cannot sign with it (not Windows, a tool missing, not signed in).
 * It prints configuration names and paths, never a secret: authentication
 * lives in `az login` or the AZURE_* environment, which this reads only for
 * presence. A probe spends one signature from the account's monthly quota. */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { resolveWindowsSigning, SigningConfigurationError, ENV } = require('./windows-signing.cjs')
const { createSigner } = require('./artifact-signing-sign.cjs')

export async function preflight({ env = process.env, platform = process.platform, argv = [], log = console.log, run = spawnSync } = {}) {
  let resolution
  try {
    resolution = resolveWindowsSigning(env)
  } catch (error) {
    if (!(error instanceof SigningConfigurationError)) throw error
    log('Windows code signing: MISCONFIGURED -- a build from this environment will refuse to package.')
    for (const problem of error.problems) log(`  - ${problem}`)
    return 1
  }
  if (!resolution.enabled) {
    log('Windows code signing: OFF. Builds from this environment are unsigned, and the release notes will say so.')
    log(`  To turn it on, set every one of: ${Object.values(ENV).filter((name) => name !== ENV.config).join(', ')}`)
    log(`  (or put the non-secret values in a JSON file named by ${ENV.config}); see tools/code-signing/README.md.`)
    return 0
  }
  const { settings } = resolution
  log('Windows code signing: CONFIGURED (Azure Artifact Signing)')
  for (const key of ['endpoint', 'account', 'profile', 'publisher', 'auth', 'signtool', 'dlib']) log(`  ${key.padEnd(9)} ${settings[key]}`)
  if (platform !== 'win32') {
    log('Not ready HERE: SignTool with the Artifact Signing dlib runs on Windows. Run this on the Windows build machine.')
    return 2
  }
  const failures = []
  for (const [label, file] of [['SignTool', settings.signtool], ['Artifact Signing dlib', settings.dlib]]) {
    if (!existsSync(file)) failures.push(`${label} not found at ${file}`)
  }
  if (settings.auth === 'azure-cli') {
    const account = run('az', ['account', 'show', '--query', '{tenant:tenantId,user:user.name}', '-o', 'json'], { encoding: 'utf8', shell: true, windowsHide: true })
    if (account.status !== 0) failures.push('`az account show` failed: sign in with `az login` as an identity holding "Artifact Signing Certificate Profile Signer"')
    else log(`  az login  ${String(account.stdout).replace(/\s+/g, ' ').trim()}`)
  } else {
    log(`  service principal ${env.AZURE_CLIENT_ID} in tenant ${env.AZURE_TENANT_ID} (${env.AZURE_CLIENT_CERTIFICATE_PATH ? 'certificate' : 'client secret'})`)
  }
  if (failures.length) {
    for (const failure of failures) log(`  NOT READY: ${failure}`)
    return 2
  }
  const probeIndex = argv.indexOf('--probe')
  if (probeIndex === -1) {
    log('Ready to sign. Add --probe <some .exe> to spend one signature proving it end to end on a copy.')
    return 0
  }
  const source = argv[probeIndex + 1]
  if (!source || !existsSync(source)) {
    log('--probe needs an existing .exe to copy (for example release\\win-unpacked\\ToolsEnabled.exe)')
    return 1
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'te-signing-probe-'))
  try {
    const copy = path.join(directory, path.basename(source))
    copyFileSync(source, copy)
    await createSigner({ env, platform, log })({ path: copy, hash: 'sha256' }, { appInfo: { version: 'probe' } })
    log('Probe signed and read back successfully. The original file was not modified.')
    return 0
  } catch (error) {
    log(`Probe FAILED: ${error.message}`)
    return 2
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await preflight({ argv: process.argv.slice(2) })
}
