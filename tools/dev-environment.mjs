#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDevelopmentSession, readDevelopmentSession, acquireDevelopmentSession,
  developmentSessionEnvironment, ordinaryPath } from './lib/development-session.mjs'
import { runDevelopmentProcess } from './lib/development-process.mjs'
import { configureDevelopmentSandbox } from './lib/development-sandbox.mjs'
import { prepareDevelopmentSocketTemp, removeDevelopmentSocketTemp } from './lib/development-socket-temp.mjs'
import sterileLaunch from './lib/sterile-launch.cjs'
import { assertPrivateDependencyTree, assertNativeDependencyRuntime, nativeDependencyInstallCommand } from './release-packager/lib/node-modules-reuse.mjs'

const valueOptions = new Set(['directory', 'kind', 'app', 'engine', 'app-ref', 'engine-ref', 'privacy-profile', 'session',
  'npm-cli', 'version', 'readiness-context', 'readiness-evidence', 'timeout-ms'])

export function parseDevelopmentArguments(argv) {
  const [command, ...rest] = argv
  if (!['create', 'start', 'status', 'prepare', 'sandbox', 'open', 'cut', 'help'].includes(command)) throw Error('Use dev-environment.mjs help')
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].replace(/^--/, '')
    if (!rest[i].startsWith('--') || Object.hasOwn(options, name)) throw Error('Unknown or duplicate session option: ' + rest[i])
    if (name === 'watch' || name === 'inspect' || name === 'refresh' || name === 'test' || name === 'allow-same-version') options[name] = true
    else if (valueOptions.has(name) && rest[i + 1] && !rest[i + 1].startsWith('--')) options[name] = rest[++i]
    else throw Error('Unknown or incomplete session option: ' + rest[i])
  }
  const allowed = {
    create: ['directory', 'kind', 'app', 'engine', 'app-ref', 'engine-ref', 'privacy-profile'],
    start: ['directory', 'app', 'engine', 'app-ref', 'engine-ref', 'privacy-profile', 'session', 'npm-cli', 'watch', 'inspect', 'refresh', 'timeout-ms'],
    sandbox: ['session'],
    status: ['session'], prepare: ['session', 'npm-cli', 'timeout-ms'], open: ['session', 'watch', 'inspect', 'timeout-ms'],
    cut: ['session', 'version', 'npm-cli', 'readiness-context', 'readiness-evidence', 'timeout-ms', 'test', 'allow-same-version'], help: [],
  }
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw Error('--' + key + ' does not apply to ' + command)
  return { command, options }
}

function help() {
  console.log(`Usage: node tools/dev-environment.mjs COMMAND [options]

create --directory NEW_ABSOLUTE_PATH --kind dev|cut --app APP_REPOSITORY --engine ENGINE_REPOSITORY
       [--app-ref EXACT_COMMIT] [--engine-ref EXACT_COMMIT] [--privacy-profile PRIVATE_JSON]
start --directory NEW_ABSOLUTE_PATH --app APP_REPOSITORY --engine ENGINE_REPOSITORY
      --npm-cli ABSOLUTE_NPM_CLI_JS [--privacy-profile PRIVATE_JSON] [--watch]
start --session EXISTING_DEV_SESSION [--refresh --npm-cli ABSOLUTE_NPM_CLI_JS] [--watch]
status --session SESSION_DIRECTORY
prepare --session SESSION_DIRECTORY --npm-cli ABSOLUTE_NPM_CLI_JS [--timeout-ms MILLISECONDS]
sandbox --session SESSION_DIRECTORY
open --session SESSION_DIRECTORY [--watch] [--inspect] [--timeout-ms MILLISECONDS]
cut --session SESSION_DIRECTORY --version X.Y.Z --npm-cli ABSOLUTE_NPM_CLI_JS
    --readiness-context PRIVATE_JSON | --readiness-evidence PRIVATE_RECEIPT [--test]

Create takes the current committed pair once, including from dirty active checkouts.
Each session owns its Git databases, build output, dependencies, caches, profiles and process scopes.
Use a different directory for every DEV window and CUT. A running session cannot be rebuilt.
Edit the DEV session's own app/engine trees. Commit engine changes and create a fresh session for them.
CUT qualification requires disposable-worker dispatch; shared-host execution refuses.
Source snapshots are pending qualification. They do not select, stop, restart or publish LIVE.
Start creates/prepares a new DEV session, or reopens the explicitly selected session.
Linux sandbox configuration loads only the exact private Electron path with sudo -n.
Open preserves sandboxing. Private Electron paths need normal OS sandbox prerequisites.`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options: o } = parseDevelopmentArguments(argv)
  if (command === 'help') { help(); return }
  if (command === 'start') {
    if (o.session && ['directory', 'app', 'engine', 'app-ref', 'engine-ref', 'privacy-profile'].some(key => o[key])) {
      throw Error('Choose an existing session or inputs for a new one')
    }
    if ((!o.session || o.refresh) && !o['npm-cli']) throw Error('A native npm CLI is required to prepare a DEV session')
    const selected = o.session ? readDevelopmentSession(o.session)
      : createDevelopmentSession({ directory: o.directory, kind: 'dev', app: o.app, engine: o.engine,
        appRef: o['app-ref'], engineRef: o['engine-ref'], privacyProfile: o['privacy-profile'] })
    if (selected.kind !== 'dev') throw Error('Start requires a DEV session')
    console.log('DEV session: ' + selected.paths.root)
    const deadline = o['timeout-ms'] ? ['--timeout-ms', o['timeout-ms']] : []
    if (!o.session || o.refresh) {
      await main(['prepare', '--session', selected.paths.root, '--npm-cli', o['npm-cli'], ...deadline])
    }
    await main(['sandbox', '--session', selected.paths.root])
    await main(['open', '--session', selected.paths.root, ...(o.watch ? ['--watch'] : []), ...(o.inspect ? ['--inspect'] : []), ...deadline])
    return
  }
  if (command === 'create') {
    const session = createDevelopmentSession({ directory: o.directory, kind: o.kind, app: o.app, engine: o.engine,
      appRef: o['app-ref'], engineRef: o['engine-ref'], privacyProfile: o['privacy-profile'] })
    console.log(JSON.stringify(session, null, 2)); return
  }
  const session = readDevelopmentSession(o.session)
  // Full qualification cannot enter an older/custom controller before the
  // shared-host boundary has been checked by this entry point.
  if (command === 'cut') sterileLaunch.assertSharedHostQualificationAllowed(developmentSessionEnvironment(session, { phase: 'build' }))
  // Existing sessions run their own measured controller. The original working
  // checkout, and the editable DEV app tree, may have changed or moved away.
  const controller = ordinaryPath(path.join(session.paths.controlApp, 'tools/dev-environment.mjs'), { directory: false })
  if (fileURLToPath(import.meta.url) !== controller) {
    const frozen = await import(pathToFileURL(controller).href)
    return frozen.main(argv)
  }
  if (command === 'status') {
    const active = path.join(session.paths.root, 'operation.json')
    console.log(JSON.stringify({ ...session, admission: fs.existsSync(active) ? JSON.parse(fs.readFileSync(active, 'utf8')) : null }, null, 2)); return
  }
  if (command === 'sandbox') {
    const lease = acquireDevelopmentSession(session, command)
    let outcome, cleanupConfirmed = true
    try { outcome = configureDevelopmentSandbox(session); console.log(JSON.stringify(outcome)) }
    catch (error) { cleanupConfirmed = error.cleanupConfirmed !== false; throw error }
    finally { lease.finish({ cleanupConfirmed, result: outcome ? 'passed' : 'failed', sandbox: outcome }) }
    return
  }
  if (command === 'open' && session.kind !== 'dev') throw Error('Open requires a DEV session; CUT has its own qualification launchers')
  if (command === 'cut' && session.kind !== 'cut') throw Error('CUT requires a separate frozen CUT session')
  const timeoutMs = o['timeout-ms'] === undefined ? 6 * 60 * 60_000 : Number(o['timeout-ms'])
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60_000) throw Error('Invalid session deadline')
  const environment = developmentSessionEnvironment(session, { phase: command === 'open' ? 'runtime' : 'build' })
  // Source/default QA can run in private directories on a shared machine.
  // Real account refresh, installation and recovery need a disposable native
  // worker. No environment value or supplied evidence path grants that custody.
  const lease = acquireDevelopmentSession(session, command)
  let cleanupConfirmed = true, outcome = {}, runs = [], socketTemp = null
  // Keep the app's normal 2 GiB host reserve plus an estimated operation
  // allowance before admitting new work. This is a preflight observation,
  // not a claim that separate directories create separate physical hardware.
  const memory = { observedAt: new Date().toISOString(), freeBytes: process.availableMemory?.() ?? os.freemem(),
    reserveBytes: 2048 * 1024 ** 2, estimatedOperationBytes: (command === 'cut' ? 4096 : command === 'prepare' ? 2048 : 512) * 1024 ** 2 }
  const run = async (args, cwd = session.paths.app) => {
    cleanupConfirmed = false
    const result = await runDevelopmentProcess(session, process.execPath, args, { cwd, env: environment, timeoutMs,
      log: value => process.stdout.write(value) })
    runs.push(result); cleanupConfirmed = result.cleanupConfirmed
    if (!cleanupConfirmed || result.code !== 0 || result.failure) throw Error(result.failure || 'Session command failed; see ' + result.output)
    return result
  }
  try {
    if (memory.freeBytes < memory.reserveBytes + memory.estimatedOperationBytes) {
      throw Error('This host has insufficient free memory for ' + command + ' alongside existing work. '
        + 'The session is retained; retry when capacity is available or prepare it on a dedicated native worker.')
    }
    if (command === 'prepare') {
      const npm = ordinaryPath(o['npm-cli'], { directory: false })
      // A normal native install in each private tree, including dev/optional
      // inputs and required lifecycle scripts. There is no writable reuse.
      for (const cwd of [session.paths.engine, session.paths.app]) {
        if (fs.existsSync(path.join(cwd, 'node_modules'))) {
          ordinaryPath(path.join(cwd, 'node_modules'))
          assertPrivateDependencyTree(path.join(cwd, 'node_modules'))
        }
        await run([npm, ...nativeDependencyInstallCommand().args], cwd)
        assertPrivateDependencyTree(path.join(cwd, 'node_modules'))
      }
      const modules = path.join(session.paths.app, 'node_modules')
      // The committed Electron package may omit postinstall. Preserve its
      // official installer instead of treating an empty package as a runtime.
      const electronName = process.platform === 'win32' ? 'electron.exe' : 'electron'
      if (!fs.existsSync(path.join(modules, 'electron', 'dist', electronName))) {
        await run([path.join(modules, 'electron', 'install.js')])
        assertPrivateDependencyTree(modules)
      }
      assertNativeDependencyRuntime(modules)
      await run(['tools/sync-bridge-api-contract.mjs', ...(session.kind === 'cut' ? ['--check'] : []),
        '--source', session.paths.engine, '--source-ref', session.sources.engine.ref])
      await run(['tools/pack-capability-layer.mjs', '--source', session.paths.engine, '--source-ref', session.sources.engine.ref])
      await run([npm, 'run', 'build'])
      if (session.kind === 'cut') readDevelopmentSession(session.paths.root)
    } else if (command === 'open') {
      socketTemp = prepareDevelopmentSocketTemp(session)
      await run([fileURLToPath(new URL('./lib/development-window.mjs', import.meta.url)), '--session', session.paths.root,
        ...(o.watch ? ['--watch'] : []), ...(o.inspect ? ['--inspect'] : [])])
    } else {
      if (!/^\d+\.\d+\.\d+$/.test(o.version || '')) throw Error('An explicit release version is required')
      if (Boolean(o['readiness-context']) === Boolean(o['readiness-evidence'])) throw Error('Choose exactly one readiness context or existing receipt')
      const npm = ordinaryPath(o['npm-cli'], { directory: false })
      const args = [npm, 'run', 'release:cut', '--', '--repo', session.paths.app,
        '--source-ref', session.sources.app.ref, '--engine-source-ref', session.sources.engine.ref,
        '--version', o.version, '--build-dir', session.paths.build, '--staging', session.paths.staging,
        '--readiness-output', path.join(session.paths.evidence, 'release-readiness.json'), '--keep-worktree']
      for (const key of ['readiness-context', 'readiness-evidence']) if (o[key]) args.push('--' + key, o[key])
      if (o.test) args.push('--test')
      if (o['allow-same-version']) args.push('--allow-same-version')
      await run(args)
    }
    outcome = { result: 'passed', scope: command === 'cut' ? 'cutter-command' : 'development-operation' }
  } catch (error) {
    outcome = { result: 'failed', message: error.message }
    if (typeof error.cleanupConfirmed === 'boolean') cleanupConfirmed = error.cleanupConfirmed
    throw error
  } finally {
    let cleanupError, socketTempRemoved = false
    if (socketTemp && cleanupConfirmed) {
      try { removeDevelopmentSocketTemp(session, socketTemp, { cleanupConfirmed }); socketTempRemoved = true }
      catch (error) { cleanupConfirmed = false; cleanupError = error; outcome = { result: 'failed', message: error.message } }
    }
    lease.finish({ cleanupConfirmed, ...outcome, memory, runs, socketTemp, socketTempRemoved })
    if (cleanupError) throw cleanupError
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
