/* THE EXAMPLE LIBRARY IS NOT PART OF THE APP'S STARTUP.
 *
 * src/research-examples.mjs is ~400 KB of donor material for one tab of one
 * page, and the chain main.js -> views/research.js -> research-benchmark.js is
 * static all the way down. While research-benchmark.js imported the library
 * statically, every one of those bytes was fetched and parsed on every app
 * launch, whether or not anybody opened Research.
 *
 * What is asserted here is the module graph itself, recorded from node's
 * loader, not a source-text search for an `import` line: a spelling check
 * cannot see a module reached two hops away and fails against a better
 * spelling of the same thing.
 */
import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { genericStarter } from '../../src/benchmark/starters.mjs'

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })

const { port1, port2 } = new MessageChannel()
const loaded = []
port1.on('message', url => loaded.push(url))
port1.unref()
register('./module-load-recorder.mjs', import.meta.url, { data: { port: port2 }, transferList: [port2] })

// The hook runs off-thread, so give its messages a turn of the event loop to
// arrive before reading them. If they never arrived the recording would be
// empty and the graph assertion would pass for nothing, which is why the first
// thing checked is that something WAS recorded.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) }
const timesLoaded = name => loaded.filter(url => url.endsWith('/' + name)).length

await import('../../src/research-benchmark.js')
await settle()
const afterPage = [...loaded]
// Captured before any test asks for the library, so the order tests run in
// cannot change what this says.
const seam = await import('../../src/research-examples-lazy.mjs')
const loadedAtStartup = seam.exampleSnippetsLoaded()

test('importing the Research page does not pull the example library into the graph', () => {
  assert.ok(afterPage.some(url => url.endsWith('/research-benchmark.js')),
    'the recorder is recording; an empty recording would pass the next assertion for nothing')
  assert.ok(afterPage.some(url => url.endsWith('/research-examples-lazy.mjs')),
    'the page does reach the seam that knows how to load the library')
  assert.equal(afterPage.some(url => url.endsWith('/research-examples.mjs')), false,
    'but the library itself is not in the page’s static graph, so it costs nothing at app startup')
  assert.equal(loadedAtStartup, false, 'and the seam agrees it has not been asked for one')
})

test('asking for the library loads it, once, and it merges on demand', async () => {
  const { importSnippetLibrary } = await import('../../src/research-snippets.mjs')
  const first = await seam.loadExampleSnippets()
  await settle()
  assert.equal(seam.exampleSnippetsLoaded(), true, 'now it is here')
  assert.equal(timesLoaded('research-examples.mjs'), 1, 'the loader really did fetch it, exactly once')

  // It merges exactly as the static import used to, through the ordinary
  // import path a person's own exported file takes.
  const starter = genericStarter().catalog
  const merged = importSnippetLibrary(first.exampleSnippetLibrary(), starter)
  assert.equal(merged.length, starter.length + first.EXAMPLE_SNIPPET_IDS.length)
  for (const id of first.EXAMPLE_SNIPPET_IDS) assert.ok(merged.some(bundle => bundle.id === id), `${id} merged`)

  // Asking again costs no second load.
  const second = await seam.loadExampleSnippets()
  await settle()
  assert.equal(second, first, 'the same module object, not a second copy')
  assert.equal(timesLoaded('research-examples.mjs'), 1, 'and the loader was not asked for it again')
})

test('once loaded the seam answers isExampleSnippet exactly, edits included', async () => {
  const library = await seam.loadExampleSnippets()
  const shipped = library.exampleSnippetLibrary().catalog
  assert.ok(shipped.length > 0)
  for (const bundle of shipped) assert.equal(seam.isExampleSnippet(bundle), true, `${bundle.id} is a shipped example`)
  // The check is the exact content comparison, not an identifier set: an edited
  // bundle keeps its id and is no longer an unedited example.
  const edited = { ...structuredClone(shipped[0]), text: shipped[0].text + ' edited' }
  assert.equal(seam.isExampleSnippet(edited), false, 'an edited example is not an unedited example')
  assert.equal(seam.isExampleSnippet(genericStarter().catalog[0]), false, 'and a starter bundle was never one')
})
