'use strict'
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../../..')
const data = process.argv[2]
if (!data || !path.isAbsolute(data)) throw new Error('An explicit isolated user-data path is required')
app.setPath('userData', data)
app.commandLine.appendSwitch('disable-gpu') // UI fixture only; never the inference worker.
app.commandLine.appendSwitch('use-fake-device-for-media-stream') // No physical microphone is opened.
const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/home.css"></head><body><main class="home"><div class="home-ring-wrap"><div class="uring"><svg viewBox="0 0 240 240" aria-hidden="true"><circle class="arc-glow" cx="120" cy="120" r="100" fill="none" stroke="currentColor" stroke-width="4"></circle></svg></div></div></main></body></html>')
    return
  }
  const file = path.resolve(root, '.' + new URL(request.url, 'http://127.0.0.1').pathname)
  const type = { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)]
  if (!file.startsWith(root + path.sep) || !type) { response.writeHead(404); response.end(); return }
  // The production bundler turns a component's CSS import into a stylesheet.
  // Do the same for this raw-module fixture, leaving direct CSS requests intact.
  if (type === 'text/css' && request.headers['sec-fetch-dest'] === 'script') {
    const href = new URL(request.url, 'http://127.0.0.1').pathname + '?stylesheet=1'
    response.setHeader('Content-Type', 'text/javascript')
    response.end(`const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = ${JSON.stringify(href)};
      await new Promise((resolve, reject) => {
        link.onload = resolve; link.onerror = () => reject(new Error('Fixture stylesheet could not load'));
        document.head.append(link);
      });`)
    return
  }
  response.setHeader('Content-Type', type)
  fs.createReadStream(file).on('error', () => { response.writeHead(404); response.end() }).pipe(response)
})
let win
async function main() {
  await app.whenReady()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  let micAllowed = false
  require('../../../shell/voice-permissions.cjs').installVoicePermissions(win.webContents.session, { owns: contents => contents === win.webContents, allows: () => micAllowed })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
  // Exercise both native media-query modes independently of the test machine's setting.
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  const denied = await win.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:true}).then(s => {s.getTracks().forEach(t=>t.stop());return false},()=>true)`)
  assert.equal(denied, true, 'native Chromium microphone must refuse before explicit start')
  micAllowed = true
  const granted = await win.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio:true,video:false}).then(s => {s.getTracks().forEach(t=>t.stop());return true})`)
  assert.equal(granted, true, 'native synthetic microphone passes only while voice is active')
  const cameraDenied = await win.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({video:true}).then(s => {s.getTracks().forEach(t=>t.stop());return false},()=>true)`)
  assert.equal(cameraDenied, true)
  const result = await win.webContents.executeJavaScript(`(async () => {
    const starts = [], stops = [], send = [], replies = [], listeners = {};
    localStorage.setItem('mc.fleet.trees.v1:voice-computer', JSON.stringify({version:1,computerId:'voice-computer',
      trees:[{id:'voice-tree',name:'Voice',createdAt:'2026-09-06T00:00:00Z',updatedAt:'2026-09-06T00:00:00Z',profileId:null}],
      nodes:[{id:'coordinator-node',treeId:'voice-tree',parentId:null,role:'coordinator-assistant',nameBase:'Coordinator assistant',
        nameOrdinal:1,sessionId:'previous-session',message:'Be my voice assistant',status:'finished',tier:'luna',
        createdAt:'2026-09-06T00:00:00Z',updatedAt:'2026-09-06T00:00:00Z'}]}));
    window.mcVoice = {
      targets: async () => [{sessionId:'coordinator',agentId:'coordinator-node',state:'ready'}, {sessionId:'worker',agentId:'Worker',state:'ready'}],
      start: async value => { starts.push(value); return {sessionId:'voice-'+starts.length,targetAgentId:value.targetAgentId,generation:starts.length,speechEpoch:0} },
      stop: async () => stops.push(true),
      offer: async () => ({type:'answer',sdp:'fixture'}),
      reply: async value => { replies.push(value); return {} }, interrupt: async () => ({speechEpoch:1}),
      onEvent: cb => { listeners.voice=cb; return () => {delete listeners.voice} },
    };
    window.mcAgent = { send: async value => {send.push(value); return {turnId:'turn'}}, onEvent: cb => {listeners.agent=cb; return () => {delete listeners.agent}} };
    const track = Object.assign(new EventTarget(), {enabled:true,stopped:false,stop(){this.stopped=true}});
    let micRequests=0, visualContexts=0;
    // A failed optional analyser must leave the real voice controls usable.
    window.AudioContext = class { constructor() { visualContexts++; throw new Error('Fixture analyser unavailable') } };
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value: async options => {micRequests++; if(options.video !== false || !options.audio.echoCancellation) throw Error('Unsafe mic constraints'); return {getTracks:()=>[track],getAudioTracks:()=>[track]} }});
    window.RTCPeerConnection = class {
      constructor(){this.iceGatheringState='complete';this.connectionState='connected';this.localDescription={sdp:'fixture'}}
      addTrack(){} createDataChannel(){} async createOffer(){return {type:'offer',sdp:'fixture'}}
      async setLocalDescription(){} async setRemoteDescription(){} close(){}
    };
    const {voiceCoordinator,attachPersistentVoice,resetPersistentVoice}=await import('/src/voice-coordinator.js');
    const ring=document.querySelector('.home-ring-wrap .uring');
    const arc=ring.querySelector('.arc-glow');
    const contact=voiceCoordinator({ring});document.querySelector('.home-ring-wrap').append(contact.el);
    const tick=()=>new Promise(resolve=>setTimeout(resolve,30));await tick();
    const get=name=>contact.el.querySelector('[data-voice-'+name+']');
    const visual={styles:[...document.styleSheets].map(sheet=>new URL(sheet.href).pathname), backgrounds:{}, idle:getComputedStyle(arc).animationName, reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
    for(const theme of ['default','white','tan','black']) {
      if(theme==='default') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme=theme;
      visual.backgrounds[theme]=getComputedStyle(contact.el).backgroundColor;
    }
    delete document.documentElement.dataset.theme;
    const before={micRequests,starts:starts.length,visualContexts,selected:get('target').value};
    const compact={collapsed:get('controls').hidden,expanded:get('expand').getAttribute('aria-expanded'),width:contact.el.getBoundingClientRect().width,height:contact.el.getBoundingClientRect().height,contact:get('contact-name').textContent};
    get('expand').click();await tick();
    compact.openedWithoutStart=!get('controls').hidden && starts.length===0 && micRequests===0 && visualContexts===0;
    if(get('target').selectedOptions[0].textContent !== 'Coordinator assistant') throw new Error('Rotated Coordinator voice contact lost its name');
    get('start').click();await tick();
    const active={state:contact.el.dataset.state,micRequests,visualContexts,selected:starts[0].targetAgentId};
    get('expand').click();await tick();
    compact.activeActionsVisible=get('controls').hidden && !get('live').hidden && !get('compact-mute').disabled && get('compact-end').getBoundingClientRect().height>=40;
    listeners.agent({sessionId:'coordinator',event:{type:'assistant_text',turnId:'format-test',text:'**Hello** 😊. Open _Settings_.'}});
    listeners.agent({sessionId:'coordinator',event:{type:'turn_completed',turnId:'format-test'}});await tick();
    const speechText=replies.map(value=>value.text).join('').replace(/\\s+/g,' ').trim();
    visual.listening={state:ring.dataset.voice,animation:getComputedStyle(arc).animationName};
    listeners.voice({sessionId:'voice-1',targetAgentId:'coordinator',generation:1,sequence:1,speechEpoch:0,type:'playback.started'});await tick();
    visual.speaking={state:ring.dataset.voice,animation:getComputedStyle(arc).animationName};
    listeners.voice({sessionId:'voice-1',targetAgentId:'coordinator',generation:1,sequence:2,speechEpoch:0,type:'playback.stopped'});await tick();
    visual.stopped={state:ring.dataset.voice,animation:getComputedStyle(arc).animationName};
    get('compact-mute').click(); const muted=track.enabled===false && get('compact-mute').getAttribute('aria-label')==='Unmute mic';
    get('expand').click();await tick();
    get('target').value='worker';get('target').dispatchEvent(new Event('change'));await tick();
    const switched={selected:starts.at(-1).targetAgentId,stops:stops.length};
    listeners.voice({sessionId:'voice-1',targetAgentId:'coordinator',generation:1,sequence:1,speechEpoch:0,type:'transcript.final',text:'Stale instruction',utteranceId:'old'});await tick();
    const staleSent=send.length;
    const directStarts=starts.length;
    const directSelected=await contact.selectTarget('coordinator');await tick();
    const directSwitch={selected:directSelected,sessionId:contact.getContact().sessionId,restarted:starts.length===directStarts+1};
    const beforeMissing=starts.length;
    const missingSelected=await contact.selectTarget('missing-agent');
    directSwitch.missingRefused=missingSelected===false&&starts.length===beforeMissing&&contact.getContact().sessionId==='coordinator';
    const originalStop=window.mcVoice.stop, beforeSuperseded=starts.length;
    let releaseStop;
    window.mcVoice.stop=()=>new Promise(resolve=>{releaseStop=()=>{stops.push(true);resolve()}});
    const olderSwitch=contact.selectTarget('worker');
    for(let i=0;!releaseStop&&i<30;i++)await tick();
    if(!releaseStop)throw new Error('Selection did not reach the deferred stop bridge');
    const newerSwitch=contact.selectTarget('coordinator');
    window.mcVoice.stop=originalStop;
    releaseStop();
    const superseded={older:await olderSwitch,newer:await newerSwitch};await tick();
    superseded.startedTargets=starts.slice(beforeSuperseded).map(value=>value.targetAgentId);
    superseded.selected=contact.getContact().sessionId;
    superseded.active=contact.getContact().state==='listening';
    get('expand').click();get('compact-end').click();await tick();
    compact.endedWithoutOpening=get('controls').hidden && contact.el.dataset.state==='off' && get('live').hidden;
    compact.endFocusRestored=document.activeElement===get('expand') && get('expand').getAttribute('aria-label').includes('Off.');
    contact.destroy();await tick();
    visual.off={state:ring.dataset.voice,animation:getComputedStyle(arc).animationName};
    const cleanup={trackStopped:track.stopped,listeners:Object.keys(listeners).length,panels:document.querySelectorAll('.voice-contact').length};
    const first=attachPersistentVoice({ring});document.body.append(first.el);await tick();
    first.el.querySelector('[data-voice-start]').click();await tick();
    const oldStops=stops.length, oldMic=micRequests, sameElement=first.el;
    first.destroy();await tick();
    const inDock=Boolean(document.querySelector('.voice-screen-dock .voice-contact'));
    const second=attachPersistentVoice({ring});document.body.append(second.el);
    first.destroy();await tick(); // A stale route teardown cannot detach the new lease.
    if(!document.querySelector('.voice-screen-dock').hidden)throw new Error('Voice dock must disappear when Home owns the panel');
    const continuity={sameElement:second.el===sameElement,inDock,noStop:stops.length===oldStops,noMicRestart:micRequests===oldMic,newLeaseAttached:second.el.parentElement===document.body};
    resetPersistentVoice();await tick();
    continuity.stoppedOnReset=stops.length>oldStops;
    let screenState={supported:true,permissionLevel:'unrestricted',grants:[]};
    const screenCalls=[];
    window.mcScreenControl={status:async()=>screenState,onEvent:()=>()=>{},
      grant:async value=>{screenCalls.push(value);screenState={...screenState,grants:value.sessionIds.map(sessionId=>({sessionId}))};return screenState},
      revoke:async()=>{screenState={...screenState,grants:[]};return screenState}};
    const {mountAgentScreenVoiceControls}=await import('/src/agent-screen-voice-controls.js');
    const controls=mountAgentScreenVoiceControls();document.body.append(controls.el);await tick();
    const beforeSelection={starts:starts.length,micRequests};
    await controls.selectAgent({id:'coordinator-node'});await tick();
    const selectedVoice=controls.el.querySelector('[data-voice-target]').value;
    const selectionOnly=starts.length===beforeSelection.starts&&micRequests===beforeSelection.micRequests;
    await controls.selectAgent({id:'not-running'});await controls.refresh();
    if(!controls.el.querySelector('[data-control-status]').textContent.includes('Start this local agent'))throw new Error('Supported screen polling lost the draft refusal');
    controls.el.querySelector('[data-control-grant]').click();await tick();
    const grantedAgents=screenCalls.at(-1)?.sessionIds;
    if(screenCalls.at(-1)?.mode!=='selected'||screenCalls.at(-1)?.labels?.coordinator!=='Coordinator assistant')throw new Error('Page 2 must use the current selected-agent computer-control grant contract');
    const screenActionClearsRefusal=controls.el.querySelector('[data-control-status]').textContent==='Access is on. One agent holds control until it releases its turn or becomes idle.';
    controls.el.querySelector('[data-control-stop]').click();await tick();
    const stoppedAll=screenState.grants.length===0;
    controls.destroy();resetPersistentVoice();await tick();
    delete window.mcScreenControl;
    const marks=[];
    const voiceOnly=mountAgentScreenVoiceControls({onMarks:value=>marks.push(value)});document.body.append(voiceOnly.el);await tick();
    const beforeVoiceOnly={starts:starts.length,micRequests};
    await voiceOnly.selectAgent({id:'coordinator-node'});await tick();
    const noScreen={selected:voiceOnly.el.querySelector('[data-voice-target]').value,
      selectionOnly:starts.length===beforeVoiceOnly.starts&&micRequests===beforeVoiceOnly.micRequests,
      allScreenDisabled:[...voiceOnly.el.querySelectorAll('.agent-control-buttons button')].every(button=>button.disabled),
      voiceEnabled:!voiceOnly.el.querySelector('[data-voice-start]').disabled,
      screenUnavailable:voiceOnly.el.querySelector('[data-control-status]').textContent==='Open the local desktop app to enable computer control.',
      marked:marks.at(-1)?.voiceNodeId==='coordinator-node'};
    voiceOnly.el.open=false;await tick();
    let draftOpenToggle=false;
    voiceOnly.el.addEventListener('toggle',()=>{if(voiceOnly.el.open)draftOpenToggle=true},{once:true});
    await voiceOnly.selectAgent({id:'not-running'});await tick();
    noScreen.nonrunningRefused=voiceOnly.el.querySelector('[data-control-status]').textContent.includes('Start this local agent')&&voiceOnly.el.querySelector('[data-voice-target]').value==='coordinator';
    noScreen.refusalSurvivesToggle=draftOpenToggle&&noScreen.nonrunningRefused;
    await voiceOnly.refresh();
    noScreen.refusalSurvivesRefresh=voiceOnly.el.querySelector('[data-control-status]').textContent.includes('Start this local agent');
    await voiceOnly.selectAgent({id:'coordinator-node'});
    noScreen.validSelectionClearsRefusal=voiceOnly.el.querySelector('[data-control-status]').textContent==='Open the local desktop app to enable computer control.';
    voiceOnly.el.querySelector('[data-voice-start]').click();await tick();
    const originalTargets=window.mcVoice.targets, beforeLateSelection=starts.length,
      survivingVoiceTarget=voiceOnly.el.querySelector('[data-voice-target]');
    let releaseTargets;
    window.mcVoice.targets=()=>new Promise(resolve=>{releaseTargets=resolve});
    const lateSelection=voiceOnly.selectAgent({id:'Worker'});
    voiceOnly.destroy();
    window.mcVoice.targets=originalTargets;
    releaseTargets(await originalTargets());
    await lateSelection;await tick();
    noScreen.staleClickDiscarded=starts.length===beforeLateSelection&&survivingVoiceTarget.value==='coordinator';
    // The controls' own read has completed here; pause the SECOND targets
    // read inside the persistent coordinator before destroying the old page.
    const lateControls=mountAgentScreenVoiceControls();document.body.append(lateControls.el);
    await lateControls.refresh();lateControls.el.open=true;await tick();
    let lateReads=0, releaseSecondRead;
    window.mcVoice.targets=()=>++lateReads===2?new Promise(resolve=>{releaseSecondRead=resolve}):originalTargets();
    const beforeDraftSupersedes=starts.length;
    const supersededByDraft=lateControls.selectAgent({id:'Worker'});
    for(let i=0;!releaseSecondRead&&i<30;i++)await tick();
    if(!releaseSecondRead)throw new Error('Selection did not reach its second targets read');
    await lateControls.selectAgent({id:'not-running'});
    releaseSecondRead(await originalTargets());
    noScreen.latestDraftWins=await supersededByDraft===false&&starts.length===beforeDraftSupersedes
      &&lateControls.el.querySelector('[data-voice-target]').value==='coordinator';
    lateReads=0;releaseSecondRead=null;
    const beforeHandoff={starts:starts.length,stops:stops.length,micRequests};
    const selectionDuringHandoff=lateControls.selectAgent({id:'Worker'});
    for(let i=0;!releaseSecondRead&&i<30;i++)await tick();
    if(!releaseSecondRead)throw new Error('Handoff did not reach its second targets read');
    lateControls.destroy();
    const nextPage=attachPersistentVoice();document.body.append(nextPage.el);
    window.mcVoice.targets=originalTargets;
    // Even an obsolete empty target snapshot cannot end the surviving call.
    releaseSecondRead([]);
    noScreen.staleCoordinatorSelectionDiscarded=await selectionDuringHandoff===false
      &&nextPage.getContact().sessionId==='coordinator';
    noScreen.handoffPreservesActiveVoice=nextPage.getContact().state==='listening'
      &&starts.length===beforeHandoff.starts&&stops.length===beforeHandoff.stops&&micRequests===beforeHandoff.micRequests;
    nextPage.destroy();
    noScreen.detachedLeaseCannotRetarget=await nextPage.selectTarget('worker')===false;
    resetPersistentVoice();await tick();
    noScreen.cleanup=Object.keys(listeners).length===0;
    return {before,active,compact,speechText,muted,switched,staleSent,directSwitch,superseded,visual,cleanup,continuity,page2:{selectedVoice,selectionOnly,grantedAgents,screenActionClearsRefusal,stoppedAll},noScreen};
  })()`)
  assert.equal(result.before.micRequests, 0)
  assert.equal(result.before.starts, 0)
  assert.equal(result.before.visualContexts, 0, 'a collapsed widget and disclosure must not create an audio context')
  assert.equal(result.before.selected, 'coordinator')
  assert.equal(result.active.state, 'listening')
  assert.equal(result.active.micRequests, 1)
  assert.equal(result.active.visualContexts, 1, 'an analyser failure after authorized capture must not break voice')
  assert.equal(result.compact.collapsed, true)
  assert.equal(result.compact.expanded, 'false')
  assert.ok(result.compact.width <= 320 && result.compact.height >= 48 && result.compact.height <= 62)
  assert.equal(result.compact.contact, 'Coordinator assistant')
  assert.equal(result.compact.openedWithoutStart, true)
  assert.equal(result.compact.activeActionsVisible, true)
  assert.equal(result.compact.endedWithoutOpening, true)
  assert.equal(result.compact.endFocusRestored, true)
  assert.equal(result.speechText, 'Hello . Open Settings.', 'production voice UI sends speech-only plain text to its transport')
  assert.equal(result.muted, true)
  assert.equal(result.switched.selected, 'worker')
  assert.ok(result.switched.stops >= 1)
  assert.equal(result.staleSent, 0)
  assert.deepEqual(result.directSwitch, { selected: true, sessionId: 'coordinator', restarted: true, missingRefused: true })
  assert.deepEqual(result.superseded, { older: false, newer: true, startedTargets: ['coordinator'], selected: 'coordinator', active: true }, 'a newer selection wins during stop without losing the active call')
  assert.deepEqual(result.cleanup, { trackStopped: true, listeners: 0, panels: 0 })
  assert.deepEqual(result.continuity, { sameElement: true, inDock: true, noStop: true, noMicRestart: true, newLeaseAttached: true, stoppedOnReset: true })
  assert.deepEqual(result.page2, { selectedVoice: 'coordinator', selectionOnly: true, grantedAgents: ['coordinator'], screenActionClearsRefusal: true, stoppedAll: true })
  assert.deepEqual(result.noScreen, { selected: 'coordinator', selectionOnly: true, allScreenDisabled: true, voiceEnabled: true,
    screenUnavailable: true, marked: true, nonrunningRefused: true, refusalSurvivesToggle: true, refusalSurvivesRefresh: true,
    validSelectionClearsRefusal: true, staleClickDiscarded: true, latestDraftWins: true, staleCoordinatorSelectionDiscarded: true,
    handoffPreservesActiveVoice: true, detachedLeaseCannotRetarget: true, cleanup: true })
  assert.deepEqual(result.visual.styles, ['/src/styles.css', '/src/home.css', '/src/home-voice.css'], 'load the actual production styles in cascade order')
  assert.deepEqual(result.visual.backgrounds, { default: 'rgb(255, 255, 255)', white: 'rgb(255, 255, 255)', tan: 'rgb(251, 241, 199)', black: 'rgb(46, 49, 54)' }, 'voice contact uses the active theme sheet, including the default light theme')
  assert.equal(result.visual.reducedMotion, false)
  assert.equal(result.visual.idle, 'home-ring-breathe')
  assert.deepEqual(result.visual.listening, { state: 'listening', animation: 'none' })
  assert.deepEqual(result.visual.speaking, { state: 'speaking', animation: 'voice-answer' }, 'speaking must override the later idle-ring animation')
  assert.deepEqual(result.visual.stopped, { state: 'listening', animation: 'none' })
  assert.deepEqual(result.visual.off, { state: 'off', animation: 'home-ring-breathe' })
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  result.visual.reduced = await win.webContents.executeJavaScript(`(() => {
    const ring=document.querySelector('.home-ring-wrap .uring');
    ring.dataset.voice='speaking';
    return {matches:matchMedia('(prefers-reduced-motion: reduce)').matches,animation:getComputedStyle(ring.querySelector('.arc-glow')).animationName};
  })()`)
  assert.deepEqual(result.visual.reduced, { matches: true, animation: 'none' }, 'reduced motion must disable speaking animation')
  win.webContents.debugger.detach()
  console.log(JSON.stringify({ ok: true, result }))
}
main().then(() => { win?.destroy(); server.close(); app.exit(0) }).catch(error => { console.error(error); win?.destroy(); server.close(); app.exit(1) })
