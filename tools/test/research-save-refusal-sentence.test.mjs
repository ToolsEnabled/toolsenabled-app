/* A RESEARCH SAVE THAT FAILED FOR A REASON THAT WAS NOT "SIGN IN" WAS TOLD TO
 * SIGN IN ANYWAY.
 *
 * EVIDENCE. src/agent-tools-markup.js's saveRefusalSentence() exists because
 * shell/product-account.cjs putSetting() answers six distinct named refusals
 * -- not signed in, a bad key, a value too long, a DAMAGED partition, a
 * settings store that is FULL, and a WRITE this computer refused -- each with
 * a reason written for a person, and src/views/tools.js used to discard every
 * one of them and print one fixed line ending "Sign in, then set it again."
 * src/views/research.js's persistQueueRow() and persistExperiments() answer
 * over the exact same account.putSetting() call, and carried the exact same
 * shape of bug under a slightly different spelling -- "That was not saved.
 * Sign in, then try it again." -- for a THIRD time, after the first two had
 * already been fixed (src/views/account.js, then src/views/tools.js). Neither
 * function can even be showing this to somebody who is signed out: both
 * refuse one line earlier, with their own sentence, when `account.putSetting`
 * is not a function at all -- so a full settings store, a damaged partition,
 * or a disk write this computer refused was being told the one thing that
 * cannot fix it, while the reason that WOULD help was thrown away by `catch
 * {}` or the discarded `result`.
 *
 * MECHANISM. Both functions now answer with saveRefusalSentence(result), the
 * same shared sentence src/views/tools.js already uses for this same value --
 * so this rule has one definition, not three.
 *
 * These checks mount the real page (src/views/research.js, exactly as
 * tools/test/research.test.mjs does) over a fake `window.mcAccount` whose
 * `putSetting` answers a refusal carrying a reason, or throws outright, and
 * press the real controls: the queue note form's Save, and the experiment
 * bench's Remove (armed then confirmed). What is asserted is what the person
 * actually reads afterward.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'
register('./helpers/css-stub-loader.mjs', import.meta.url)

/* ---------- the same small DOM tools/test/research.test.mjs mounts the real
   page on, copied rather than imported so this file stays independently
   readable; extended with ONE addition, a `.elements` getter keyed by the
   `name` attribute (the form of access src/views/research.js's own submit
   handlers use, e.g. `form.elements.title.value`), which research.test.mjs's
   three existing checks never needed because none of them submits a form. */
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
class Classes { constructor(e){this.e=e} _a(){return this.e.className.split(/\s+/).filter(Boolean)} contains(x){return this._a().includes(x)} add(...x){this.e.className=[...new Set([...this._a(),...x])].join(' ')} remove(...x){this.e.className=this._a().filter(y=>!x.includes(y)).join(' ')} toggle(x,on){on=on??!this.contains(x); on?this.add(x):this.remove(x); return on} }
class E {
 constructor(doc,tag='div'){this.ownerDocument=doc;this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.attributes=new Map;this.dataset={};this.style={setProperty(){},removeProperty(){}};this.className='';this.classList=new Classes(this);this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.listeners=new Map;this._text='';this.offsetParent={}}
 get firstElementChild(){return this.children[0]||null} get childElementCount(){return this.children.length} get isConnected(){return !!this.parentNode} get textContent(){return this._text+this.children.map(x=>x.textContent).join('')} set textContent(v){for(const c of this.children)c.parentNode=null;this.children=[];this._text=String(v)} get innerHTML(){return this.textContent} set innerHTML(v){this.replaceChildren(...parse(this.ownerDocument,String(v)))}
 append(...ns){for(let n of ns){if(typeof n==='string') n=new T(this.ownerDocument,n);n.remove?.();n.parentNode=this;this.children.push(n)}} appendChild(n){this.append(n);return n} prepend(...ns){for(const n of ns.reverse()){n.remove?.();n.parentNode=this;this.children.unshift(n)}} after(n){const i=this.parentNode.children.indexOf(this);n.remove?.();n.parentNode=this.parentNode;this.parentNode.children.splice(i+1,0,n)} replaceChildren(...ns){for(const c of this.children)c.parentNode=null;this.children=[];this._text='';this.append(...ns)} remove(){if(this.parentNode?.children)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null}
 setAttribute(n,v){v=String(v);this.attributes.set(n,v);if(n==='class')this.className=v;if(n==='hidden')this.hidden=true;if(n==='disabled')this.disabled=true;if(n==='checked')this.checked=true;if(n==='value')this.value=v;if(n.startsWith('data-'))this.dataset[camel(n.slice(5))]=v} getAttribute(n){return this.attributes.get(n)??null} hasAttribute(n){return this.attributes.has(n)} removeAttribute(n){this.attributes.delete(n);if(n==='hidden')this.hidden=false} toggleAttribute(n,on){on=on??!this.hasAttribute(n);on?this.setAttribute(n,''):this.removeAttribute(n);return on}
 addEventListener(n,f){this.listeners.set(n,[...(this.listeners.get(n)||[]),f])} removeEventListener(){} contains(n){return n===this||this.children.some(x=>x.contains?.(n))} querySelector(s){return this.querySelectorAll(s)[0]||null} querySelectorAll(s){return walk(this).slice(1).filter(n=>matches(n,s))} matches(s){return matches(this,s)} closest(s){for(let n=this;n;n=n.parentNode)if(matches(n,s))return n;return null} getBoundingClientRect(){return {width:600,height:400,top:0,left:0,right:600,bottom:400}} focus(){} insertAdjacentHTML(_p,h){this.after(...parse(this.ownerDocument,h))}
 /* form.elements.<name> -- the walk is keyed by first occurrence, matching
    HTMLFormControlsCollection's own rule closely enough for a single-value
    named field, which is all this page's forms use. */
 get elements(){const named={};const visit=node=>{for(const child of node.children){const name=child.getAttribute('name');if(name&&!(name in named))named[name]=child;visit(child)}};visit(this);return named}
}
class T extends E {constructor(d,t){super(d,'#text');this._text=t}}
function walk(n){return [n,...n.children.flatMap(walk)]}
function matches(n,s){if(s.includes(','))return s.split(',').some(x=>matches(n,x.trim())); if(s.startsWith(':scope > '))s=s.slice(9); const tag=/^[a-z]+/i.exec(s)?.[0];if(tag&&n.tagName!==tag.toUpperCase())return false;for(const c of [...s.matchAll(/\.([\w-]+)/g)])if(!n.classList.contains(c[1]))return false;for(const a of [...s.matchAll(/\[([^\]=]+)(?:="?([^\]"]+)"?)?\]/g)]){const name=a[1],wanted=a[2];let got=name.startsWith('data-')?n.dataset[camel(name.slice(5))]:n.getAttribute(name);if(got==null)return false;if(wanted!=null&&got!==wanted)return false}return !!(tag||s.includes('.')||s.includes('['))}
const VOID=new Set(['input','br','img']);
function parse(doc,h){const root=new E(doc);let cur=root;const re=/<\/?[^>]+>|[^<]+/g;for(const tok of h.match(re)||[]){if(tok.startsWith('</')){cur=cur.parentNode||root;continue}if(tok.startsWith('<')){if(tok.startsWith('<!--'))continue;const m=/^<\s*([\w-]+)/.exec(tok);if(!m)continue;const e=new E(doc,m[1]);for(const a of tok.matchAll(/([:\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)){if(a[1]===m[1])continue;e.setAttribute(a[1],a[2]??a[3]??a[4]??'')}cur.append(e);if(!tok.endsWith('/>')&&!VOID.has(m[1]))cur=e}else if(tok.trim())cur.append(new T(doc,tok.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')))}return root.children}
class D extends E {constructor(){super(null,'document');this.ownerDocument=this;this.body=new E(this,'body');this.documentElement=new E(this,'html');this.activeElement=null;this.defaultView={getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})}}createElement(t){if(t!=='template')return new E(this,t);const e=new E(this,t);e.content={firstElementChild:null};Object.defineProperty(e,'innerHTML',{set:h=>e.content.firstElementChild=parse(this,h)[0]});return e}}
const storage={getItem:()=>null,setItem(){},removeItem(){}}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {userAgent:'node'} });const document=new D();globalThis.document=document;globalThis.localStorage=storage;const windowListeners = new Map(); globalThis.window={document,localStorage,location:{hostname:'127.0.0.1',search:'?bridge=http%3A%2F%2F127.0.0.1%3A4610'},mcShell:{getBridgeProof:async()=>({ok:true,proof:'research-fixture-proof'.padEnd(43,'0')})},addEventListener(type, fn){windowListeners.set(type,[...(windowListeners.get(type)||[]),fn])},removeEventListener(type, fn){windowListeners.set(type,(windowListeners.get(type)||[]).filter(item=>item!==fn))},dispatchEvent(event){for(const fn of windowListeners.get(event.type)||[])fn(event);return true}};globalThis.MutationObserver=class{observe(){}disconnect(){}};globalThis.ResizeObserver=class{observe(){}disconnect(){}};globalThis.requestAnimationFrame=f=>{queueMicrotask(f);return 1}
globalThis.fetch = async input => {
  const url = String(input)
  const response = (ok, body, status = ok ? 200 : 503) => ({ ok, status, statusText: ok ? 'OK' : 'Unavailable', json: async () => structuredClone(body) })
  if (url.includes('/v1/bootstrap')) return response(true, { ok: true, token: 'fixture-token' })
  if (url.endsWith('/v1/actions/research-snapshot')) return response(true, { ok: true, receipt: { projects: [{ projectId: 'rp-abcd', name: 'Alpha', enabled: true }], experiments: {}, assignments: [], settings: { pipelineEnabled: true }, lifecycle: {} } })
  if (url.endsWith('/v1/research/local-tiers-status')) return response(false, { error: { message: 'tiers fixture refused', code: 'TIERS_FIXTURE_REFUSAL' } })
  if (url.endsWith('/data/research-queue.json')) return response(true, { schemaVersion: 1, items: [] })
  if (url.endsWith('/data/research.json')) return response(false, { reason: 'catalog fixture refused' })
  return response(false, { error: { message: `unexpected fixture request: ${url}` } })
}

/* Dynamic imports, after the loader is registered and the window/fetch
   fixtures stand -- research.js pulls in research.css, which only resolves
   under the stub loader registered above. Resolved before the account-bridge
   mock below so its two keys are real bindings, not a forward reference. */
const { saveRefusalSentence } = await import('../../src/agent-tools-markup.js')
const { RESEARCH_QUEUE_ROW_KEY } = await import('../../src/research-queue-store.js')
const { RESEARCH_EXPERIMENTS_ROW_KEY, buildExperiment, serializeExperimentsRow, resetExperimentTracking } = await import('../../src/research-experiments.js')

/* ---------- the fake account bridge ----------
   Reads always succeed -- this suite is about the WRITE refusal, not the read
   side (that honesty question is a separate, already-covered one; see
   src/views/research.js's readQueueRow/readExperimentsRow). `putSettingImpl`
   is swapped per test to answer a named refusal, throw, or succeed. */
let queueRowValue = null
let experimentsRowValue = null
let putSettingImpl = async () => ({ ok: true })

globalThis.window.mcAccount = {
  async getSetting(key) {
    if (key === RESEARCH_QUEUE_ROW_KEY) return { ok: true, accountId: 'save-refusal-account', key, value: queueRowValue }
    if (key === RESEARCH_EXPERIMENTS_ROW_KEY) return { ok: true, accountId: 'save-refusal-account', key, value: experimentsRowValue }
    return { ok: true, accountId: 'save-refusal-account', key, value: null }
  },
  async putSetting(key, value) { return putSettingImpl(key, value) },
}

const { researchView } = await import('../../src/views/research.js')

const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(r=>setTimeout(r, 25));for(let i=0;i<10;i++)await Promise.resolve()}
async function mount() {
  const view = researchView()
  view.el.parentNode = { isConnected: true }
  await settle()
  return view
}

/* Only ONE 'submit' listener is ever registered on the queue module, so
   firing it directly (rather than reimplementing bubbling) cannot pick up an
   unrelated handler by accident. */
function submitForm(moduleRoot, form) {
  for (const listener of moduleRoot.listeners.get('submit') || []) listener({ target: form, preventDefault() {} })
}

const NOTE = { title: 'Tokenizer drift between checkpoints', observation: 'Two checkpoints disagree on 3% of tokenizations.', researchQuestion: 'Does the drift move scores, or only token counts?' }
function fillNoteForm(form) {
  form.elements.title.value = NOTE.title
  form.elements.observation.value = NOTE.observation
  form.elements.researchQuestion.value = NOTE.researchQuestion
}

test('a queue note refused for a reason that is not sign-in states that reason, not "sign in"', async () => {
  queueRowValue = null
  putSettingImpl = async () => ({ ok: false, code: 'ACCOUNT_DATA_FULL', reason: 'An account holds at most 200 settings.' })
  const view = await mount()
  const form = view.el.querySelector('[data-queue-form]')
  assert.ok(form, 'the note form did not render -- readQueueRow must have raised queueSignedOut on a successful read')
  fillNoteForm(form)
  submitForm(view.el.querySelector('[data-mc="queue"]'), form)
  await settle()
  const status = form.querySelector('[data-queue-form-status]')
  assert.equal(status.textContent, saveRefusalSentence({ reason: 'An account holds at most 200 settings.' }),
    'the note form must show the shell\'s own reason, worded exactly as saveRefusalSentence renders it')
  assert.match(status.textContent, /An account holds at most 200 settings\./, 'the real reason from the shell did not reach the form')
  assert.doesNotMatch(status.textContent, /Sign in, then try it again/i, 'a full settings store was blamed on being signed out')
  view.destroy()
})

test('a queue note write that throws gets the reasonless fallback, not a sign-in instruction', async () => {
  queueRowValue = null
  putSettingImpl = async () => { throw new Error('bridge unavailable') }
  const view = await mount()
  const form = view.el.querySelector('[data-queue-form]')
  fillNoteForm(form)
  submitForm(view.el.querySelector('[data-mc="queue"]'), form)
  await settle()
  const status = form.querySelector('[data-queue-form-status]')
  assert.equal(status.textContent, saveRefusalSentence(undefined),
    'a thrown write must fall back to the reasonless sentence, worded exactly as saveRefusalSentence renders it')
  assert.doesNotMatch(status.textContent, /Sign in, then try it again/i, 'a call that threw was blamed on being signed out')
  view.destroy()
})

test('a queue note the account store kept is unchanged: no refusal sentence, the note is on the bench', async () => {
  queueRowValue = null
  putSettingImpl = async () => ({ ok: true })
  const view = await mount()
  const form = view.el.querySelector('[data-queue-form]')
  fillNoteForm(form)
  submitForm(view.el.querySelector('[data-mc="queue"]'), form)
  await settle()
  const status = form.querySelector('[data-queue-form-status]')
  assert.equal(status.textContent, '', 'a kept write must not show any refusal sentence')
  assert.match(view.el.querySelector('[data-mc="queue"]').querySelector('[data-research-queue]').textContent, /Tokenizer drift between checkpoints/,
    'the saved note must render onto the bench')
  view.destroy()
})

/* ---------- the experiment bench's Remove, armed then confirmed ----------
   moduleEl('designer') carries THREE 'click' listeners for three unrelated
   concerns (run/remove; the axis/column row builder; open, duplicate and the
   starter templates). A real click bubbles to all three, and the second and
   third read `event.target.closest(...)` -- which this stand-in's simplified
   `matches()` resolves for `li[data-research-experiment] h3` against ANY
   `[data-research-experiment]` ancestor, ignoring the h3, so a real button
   node would wrongly open the gathered panel and re-render the module out
   from under the very button this test presses. A bare object carrying only
   what the run/remove listener reads (`dataset`, `textContent`) has no
   `.closest` to call, so `event.target?.closest?.(...)` short-circuits to
   `undefined` in the other two listeners and they no-op -- exactly the
   production code's own guard, not a workaround this suite invented. */
function seedOneExperiment() {
  resetExperimentTracking()
  const built = buildExperiment({
    name: 'Tokenizer drift sweep',
    axes: [{ id: 'tier', values: ['luna'] }],
    runner: { kind: 'agent', briefTemplate: 'Read {dataset} and report the drift.' },
    runsPerCell: 1,
    datasetPath: null,
  }, { experiments: [], damaged: false })
  assert.equal(built.ok, true, `fixture experiment failed to build: ${built.sentence}`)
  experimentsRowValue = serializeExperimentsRow({ experiments: [built.experiment] })
  return built.experiment.id
}

function pressRemoveTwice(designerRoot, id) {
  const target = { dataset: { expRemove: id }, textContent: '' }
  const press = () => { for (const listener of designerRoot.listeners.get('click') || []) listener({ target }) }
  press()
  press()
  return target
}

test('an experiment removal the account store refused states the real reason, not "sign in"', async () => {
  const id = seedOneExperiment()
  putSettingImpl = async () => ({ ok: false, code: 'ACCOUNT_DATA_WRITE_FAILED', reason: 'That setting could not be saved on this computer.' })
  const view = await mount()
  const designer = view.el.querySelector('[data-mc="designer"]')
  assert.ok(designer.querySelector(`[data-exp-remove="${id}"]`), 'the seeded experiment did not render onto the bench')
  const button = pressRemoveTwice(designer, id)
  await settle()
  assert.equal(button.textContent, saveRefusalSentence({ reason: 'That setting could not be saved on this computer.' }),
    'the Remove control must show the shell\'s own reason, worded exactly as saveRefusalSentence renders it')
  assert.doesNotMatch(button.textContent, /Sign in, then try it again/i, 'a refused disk write was blamed on being signed out')
  view.destroy()
})

test('an experiment removal that throws gets the reasonless fallback, not a sign-in instruction', async () => {
  const id = seedOneExperiment()
  putSettingImpl = async () => { throw new Error('bridge unavailable') }
  const view = await mount()
  const designer = view.el.querySelector('[data-mc="designer"]')
  const button = pressRemoveTwice(designer, id)
  await settle()
  assert.equal(button.textContent, saveRefusalSentence(undefined),
    'a thrown write must fall back to the reasonless sentence, worded exactly as saveRefusalSentence renders it')
  assert.doesNotMatch(button.textContent, /Sign in, then try it again/i, 'a call that threw was blamed on being signed out')
  view.destroy()
})

test('an experiment removal the account store kept is unchanged: the experiment leaves the bench', async () => {
  const id = seedOneExperiment()
  putSettingImpl = async () => ({ ok: true })
  const view = await mount()
  const designer = view.el.querySelector('[data-mc="designer"]')
  pressRemoveTwice(designer, id)
  await settle()
  assert.equal(designer.querySelector(`[data-exp-remove="${id}"]`), null, 'a kept removal must take the experiment off the bench')
  view.destroy()
})

test('the true signed-out sentences are untouched: no account bridge at all is still told to sign in', async () => {
  const realAccount = globalThis.window.mcAccount
  globalThis.window.mcAccount = undefined
  try {
    const view = await mount()
    assert.match(view.el.querySelector('[data-mc="queue"]').textContent, /Sign in to write notes here/,
      'a genuinely absent account bridge lost its own signed-out sentence')
    view.destroy()
  } finally {
    globalThis.window.mcAccount = realAccount
  }
})
