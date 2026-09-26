import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const componentsModule = await import('../../src/components.js')
const armed = Object.hasOwn(componentsModule, 'CHAT_HEADER_META_SEAM')

if (!armed) {
  describe.skip('chat real-data header capability (CHAT_HEADER_META_SEAM absent)', () => {})
} else {
  const {
    chatHeaderPathCopy,
    chatHeaderStatusCopy,
    chatHeaderBranchCopy,
    chatHeaderContextCopy,
  } = await import('../../src/chat-copy.js')

  const { buildChat } = componentsModule

  assert.equal(typeof buildChat, 'function')
  assert.equal(typeof chatHeaderPathCopy, 'function')
  assert.equal(typeof chatHeaderStatusCopy, 'function')
  assert.equal(typeof chatHeaderBranchCopy, 'function')
  assert.equal(typeof chatHeaderContextCopy, 'function')

  const PATH_HOOK = '[data-chat-header-path]'
  const STATUS_HOOK = '[data-chat-header-status]'
  const BRANCH_HOOK = '[data-chat-header-branch]'
  const CONTEXT_HOOK = '[data-chat-header-context]'
  const ALL_HOOKS = [PATH_HOOK, STATUS_HOOK, BRANCH_HOOK, CONTEXT_HOOK]

  const PROFILE_PATH = Object.freeze({ source: 'profile-cwd', value: 'C:\\work\\engine' })
  const WORKSPACE_PATH = Object.freeze({ source: 'session-workspace', value: '/workspace/engine' })
  const RUNNING_STATUS = Object.freeze({ source: 'session-node-status', key: 'running' })
  const BRANCH = Object.freeze({ source: 'git', name: 'feature/header', dirty: true })
  const CONTEXT = Object.freeze({
    source: 'current-context',
    usedTokens: 1200,
    capacityTokens: 8000,
  })

  class MiniEvent {
    constructor(type, options = {}) {
      this.type = String(type)
      this.bubbles = Boolean(options.bubbles)
      this.cancelable = Boolean(options.cancelable)
      this.defaultPrevented = false
      this.target = null
      this.currentTarget = null
      this.cancelBubble = false
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true
    }

    stopPropagation() {
      this.cancelBubble = true
    }
  }

  class MiniNode {
    constructor(ownerDocument, nodeType) {
      this.ownerDocument = ownerDocument
      this.nodeType = nodeType
      this.parentNode = null
      this.childNodes = []
      this.listeners = new Map()
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

    get nextSibling() {
      if (!this.parentNode) return null
      const index = this.parentNode.childNodes.indexOf(this)
      return this.parentNode.childNodes[index + 1] ?? null
    }

    get previousSibling() {
      if (!this.parentNode) return null
      const index = this.parentNode.childNodes.indexOf(this)
      return this.parentNode.childNodes[index - 1] ?? null
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

    get isConnected() {
      let node = this
      while (node) {
        if (node.nodeType === 9) return true
        node = node.parentNode
      }
      return false
    }

    appendChild(node) {
      if (!(node instanceof MiniNode)) throw new TypeError('appendChild requires a node')
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) this.appendChild(child)
        return node
      }
      node.remove()
      node.parentNode = this
      this.childNodes.push(node)
      return node
    }

    append(...values) {
      for (const value of values) {
        this.appendChild(value instanceof MiniNode
          ? value
          : this.ownerDocument.createTextNode(String(value)))
      }
    }

    prepend(...values) {
      const nodes = values.map((value) => value instanceof MiniNode
        ? value
        : this.ownerDocument.createTextNode(String(value)))
      for (const node of nodes.reverse()) this.insertBefore(node, this.firstChild)
    }

    insertBefore(node, referenceNode) {
      if (referenceNode === null) return this.appendChild(node)
      const index = this.childNodes.indexOf(referenceNode)
      if (index < 0) throw new Error('reference node is not a child')
      node.remove()
      node.parentNode = this
      this.childNodes.splice(index, 0, node)
      return node
    }

    replaceChildren(...values) {
      for (const child of [...this.childNodes]) child.remove()
      this.append(...values)
    }

    replaceWith(...values) {
      if (!this.parentNode) return
      const parent = this.parentNode
      const reference = this.nextSibling
      this.remove()
      for (const value of values) {
        const node = value instanceof MiniNode
          ? value
          : parent.ownerDocument.createTextNode(String(value))
        parent.insertBefore(node, reference)
      }
    }

    remove() {
      if (!this.parentNode) return
      const index = this.parentNode.childNodes.indexOf(this)
      if (index >= 0) this.parentNode.childNodes.splice(index, 1)
      this.parentNode = null
    }

    contains(candidate) {
      for (let node = candidate; node; node = node.parentNode) {
        if (node === this) return true
      }
      return false
    }

    addEventListener(type, listener, options = {}) {
      if (!listener) return
      const entries = this.listeners.get(type) ?? []
      entries.push({ listener, once: Boolean(options?.once) })
      this.listeners.set(type, entries)
    }

    removeEventListener(type, listener) {
      const entries = this.listeners.get(type) ?? []
      this.listeners.set(type, entries.filter((entry) => entry.listener !== listener))
    }

    dispatchEvent(event) {
      if (!(event instanceof MiniEvent)) throw new TypeError('dispatchEvent requires an Event')
      if (!event.target) event.target = this
      event.currentTarget = this
      const entries = [...(this.listeners.get(event.type) ?? [])]
      for (const entry of entries) {
        if (typeof entry.listener === 'function') entry.listener.call(this, event)
        else entry.listener.handleEvent(event)
        if (entry.once) this.removeEventListener(event.type, entry.listener)
      }
      const handler = this[`on${event.type}`]
      if (typeof handler === 'function') handler.call(this, event)
      if (event.bubbles && !event.cancelBubble && this.parentNode) {
        this.parentNode.dispatchEvent(event)
      }
      return !event.defaultPrevented
    }

    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('')
    }

    set textContent(value) {
      this.replaceChildren()
      if (value !== null && value !== undefined && String(value) !== '') {
        this.appendChild(this.ownerDocument.createTextNode(String(value)))
      }
    }
  }

  class MiniText extends MiniNode {
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

  class MiniClassList {
    constructor(element) {
      this.element = element
    }

    values() {
      return this.element.className.split(/\s+/).filter(Boolean)
    }

    contains(token) {
      return this.values().includes(token)
    }

    add(...tokens) {
      this.element.className = [...new Set([...this.values(), ...tokens])].join(' ')
    }

    remove(...tokens) {
      this.element.className = this.values().filter((token) => !tokens.includes(token)).join(' ')
    }

    toggle(token, force) {
      const present = this.contains(token)
      const next = force === undefined ? !present : Boolean(force)
      if (next) this.add(token)
      else this.remove(token)
      return next
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

  function dataName(property) {
    return `data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
  }

  function makeStyle() {
    const values = new Map()
    return new Proxy({
      setProperty(name, value) {
        values.set(String(name), String(value))
      },
      getPropertyValue(name) {
        return values.get(String(name)) ?? ''
      },
      removeProperty(name) {
        const prior = values.get(String(name)) ?? ''
        values.delete(String(name))
        return prior
      },
    }, {
      get(target, property) {
        if (property in target) return target[property]
        if (property === 'cssText') return [...values].map(([key, value]) => `${key}: ${value};`).join(' ')
        return values.get(String(property)) ?? ''
      },
      set(_target, property, value) {
        if (property === 'cssText' && String(value) === '') values.clear()
        else values.set(String(property), String(value))
        return true
      },
    })
  }

  function splitSelectorList(selector) {
    const parts = []
    let bracketDepth = 0
    let current = ''
    for (const character of selector) {
      if (character === '[' || character === '(') bracketDepth += 1
      if (character === ']' || character === ')') bracketDepth -= 1
      if (character === ',' && bracketDepth === 0) {
        parts.push(current.trim())
        current = ''
      } else current += character
    }
    if (current.trim()) parts.push(current.trim())
    return parts
  }

  function splitDescendants(selector) {
    const parts = []
    let bracketDepth = 0
    let current = ''
    for (const character of selector.trim()) {
      if (character === '[' || character === '(') bracketDepth += 1
      if (character === ']' || character === ')') bracketDepth -= 1
      if (/\s/.test(character) && bracketDepth === 0) {
        if (current) parts.push(current)
        current = ''
      } else current += character
    }
    if (current) parts.push(current)
    return parts
  }

  function matchesSimple(element, selector) {
    if (selector === '*') return true
    let rest = selector
    const tag = rest.match(/^[a-zA-Z][\w-]*/)?.[0]
    if (tag) {
      if (element.localName !== tag.toLowerCase()) return false
      rest = rest.slice(tag.length)
    }
    while (rest) {
      if (rest.startsWith('.')) {
        const token = rest.match(/^\.([\w-]+)/)?.[1]
        if (!token || !element.classList.contains(token)) return false
        rest = rest.slice(token.length + 1)
        continue
      }
      if (rest.startsWith('#')) {
        const token = rest.match(/^#([\w-]+)/)?.[1]
        if (!token || element.id !== token) return false
        rest = rest.slice(token.length + 1)
        continue
      }
      if (rest.startsWith('[')) {
        const end = rest.indexOf(']')
        if (end < 0) return false
        const expression = rest.slice(1, end).trim()
        const match = expression.match(/^([^\s~|^$*!=]+)\s*(?:=\s*["']?([^"']*)["']?)?$/)
        if (!match) return false
        const [, name, expected] = match
        if (!element.hasAttribute(name)) return false
        if (expected !== undefined && element.getAttribute(name) !== expected) return false
        rest = rest.slice(end + 1)
        continue
      }
      if (rest.startsWith(':not(')) {
        const end = rest.indexOf(')')
        if (end < 0 || matchesSimple(element, rest.slice(5, end))) return false
        rest = rest.slice(end + 1)
        continue
      }
      return false
    }
    return true
  }

  function matchesComplex(element, selector) {
    const parts = splitDescendants(selector)
    if (parts.length === 0 || !matchesSimple(element, parts.at(-1))) return false
    let ancestor = element.parentElement
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement
      if (!ancestor) return false
      ancestor = ancestor.parentElement
    }
    return true
  }

  class MiniElement extends MiniNode {
    constructor(ownerDocument, localName) {
      super(ownerDocument, 1)
      this.localName = String(localName).toLowerCase()
      this.tagName = this.localName.toUpperCase()
      this.attributes = new Map()
      this.classList = new MiniClassList(this)
      this.style = makeStyle()
      this.value = ''
      this.checked = false
      this.disabled = false
      this.scrollTop = 0
      this.scrollLeft = 0
      this._className = ''
      this.dataset = new Proxy({}, {
        get: (_target, property) => this.getAttribute(dataName(property)) ?? undefined,
        set: (_target, property, value) => {
          this.setAttribute(dataName(property), value)
          return true
        },
        deleteProperty: (_target, property) => this.removeAttribute(dataName(property)),
      })
    }

    get className() {
      return this._className
    }

    set className(value) {
      this._className = String(value ?? '')
      if (this._className) this.attributes.set('class', this._className)
      else this.attributes.delete('class')
    }

    get id() {
      return this.getAttribute('id') ?? ''
    }

    set id(value) {
      this.setAttribute('id', value)
    }

    get hidden() {
      return this.hasAttribute('hidden')
    }

    set hidden(value) {
      this.toggleAttribute('hidden', Boolean(value))
    }

    get innerHTML() {
      return this.textContent
    }

    set innerHTML(value) {
      this.textContent = value
    }

    get nextElementSibling() {
      let node = this.nextSibling
      while (node && node.nodeType !== 1) node = node.nextSibling
      return node
    }

    get previousElementSibling() {
      let node = this.previousSibling
      while (node && node.nodeType !== 1) node = node.previousSibling
      return node
    }

    setAttribute(name, value) {
      const key = String(name)
      const stringValue = String(value)
      if (key === 'class') this._className = stringValue
      this.attributes.set(key, stringValue)
    }

    getAttribute(name) {
      return this.attributes.get(String(name)) ?? null
    }

    hasAttribute(name) {
      return this.attributes.has(String(name))
    }

    removeAttribute(name) {
      const key = String(name)
      if (key === 'class') this._className = ''
      return this.attributes.delete(key)
    }

    toggleAttribute(name, force) {
      const next = force === undefined ? !this.hasAttribute(name) : Boolean(force)
      if (next) this.setAttribute(name, '')
      else this.removeAttribute(name)
      return next
    }

    matches(selector) {
      return splitSelectorList(selector).some((part) => matchesComplex(this, part))
    }

    closest(selector) {
      for (let node = this; node?.nodeType === 1; node = node.parentElement) {
        if (node.matches(selector)) return node
      }
      return null
    }

    querySelectorAll(selector) {
      const found = []
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (child.matches(selector)) found.push(child)
            visit(child)
          }
        }
      }
      visit(this)
      return found
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }

    click() {
      if (!this.disabled) this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true }))
    }

    focus() {
      this.ownerDocument.activeElement = this
      this.dispatchEvent(new MiniEvent('focus'))
    }

    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
      this.dispatchEvent(new MiniEvent('blur'))
    }

    scrollIntoView() {}

    getBoundingClientRect() {
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }
    }
  }

  class MiniFragment extends MiniNode {
    constructor(ownerDocument) {
      super(ownerDocument, 11)
    }

    querySelectorAll(selector) {
      const holder = new MiniElement(this.ownerDocument, 'fragment-holder')
      holder.childNodes = this.childNodes
      return holder.querySelectorAll(selector)
    }
  }

  function decodeHtml(value) {
    return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
      const lower = entity.toLowerCase()
      if (lower === 'amp') return '&'
      if (lower === 'lt') return '<'
      if (lower === 'gt') return '>'
      if (lower === 'quot') return '"'
      if (lower === 'apos') return "'"
      const radix = lower.startsWith('#x') ? 16 : 10
      const digits = lower.slice(radix === 16 ? 2 : 1)
      const point = Number.parseInt(digits, radix)
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole
    })
  }

  function parseHtml(ownerDocument, markup) {
    const fragment = new MiniFragment(ownerDocument)
    const stack = [fragment]
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
    const tokens = String(markup).match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g) ?? []
    for (const token of tokens) {
      if (token.startsWith('<!--')) continue
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop()
        continue
      }
      if (token.startsWith('<')) {
        const opening = token.match(/^<([^\s/>]+)([\s\S]*?)(\/?)>$/)
        if (!opening) continue
        const [, name, rawAttributes, selfClosing] = opening
        const element = ownerDocument.createElement(name)
        const attributes = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
        for (const match of rawAttributes.matchAll(attributes)) {
          element.setAttribute(match[1], decodeHtml(match[2] ?? match[3] ?? match[4] ?? ''))
        }
        stack.at(-1).appendChild(element)
        if (!selfClosing && !voidTags.has(element.localName)) stack.push(element)
        continue
      }
      stack.at(-1).appendChild(ownerDocument.createTextNode(decodeHtml(token)))
    }
    return fragment
  }

  class MiniTemplate extends MiniElement {
    constructor(ownerDocument) {
      super(ownerDocument, 'template')
      this.content = new MiniFragment(ownerDocument)
    }

    get innerHTML() {
      return this.content.textContent
    }

    set innerHTML(value) {
      this.content = parseHtml(this.ownerDocument, value)
    }
  }

  class MiniDocument extends MiniNode {
    constructor() {
      super(null, 9)
      this.ownerDocument = this
      this.documentElement = new MiniElement(this, 'html')
      this.body = new MiniElement(this, 'body')
      this.documentElement.appendChild(this.body)
      this.appendChild(this.documentElement)
      this.activeElement = this.body
      this.defaultView = null
    }

    createElement(name) {
      return String(name).toLowerCase() === 'template'
        ? new MiniTemplate(this)
        : new MiniElement(this, name)
    }

    createElementNS(_namespace, name) {
      return this.createElement(name)
    }

    createTextNode(value) {
      return new MiniText(this, value)
    }

    createDocumentFragment() {
      return new MiniFragment(this)
    }

    querySelectorAll(selector) {
      const found = []
      if (this.documentElement.matches(selector)) found.push(this.documentElement)
      return [...found, ...this.documentElement.querySelectorAll(selector)]
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }

    getElementById(id) {
      return this.querySelector(`#${id}`)
    }
  }

  function installDom() {
    const document = new MiniDocument()
    class MiniResizeObserver {
      constructor(callback) {
        this.callback = callback
        this.targets = new Set()
      }

      observe(target) {
        this.targets.add(target)
      }

      unobserve(target) {
        this.targets.delete(target)
      }

      disconnect() {
        this.targets.clear()
      }
    }
    class MiniMutationObserver {
      constructor(callback) {
        this.callback = callback
        this.targets = new Set()
      }

      observe(target) {
        this.targets.add(target)
      }

      disconnect() {
        this.targets.clear()
      }

      takeRecords() {
        return []
      }
    }
    const window = {
      document,
      Event: MiniEvent,
      Node: MiniNode,
      Element: MiniElement,
      HTMLElement: MiniElement,
      ResizeObserver: MiniResizeObserver,
      MutationObserver: MiniMutationObserver,
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ display: '', visibility: '' }),
      requestAnimationFrame: (callback) => callback(0),
      cancelAnimationFrame() {},
    }
    document.defaultView = window
    globalThis.document = document
    globalThis.window = window
    globalThis.Event = MiniEvent
    globalThis.Node = MiniNode
    globalThis.Element = MiniElement
    globalThis.HTMLElement = MiniElement
    globalThis.ResizeObserver = MiniResizeObserver
    globalThis.MutationObserver = MiniMutationObserver
    globalThis.requestAnimationFrame = window.requestAnimationFrame
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame
    return document
  }

  function within(root, selector) {
    return [
      ...(root.nodeType === 1 && root.matches(selector) ? [root] : []),
      ...root.querySelectorAll(selector),
    ]
  }

  function mount(options) {
    const document = installDom()
    const root = buildChat(options)
    document.body.appendChild(root)
    return { document, root }
  }

  function assertIdentity(root, title, subtitle) {
    const heads = within(root, '.chat-head')
    assert.equal(heads.length, 1, 'identity: .chat-head count is one; bad values are zero or two')
    const titles = within(heads[0], '.t')
    assert.equal(titles.length, 1, 'identity: .t count is one; bad values are zero or two')
    assert.equal(titles[0].textContent, title, 'identity: title is the supplied fixture; bad value is empty')
    if (subtitle !== undefined) {
      assert.equal(
        heads[0].textContent.includes(subtitle),
        true,
        'identity: subtitle remains in the header; bad value is false',
      )
    }
    return heads[0]
  }

  function positiveCopy(helper, record, label) {
    const result = helper(record)
    assert.notEqual(result, null, `${label}: helper returns a copy object; bad value is null`)
    assert.equal(Object.isFrozen(result), true, `${label}: copy object is frozen; bad value is false`)
    return result
  }

  function assertPositive(root, hook, helper, record, label) {
    const expected = positiveCopy(helper, record, label)
    const nodes = within(root, hook)
    assert.equal(nodes.length, 1, `${label}: hook count is one; bad values are zero or two`)
    // H6 bypassing the copy helper makes these independently observed DOM values
    // differ: a plausible bad visible value is empty and a plausible bad aria value is null.
    assert.equal(
      nodes[0].textContent,
      expected.text,
      `${label}: H6 visible text comes from the public owner export; bad value is empty`,
    )
    assert.equal(
      nodes[0].getAttribute('aria-label'),
      expected.ariaLabel,
      `${label}: H6 aria comes from the public owner export; bad value is null`,
    )
    return { expected, node: nodes[0] }
  }

  function assertAbsent(root, hook, label) {
    assert.equal(within(root, hook).length, 0, `${label}: hook count is zero; bad value is one`)
  }

  function assertNoMetadata(root, label) {
    assert.equal(
      within(root, '.chat-header-meta').length,
      0,
      `${label}: metadata wrapper count is zero; bad value is one`,
    )
    for (const hook of ALL_HOOKS) assertAbsent(root, hook, label)
  }

  function metadataHookOrder(root) {
    const wrapper = within(root, '.chat-header-meta')[0]
    if (!wrapper) return []
    const ordered = []
    const visit = (node) => {
      for (const child of node.children) {
        const hook = ALL_HOOKS.find((candidate) => child.matches(candidate))
        if (hook) ordered.push(hook)
        visit(child)
      }
    }
    visit(wrapper)
    return ordered
  }

  function semanticallyAvailable(element) {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false
    }
    return true
  }

  function searchState(root, button) {
    const inputs = within(root, 'input')
    return {
      inputCount: inputs.length,
      availableInputCount: inputs.filter(semanticallyAvailable).length,
      expanded: button.getAttribute('aria-expanded'),
    }
  }

  function exerciseHeaderControls(root, head, onExpandCount, onCloseCount) {
    const controls = within(head, 'button')
    assert.equal(controls.length, 3, 'header control count is three; bad values are two or four')
    let searchControl = null
    let searchBefore = null
    let searchAfter = null
    for (const control of controls) {
      const before = searchState(root, control)
      control.click()
      const after = searchState(root, control)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        assert.equal(searchControl, null, 'one header control toggles search; bad value is a second control')
        searchControl = control
        searchBefore = before
        searchAfter = after
      }
    }
    assert.notEqual(searchControl, null, 'search control changes semantic input state; bad value is null')
    assert.notDeepEqual(searchAfter, searchBefore, 'search opens or closes; bad value is unchanged state')
    searchControl.click()
    assert.deepEqual(
      searchState(root, searchControl),
      searchBefore,
      'search toggles back to its initial semantic state; bad value is the prior toggled state',
    )
    assert.equal(onExpandCount(), 1, 'expand callback count is one; bad values are zero or two')
    assert.equal(onCloseCount(), 1, 'close callback count is one; bad values are zero or two')
    return controls.length
  }

  describe('real-data chat header public runtime contract', () => {
    test('static complete snapshot keeps identity, ordered facts, search, expand, and close', () => {
      const title = 'Header fixture'
      const subtitle = 'Subtitle fixture'
      let expandCount = 0
      let closeCount = 0
      const { root } = mount({
        title,
        subtitle,
        onExpand: () => { expandCount += 1 },
        onClose: () => { closeCount += 1 },
        headerMeta: {
          path: PROFILE_PATH,
          status: RUNNING_STATUS,
          branch: BRANCH,
          context: CONTEXT,
        },
      })

      const head = assertIdentity(root, title, subtitle)
      assert.equal(within(root, '.chat-header-meta').length, 1, 'complete snapshot has one wrapper; bad value is two')
      assert.deepEqual(
        metadataHookOrder(root),
        ALL_HOOKS,
        'fact hooks preserve path/status/branch/context order; bad value is a swapped pair',
      )
      assertPositive(root, PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH, 'complete path')
      assertPositive(root, STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS, 'complete status')
      assertPositive(root, BRANCH_HOOK, chatHeaderBranchCopy, BRANCH, 'complete branch')
      assertPositive(root, CONTEXT_HOOK, chatHeaderContextCopy, CONTEXT, 'complete context')
      exerciseHeaderControls(root, head, () => expandCount, () => closeCount)
    })

    test('portable path records use the exact public formatter results', () => {
      const cases = [
        ['profile path fixture', PROFILE_PATH],
        ['workspace path fixture', WORKSPACE_PATH],
      ]
      for (const [label, path] of cases) {
        const title = `${label} title`
        const { root } = mount({ title, subtitle: `${label} subtitle`, headerMeta: { path } })
        assertIdentity(root, title, `${label} subtitle`)
        assertPositive(root, PATH_HOOK, chatHeaderPathCopy, path, label)
        assertAbsent(root, STATUS_HOOK, label)
        assertAbsent(root, BRANCH_HOOK, label)
        assertAbsent(root, CONTEXT_HOOK, label)
      }
    })

    test('each fact omits independently and title-only reserves no metadata space', () => {
      const omissions = [
        {
          label: 'omitted path',
          hook: PATH_HOOK,
          headerMeta: { status: RUNNING_STATUS },
          sibling: [STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'omitted status',
          hook: STATUS_HOOK,
          headerMeta: { path: PROFILE_PATH },
          sibling: [PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH],
        },
        {
          label: 'omitted branch',
          hook: BRANCH_HOOK,
          headerMeta: { context: CONTEXT },
          sibling: [CONTEXT_HOOK, chatHeaderContextCopy, CONTEXT],
        },
        {
          label: 'omitted context',
          hook: CONTEXT_HOOK,
          headerMeta: { branch: BRANCH },
          sibling: [BRANCH_HOOK, chatHeaderBranchCopy, BRANCH],
        },
      ]

      for (const entry of omissions) {
        const title = `${entry.label} title`
        const { root } = mount({ title, subtitle: `${entry.label} subtitle`, headerMeta: entry.headerMeta })
        assertIdentity(root, title, `${entry.label} subtitle`)
        assertPositive(root, ...entry.sibling, `${entry.label} sibling`)
        assertAbsent(root, entry.hook, entry.label)
      }

      const title = 'Title-only fixture'
      const { root } = mount({ title, subtitle: 'Title-only subtitle' })
      assertIdentity(root, title, 'Title-only subtitle')
      // H5 appending default facts makes these exact zero-count assertions observe one.
      assertNoMetadata(root, 'H5 title-only absence; plausible bad value is one wrapper or hook')
    })

    test('invalid discriminated records return null and paint no targeted hook', () => {
      const invalidCases = [
        {
          label: 'H2 bare path record', member: 'path', value: 'C:\\work\\engine',
          hook: PATH_HOOK, helper: chatHeaderPathCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'blank path value', member: 'path',
          value: { source: 'profile-cwd', value: '   ' },
          hook: PATH_HOOK, helper: chatHeaderPathCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'unknown path source', member: 'path',
          value: { source: 'test-unknown-path-source', value: 'C:\\work\\engine' },
          hook: PATH_HOOK, helper: chatHeaderPathCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'blank status key', member: 'status',
          value: { source: 'session-node-status', key: '   ' },
          hook: STATUS_HOOK, helper: chatHeaderStatusCopy,
          sibling: ['path', PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH],
        },
        {
          label: 'wrong status source', member: 'status',
          value: { ...RUNNING_STATUS, source: 'test-wrong-status-source' },
          hook: STATUS_HOOK, helper: chatHeaderStatusCopy,
          sibling: ['path', PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH],
        },
        {
          label: 'H2 unowned status key', member: 'status',
          value: { source: 'session-node-status', key: 'test-unowned-key' },
          hook: STATUS_HOOK, helper: chatHeaderStatusCopy,
          sibling: ['path', PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH],
        },
        {
          label: 'wrong branch source', member: 'branch',
          value: { ...BRANCH, source: 'test-wrong-branch-source' },
          hook: BRANCH_HOOK, helper: chatHeaderBranchCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'blank branch name', member: 'branch',
          value: { source: 'git', name: '   ', dirty: true },
          hook: BRANCH_HOOK, helper: chatHeaderBranchCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'non-boolean branch dirty field', member: 'branch',
          value: { source: 'git', name: 'feature/header', dirty: 1 },
          hook: BRANCH_HOOK, helper: chatHeaderBranchCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        {
          label: 'wrong context source', member: 'context',
          value: { ...CONTEXT, source: 'test-wrong-context-source' },
          hook: CONTEXT_HOOK, helper: chatHeaderContextCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
        ...[
          ['fractional used tokens', { usedTokens: 1.5, capacityTokens: 8000 }],
          ['fractional capacity tokens', { usedTokens: 1200, capacityTokens: 8000.5 }],
          ['negative used tokens', { usedTokens: -1, capacityTokens: 8000 }],
          ['negative capacity tokens', { usedTokens: 1200, capacityTokens: -1 }],
          ['NaN used tokens', { usedTokens: Number.NaN, capacityTokens: 8000 }],
          ['NaN capacity tokens', { usedTokens: 1200, capacityTokens: Number.NaN }],
          ['infinite used tokens', { usedTokens: Number.POSITIVE_INFINITY, capacityTokens: 8000 }],
          ['infinite capacity tokens', { usedTokens: 1200, capacityTokens: Number.POSITIVE_INFINITY }],
          ['zero capacity tokens', { usedTokens: 0, capacityTokens: 0 }],
          ['used tokens above capacity', { usedTokens: 8001, capacityTokens: 8000 }],
        ].map(([label, numbers]) => ({
          label,
          member: 'context',
          value: { source: 'current-context', ...numbers },
          hook: CONTEXT_HOOK,
          helper: chatHeaderContextCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        })),
        {
          label: 'legacy context fields', member: 'context',
          value: { totalTokens: 1200, modelContextWindow: 8000 },
          hook: CONTEXT_HOOK, helper: chatHeaderContextCopy,
          sibling: ['status', STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS],
        },
      ]

      for (const entry of invalidCases) {
        const title = `${entry.label} title`
        const [siblingMember, siblingHook, siblingHelper, siblingRecord] = entry.sibling
        const { root } = mount({
          title,
          subtitle: `${entry.label} subtitle`,
          headerMeta: { [entry.member]: entry.value, [siblingMember]: siblingRecord },
        })
        assertIdentity(root, title, `${entry.label} subtitle`)
        assertPositive(root, siblingHook, siblingHelper, siblingRecord, `${entry.label} valid sibling`)
        assert.equal(
          entry.helper(entry.value),
          null,
          `${entry.label}: targeted helper returns null; bad value is a copy object`,
        )
        // H2 accepting an undiscriminated record or unowned key makes this observe one.
        assertAbsent(root, entry.hook, `${entry.label}; H2 plausible bad hook count is one`)
      }
    })

    test('provider mount and notice read snapshots wholly without duplication', () => {
      let snapshot = { path: PROFILE_PATH, status: RUNNING_STATUS }
      let readCount = 0
      let subscribeCount = 0
      let disposeCount = 0
      let notice = null
      const provider = {
        read() {
          readCount += 1
          return snapshot
        },
        subscribe(listener) {
          subscribeCount += 1
          notice = listener
          return () => { disposeCount += 1 }
        },
      }
      const title = 'Provider fixture'
      const { root } = mount({
        title,
        subtitle: 'Provider subtitle',
        onExpand() {},
        onClose() {},
        headerMeta: provider,
      })

      const head = assertIdentity(root, title, 'Provider subtitle')
      assert.equal(readCount, 1, 'provider mount read count is one; bad value is zero or two')
      assert.equal(subscribeCount, 1, 'provider subscription count is one; bad value is zero or two')
      assert.equal(typeof notice, 'function', 'provider captures a notice listener; bad value is null')
      assertPositive(root, PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH, 'provider mount path')
      assertPositive(root, STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS, 'provider mount status')
      const controlCount = within(head, 'button').length

      snapshot = { status: RUNNING_STATUS }
      notice()

      assert.equal(readCount, 2, 'provider notice read count is two; bad value is one')
      // H1 merging instead of replacing leaves this hook behind with bad count one.
      assertAbsent(root, PATH_HOOK, 'H1 whole replacement path removal; plausible bad count is one')
      assertPositive(root, STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS, 'provider replacement status')
      assert.equal(within(root, '.chat-header-meta').length, 1, 'replacement wrapper count is one; bad value is two')
      assert.equal(within(head, 'button').length, controlCount, 'replacement control count is stable; bad value is baseline plus one')
      assert.equal(within(root, STATUS_HOOK).length, 1, 'replacement status stays singular; bad value is two')
      assertAbsent(root, BRANCH_HOOK, 'replacement branch absence')
      assertAbsent(root, CONTEXT_HOOK, 'replacement context absence')
      assert.equal(disposeCount, 0, 'provider remains live before disposal; bad value is one')
    })

    test('provider read failures clear metadata and later valid reads recover', () => {
      let mode = 'valid'
      let readCount = 0
      let notice = null
      const provider = {
        read() {
          readCount += 1
          if (mode === 'throw') throw new Error('test-owned read failure')
          if (mode === 'promise-like') return { then() {} }
          if (mode === 'non-record') return 17
          if (mode === 'recovery') return { path: WORKSPACE_PATH }
          return { path: PROFILE_PATH, status: RUNNING_STATUS }
        },
        subscribe(listener) {
          notice = listener
          return () => {}
        },
      }
      const title = 'Read failure fixture'
      const { root } = mount({ title, subtitle: 'Read failure subtitle', headerMeta: provider })

      assertIdentity(root, title, 'Read failure subtitle')
      assertPositive(root, PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH, 'read failure initial path')
      assertPositive(root, STATUS_HOOK, chatHeaderStatusCopy, RUNNING_STATUS, 'read failure initial status')
      assert.equal(readCount, 1, 'initial provider read count is one; bad value is zero')

      mode = 'throw'
      assert.doesNotThrow(() => notice(), 'provider read exception is contained; bad value is an uncaught error')
      // H4 retaining the last snapshot makes the wrapper and hooks observe one here.
      assertNoMetadata(root, 'H4 thrown read clears prior facts; plausible bad wrapper or hook count is one')

      mode = 'recovery'
      notice()
      assertPositive(root, PATH_HOOK, chatHeaderPathCopy, WORKSPACE_PATH, 'provider recovery path')
      assertAbsent(root, STATUS_HOOK, 'provider recovery replaces prior status')
      assertAbsent(root, BRANCH_HOOK, 'provider recovery branch absence')
      assertAbsent(root, CONTEXT_HOOK, 'provider recovery context absence')

      mode = 'promise-like'
      assert.doesNotThrow(() => notice(), 'Promise-like read result is contained; bad value is an uncaught error')
      assertNoMetadata(root, 'H4 Promise-like read clears prior facts; plausible bad hook count is one')

      mode = 'non-record'
      assert.doesNotThrow(() => notice(), 'non-record read result is contained; bad value is an uncaught error')
      assertNoMetadata(root, 'H4 non-record read clears prior facts; plausible bad hook count is one')
      assert.equal(readCount, 5, 'each notice performs one read; bad value is four')
    })

    test('subscription failures clear a valid preceding read without uncaught mount errors', () => {
      const cases = [
        ['throwing subscription', () => { throw new Error('test-owned subscription failure') }],
        ['non-function disposer', () => ({})],
      ]
      for (const [label, subscribe] of cases) {
        let readCount = 0
        const title = `${label} title`
        const { root } = mount({
          title,
          subtitle: `${label} subtitle`,
          headerMeta: {
            read() {
              readCount += 1
              return { status: RUNNING_STATUS }
            },
            subscribe,
          },
        })
        assertIdentity(root, title, `${label} subtitle`)
        assert.equal(readCount, 1, `${label}: preceding read count is one; bad value is zero or two`)
        assert.equal(Object.isFrozen(chatHeaderStatusCopy(RUNNING_STATUS)), true, `${label}: valid read copy is frozen; bad value is false`)
        // H4 retaining the preceding valid read makes these zero counts become one.
        assertNoMetadata(root, `H4 ${label} clears preceding facts; plausible bad hook count is one`)
      }
    })

    test('disposal is once-only and makes late notices inert against detached DOM', () => {
      let snapshot = { path: PROFILE_PATH }
      let readCount = 0
      let disposeCount = 0
      let notice = null
      const provider = {
        read() {
          readCount += 1
          return snapshot
        },
        subscribe(listener) {
          notice = listener
          return () => { disposeCount += 1 }
        },
      }
      const title = 'Disposal fixture'
      const { root } = mount({ title, subtitle: 'Disposal subtitle', headerMeta: provider })

      assertIdentity(root, title, 'Disposal subtitle')
      assertPositive(root, PATH_HOOK, chatHeaderPathCopy, PROFILE_PATH, 'disposal initial path')
      assert.equal(readCount, 1, 'disposal fixture mount read count is one; bad value is zero or two')
      assert.equal(typeof notice, 'function', 'disposal fixture captures listener; bad value is null')
      root.remove()
      assert.equal(root.isConnected, false, 'fixture DOM is detached; bad value is true')
      root.dispose()
      root.dispose()
      // H3 missing or repeated disposal makes this independently counted value zero or two.
      assert.equal(disposeCount, 1, 'H3 disposer count is one after two calls; plausible bad values are zero or two')

      const readsAfterDispose = readCount
      const factsAfterDispose = ALL_HOOKS.map((hook) => within(root, hook).map((node) => ({
        text: node.textContent,
        ariaLabel: node.getAttribute('aria-label'),
      })))
      snapshot = { status: RUNNING_STATUS }
      assert.doesNotThrow(() => notice(), 'late notice is inert; bad value is an uncaught error')
      // H3 removing the disposed guard makes this counter increase by one.
      assert.equal(readCount, readsAfterDispose, 'H3 late notice does not read; plausible bad value is prior count plus one')
      assert.equal(root.isConnected, false, 'late notice leaves DOM detached; bad value is true')
      assert.deepEqual(
        ALL_HOOKS.map((hook) => within(root, hook).map((node) => ({
          text: node.textContent,
          ariaLabel: node.getAttribute('aria-label'),
        }))),
        factsAfterDispose,
        'H3 late notice leaves detached fact DOM unchanged; bad value is a replaced path/status set',
      )
    })
  })
}
