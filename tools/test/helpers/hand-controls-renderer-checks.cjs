'use strict'
const assert = require('node:assert/strict')
module.exports = async win => {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {handControls,startHandControls}=await import('/src/hand-controls.js');
    const baseline={state:handControls().getState(),models:performance.getEntriesByType('resource').filter(r=>/vendor|tracker.js/.test(r.name)).length};
    const denied=await navigator.mediaDevices.getUserMedia({video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return false},()=>true);
    handControls().destroy();
    let activeWindow=true, ratio=.8, missing=false, workers=0, terminations=0, frames=0, captures=0;
    const streams=[];const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const controls=startHandControls({storage:{getItem:()=>null,setItem(){}},isActive:()=>activeWindow,
      getMedia:async options=>{captures++;const stream=await media(options);streams.push(stream);return stream},
      createWorker:()=>{
        workers++;const worker={terminate(){terminations++},postMessage(data){
          if(data.type==='init')queueMicrotask(()=>worker.onmessage({data:{type:'ready'}}));
          if(data.type==='frame'){
            frames++;data.frame.close();
            const rect=document.querySelector('[data-practice="Middle"]').getBoundingClientRect();
            const x=1-((rect.x+rect.width/2)/innerWidth*.7+.15),y=(rect.y+rect.height/2)/innerHeight*.7+.15;
            const points=Array.from({length:21},()=>({x,y,z:0}));points[5].x-=.09;points[17].x+=.09;points[8].x+=ratio*.18;
            setTimeout(()=>worker.onmessage({data:{type:'result',at:data.at,ms:2,hand:'Right',landmarks:missing?null:points}}),0);
          }
        }};return worker;
      }
    });
    let clicks=0;const button=document.querySelector('[data-practice="Middle"]');button.addEventListener('click',()=>clicks++);
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    await controls.setEnabled(true);await wait(900);
    const running={phase:controls.getState().phase,workers,captures,frames};
    ratio=.1;await wait(450);const once=clicks;await wait(450);const held=clicks;
    ratio=.8;await wait(350);button.disabled=true;ratio=.1;await wait(400);const disabledClicks=clicks;
    button.disabled=false;ratio=.8;await wait(350);missing=true;await wait(120);ratio=.1;missing=false;await wait(400);const reacquired=clicks;
    activeWindow=false;window.dispatchEvent(new Event('blur'));await wait(80);
    const paused={phase:controls.getState().phase,terminated:terminations,liveTracks:streams.flatMap(s=>s.getTracks()).filter(t=>t.readyState==='live').length};
    const before=frames;await wait(150);const backgroundFrames=frames-before;
    activeWindow=true;window.dispatchEvent(new Event('focus'));await wait(400);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await wait(80);
    const stopped={phase:controls.getState().phase,enabled:controls.getState().enabled,workers,terminations,
      liveTracks:streams.flatMap(s=>s.getTracks()).filter(t=>t.readyState==='live').length,pointers:document.querySelectorAll('.hand-control-pointer').length};
    controls.destroy();
    const {createHandPress}=await import('/src/hand-press.js');
    const presses=createHandPress(document), select=document.createElement('select'), field=document.createElement('textarea');
    for(let i=0;i<10;i++){const o=document.createElement('option');o.textContent='Choice '+i;o.value=String(i);select.append(o)}
    select.options[2].disabled=true; document.body.append(select,field);
    let changes=0;select.addEventListener('change',()=>changes++);
    presses.press(select);
    const find=text=>[...document.querySelectorAll('.hand-control-choices button')].find(b=>b.textContent===text);
    const optionDisabled=find('Choice 2').disabled;
    find('Next choices').click();find('Choice 8').click();
    const selected={value:select.value,changes,closed:!document.querySelector('.hand-control-choices'),optionDisabled};
    presses.press(select);select.disabled=true;find('Choice 9').click();
    const staleChoice=select.value;presses.press(field);const fieldFocused=document.activeElement===field;
    presses.close();select.remove();field.remove();
    return {baseline,denied,running,once,held,disabledClicks,reacquired,paused,backgroundFrames,stopped,selected,staleChoice,fieldFocused};
  })()`)
  assert.equal(result.baseline.state.enabled, false)
  assert.equal(result.baseline.models, 0, 'Off must not load model or WASM assets')
  assert.equal(result.denied, true, 'Native camera permission must refuse before opt-in')
  assert.equal(result.running.phase, 'running')
  assert.ok(result.running.frames >= 4, 'Real native synthetic camera frames must reach the worker boundary')
  assert.equal(result.once, 1); assert.equal(result.held, 1)
  assert.equal(result.disabledClicks, 1); assert.equal(result.reacquired, 1)
  assert.equal(result.paused.phase, 'paused'); assert.equal(result.paused.liveTracks, 0)
  assert.equal(result.backgroundFrames, 0)
  assert.equal(result.stopped.enabled, false); assert.equal(result.stopped.phase, 'off')
  assert.equal(result.stopped.liveTracks, 0); assert.equal(result.stopped.pointers, 0)
  assert.equal(result.stopped.terminations, result.stopped.workers)
  assert.deepEqual(result.selected, {value:'8',changes:1,closed:true,optionDisabled:true})
  assert.equal(result.staleChoice,'8');assert.equal(result.fieldFocused,true)
  win.setContentSize(480, 500)
  const bounds = await win.webContents.executeJavaScript(`(async () => {
    const rows=[];
    for(const zoom of [1,.9,1.12]) {
      document.documentElement.style.setProperty('--zoom',String(zoom));document.body.style.zoom=String(zoom);
      for(const name of ['accessibility-confirmation','voice-screen-dock','hand-control-hud','hand-control-choices']) {
        const panel=document.createElement('aside');panel.className=name;
        const content=document.createElement('div');content.style.height='1200px';content.textContent='Control';panel.append(content);document.body.append(panel);
        const rect=panel.getBoundingClientRect();
        rows.push({name,zoom,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight});panel.remove();
      }
    }
    document.body.style.zoom='';document.documentElement.style.removeProperty('--zoom');
    return rows;
  })()`)
  for (const row of bounds) {
    // The hand HUD is a single-row status strip, not a tall content panel.
    assert.ok(row.left >= -1 && row.right <= row.width + 1, JSON.stringify(row))
    if (row.name !== 'hand-control-hud') assert.ok(row.top >= -1 && row.bottom <= row.height + 1, JSON.stringify(row))
  }
  result.zoomBounds = bounds.length
  return result
}
