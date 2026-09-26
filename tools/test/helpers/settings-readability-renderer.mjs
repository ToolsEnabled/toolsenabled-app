import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/source-sans-3'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/guided-step.css'
import { settingsView } from '../../../src/views/settings.js'
import '../../../src/sidebar-pages.css'
import '../../../src/readability.css'
import { applyTextSize } from '../../../src/text-size.js'
import { applyFontChoice } from '../../../src/font-choice.js'
import fixtureRows from './settings-readability-rows.json'

// Deliberately synthetic bridge replies; no native bridge, account or transport.
const rows = fixtureRows.rows
const syntheticReads=[]
window.fetch=async input=>{
  const pathname=new URL(String(input),location.href).pathname
  if(!['/data/agents.json','/data/schema/agents.schema.json','/data/coordinator.json','/data/schema/coordinator.schema.json'].includes(pathname))throw Error('Unexpected fixture read: '+pathname)
  syntheticReads.push(pathname)
  return new Response('{}',{status:404})
}
let writes=0, current=null
const navigations=[]
window.mcSettings={read:async()=>({ok:true,available:true,rows:structuredClone(rows)}),set:async()=>{writes++;throw Error('Read-only layout fixture')}}
window.mcAccount={current:async()=>({signedIn:false})}
const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
const visible=node=>!!node.getClientRects().length && getComputedStyle(node).visibility!=='hidden'
const rect=node=>{const box=node.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom}}
const values=()=>[...document.querySelectorAll('.settings-row input,.settings-row select,[data-working-profile-slider]')].map(node=>({
  id:node.dataset.researchSetting||node.dataset.researchNumber||node.id||node.name,type:node.type,value:node.value,checked:node.checked,disabled:node.disabled
}))

window.settingsReadabilityFixture={
  async open({category='tool-use',theme='white',zoom=1,expert=true,pageWidth}={}) {
    current?.destroy(); document.querySelector('.settings-page')?.remove()
    document.documentElement.dataset.theme=theme
    document.body.dataset.route='settings';document.body.dataset.navigation='side'
    localStorage.setItem('mc.settings.mode','advanced');localStorage.setItem('mc.font','grotesk')
    applyFontChoice('grotesk');applyTextSize(zoom)
    current=settingsView({query:new URLSearchParams({category}),navigate:href=>navigations.push(href)})
    if(pageWidth)current.el.style.width=`${pageWidth}px`
    document.body.append(current.el)
    await document.fonts.ready; await tick();await tick()
    if(expert){
      document.querySelector('[data-settings-mode-choice="expert"]').click()
      const dialog=document.querySelector('.settings-expert-dialog')
      dialog.querySelector('input').value=dialog.querySelector('label strong').textContent
      dialog.querySelector('form').requestSubmit()
    }
    await tick();await tick()
    for(const animation of document.getAnimations())if(animation.effect?.getComputedTiming().iterations!==Infinity)animation.finish()
    return this.measure()
  },
  async measure(){
    await tick()
    const page=document.querySelector('.settings-page'), main=document.querySelector('.settings-main')
    const names=[...document.querySelectorAll('.settings-name')].filter(visible)
    const measuredRows=[...document.querySelectorAll('.settings-row')].filter(visible).map(node=>({
      id:node.dataset.settingId||node.dataset.researchSettingRow||null,box:rect(node),columns:getComputedStyle(node).gridTemplateColumns,
      name:node.querySelector('.settings-name')?.textContent.trim(),copy:node.querySelector('.settings-copy')?rect(node.querySelector('.settings-copy')):null,
      control:node.querySelector('.settings-control')?rect(node.querySelector('.settings-control')):null,
    }))
    /* The quick strip, so the suite can say where it is drawn and where it is
       not. `firstSlider` is the first quick slider's own range control: the
       strip is only "reachable where Settings opens" if a person can see a
       slider without scrolling, not merely the heading above it. */
    const quickStrip=document.querySelector('[data-settings-quick]')
    const firstQuickSlider=quickStrip?.querySelector('[data-quick-slider] input[type="range"]')||null
    const quick={present:Boolean(quickStrip),shown:Boolean(quickStrip)&&visible(quickStrip),
      box:quickStrip&&visible(quickStrip)?rect(quickStrip):null,
      firstSlider:firstQuickSlider&&visible(firstQuickSlider)?rect(firstQuickSlider):null,
      sliders:quickStrip?[...quickStrip.querySelectorAll('[data-quick-slider]')].filter(visible).length:0}
    return {quick,width:innerWidth,height:innerHeight,page:rect(page),main:rect(main),pageScrollWidth:page.scrollWidth,pageClientWidth:page.clientWidth,
      category:rect(document.querySelector('.settings-section-title')),command:rect(document.querySelector('.settings-command-bar')),
      profile:rect(document.querySelector('[data-working-profile]')),mode:page.dataset.settingsMode,dirty:page.dataset.settingsDirty,
      names:names.map(node=>({text:node.textContent.trim(),font:getComputedStyle(node).fontSize,color:getComputedStyle(node).color})),
      rows:measuredRows,values:values(),writes,bodyText:document.querySelector('.settings-main-context').textContent.trim(),
      profileSummary:document.querySelector('[data-working-profile] > summary')?{
        state:document.querySelector('[data-working-profile-current]').textContent,
        warning:document.querySelector('[data-working-profile-message]').textContent,
        stateVisible:visible(document.querySelector('[data-working-profile-current]')),
        warningVisible:visible(document.querySelector('[data-working-profile-message]')),
      }:null,
      contextVisible:visible(document.querySelector('.settings-main-context-copy')),
      navigation:{pickerVisible:visible(document.querySelector('.settings-category-picker')),railVisible:visible(document.querySelector('.settings-rail')),
        selected:document.querySelector('[data-settings-category-picker]').value,
        categories:[...document.querySelectorAll('[data-settings-category-picker] option')].map(option=>option.value)},
      overflow:[...document.querySelectorAll('.settings-main input,.settings-main button,.settings-name,.settings-desc,.settings-mode-seg')]
        .filter(visible).filter(node=>node.scrollWidth>node.clientWidth+2).map(node=>({class:node.className,text:node.textContent.slice(0,80),width:node.clientWidth,scroll:node.scrollWidth}))}
  },
  async focusCategoryPicker(){
    const picker=document.querySelector('[data-settings-category-picker]')
    picker.focus()
    return{focused:document.activeElement===picker,values:values(),selected:picker.value,navigations:[...navigations]}
  },
  async categoryPickerResult(){await tick();return{values:values(),selected:document.querySelector('[data-settings-category-picker]').value,navigations:[...navigations],writes}},
  async content(){const page=document.querySelector('.settings-page'),title=document.querySelector('.settings-section-title'),bar=document.querySelector('.settings-command-bar')
    page.scrollTop+=title.getBoundingClientRect().top-page.getBoundingClientRect().top-(getComputedStyle(bar).position==='sticky'?bar.offsetHeight+12:12)
    return this.measure()},
  async numeric(){const row=document.querySelector('[data-research-setting-row="tools.audit_batch_window_ms"]');row.scrollIntoView({block:'center'});await tick();await tick()
    const ancestors=[];for(let node=row;node&&node!==document.body;node=node.parentElement){const style=getComputedStyle(node);ancestors.push({class:node.className,box:rect(node),opacity:style.opacity,visibility:style.visibility,display:style.display,overflow:style.overflow,maxHeight:style.maxHeight,transform:style.transform})}
    return{...await this.measure(),ancestors}},
  async details(){
    const row=document.querySelector('[data-research-setting-row="agent.agent_api"]'),details=row.querySelector('.guided-note'),body=details.querySelector('.guided-body')
    row.scrollIntoView({block:'start'});await tick();await tick()
    const before={text:body.textContent,control:rect(row.querySelector('.settings-control')),bodyVisible:visible(body)}
    details.querySelector('summary').click();await tick();await tick()
    return{before,after:{text:body.textContent,control:rect(row.querySelector('.settings-control')),bodyVisible:visible(body),body:rect(body),row:rect(row)},open:details.open}
  },
  async profile(){
    const panel=document.querySelector('[data-working-profile]'), summary=panel.querySelector(':scope > summary')
    const before=values()
    if(summary)summary.click()
    document.querySelector('.settings-page').scrollTop=0;await tick()
    const opened={open:panel.open??true,sliderVisible:visible(panel.querySelector('input[type="range"]')),choices:panel.querySelectorAll('[data-working-profile-choice]').length}
    if(summary)summary.click()
    // Presentation test of text delivered by the existing controller. This
    // does not stage a profile or emulate the settings writer.
    panel.querySelector('[data-working-profile-current]').textContent='Saved: Custom'
    panel.querySelector('[data-working-profile-draft]').textContent='Pending profile: Balanced. Save settings to apply.'
    panel.querySelector('[data-working-profile-message]').textContent='Synthetic warning: this profile needs review.'
    await tick()
    return{opened,unchanged:JSON.stringify(before)===JSON.stringify(values()),stateVisible:visible(panel.querySelector('[data-working-profile-current]')),
      pendingVisible:visible(panel.querySelector('[data-working-profile-draft]')),warningVisible:visible(panel.querySelector('[data-working-profile-message]')),closed:!panel.open}
  },
  close(){current?.destroy();current=null;document.querySelector('.settings-page')?.remove();return{writes,syntheticReads}}
}
