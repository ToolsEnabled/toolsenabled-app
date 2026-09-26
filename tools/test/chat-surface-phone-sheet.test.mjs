// THE PHONE SHEET CHAT SURFACE.
//
// The sheet does not build a second conversation: mountPhoneCanvas moves the
// rail into its body, and the rail mounts the shared tree chat config.  This
// pin keeps that route explicit.  In particular, it rejects the failure mode
// where a mount copies today's memorable fields and silently misses the next
// option added to the shared config.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseAst } from 'rollup/parseAst'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const read = name => readFileSync(join(SRC, name), 'utf8')
const phoneCanvas = read('phone-canvas.js')
const computers = read('views/computers.js')
const components = read('components.js')

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

function balanced(source, start, open = '{', close = '}') {
  const at = source.indexOf(start)
  assert.notEqual(at, -1, `${start} moved or disappeared`)
  const first = source.indexOf(open, at)
  assert.notEqual(first, -1, `${start} has no ${open}`)
  let depth = 0
  for (let index = first; index < source.length; index += 1) {
    if (source[index] === open) depth += 1
    if (source[index] === close) depth -= 1
    if (depth === 0) return source.slice(first, index + 1)
  }
  assert.fail(`${start} has no balanced ${close}`)
}

function functionBody(source, declaration) {
  const at = source.indexOf(declaration)
  assert.notEqual(at, -1, `${declaration} moved or disappeared`)
  const signatureEnd = source.indexOf(')', at)
  return balanced(source.slice(signatureEnd + 1), '{')
}

function topLevelObjectReturns(body) {
  const source = 'function factory() ' + body
  const returns = []
  const visit = node => {
    if (!node || typeof node !== 'object') return
    // Branches belong to this factory; callback returns do not. Parsing also
    // prevents an early "return null" from borrowing the next unrelated object.
    if (/FunctionExpression|FunctionDeclaration|ArrowFunctionExpression/.test(node.type)) return
    if (node.type === 'ReturnStatement') {
      if (node.argument?.type === 'ObjectExpression') {
        returns.push(source.slice(node.argument.start, node.argument.end))
      }
      return
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source).body[0].body)
  return returns
}

test('the phone sheet mounts the identity-marked shared chat panel', () => {
  const mount = functionBody(phoneCanvas, 'export function mountPhoneCanvas')
  assert.match(mount, /sheetBody\.append\(rail\)/,
    'the phone sheet no longer owns the rail whose Chat tab supplies its conversation')

  const railMount = computers.slice(
    computers.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')"),
    computers.indexOf('/* THE KEYBOARD HALF', computers.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')")),
  )
  assert.match(railMount, /chatHost\.appendChild\(chat\)/,
    'the rail moved into the sheet, but its chat panel is no longer mounted in the Chat host')

  const buildChat = functionBody(components, 'export function buildChat')
  assert.match(buildChat, /data-chat-panel(?:\s|>)/,
    'the mounted component lost data-chat-panel, so this surface has no identity to drift-check')
})

test('the read-only phone footer retains the whole shared composer, not a detached input', () => {
  const mount = functionBody(phoneCanvas, 'export function mountPhoneCanvas')
  assert.match(mount, /composer\.closest\('\.chat-composer-dock'\)\s*\|\|\s*composer/)
  assert.match(mount, /footer\.append\(refusal, composerSurface\)/)
  assert.doesNotMatch(mount, /footer\.append\(refusal, composer\)/)
})

test('the phone sheet forwards the whole config instead of a hand-picked field list', () => {
  const start = computers.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')")
  const railMount = withoutComments(computers.slice(start, computers.indexOf('/* THE KEYBOARD HALF', start)))
  assert.ok(start >= 0 && railMount.length > 0, 'the rail Chat mount moved')
  assert.match(railMount, /buildChat\(\{\s*\.\.\.config,/,
    'the phone sheet chat hand-picks config fields; a new buildChat option would starve this surface')

  // These are the fields from the old copied mount.  They are deliberately a
  // mutation sentinel, not an allowlist: forwarding any or all of them cannot
  // substitute for forwarding the object itself.
  for (const field of ['title', 'subtitle', 'roleKey', 'history', 'onSend', 'onAttach']) {
    assert.doesNotMatch(railMount, new RegExp(`\\b${field}:\\s*config\\.${field}\\b`),
      `the mount copied config.${field}; spread config whole instead`)
  }
})

test('every shared tree config selects exactly one composer authority', () => {
  /* The example fleet's own agents take the example's chat config (2026-09-11
     simulation upgrade), routed by one line before either real config; that
     config is held to the same rule below. */
  const exampleRoute = /\n\s*if \(mockSource\(\) && \(node\.sessionId \|\| sampleRun\?\.owns\(node\.id\)\)\) return exampleChatConfigFor\(node\)/
  const routed = withoutComments(functionBody(computers, 'function treeChatConfigFor(node)'))
  assert.match(routed, exampleRoute, 'the example route moved; hold its config to this rule wherever it went')
  const configFactory = routed.replace(exampleRoute, '')
  const returns = topLevelObjectReturns(configFactory)
  assert.equal(returns.length, 2, 'treeChatConfigFor should have one no-session and one session config')
  const example = topLevelObjectReturns(withoutComments(functionBody(computers, 'function exampleChatConfigFor(node)')))
  assert.equal(example.length, 1, 'the example chat config should be one config')
  returns.push(...example)

  for (const config of returns) {
    const authorities = [
      /\bonSend\s*:/.test(config),
      /\bsampleConversation\s*:\s*true\b/.test(config),
      /\bcomposerReason\s*:/.test(config),
    ]
    assert.equal(authorities.filter(Boolean).length, 1,
      'a phone-sheet chat config must pass exactly one of onSend, sampleConversation:true, or composerReason')
  }
})
