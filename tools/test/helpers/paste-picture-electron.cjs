'use strict'
/* T18 native scenario, main process half. Hidden window, own user-data-dir,
   real key events. Adapted from computers-composer-electron.cjs. */
const { app, BrowserWindow, session, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')

const data = process.argv[2]
if (!data || fs.realpathSync.native(data) !== data) throw Error('Owned real output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const p = path.join(data, key); fs.mkdirSync(p); app.setPath(key, p) }
app.disableHardwareAcceleration()

let win
const report = { surfaces: [], pageErrors: [], deniedRequests: [] }
const save = () => fs.writeFileSync(path.join(data, 'observations.json'), JSON.stringify(report, null, 2))
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  // The session/provider is a fixture. Its paste and image-queue authority are
  // the real command surface and main-process implementation, over private IPC.
  const mainPath = path.resolve(__dirname, '../../../shell/main.cjs')
  const mainRequire = createRequire(mainPath)
  const source = fs.readFileSync(mainPath, 'utf8')
  const { parseAst } = await import('rollup/parseAst')
  const ast = parseAst(source)
  const functions = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend', 'parseAgentPasteAttachment']
    .map(name => {
      const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name)
      if (!node) throw Error('Missing actual main helper: ' + name)
      return source.slice(node.start, node.end)
    }).join('\n')
  const constants = ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH', 'MAX_PASTE_IMAGE_BYTES', 'MAX_PASTE_IMAGE_DATA_LENGTH', 'PASTE_IMAGE_MIME_EXTENSIONS']
  const limits = ast.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
    .filter(n => constants.includes(n.id.name)).map(n => 'const ' + source.slice(n.start, n.end) + ';').join('\n')
  const helpers = new Function(limits + '\n' + functions + '; return { ' + [...functions.matchAll(/function (\w+)\(/g)].map(m => m[1]).join(',') + ', MAX_SESSION_ID_LENGTH, MAX_PASTE_IMAGE_BYTES };')()
  const queueNode = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'runImageQueue')
  if (!queueNode) throw Error('Missing actual native image queue')
  const { createAgentCommandSurface, REQUIRED_DEPS } = mainRequire('./agent-command-surface.cjs')
  const { createImageOwnerContext } = mainRequire('./image-owner-context.cjs')
  const engineRoot = process.argv[3]
  if (!engineRoot) throw Error('The paired engine root is required')
  let fixture
  const channel = (name, run) => ipcMain.handle('paste-fixture:' + name, async (event, value) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Foreign fixture sender')
    try { return { value: await run(value) } }
    catch (error) { return { error: { code: error.code || 'FIXTURE_FAILURE', message: error.message } } }
  })
  channel('owner-context', () => fixture.surface.run('agent:owner-context', {}, fixture.principal))
  channel('paste', async request => {
    const result = await fixture.surface.run('agent:paste-attachment', request, fixture.principal)
    if (result.ok) fixture.pasted.push({ mime: request.mime, path: result.path, data: fs.readFileSync(result.path).toString('base64') })
    return result
  })
  channel('queue', async request => {
    const result = await fixture.surface.run('agent:image-queue', request, fixture.principal)
    fixture.operations.push({ operation: request.operation, ok: result.ok, code: result.code || null,
      deliveryDisposition: result.deliveryDisposition || null, result: result.result || null })
    return result
  })
  channel('observations', () => ({ pasted: fixture.pasted, sent: fixture.sent, operations: fixture.operations }))
  function beginSurface(mode, provider, revokeAttachment) {
    const principal = { kind: 'window', owner: win.webContents, label: 'the private fixture window', mayWrite: true }
    const productOwner = 'paste-fixture-' + mode
    const gate = createImageOwnerContext({ scope: data, readState: () => ({ principal: productOwner, signedIn: false }) })
    const sessions = new Map([['fixture-session', { owner: principal.owner, state: 'running', metricsPrincipal: productOwner, attachments: new Set() }]])
    const current = { principal, pasted: [], sent: [], operations: [] }
    const host = {
      providerForTier: () => provider,
      sessionTranscriptMetadata: () => ({ account: 'default', provider }),
      sessionDeliverySettings: () => ({ model: 'fixture-model', effort: null, busy: false }),
      holdQueuedUserMessage() {},
      async sendTurnTracked(request) {
        current.sent.push({ ...request, images: request.images.map(image => ({ path: image.path })),
          imageBytes: request.images.map(image => fs.readFileSync(image.path).toString('base64')) })
        return { ok: true, deliveryDisposition: 'accepted', result: { turnId: 'fixture-turn-' + current.sent.length } }
      },
    }
    const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([name, kind]) => [name,
      kind === 'function' ? () => { throw Error('Unexpected fixture dependency: ' + name) } : kind === 'number' ? 128 : kind === 'string' ? data : {}]))
    Object.assign(deps, helpers, { agentSessions: sessions, currentAgentHost: () => host,
      rendererSafeAgentError: error => error, requireModule: mainRequire, resolveCapabilityRoot: () => engineRoot,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, AGENT_EFFORT_VALUES: [],
      statFile: fs.promises.stat, recordAcceptedTranscriptSend: async () => {},
      imageOwnerContext: () => gate.read(),
      savePasteAttachment: (mime, bytes) => {
        const target = path.join(data, mode + '-' + randomUUID() + '.png')
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
        return { path: target, size: bytes.length }
      },
    })
    const surface = createAgentCommandSurface(deps)
    const commands = { ...surface, sendImageEnvelope: (request, owner) => {
      // Revoke the native reissued grant immediately before the actual send
      // allowlist check. The host transport must never receive this turn.
      if (revokeAttachment) for (const image of request.images) sessions.get(request.sessionId).attachments.delete(image.path)
      return surface.sendImageEnvelope(request, owner)
    } }
    const environment = { ...helpers, getImageOwnerContext: () => gate, getAgentCommandSurface: () => commands,
      accountPrincipal: () => productOwner, agentSessions: sessions, agentHost: host,
      transcriptCapture: { bindingFor: id => id === 'fixture-session' ? { nodeId: 'fixture-manager' } : null },
      require: mainRequire, path, app, resolveCapabilityRoot: () => engineRoot }
    deps.imageQueue = new Function(...Object.keys(environment), 'return (' + source.slice(queueNode.start, queueNode.end) + ')')(...Object.values(environment))
    current.surface = surface
    fixture = current
  }
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const allow = d.url.startsWith('data:') || (d.url.startsWith('file:') && path.dirname(fileURLToPath(d.url)) === data)
    if (!allow) report.deniedRequests.push(d.url)
    cb({ cancel: !allow })
  })
  win = new BrowserWindow({ show: false, width: 2560, height: 1040, useContentSize: true, webPreferences: { preload: path.join(data, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('console-message', d => { if (d.level === 'error') report.pageErrors.push(d.message) })
  const js = code => win.webContents.executeJavaScript(code, true)
  const key = k => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k })
    if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k })
  }
  const png = fs.readFileSync(path.join(data, 'fixture.png')).toString('base64')
  const scenario = JSON.parse(fs.readFileSync(path.join(data, 'scenario.json'), 'utf8'))
  /* BOTH SURFACES THE OWNER USES: the full tree conversation and the right
     rail. A picture that works in one and not the other is still the defect. */
  for (const mode of ['conversation', 'rail']) {
    const current = { mode, steps: [] }
    report.surfaces.push(current)
    beginSurface(mode, scenario.provider, scenario.revokeAttachment)
    await win.loadFile(path.join(data, 'index.html'))
    current.provider = scenario.provider
    current.revokeAttachment = scenario.revokeAttachment
    current.setup = await js(`pastePicture.setup(${JSON.stringify(mode)}, ${JSON.stringify(png)})`)
    /* Open the conversation the same way a person does: Enter on the focused
       node for the full conversation, Shift+Enter for the rail. */
    if (mode === 'rail') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] })
    } else key('Enter')
    current.ready = await js('pastePicture.ready()')
    current.idle = await js('pastePicture.idle()')
    await js('pastePicture.focusComposer()')
    current.pasted = await js('pastePicture.paste()')
    save()
    fs.writeFileSync(path.join(data, mode + '-after-paste.png'), (await win.webContents.capturePage()).toPNG())
    current.typed = await js(`pastePicture.type(${JSON.stringify('what is in this picture?')})`)
    /* THE SEND IS A REAL KEYSTROKE, not a call into the view. */
    key('Enter')
    current.result = await js('pastePicture.afterSend()')
    save()
    fs.writeFileSync(path.join(data, mode + '-after-send.png'), (await win.webContents.capturePage()).toPNG())
    await js('pastePicture.dispose()')
  }
  report.visible = win.isVisible()
  win.destroy()
  report.destroyed = win.isDestroyed()
  save()
  app.exit(0)
}).catch(error => {
  report.failure = { message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) win.destroy()
  save()
  app.exit(1)
})
