'use strict'
const {app,BrowserWindow,session}=require('electron')
const fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url')
const data=process.argv[2]
if(!data||!path.isAbsolute(data)||fs.realpathSync.native(data)!==data)throw Error('Real isolated output required')
app.setName('ToolsEnabled isolated settings layout')
for(const key of ['userData','sessionData','logs','crashDumps']){const directory=path.join(data,key);fs.mkdirSync(directory);app.setPath(key,directory)}
app.disableHardwareAcceleration()
const report={cases:[],pageErrors:[],deniedRequests:[]};let win
const save=()=>fs.writeFileSync(path.join(data,'observations.json'),JSON.stringify(report,null,2)+'\n')
app.on('window-all-closed',()=>{})
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
    const allowed=details.url.startsWith('data:')||details.url.startsWith('file:')&&path.dirname(fileURLToPath(details.url))===data
    if(!allowed)report.deniedRequests.push(details.url);callback({cancel:!allowed})
  })
  win=new BrowserWindow({show:false,width:1440,height:1000,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  win.webContents.on('console-message',details=>{if(details.level==='error')report.pageErrors.push(details.message)})
  await win.loadFile(path.join(data,'index.html'))
  for(const fixture of [
    {name:'tools-1440',width:1440,category:'tool-use'},
    {name:'tools-1120',width:1120,category:'tool-use'},
    {name:'appearance-900',width:900,category:'appearance'},
    {name:'tools-600',width:600,category:'tool-use',theme:'black'},
    {name:'tools-large-1120',width:1120,category:'tool-use',zoom:1.12},
    {name:'tools-inset-1120',width:1120,pageWidth:720,category:'tool-use',theme:'black'},
    /* THE LANDING CATEGORY, at the same narrow width as tools-600. The quick
       strip is drawn where Settings opens and nowhere else, so the strip and
       the working profile inside it can only be measured here. */
    {name:'landing-600',width:600,category:'this-computer',theme:'black'},
  ]){
    win.setContentSize(fixture.width,1000)
    await win.webContents.executeJavaScript(`settingsReadabilityFixture.open(${JSON.stringify({...fixture,expert:false})})`,true)
    // Enter through the real button, focus handling and native keyboard input.
    const target=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-settings-mode-choice="expert"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(target.x),y:Math.round(target.y)})
    /* WAIT FOR THE DIALOG THE CLICK OPENS. Reading it in the same tick as the
       sendInputEvent was a race, and it lost often: the child died on the
       FIRST fixture with "Cannot read properties of null (reading
       'querySelector')" -- d was null -- and the suite reported only
       "Command failed ... code 1" with an empty stdout and stderr, which
       reads like an environment fault and is not one. Measured on this
       machine: 0 of 4 and 1 of 4 runs completed without this wait, 4 of 4
       with it. */
    await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){if(document.querySelector('.settings-expert-dialog'))return true;await new Promise(r=>setTimeout(r,20))}throw Error('the expert dialog never opened')})()`,true)
    const challenge=await win.webContents.executeJavaScript(`(()=>{const d=document.querySelector('.settings-expert-dialog');return{code:d.querySelector('label strong').textContent,focused:document.activeElement===d.querySelector('input')}})()`)
    if(!challenge.focused)throw Error('Expert entry did not focus its four-digit input')
    for(const keyCode of challenge.code)for(const type of ['keyDown','char','keyUp'])win.webContents.sendInputEvent({type,keyCode})
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'})
    win.webContents.sendInputEvent({type:'char',keyCode:'\r'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'})
    const top=await win.webContents.executeJavaScript('settingsReadabilityFixture.measure()',true)
    fs.writeFileSync(path.join(data,fixture.name+'-top.png'),(await win.webContents.capturePage()).toPNG())
    const content=await win.webContents.executeJavaScript('settingsReadabilityFixture.content()',true)
    fs.writeFileSync(path.join(data,fixture.name+'-content.png'),(await win.webContents.capturePage()).toPNG())
    report.cases.push({...fixture,top,content})
    if(fixture.name==='tools-1120'){
      report.numeric=await win.webContents.executeJavaScript('settingsReadabilityFixture.numeric()',true)
      fs.writeFileSync(path.join(data,'tools-1120-numeric.png'),(await win.webContents.capturePage()).toPNG())
      report.details=await win.webContents.executeJavaScript('settingsReadabilityFixture.details()',true)
      fs.writeFileSync(path.join(data,'tools-1120-details.png'),(await win.webContents.capturePage()).toPNG())
    }
    if(fixture.name==='landing-600'){
      report.profile=await win.webContents.executeJavaScript('settingsReadabilityFixture.profile()',true)
      fs.writeFileSync(path.join(data,'profile-600-feedback.png'),(await win.webContents.capturePage()).toPNG())
    }
    if(fixture.name==='tools-inset-1120'){
      const before=await win.webContents.executeJavaScript('settingsReadabilityFixture.focusCategoryPicker()',true)
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Down'})
      for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Enter'})
      report.categorySelection={before,after:await win.webContents.executeJavaScript('settingsReadabilityFixture.categoryPickerResult()',true)}
    }
  }
  report.final=await win.webContents.executeJavaScript('settingsReadabilityFixture.close()',true)
  report.visible=win.isVisible();win.destroy();report.destroyed=win.isDestroyed();save();app.exit(0)
}).catch(error=>{report.failure={message:error.message,stack:error.stack};save();if(win&&!win.isDestroyed())win.destroy();app.exit(1)})
