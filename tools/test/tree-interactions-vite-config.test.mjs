import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { normalizePath } from 'vite'
import { treeInteractionViteConfig } from './fixtures/tree-interactions-vite-config.mjs'

const TEST_FILE = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(TEST_FILE), '../..')
const OUT = path.join(ROOT, 'tools', 'test', '.t979-retained-vite-out')
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
const installedLibCore = normalizePath(fs.realpathSync(
  requireFromRoot.resolve('highlight.js/lib/core')
))
const highlightPackageRoot = path.dirname(path.dirname(installedLibCore))
const installedEsCore = fs.realpathSync(path.join(highlightPackageRoot, 'es', 'core.js'))
const installedEsJavascript = fs.realpathSync(path.join(
  highlightPackageRoot, 'es', 'languages', 'javascript.js'
))
const installedCoreSource = fs.readFileSync(installedLibCore, 'utf8')
const installedEsCoreSource = fs.readFileSync(installedEsCore, 'utf8')
const installedEsJavascriptSource = fs.readFileSync(installedEsJavascript, 'utf8')

after(() => {
  esbuild.stop()
})

function retainedConfig() {
  return treeInteractionViteConfig({
    root: ROOT,
    out: OUT,
    retainBrowser: true
  })
}

function ordinaryConfig() {
  return treeInteractionViteConfig({
    root: ROOT,
    out: OUT,
    retainBrowser: false
  })
}

function highlightPlugin(config) {
  const plugin = config.plugins?.find(candidate => (
    candidate && typeof candidate.transform === 'function'
  ))
  assert.ok(plugin, 'retained config must provide a transform-capable plugin')
  return plugin
}

let fixtureSequence = 0

// Node's ordinary loader can enforce browser-style ESM semantics without a
// VM-only command-line flag. The private URL graph uses the installed source
// bytes unchanged; only the selected core's transform output varies.
async function importHighlightFixture(coreImplementationSource, withJavascript = false) {
  const base = new URL(`t1002-highlight://fixture-${++fixtureSequence}/`)
  const entryUrl = new URL('es/core.js', base).href
  const languageUrl = new URL('es/languages/javascript.js', base).href
  const sources = new Map([
    [entryUrl, installedEsCoreSource],
    [new URL('lib/core.js', base).href, coreImplementationSource],
    [languageUrl, installedEsJavascriptSource],
  ])
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (sources.has(specifier)) return { url: specifier, shortCircuit: true }
      if (context.parentURL?.startsWith(base.href)) {
        const url = new URL(specifier, context.parentURL).href
        if (!sources.has(url)) throw new Error('Unexpected highlight fixture import: ' + specifier)
        return { url, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (sources.has(url)) return { format: 'module', source: sources.get(url), shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  try {
    const core = await import(entryUrl)
    const javascript = withJavascript ? await import(languageUrl) : null
    return { core: core.default, javascript: javascript?.default }
  } finally {
    hooks.deregister()
  }
}

test('retained config preserves optimizer, server, cache, and filesystem values', () => {
  const retained = retainedConfig()
  const ordinary = ordinaryConfig()
  const expectedAllow = [
    ROOT,
    fs.realpathSync(path.join(ROOT, 'node_modules'))
  ]

  assert.deepEqual(retained.optimizeDeps, {
    noDiscovery: true,
    include: []
  })
  assert.equal(ordinary.optimizeDeps, undefined)
  assert.equal(retained.configFile, false)
  assert.equal(ordinary.configFile, false)
  assert.equal(retained.root, ROOT)
  assert.equal(ordinary.root, ROOT)
  assert.equal(ordinary.plugins, undefined)
  assert.equal(retained.cacheDir, path.join(OUT, 'vite-cache'))
  assert.equal(ordinary.cacheDir, retained.cacheDir)
  assert.deepEqual(retained.server, {
    host: '127.0.0.1',
    port: 0,
    hmr: false,
    watch: null,
    fs: { allow: expectedAllow }
  })
  assert.deepEqual(ordinary.server, retained.server)
  assert.deepEqual(retained.server.fs.allow, expectedAllow)
})

test('retained plugin filters query/native paths and reports non-native separators', async () => {
  const plugin = highlightPlugin(retainedConfig())
  const nativeTransform = await plugin.transform(
    installedCoreSource,
    installedLibCore + '?import'
  )
  assert.ok(nativeTransform && typeof nativeTransform.code === 'string')
  assert.notEqual(nativeTransform.code, installedCoreSource)

  const separatorVariant = installedLibCore.split('/').join('\\')
  const separatorResult = await plugin.transform(
    installedCoreSource,
    separatorVariant + '?browser'
  )
  if (process.platform === 'win32') {
    assert.ok(separatorResult && typeof separatorResult.code === 'string')
  } else {
    assert.equal(separatorResult, null)
    console.error(
      'T979 platform diagnostic: non-native Windows separators are not credited on ' +
      process.platform
    )
  }

  const unrelatedId = path.join(path.dirname(installedLibCore), 'unrelated.js')
  assert.equal(await plugin.transform(installedCoreSource, unrelatedId), null)
})

test('unconverted core fails ESM default linkage while transformed core evaluates and highlights JavaScript', async () => {
  let observedBaselineError
  const baselineLink = importHighlightFixture(installedCoreSource).catch(error => {
    observedBaselineError = error
    throw error
  })
  await assert.rejects(
    baselineLink,
    error => {
      observedBaselineError = error
      console.error(
        'T979 unconverted-core linkage diagnostic: ' +
        String(error && error.message ? error.message : error)
      )
      return error instanceof SyntaxError
        && /does not provide an export named ['"]default['"]/i.test(
          String(error && error.message ? error.message : error)
        )
    },
    'the installed CommonJS core must fail with the missing default-export linkage error'
  )
  assert.ok(observedBaselineError instanceof SyntaxError)

  const plugin = highlightPlugin(retainedConfig())
  const transformed = await plugin.transform(
    installedCoreSource,
    installedLibCore + '?import'
  )
  assert.ok(transformed && typeof transformed.code === 'string')

  const { core: highlightCore, javascript } = await importHighlightFixture(transformed.code, true)
  assert.equal(typeof highlightCore.registerLanguage, 'function')
  assert.equal(typeof highlightCore.highlight, 'function')
  assert.equal(typeof javascript, 'function')

  highlightCore.registerLanguage('javascript', javascript)
  const source = 'const answer = 42;'
  const highlighted = highlightCore.highlight(source, { language: 'javascript' })
  assert.equal(highlighted.language, 'javascript')
  assert.notEqual(highlighted.value, source)
  assert.match(highlighted.value, /<span\b[^>]*>const<\/span>/)
})
