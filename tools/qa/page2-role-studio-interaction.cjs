'use strict'
// Explicit component regression, not a full native app qualification. Requires
// the checkout's prepared native dependencies; no provider or account is selected.
// Explicit --modules, --electron and --playwright select an engineering-only kit.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { fileURLToPath } = require('node:url')
let fixtureWindow
process.umask(0o077)

if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain, session } = require('electron')
  const entry = process.argv.indexOf(__filename)
  if (entry < 1) throw new Error('The fixture entry must be explicit')
  const [data, root, engine] = process.argv.slice(entry + 1)
  if (![data, root, engine].every(value => value && path.isAbsolute(value))) throw new Error('Explicit fixture paths are required')
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
    const target = path.join(data, key); fs.mkdirSync(target); app.setPath(key, target)
  }
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => { fixtureWindow = null })
  app.whenReady().then(async () => {
    const record = require(path.join(root, 'shell/agent-org-record.cjs'))
    const modules = record.loadModules({ root: engine })
    assert.equal(modules.ok, true, modules.reason)
    const api = record.createAgentOrgRecord({ modules, env: { LOCALAPPDATA: path.join(data, 'local'),
      TOOLSENABLED_STATE_ROOT: path.join(data, 'Role component', 'capability') } })
    const writes = []
    for (const method of ['read', 'createRole', 'editRole', 'resetRole']) ipcMain.handle('role-fixture:' + method, (event, request) => {
      assert.equal(event.senderFrame, event.sender.mainFrame)
      assert.equal(new URL(event.senderFrame.url).protocol, 'file:')
      const answer = api[method](request)
      if (method !== 'read') writes.push({ method, request, answer })
      return answer
    })
    ipcMain.handle('role-fixture:receipt', () => writes)
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel:
      !(details.url.startsWith('data:') || (details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data)) }))
    const win = fixtureWindow = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
      webPreferences: { preload: path.join(data, 'preload.cjs'), sandbox: true, contextIsolation: true,
        nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
    for (const name of ['did-navigate', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) win.webContents.on(name, (...args) => fs.appendFileSync(path.join(data, 'window-events.jsonl'), JSON.stringify({ name, args: args.slice(1).filter(value => typeof value === 'string' || (value && value.reason)) }) + '\n'))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(path.join(data, 'index.html'))
  }).catch(error => { fs.writeFileSync(path.join(data, 'main-failure.txt'), error.stack); app.exit(1) })
} else {
  void (async () => {
    const options = {}
    for (let index = 2; index < process.argv.length; index += 2) {
      assert.ok(['--app', '--engine', '--modules', '--electron', '--playwright', '--out'].includes(process.argv[index]))
      options[process.argv[index].slice(2)] = path.resolve(process.argv[index + 1])
    }
    assert.ok(options.app && options.engine && options.out, 'Pass explicit --app, --engine and --out')
    fs.mkdirSync(options.out, { recursive: true, mode: 0o700 })
    const data = fs.mkdtempSync(path.join(options.out, 'role-component-'))
    const requireApp = createRequire(path.join(options.app, 'package.json'))
    const { resolveNativeDriverDependencies } = requireApp('./tools/lib/native-driver-dependencies.cjs')
    const dependencies = await resolveNativeDriverDependencies(options.app, options)
    const { sterileProfileDirectories, prepareSterileProfile, sterileLaunchEnvironment } = requireApp('./tools/lib/sterile-launch.cjs')
    const environment = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data, 'profile'))))
    for (const key of Object.keys(environment)) if (/^NODE_OPTIONS$/i.test(key)) delete environment[key]
    const esbuild = requireApp(path.join(dependencies.modulesDirectory, 'esbuild'))
    await esbuild.build({ entryPoints: [path.join(options.app, 'tools/test/helpers/page2-role-studio-renderer.mjs')],
      nodePaths: [dependencies.modulesDirectory],
      bundle: true, format: 'iife', outfile: path.join(data, 'fixture.js'), loader: { '.woff2': 'dataurl' }, logLevel: 'silent' })
    esbuild.stop()
    fs.writeFileSync(path.join(data, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>')
    fs.writeFileSync(path.join(data, 'preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mcOrg',Object.fromEntries(['read','createRole','editRole','resetRole'].map(method=>[method,request=>ipcRenderer.invoke('role-fixture:'+method,request)])));contextBridge.exposeInMainWorld('roleFixtureReceipt',()=>ipcRenderer.invoke('role-fixture:receipt'));\n")
    const { playwright, executablePath } = dependencies
    const evidence = { scope: 'Actual Role Studio component and App/Engine stores; fixture navigation and IPC envelope, no full-app or provider qualification', dependencies: dependencies.receipt, results: [], events: [], errors: [] }
    let application, page
    try {
      application = await playwright._electron.launch({ executablePath,
        args: [__filename, data, options.app, options.engine], cwd: data, env: environment, chromiumSandbox: true, timeout: 30000 })
      application.process().stderr.on('data', bytes => fs.appendFileSync(path.join(data, 'stderr.log'), bytes))
      evidence.bootstrap = await application.evaluate(({ app }) => ({ argv: process.argv, ready: app.isReady(), electron: process.versions.electron }))
      page = await application.firstWindow()
      page.setDefaultTimeout(4000)
      page.on('pageerror', error => evidence.errors.push(error.message))
      page.on('console', message => fs.appendFileSync(path.join(data, 'console.log'), message.type() + ': ' + message.text() + '\n'))
      await page.evaluate(() => document.addEventListener('change', event => console.log('fixture-change', event.target.dataset.field || event.target.dataset.functionId, Boolean(document.body), document.querySelectorAll('[data-action=save]').length), true))
      await page.locator('.first-use-layer:not([hidden])').waitFor()
      const context = { page, paths: { qaRoot: data, userData: path.join(data, 'userData') }, state: {},
        async type(locator, text) { await locator.fill(text) },
        async select(locator, value) { await locator.selectOption(value) },
        async step(id, action) { const result = await action(); evidence.events.push({ id, result }); return result },
        async capture(name) { await page.screenshot({ path: path.join(data, name + '.png') }) } }
      const { quietNewPageTips } = requireApp('./tools/lib/page2-native-scenarios.cjs')
      evidence.guidePreparation = await quietNewPageTips(context)
      await page.reload()
      await page.locator('.first-use-launch').waitFor()
      assert.equal(await page.locator('.first-use-layer').isVisible(), false)
      evidence.guideReload = await page.evaluate(() => JSON.parse(localStorage.getItem('mc.set.feature_guides.v1')))
      assert.deepEqual(evidence.guideReload, evidence.guidePreparation.states.at(-1))
      const { scenarios } = requireApp('./tools/lib/page2-native-role-scenarios.cjs')
      evidence.requiredCases = scenarios.map(scenario => scenario.id)
      for (const scenario of scenarios) {
        console.log('Component case: ' + scenario.id)
        try { await scenario.run(context); evidence.results.push({ id: scenario.id, passed: true }) }
        catch (error) { evidence.results.push({ id: scenario.id, passed: false, error: error.message }); throw error }
      }
      assert.deepEqual(evidence.results.map(result => result.id), evidence.requiredCases)
      evidence.writes = await page.evaluate(() => window.roleFixtureReceipt())
      assert.deepEqual(evidence.errors, [])
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible())), false)
      evidence.passed = true
    } catch (error) {
      evidence.passed = false; evidence.failure = error.stack; process.exitCode = 1
      if (page && !page.isClosed()) {
        evidence.finalUrl = page.url()
        try {
          fs.writeFileSync(path.join(data, 'failure.html'), await page.content())
          evidence.domAtFailure = await page.evaluate(() => {
            const describe = element => element ? { tag: element.tagName, className: element.className,
              action: element.dataset?.action, field: element.dataset?.field, type: element.type } : null
            const button = document.querySelector('dialog[open] .rs-editor-footer [data-action="save"]')
            const bounds = button?.getBoundingClientRect()
            const ancestors = []
            for (let item = button; item; item = item.parentElement) {
              const style = getComputedStyle(item), rect = item.getBoundingClientRect()
              ancestors.push({ ...describe(item), rect: rect.toJSON(), scrollTop: item.scrollTop,
                scrollHeight: item.scrollHeight, clientHeight: item.clientHeight,
                display: style.display, visibility: style.visibility, overflow: style.overflow })
            }
            return { body: Boolean(document.body), dialog: Boolean(document.querySelector('dialog[open]')),
              save: button ? { text: button.innerText, disabled: button.disabled, visible: button.checkVisibility(),
                bounds: bounds.toJSON(), hitTarget: describe(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)) } : null,
              active: describe(document.activeElement), editState: document.querySelector('[data-edit-state]')?.textContent,
              ancestors }
          })
        } catch (captureError) { evidence.domCaptureError = captureError.message }
      }
      if (page && !page.isClosed()) {
        try { evidence.visibleText = await page.locator('body').innerText(); await page.screenshot({ path: path.join(data, 'failure.png') }) }
        catch (captureError) { evidence.captureError = captureError.message }
      }
    } finally {
      if (application) await application.close()
      evidence.closed = true
      fs.writeFileSync(path.join(data, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
      console.log('Role component evidence: ' + data)
      console.log(JSON.stringify({ passed: evidence.passed, results: evidence.results, failure: evidence.failure }, null, 2))
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1 })
}
