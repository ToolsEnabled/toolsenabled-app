import { useArithmeticExample } from './lib/benchmark-example.mjs'
// The Study version field on the Research page: its stated rules, its live
// echo of the normalized value, and the value reaching the saved draft.
// The rules themselves are tested in research-benchmark-study-version.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { RUNTIME_FILES, STUDY_VERSION_RULES } from '../../src/benchmark/study.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, fixture, cryptoDescriptor
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await pause() }
  assert.fail('the benchmark UI did not settle')
}
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
function fill(view, name, value) { const input = f(view, name); assert.equal(input.disabled, false); input.value = value; input.dispatch('input') }
async function click(view, name) { assert.equal(f(view, name).disabled, false, `${name} is available`); f(view, name).click(); await idle(view) }
const echo = view => f(view, 'study-version-status').textContent
async function mount() {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => sources, download: (name, contents) => fixture.downloads.push({ name, contents }) })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await useArithmeticExample(view)
  await until(() => f(view, 'preview-meta').textContent.includes('components') && f(view, 'review-status').textContent.includes('SHA-256'))
  return view
}
beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map(), downloads: [] }
  fixture.account = {
    async getSetting(key) { return { ok: true, value: fixture.values.get(key) ?? null } },
    async putSetting(key, value) { fixture.values.set(key, value); return { ok: true } },
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause()
  installed.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

test('the page states the study version rules and echoes what each entry will freeze as', async () => {
  const view = await mount()
  assert.ok(f(view, 'study-version'), 'the Study version field exists')
  // The rules the page shows are the exported rules, so the two cannot drift.
  for (const rule of STUDY_VERSION_RULES) assert.ok(view.el.textContent.includes(rule), rule)

  assert.match(echo(view), /No study version declared/)
  assert.match(echo(view), /1\.0\.0/)

  fill(view, 'study-version', '1.0.44')
  assert.match(echo(view), /Study version 1\.0\.44/)
  assert.match(echo(view), /package\.json/)

  // .44 is completed, and the completed form is shown before anything freezes.
  fill(view, 'study-version', '.44')
  assert.match(echo(view), /\.44 is read as 0\.44\.0/)

  fill(view, 'study-version', 'v2')
  assert.match(echo(view), /v2 is read as 2\.0\.0/)

  fill(view, 'study-version', '1.0.44.2')
  assert.match(echo(view), /three numbers/)

  fill(view, 'study-version', '01.0.44')
  assert.match(echo(view), /start with a zero/)

  fill(view, 'study-version', '')
  assert.match(echo(view), /No study version declared/)
})

test('the study version reaches the exported draft and survives reopening the project', async () => {
  const view = await mount()
  fill(view, 'name', 'Lean Bench 1.0.44')
  fill(view, 'id', 'lean-bench-1-0-44')
  fill(view, 'study-version', '.44')
  await click(view, 'save')
  await click(view, 'draft-export')
  const draft = JSON.parse(fixture.downloads.at(-1).contents)
  assert.equal(draft.spec.version, '0.44.0')
  assert.equal(draft.spec.id, 'lean-bench-1-0-44')

  // Reopening reads back the normalized value, not the keystrokes.
  const reopened = await mount()
  assert.equal(f(reopened, 'study-version').value, '0.44.0')
  assert.match(echo(reopened), /Study version 0\.44\.0/)
})
