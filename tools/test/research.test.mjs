/* Execute the real research view through the repository CSS loader. The small DOM
 * below implements only the browser surface this view exercises during boot; no
 * product source is read or transformed. */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
class Classes { constructor(e){this.e=e} _a(){return this.e.className.split(/\s+/).filter(Boolean)} contains(x){return this._a().includes(x)} add(...x){this.e.className=[...new Set([...this._a(),...x])].join(' ')} remove(...x){this.e.className=this._a().filter(y=>!x.includes(y)).join(' ')} toggle(x,on){on=on??!this.contains(x); on?this.add(x):this.remove(x); return on} }
class E {
 constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map;this.dataset={};this.style={setProperty(){},removeProperty(){}};this.className='';this.classList=new Classes(this);this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.listeners=new Map;this._text='';this.offsetParent={}}
 get firstElementChild(){return this.children[0]||null} get childElementCount(){return this.children.length} get isConnected(){return !!this.parentNode} get textContent(){return this._text+this.children.map(x=>x.textContent).join('')} set textContent(v){for(const c of this.children)c.parentNode=null;this.children=[];this._text=String(v)} get innerHTML(){return this.textContent} set innerHTML(v){this.replaceChildren(...parse(this.ownerDocument,String(v)))}
 append(...ns){for(let n of ns){if(typeof n==='string') n=new T(this.ownerDocument,n);n.remove?.();n.parentNode=this;this.children.push(n)}} appendChild(n){this.append(n);return n} prepend(...ns){for(const n of ns.reverse()){n.remove?.();n.parentNode=this;this.children.unshift(n)}} after(n){const i=this.parentNode.children.indexOf(this);n.remove?.();n.parentNode=this.parentNode;this.parentNode.children.splice(i+1,0,n)} replaceChildren(...ns){for(const c of this.children)c.parentNode=null;this.children=[];this._text='';this.append(...ns)} remove(){if(this.parentNode?.children)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null}
 setAttribute(n,v){v=String(v);this.attributes.set(n,v);if(n==='class')this.className=v;if(n==='hidden')this.hidden=true;if(n==='disabled')this.disabled=true;if(n==='checked')this.checked=true;if(n==='value')this.value=v;if(n.startsWith('data-'))this.dataset[camel(n.slice(5))]=v} getAttribute(n){return this.attributes.get(n)??null} hasAttribute(n){return this.attributes.has(n)} removeAttribute(n){this.attributes.delete(n);if(n==='hidden')this.hidden=false} toggleAttribute(n,on){on=on??!this.hasAttribute(n);on?this.setAttribute(n,''):this.removeAttribute(n);return on}
 addEventListener(n,f){this.listeners.set(n,[...(this.listeners.get(n)||[]),f])} removeEventListener(){} contains(n){return n===this||this.children.some(x=>x.contains?.(n))} querySelector(s){return this.querySelectorAll(s)[0]||null} querySelectorAll(s){return walk(this).slice(1).filter(n=>matches(n,s))} matches(s){return matches(this,s)} closest(s){for(let n=this;n;n=n.parentNode)if(matches(n,s))return n;return null} getBoundingClientRect(){return {width:600,height:400,top:0,left:0,right:600,bottom:400}} focus(){} insertAdjacentHTML(_p,h){this.after(...parse(this.ownerDocument,h))}
}
class T extends E {constructor(d,t){super(d,'#text');this._text=t}}
function walk(n){return [n,...n.children.flatMap(walk)]}
function matches(n,s){if(s.includes(','))return s.split(',').some(x=>matches(n,x.trim())); if(s.startsWith(':scope > '))s=s.slice(9); const tag=/^[a-z]+/i.exec(s)?.[0];if(tag&&n.tagName!==tag.toUpperCase())return false;for(const c of [...s.matchAll(/\.([\w-]+)/g)])if(!n.classList.contains(c[1]))return false;for(const a of [...s.matchAll(/\[([^\]=]+)(?:="?([^\]"]+)"?)?\]/g)]){const name=a[1],wanted=a[2];let got=name.startsWith('data-')?n.dataset[camel(name.slice(5))]:n.getAttribute(name);if(got==null)return false;if(wanted!=null&&got!==wanted)return false}return !!(tag||s.includes('.')||s.includes('['))}
const VOID=new Set(['input','br','img']);
function parse(doc,h){const root=new E(doc);let cur=root;const re=/<\/?[^>]+>|[^<]+/g;for(const tok of h.match(re)||[]){if(tok.startsWith('</')){cur=cur.parentNode||root;continue}if(tok.startsWith('<')){if(tok.startsWith('<!--'))continue;const m=/^<\s*([\w-]+)/.exec(tok);if(!m)continue;const e=new E(doc,m[1]);for(const a of tok.matchAll(/([:\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)){if(a[1]===m[1])continue;e.setAttribute(a[1],a[2]??a[3]??a[4]??'')}cur.append(e);if(!tok.endsWith('/>')&&!VOID.has(m[1]))cur=e}else if(tok.trim())cur.append(new T(doc,tok.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')))}return root.children}
class D extends E {constructor(){super(null,'document');this.ownerDocument=this;this.body=new E(this,'body');this.documentElement=new E(this,'html');this.activeElement=null;this.defaultView={getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})}}createElement(t){if(t!=='template')return new E(this,t);const e=new E(this,t);e.content={firstElementChild:null};Object.defineProperty(e,'innerHTML',{set:h=>e.content.firstElementChild=parse(this,h)[0]});return e}}
const storage={getItem:()=>null,setItem(){},removeItem(){}}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {userAgent:'node'} });const document=new D();globalThis.document=document;globalThis.localStorage=storage;const windowListeners = new Map(); globalThis.window={document,localStorage,location:{hostname:'127.0.0.1',search:'?bridge=http%3A%2F%2F127.0.0.1%3A4610'},mcShell:{getBridgeProof:async()=>({ok:true,proof:'research-fixture-proof'.padEnd(43,'0')})},addEventListener(type, fn){windowListeners.set(type,[...(windowListeners.get(type)||[]),fn])},removeEventListener(type, fn){windowListeners.set(type,(windowListeners.get(type)||[]).filter(item=>item!==fn))},dispatchEvent(event){for(const fn of windowListeners.get(event.type)||[])fn(event);return true}};globalThis.MutationObserver=class{observe(){}disconnect(){}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=f=>{queueMicrotask(f);return 1};let snapshotReadable = true
let queueReadable = true
globalThis.fetch = async input => {
  const url = String(input)
  const response = (ok, body, status = ok ? 200 : 503) => ({ ok, status, statusText: ok ? 'OK' : 'Unavailable', json: async () => structuredClone(body) })
  if (url.includes('/v1/bootstrap')) return response(true, { ok: true, token: 'fixture-token' })
  if (url.endsWith('/v1/actions/research-snapshot')) return snapshotReadable
    ? response(true, { ok: true, receipt: { projects: [{ projectId: 'rp-abcd', name: 'Alpha', enabled: true }], experiments: {}, assignments: [], settings: { pipelineEnabled: true }, lifecycle: {} } })
    : response(false, { error: { message: 'snapshot fixture refused', code: 'FIXTURE_REFUSAL' } })
  if (url.endsWith('/v1/research/local-tiers-status')) return response(false, { error: { message: 'tiers fixture refused', code: 'TIERS_FIXTURE_REFUSAL' } })
  if (url.endsWith('/data/research-queue.json')) return queueReadable
    ? response(true, { schemaVersion: 1, items: [] })
    : response(false, { error: { message: 'queue fixture refused' } })
  if (url.endsWith('/data/research.json')) return response(false, { reason: 'catalog fixture refused' })
  return response(false, { error: { message: `unexpected fixture request: ${url}` } })
}

const { researchView } = await import('../../src/views/research.js')
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(r=>setTimeout(r, 25));for(let i=0;i<10;i++)await Promise.resolve()}
async function mount() {
  const view = researchView()
  view.el.parentNode = { isConnected: true }
  await settle()
  return view
}

test('project control reflects readable and refused service states, including the refusal reason', async () => {
  snapshotReadable = true
  const ready = await mount()
  const readySelect = ready.el.querySelector('[data-project-select]')
  assert.equal(readySelect.disabled, false, 'a readable project snapshot must enable project selection')
  assert.match(readySelect.textContent, /Alpha/, 'the enabled control must carry the project returned by the service')
  snapshotReadable = false
  window.dispatchEvent({ type: 'mc:data-source-changed' })
  await settle()
  assert.equal(ready.el.querySelector('[data-project-select]').disabled, true,
    'a refused project snapshot must disable a control that cannot select a project')
  assert.match(ready.el.querySelector('[data-project-status]').textContent, /could not be read.*snapshot fixture refused/i,
    'the disabled project control must tell the reader why it cannot succeed')
  ready.destroy()
})

test('an observed empty research queue reaches the reader as an empty state', async () => {
  snapshotReadable = true
  queueReadable = true
  const view = await mount()
  const queue = view.el.querySelector('[data-research-queue]')
  assert.equal(queue.dataset.queueState, 'ready', 'an empty response is still a completed, readable observation')
  assert.match(queue.textContent, /no research items are queued/i,
    'a readable zero must be stated rather than leaving the loading sentence behind')
  assert.doesNotMatch(queue.textContent, /could not be read/i,
    'an observed zero must not be presented as a read failure')
  view.destroy()
})

test('a failed tier reading stays unavailable and does not become a definite readiness answer', async () => {
  queueReadable = true
  const view = await mount()
  const tiers = view.el.querySelector('[data-research-tiers]')
  assert.match(tiers.textContent, /local tiers could not be read.*tiers fixture refusal/i,
    'the reader must see that tier readiness could not be determined and why')
  assert.doesNotMatch(tiers.textContent, /— ready|switched off in settings/i,
    'a could-not-read response must not be collapsed into a definite tier state')
  view.destroy()
})
