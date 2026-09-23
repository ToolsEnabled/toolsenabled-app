/**
 * A deliberately small, zero-dependency DOM stand-in for component tests.
 *
 * Selectors are limited to `.class`, `#id`, `tag`, `tag.class`, `tag[name]`, `[name]`, and
 * `[name=value]` (with an unquoted, single-quoted, or double-quoted value).
 * Queries may contain whitespace-separated steps. The last step selects the
 * candidate; every earlier step independently needs any match in the complete
 * parent chain. Steps are not ordered and the chain is not bounded by the
 * receiver. Anchored child chains (`:scope > simple > simple`) follow each
 * immediate child in order, bounded by the receiver. Commas, unanchored child
 * or sibling combinators, other pseudos, escapes, ordered descendant chains,
 * and general CSS are deliberately unsupported.
 *
 * innerHTML recognizes only [\w-]+ start/end tags, [\w-]+ attributes with
 * optional double-quoted values, explicit `/>`, and the non-pushed void tags
 * input, img, path, and rect. HTML comments are discarded. Entities, scripts, recovery,
 * namespaces, single/unquoted parsed values, and text-node fidelity are out of
 * scope. Synthetic geometry is zero by default and is not product layout.
 *
 * Installer restoration supports nested installs restored in LIFO order.
 * Out-of-order restore is unsupported.
 */

export class ClassList {
  constructor(element) { this.element = element }
  values() { return String(this.element.className || '').split(/\s+/).filter(Boolean) }
  contains(value) { return this.values().includes(value) }
  add(value) { const values = new Set(this.values()); values.add(value); this.element.className = [...values].join(' ') }
  remove(value) { this.element.className = this.values().filter(item => item !== value).join(' ') }
  toggle(value, force) {
    const values = new Set(this.values())
    const add = force === undefined ? !values.has(value) : force
    if (add) values.add(value); else values.delete(value)
    this.element.className = [...values].join(' ')
    return add
  }
}

export class Element {
  constructor(tag = 'div', ownerDocument = null) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = ownerDocument
    this.children = []
    this._content = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.classList = new ClassList(this)
    this.style = {
      cssText: '',
      setProperty(name, value) { this[name] = String(value) },
      getPropertyValue(name) { return Object.hasOwn(this, name) ? String(this[name]) : '' },
      /* THE THIRD HALF OF THE PAIR ABOVE, and its absence was not a gap in
         coverage -- it was a THROW. Production sets a custom property and then
         takes it off again (the tree graph's per-record placement does exactly
         that), and a stand-in that offers setProperty without removeProperty
         answers "record.el.style.removeProperty is not a function". Inside a
         view's own load path that lands in the load's catch, so the suite reads
         a page that refused its fleet -- a harness gap reported as a product
         defect. Returns the removed value, as the DOM's own does.
         Ported from 4d3cfab9 (app repo, "computers: wait for the projection a
         tree command needs, not only the first boot"). */
      removeProperty(name) {
        const had = Object.hasOwn(this, name) ? String(this[name]) : ''
        delete this[name]
        return had
      },
    }
    this.value = ''
    this.checked = false
    this.hidden = false
    this.disabled = false
    /* Native <dialog> exposes open plus showModal()/close(). Account switching
       uses those methods, so keep the stand-in's lifecycle observable instead
       of turning a valid menu click into a TypeError. */
    this.open = false
    this.scrollHeight = 0
    this.scrollTop = 0
    this.clientHeight = 0
    this._offsetHeight = 0
    this._text = ''
    this.dataset = new Proxy({}, {
      get: (_, key) => typeof key === 'string' ? this.getAttribute(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined : undefined,
      set: (_, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true },
    })
  }
  get hidden() { return this.attributes.has('hidden') }
  set hidden(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden') }
  get nodeType() { return 1 }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this._text = String(value); this.children = []; this._content = [this._text] }
  get textContent() { return this._content.map(item => typeof item === 'string' ? item : item.textContent).join('') }
  set innerHTML(value) {
    this._text = String(value)
    const root = parse(this._text, this.ownerDocument)
    const content = [...root._content]
    this.replaceChildren(...root.children)
    this._content = content
    for (const child of this.children) child.parentNode = this
  }
  get innerHTML() { return this._text }
  get offsetHeight() { return this._offsetHeight }
  set offsetHeight(value) { this._offsetHeight = value }
  get content() { return this }
  /* A form's named controls, the way production reaches them: form.elements.text.
     Real code addresses inputs through this constantly (agent-session.js reads
     `form.elements.text` at mount), and without it a consumer suite cannot
     mount the surface at all -- it throws before any assertion runs, which
     reads as "cannot test this" rather than as the missing mechanic it is.
     Keyed by the `name` attribute over all descendants, which is the form of
     access this stand-in exists to support; the indexed and iterable halves of
     the real HTMLFormControlsCollection are deliberately not modelled.
     A control named through its `name` property counts too: in a browser the
     property reflects the attribute, and production swaps a field for a
     picker that way (write-surfaces.js showRegister sets `select.name`). */
  /* The four documented positions, built on the primitives above rather than
     given their own insertion logic, so they cannot disagree with them. */
  insertAdjacentElement(position, node) {
    if (position === 'beforebegin') { if (this.parentNode) this.parentNode.insertBefore(node, this); return node }
    if (position === 'afterbegin') { this.insertBefore(node, this.firstChild); return node }
    if (position === 'beforeend') { this.appendChild(node); return node }
    if (position === 'afterend') { this.after(node); return node }
    throw new TypeError(`unsupported insertAdjacentElement position: ${position}`)
  }
  get elements() {
    const named = {}
    const walk = (node) => {
      for (const child of node.children) {
        const name = child.getAttribute('name') ?? (typeof child.name === 'string' ? child.name : null)
        if (name && !(name in named)) named[name] = child
        walk(child)
      }
    }
    walk(this)
    return named
  }
  get firstElementChild() { return this.children[0] || null }
  get firstChild() { return this.children[0] || null }
  get lastElementChild() { return this.children.at(-1) || null }
  get childElementCount() { return this.children.length }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
    if (name === 'value') this.value = String(value)
    if (name === 'checked') this.checked = true
    if (name === 'disabled') this.disabled = true
    if (name === 'hidden') this.hidden = true
  }
  getAttribute(name) { return name === 'class' ? this.className : (this.attributes.get(name) ?? null) }
  hasAttribute(name) { return name === 'class' ? this.className !== '' || this.attributes.has(name) : this.attributes.has(name) }
  toggleAttribute(name, force) {
    const present = this.hasAttribute(name)
    const add = force === undefined ? !present : Boolean(force)
    if (add) this.setAttribute(name, ''); else this.removeAttribute(name)
    return add
  }
  removeAttribute(name) {
    this.attributes.delete(name)
    if (name === 'disabled') this.disabled = false
    if (name === 'hidden') this.hidden = false
    if (name === 'checked') this.checked = false
  }
  _adopt(child) { child.remove(); child.parentNode = this; const setDocument = node => { node.ownerDocument = this.ownerDocument; for (const descendant of node.children) setDocument(descendant) }; setDocument(child) }
  appendChild(child) { this._adopt(child); this.children.push(child); this._content.push(child); return child }
  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at < 0) throw new Error('child is not a child of this element')
    this.children.splice(at, 1); this._content = this._content.filter(item => item !== child); child.parentNode = null; return child
  }
  insertBefore(node, ref) {
    if (ref === null) return this.appendChild(node)
    const at = this.children.indexOf(ref)
    if (at < 0) throw new Error('reference is not a child of this element')
    this._adopt(node); this.children.splice(at, 0, node)
    const contentAt = this._content.indexOf(ref); this._content.splice(contentAt, 0, node)
    return node
  }
  _appendText(value, before = false) { const text = String(value).trim(); if (!text) return; if (before) this._content.unshift(text); else this._content.push(text); this._text += text }
  append(...children) { children.forEach(child => child instanceof Element ? this.appendChild(child) : this._appendText(child)) }
  prepend(...nodes) { for (const node of [...nodes].reverse()) node instanceof Element ? this.insertBefore(node, this.firstChild) : this._appendText(node, true) }
  before(...nodes) {
    if (!this.parentNode) return
    const parent = this.parentNode
    for (const node of nodes) {
      if (node === this) continue
      if (node instanceof Element) parent.insertBefore(node, this)
      else { const text = String(node).trim(); if (text) { parent._content.splice(parent._content.indexOf(this), 0, text); parent._text += text } }
    }
  }
  after(...nodes) {
    if (!this.parentNode) return
    const parent = this.parentNode; let ref = parent.children[parent.children.indexOf(this) + 1] || null
    for (const node of nodes) { if (node instanceof Element) parent.insertBefore(node, ref); else { const text = String(node).trim(); if (text) { const at = parent._content.indexOf(ref); parent._content.splice(at < 0 ? parent._content.length : at, 0, text); parent._text += text } } }
  }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._content = []; this._text = ''; this.append(...nodes) }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  replaceWith(next) {
    if (!this.parentNode) return
    const parent = this.parentNode
    const at = parent.children.indexOf(this)
    parent.insertBefore(next, this); parent.removeChild(this)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener)) }
  dispatch(type, event = {}) {
    const dispatched = { ...event, type, key: event.key || '' }
    this.dispatchEvent(dispatched)
    return dispatched
  }
  dispatchEvent(event) {
    if (!event || !event.type) throw new TypeError('event.type is required')
    if (!('target' in event)) event.target = this
    let stopped = false
    const originalPrevent = event.preventDefault
    const originalStop = event.stopPropagation
    event.preventDefault = function () { this.defaultPrevented = true; if (originalPrevent) originalPrevent.call(this) }
    event.stopPropagation = function () { stopped = true; if (originalStop) originalStop.call(this) }
    const route = []; for (let node = this; node; node = node.parentNode) route.push([node, [...(node.listeners.get(event.type) || [])]])
    for (const [node, listeners] of route) { for (const listener of listeners) listener.call(node, event); if (stopped) break }
    return !event.defaultPrevented
  }
  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click' })
  }
  showModal() {
    this.open = true
    this.setAttribute('open', '')
  }
  close() {
    if (!this.open && !this.hasAttribute('open')) return
    this.open = false
    this.removeAttribute('open')
    this.dispatchEvent({ type: 'close' })
  }
  matches(selector) {
    if (typeof selector !== 'string' || !selector) return false
    if (/^\.[A-Za-z0-9_-]+$/.test(selector)) return this.classList.contains(selector.slice(1))
    if (/^#[A-Za-z0-9_-]+$/.test(selector)) return this.id === selector.slice(1)
    const taggedAttribute = selector.match(/^([\w-]+)(\[[^\]]+\])$/)
    if (taggedAttribute) return this.tagName === taggedAttribute[1].toUpperCase() && this.matches(taggedAttribute[2])
    if (selector.startsWith('[')) {
      const match = selector.match(/^\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]$/)
      return Boolean(match && this.attributes.has(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]))
    }
    const match = selector.match(/^([\w-]+)(?:\.([A-Za-z0-9_-]+))?$/)
    return Boolean(match && this.tagName === match[1].toUpperCase() && (!match[2] || this.classList.contains(match[2])))
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) {
    if (typeof selector !== 'string' || !selector.trim()) return []
    const scope = selector.trim().match(/^:scope((?:\s*>\s*[^\s,>+~:]+)+)$/)
    if (scope) {
      let parents = [this]
      for (const part of scope[1].split('>').slice(1)) {
        parents = parents.flatMap(parent => parent.children.filter(child => child.matches(part.trim())))
      }
      return parents
    }
    if (/[,>+~:]/.test(selector)) return []
    const parts = selector.trim().split(/\s+/)
    const found = []
    const visit = node => {
      for (const child of node.children) {
        const ancestorsMatch = parts.slice(0, -1).every(part => {
          for (let ancestor = child.parentNode; ancestor; ancestor = ancestor.parentNode) if (ancestor.matches(part)) return true
          return false
        })
        if (child.matches(parts.at(-1)) && ancestorsMatch) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null }
  contains(candidate) { return candidate === this || this.children.some(child => child.contains(candidate)) }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  /* NO DRAWING CONTEXT, WHICH IS AN ANSWER RATHER THAN A GAP. src/corona-gl.js
     documents null as the supported reply -- "returns null, deliberately,
     rather than throwing, when WebGL2 is unavailable" -- and the caller falls
     back to the CPU field renderer. Without this method the same question
     threw a TypeError, so any view that mounts the uptime ring could not be
     built here at all. */
  getContext() { return null }
  get isConnected() {
    const document = this.ownerDocument
    if (!document) return false
    for (let node = this; node; node = node.parentNode) {
      if (node === document.body || node === document.documentElement || node === document) return true
    }
    return false
  }
}

function parse(html, ownerDocument) {
  const root = new Element('fragment', ownerDocument)
  const stack = [root]
  let end = 0
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?([\w-]+)([^>]*)>/g)) {
    stack.at(-1)._appendText(html.slice(end, match.index))
    end = match.index + match[0].length
    if (match[0].startsWith('<!--')) continue
    if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    const node = new Element(match[1], ownerDocument)
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1], attribute[2] ?? '')
    stack.at(-1).appendChild(node)
    if (!/\/\s*$/.test(match[2]) && !/^(input|img|path|rect)$/i.test(match[1])) stack.push(node)
  }
  stack.at(-1)._appendText(html.slice(end))
  return root
}

export function createDocument() {
  const document = {
    activeElement: null,
    listeners: new Map(),
    createElement(tag) { return new Element(tag, this) },
    addEventListener() {},
    removeEventListener() {},
    elementFromPoint() { return null },
    fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
  }
  document.body = new Element('body', document)
  document.documentElement = new Element('html', document)
  return document
}

export function installDomStandIn(target = globalThis) {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) throw new TypeError('target must be an object')
  const keys = ['document', 'window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(target, key)]))
  const document = createDocument()
  const window = new Element('window', document)
  window.matchMedia = () => ({ matches: true })
  const values = {
    document,
    window,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { callback(); return 1 },
    cancelAnimationFrame: () => {},
  }
  for (const key of keys) Object.defineProperty(target, key, { value: values[key], writable: true, enumerable: true, configurable: true })
  let restored = false
  return { document, restore() {
    if (restored) return
    restored = true
    for (const key of keys) {
      const descriptor = descriptors.get(key)
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else delete target[key]
    }
  } }
}
