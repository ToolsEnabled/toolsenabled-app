/* The interface-font register and its small DOM boundary.
 *
 * The settings page passes stored/user-selected strings to this module, while
 * the quick-settings drawer renders FONT_CHOICES and asks the document which
 * stack is currently applied.  This test therefore follows those public
 * values rather than repeating the register's copy or CSS byte-for-byte.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_FONT,
  FONT_CHOICES,
  applyFontChoice,
  currentFontChoice,
  fontStack,
  normalizeFontId,
} from '../../src/font-choice.js'

function fakeDocument({ applied = '', theme } = {}) {
  const properties = new Map(applied ? [['--font-ui', applied]] : [])
  const themeWrites = []
  let currentTheme = theme
  return {
    documentElement: {
      style: {
        getPropertyValue(name) { return properties.get(name) || '' },
        setProperty(name, value) { properties.set(name, String(value)) },
      },
      dataset: {
        get theme() { return currentTheme },
        set theme(value) { currentTheme = value; themeWrites.push(value) },
      },
    },
    properties,
    themeWrites,
  }
}

function withDocument(documentRef, work) {
  const previous = globalThis.document
  globalThis.document = documentRef
  try { return work() } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

test('every offered choice is usable as its own preview and stored value', () => {
  assert.ok(FONT_CHOICES.length > 1, 'the user must be offered more than one font choice')
  assert.equal(new Set(FONT_CHOICES.map(choice => choice.id)).size, FONT_CHOICES.length,
    'font choice ids must be unique so a stored selection is unambiguous')

  for (const choice of FONT_CHOICES) {
    assert.ok(choice.id && choice.label && choice.stack,
      'every font choice needs an id, user-facing label, and preview stack')
    assert.equal(normalizeFontId(choice.id), choice.id,
      `the offered font id ${choice.id} must survive normalization`)
    assert.equal(fontStack(choice.id), choice.stack,
      `the preview for ${choice.id} must use that choice's registered stack`)
  }
})

test('unrecognised caller values consistently fall back to the declared default', () => {
  const fallback = FONT_CHOICES.find(choice => choice.id === DEFAULT_FONT)
  assert.ok(fallback, 'the declared default font must be one of the offered choices')

  for (const value of ['not-a-font', '', null, undefined]) {
    assert.equal(normalizeFontId(value), DEFAULT_FONT,
      'an unrecognised stored font must normalize to the declared default')
    assert.equal(fontStack(value), fallback.stack,
      'an unrecognised preview value must use the declared default stack')
  }
})

test('the current choice follows the stack actually applied to the root', () => {
  for (const choice of FONT_CHOICES) {
    const documentRef = fakeDocument({ applied: `  ${choice.stack}  ` })
    assert.equal(withDocument(documentRef, currentFontChoice), choice.id,
      `the applied stack for ${choice.id} must read back as that choice`)
  }

  assert.equal(withDocument(fakeDocument(), currentFontChoice), DEFAULT_FONT,
    'no inline font means the stylesheet default is in force')
  assert.equal(withDocument(fakeDocument({ applied: 'a stack no longer offered' }), currentFontChoice), DEFAULT_FONT,
    'an unknown inline stack must not masquerade as an offered non-default choice')
})

test('a failure to read the applied style remains a failure, not a definite choice', () => {
  const documentRef = fakeDocument()
  documentRef.documentElement.style.getPropertyValue = () => { throw new Error('style is not readable') }
  assert.throws(() => withDocument(documentRef, currentFontChoice), /style is not readable/,
    'an unreadable applied style must remain unknown by throwing')
})

test('applying a choice writes its stack, returns its id, and refreshes themed canvases', () => {
  for (const choice of FONT_CHOICES) {
    const documentRef = fakeDocument({ theme: 'night' })
    const applied = withDocument(documentRef, () => applyFontChoice(choice.id))
    assert.equal(applied, choice.id, `applying ${choice.id} must report that choice as applied`)
    assert.equal(documentRef.properties.get('--font-ui'), choice.stack,
      `applying ${choice.id} must write its registered stack to the root`)
    assert.deepEqual(documentRef.themeWrites, ['night'],
      'applying a font under a theme must re-assert it so canvas text refreshes')
  }
})

test('applying an unknown value safely applies the default without inventing a theme', () => {
  const documentRef = fakeDocument()
  const fallback = FONT_CHOICES.find(choice => choice.id === DEFAULT_FONT)
  const applied = withDocument(documentRef, () => applyFontChoice('removed-font'))

  assert.equal(applied, DEFAULT_FONT, 'an unknown font request must report the default that actually applied')
  assert.equal(documentRef.properties.get('--font-ui'), fallback.stack,
    'an unknown font request must write the default stack')
  assert.deepEqual(documentRef.themeWrites, [],
    'applying a font must not invent a theme when the document has none')
})
