import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const globalNames = ['document', 'window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
const beforeImport = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const dom = await import(moduleUrl)

test('module has the exact API and import has no global side effects', () => {
  assert.deepEqual(Object.keys(dom).sort(), ['ClassList', 'Element', 'createDocument', 'installDomStandIn'])
  for (const name of globalNames) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), beforeImport.get(name), `${name} changed during import`)
})

test('simple matching covers classes, tags, tag classes, and exact attributes', () => {
  const node = new dom.Element('button')
  node.className = 'fixture-a fixture-b'
  node.setAttribute('data-chat-chip', 'fixture-a')
  node.setAttribute('disabled', '')
  assert.equal(node.matches('.fixture-a'), true)
  assert.equal(node.matches('button'), true)
  assert.equal(node.matches('button.fixture-b'), true)
  assert.equal(node.matches('[disabled]'), true)
  for (const selector of ['[data-chat-chip="fixture-a"]', "[data-chat-chip='fixture-a']", '[data-chat-chip=fixture-a]']) assert.equal(node.matches(selector), true)
  assert.equal(node.matches('button.fixture-c'), false)
  assert.equal(node.matches('[data-chat-chip="fixture-b"]'), false)
  assert.equal(node.matches('#fixture-a'), false)
  assert.equal(node.matches('[data-chat-chip="fixture-a"'), false)
})

test('attribute values distinguish sibling chips and reject an absent value', () => {
  const root = new dom.Element()
  for (const value of ['fixture-a', 'fixture-b']) { const child = new dom.Element(); child.setAttribute('data-chat-chip', value); root.appendChild(child) }
  assert.equal(root.querySelectorAll('[data-chat-chip="fixture-a"]').length, 1)
  assert.equal(root.querySelector('[data-chat-chip="fixture-a"]').getAttribute('data-chat-chip'), 'fixture-a')
  assert.equal(root.querySelectorAll('[data-chat-chip="fixture-c"]').length, 0)
})

test('descendant query includes nested input and excludes unrelated input', () => {
  const root = new dom.Element()
  const composer = root.appendChild(new dom.Element()); composer.className = 'chat-input'
  const nested = composer.appendChild(new dom.Element('input'))
  const unrelated = root.appendChild(new dom.Element('input'))
  assert.deepEqual(root.querySelectorAll('.chat-input input'), [nested])
  assert.notEqual(nested, unrelated)
})

test('earlier query steps are independent, unordered, and unbounded', () => {
  const outside = new dom.Element(); outside.className = 'fixture-a'
  const receiver = outside.appendChild(new dom.Element()); receiver.className = 'fixture-b'
  const middle = receiver.appendChild(new dom.Element()); middle.className = 'fixture-c'
  const leaf = middle.appendChild(new dom.Element('input'))
  assert.deepEqual(outside.querySelectorAll('.fixture-c .fixture-b input'), [leaf], 'reversed earlier steps were treated as an ordered CSS chain')
  assert.deepEqual(receiver.querySelectorAll('.fixture-a input'), [leaf], 'ancestor matching stopped at the query receiver')
})

test('nested template parsing preserves links, attributes, and queries', () => {
  const document = dom.createDocument()
  const template = document.createElement('template')
  template.innerHTML = '<section data-fixture="fixture-a"><div class="fixture-b"><input data-chat-chip="fixture-c"></div><img /></section>'
  const section = template.content.firstElementChild
  const input = template.querySelector('[data-chat-chip="fixture-c"]')
  assert.equal(section.tagName, 'SECTION')
  assert.equal(section.getAttribute('data-fixture'), 'fixture-a')
  assert.equal(input.parentNode.className, 'fixture-b')
  assert.equal(input.parentNode.parentNode, section)
  assert.deepEqual(template.querySelectorAll('section input'), [input])
  assert.equal(section.childElementCount, 2)
})

test('offsetHeight defaults, round trips, and remains instance-local', () => {
  const first = new dom.Element(); const second = new dom.Element()
  const nonProductSentinel = 731
  assert.equal(first.offsetHeight, 0)
  first.offsetHeight = nonProductSentinel
  assert.equal(first.offsetHeight, nonProductSentinel)
  assert.equal(second.offsetHeight, 0)
})

test('createDocument returns wholly fresh state', () => {
  const a = dom.createDocument(); const b = dom.createDocument()
  a.activeElement = a.body
  a.body.className = 'fixture-a'; a.body.style.cssText = 'fixture-a'
  a.body.listeners.set('fixture-a', []); a.listeners.set('fixture-a', [])
  assert.notEqual(a, b); assert.notEqual(a.body, b.body); assert.notEqual(a.documentElement, b.documentElement)
  assert.equal(b.activeElement, null); assert.equal(b.body.className, ''); assert.equal(b.body.style.cssText, '')
  assert.equal(b.body.listeners.size, 0); assert.equal(b.listeners.size, 0)
  assert.equal(a.createElement('div').ownerDocument, a)
})

test('installer replaces the whole window and leaves the old object untouched', () => {
  const oldMatchMedia = () => ({ matches: false })
  const oldWindow = { matchMedia: oldMatchMedia, fixture: 'fixture-a' }
  const target = { window: oldWindow }
  const installed = dom.installDomStandIn(target)
  assert.notEqual(target.window, oldWindow)
  assert.equal(oldWindow.matchMedia, oldMatchMedia)
  assert.equal(target.window.matchMedia().matches, true)
  assert.equal(target.document, installed.document)
  installed.restore()
})

test('LIFO restore is descriptor-exact, removes absent keys, and is idempotent', () => {
  const originalDocument = { fixture: 'fixture-a' }
  const target = {}
  Object.defineProperty(target, 'document', { value: originalDocument, writable: false, enumerable: false, configurable: true })
  Object.defineProperty(target, 'window', { get: () => 'fixture-a', enumerable: true, configurable: true })
  const original = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(target, name)]))
  const outer = dom.installDomStandIn(target)
  const outerDescriptors = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(target, name)]))
  const inner = dom.installDomStandIn(target)
  inner.restore()
  for (const name of globalNames) assert.deepEqual(Object.getOwnPropertyDescriptor(target, name), outerDescriptors.get(name), `inner restore changed ${name}`)
  inner.restore()
  outer.restore(); outer.restore()
  for (const name of globalNames) assert.deepEqual(Object.getOwnPropertyDescriptor(target, name), original.get(name), `outer restore did not reproduce ${name}`)
  assert.equal(target.document, originalDocument)
  assert.equal(Object.hasOwn(target, 'ResizeObserver'), false)
})

test('installer rejects null and primitive targets', () => {
  for (const target of [null, 1, 'fixture-a']) assert.throws(() => dom.installDomStandIn(target), TypeError)
})

test('removeChild detaches the selected child', () => {
  const parent = new dom.Element(); const child = parent.appendChild(new dom.Element())
  assert.equal(parent.removeChild(child), child); assert.deepEqual(parent.children, []); assert.equal(child.parentNode, null)
})

test('insertBefore inserts before a reference and null appends', () => {
  const parent = new dom.Element(); const last = parent.appendChild(new dom.Element('last')); const first = new dom.Element('first'); const tail = new dom.Element('tail')
  parent.insertBefore(first, last); parent.insertBefore(tail, null)
  assert.deepEqual(parent.children, [first, last, tail]); assert.equal(first.parentNode, parent)
})

test('firstChild and lastElementChild expose structural endpoints', () => {
  const parent = new dom.Element(); const first = parent.appendChild(new dom.Element('i')); const last = parent.appendChild(new dom.Element('b'))
  assert.equal(parent.firstChild, first); assert.equal(parent.lastElementChild, last)
})

test('prepend and after accept elements and trimmed strings', () => {
  const parent = new dom.Element(); const middle = parent.appendChild(new dom.Element('b')); middle.textContent = 'middle'
  middle.prepend('  before  '); middle.after('  after  ', new dom.Element('i'))
  assert.equal(middle.textContent, 'beforemiddle'); assert.equal(parent.textContent, 'beforemiddleafter'); assert.equal(parent.lastElementChild.tagName, 'I')
})

test('appendChild moves a node out of its old parent and adopts its document', () => {
  const oldParent = new dom.Element(); const document = dom.createDocument(); const nextParent = document.createElement('main'); const child = oldParent.appendChild(new dom.Element())
  nextParent.appendChild(child)
  assert.deepEqual(oldParent.children, []); assert.equal(child.parentNode, nextParent); assert.equal(child.ownerDocument, document)
})

test('replaceChildren detaches every removed child', () => {
  const parent = new dom.Element(); const removed = parent.appendChild(new dom.Element()); const replacement = new dom.Element('span')
  parent.replaceChildren(replacement)
  assert.equal(removed.parentNode, null); assert.deepEqual(parent.children, [replacement])
})

test('elements report nodeType 1', () => assert.equal(new dom.Element().nodeType, 1))

test('hasAttribute and toggleAttribute report resulting presence', () => {
  const node = new dom.Element(); assert.equal(node.hasAttribute('open'), false); assert.equal(node.toggleAttribute('open'), true); assert.equal(node.hasAttribute('open'), true); assert.equal(node.toggleAttribute('open', false), false)
})

test('setAttribute reflects id, value, checked, class, disabled, and hidden', () => {
  const node = new dom.Element('input'); assert.equal(node.checked, false)
  for (const [name, value] of [['id', 'fixture-id'], ['value', 'fixture-value'], ['checked', ''], ['class', 'fixture-class'], ['disabled', ''], ['hidden', '']]) node.setAttribute(name, value)
  assert.equal(node.id, 'fixture-id'); assert.equal(node.value, 'fixture-value'); assert.equal(node.checked, true); assert.equal(node.className, 'fixture-class'); assert.equal(node.disabled, true); assert.equal(node.hidden, true)
})

test('dataset reflects data attributes in both directions', () => {
  const node = new dom.Element(); node.setAttribute('data-long-name', 'from-attribute'); assert.equal(node.dataset.longName, 'from-attribute')
  node.dataset.otherValue = 'from-dataset'; assert.equal(node.getAttribute('data-other-value'), 'from-dataset')
})

test('ClassList add deduplicates, remove deletes, and toggle returns presence', () => {
  const node = new dom.Element(); node.classList.add('on'); node.classList.add('on'); assert.equal(node.className, 'on'); node.classList.remove('on'); assert.equal(node.className, '')
  assert.equal(node.classList.toggle('on'), true); assert.equal(node.classList.toggle('on'), false)
})

test('listener dispatch uses a snapshot despite additions and removals', () => {
  const node = new dom.Element(); const calls = []; const removed = () => calls.push('removed'); const added = () => calls.push('added')
  node.addEventListener('change', () => { calls.push('mutator'); node.removeEventListener('change', removed); node.addEventListener('change', added) }); node.addEventListener('change', removed)
  node.dispatch('change'); assert.deepEqual(calls, ['mutator', 'removed'])
})

test('a listener added during dispatch waits for the next dispatch even with no removal', () => {
  const node = new dom.Element(); const calls = []
  const added = () => calls.push('added')
  node.addEventListener('change', () => { calls.push('first'); node.addEventListener('change', added) })
  node.dispatch('change'); assert.deepEqual(calls, ['first'])
})

test('dispatchEvent binds this, bubbles with one target, and returns cancellation state', () => {
  const parent = new dom.Element(); const child = parent.appendChild(new dom.Element()); const observed = []
  child.addEventListener('save', function (event) { observed.push([this, event.target]); event.preventDefault() }); parent.addEventListener('save', function (event) { observed.push([this, event.target]) })
  const event = { type: 'save' }; assert.equal(child.dispatchEvent(event), false); assert.deepEqual(observed, [[child, child], [parent, child]])
})

test('dispatch returns the delivered event', () => {
  const node = new dom.Element(); let delivered; node.addEventListener('ping', event => { delivered = event }); const result = node.dispatch('ping', { detail: 41 })
  assert.equal(result, delivered); assert.equal(result.detail, 41)
})

test('id selectors match and query exact ids', () => {
  const root = new dom.Element(); const wanted = root.appendChild(new dom.Element()); const other = root.appendChild(new dom.Element()); wanted.setAttribute('id', 'wanted'); other.setAttribute('id', 'wanted-more')
  assert.equal(wanted.matches('#wanted'), true); assert.equal(root.querySelector('#wanted'), wanted); assert.deepEqual(root.querySelectorAll('#wanted'), [wanted])
})

test(':scope child queries exclude deeper matching descendants', () => {
  const root = new dom.Element(); const direct = root.appendChild(new dom.Element('span')); const wrapper = root.appendChild(new dom.Element()); wrapper.appendChild(new dom.Element('span'))
  assert.deepEqual(root.querySelectorAll(':scope > span'), [direct]); assert.equal(root.querySelector(':scope > span'), direct)
})

test('parentElement follows reparenting and excludes absent or non-element parents', () => {
  const first = new dom.Element(), second = new dom.Element(), child = new dom.Element('button')
  assert.equal(child.parentElement, null)
  first.appendChild(child); assert.equal(child.parentElement, first)
  second.appendChild(child); assert.equal(child.parentElement, second)
  child.remove(); assert.equal(child.parentElement, null)
  child.parentNode = { nodeType: 9 }; assert.equal(child.parentElement, null)
})

test('anchored child chains choose the toolbar in the requested pane, in tree order', () => {
  const outer = new dom.Element(), pane = outer.appendChild(new dom.Element())
  const addBar = host => {
    const bar = host.appendChild(new dom.Element()); bar.className = 'graph-bar'
    const tools = bar.appendChild(new dom.Element()); tools.className = 'graph-tools'
    return { bar, tools }
  }
  const unrelated = addBar(outer), first = addBar(pane), second = addBar(pane)
  const nested = addBar(pane.appendChild(new dom.Element()))
  assert.deepEqual(pane.querySelectorAll(':scope > .graph-bar > .graph-tools'), [first.tools, second.tools])
  assert.equal(pane.querySelector('  :scope>.graph-bar>.graph-tools  '), first.tools)
  assert.deepEqual(pane.querySelectorAll(':scope > .graph-tools > .graph-bar'), [])
  assert.ok(!pane.querySelectorAll(':scope > .graph-bar > .graph-tools').includes(unrelated.tools))
  assert.ok(!pane.querySelectorAll(':scope > .graph-bar > .graph-tools').includes(nested.tools))
  const wrapper = first.bar.appendChild(new dom.Element())
  wrapper.appendChild(first.tools)
  assert.deepEqual(pane.querySelectorAll(':scope > .graph-bar > .graph-tools'), [second.tools], 'a matching grandchild is not an immediate child')
})

test('anchored child chains keep attribute selectors exact and reject unsupported combinators', () => {
  const root = new dom.Element()
  const panel = root.appendChild(new dom.Element('section')); panel.setAttribute('data-panel', 'one')
  const child = panel.appendChild(new dom.Element('button')); child.className = 'action'
  assert.deepEqual(root.querySelectorAll(':scope > [data-panel="one"] > button.action'), [child])
  assert.deepEqual(root.querySelectorAll(':scope > [data-panel="two"] > button.action'), [])
  for (const selector of [':scope > section + button', ':scope > section > button:hover', ':scope > section, button']) {
    assert.deepEqual(root.querySelectorAll(selector), [])
  }
})

test('innerHTML preserves exact trimmed mixed text tokens', () => {
  const node = new dom.Element(); node.innerHTML = '  alpha <b> beta </b> gamma <i> delta </i>  '
  assert.equal(node.textContent, 'alphabetagammadelta'); assert.equal(node.firstElementChild.textContent, 'beta')
})

test('scrollIntoView is a callable no-op', () => assert.equal(new dom.Element().scrollIntoView(), undefined))

test('style.setProperty records a string property value', () => {
  const node = new dom.Element(); node.style.setProperty('--fixture', 17); assert.equal(node.style['--fixture'], '17')
})

test('document fonts exposes resolved readiness and listener no-ops', async () => {
  const document = dom.createDocument(); assert.equal(await document.fonts.ready, undefined); assert.equal(document.fonts.addEventListener('loading', () => {}), undefined); assert.equal(document.fonts.removeEventListener('loading', () => {}), undefined)
})

test('isConnected follows mounting and un-mounting through the document tree', () => {
  const document = dom.createDocument()
  const mountedParent = document.body.appendChild(document.createElement('main'))
  const child = mountedParent.appendChild(document.createElement('button'))
  const detached = document.createElement('aside')
  assert.equal(child.isConnected, true, 'a descendant of document.body reported detached')
  assert.equal(detached.isConnected, false, 'an unmounted element reported connected')
  mountedParent.remove()
  assert.equal(child.isConnected, false, 'a descendant stayed connected after its tree was unmounted')
})

test('click dispatches activation with listener binding and target unless disabled', () => {
  const parent = new dom.Element('section')
  const button = parent.appendChild(new dom.Element('button'))
  const observed = []
  button.addEventListener('click', function (event) { observed.push([this, event.target]); event.preventDefault() })
  parent.addEventListener('click', function (event) { observed.push([this, event.target, event.defaultPrevented]) })
  assert.equal(button.click(), undefined)
  assert.deepEqual(observed, [[button, button], [parent, button, true]])
  button.disabled = true
  button.click()
  assert.equal(observed.length, 2, 'disabled activation dispatched another click')
})

test('style.getPropertyValue reads assigned values and returns empty for an unset name', () => {
  const node = new dom.Element()
  node.style.setProperty('--fixture', 17)
  node.style.color = 'rebeccapurple'
  assert.equal(node.style.getPropertyValue('--fixture'), '17')
  assert.equal(node.style.getPropertyValue('color'), 'rebeccapurple')
  assert.equal(node.style.getPropertyValue('--missing'), '')
})

test('installed window listeners add, dispatch, remove, and use a dispatch snapshot', () => {
  const target = {}
  const installed = dom.installDomStandIn(target)
  const calls = []
  const removed = () => calls.push('removed')
  const added = () => calls.push('added')
  const mutator = () => { calls.push('mutator'); target.window.removeEventListener('keydown', removed); target.window.addEventListener('keydown', added) }
  target.window.addEventListener('keydown', mutator)
  target.window.addEventListener('keydown', removed)
  target.window.dispatchEvent({ type: 'keydown' })
  assert.deepEqual(calls, ['mutator', 'removed'])
  target.window.removeEventListener('keydown', mutator)
  target.window.dispatchEvent({ type: 'keydown' })
  assert.deepEqual(calls, ['mutator', 'removed', 'added'])
  installed.restore()
})

test('innerHTML consumes comments without exposing their text or tags', () => {
  const node = new dom.Element()
  node.innerHTML = 'before<!-- hidden <b>tag</b>\nsecond line -->after'
  assert.equal(node.textContent, 'beforeafter')
  assert.equal(node.childElementCount, 0)
})

test('a form exposes its named controls the way production reaches them', () => {
  const document = dom.createDocument()
  const form = document.createElement('form')
  const input = form.appendChild(document.createElement('input'))
  input.setAttribute('name', 'text')
  const nested = form.appendChild(document.createElement('div')).appendChild(document.createElement('input'))
  nested.setAttribute('name', 'deep')
  assert.equal(form.elements.text, input, 'form.elements did not resolve a direct named control')
  assert.equal(form.elements.deep, nested, 'form.elements did not reach a nested named control')
  assert.equal(form.elements.missing, undefined, 'an unnamed control resolved to something')
})

test('a control named through its name property is one of the form\'s named controls', () => {
  const document = dom.createDocument()
  const form = document.createElement('form')
  const input = form.appendChild(document.createElement('input'))
  input.setAttribute('name', 'target')
  /* The way write-surfaces.js swaps a typed field for a picker: the new
     control is named through the property, and the next read of
     form.elements.target must find it, as a browser does. */
  const select = document.createElement('select')
  select.name = 'target'
  input.replaceWith(select)
  assert.equal(form.elements.target, select, 'form.elements lost a control named through its name property')
  const unnamed = form.appendChild(document.createElement('input'))
  unnamed.name = ''
  assert.equal(Object.values(form.elements).includes(unnamed), false, 'an empty name resolved to a control')
})

test('insertAdjacentElement places all four positions against the same tree', () => {
  const document = dom.createDocument()
  const parent = document.createElement('div')
  const anchor = parent.appendChild(document.createElement('b'))
  const before = anchor.insertAdjacentElement('beforebegin', document.createElement('i'))
  const after = anchor.insertAdjacentElement('afterend', document.createElement('u'))
  const inFirst = anchor.insertAdjacentElement('afterbegin', document.createElement('s'))
  const inLast = anchor.insertAdjacentElement('beforeend', document.createElement('em'))
  assert.deepEqual(parent.children, [before, anchor, after], 'beforebegin/afterend landed in the wrong order')
  assert.deepEqual(anchor.children, [inFirst, inLast], 'afterbegin/beforeend landed in the wrong order')
  assert.throws(() => anchor.insertAdjacentElement('sideways', document.createElement('p')), TypeError,
    'an unsupported position was accepted silently')
})
