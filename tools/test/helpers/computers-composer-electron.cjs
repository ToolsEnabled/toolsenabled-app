'use strict'
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url')
const data=process.argv[2];if(!data||fs.realpathSync.native(data)!==data)throw Error('Owned real output required')
for(const key of ['userData','sessionData','logs','crashDumps']){const p=path.join(data,key);fs.mkdirSync(p);app.setPath(key,p)}
app.disableHardwareAcceleration();let win;const report={surfaces:[],pageErrors:[],deniedRequests:[]}
const save=()=>fs.writeFileSync(path.join(data,'observations.json'),JSON.stringify(report,null,2))
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,cb)=>{const allow=d.url.startsWith('data:')||(d.url.startsWith('file:')&&path.dirname(fileURLToPath(d.url))===data);if(!allow)report.deniedRequests.push(d.url);cb({cancel:!allow})})
 win=new BrowserWindow({show:false,width:2560,height:1040,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('console-message',d=>{if(d.level==='error')report.pageErrors.push(d.message)})
 const js=code=>win.webContents.executeJavaScript(code,true)
 const key=k=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:k});if(k.length===1)win.webContents.sendInputEvent({type:'char',keyCode:k});win.webContents.sendInputEvent({type:'keyUp',keyCode:k})}
 const click=info=>{if(!info?.rect)throw Error('Missing target');const {x,y,width,height}=info.rect;for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(x+width/2),y:Math.round(y+height/2)})}
 for(const mode of ['conversation','rail']) {
 const current={mode,stages:[]};report.surfaces.push(current)
 const snapshot=async name=>{const state=await js('wholeComposer.snapshot()');current.stages.push({name,state});save();return state}
 await win.loadFile(path.join(data,'index.html'));current.setup=await js(`wholeComposer.setup(${JSON.stringify(mode)})`)
 if(mode==='rail'){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers:['shift']})}else key('Enter')
 current.ready=await js('wholeComposer.ready()');save()
 await js('wholeComposer.focusComposer()');for(const c of 'unfinished draft')key(c);key('/');await snapshot('slash-mid-draft')
 await js('wholeComposer.clearComposer()');key('/');let s=await snapshot('slash-first-character')
 key('Escape');s=await snapshot('escape-palette');click(s.controls.goal);await snapshot('goal-pointer')
 await js('wholeComposer.clearComposer()');for(const c of 'partial draft')key(c);await js('wholeComposer.pulse()');s=await snapshot('busy-draft');click(s.options);await snapshot('options-pointer')
 for(const c of 'Mention a file')key(c);s=await snapshot('options-filtered');const mention=s.rows.find(row=>row.text.startsWith('Mention a file'));if(!mention?.hit.inside)throw Error('Filtered mention row must be reachable');click(mention);await snapshot('option-mention-pointer')
 s=await snapshot('before-loop');click(s.controls.loop);await snapshot('loop-pointer')
 await js('wholeComposer.pulse()');await snapshot('loop-streaming')
 fs.writeFileSync(path.join(data,mode+'-loop.png'),(await win.webContents.capturePage()).toPNG())
 if(mode==='conversation')key('Escape');else await js(`document.querySelector('[data-rail-tab="chat"]').click()`)
 await snapshot('loop-closed')
 await js('wholeComposer.wrapDialog()');await js('wholeComposer.clearComposer()');key('/');await snapshot('dialog-slash')
 fs.writeFileSync(path.join(data,mode+'-dialog-slash.png'),(await win.webContents.capturePage()).toPNG())
 for(const c of '/loop')key(c);s=await snapshot('dialog-loop-option');const nestedLoop=s.rows.find(row=>row.text.startsWith('/loop'));if(!nestedLoop?.hit.inside)throw Error('Nested loop row must be reachable');click(nestedLoop);await snapshot('dialog-loop')
 await js('wholeComposer.dispose()')
 }
 report.visible=win.isVisible();win.destroy();report.destroyed=win.isDestroyed();save();app.exit(0)
}).catch(error=>{report.failure={message:error.message};if(win&&!win.isDestroyed())win.destroy();save();app.exit(1)})
