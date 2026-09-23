/* PROMPT B. WHAT THE DATA WORKSPACE SAYS THE MOMENT A PERSON ARRIVES.
 *
 * Three of the four ways the saved-folder lookup can end used to end without a
 * word, so a page with no folder and a page whose folder did not answer looked
 * identical -- and identical to a page still trying. Somebody who cannot find
 * their data is in exactly that state, so each ending has to name itself.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./css-loader.mjs', import.meta.url)
const { restore } = installDomStandIn(globalThis)
const { createResearchDataWorkspace } = await import('../../src/research-data-workspace.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const status = view => view.el.querySelector('[data-rd-status]').textContent

async function arrive(fetchImpl) {
  const view = createResearchDataWorkspace({ fetchImpl, downloadFile: () => {} })
  document.body.append(view.el)
  await settle()
  return view
}
const json = body => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => body })

test('no pointer file at all is said plainly, with the two ways forward', async () => {
  const view = await arrive(async () => ({ ok: false, status: 404, headers: { get: () => 'text/html' } }))
  assert.match(status(view), /no saved folder/i)
  assert.match(status(view), /Open a folder or import files/i, 'it names what to do instead')
  view.destroy()
})

test('a pointer served as something other than JSON is not read as an empty workspace', async () => {
  const view = await arrive(async () => ({ ok: true, headers: { get: () => 'text/html' } }))
  assert.match(status(view), /no saved folder/i)
  view.destroy()
})

test('a pointer that names no folder says so rather than going quiet', async () => {
  for (const body of [{}, { url: '' }, { url: 42 }]) {
    const view = await arrive(async () => json(body))
    assert.match(status(view), /names no folder/i, JSON.stringify(body))
    assert.match(status(view), /Open a folder or import files/i)
    view.destroy()
  }
})

test('a pointer this page cannot even read names the reason', async () => {
  const view = await arrive(async () => { throw new Error('offline') })
  assert.match(status(view), /could not be read/i)
  assert.match(status(view), /offline/, 'the reason travels')
  assert.match(status(view), /Open a folder or import files/i)
  view.destroy()
})

test('a saved folder that does not answer names itself, its reason and the way round it', async () => {
  const view = await arrive(async path => {
    if (String(path).includes('research-workspace.json')) return json({ url: 'http://127.0.0.1:57923' })
    throw new Error('connection refused')
  })
  assert.match(status(view), /127\.0\.0\.1:57923/, 'the folder it tried is named')
  assert.match(status(view), /did not answer/i)
  assert.match(status(view), /connection refused/, 'the reason travels')
  assert.match(status(view), /open a folder or import files/i)
  view.destroy()
})

test('while it is looking, it says it is looking', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const view = createResearchDataWorkspace({ fetchImpl: () => held, downloadFile: () => {} })
  document.body.append(view.el)
  await settle()
  assert.match(status(view), /Looking for the folder/i, 'an arrival in flight is not silence')
  release({ ok: false, headers: { get: () => 'text/html' } })
  await settle()
  assert.match(status(view), /no saved folder/i)
  view.destroy()
})

test('a folder the person opened themselves is never overwritten by the saved one', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  const view = createResearchDataWorkspace({ fetchImpl: () => held, downloadFile: () => {} })
  document.body.append(view.el)
  await settle()
  await view.setSource({ name: 'A folder they chose', entries: async () => [], text: async () => ({ text: '', size: 0 }) })
  await settle()
  release(json({ url: 'http://127.0.0.1:57923' }))
  await settle()
  assert.equal(status(view).includes('no saved folder'), false)
  assert.equal(status(view).includes('did not answer'), false)
  assert.match(view.el.querySelector('[data-rd-folder-name]').textContent, /A folder they chose/)
  view.destroy()
})

test.after(() => restore())
