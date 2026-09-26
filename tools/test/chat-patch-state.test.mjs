import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Element } from './lib/dom-stand-in.mjs'

const source = readFileSync(new URL('../../src/chat-message-body.js', import.meta.url), 'utf8')
const start = source.indexOf('function patchChildren(')
const end = source.indexOf('export function setChatMessageBody(', start)
assert.ok(start >= 0 && end > start)
const patchChildren = runInNewContext(`${source.slice(start, end)}; patchChildren`)

// Only element/attribute equality is needed here. Text, selection, scrolling,
// and browser MutationObserver behavior are checked by the real browser probe.
class PatchElement extends Element {
  get nodeName() { return this.tagName }
  get childNodes() { return this.children }
  get lastChild() { return this.children.at(-1) || null }
  getAttributeNames() { return [...new Set([...this.attributes.keys(), ...(this.className ? ['class'] : [])])] }
  isEqualNode(other) {
    const attrs = node => node.getAttributeNames().sort().map(name => [name, node.getAttribute(name)])
    return this.nodeName === other.nodeName && JSON.stringify(attrs(this)) === JSON.stringify(attrs(other))
      && this.children.length === other.children.length && this.children.every((child, i) => child.isEqualNode(other.children[i]))
  }
}
function node(tag, classes = '') { const result = new PatchElement(tag); if (classes) result.setAttribute('class', classes); return result }
function content(classes = 'md-code-block') {
  const host = node('div'), block = node('div', classes), controls = node('div', 'md-code-tools'), code = node('pre')
  controls.setAttribute('data-local-feedback', 'idle')
  block.append(controls, code); host.append(block)
  return { host, block, controls, code }
}
function classWrites(element) {
  let value = element.className, writes = 0
  Object.defineProperty(element, 'className', { get: () => value, set: next => { value = next; writes++ } })
  return () => writes
}

test('wrapped code keeps its class without writes while later content changes', () => {
  const current = content('md-code-block is-wrapped')
  const writes = classWrites(current.block)
  current.controls.setAttribute('data-local-feedback', 'copied')
  for (let i = 0; i < 100; i++) {
    const incoming = content()
    incoming.code.setAttribute('data-content-revision', String(i))
    patchChildren(current.host, incoming.host)
  }
  assert.equal(writes(), 0, 'an unchanged wrap class must not reset and restore on every delta')
  assert.equal(current.host.firstChild, current.block)
  assert.equal(current.block.lastChild, current.code)
  assert.equal(current.code.getAttribute('data-content-revision'), '99')
  assert.equal(current.controls.getAttribute('data-local-feedback'), 'copied')
})

test('wrapping retains local state while other changed or removed attributes update once', () => {
  const current = content('md-code-block old-language is-wrapped')
  current.block.setAttribute('data-old', 'remove')
  const incoming = content('md-code-block new-language')
  incoming.block.setAttribute('data-new', 'keep')
  const writes = classWrites(current.block)
  patchChildren(current.host, incoming.host)
  assert.equal(current.block.className, 'md-code-block new-language is-wrapped')
  assert.equal(writes(), 1)
  assert.equal(current.block.hasAttribute('data-old'), false)
  assert.equal(current.block.getAttribute('data-new'), 'keep')
})

test('unwrapping a code block remains effective on the next update', () => {
  const current = content('md-code-block is-wrapped')
  patchChildren(current.host, content().host)
  current.block.classList.remove('is-wrapped')
  const writes = classWrites(current.block)
  patchChildren(current.host, content().host)
  assert.equal(current.block.className, 'md-code-block')
  assert.equal(writes(), 0)
})

test('ordinary content does not inherit the code-block wrap preservation rule', () => {
  const current = content('ordinary is-wrapped'), incoming = content('ordinary')
  patchChildren(current.host, incoming.host)
  assert.equal(current.block.className, 'ordinary')
})
