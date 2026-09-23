import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const componentsModule = await import('../../src/components.js')
const armed = Object.hasOwn(componentsModule, 'CHAT_MESSAGE_TIME_SEAM')

if (!armed) {
  describe.skip('source-backed spoken message times (public seam not present)', () => {})
} else {
  const { chatMessageTimeCopy } = await import('../../src/chat-copy.js')
  const { buildChat } = componentsModule

  const SAME_MINUTE_YOU_AT = Date.UTC(2026, 0, 15, 18, 42, 5, 250)
  const SAME_MINUTE_AGENT_AT = SAME_MINUTE_YOU_AT + 20_000
  const FAR_AGENT_AT = SAME_MINUTE_YOU_AT + (6 * 60 * 60 * 1000)
  const STREAM_AT = Date.UTC(2026, 2, 18, 9, 7, 6, 543)
  const OUTGOING_AT = Date.UTC(2026, 4, 22, 15, 31, 12, 345)
  const DEFAULT_STREAM_AT = Date.UTC(2026, 6, 9, 21, 16, 4, 321)
  const UNKNOWN_FALLBACK_AT = Date.UTC(2026, 8, 11, 23, 53, 2, 789)
  const OUT_OF_DATE_RANGE = 8.64e15 + 1

  /*
   * Concrete mutation fallibility map. Expected values named below come from
   * chatMessageTimeCopy; bad values are independently observed in the DOM or
   * in the test-owned clock counter.
   *
   * T1 remove the semantic <time> append: the same-minute root hook-count
   *    assertion expects 2 and observes the bad value 0.
   * T2 expose a restored unknown through Date.now in a time, tooltip, aria
   *    label, or divider: the unknown-row hook/time/attribute and root-divider
   *    assertions expect none and observe a hook, fallback copy, or count 1.
   * T3 add time to finite note/context rows: their owned hook-count assertions
   *    expect 0 and observe the bad value 1.
   * T4 replace or reuse .turn-stamp for clock output: the simultaneous-node
   *    identity assertion expects distinct nodes and observes one shared node.
   * T5 ignore finite openStream({ at }): the fixed-stream ISO assertion expects
   *    chatMessageTimeCopy(STREAM_AT).dateTime and observes a sampled ISO.
   * T6 sample Date.now separately for one default live row: the clock-count
   *    assertion expects 1 and observes the bad value 2.
   */

  class TestEvent {
    constructor(type, options = {}) {
      this.type = String(type)
      this.bubbles = Boolean(options.bubbles)
      this.cancelable = Boolean(options.cancelable)
      this.defaultPrevented = false
      this.target = null
      this.currentTarget = null
      this._stopped = false
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true
    }

    stopPropagation() {
      this._stopped = true
    }
  }

  class TestCustomEvent extends TestEvent {
    constructor(type, options = {}) {
      super(type, options)
      this.detail = options.detail
    }
  }

  class TestNode {
    constructor(ownerDocument, nodeType) {
      this.ownerDocument = ownerDocument ?? null
      this.nodeType = nodeType
      this.parentNode = null
      this.childNodes = []
      this._listeners = new Map()
    }

    get parentElement() {
      return this.parentNode?.nodeType === 1 ? this.parentNode : null
    }

    get firstChild() {
      return this.childNodes[0] ?? null
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null
    }

    get isConnected() {
      let current = this
      while (current) {
        if (current.nodeType === 9) return true
        current = current.parentNode
      }
      return false
    }

    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('')
    }

    set textContent(value) {
      this.replaceChildren()
      const text = String(value ?? '')
      if (text) this.appendChild(this.ownerDocument.createTextNode(text))
    }

    appendChild(node) {
      if (node?.nodeType === 11) {
        for (const child of [...node.childNodes]) this.appendChild(child)
        return node
      }
      if (!(node instanceof TestNode)) {
        throw new TypeError('The test DOM accepts nodes only in appendChild')
      }
      node.remove()
      node.parentNode = this
      this.childNodes.push(node)
      return node
    }

    append(...nodes) {
      for (const node of nodes) {
        this.appendChild(node instanceof TestNode
          ? node
          : this.ownerDocument.createTextNode(String(node)))
      }
    }

    prepend(...nodes) {
      const prepared = nodes.map((node) => node instanceof TestNode
        ? node
        : this.ownerDocument.createTextNode(String(node)))
      for (const node of prepared.reverse()) {
        node.remove()
        node.parentNode = this
        this.childNodes.unshift(node)
      }
    }

    insertBefore(node, referenceNode) {
      if (referenceNode === null) return this.appendChild(node)
      const index = this.childNodes.indexOf(referenceNode)
      if (index < 0) throw new Error('Reference node is not a child')
      node.remove()
      node.parentNode = this
      this.childNodes.splice(index, 0, node)
      return node
    }

    replaceChildren(...nodes) {
      for (const child of this.childNodes) child.parentNode = null
      this.childNodes = []
      this.append(...nodes)
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node)
      if (index < 0) throw new Error('Node is not a child')
      this.childNodes.splice(index, 1)
      node.parentNode = null
      return node
    }

    remove() {
      if (this.parentNode) this.parentNode.removeChild(this)
    }

    before(...nodes) {
      if (!this.parentNode) return
      let index = this.parentNode.childNodes.indexOf(this)
      for (const node of nodes) {
        const prepared = node instanceof TestNode
          ? node
          : this.ownerDocument.createTextNode(String(node))
        prepared.remove()
        prepared.parentNode = this.parentNode
        this.parentNode.childNodes.splice(index, 0, prepared)
        index += 1
      }
    }

    after(...nodes) {
      if (!this.parentNode) return
      let index = this.parentNode.childNodes.indexOf(this) + 1
      for (const node of nodes) {
        const prepared = node instanceof TestNode
          ? node
          : this.ownerDocument.createTextNode(String(node))
        prepared.remove()
        prepared.parentNode = this.parentNode
        this.parentNode.childNodes.splice(index, 0, prepared)
        index += 1
      }
    }

    addEventListener(type, listener, options = {}) {
      const entries = this._listeners.get(type) ?? []
      entries.push({ listener, once: Boolean(options?.once) })
      this._listeners.set(type, entries)
    }

    removeEventListener(type, listener) {
      const entries = this._listeners.get(type) ?? []
      this._listeners.set(type, entries.filter((entry) => entry.listener !== listener))
    }

    dispatchEvent(event) {
      if (!(event instanceof TestEvent)) throw new TypeError('Expected a test event')
      if (!event.target) event.target = this
      let current = this
      do {
        event.currentTarget = current
        const entries = [...(current._listeners.get(event.type) ?? [])]
        for (const entry of entries) {
          entry.listener.call(current, event)
          if (entry.once) current.removeEventListener(event.type, entry.listener)
          if (event._stopped) break
        }
        const propertyListener = current[`on${event.type}`]
        if (!event._stopped && typeof propertyListener === 'function') {
          propertyListener.call(current, event)
        }
        current = event.bubbles && !event._stopped ? current.parentNode : null
      } while (current)
      return !event.defaultPrevented
    }

    contains(other) {
      let current = other
      while (current) {
        if (current === this) return true
        current = current.parentNode
      }
      return false
    }
  }

  class TestText extends TestNode {
    constructor(ownerDocument, data) {
      super(ownerDocument, 3)
      this.data = String(data)
    }

    get textContent() {
      return this.data
    }

    set textContent(value) {
      this.data = String(value ?? '')
    }
  }

  class TestClassList {
    constructor(element) {
      this.element = element
    }

    _values() {
      return this.element.className.split(/\s+/).filter(Boolean)
    }

    _write(values) {
      this.element.className = [...new Set(values)].join(' ')
    }

    add(...tokens) {
      this._write([...this._values(), ...tokens.map(String)])
    }

    remove(...tokens) {
      const rejected = new Set(tokens.map(String))
      this._write(this._values().filter((token) => !rejected.has(token)))
    }

    contains(token) {
      return this._values().includes(String(token))
    }

    toggle(token, force) {
      const present = this.contains(token)
      const shouldAdd = force === undefined ? !present : Boolean(force)
      if (shouldAdd) this.add(token)
      else this.remove(token)
      return shouldAdd
    }

    replace(oldToken, newToken) {
      if (!this.contains(oldToken)) return false
      this.remove(oldToken)
      this.add(newToken)
      return true
    }

    toString() {
      return this.element.className
    }
  }

  class TestStyle {
    setProperty(name, value) {
      this[name] = String(value)
    }

    removeProperty(name) {
      const previous = this[name] ?? ''
      delete this[name]
      return previous
    }
  }

  class TestElement extends TestNode {
    constructor(ownerDocument, tagName) {
      super(ownerDocument, 1)
      this.localName = String(tagName).toLowerCase()
      this.tagName = this.localName.toUpperCase()
      this.attributes = new Map()
      this.style = new TestStyle()
      this.value = ''
      this.checked = false
      this.scrollTop = 0
      this.scrollHeight = 0
      this.clientHeight = 0
      this.selectionStart = 0
      this.selectionEnd = 0
      this._classList = new TestClassList(this)
      this.dataset = new Proxy({}, {
        get: (_target, property) => this.getAttribute(`data-${camelToKebab(property)}`) ?? undefined,
        set: (_target, property, value) => {
          this.setAttribute(`data-${camelToKebab(property)}`, value)
          return true
        },
        deleteProperty: (_target, property) => {
          this.removeAttribute(`data-${camelToKebab(property)}`)
          return true
        },
      })
    }

    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1)
    }

    get firstElementChild() {
      return this.children[0] ?? null
    }

    get lastElementChild() {
      return this.children.at(-1) ?? null
    }

    get nextElementSibling() {
      if (!this.parentNode) return null
      const siblings = this.parentNode.childNodes.filter((node) => node.nodeType === 1)
      return siblings[siblings.indexOf(this) + 1] ?? null
    }

    get previousElementSibling() {
      if (!this.parentNode) return null
      const siblings = this.parentNode.childNodes.filter((node) => node.nodeType === 1)
      return siblings[siblings.indexOf(this) - 1] ?? null
    }

    get className() {
      return this.getAttribute('class') ?? ''
    }

    set className(value) {
      this.setAttribute('class', value)
    }

    get classList() {
      return this._classList
    }

    get id() {
      return this.getAttribute('id') ?? ''
    }

    set id(value) {
      this.setAttribute('id', value)
    }

    get title() {
      return this.getAttribute('title') ?? ''
    }

    set title(value) {
      this.setAttribute('title', value)
    }

    get dateTime() {
      return this.getAttribute('datetime') ?? ''
    }

    set dateTime(value) {
      this.setAttribute('datetime', value)
    }

    get disabled() {
      return this.hasAttribute('disabled')
    }

    set disabled(value) {
      if (value) this.setAttribute('disabled', '')
      else this.removeAttribute('disabled')
    }

    get hidden() {
      return this.hasAttribute('hidden')
    }

    set hidden(value) {
      if (value) this.setAttribute('hidden', '')
      else this.removeAttribute('hidden')
    }

    get innerText() {
      return this.textContent
    }

    set innerText(value) {
      this.textContent = value
    }

    get innerHTML() {
      return this.textContent
    }

    set innerHTML(value) {
      this.textContent = value
    }

    setAttribute(name, value) {
      this.attributes.set(String(name).toLowerCase(), String(value))
    }

    getAttribute(name) {
      return this.attributes.get(String(name).toLowerCase()) ?? null
    }

    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase())
    }

    removeAttribute(name) {
      this.attributes.delete(String(name).toLowerCase())
    }

    toggleAttribute(name, force) {
      const shouldHave = force === undefined ? !this.hasAttribute(name) : Boolean(force)
      if (shouldHave) this.setAttribute(name, '')
      else this.removeAttribute(name)
      return shouldHave
    }

    matches(selector) {
      return selectorMatches(this, selector, this)
    }

    closest(selector) {
      let current = this
      while (current) {
        if (current.nodeType === 1 && selectorMatches(current, selector, current)) return current
        current = current.parentElement
      }
      return null
    }

    querySelectorAll(selector) {
      return queryDescendants(this, selector)
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }

    focus() {
      this.ownerDocument.activeElement = this
    }

    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null
    }

    click() {
      if (!this.disabled) this.dispatchEvent(new TestEvent('click', { bubbles: true, cancelable: true }))
    }

    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    }

    scrollIntoView() {}

    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    }
  }

  class TestDocumentFragment extends TestNode {
    constructor(ownerDocument) {
      super(ownerDocument, 11)
    }

    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1)
    }

    get firstElementChild() {
      return this.children[0] ?? null
    }

    get lastElementChild() {
      return this.children.at(-1) ?? null
    }

    querySelectorAll(selector) {
      return queryDescendants(this, selector)
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }

  class TestTemplateElement extends TestElement {
    constructor(ownerDocument) {
      super(ownerDocument, 'template')
      this.content = new TestDocumentFragment(ownerDocument)
    }

    get innerHTML() {
      return this.content.textContent
    }

    set innerHTML(value) {
      this.content.replaceChildren()
      parseHtmlFragment(this.ownerDocument, String(value ?? ''), this.content)
    }
  }

  class TestDocument extends TestNode {
    constructor() {
      super(null, 9)
      this.ownerDocument = this
      this.activeElement = null
      this.documentElement = new TestElement(this, 'html')
      this.body = new TestElement(this, 'body')
      this.documentElement.appendChild(this.body)
      this.appendChild(this.documentElement)
      this.defaultView = null
    }

    createElement(tagName) {
      return String(tagName).toLowerCase() === 'template'
        ? new TestTemplateElement(this)
        : new TestElement(this, tagName)
    }

    createElementNS(_namespace, tagName) {
      return this.createElement(tagName)
    }

    createTextNode(data) {
      return new TestText(this, data)
    }

    createDocumentFragment() {
      return new TestDocumentFragment(this)
    }

    querySelectorAll(selector) {
      return queryDescendants(this, selector)
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }

    getElementById(id) {
      return this.querySelector(`#${id}`)
    }
  }

  function camelToKebab(value) {
    return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
  }

  function decodeHtml(value) {
    const named = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: '\u00a0',
      quot: '"',
    }
    return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const radix = entity[1]?.toLowerCase() === 'x' ? 16 : 10
        const digits = radix === 16 ? entity.slice(2) : entity.slice(1)
        const point = Number.parseInt(digits, radix)
        return Number.isFinite(point) ? String.fromCodePoint(point) : match
      }
      return named[entity.toLowerCase()] ?? match
    })
  }

  function parseHtmlFragment(document, html, fragment) {
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    const stack = [fragment]
    const tokens = html.match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+/gi) ?? []
    for (const token of tokens) {
      if (token.startsWith('<!--')) continue
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop()
        continue
      }
      if (token.startsWith('<')) {
        const opening = token.match(/^<\s*([\w-]+)([\s\S]*?)\/?\s*>$/)
        if (!opening) continue
        const [, tagName, rawAttributes] = opening
        const element = document.createElement(tagName)
        const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
        for (const match of rawAttributes.matchAll(attributePattern)) {
          const [, name, doubleQuoted, singleQuoted, unquoted] = match
          const attributeValue = doubleQuoted ?? singleQuoted ?? unquoted ?? ''
          element.setAttribute(name, decodeHtml(attributeValue))
          if (name.toLowerCase() === 'value') element.value = decodeHtml(attributeValue)
        }
        stack.at(-1).appendChild(element)
        if (!token.endsWith('/>') && !voidTags.has(tagName.toLowerCase())) stack.push(element)
        continue
      }
      stack.at(-1).appendChild(document.createTextNode(decodeHtml(token)))
    }
  }

  function splitTopLevel(value, delimiter) {
    const parts = []
    let buffer = ''
    let squareDepth = 0
    let roundDepth = 0
    let quote = null
    for (const character of value) {
      if (quote) {
        buffer += character
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        buffer += character
        continue
      }
      if (character === '[') squareDepth += 1
      if (character === ']') squareDepth -= 1
      if (character === '(') roundDepth += 1
      if (character === ')') roundDepth -= 1
      if (character === delimiter && squareDepth === 0 && roundDepth === 0) {
        parts.push(buffer.trim())
        buffer = ''
      } else {
        buffer += character
      }
    }
    if (buffer.trim()) parts.push(buffer.trim())
    return parts
  }

  function parseSelectorChain(selector) {
    const simples = []
    const combinators = []
    let buffer = ''
    let squareDepth = 0
    let roundDepth = 0
    let quote = null
    let pendingDescendant = false

    const flush = () => {
      if (!buffer.trim()) return false
      if (pendingDescendant && simples.length > 0 && combinators.length < simples.length) {
        combinators.push(' ')
      }
      simples.push(buffer.trim())
      buffer = ''
      pendingDescendant = false
      return true
    }

    for (const character of selector.trim()) {
      if (quote) {
        buffer += character
        if (character === quote) quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
        buffer += character
        continue
      }
      if (character === '[') squareDepth += 1
      if (character === ']') squareDepth -= 1
      if (character === '(') roundDepth += 1
      if (character === ')') roundDepth -= 1
      if (squareDepth === 0 && roundDepth === 0 && character === '>') {
        flush()
        if (simples.length > 0) combinators[simples.length - 1] = '>'
        pendingDescendant = false
      } else if (squareDepth === 0 && roundDepth === 0 && /\s/.test(character)) {
        if (buffer.trim()) flush()
        if (simples.length > 0 && combinators.length < simples.length) pendingDescendant = true
      } else {
        if (pendingDescendant && buffer === '' && simples.length > 0 && combinators.length < simples.length) {
          combinators.push(' ')
          pendingDescendant = false
        }
        buffer += character
      }
    }
    flush()
    return { simples, combinators }
  }

  function selectorMatches(element, selector, scope) {
    return splitTopLevel(String(selector), ',').some((part) => {
      const { simples, combinators } = parseSelectorChain(part)
      if (!simples.length || !matchesSimple(element, simples.at(-1), scope)) return false
      let current = element
      for (let index = simples.length - 1; index > 0; index -= 1) {
        const combinator = combinators[index - 1] ?? ' '
        if (combinator === '>') {
          current = current.parentElement
          if (!current || !matchesSimple(current, simples[index - 1], scope)) return false
        } else {
          current = current.parentElement
          while (current && !matchesSimple(current, simples[index - 1], scope)) {
            current = current.parentElement
          }
          if (!current) return false
        }
      }
      return true
    })
  }

  function matchesSimple(element, simple, scope) {
    let rest = simple
    const notParts = []
    rest = rest.replace(/:not\(([^()]*)\)/g, (_match, inner) => {
      notParts.push(inner)
      return ''
    })
    if (notParts.some((inner) => selectorMatches(element, inner, scope))) return false

    if (rest.includes(':scope')) {
      if (element !== scope) return false
      rest = rest.replaceAll(':scope', '')
    }
    if (rest.includes(':first-child')) {
      if (element.parentElement?.firstElementChild !== element) return false
      rest = rest.replaceAll(':first-child', '')
    }
    if (rest.includes(':last-child')) {
      if (element.parentElement?.lastElementChild !== element) return false
      rest = rest.replaceAll(':last-child', '')
    }
    if (rest.includes(':disabled')) {
      if (!element.disabled) return false
      rest = rest.replaceAll(':disabled', '')
    }

    const attributes = [...rest.matchAll(/\[([^\]]+)\]/g)]
    for (const match of attributes) {
      const parsed = match[1].match(/^\s*([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|~=|=)\s*(.*?)\s*)?$/)
      if (!parsed) return false
      const [, name, operator, rawExpected] = parsed
      if (!element.hasAttribute(name)) return false
      if (operator) {
        const actual = element.getAttribute(name)
        const expected = rawExpected.replace(/^(['"])(.*)\1$/, '$2')
        if (operator === '=' && actual !== expected) return false
        if (operator === '^=' && !actual.startsWith(expected)) return false
        if (operator === '$=' && !actual.endsWith(expected)) return false
        if (operator === '*=' && !actual.includes(expected)) return false
        if (operator === '~=' && !actual.split(/\s+/).includes(expected)) return false
      }
    }
    rest = rest.replace(/\[[^\]]+\]/g, '')

    const ids = [...rest.matchAll(/#([\w-]+)/g)].map((match) => match[1])
    if (ids.some((id) => element.id !== id)) return false
    rest = rest.replace(/#[\w-]+/g, '')

    const classes = [...rest.matchAll(/\.([\w-]+)/g)].map((match) => match[1])
    if (classes.some((name) => !element.classList.contains(name))) return false
    rest = rest.replace(/\.[\w-]+/g, '')

    const tag = rest.trim()
    return !tag || tag === '*' || element.localName === tag.toLowerCase()
  }

  function queryDescendants(root, selector) {
    const matches = []
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (selectorMatches(child, selector, root.nodeType === 1 ? root : root.documentElement)) {
            matches.push(child)
          }
          visit(child)
        }
      }
    }
    visit(root)
    return matches
  }

  function installTestDom() {
    const document = new TestDocument()
    class TestResizeObserver {
      constructor(callback) {
        this.callback = callback
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    }
    class TestMutationObserver extends TestResizeObserver {
      takeRecords() {
        return []
      }
    }
    const window = {
      document,
      Event: TestEvent,
      CustomEvent: TestCustomEvent,
      HTMLElement: TestElement,
      Element: TestElement,
      Node: TestNode,
      ResizeObserver: TestResizeObserver,
      MutationObserver: TestMutationObserver,
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      requestAnimationFrame: (callback) => {
        callback(0)
        return 1
      },
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    document.defaultView = window
    const replacements = {
      document,
      window,
      Event: TestEvent,
      CustomEvent: TestCustomEvent,
      KeyboardEvent: TestEvent,
      HTMLElement: TestElement,
      Element: TestElement,
      Node: TestNode,
      ResizeObserver: TestResizeObserver,
      MutationObserver: TestMutationObserver,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
    }
    const originals = new Map()
    for (const [name, value] of Object.entries(replacements)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      })
    }
    return {
      document,
      restore() {
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else delete globalThis[name]
        }
      },
    }
  }

  async function withTestDom(run) {
    const fixture = installTestDom()
    try {
      return await run(fixture.document)
    } finally {
      fixture.restore()
    }
  }

  function mountChat(document, options) {
    const root = buildChat(options)
    assert.ok(root instanceof TestElement, 'mount returns a real root element; plausible bad value is null')
    document.body.appendChild(root)
    return root
  }

  function expectedTime(at, assertionName) {
    const copy = chatMessageTimeCopy(at)
    assert.ok(copy, `${assertionName}: valid instant returns a copy; plausible bad value is null`)
    assert.equal(Object.isFrozen(copy), true, `${assertionName}: copy is frozen; plausible bad value is false`)
    return copy
  }

  function assertTimeNode(node, at, assertionName) {
    const expected = expectedTime(at, assertionName)
    assert.ok(node, `${assertionName}: row owns a time hook; plausible bad value is null`)
    assert.equal(node.localName, 'time', `${assertionName}: hook is semantic time; plausible bad value is span`)
    assert.equal(node.textContent, expected.text, `${assertionName}: visible text matches owner copy; plausible bad value is 00:00`)
    assert.equal(node.dateTime, expected.dateTime, `${assertionName}: ISO matches owner copy; plausible bad value is a sampled instant`)
    assert.equal(node.getAttribute('aria-label'), expected.ariaLabel, `${assertionName}: aria matches owner copy; plausible bad value is the visible text alone`)
    return { node, expected }
  }

  function assertOneOwnedTime(row, at, assertionName) {
    const nodes = row.querySelectorAll('[data-chat-message-time]')
    assert.equal(nodes.length, 1, `${assertionName}: row owns exactly one time hook; plausible bad value is 0 or 2`)
    return assertTimeNode(nodes[0], at, assertionName)
  }

  function descendantElements(root) {
    const values = []
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          values.push(child)
          visit(child)
        }
      }
    }
    visit(root)
    return values
  }

  function assertNoFallbackExposure(row, fallbackAt, assertionName) {
    const elements = [row, ...descendantElements(row)]
    const nearbyCopies = [...new Set([
      0,
      fallbackAt - 60_000,
      fallbackAt - 1,
      fallbackAt,
      fallbackAt + 1,
      fallbackAt + 60_000,
    ])].map((at) => expectedTime(at, `${assertionName} fallback boundary`))

    assert.equal(row.hasAttribute('title'), false, `${assertionName}: row has no own title; plausible bad value is true`)
    assert.equal(elements.filter((element) => element.localName === 'time').length, 0, `${assertionName}: no hidden or empty time element exists; plausible bad value is 1`)

    for (const copy of nearbyCopies) {
      assert.equal(row.textContent.includes(copy.text), false, `${assertionName}: visible row text excludes fallback or epoch clock ${copy.text}; plausible bad value is true`)
      for (const element of elements) {
        for (const attribute of ['title', 'aria-label', 'datetime']) {
          const observed = element.getAttribute(attribute)
          assert.notEqual(observed, copy.text, `${assertionName}: ${attribute} excludes fallback clock; plausible bad value is ${copy.text}`)
          assert.notEqual(observed, copy.dateTime, `${assertionName}: ${attribute} excludes fallback ISO; plausible bad value is ${copy.dateTime}`)
          assert.notEqual(observed, copy.ariaLabel, `${assertionName}: ${attribute} excludes fallback aria; plausible bad value is the owner-copy aria value`)
        }
        for (const observed of element.attributes.values()) {
          assert.notEqual(observed, copy.text, `${assertionName}: no tooltip-like attribute exposes fallback clock; plausible bad value is ${copy.text}`)
          assert.notEqual(observed, copy.dateTime, `${assertionName}: no tooltip-like attribute exposes fallback ISO; plausible bad value is ${copy.dateTime}`)
          assert.notEqual(observed, copy.ariaLabel, `${assertionName}: no tooltip-like attribute exposes fallback aria; plausible bad value is the owner-copy aria value`)
        }
      }
    }
  }

  test('copy contract owns a frozen three-field valid clock and rejects invalid inputs', () => {
    const copy = chatMessageTimeCopy(SAME_MINUTE_YOU_AT)
    assert.ok(copy, 'copy contract: valid instant returns an object; plausible bad value is null')
    assert.equal(Object.isFrozen(copy), true, 'copy contract: result is frozen; plausible bad value is false')
    assert.deepEqual(Reflect.ownKeys(copy).sort(), ['ariaLabel', 'dateTime', 'text'], 'copy contract: own keys are exact; plausible bad value adds title')
    assert.match(copy.text, /^\d{2}:\d{2}$/, 'copy contract: local clock has two numeric fields; plausible bad value is 6:2')
    const [hour, minute] = copy.text.split(':').map(Number)
    assert.ok(hour >= 0 && hour <= 23, 'copy contract: hour is in clock range; plausible bad value is 24')
    assert.ok(minute >= 0 && minute <= 59, 'copy contract: minute is in clock range; plausible bad value is 60')
    assert.equal(copy.dateTime, new Date(SAME_MINUTE_YOU_AT).toISOString(), 'copy contract: ISO is the exact platform conversion; plausible bad value is epoch ISO')
    assert.equal(typeof copy.ariaLabel, 'string', 'copy contract: aria value is text; plausible bad value is undefined')
    assert.ok(copy.ariaLabel.length > copy.text.length, 'copy contract: aria value adds accessible context; plausible bad value is bare clock text')
    assert.equal(copy.ariaLabel.includes(copy.text), true, 'copy contract: aria value carries the owned clock; plausible bad value is unrelated text')

    const invalidInputs = [
      ['non-number', '1700000000000'],
      ['null', null],
      ['undefined', undefined],
      ['NaN', Number.NaN],
      ['positive infinity', Number.POSITIVE_INFINITY],
      ['negative infinity', Number.NEGATIVE_INFINITY],
      ['finite out-of-Date-range', OUT_OF_DATE_RANGE],
    ]
    for (const [label, value] of invalidInputs) {
      assert.equal(chatMessageTimeCopy(value), null, `copy contract: ${label} returns null; plausible bad value is a clock object`)
    }
  })

  test('restored same-minute you and agent rows each own semantic time (T1)', async () => {
    await withTestDom((document) => {
      const root = mountChat(document, {
        history: [
          { who: 'you', text: 'same-minute outgoing fixture', at: SAME_MINUTE_YOU_AT },
          { who: 'agent', text: 'same-minute incoming fixture', at: SAME_MINUTE_AGENT_AT },
        ],
      })
      const meRows = root.querySelectorAll('.msg.me')
      const themRows = root.querySelectorAll('.msg.them')
      assert.equal(meRows.length, 1, 'T1 intended outgoing .msg.me row exists; plausible bad value is 0')
      assert.equal(themRows.length, 1, 'T1 intended incoming .msg.them row exists; plausible bad value is 0')
      assertOneOwnedTime(meRows[0], SAME_MINUTE_YOU_AT, 'T1 outgoing same-minute row')
      assertOneOwnedTime(themRows[0], SAME_MINUTE_AGENT_AT, 'T1 incoming same-minute row')
      assert.equal(root.querySelectorAll('[data-chat-message-time]').length, 2, 'T1 same-minute root owns two hooks; semantic-append mutation observes 0')
      assert.equal(root.querySelectorAll('.chat-time-divider').length, 0, 'same-minute rows need no gap divider; plausible bad value is 1')
    })
  })

  test('a far restored gap keeps divider and row time independent', async () => {
    await withTestDom((document) => {
      const root = mountChat(document, {
        history: [
          { who: 'you', text: 'known row before a far gap', at: SAME_MINUTE_YOU_AT },
          { who: 'agent', text: 'spoken row after a far gap', at: FAR_AGENT_AT },
        ],
      })
      const meRows = root.querySelectorAll('.msg.me')
      const themRows = root.querySelectorAll('.msg.them')
      assert.equal(meRows.length, 1, 'gap case intended .msg.me row exists; plausible bad value is 0')
      assert.equal(themRows.length, 1, 'gap case intended .msg.them row exists; plausible bad value is 0')
      const { node: timeNode } = assertOneOwnedTime(themRows[0], FAR_AGENT_AT, 'spoken row after gap')
      const dividers = root.querySelectorAll('.chat-time-divider')
      assert.equal(dividers.length, 1, 'far gap creates one existing divider; plausible bad value is 0')
      assert.notEqual(dividers[0], timeNode, 'gap divider and semantic time are distinct nodes; plausible bad value is one shared node')
      assert.equal(dividers[0].querySelectorAll('[data-chat-message-time]').length, 0, 'divider carries no semantic-time hook; plausible bad value is 1')
    })
  })

  const unknownCases = [
    { label: 'null', value: null, entry: (text) => ({ who: 'agent', text, at: null }) },
    { label: 'omitted', value: undefined, entry: (text) => ({ who: 'agent', text }) },
    { label: 'NaN', value: Number.NaN, entry: (text) => ({ who: 'agent', text, at: Number.NaN }) },
    { label: 'infinity', value: Number.POSITIVE_INFINITY, entry: (text) => ({ who: 'agent', text, at: Number.POSITIVE_INFINITY }) },
    { label: 'non-number', value: 'not-a-time', entry: (text) => ({ who: 'agent', text, at: 'not-a-time' }) },
    { label: 'finite out-of-Date-range', value: OUT_OF_DATE_RANGE, entry: (text) => ({ who: 'agent', text, at: OUT_OF_DATE_RANGE }) },
  ]

  for (const unknownCase of unknownCases) {
    test(`restored spoken row with ${unknownCase.label} at exposes no fallback time (T2)`, async () => {
      const originalNow = Date.now
      Date.now = () => UNKNOWN_FALLBACK_AT
      try {
        await withTestDom((document) => {
          const root = mountChat(document, {
            history: [
              { who: 'you', text: `known row before ${unknownCase.label}`, at: SAME_MINUTE_YOU_AT },
              unknownCase.entry(`unknown ${unknownCase.label} restored row`),
            ],
          })
          const knownRows = root.querySelectorAll('.msg.me')
          const unknownRows = root.querySelectorAll('.msg.them')
          assert.equal(knownRows.length, 1, `T2 ${unknownCase.label}: intended known .msg.me row exists; plausible bad value is 0`)
          assert.equal(unknownRows.length, 1, `T2 ${unknownCase.label}: intended unknown .msg.them row exists; plausible bad value is 0`)
          assertOneOwnedTime(knownRows[0], SAME_MINUTE_YOU_AT, `T2 ${unknownCase.label} known positive control`)
          assert.equal(chatMessageTimeCopy(unknownCase.value), null, `T2 ${unknownCase.label}: public copy rejects source value; plausible bad value is a clock object`)
          assert.equal(unknownRows[0].querySelectorAll('[data-chat-message-time]').length, 0, `T2 ${unknownCase.label}: unknown row owns no hook; fallback mutation observes 1`)
          assertNoFallbackExposure(unknownRows[0], UNKNOWN_FALLBACK_AT, `T2 ${unknownCase.label}`)
          const dividers = root.querySelectorAll('.chat-time-divider')
          assert.equal(dividers.length, 0, `T2 ${unknownCase.label}: private fallback creates no visible gap divider; fallback mutation observes 1`)
          assert.equal(dividers.some((divider) => divider.querySelectorAll('[data-chat-message-time]').length > 0), false, `T2 ${unknownCase.label}: no divider is labeled as semantic time; plausible bad value is true`)
        })
      } finally {
        Date.now = originalNow
      }
    })
  }

  test('finite note and context rows never own spoken semantic time (T3)', async () => {
    await withTestDom((document) => {
      const root = mountChat(document, {
        history: [
          { who: 'note', text: 'finite note fixture', at: SAME_MINUTE_YOU_AT },
          { who: 'context', text: 'finite context fixture', at: SAME_MINUTE_AGENT_AT },
          { who: 'you', text: 'finite spoken positive control', at: FAR_AGENT_AT },
        ],
      })
      const noteRows = root.querySelectorAll('.msg.note')
      const contextRows = root.querySelectorAll('.msg.context')
      const spokenRows = root.querySelectorAll('.msg.me')
      assert.equal(noteRows.length, 1, 'T3 intended .msg.note row exists; plausible bad value is 0')
      assert.equal(contextRows.length, 1, 'T3 intended .msg.context row exists; plausible bad value is 0')
      assert.equal(spokenRows.length, 1, 'T3 intended .msg.me positive row exists; plausible bad value is 0')
      assert.equal(noteRows[0].querySelectorAll('[data-chat-message-time]').length, 0, 'T3 note owns no hook; mutation observes 1')
      assert.equal(contextRows[0].querySelectorAll('[data-chat-message-time]').length, 0, 'T3 context owns no hook; mutation observes 1')
      assertOneOwnedTime(spokenRows[0], FAR_AGENT_AT, 'T3 spoken positive control')
      const hooks = root.querySelectorAll('[data-chat-message-time]')
      assert.equal(hooks.length, 1, 'T3 root has only the spoken hook; plausible bad value is 2 or 3')
      for (const hook of hooks) {
        const owner = hook.closest('.msg')
        assert.ok(owner, 'T3 every hook has a real .msg owner; plausible bad value is null')
        assert.equal(owner.matches('.msg.me, .msg.them'), true, 'T3 every hook belongs to me/them, not note/context/action/approval/diff/divider; plausible bad value is false')
        assert.equal(hook.closest('.chat-time-divider'), null, 'T3 no hook belongs to a divider; plausible bad value is a divider node')
      }
    })
  })

  function assertLiveIdentity(root, at, stampFixture, previous = null, assertionName = 'live stream') {
    const rows = root.querySelectorAll('.msg.them')
    assert.equal(rows.length, 1, `${assertionName}: intended .msg.them row exists; plausible bad value is 0`)
    const row = rows[0]
    const { node: timeNode } = assertOneOwnedTime(row, at, assertionName)
    const stamps = row.querySelectorAll('.turn-stamp')
    assert.equal(stamps.length, 1, `${assertionName}: row owns one execution stamp; plausible bad value is 0 or 2`)
    const stampNode = stamps[0]
    assert.equal(stampNode.textContent, stampFixture, `${assertionName}: stamp keeps fixture identity; plausible bad value is clock text`)
    assert.notEqual(timeNode, stampNode, `${assertionName}: T4 time and stamp are simultaneous distinct nodes; reuse mutation observes one shared node`)
    assert.notEqual(timeNode.textContent, stampNode.textContent, `${assertionName}: clock and execution identity text differ; plausible bad value is duplicated clock text`)
    if (previous) {
      assert.equal(row, previous.row, `${assertionName}: close preserves the row; plausible bad value is a replacement row`)
      assert.equal(timeNode, previous.timeNode, `${assertionName}: close preserves the semantic-time node; plausible bad value is a replacement node`)
      assert.equal(stampNode, previous.stampNode, `${assertionName}: close preserves the execution-stamp node; plausible bad value is a replacement node`)
    }
    return { row, timeNode, stampNode }
  }

  test('fixed live stream keeps source time and execution stamp distinct through close (T4, T5)', async () => {
    await withTestDom((document) => {
      const root = mountChat(document, { history: [], seed: 0 })
      const stampFixture = 'turn-fixed-stream-fixture'
      const stream = root.openStream({ at: STREAM_AT, turnStamp: stampFixture })
      const before = assertLiveIdentity(root, STREAM_AT, stampFixture, null, 'T4/T5 fixed stream before close')
      stream.push('streamed content fixture')
      stream.close()
      assertLiveIdentity(root, STREAM_AT, stampFixture, before, 'T4/T5 fixed stream after close')
    })
  })

  test('fresh outgoing send captures one instant and renders its owner copy', async () => {
    await withTestDom(async (document) => {
      const sends = []
      const root = mountChat(document, {
        history: [],
        seed: 0,
        onSend(text, handlers) {
          sends.push({ text, handlers })
        },
      })
      const input = root.querySelector('.chat-input input')
      const send = root.querySelector('.chat-send')
      assert.ok(input, 'outgoing case intended composer input exists; plausible bad value is null')
      assert.ok(send, 'outgoing case intended send control exists; plausible bad value is null')
      input.value = 'fresh outgoing fixture'
      input.dispatchEvent(new TestEvent('input', { bubbles: true }))

      const originalNow = Date.now
      let nowCalls = 0
      Date.now = () => {
        nowCalls += 1
        return OUTGOING_AT
      }
      try {
        send.click()
        await Promise.resolve()
        const rows = root.querySelectorAll('.msg.me')
        assert.equal(rows.length, 1, 'outgoing case intended new .msg.me row exists; plausible bad value is 0')
        assert.equal(nowCalls, 1, 'outgoing action samples Date.now exactly once; plausible bad value is 0 or 2')
        assert.equal(sends.length, 1, 'outgoing action reaches test-owned onSend once; plausible bad value is 0 or 2')
        assert.equal(sends[0].text, 'fresh outgoing fixture', 'outgoing action forwards the entered fixture; plausible bad value is empty text')
        assert.ok(sends[0].handlers && typeof sends[0].handlers === 'object', 'outgoing action supplies public handlers; plausible bad value is null')
        assertOneOwnedTime(rows[0], OUTGOING_AT, 'fresh outgoing captured row')
      } finally {
        Date.now = originalNow
      }
    })
  })

  test('default live stream samples one instant and preserves its separate stamp (T6)', async () => {
    await withTestDom((document) => {
      const root = mountChat(document, { history: [], seed: 0 })
      const stampFixture = 'turn-default-stream-fixture'
      const originalNow = Date.now
      let nowCalls = 0
      Date.now = () => {
        nowCalls += 1
        return DEFAULT_STREAM_AT
      }
      try {
        const stream = root.openStream({ turnStamp: stampFixture })
        assert.equal(nowCalls, 1, 'T6 default stream samples Date.now exactly once; split-sampling mutation observes 2')
        const before = assertLiveIdentity(root, DEFAULT_STREAM_AT, stampFixture, null, 'T6 default stream before close')
        stream.close()
        assertLiveIdentity(root, DEFAULT_STREAM_AT, stampFixture, before, 'T6 default stream after close')
      } finally {
        Date.now = originalNow
      }
    })
  })
}
