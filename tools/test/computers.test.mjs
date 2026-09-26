import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

/* computers.js is a browser view and owns its stylesheets. Node has no CSS
 * module format, so this narrow loader supplies the same empty stylesheet
 * stand-in used by the view's test environment; JavaScript dependencies still
 * load normally, and failures in them still fail this file. */
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)

const { rangeFill } = await import('../../src/views/computers.js')

function rangeInput({ min, max, value }) {
  const listeners = new Map()
  const properties = new Map()
  return {
    min,
    max,
    value,
    listeners,
    properties,
    addEventListener(type, listener) { listeners.set(type, listener) },
    style: { setProperty(name, next) { properties.set(name, next) } },
  }
}

test('rangeFill paints the real range position when a caller first binds a control', () => {
  const input = rangeInput({ min: '0', max: '100', value: '25' })

  rangeFill(input)

  assert.equal(input.properties.get('--fill'), '25%', 'the visible fill must represent the control value at bind time')
  assert.equal(typeof input.listeners.get('input'), 'function', 'the view must subscribe to the range input event')
})

test('rangeFill repaints after the person moves the control in either direction', () => {
  const input = rangeInput({ min: '10', max: '30', value: '10' })
  rangeFill(input)
  const repaint = input.listeners.get('input')

  input.value = '30'
  repaint()
  assert.equal(input.properties.get('--fill'), '100%', 'the maximum reading must paint a full control')

  input.value = '10'
  repaint()
  assert.equal(input.properties.get('--fill'), '0%', 'the minimum reading must paint an empty control')
})

test('rangeFill measures within the caller supplied bounds instead of treating value as a percentage', () => {
  const input = rangeInput({ min: '20', max: '60', value: '30' })

  rangeFill(input)

  assert.equal(input.properties.get('--fill'), '25%', 'an offset range must paint its relative position')
})

test('rangeFill preserves fractional precision across bounds that cross zero', () => {
  const input = rangeInput({ min: '-1.5', max: '2.5', value: '0.5' })

  rangeFill(input)

  assert.equal(input.properties.get('--fill'), '50%', 'fractional bounds must paint their relative position')
})
