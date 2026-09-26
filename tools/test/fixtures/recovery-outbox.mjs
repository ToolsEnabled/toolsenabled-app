// Execute the app's private functions and full outbox without a DOM, provider,
// filesystem storage, or a copied queue implementation. Each outbox owns its
// storage and module state; only the export keywords are removed for the VM.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'

const view = readFileSync(new URL('../../../src/views/computers.js', import.meta.url), 'utf8')
const functions = new Map()
function collect(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, view.slice(node.start, node.end))
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') collect(value)
  }
}
collect(parseAst(view))

export function functionSource(name) {
  assert.ok(functions.has(name), `${name} must exist in the actual view`)
  return functions.get(name)
}

export function realOutbox(storage = new Map()) {
  const source = readFileSync(new URL('../../../src/session-outbox.js', import.meta.url), 'utf8')
  const declarations = parseAst(source).body.filter(node => node.type === 'ExportNamedDeclaration')
  let executable = source
  for (const node of declarations.reverse()) {
    assert.ok(node.declaration, 'the outbox fixture must explicitly handle every export form')
    executable = executable.slice(0, node.start) + executable.slice(node.declaration.start)
  }
  return vm.runInNewContext(`(() => { ${executable}; return {
    enqueue, list, moveSession, takeNext, confirmDelivered, cancel, clearSession, holdForSend, promoteFront,
    requeueFront, persistence,
  } })()`, {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Date, Map, Set, Object,
  })
}
