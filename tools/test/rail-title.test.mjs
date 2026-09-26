/* The shared rail heading has two callers: template-built fleet pages and the
 * element-by-element compose panel.  Keep this fake deliberately narrow: it
 * supplies only the DOM operations rail-title.js uses. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BACK_LABEL, railTitleRow, railTitleRowElement } from '../../src/rail-title.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.className = ''
    this.type = ''
    this.textContent = ''
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  appendChild(child) { this.children.push(child); return child }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName) }
}

test('markup rows preserve fixed slots and treat caller text as text', () => {
  const markup = railTitleRow({ title: '<Agent & fleet>' })

  const slots = [...markup.matchAll(/class="rail-title-slot rail-title-slot-(back|title|forward)"/g)]
    .map(match => match[1])
  assert.deepEqual(slots, ['back', 'title', 'forward'],
    'a markup rail row must keep the back, title, and forward slots in fixed order')
  assert.match(markup, /&lt;Agent &amp; fleet&gt;/,
    'a markup rail title must escape caller-provided text')
  assert.doesNotMatch(markup, /<Agent & fleet>/,
    'caller-provided title text must not become markup')
})

test('markup back controls keep navigation copy and an escaped accessible destination', () => {
  const markup = railTitleRow({
    back: { aria: 'Back to "Fleet & agents"' },
    title: 'Agent in your tree',
  })

  assert.match(BACK_LABEL, /\bBack\b/i,
    'the shared back control must still tell the user it navigates back')
  assert.match(markup, /class="rail-back"[^>]*type="button"/,
    'a requested markup back control must be a non-submit button')
  assert.match(markup, /aria-label="Back to &quot;Fleet &amp; agents&quot;"/,
    'the markup back destination must remain accessible without permitting attribute injection')
})

test('element rows expose the compose caller button and preserve all three slots', () => {
  const { row, backButton } = railTitleRowElement(new FakeDocument(), {
    back: { label: 'Cancel', attrs: { 'data-compose-action': 'cancel' } },
    title: 'Start an agent',
    titleId: 'compose-title',
  })

  assert.deepEqual(row.children.map(child => child.className), [
    'rail-title-slot rail-title-slot-back',
    'rail-title-slot rail-title-slot-title',
    'rail-title-slot rail-title-slot-forward',
  ], 'an element rail row must keep all three fixed slots in order')
  assert.equal(row.children[0].children[0], backButton,
    'the returned back button must be the same element mounted in the row')
  assert.equal(backButton.textContent, 'Cancel',
    'the compose action must retain its honest visible Cancel label')
  assert.equal(backButton.getAttribute('data-compose-action'), 'cancel',
    'the compose caller attribute must reach the mounted back button')
  assert.equal(row.children[1].textContent, 'Start an agent',
    'the element row must render the caller title as text')
  assert.equal(row.children[1].getAttribute('id'), 'compose-title',
    'the element title id must remain available to aria-labelledby')
})

test('element construction does not turn a document failure into a definite row', () => {
  const couldNotCreate = new Error('document could not create an element')
  const unreadableDocument = {
    createElement() { throw couldNotCreate },
  }

  assert.throws(
    () => railTitleRowElement(unreadableDocument, { title: 'Fleet overview' }),
    error => error === couldNotCreate,
    'a document construction failure must propagate instead of becoming a definite title row',
  )
})
