const { app, BrowserWindow, ipcMain, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const {execFileSync}=require('node:child_process')
process.on('uncaughtException',error=>{console.error(error.stack);app.exit(1)})
const { randomUUID } = require('node:crypto')
const { pathToFileURL, fileURLToPath } = require('node:url')
const source = path.resolve(__dirname, '../../..')
const mainRequire = require('node:module').createRequire(path.join(source, 'shell/main.cjs'))
const { createDiffFiles } = require(source + '/shell/diff-file.cjs')
const { createSessionProfileStore } = require(source + '/shell/session-profiles.cjs')
const { bindSessionChangePaths } = require(source + '/shell/session-change-paths.cjs')
const data = process.argv[2]
if (!data || path.resolve(data) !== data || fs.realpathSync.native(data) !== data) throw Error('Isolated destination required')
app.setName('ToolsEnabled isolated diff host audit')
for (const key of ['userData','sessionData','logs','crashDumps']) {
  const directory=path.join(data,key)
  if(!fs.existsSync(directory))fs.mkdirSync(directory)
  assert(fs.lstatSync(directory).isDirectory()&&!fs.lstatSync(directory).isSymbolicLink())
  assert.equal(fs.realpathSync.native(directory),directory)
  app.setPath(key,directory)
}
app.disableHardwareAcceleration()
const report = { pageErrors: [], deniedRequests: [], reads: [], pickCount: 0, hand: [] }
assert.equal(app.commandLine.getSwitchValue('user-data-dir'),path.join(data,'userData'))
if(process.platform==='win32') {
  const identity=JSON.parse(execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}" | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`],
    {windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,PSModulePath:''}}))
  assert.equal(identity.ProcessId,process.pid);assert(identity.CreationDate)
  assert(identity.CommandLine.includes('--user-data-dir='+path.join(data,'userData')))
  report.identity={pid:identity.ProcessId,creationDate:identity.CreationDate,userData:path.join(data,'userData')}
} else report.identity={pid:process.pid,userData:path.join(data,'userData')}
fs.writeFileSync(path.join(data,'identity-ready.json'),JSON.stringify(report.identity,null,2)+'\n',{flag:'wx'})
let win
const save = () => fs.writeFileSync(path.join(data,'observations.json'), JSON.stringify(report,null,2)+'\n')
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const { declaredFunctionSource } = await import(pathToFileURL(source+'/tools/test/lib/declared-function-source.mjs'))
  const chosen = path.join(data,'chosen'), owned = path.join(data,'app-owned'), profiled = path.join(data,'registered-project')
  for (const directory of [chosen,owned,profiled]) fs.mkdirSync(directory)
  const profiles = createSessionProfileStore({ file:path.join(data,'synthetic-session-profiles.json') })
  const profile = profiles.create({ name:'Synthetic separate project',cwd:profiled })
  const profileCwd = profiles.resolveCwd(profile.id)
  report.profileResolvedOutsideDefaultRoots = profileCwd === profiled && profileCwd !== chosen && profileCwd !== owned
  const mainSource = fs.readFileSync(source+'/shell/main.cjs','utf8')
  const defaultFiles = new Function('createDiffFiles','fs','path','randomUUID','chosenWorkspaceCwd','ensureWorkspaceRoot',
    'let diffFiles=null;'+declaredFunctionSource(mainSource,'getDiffFiles')+';return getDiffFiles()')(
      createDiffFiles,fs,path,randomUUID,()=>chosen,()=>owned)
  const canonicalRoot = JSON.parse(fs.readFileSync(path.join(data,'inputs.json'),'utf8')).canonicalRoot
  const agentSessions = new Map()
  const access = new Function('require','fs','path','resolveCapabilityRoot','workspaceCeilingModule','agentSessions','rendererPrefs','sessionProfiles','SHELL_PROFILE_FENCE','getDiffFiles',
    'let sessionDiffAccess=null;'+declaredFunctionSource(mainSource,'getSessionDiffAccess')+';return getSessionDiffAccess()')(
    mainRequire,fs,path,()=>canonicalRoot,()=>require(path.join(canonicalRoot,'src/lib/session-workspace-ceiling.js')),agentSessions,{snapshot:()=>({ok:true,values:{}})},profiles,JSON.parse(fs.readFileSync(path.join(data,'inputs.json'),'utf8')).profileRoot,()=>defaultFiles)
  const cases = [
    {id:'chosen-modified',cwd:chosen,file:'modified.txt',kind:'update',before:'before\n',after:'after\n',diff:'@@ -1 +1 @@\n-before\n+after\n'},
    {id:'chosen-added-untracked',cwd:chosen,file:'added.txt',kind:'add',before:'',after:'new\n',diff:'@@ -0,0 +1 @@\n+new\n'},
    {id:'chosen-deleted',cwd:chosen,file:'deleted.txt',kind:'delete',before:'removed\n',after:'',diff:'@@ -1 +0,0 @@\n-removed\n'},
    {id:'profile-modified',cwd:profileCwd,file:'profile.txt',kind:'update',before:'before\n',after:'after\n',diff:'@@ -1 +1 @@\n-before\n+after\n'},
    {id:'profile-added-untracked',cwd:profileCwd,file:'profile-new.txt',kind:'add',before:'',after:'new\n',diff:'@@ -0,0 +1 @@\n+new\n'},
  ].map(sample => {
    if (sample.kind !== 'delete') fs.writeFileSync(path.join(sample.cwd,sample.file),sample.after)
    const packet = (type,payload) => bindSessionChangePaths({ sessionId:sample.id,event:{type,tool:'fileChange',turnId:'synthetic-turn',toolCallId:'synthetic-edit',payload} },sample.cwd,path)
    return {id:sample.id, packets:[packet('tool_call',{changes:[{path:sample.file,kind:{type:sample.kind},diff:sample.diff}]}),packet('tool_result',{status:'completed'})]}
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const permitted = details.url.startsWith('data:') || details.url.startsWith('file:') && path.dirname(fileURLToPath(details.url)) === data
    if (!permitted) report.deniedRequests.push(details.url)
    callback({cancel:!permitted})
  })
  win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{
    preload:path.join(data,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  win.webContents.on('console-message',details=>{if(details.level==='error')report.pageErrors.push(details.message)})
  for (const sample of cases) agentSessions.set(sample.id,{owner:win.webContents,ownerKind:'window',cwd:sample.id.startsWith('profile-')?profileCwd:chosen,profileId:sample.id.startsWith('profile-')?profile.id:null,started:{sequence:1},state:'ready'})
  const own = event => event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame
  ipcMain.handle('audit:inputs',event=>{if(!own(event))throw Error('Own sender required');return cases})
  ipcMain.handle('mc-diff:read-change',(event,request)=>{
    if(!own(event))throw Error('Own sender required')
    const result=access.read(event.sender,request)
    report.reads.push({file:path.basename(request.path),ok:result.ok,code:result.code||null})
    return result
  })
  ipcMain.handle('mc-diff:stamp',(event,request)=>{if(!own(event))throw Error('Own sender required');return access.stamp(event.sender,request)})
  ipcMain.handle('mc-diff:save',(event,request)=>{if(!own(event))throw Error('Own sender required');return access.write(event.sender,request)})
  ipcMain.handle('mc-diff:pick',()=>{report.pickCount++;throw Error('Unexpected picker')})
  await win.loadFile(path.join(data,'index.html'))
  report.cases=await win.webContents.executeJavaScript('runDiffHostAudit()',true)
  const js=code=>win.webContents.executeJavaScript(code,true)
  const pause=()=>new Promise(resolve=>setTimeout(resolve,40))
  async function waitFor(code) {
    const end=Date.now()+5000
    while(!await js(code)){assert(Date.now()<end,'UI did not settle: '+code);await pause()}
  }
  async function click(selector) {
    const point=await js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Enabled control required');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    assert(point.x>=0&&point.y>=0)
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
    await pause()
  }
  for(const sample of cases) {
    const width=sample.id==='profile-added-untracked'?540:1100
    win.setContentSize(width,900)
    await js(`prepareDiffHandCase(${JSON.stringify(sample.id)})`)
    await click('[data-chat-open-diff]')
    await waitFor(`Boolean(document.querySelector('[data-diff-pane="proposed"]')&&!document.querySelector('[data-diff-pane="proposed"]').disabled)`)
    const side=sample.id==='chosen-deleted'?'original':'proposed'
    await click(`[data-diff-action="edit-line"][data-diff-side="${side}"]`)
    const editedText='Owner correction for '+sample.id+'\n'
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']})
    await waitFor(`(()=>{const box=document.querySelector('[data-diff-pane="${side}"]');return document.activeElement===box&&box.selectionStart===0&&box.selectionEnd===box.value.length})()`)
    await win.webContents.insertText(editedText)
    await waitFor(`document.querySelector('[data-diff-pane="${side}"]').value===${JSON.stringify(editedText)}`)
    const caretBefore=await js(`document.querySelector('[data-diff-pane="${side}"]').selectionStart`)
    await waitFor(`document.querySelector('[data-live-diff]').textContent.includes(${JSON.stringify(editedText.trim())})`)
    const caretPreserved=await js(`document.activeElement===document.querySelector('[data-diff-pane="${side}"]')&&document.activeElement.selectionStart===${caretBefore}`)
    const liveUpdated=await js(`document.querySelector('[data-live-diff]').textContent.includes(${JSON.stringify(editedText.trim())})`)
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await pause()
    fs.writeFileSync(path.join(data,sample.id+'-edited.png'),(await win.webContents.capturePage()).toPNG())
    await click(`.diff-save[data-diff-side="${side}"]`)
    await waitFor(`Boolean(document.querySelector('[data-diff-action="confirm-save"]'))`)
    await click('[data-diff-action="confirm-save"]')
    await waitFor(`document.querySelector('[data-diff-state="${side}"]').textContent.startsWith('Saved.')`)
    const savedVisible=await js(`document.querySelector('[data-diff-state="${side}"]').textContent.startsWith('Saved.')`)
    const savedText=fs.readFileSync(sample.packets[0].event.payload.changes[0].path,'utf8')
    const outerOverflow=await js(`document.documentElement.scrollWidth>innerWidth+1||document.querySelector('.diff-dialog').getBoundingClientRect().right>innerWidth+1`)
    await click('[data-diff-action="close"]')
    await waitFor(`!document.querySelector('.diff-dialog')`)
    await click('[data-chat-open-diff]')
    await waitFor(`document.querySelector('[data-diff-pane="proposed"]')?.value===${JSON.stringify(editedText)}`)
    const reopenedText=await js(`document.querySelector('[data-diff-pane="proposed"]').value`)
    report.hand.push({id:sample.id,width,editedText,savedText,reopenedText,liveUpdated,caretPreserved,savedVisible,outerOverflow})
    save()
    await js('closeDiffHandCase()')
  }
  report.visible=win.isVisible();win.destroy();report.destroyed=win.isDestroyed()
  save();app.exit(0)
}).catch(error=>{report.failure={message:error.message,stack:error.stack};save();if(win&&!win.isDestroyed())win.destroy();app.exit(1)})
