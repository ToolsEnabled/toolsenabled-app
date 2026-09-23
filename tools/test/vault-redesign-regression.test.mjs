// T574 component regression: synthetic metadata and approval receipts only.
// Browser keyboard/CSS and native persistence are qualified separately.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const draft = new URL('../../', import.meta.url)
const dom = installDomStandIn(globalThis)
// Stand-in lacks selector lists and colons within quoted attribute values.
// Extend only those generic DOM mechanics, never product selectors or results.
const oldQuery = Element.prototype.querySelectorAll
const oldReplace = Element.prototype.replaceChildren
Element.prototype.querySelectorAll = function(selector) {
  if (selector.includes(',')) return [...new Set(selector.split(',').flatMap(part => this.querySelectorAll(part.trim())))]
  if (/^\[[\w-]+="[^"]*"\]$/.test(selector)) {
    const result = []
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) result.push(child); visit(child) } }
    visit(this)
    return result
  }
  return oldQuery.call(this, selector)
}
Element.prototype.replaceChildren = function(...nodes) {
  const active = this.ownerDocument?.activeElement
  if (active && active !== this && this.contains(active)) this.ownerDocument.activeElement = this.ownerDocument.body
  return oldReplace.apply(this, nodes)
}
after(() => {
  Element.prototype.querySelectorAll = oldQuery
  Element.prototype.replaceChildren = oldReplace
  dom.restore()
})
const { vaultView, matrixRoles } = await import(new URL('src/views/vault.js', draft))
const { createVaultCredentialsSettings } = await import(new URL('src/vault-credentials-settings.js', draft))
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b}); return {promise,resolve,reject} }
const turns = async (n=40) => { for(let i=0;i<n;i++) await Promise.resolve() }
const q = (root, selector) => { const node=root.querySelector(selector); assert.ok(node, selector); return node }
const type = (root, selector, value) => { const node=q(root,selector); node.value=value; node.dispatch('input'); return node }
const change = (root, selector, value) => { const node=q(root,selector); node.checked=value; node.dispatch('change') }
function bridge() {
  const state = { names:['record_a'], records:{}, pending:[], calls:[] }
  const api = {
    names: async()=>({ok:true,names:[...state.names]}),
    policy: async()=>({readable:true,records:structuredClone(state.records)}),
    pendingRemovals: async()=>({ok:true,pending:structuredClone(state.pending)}),
    setAccess: async request => {
      state.calls.push(['access',request])
      const record=state.records[request.name] ||= {nickname:'',access:{}}
      record.access[request.subject]=request.allowed
      return {ok:true}
    },
    setNickname: async request => {
      state.calls.push(['nickname',request])
      const record=state.records[request.name] ||= {nickname:'',access:{}}
      record.nickname=request.nickname || ''
      return {ok:true}
    },
    add: async request => {state.calls.push(['add',request]); return {ok:true}},
    requestRemoval: async ({name}) => {state.calls.push(['request',name]); return {ok:true,promptId:'prompt-'+name,reused:true}},
    completeRemoval: async request => {
      state.calls.push(['complete',request])
      state.names=state.names.filter(name=>name!==request.name)
      state.pending=state.pending.filter(item=>item.name!==request.name)
      return {ok:true,removed:true}
    },
  }
  return {state,api}
}
async function mount(t, api) {
  const view=vaultView({vault:api})
  document.body.appendChild(view.el)
  t.after(()=>{view.destroy();view.el.remove()})
  await turns()
  return view
}

test('nickname save immediately redacts both lists and unreadable policy stays redacted', async t=>{
  const {state,api}=bridge()
  const gate=deferred()
  api.setNickname=async request=>{await gate.promise; state.records[request.name]={nickname:request.nickname,access:{}}; return {ok:true}}
  const view=await mount(t,api)
  assert.equal(q(view.el,'[data-vault-name]').textContent,'record_a')
  type(view.el,'[data-vault-nickname]','private label')
  q(view.el,'[data-vault-save-nickname]').click()
  assert.equal(view.el.querySelector('[data-vault-shown]'),null)
  assert.equal(q(view.el,'[data-vault-name]').textContent,'Credential')
  gate.resolve()
  await turns()
  assert.equal(q(view.el,'[data-vault-shown]').textContent,'private label')
  assert.equal(q(view.el,'[data-vault-name]').textContent,'private label')
  api.policy=async()=>{throw new Error('unavailable')}
  await view.refresh()
  assert.equal(view.el.querySelector('[data-vault-shown]'),null)
  assert.equal(q(view.el,'[data-vault-name]').textContent,'Credential')
  assert.equal(q(view.el,'[data-vault-remove]').disabled,true)
})

test('role and exact-agent restrictions survive search/filter repaint on previously unruled records',async t=>{
  const {state,api}=bridge()
  const view=await mount(t,api)
  const role=matrixRoles()[0].id
  change(view.el,'[data-vault-role="'+role+'"]',false)
  await turns()
  const filter=q(view.el,'[data-vault-filter]')
  filter.value='restricted';filter.dispatch('change')
  assert.equal(q(view.el,'[data-vault-role="'+role+'"]').checked,false)
  type(view.el,'[data-vault-agent-id]','agent:sample')
  change(view.el,'[data-vault-agent-allowed]',false)
  q(view.el,'[data-vault-save-agent]').click()
  await turns()
  type(view.el,'[data-vault-search]','no match')
  assert.equal(view.el.querySelector('[data-vault-shown]'),null)
  type(view.el,'[data-vault-search]','record')
  assert.equal(q(view.el,'[data-vault-field="access:agent:sample"]').checked,false)
  assert.deepEqual(state.records.record_a.access,{[role]:false,'agent:sample':false})
})

test('pending writes stay disabled through repaint; disposed view ignores late completion',async t=>{
  const {state,api}=bridge(), gate=deferred()
  api.setAccess=async request=>{state.calls.push(request);return gate.promise}
  const view=await mount(t,api)
  const role=matrixRoles()[0].id
  change(view.el,'[data-vault-role="'+role+'"]',false)
  type(view.el,'[data-vault-search]','record')
  assert.equal(q(view.el,'[data-vault-role="'+role+'"]').disabled,true)
  change(view.el,'[data-vault-role="'+role+'"]',true)
  assert.equal(state.calls.length,1)
  view.destroy()
  const text=view.el.textContent
  gate.resolve({ok:true})
  await turns()
  assert.equal(view.el.textContent,text)
})

test('credential named add has independent pending state and approved removal reuses exact prompt',async t=>{
  const {state,api}=bridge(), gate=deferred()
  state.names=['add']
  state.pending=[{name:'add',promptId:'prompt-add',decision:'approved'}]
  api.add=async request=>{state.calls.push(['add',request]);return gate.promise}
  const panel=createVaultCredentialsSettings({vault:api})
  document.body.appendChild(panel.element)
  t.after(()=>{panel.destroy();panel.element.remove()})
  await panel.refresh()
  q(panel.element,'[data-vault-new-name]').value='new_record'
  const adding=panel.add()
  await turns(3)
  assert.equal(q(panel.element,'[data-vault-remove="add"]').disabled,false)
  await panel.askToRemove('add')
  assert.ok(state.calls.some(([kind,name])=>kind==='request'&&name==='add'))
  gate.resolve({ok:true})
  await adding
  await turns()
  assert.ok(q(panel.element,'[data-vault-finish="add"]'))
  await panel.finishRemoval('add')
  assert.deepEqual(state.calls.find(([kind])=>kind==='complete')[1],{name:'add',promptId:'prompt-add'})
  assert.equal(panel.element.querySelector('[data-vault-item="add"]'),null)
})

test('approval reconciliation drains across stale-read and operation-completion microtask schedules',async t=>{
  // Exercise a bounded set of actual promise orderings, including completion
  // while the stale read promise is settling. Do not inspect internal state.
  for(let offset=0;offset<=8;offset++){
    const {api}=bridge(), firstRead=deferred(), adding=deferred()
    let reads=0
    api.pendingRemovals=()=>++reads===1?firstRead.promise:Promise.resolve({ok:true,pending:[{name:'record_a',promptId:'p',decision:'approved'}]})
    api.add=()=>adding.promise
    const panel=createVaultCredentialsSettings({vault:api})
    document.body.appendChild(panel.element)
    try {
      const refreshing=panel.refresh()
      await turns(5)
      assert.equal(reads,1)
      q(panel.element,'[data-vault-new-name]').value='queued_record'
      const operation=panel.add()
      firstRead.resolve({ok:true,pending:[]})
      await turns(offset)
      adding.resolve({ok:true})
      await Promise.all([refreshing,operation])
      await turns()
      assert.ok(reads>=2,'no reconciliation at offset '+offset)
      assert.ok(panel.element.querySelector('[data-vault-finish="record_a"]'),'approved control lost at offset '+offset)
      const before=reads
      await turns()
      assert.equal(reads,before,'read loop failed to become idle')
    } finally {panel.destroy();panel.element.remove()}
  }
})

test('failed approval read stops; disposal does not paint or restart late read',async()=>{
  const {api}=bridge()
  let reads=0
  api.pendingRemovals=async()=>{reads++;throw new Error('unavailable')}
  const panel=createVaultCredentialsSettings({vault:api})
  document.body.appendChild(panel.element)
  try {
    await panel.refresh()
    await turns()
    assert.equal(reads,1)
    assert.equal(panel.element.querySelector('[data-vault-finish]'),null)
    const gate=deferred()
    api.pendingRemovals=()=>{reads++;return gate.promise}
    const refreshing=panel.refresh()
    await turns(5)
    panel.destroy()
    const text=panel.element.textContent
    gate.resolve({ok:true,pending:[{name:'record_a',promptId:'p',decision:'approved'}]})
    await refreshing
    await turns()
    assert.equal(panel.element.textContent,text)
    assert.equal(reads,2)
  } finally {panel.destroy();panel.element.remove()}
})

test('successful embedded removal updates main snapshot and retains backend confirmation',async t=>{
  const {state,api}=bridge()
  state.pending=[{name:'record_a',promptId:'approved-p',decision:'approved'}]
  const view=await mount(t,api)
  q(view.el,'[data-vault-finish="record_a"]').click()
  await turns(80)
  assert.deepEqual(state.calls.find(([kind])=>kind==='complete')[1],{name:'record_a',promptId:'approved-p'})
  assert.equal(view.el.querySelector('[data-vault-shown]'),null)
  assert.equal(view.el.querySelector('[data-vault-item="record_a"]'),null)
})

test('panel focus survives invalidation and main nickname drafts survive repaint',async t=>{
  const {api}=bridge()
  const panel=createVaultCredentialsSettings({vault:api})
  document.body.appendChild(panel.element)
  t.after(()=>{panel.destroy();panel.element.remove()})
  await panel.refresh()
  q(panel.element,'[data-vault-remove="record_a"]').focus()
  panel.invalidate()
  assert.equal(document.activeElement,document.body)
  await panel.setSnapshot({ok:true,names:['record_a']})
  assert.equal(document.activeElement,q(panel.element,'[data-vault-remove="record_a"]'))
  const view=await mount(t,api)
  const details=q(view.el,'.vault-card-details')
  details.open=true;details.dispatch('toggle')
  type(view.el,'[data-vault-nickname]','unsaved draft').focus()
  await view.refresh()
  assert.equal(q(view.el,'[data-vault-nickname]').value,'unsaved draft')
  assert.equal(q(view.el,'.vault-card-details').open,true)
  assert.equal(document.activeElement,q(view.el,'[data-vault-nickname]'))
})


test('opening one credential editor closes the previous editor without losing its draft or focus target', async t => {
  const { state, api } = bridge()
  state.names = ['record_a', 'record_b']
  const view = await mount(t, api)
  const first = q(view.el, '[data-vault-key="record_a"]')
  const second = q(view.el, '[data-vault-key="record_b"]')
  const firstEditor = q(first, '.vault-card-details')
  const secondEditor = q(second, '.vault-card-details')
  firstEditor.open = true
  firstEditor.dispatch('toggle')
  type(first, '[data-vault-nickname]', 'unsaved private label')
  const secondSummary = q(secondEditor, 'summary')
  secondSummary.focus()
  secondEditor.open = true
  secondEditor.dispatch('toggle')
  assert.equal(firstEditor.open, false, 'only the selected credential editor should remain open')
  assert.equal(secondEditor.open, true)
  assert.equal(document.activeElement, secondSummary, 'opening an editor must not rebuild its focused control')
  firstEditor.open = true
  firstEditor.dispatch('toggle')
  assert.equal(secondEditor.open, false)
  assert.equal(q(first, '[data-vault-nickname]').value, 'unsaved private label')
  await view.refresh()
  const restored = q(view.el, '[data-vault-key="record_a"]')
  assert.equal(q(restored, '.vault-card-details').open, true)
  assert.equal(q(restored, '[data-vault-nickname]').value, 'unsaved private label')
  secondEditor.open = true
  secondEditor.dispatch('toggle') // A browser may deliver an old detached row's queued toggle.
  assert.equal(q(restored, '.vault-card-details').open, true, 'a stale editor event cannot close the current editor')
  q(restored, '[data-vault-close-editor]').click()
  assert.equal(q(restored, '.vault-card-details').open, false)
  assert.equal(document.activeElement, q(restored, '[data-vault-field="edit-summary"]'))
  assert.deepEqual(state.calls, [], 'opening, closing and refreshing must not save a draft or alter grants')
})

test('credential summaries and search use private labels while retaining exact role and agent decisions', async t => {
  const { state, api } = bridge()
  state.names = ['record_a', 'record_b']
  state.records.record_a = { nickname: 'Private label', access: { builder: false, 'agent:restricted': false, 'agent:allowed': true } }
  const view = await mount(t, api)
  const row = q(view.el, '[data-vault-key="record_a"]')
  assert.equal(q(row, '[data-vault-shown]').textContent, 'Private label')
  assert.equal(q(row, '[data-vault-access-summary]').textContent, '2 access restrictions · 2 individual agent rules')
  assert.equal(q(row, '[data-vault-role="builder"]').checked, false)
  assert.equal(q(row, '[data-vault-role="reviewer"]').checked, true)
  assert.equal(q(row, '[data-vault-field="access:agent:restricted"]').checked, false)
  assert.equal(q(row, '[data-vault-field="access:agent:allowed"]').checked, true)
  type(view.el, '[data-vault-search]', 'record_a')
  assert.equal(view.el.querySelector('[data-vault-shown]'), null, 'a hidden real name must not become a search hint')
  type(view.el, '[data-vault-search]', 'private')
  assert.equal(q(view.el, '[data-vault-shown]').textContent, 'Private label')
  assert.equal(q(view.el, '[data-vault-count]').textContent, '1 of 2 credentials')
  assert.deepEqual(state.calls, [])
})

test('refresh and pending access writes visibly identify their state without claiming an unsaved grant', async t => {
  const { state, api } = bridge()
  const view = await mount(t, api)
  const reading = deferred()
  api.names = () => reading.promise
  const refresh = view.refresh()
  assert.equal(view.el.getAttribute('aria-busy'), 'true')
  assert.match(q(view.el, '[data-vault-status]').textContent, /Reading/)
  assert.equal(view.el.querySelector('[data-vault-shown]'), null)
  reading.resolve({ ok: true, names: ['record_a'] })
  await refresh
  assert.equal(view.el.getAttribute('aria-busy'), 'false')

  const saving = deferred()
  api.setAccess = request => { state.calls.push(['access', request]); return saving.promise }
  change(view.el, '[data-vault-role="builder"]', false)
  const row = q(view.el, '[data-vault-key="record_a"]')
  assert.equal(row.getAttribute('aria-busy'), 'true')
  assert.match(q(row, '[data-vault-save-state]').textContent, /Saving/)
  assert.equal(q(row, '[data-vault-role="builder"]').checked, true, 'the displayed grant remains applied while the request is pending')
  assert.equal(q(row, '[data-vault-role="builder"]').disabled, true)
  assert.equal(q(row, '[data-vault-close-editor]').disabled, false, 'the editor can be closed without cancelling a write')
  saving.resolve({ ok: false })
  await turns()
  const restored = q(view.el, '[data-vault-key="record_a"]')
  assert.equal(restored.getAttribute('aria-busy'), 'false')
  assert.equal(q(restored, '[data-vault-role="builder"]').checked, true)
  assert.equal(q(restored, '[data-vault-role="builder"]').disabled, false)
  assert.match(q(view.el, '[data-vault-status]').textContent, /could not be saved/)
  assert.deepEqual(state.calls, [['access', { name: 'record_a', subject: 'builder', allowed: false }]])
})
