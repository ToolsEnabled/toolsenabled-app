'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../../..')
const data = process.argv[2]
if (!data || !path.isAbsolute(data) || !fs.existsSync(data)) throw new Error('An existing isolated user-data directory is required.')
const stage = name => fs.writeFileSync(path.join(data, 'native-stage.json'), JSON.stringify({ stage: name, at: Date.now() }) + '\n', { mode: 0o600 })
stage('starting')
app.setPath('userData', data)
process.env.TOOLSENABLED_STATE_ROOT = path.join(data, 'capability')
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true, mode: 0o700 })
app.commandLine.appendSwitch('disable-gpu')
const { createAgentOrgRecord, loadModules } = require('../../../shell/agent-org-record.cjs')
const record = createAgentOrgRecord({ modules: loadModules({ root: path.join(root, 'capability') }) })
let win
let vite
const server = http.createServer((request, response) => {
  if (request.url.split('?')[0] === '/full') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    vite.transformIndexHtml('/full', fs.readFileSync(path.join(root, 'index.html'), 'utf8'))
      .then(html => response.end(html)).catch(error => { response.writeHead(500); response.end(error.message) })
    return
  }
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/role-studio.css"><style>:root {--paper:#f5f6f8;--sheet:#fff;--ink:#26313d;--ink-2:#566274;--line:#dce1e7;--accent:#477b9b;--font-ui:system-ui;--font-mono:monospace} body{margin:24px;font:14px system-ui}</style></head><body><main id="test"></main></body></html>')
    return
  }
  vite.middlewares(request, response, () => { response.writeHead(404); response.end() })
})
async function main() {
  await app.whenReady()
  vite = await (await import('vite')).createServer({ root, configFile: false, appType: 'custom',
    cacheDir: path.join(data, 'vite-cache'),
    optimizeDeps: { entries: ['index.html'] },
    server: { middlewareMode: true, watch: null, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } } })
  for (const name of ['read', 'createRole', 'editRole', 'resetRole']) {
    ipcMain.handle('role-functions-test:' + name, (event, value) => {
      assert.equal(event.sender, win.webContents)
      return record[name](value)
    })
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, 'role-functions-ui-preload.cjs') } })
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/')
  stage('role-editor')
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {readOrg, buildRoleLibraryBox, snapshotRoleLibrary, restoreRoleLibrary} = await import('/src/org-controls.js');
    const check = (value, label) => { if (!value) throw new Error(label); };
    const callbacks = {onCreate: value => mcOrg.createRole(value), onEdit: value => mcOrg.editRole(value), onReset: value => mcOrg.resetRole(value)};
    let availability = await readOrg();
    check(availability.state === 'ready', 'The real staged role store must be available: ' + JSON.stringify(availability));
    check(availability.functionCatalog.some(row => row.id === 'app.context'), 'The catalog must contain app.context');
    let box = buildRoleLibraryBox({availability, ...callbacks});
    document.querySelector('#test').append(box);
    const waitFor = async (predicate, label) => {
      for (let i=0; i<300; i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
      throw new Error(label);
    };
    const press = selector => { const button=box.querySelector(selector); check(button && !button.disabled, 'Usable button: '+selector); button.click(); };
    const write = (field, value) => { const input=box.querySelector('[data-field="'+field+'"]'); check(input, 'Field '+field); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); };
    const choose = id => press('[data-select-role="'+id+'"]');
    const section = id => press('[data-tab="'+id+'"]');
    press('[data-open-studio]');
    check(box.querySelector('dialog').open, 'The native modal must open');
    check(box.querySelectorAll('[data-node-id]').length === availability.roles.length, 'The canvas must show every real role');
    check(box.querySelector('dialog').getBoundingClientRect().width > 1000, 'The workspace must escape the narrow rail');
    check(box.querySelectorAll('[data-edge-from]').length > 0, 'The canvas must show actual saved reporting connections');
    choose('controller'); write('owns', 'Controller draft must survive saving another role.');
    press('[data-action="new"]');
    write('id', 'hands-free-helper');
    for (const field of ['owns','mustNot','handoff']) write(field, field + ' this explicitly requested task.');
    section('functions');
    const standard = box.querySelector('[data-field="functions-standard"]');
    standard.checked = false; standard.dispatchEvent(new Event('change', {bubbles:true}));
    for (const id of ['app.context','agent.spawn']) {
      const input=box.querySelector('[data-function-id="'+id+'"]'); check(!input.disabled, 'Explicit functions must be selectable');
      input.checked=true; input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    // Exercise the maintained role workspace and its actual stylesheet. The
    // former inline editor is superseded, but its visible-filter contract stays.
    const functionRows = [...box.querySelectorAll('[data-function-row]')];
    const searchFunctions = box.querySelector('[data-function-search]');
    const selectionState = () => functionRows.map(row => {
      const input=row.querySelector('[data-function-id]');
      return [input.dataset.functionId,input.checked,input.disabled];
    });
    const beforeFilter = JSON.stringify(selectionState());
    const allFunctionIds = selectionState().map(row => row[0]);
    check(allFunctionIds.length > 1, 'Filtering needs multiple actual installed functions');
    const filterFunctions = query => {
      searchFunctions.value=query; searchFunctions.dispatchEvent(new Event('input',{bubbles:true}));
      check(JSON.stringify(selectionState())===beforeFilter, 'Search must preserve selected and disabled function choices');
      return functionRows.filter(row => row.getClientRects().length > 0 && getComputedStyle(row).display!=='none')
        .map(row => row.querySelector('[data-function-id]').dataset.functionId);
    };
    const matching = filterFunctions('APP.CONTEXT');
    check(JSON.stringify(matching)===JSON.stringify(['app.context']), 'The current role workspace must visibly hide nonmatching functions');
    check(functionRows.filter(row => !row.hidden).length===1, 'Semantic hidden state must match the visible filter');
    check(filterFunctions('no-installed-function-can-match-this-qa-query').length===0, 'No-match search must remove every function from layout');
    const restored = filterFunctions('');
    check(JSON.stringify(restored)===JSON.stringify(allFunctionIds), 'Clearing search must restore every original function in order');
    const filterEvidence = {rows:allFunctionIds.length,matching,noMatch:0,restored:restored.length};
    const direct=box.querySelector('[data-field="direct-user"]'); direct.checked=true; direct.dispatchEvent(new Event('change',{bubbles:true}));
    press('[data-action="save"]');
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent === 'Role created.', 'Create must complete');
    choose('controller'); section('directions');
    check(box.querySelector('[data-field="owns"]').value === 'Controller draft must survive saving another role.', 'Saving another role must not discard existing drafts');
    choose('hands-free-helper'); section('functions');
    const settings = box.querySelector('[data-function-id="settings.read"]'); settings.checked=true; settings.dispatchEvent(new Event('change',{bubbles:true}));
    const search=box.querySelector('[data-function-search]'); search.value='settings.read'; search.dispatchEvent(new Event('input',{bubbles:true}));
    check([...box.querySelectorAll('[data-function-row]')].filter(row=>!row.hidden).every(row=>row.textContent.includes('settings.read')), 'Search must filter visible functions');
    const saved = snapshotRoleLibrary(box);
    availability = await readOrg();
    check(availability.state === 'ready', 'Store stays readable');
    const replacement=buildRoleLibraryBox({availability,...callbacks}); box.replaceWith(replacement); box=replacement;
    restoreRoleLibrary(box,saved);
    check(box.querySelector('dialog').open, 'An open workspace must survive a route remount');
    check(box.querySelector('[data-function-id="settings.read"]').checked, 'Unsaved choices must survive a remount');
    press('[data-action="save"]');
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent==='Role saved.', 'Save must complete');
    choose('controller'); section('directions');
    check(box.querySelector('[data-field="owns"]').value === 'Controller draft must survive saving another role.', 'Inactive drafts must survive remount and save');
    const current=(await readOrg()).roles.find(r=>r.id==='controller');
    await mcOrg.editRole({id:'controller',expectedRevision:current.revision,rules:{owns:'Saved elsewhere.',mustNot:current.mustNot,handoff:current.handoff}});
    press('[data-action="save"]');
    await waitFor(()=>box.querySelector('.rs-conflict'), 'A stale save must expose a conflict');
    check((await readOrg()).roles.find(r=>r.id==='controller').owns==='Saved elsewhere.', 'A stale draft must not overwrite another window');
    check(box.querySelector('[data-field="owns"]').value==='Controller draft must survive saving another role.', 'Conflict must preserve local text');
    press('[data-action="keep-draft"]'); press('[data-action="save"]');
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent==='Role saved.', 'Explicit conflict resolution must save');
    check((await readOrg()).roles.find(r=>r.id==='controller').owns==='Controller draft must survive saving another role.', 'Reviewed draft must persist');
    press('[data-action="reset"]');
    check(box.querySelector('.rs-reset-confirm').textContent.includes('function'), 'Reset must explain it restores the full policy');
    press('[data-action="cancel-reset"]');
    const beforeImport=(await readOrg()).roles.find(r=>r.id==='hands-free-helper');
    const importedDoc={format:'toolsenabled.role',version:1,id:beforeImport.id,baseDefaultRole:null,
      rules:{owns:'Imported context.\\n\\n'+'Useful context. '.repeat(180)+'Return evidence.',mustNot:beforeImport.mustNot,handoff:beforeImport.handoff},
      functions:[...beforeImport.functions,'retired.function'],requiresDirectUserAuthorization:true};
    const transfer=new DataTransfer(); transfer.items.add(new File([JSON.stringify(importedDoc)],'helper.role.json',{type:'application/json'}));
    const file=box.querySelector('[data-import-file]'); file.files=transfer.files; file.dispatchEvent(new Event('change',{bubbles:true}));
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent.includes('File opened as a draft'), 'Import must open a reviewable draft');
    check((await readOrg()).roles.find(r=>r.id===importedDoc.id).owns===beforeImport.owns, 'Import must not write before Save');
    section('functions');
    const retired=box.querySelector('[data-function-id="retired.function"]'); check(retired?.checked, 'Unavailable exact function names must be retained');
    retired.checked=false; retired.dispatchEvent(new Event('change',{bubbles:true}));
    press('[data-action="save"]');
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent==='Role saved.', 'Imported draft must save');
    check((await readOrg()).roles.find(r=>r.id===importedDoc.id).owns===importedDoc.rules.owns, 'Long imported context must persist exactly');
    const manager=(await readOrg()).roles.find(r=>r.id==='manager');
    await mcOrg.editRole({id:'manager',expectedRevision:manager.revision,rules:{owns:manager.owns,mustNot:manager.mustNot,handoff:manager.handoff},capabilities:{...manager.capabilities,mayWakeReports:false}});
    box.setRoles((await readOrg()).roles);
    press('[data-action="new"]'); write('id','scoped-manager');
    const base=box.querySelector('[data-field="base"]'); base.value='manager'; base.dispatchEvent(new Event('change',{bubbles:true}));
    check(box.querySelector('[data-field="owns"]').value===manager.owns, 'Starting from a role must fill the directions');
    press('[data-action="save"]');
    await waitFor(()=>box.querySelector('[data-roles="out"]').textContent==='Role created.', 'A role based on edited defaults must save');
    check((await readOrg()).roles.find(r=>r.id==='scoped-manager').capabilities.mayWakeReports===false, 'Creation must use the base abilities displayed in the editor');
    await mcOrg.resetRole({id:'manager'}); box.setRoles((await readOrg()).roles);

    press('[data-action="close"]'); press('[data-open-studio]');
    choose('manager'); section('directions');
    check(box.querySelector('[data-field="handoff"]').value.includes('working folder'), 'Current default context guidance must be available to edit');
    return {ok:true,filter:filterEvidence};
  })()`)
  assert.equal(result.ok, true)
  const capture = async name => {
    await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(data, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  await capture('role-workspace')
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="canvas"]').click()`)
  await capture('role-canvas')
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="fit"]').click(); const canvas=document.querySelector('[data-canvas]'); if(canvas.scrollWidth>canvas.clientWidth+1 || canvas.scrollHeight>canvas.clientHeight+1) throw new Error('Fit must show the entire role canvas on both axes.'); document.querySelector('[data-drag-role="manager"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}));`)
  await capture('role-canvas-arranged')
  await win.webContents.executeJavaScript(`document.querySelector('[data-select-role="manager"]').click(); document.querySelector('[data-tab="functions"]').click(); const search=document.querySelector('[data-function-search]'); search.value='app.context'; search.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-function-id="app.context"]').closest('details').open=true;`)
  await capture('role-function-detail')
  await win.webContents.executeJavaScript(`document.documentElement.style.cssText='--paper:#131e35;--sheet:#1b2943;--ink:#eef3fa;--ink-2:#b9c8dd;--line:#36465e;--accent:#94c9ed;--font-ui:system-ui;--font-mono:monospace'; document.querySelector('[data-tab="directions"]').click();`)
  await capture('role-workspace-dark')
  win.setSize(620, 850)
  await capture('role-workspace-narrow')
  const dimensions=await win.webContents.executeJavaScript(`(() => { const modal=document.querySelector('dialog'), main=document.querySelector('[data-studio-main]'); return {width:innerWidth,modalWidth:modal.getBoundingClientRect().width,mainWidth:main.clientWidth,scrollWidth:main.scrollWidth}; })()`)
  assert.ok(dimensions.modalWidth<=dimensions.width, JSON.stringify(dimensions))
  assert.ok(dimensions.scrollWidth<=dimensions.mainWidth+1, 'The narrow editor must not require horizontal scrolling: '+JSON.stringify(dimensions))
  const saved = record.read().roles.find(role => role.id === 'hands-free-helper')
  assert.deepEqual(saved.functions, ['agent.spawn', 'app.context', 'settings.read'])
  assert.equal(saved.requiresDirectUserAuthorization, true)
  assert.equal(saved.capabilities.mayClaimWork, false)
  const persisted = createAgentOrgRecord({ modules: loadModules({ root: path.join(root, 'capability') }) })
  stage('role-persisted')
  assert.deepEqual(persisted.read().roles.find(role => role.id === saved.id).functions, saved.functions)
  // Drive the actual MCP dispatcher and new registry entry into the real
  // application reader. Session ownership is a fixture; the reader, dispatcher,
  // role policy, tier policy and role store are production implementations.
  const principal = { kind: 'agent-session', sessionId: 'context-test', agentId: 'custom-helper',
    provider: 'local', roleId: 'hands-free-helper', expectedOrgRevision: 0, expectedRoleRevision: saved.revision }
  const contexts = new Map([[principal.sessionId, {
    agentId: principal.agentId, ownerKind: 'window', owner: win.webContents, state: 'ready', turnsCompleted: 0,
  }]])
  const contextHost = require('../../../shell/app-context.cjs').createAppContextReader({ sessions: contexts, readOrg: () => record.read() })
  require(path.join(root, 'capability/src/lib/app-context.js')).installAppContextHost(contextHost)
  const mcp = require(path.join(root, 'capability/src/mcp-server.js'))
  const options = { agentActor: 'local', agentId: principal.agentId, agentSessionId: principal.sessionId,
    agentPrincipal: principal, agentRole: { functions: saved.functions, requiresDirectUserAuthorization: true },
    permissionSession: { origin: 'local', tier: 'confined', profile: 'read-only' } }
  const discovered = await mcp.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, options)
  stage('mcp-discovered')
  assert.deepEqual(discovered.tools.map(tool => tool.name).sort(), ['app.context', 'settings.read'])
  const response = await mcp.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'app.context', arguments: {} } }, options)
  stage('mcp-context-returned')
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent))
  assert.equal(response.structuredContent.kind, 'app-context')
  assert.equal(response.structuredContent.route, '/')
  assert.deepEqual(response.structuredContent.sessions.map(row => row.sessionId), ['context-test'])
  // The shipping page must expose the workspace through its own toolbar and
  // styles, in addition to the isolated component interaction proof above.
  win.setSize(1440, 960)
  win.showInactive()
  const pageErrors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') pageErrors.push(event.message) })
  await win.loadURL('http://127.0.0.1:' + server.address().port + '/full#/computers')
  stage('full-computers-loaded')
  const fullPage = await win.webContents.executeJavaScript(`(async () => {
    let activated=false, blockedFrames=0, moreOpened=false;
    for(let i=0;i<300;i++) {
      const view=document.querySelector('#stage > .view:not([inert])');
      const button=view?.querySelector('[data-open-role-workspace]');
      const more=button?.closest('details.tree-more');
      if(more && !more.open) {
        const summary=more.querySelector('summary'), bounds=summary.getBoundingClientRect();
        const hit=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
        if(summary.contains(hit)) { summary.click(); moreOpened=true; }
        await new Promise(resolve=>setTimeout(resolve,20));
        continue;
      }
      const rect=button?.getBoundingClientRect();
      const target=rect && document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      // A view-transition snapshot can intercept input after the underlying
      // view already reports opacity1. Do not bypass it with a DOM-only click.
      if(button && !button.hidden && !button.disabled && view && getComputedStyle(view).opacity==='1'
          && button.contains(target)) { button.click(); activated=true; break; }
      if(button && !button.contains(target)) blockedFrames++;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(!activated) throw new Error('The Roles toolbar button never became a usable native hit target.');
    // Opening the Configuration details and its modal happens in one click.
    // Give native layout its paint boundary before testing pointer hit targets.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const modal=document.querySelector('dialog.role-studio');
    if (!modal?.open) throw new Error('The full Computers toolbar did not open the role workspace.');
    const bounds=modal.getBoundingClientRect();
    if(bounds.width<1000 || bounds.height<700) throw new Error('The app layout constrained the workspace: '+JSON.stringify(bounds));
    const center=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    if(!modal.contains(center)) throw new Error('The full-page workspace is not visibly on top: '+JSON.stringify({
      bounds, viewport:{width:innerWidth,height:innerHeight}, center:center?.outerHTML?.slice(0,500) || null,
      modalStyle:{display:getComputedStyle(modal).display,visibility:getComputedStyle(modal).visibility,opacity:getComputedStyle(modal).opacity,pointerEvents:getComputedStyle(modal).pointerEvents},
      ancestors:[...function*(){for(let node=modal;node;node=node.parentElement)yield {tag:node.tagName,classes:node.className,inert:node.inert,hidden:node.hidden,open:node.open,pointerEvents:getComputedStyle(node).pointerEvents};}()],
    }));
    return {buttonHitTargetVerified:true,modalHitTargetVerified:true,moreOpened,blockedFrames};
  })()`)
  fs.writeFileSync(path.join(data, 'role-toolbar-layout.json'), JSON.stringify(fullPage, null, 2))
  await capture('role-workspace-full-app')
  assert.deepEqual(pageErrors.filter(message => /ReferenceError|TypeError|SyntaxError/.test(message)), [], 'The full page must have no script errors')
  console.log(JSON.stringify({ ok: true, selected: saved.functions, policy: saved.requiresDirectUserAuthorization, screenshots: data, filter: result.filter, fullPage }))
  stage('checked')
  win.destroy()
  await new Promise(resolve => server.close(resolve))
  await vite.close()
  app.quit()
}
main().catch(async error => {
  fs.writeFileSync(path.join(data, 'native-error.log'), error.stack || String(error), { mode: 0o600 })
  if (win && !win.isDestroyed()) {
    try {
      const diagnostic = await win.webContents.executeJavaScript(`(() => {
        const describe = node => node ? {tag:node.tagName,classes:node.className,rect:node.getBoundingClientRect().toJSON(),hidden:node.hidden,inert:node.inert} : null;
        const button=document.querySelector('[data-open-role-workspace]'), rect=button?.getBoundingClientRect();
        return {url:location.href,viewport:{width:innerWidth,height:innerHeight},visibility:document.visibilityState,
          button:describe(button),hit:describe(rect&&document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),
          modals:[...document.querySelectorAll(':modal')].map(describe),bodyZoom:getComputedStyle(document.body).zoom};
      })()`)
      fs.writeFileSync(path.join(data, 'native-refusal.json'), JSON.stringify(diagnostic, null, 2)+'\n')
      fs.writeFileSync(path.join(data, 'native-refusal.png'), (await win.webContents.capturePage()).toPNG())
    } catch (failure) { console.error('Native refusal capture failed: '+failure.message) }
  }
  console.error(error.stack || String(error)); app.exit(1)
})
