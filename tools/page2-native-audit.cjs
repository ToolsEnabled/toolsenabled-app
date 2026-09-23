#!/usr/bin/env node
'use strict'

// Runs the real application, native choosers and (with --real-provider) the
// owning account's provider. No renderer bridge, dialog, or reply is replaced.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { resolveNativeDriverDependencies } = require('./lib/native-driver-dependencies.cjs')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const { NativeAuditReport, selectScenarios, unavailable } = require('./lib/page2-native-report.cjs')
const { scenarios: sharedScenarios } = require('./lib/page2-native-scenarios.cjs')
const { scenarios: controlScenarios } = require('./lib/page2-native-controls-scenarios.cjs')
const { scenarios: boundedScenarios } = require('./lib/page2-native-bounded-scenarios.cjs')
const { scenarios: functionScenarios } = require('./lib/page2-native-functions-scenarios.cjs')
const { scenarios: permissionFileScenarios } = require('./lib/page2-native-permission-file-scenarios.cjs')
const { scenarios: menuScenarios } = require('./lib/page2-native-menu-scenarios.cjs')
const { scenarios: roleScenarios } = require('./lib/page2-native-role-scenarios.cjs')
const { scenarios: preferenceScenarios } = require('./lib/page2-native-preference-scenarios.cjs')
const { scenarios: continuationScenarios } = require('./lib/page2-native-continuation-scenarios.cjs')
const scenarios = [...sharedScenarios, ...controlScenarios, ...boundedScenarios, ...functionScenarios, ...permissionFileScenarios, ...menuScenarios, ...roleScenarios, ...preferenceScenarios, ...continuationScenarios]
const { providerAuthenticatedLaunchEnvironment, createOutsideWriteFence } = require('./lib/sterile-launch.cjs')
const { guardWindowsPath, guardWindowsTree } = require('./lib/page2-native-paths.cjs')
const { guardNativeInput, assertNativeSelection, readNativeWindowState } = require('./lib/page2-native-input.cjs')
const { prepareProviderAccount, guardOwnedPath } = require('./lib/page2-native-provider-account.cjs')
const { validateFirstUseOptions, prepareFirstUseProfile, HOME_KEYS } = require('./lib/page2-native-first-use.cjs')

function optionsFrom(argv) {
  const options = { app: path.resolve(__dirname, '..'), cases: [], realProvider: false, level: 'standard', linuxDialogBackend: 'desktop', list: false }
  const values = new Map([['--app', 'app'], ['--out', 'out'], ['--socket-temp-parent', 'socketTempParent'], ['--electron', 'electron'], ['--playwright', 'playwright'], ['--modules', 'modules'], ['--level', 'level'], ['--effort', 'effort'], ['--engine-source', 'engineSource'], ['--linux-dialog-backend', 'linuxDialogBackend'], ['--codex-profile-home', 'codexProfileHome'], ['--codex-account-id-sha256', 'codexAccountIdSha256']])
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--real-provider') options.realProvider = true
    else if (flag === '--retain-socket-temp') {
      if (options.retainSocketTemp) throw new Error('Duplicate --retain-socket-temp')
      options.retainSocketTemp = true
    }
    else if (flag === '--retain-provider-credentials') {
      if (options.retainProviderCredentials) throw new Error('Duplicate --retain-provider-credentials')
      options.retainProviderCredentials = true
    }
    else if (flag === '--sterile-first-use') {
      if (options.sterileFirstUse) throw new Error('Duplicate --sterile-first-use')
      options.sterileFirstUse = true
    }
    else if (flag === '--list') options.list = true
    else if (flag === '--help') options.help = true
    else if (flag === '--case') {
      const value = argv[++index]
      if (!value || value.startsWith('--') || value.split(',').some(id => !id)) throw new Error('--case needs one or more comma-separated case IDs')
      options.cases.push(...value.split(','))
    }
    else if (values.has(flag)) {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      options[values.get(flag)] = value
    } else throw new Error(`Unknown native audit argument: ${flag}`)
  }
  if (options.effort !== undefined && !['xhigh', 'max'].includes(options.effort)) throw new Error('--effort must be xhigh or max')
  if (!['guided', 'standard'].includes(options.level)) throw new Error('--level must be guided or standard')
  if (!['desktop', 'gtk'].includes(options.linuxDialogBackend)) throw new Error('--linux-dialog-backend must be desktop or gtk')
  if (options.codexProfileHome !== undefined || options.codexAccountIdSha256 !== undefined) {
    if (!options.realProvider || !options.codexProfileHome || !/^[a-f0-9]{64}$/.test(options.codexAccountIdSha256 || '')) {
      throw new Error('Explicit provider selection requires --real-provider, --codex-profile-home and --codex-account-id-sha256 together')
    }
  }
  validateFirstUseOptions(options)
  return options
}

// Keep the short Chromium socket path inside the invoking account. The
// filesystem guard in main checks every ancestor before creating anything.
function linuxSocketTemporaryPrefix(options, accountHome) {
  const api = path.posix
  const parent = options.socketTempParent || api.join(accountHome, '.cache')
  assert.ok(api.isAbsolute(parent) && api.normalize(parent) === parent && !parent.includes('\0'), 'Socket temporary parent must be an exact absolute path')
  const relative = api.relative(accountHome, parent)
  assert.ok(relative && relative !== '..' && !relative.startsWith('../') && !api.isAbsolute(relative), 'Socket temporary parent must stay below the owning account home')
  const prefix = api.join(parent, 'te-page2-')
  assert.ok(Buffer.byteLength(prefix) + 6 <= 70, 'Socket temporary parent is too long for Chromium Unix sockets')
  return prefix
}

function electronLaunchArguments(runtime, userData, options, platform = process.platform) {
  if (options.linuxDialogBackend === 'gtk' && platform !== 'linux') throw new Error('The GTK dialog backend is available only on Linux')
  // Electron documents this switch for falling back from the desktop portal
  // to its native GTK/KDE chooser. A portal broker on another X11 display has
  // no verifiable QA-PID window on this run's isolated Xvfb desktop. This is
  // an explicit native backend selection, never a substituted dialog result.
  return [runtime, `--user-data-dir=${userData}`,
    ...(options.linuxDialogBackend === 'gtk' ? ['--xdg-portal-required-version=2147483647'] : [])]
}

function assertOwnedWindowsPath(value, accountHome) {
  if (process.platform !== 'win32') return
  const { profileRootFromWindowsUserPath, usesUnsupportedWindowsPathNamespace } = require('../shell/install-profile-guard.cjs')
  if (usesUnsupportedWindowsPathNamespace(value)) throw new Error('Unsupported Windows path namespace')
  const profile = profileRootFromWindowsUserPath(value)
  if (profile && path.normalize(profile).toLowerCase() !== path.normalize(accountHome).toLowerCase()) throw new Error('Native audit cannot access another Windows profile')
}

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function manifestFile(root, relative) {
  assert.ok(typeof relative === 'string' && relative && !path.posix.isAbsolute(relative) && !path.win32.isAbsolute(relative)
    && !/[\\:\0]/.test(relative) && relative.split('/').every(part => part && !['.', '..', '.git'].includes(part))
    && relative.split('/')[0].toLowerCase() !== 'node_modules'
    && relative !== 'PAGE2-NATIVE-INPUTS.json', 'Runtime manifest paths must stay inside the artifact')
  let current = root
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    assert.equal(stat.isSymbolicLink(), false, 'Manifest entries cannot follow symbolic links or junctions')
    assert.ok(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'Manifest input is not a regular file')
  }
  return current
}
function walk(directory, prefix = '', excludeRuntimeRoot = true) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    // Only the runtime's external engineering dependency link is excluded.
    // Packed provider dependencies are artifact bytes and must remain bound.
    if (excludeRuntimeRoot && !prefix && (entry.name === 'node_modules' || entry.name === 'PAGE2-NATIVE-INPUTS.json')) continue
    const relative = path.join(prefix, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Runtime input contains a symbolic link: ${relative}`)
    if (entry.isDirectory()) files.push(...walk(path.join(directory, entry.name), relative, excludeRuntimeRoot))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function verifyPayload(runtime) {
  const directory = path.join(runtime, 'capability')
  const payload = JSON.parse(fs.readFileSync(path.join(directory, 'PAYLOAD.json'), 'utf8'))
  assert.match(payload.sourceRef, /^[a-f0-9]{40}$/)
  assert.equal(payload.ownerDataClean, true, 'The native audit requires the normal clean capability pack')
  const files = walk(directory, '', false).filter(relative => relative !== 'PAYLOAD.json').map(relative => relative.split(path.sep).join('/')).sort()
  const digest = crypto.createHash('sha256')
  let byteCount = 0
  for (const relative of files) {
    const bytes = fs.readFileSync(path.join(directory, relative))
    byteCount += bytes.length
    digest.update(relative).update('\0').update(bytes)
  }
  assert.equal(files.length, payload.fileCount, 'Capability file inventory changed after packing')
  assert.equal(byteCount, payload.byteCount, 'Capability byte count changed after packing')
  assert.equal(digest.digest('hex'), payload.payloadSha256, 'Capability bytes changed after packing')
  return payload
}

async function stageApplication(appDirectory, qaRoot, modules, engineSource) {
  const { assertRendererMeasurable, assertStagedRendererConsistent } = await import('./lib/staged-renderer.mjs')
  const runtime = path.join(qaRoot, 'runtime')
  fs.mkdirSync(runtime, { mode: 0o700 })
  let appRef
  const suppliedManifest = path.join(appDirectory, 'PAGE2-NATIVE-INPUTS.json')
  let rendererSourceHash
  let expectedEngineRef
  if (fs.existsSync(suppliedManifest)) {
    assert.equal(fs.lstatSync(suppliedManifest).isSymbolicLink(), false)
    const manifest = JSON.parse(fs.readFileSync(suppliedManifest, 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    appRef = manifest.appRef
    rendererSourceHash = manifest.rendererSourceHash
    expectedEngineRef = manifest.engineRef
    assert.match(appRef, /^[a-f0-9]{40}$/)
    assert.match(rendererSourceHash, /^[a-f0-9]{64}$/)
    assert.ok(manifest.files && !Array.isArray(manifest.files) && typeof manifest.files === 'object')
    const seen = new Set()
    for (const [relative, digest] of Object.entries(manifest.files)) {
      const source = manifestFile(appDirectory, relative)
      const folded = process.platform === 'win32' ? relative.toLowerCase() : relative
      assert.equal(seen.has(folded), false, 'Runtime manifest has colliding paths')
      seen.add(folded)
      assert.match(digest, /^[a-f0-9]{64}$/)
      const mode = manifest.modes?.[relative]
      assert.ok(Number.isInteger(mode) && mode >= 0 && mode <= 0o777, 'Runtime manifest must preserve file permissions')
      const bytes = fs.readFileSync(source)
      assert.equal(hash(bytes), digest, `Runtime input changed: ${relative}`)
      fs.mkdirSync(path.dirname(path.join(runtime, relative)), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(runtime, relative), bytes, { mode })
      fs.chmodSync(path.join(runtime, relative), mode)
    }
    assert.equal(verifyPayload(runtime).sourceRef, manifest.engineRef, 'Artifact engine identity disagrees with its packed bytes')
  } else {
    const status = (await execute('git', ['status', '--porcelain=v1'], { cwd: appDirectory })).stdout
    assert.equal(status, '', 'Commit or isolate source changes before taking a native audit snapshot')
    appRef = (await execute('git', ['rev-parse', 'HEAD'], { cwd: appDirectory })).stdout.trim()
    assertRendererMeasurable({ repoRoot: appDirectory, sourceDist: path.join(appDirectory, 'dist') })
    const { checkDistCurrent } = await import(pathToFileURL(path.join(__dirname, 'check-dist-current.mjs')).href)
    const renderer = checkDistCurrent(path.join(appDirectory, 'dist'), { root: appDirectory })
    assert.equal(renderer.method, 'content-marker', 'Record the renderer source identity after building; an mtime-only match is insufficient')
    rendererSourceHash = renderer.sourceHash
    const payload = verifyPayload(appDirectory)
    expectedEngineRef = payload.sourceRef
    await execute(process.execPath, [path.join(appDirectory, 'tools', 'check-payload-current.mjs'), path.join(appDirectory, 'capability')], {
      cwd: appDirectory, windowsHide: true,
      env: { ...process.env, ...(engineSource ? { TOOLSENABLED_SOURCE: engineSource } : {}), TOOLSENABLED_SOURCE_REF: payload.sourceRef },
    })
    const archive = path.join(qaRoot, 'source.tar')
    await execute('git', ['archive', '--format=tar', '--output', archive, appRef], { cwd: appDirectory })
    await execute('tar', ['-xf', archive, '-C', runtime])
    for (const name of ['dist', 'capability']) {
      assert.ok(fs.statSync(path.join(appDirectory, name)).isDirectory(), `Build and pack ${name} before the native audit`)
      fs.cpSync(path.join(appDirectory, name), path.join(runtime, name), { recursive: true, preserveTimestamps: true })
    }
    assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: appDirectory })).stdout.trim(), appRef, 'Source changed during staging')
    assert.equal((await execute('git', ['status', '--porcelain=v1'], { cwd: appDirectory })).stdout, '', 'Source changed during staging')
  }
  // A matching manifest proves the copied bytes, not that index.html's named
  // assets arrived. Refuse an incomplete renderer before writing a new input
  // manifest or launching Electron, including for source-free artifacts.
  assertStagedRendererConsistent({ stagedDist: path.join(runtime, 'dist'), sourceDist: path.join(appDirectory, 'dist') })
  const payload = verifyPayload(runtime)
  assert.equal(payload.sourceRef, expectedEngineRef, 'The capability source changed during staging')
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'dist', '.dist-source.json'), 'utf8')).sourceHash, rendererSourceHash, 'Artifact renderer source identity changed')
  const names = walk(runtime).sort()
  const files = Object.fromEntries(names.map(relative => [relative.split(path.sep).join('/'), hash(fs.readFileSync(path.join(runtime, relative)))]))
  const modes = Object.fromEntries(names.map(relative => [relative.split(path.sep).join('/'), fs.statSync(path.join(runtime, relative)).mode & 0o777]))
  const manifest = { schemaVersion: 1, appRef, engineRef: payload.sourceRef, rendererSourceHash, files, modes }
  fs.writeFileSync(path.join(runtime, 'PAGE2-NATIVE-INPUTS.json'), JSON.stringify(manifest, null, 2) + '\n')
  const moduleDirectory = fs.realpathSync(modules || path.join(appDirectory, 'node_modules'))
  fs.symlinkSync(moduleDirectory, path.join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { runtime, manifest }
}

function verifyRuntimeFiles(runtime, manifest) {
  assert.deepEqual(walk(runtime).map(name => name.split(path.sep).join('/')).sort(), Object.keys(manifest.files).sort(), 'The application wrote files into its immutable runtime')
  for (const [relative, digest] of Object.entries(manifest.files)) assert.equal(hash(fs.readFileSync(manifestFile(runtime, relative))), digest, `Runtime changed during the native audit: ${relative}`)
}

async function main(argv = process.argv.slice(2), companion = null) {
  const options = optionsFrom(argv)
  const selected = companion ? selectScenarios(companion.scenarios, options.cases) : selectScenarios(scenarios, options.cases)
  if (options.help) {
    if (companion) {
      process.stdout.write('node tools/page2-native-first-use-audit.cjs --sterile-first-use --case first-use-settings-cold-reopen --app PATH --out PRIVATE_PARENT --electron PATH --modules PATH --playwright PATH --engine-source PATH --linux-dialog-backend gtk\nLinux-only mounted first-use companion. Generates an empty provider-free profile; no existing account or credentials are selected. Use --list for its separate six-case inventory. This companion cannot qualify authenticated native coverage or a whole cut.\n')
      return 0
    }
    process.stdout.write('node tools/page2-native-audit.cjs --real-provider [--app PATH] [--out PRIVATE_PARENT] [--socket-temp-parent PRIVATE_SHORT_PARENT] [--retain-socket-temp] [--retain-provider-credentials] [--case ID,...] [--level guided|standard] [--effort xhigh|max] [--linux-dialog-backend desktop|gtk] [--codex-profile-home PATH --codex-account-id-sha256 SHA256]\nUse --list for named coverage. Run on the owning account\'s interactive desktop. Explicit provider selection uses a temporary copy of the verified existing sign-in and the normal named-account registry. Provider mode spends provider budget. --retain-provider-credentials preserves temporary credential copies even when preparation fails; cleanup then requires separate authorization.\n')
    return 0
  }
  if (options.list) {
    process.stdout.write(JSON.stringify(selected.map(({ id, title, controls, requires }) => ({ id, title, controls, requires })), null, 2) + '\n')
    return 0
  }
  if (companion) {
    assert.equal(companion.cohort, 'sterile-first-use', 'Unknown native companion cohort')
    assert.equal(options.sterileFirstUse, true, 'The first-use companion requires --sterile-first-use and an explicit selection')
  } else assert.equal(options.sterileFirstUse, undefined, 'Sterile first-use requires the dedicated companion entry')
  const accountHome = os.homedir()
  if (options.codexProfileHome) assert.equal(accountHome, os.userInfo().homedir, 'Explicit provider selection must use the operating-system account home')
  for (const value of [options.app, options.out, options.modules, options.electron, options.playwright, options.engineSource].filter(Boolean)) assertOwnedWindowsPath(path.resolve(value), accountHome)
  if (process.platform === 'win32') {
    // Resolve ordinary repository defaults before applying the same account
    // and tree fences used for explicitly selected engineering dependencies.
    options.modules ||= path.join(options.app, 'node_modules')
    options.electron ||= path.join(options.modules, 'electron', 'dist', 'electron.exe')
    options.playwright ||= path.join(options.app, 'node_modules', 'playwright')
    for (const name of ['modules', 'electron', 'playwright']) assert.ok(path.isAbsolute(options[name]), `Windows native audit requires an absolute ${name} path`)
    for (const name of ['app', 'modules', 'playwright', 'engineSource'].filter(name => options[name])) options[name] = guardWindowsPath(path.resolve(options[name]), { accountHome, expectedType: 'directory' })
    options.electron = guardWindowsPath(options.electron, { accountHome, expectedType: 'file' })
    guardWindowsTree(options.modules, { accountHome })
    guardWindowsTree(path.dirname(options.playwright), { accountHome })
  }
  process.umask(0o077)
  const parent = options.out ? path.resolve(options.out) : process.platform === 'win32'
    ? path.join(accountHome, 'AppData', 'Local', 'Temp') : path.join(accountHome, '.cache', 'toolsenabled-native-audits')
  guardWindowsPath(parent, { accountHome, allowMissing: true, expectedType: 'directory', requireProfile: true })
  if (process.platform === 'linux') guardOwnedPath(parent, { accountHome, allowMissing: true })
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (process.platform === 'linux') {
    guardOwnedPath(parent, { accountHome })
    assert.equal(fs.statSync(parent).mode & 0o077, 0, 'The native run parent must be private')
  }
  const qaRoot = fs.mkdtempSync(path.join(parent, 'page2-'))
  const userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  const workspace = path.join(qaRoot, 'workspace')
  fs.mkdirSync(workspace, { mode: 0o700 })
  const report = new NativeAuditReport(qaRoot, { platform: process.platform, providerMode: options.realProvider, level: options.level, dialogBackend: options.linuxDialogBackend, selectedCases: selected.map(item => item.id), ...(options.sterileFirstUse ? { sterileFirstUse: true, cohort: 'sterile-first-use' } : {}) })
  process.stdout.write(`Native audit evidence: ${qaRoot}\n`)
  let application = null
  let fence = null
  let socketTemporaryRoot = null
  let providerAccount = null
  let firstUse = null
  let closeApplication = null
  const errors = []
  try {
    const appDirectory = fs.realpathSync(options.app)
    const { playwright, executablePath, modulesDirectory, receipt } = await resolveNativeDriverDependencies(appDirectory, options)
    const { runtime, manifest } = await stageApplication(appDirectory, qaRoot, modulesDirectory, options.engineSource)
    Object.assign(report.metadata, { appRef: manifest.appRef, engineRef: manifest.engineRef, runtime })
    report.metadata.dependencies = receipt
    if (options.sterileFirstUse) {
      firstUse = prepareFirstUseProfile(qaRoot)
      report.metadata.firstUse = firstUse.receipt
      report.event({ kind: 'first-use-profile-created', receipt: firstUse.receipt })
    }
    const environment = firstUse ? firstUse.environment
      : providerAuthenticatedLaunchEnvironment({ accountHome, scratchRoot: path.join(qaRoot, 'profile') }, process.env, { cwd: qaRoot })
    if (!firstUse) providerAccount = prepareProviderAccount({ options, accountHome, qaRoot, userData, runtime, environment })
    if (providerAccount) report.metadata.providerAccount = providerAccount.receipt
    if (process.platform === 'linux') {
      // Chromium's singleton Unix socket has a 108-byte address limit. A long
      // evidence path must not prevent the real app from opening.
      const prefix = linuxSocketTemporaryPrefix(options, accountHome)
      const socketParent = path.dirname(prefix)
      guardOwnedPath(socketParent, { accountHome, allowMissing: true })
      fs.mkdirSync(socketParent, { recursive: true, mode: 0o700 })
      guardOwnedPath(socketParent, { accountHome })
      assert.equal(fs.statSync(socketParent).mode & 0o077, 0, 'The socket temporary parent must be private')
      socketTemporaryRoot = fs.mkdtempSync(prefix)
      fs.chmodSync(socketTemporaryRoot, 0o700)
      Object.assign(environment, { TMPDIR: socketTemporaryRoot, TMP: socketTemporaryRoot, TEMP: socketTemporaryRoot })
      report.metadata.temporaryRoot = socketTemporaryRoot
    }
    fence = createOutsideWriteFence({ appDirectory: runtime, cwd: qaRoot, selectedUserData: userData, label: 'Page 2 native regression audit' })
    await fence.arm()
    const context = {
      options, report, page: null, paths: { qaRoot, workspace, userData, runtime, mentionFile: path.join(workspace, 'qa-note.txt'), imageA: path.join(workspace, 'qa-image-a.png'), imageB: path.join(workspace, 'qa-image-b.png') },
      provider: {}, state: {}, firstUse,
      check: (condition, message) => assert.ok(condition, message),
      unavailable,
      async step(id, action) {
        report.event({ kind: 'step-start', id })
        try { const result = await action(); report.event({ kind: 'step-result', id, status: 'passed', result }); return result }
        catch (error) { report.event({ kind: 'step-result', id, status: 'failed', reason: error.message }); throw error }
      },
      async type(locator, text) { report.event({ kind: 'type', text }); await locator.click(); await context.page.keyboard.press('Control+A'); await context.page.keyboard.insertText(text) },
      async select(locator, value, { resetsAfterSelection = false } = {}) {
        const choices = await locator.evaluate(element => [...element.options].filter(option => !option.disabled && !option.hidden && !option.parentElement?.disabled).map(option => ({ value: option.value, label: option.label })))
        const index = choices.findIndex(option => option.value === value)
        assert.ok(index >= 0, `Visible select does not offer ${value}`)
        await context.nativeReady()
        // GTK can leave an Xvfb app visible but without native focus. Chromium
        // then treats arrows as closed-select changes, and a one-shot picker
        // resets/focuses another control on the first intermediate choice.
        // Focus only this already visible, enabled QA window before opening it.
        await application.evaluate(({ BrowserWindow }, id) => {
          const window = BrowserWindow.fromId(id)
          if (!window || window.isDestroyed() || !window.isVisible() || !window.isEnabled()) throw new Error('The owned native window cannot accept a select input')
          window.focus()
        }, context.state.qaWindowId)
        await context.page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })
        const observer = await locator.evaluateHandle(element => {
          const record = { element, before: element.value, events: [] }
          record.listener = event => record.events.push({ type: event.type, value: element.value, trusted: event.isTrusted })
          element.addEventListener('input', record.listener, true)
          element.addEventListener('change', record.listener, true)
          return record
        })
        try {
          await locator.click(); await context.page.keyboard.press('Home')
          for (let step = 0; step < index; step++) await context.page.keyboard.press('ArrowDown')
          await context.page.keyboard.press('Enter')
          const observed = await observer.evaluate(({ before, events }) => ({ before, events }))
          const receipt = { requested: value, label: choices[index].label, ...observed, after: await locator.inputValue(), resetsAfterSelection }
          report.event({ kind: 'native-select', ...receipt })
          assertNativeSelection(receipt)
        } finally {
          await observer.evaluate(record => {
            record.element.removeEventListener('input', record.listener, true)
            record.element.removeEventListener('change', record.listener, true)
          })
          await observer.dispose()
        }
      },
      async picker(request) {
        const serial = crypto.randomBytes(6).toString('hex')
        const requestPath = path.join(qaRoot, `picker-${serial}-request.json`)
        const resultPath = path.join(qaRoot, `picker-${serial}-result.json`)
        fs.writeFileSync(requestPath, JSON.stringify(request) + '\n')
        const pid = context.state.qaProcessId
        assert.ok(Number.isInteger(pid) && pid > 0, 'Native input requires the real Electron main process identity')
        let failure
        try {
          if (process.platform === 'win32') {
            await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(runtime, 'tools/lib/page2-native-picker.ps1'), '-QaRoot', qaRoot, '-ExpectedProfileRoot', accountHome, '-QaProcessId', String(pid), '-RequestPath', requestPath, '-ResultPath', resultPath], { timeout: 25000, windowsHide: true })
          } else {
            await execute('/usr/bin/python3', [path.join(runtime, 'tools/lib/page2-native-picker.py'), '--qa-root', qaRoot, '--expected-profile-root', accountHome, '--qa-process-id', String(pid), '--request-path', requestPath, '--result-path', resultPath, '--launch-record', path.join(qaRoot, 'native-launch.json')], { timeout: 25000 })
          }
        } catch (error) {
          failure = error
        }
        const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')) : null
        report.event({ kind: 'native-picker', request, result, failure: failure?.message })
        if (failure) throw failure
        assert.equal(result?.ok, true, 'The native dialog did not report acceptance')
        return result
      },
      async capture(name) {
        if (!context.page || context.page.isClosed()) return
        await context.page.screenshot({ path: path.join(qaRoot, `${name}.png`) })
        fs.writeFileSync(path.join(qaRoot, `${name}.txt`), await context.page.locator('body').innerText())
      },
      async nativeReady() {
        // Electron may garbage-collect a long-retained BrowserWindow JS
        // wrapper while its native window remains alive. Resolve this exact
        // window afresh for every guard and return only synchronous values.
        const enabled = () => readNativeWindowState(() => application.evaluate(({ BrowserWindow }, id) => {
          const window = BrowserWindow.fromId(id)
          return Boolean(window && !window.isDestroyed() && window.isVisible() && window.isEnabled())
        }, context.state.qaWindowId), event => report.event(event))
        if (await enabled()) return
        if (process.platform === 'linux') {
          await context.picker({ operation: 'cancel', title: 'Check for updates?' })
        } else {
          const inspection = await context.picker({ operation: 'inspect' })
          const defer = inspection.windows.flatMap(window => window.buttons || []).filter(button => button.enabled && button.name === 'Not now')
          assert.equal(defer.length, 1, 'An unhandled native modal blocks input to the QA main window')
          await context.picker({ operation: 'dismiss-update' })
        }
        assert.equal(await enabled(), true, 'The QA main window is still disabled after dismissing its update prompt')
      },
      async open() {
        if (firstUse) assert.equal(application, null, 'The prior sterile Electron attempt must be closed before launching again')
        if (providerAccount) report.event({ kind: 'provider-account-open', ...providerAccount.beginOpen() })
        application = await playwright._electron.launch({ executablePath, args: electronLaunchArguments(runtime, userData, options), cwd: qaRoot, env: environment, chromiumSandbox: true, timeout: 60000 })
        const ready = async () => {
          application.process().stderr.on('data', bytes => fs.appendFileSync(path.join(qaRoot, 'stderr.log'), bytes))
          const firstWindow = await application.firstWindow({ timeout: 60000 })
          const mainWindow = await application.browserWindow(firstWindow)
          context.state.qaWindowId = await mainWindow.evaluate(window => window.id)
          await mainWindow.dispose()
          context.page = guardNativeInput(firstWindow, () => context.nativeReady())
          context.page.setDefaultTimeout(12000)
          context.page.on('pageerror', error => { errors.push(error.message); report.event({ kind: 'pageerror', message: error.message }) })
          await context.page.waitForLoadState('domcontentloaded')
          const runtimeState = await application.evaluate(({ app, BrowserWindow }) => ({ pid: process.pid, userData: app.getPath('userData'), sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), windows: BrowserWindow.getAllWindows().map(window => window.webContents.getLastWebPreferences()).map(({ sandbox, contextIsolation, nodeIntegration }) => ({ sandbox, contextIsolation, nodeIntegration })) }))
          assert.equal(runtimeState.userData, userData)
          assert.equal(runtimeState.sandboxDisabled, false)
          assert.ok(runtimeState.windows.every(window => window.sandbox && window.contextIsolation && !window.nodeIntegration))
          context.state.qaProcessId = runtimeState.pid
          runtimeState.launcherPid = application.process().pid
          if (process.platform === 'linux') {
            const fields = fs.readFileSync(`/proc/${runtimeState.pid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/)
            assert.equal(Number(fields[1]), process.pid, 'The QA app must be this runner’s direct child')
            fs.writeFileSync(path.join(qaRoot, 'native-launch.json'), JSON.stringify({ qaProcessId: runtimeState.pid, runnerPid: process.pid, startTicks: fields[19], userData: runtimeState.userData }) + '\n')
          }
          report.event({ kind: 'runtime', ...runtimeState })
          // Wait through the normal launch prompt delay, then inspect the real
          // window. Current Linux builds do not offer the Windows-only updater;
          // requiring that absent dialog would fail before native setup starts.
          // A genuinely blocking dialog still goes through the owned input guard.
          await context.page.waitForTimeout(2000)
          if (process.platform === 'linux') {
            await context.nativeReady()
          }
          if (process.platform === 'win32') {
            let inspection = await context.picker({ operation: 'inspect' })
            const defer = inspection.windows.flatMap(window => window.buttons || []).filter(button => button.enabled && button.name === 'Not now')
            assert.ok(defer.length <= 1, 'The QA window has ambiguous native update prompts')
            if (defer.length) {
              await context.picker({ operation: 'dismiss-update' })
              inspection = await context.picker({ operation: 'inspect' })
            }
            assert.ok(inspection.windows.some(window => window.class === 'Chrome_WidgetWin_1' && window.enabled), 'The QA main window must be enabled before native input')
            assert.ok(!inspection.windows.some(window => window.class === '#32770'), 'An unhandled native modal blocks the QA main window')
          }
          if (providerAccount) report.event({ kind: 'provider-account-check', ...await providerAccount.verify(context.page, 'startup') })
          if (firstUse) return application.evaluate(({ app }, keys) => ({ pid: process.pid, userData: app.getPath('userData'),
            homedir: app.getPath('home'), homes: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])),
            absentHomeKeys: keys.filter(key => !Object.prototype.hasOwnProperty.call(process.env, key)),
            credentialEnvironmentKeys: Object.keys(process.env).filter(key =>
              /^(?:CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|AWS_|AZURE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) }), HOME_KEYS)
        }
        if (firstUse) await firstUse.observeOpening(application.process(), ready, event => report.event(event))
        else await ready()
      },
      async close() {
        if (application) {
          const child = firstUse ? application.process() : null
          await application.close(); application = null
          if (firstUse) report.event({ kind: 'first-use-close', ...firstUse.closed(child) })
        }
      },
    }
    closeApplication = () => context.close()
    context.paths.checkWord = `QA_${crypto.randomBytes(8).toString('hex').toUpperCase()}`
    fs.writeFileSync(context.paths.mentionFile, `The check word is ${context.paths.checkWord}.\n`)
    for (const target of [context.paths.imageA, context.paths.imageB]) fs.copyFileSync(path.join(runtime, 'shell', 'icon.png'), target)
    for (const scenario of selected) {
      if (providerAccount && application && context.page) report.event({ kind: 'provider-account-check',
        ...await providerAccount.verify(context.page, `before:${scenario.id}`) })
      await report.run(scenario, context)
      if (providerAccount && application && context.page) report.event({ kind: 'provider-account-check',
        ...await providerAccount.verify(context.page, `after:${scenario.id}`) })
    }
    await context.close()
    await report.run({ id: 'runtime-unchanged', title: 'The exact application inputs were unchanged throughout the native audit', run: () => verifyRuntimeFiles(runtime, manifest) }, context)
    await report.run({ id: 'renderer-errors', title: 'No uncaught renderer errors', requires: ['startup'], run: () => assert.deepEqual(errors, []) }, context)
    await report.run({ id: 'outside-write-fence', title: 'No changes outside the isolated application profile', run: () => fence.check() }, context)
  } catch (error) {
    await report.run({ id: 'harness', title: 'Native audit prerequisites and lifecycle', run: () => { throw error } }, {})
  } finally {
    if (application) await (closeApplication ? closeApplication() : application.close().then(() => { application = null })).catch(error => { report.event({ kind: 'cleanup-error', message: error.message }); process.exitCode = 1 })
    if (firstUse) {
      try {
        const receipt = firstUse.finish(userData)
        report.event({ kind: 'first-use-final', receipt })
        assert.equal(receipt.complete, true, 'First-use lifecycle did not validate and close every launched attempt')
      }
      catch (error) { report.event({ kind: 'cleanup-error', message: error.message }); process.exitCode = 1 }
    }
    if (providerAccount) {
      try { report.event({ kind: 'provider-account-final-check', ...providerAccount.finish() }) }
      catch (error) { report.event({ kind: 'cleanup-error', message: error.message }); process.exitCode = 1 }
    }
    if (socketTemporaryRoot && !application) {
      if (options.retainSocketTemp) report.event({ kind: 'socket-temp-retained', path: socketTemporaryRoot,
        providerCredentialCleanup: 'Still required from the outer runner after independent process closure' })
      else fs.rmSync(socketTemporaryRoot, { recursive: true, force: true })
    }
    if (fence) await fence.check().catch(error => { report.event({ kind: 'outside-write-failure', message: error.message }); process.exitCode = 1 })
    for (const scenario of selected) {
      if (!report.results.some(row => row.id === scenario.id)) report.notRun(scenario, 'The native audit lifecycle failed before this case could run')
    }
    report.save()
  }
  return process.exitCode || report.exitCode()
}

module.exports = { main, optionsFrom, linuxSocketTemporaryPrefix, electronLaunchArguments, stageApplication, manifestFile, verifyPayload, verifyRuntimeFiles }
if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 2 })
