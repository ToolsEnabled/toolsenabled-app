const componentsModule = await import('../../src/components.js');
const ownsDiffCardSeam = Object.hasOwn(componentsModule, 'CHAT_DIFF_CARD_SEAM');

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

if (!ownsDiffCardSeam) {
  test('inline diff card public seam is available', {
    skip: 'CHAT_DIFF_CARD_SEAM is not present on the components module',
  }, () => {});
} else {
  const { buildChat, createChatDiffOpenHandler } = componentsModule;
  const { sessionActivityEvent } = await import('../../src/agent-session-events.js');
  const {
    CHAT_DIFF_OPEN_TEXT,
    chatDiffAddedText,
    chatDiffOpenLabel,
    chatDiffPathText,
    chatDiffPositionText,
    chatDiffRemovedText,
    chatDiffStatusText,
  } = await import('../../src/chat-copy.js');

  assert.equal(typeof buildChat, 'function');
  assert.equal(typeof createChatDiffOpenHandler, 'function');
  assert.equal(typeof sessionActivityEvent, 'function');
  assert.equal(typeof CHAT_DIFF_OPEN_TEXT, 'string');
  for (const copyHelper of [
    chatDiffAddedText,
    chatDiffOpenLabel,
    chatDiffPathText,
    chatDiffPositionText,
    chatDiffRemovedText,
    chatDiffStatusText,
  ]) {
    assert.equal(typeof copyHelper, 'function');
  }

  class TestNode {
    constructor(ownerDocument) {
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
    }

    get parentElement() {
      return this.parentNode instanceof TestElement ? this.parentNode : null;
    }

    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.childNodes.indexOf(this);
      if (index >= 0) this.parentNode.childNodes.splice(index, 1);
      this.parentNode = null;
    }

    replaceWith(...nodes) {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const index = parent.childNodes.indexOf(this);
      if (index < 0) return;
      const replacements = nodes.map((node) => parent.asNode(node));
      for (const replacement of replacements) replacement.parentNode = parent;
      parent.childNodes.splice(index, 1, ...replacements);
      this.parentNode = null;
    }
  }

  class TestText extends TestNode {
    constructor(value, ownerDocument) {
      super(ownerDocument);
      this.nodeType = 3;
      this.nodeName = '#text';
      this.data = String(value);
    }

    get textContent() {
      return this.data;
    }

    set textContent(value) {
      this.data = String(value ?? '');
    }

    cloneNode() {
      return new TestText(this.data, this.ownerDocument);
    }
  }

  function dataName(property) {
    return `data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  }

  function decodeHtml(value) {
    return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      if (lower === 'nbsp') return '\u00a0';
      const radix = lower.startsWith('#x') ? 16 : 10;
      const digits = lower.slice(radix === 16 ? 2 : 1);
      return String.fromCodePoint(Number.parseInt(digits, radix));
    });
  }

  const voidElements = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  function parseAttributes(source, element) {
    const start = source.search(/\s/);
    if (start < 0) return;
    const attributes = source.slice(start);
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const match of attributes.matchAll(pattern)) {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      element.setAttribute(match[1], decodeHtml(value));
    }
  }

  function parseHtml(html, ownerDocument) {
    const fragment = new TestFragment(ownerDocument);
    const stack = [fragment];
    const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) ?? [];

    for (const token of tokens) {
      if (token.startsWith('<!--') || token.startsWith('<!')) continue;
      if (token.startsWith('</')) {
        const closingName = token.slice(2, -1).trim().toLowerCase();
        while (stack.length > 1) {
          const closed = stack.pop();
          if (closed.localName === closingName) break;
        }
        continue;
      }
      if (token.startsWith('<')) {
        const selfClosing = /\/\s*>$/.test(token);
        const inner = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
        const tagName = inner.match(/^[^\s/>]+/)?.[0];
        if (!tagName) continue;
        const element = ownerDocument.createElement(tagName);
        parseAttributes(inner, element);
        stack.at(-1).append(element);
        if (!selfClosing && !voidElements.has(element.localName)) stack.push(element);
        continue;
      }
      stack.at(-1).append(ownerDocument.createTextNode(decodeHtml(token)));
    }
    return fragment;
  }

  function splitSelectorGroups(selector) {
    const groups = [];
    let current = '';
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    let quote = '';
    for (const character of String(selector)) {
      if (quote) {
        current += character;
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        current += character;
      } else if (character === '[') {
        bracketDepth += 1;
        current += character;
      } else if (character === ']') {
        bracketDepth -= 1;
        current += character;
      } else if (character === '(') {
        parenthesisDepth += 1;
        current += character;
      } else if (character === ')') {
        parenthesisDepth -= 1;
        current += character;
      } else if (character === ',' && bracketDepth === 0 && parenthesisDepth === 0) {
        groups.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    if (current.trim()) groups.push(current.trim());
    return groups;
  }

  function tokenizeSelector(selector) {
    const tokens = [];
    let current = '';
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    let quote = '';
    let pendingDescendant = false;

    const pushCurrent = () => {
      if (!current.trim()) return;
      if (pendingDescendant && tokens.length > 0 && tokens.at(-1) !== '>') tokens.push(' ');
      tokens.push(current.trim());
      current = '';
      pendingDescendant = false;
    };

    for (const character of selector) {
      if (quote) {
        current += character;
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        current += character;
      } else if (character === '[') {
        bracketDepth += 1;
        current += character;
      } else if (character === ']') {
        bracketDepth -= 1;
        current += character;
      } else if (character === '(') {
        parenthesisDepth += 1;
        current += character;
      } else if (character === ')') {
        parenthesisDepth -= 1;
        current += character;
      } else if (bracketDepth === 0 && parenthesisDepth === 0 && character === '>') {
        pushCurrent();
        if (tokens.at(-1) === ' ') tokens.pop();
        tokens.push('>');
        pendingDescendant = false;
      } else if (bracketDepth === 0 && parenthesisDepth === 0 && /\s/.test(character)) {
        if (current.trim()) pushCurrent();
        if (tokens.length > 0 && tokens.at(-1) !== '>') pendingDescendant = true;
      } else {
        current += character;
      }
    }
    pushCurrent();
    return tokens;
  }

  function attributeMatches(element, name, operator, expected) {
    if (!element.hasAttribute(name)) return false;
    if (!operator) return true;
    const actual = element.getAttribute(name);
    if (operator === '=') return actual === expected;
    if (operator === '^=') return actual.startsWith(expected);
    if (operator === '$=') return actual.endsWith(expected);
    if (operator === '*=') return actual.includes(expected);
    if (operator === '~=') return actual.split(/\s+/).includes(expected);
    if (operator === '|=') return actual === expected || actual.startsWith(`${expected}-`);
    return false;
  }

  function matchesSimple(element, selector, scope) {
    let remaining = selector.trim();
    for (const match of [...remaining.matchAll(/:not\(([^()]*)\)/g)]) {
      if (matchesComplex(element, tokenizeSelector(match[1]), scope)) return false;
    }
    remaining = remaining.replace(/:not\([^()]*\)/g, '');

    if (remaining.includes(':scope') && element !== scope) return false;
    remaining = remaining.replace(/:scope/g, '');
    if (remaining.includes(':first-child') && element.parentElement?.children[0] !== element) return false;
    if (remaining.includes(':last-child') && element.parentElement?.children.at(-1) !== element) return false;
    if (remaining.includes(':checked') && !element.checked) return false;
    if (remaining.includes(':disabled') && !element.disabled) return false;
    remaining = remaining.replace(/:(?:first-child|last-child|checked|disabled)/g, '');

    const tag = remaining.match(/^[a-zA-Z][\w-]*/)?.[0];
    if (tag && element.localName !== tag.toLowerCase()) return false;

    for (const idMatch of remaining.matchAll(/#([\w-]+)/g)) {
      if (element.id !== idMatch[1]) return false;
    }
    for (const classMatch of remaining.matchAll(/\.([\w-]+)/g)) {
      if (!element.classList.contains(classMatch[1])) return false;
    }

    const attributePattern = /\[([^\]\s~|^$*!=]+)(?:\s*(\^=|\$=|\*=|~=|\|=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g;
    for (const match of remaining.matchAll(attributePattern)) {
      const expected = match[3] ?? match[4] ?? match[5] ?? '';
      if (!attributeMatches(element, match[1], match[2], expected)) return false;
    }
    return true;
  }

  function matchesComplex(element, tokens, scope) {
    if (tokens.length === 0) return false;
    let current = element;
    let index = tokens.length - 1;
    if (!matchesSimple(current, tokens[index], scope)) return false;
    index -= 1;

    while (index >= 0) {
      const combinator = tokens[index];
      const simple = tokens[index - 1];
      if (!simple) return false;
      if (combinator === '>') {
        current = current.parentElement;
        if (!current || !matchesSimple(current, simple, scope)) return false;
      } else {
        let ancestor = current.parentElement;
        while (ancestor && !matchesSimple(ancestor, simple, scope)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        current = ancestor;
      }
      index -= 2;
    }
    return true;
  }

  class TestElement extends TestNode {
    constructor(tagName, ownerDocument) {
      super(ownerDocument);
      this.nodeType = 1;
      this.localName = String(tagName).toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this.nodeName = this.tagName;
      this.childNodes = [];
      this._attributes = new Map();
      this._listeners = new Map();
      this.style = {
        setProperty(name, value) { this[name] = String(value); },
        removeProperty(name) { delete this[name]; },
      };
      this.scrollTop = 0;
      this.scrollHeight = 1;
      this.clientHeight = 1;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.dataset = new Proxy({}, {
        get: (_target, property) => this.getAttribute(dataName(property)) ?? undefined,
        set: (_target, property, value) => {
          this.setAttribute(dataName(property), value);
          return true;
        },
        deleteProperty: (_target, property) => this.removeAttribute(dataName(property)),
        ownKeys: () => [...this._attributes.keys()]
          .filter((name) => name.startsWith('data-'))
          .map((name) => name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())),
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
      });
    }

    asNode(value) {
      return value instanceof TestNode ? value : this.ownerDocument.createTextNode(value);
    }

    get children() {
      return this.childNodes.filter((node) => node instanceof TestElement);
    }

    get firstChild() {
      return this.childNodes[0] ?? null;
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    }

    get firstElementChild() {
      return this.children[0] ?? null;
    }

    get lastElementChild() {
      return this.children.at(-1) ?? null;
    }

    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    get previousElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) - 1] ?? null;
    }

    get textContent() {
      return this.childNodes.map((node) => node.textContent).join('');
    }

    set textContent(value) {
      this.replaceChildren();
      if (value !== '' && value !== null && value !== undefined) this.append(String(value));
    }

    get innerHTML() {
      return this.textContent;
    }

    set innerHTML(value) {
      const fragment = parseHtml(value, this.ownerDocument);
      this.replaceChildren(...fragment.childNodes);
    }

    get className() {
      return this.getAttribute('class') ?? '';
    }

    set className(value) {
      this.setAttribute('class', value);
    }

    get id() {
      return this.getAttribute('id') ?? '';
    }

    set id(value) {
      this.setAttribute('id', value);
    }

    get ariaLabel() {
      return this.getAttribute('aria-label') ?? '';
    }

    set ariaLabel(value) {
      this.setAttribute('aria-label', value);
    }

    get classList() {
      const element = this;
      const values = () => new Set(element.className.split(/\s+/).filter(Boolean));
      const write = (set) => { element.className = [...set].join(' '); };
      return {
        add(...tokens) {
          const set = values();
          for (const token of tokens) set.add(token);
          write(set);
        },
        contains(token) {
          return values().has(token);
        },
        remove(...tokens) {
          const set = values();
          for (const token of tokens) set.delete(token);
          write(set);
        },
        toggle(token, force) {
          const set = values();
          const enabled = force === undefined ? !set.has(token) : Boolean(force);
          if (enabled) set.add(token);
          else set.delete(token);
          write(set);
          return enabled;
        },
      };
    }

    append(...values) {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        const node = this.asNode(value);
        node.remove();
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }

    appendChild(node) {
      this.append(node);
      return node;
    }

    prepend(...values) {
      const nodes = values.map((value) => this.asNode(value));
      for (const node of nodes) {
        node.remove();
        node.parentNode = this;
      }
      this.childNodes.unshift(...nodes);
    }

    insertBefore(node, reference) {
      if (reference === null || reference === undefined) return this.appendChild(node);
      const index = this.childNodes.indexOf(reference);
      if (index < 0) throw new Error('Reference node does not belong to this parent');
      node.remove();
      node.parentNode = this;
      this.childNodes.splice(index, 0, node);
      return node;
    }

    replaceChildren(...values) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      this.append(...values);
    }

    setAttribute(name, value) {
      this._attributes.set(String(name), String(value));
      if (name === 'disabled') this.disabled = true;
      if (name === 'checked') this.checked = true;
      if (name === 'hidden') this.hidden = true;
    }

    getAttribute(name) {
      return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null;
    }

    hasAttribute(name) {
      return this._attributes.has(String(name));
    }

    removeAttribute(name) {
      const removed = this._attributes.delete(String(name));
      if (name === 'disabled') this.disabled = false;
      if (name === 'checked') this.checked = false;
      if (name === 'hidden') this.hidden = false;
      return removed;
    }

    toggleAttribute(name, force) {
      const shouldHave = force === undefined ? !this.hasAttribute(name) : Boolean(force);
      if (shouldHave) this.setAttribute(name, '');
      else this.removeAttribute(name);
      return shouldHave;
    }

    attributeEntries() {
      return [...this._attributes.entries()];
    }

    addEventListener(type, listener) {
      const listeners = this._listeners.get(type) ?? [];
      listeners.push(listener);
      this._listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this._listeners.get(type) ?? [];
      this._listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }

    dispatchEvent(eventLike) {
      const event = eventLike && typeof eventLike === 'object' ? eventLike : { type: eventLike };
      if (!event.type) throw new TypeError('Event type is required');
      if (!Object.hasOwn(event, 'target')) event.target = this;
      if (!Object.hasOwn(event, 'bubbles')) event.bubbles = true;
      event.defaultPrevented = Boolean(event.defaultPrevented);
      event.cancelBubble = false;
      event.preventDefault ??= () => { event.defaultPrevented = true; };
      event.stopPropagation ??= () => { event.cancelBubble = true; };

      let current = this;
      while (current) {
        event.currentTarget = current;
        for (const listener of [...(current._listeners?.get(event.type) ?? [])]) {
          if (typeof listener === 'function') listener.call(current, event);
          else listener.handleEvent(event);
        }
        const propertyListener = current[`on${event.type}`];
        if (typeof propertyListener === 'function') propertyListener.call(current, event);
        if (!event.bubbles || event.cancelBubble) break;
        current = current.parentElement;
      }
      return !event.defaultPrevented;
    }

    click() {
      if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true });
    }

    matches(selector) {
      return splitSelectorGroups(selector).some((group) => matchesComplex(this, tokenizeSelector(group), this));
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (splitSelectorGroups(selector).some((group) => matchesComplex(current, tokenizeSelector(group), current))) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const groups = splitSelectorGroups(selector).map(tokenizeSelector);
      const visit = (node) => {
        for (const child of node.children) {
          if (groups.some((tokens) => matchesComplex(child, tokens, this))) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    }

    scrollIntoView() {}
    scrollTo(_options) {}

    cloneNode(deep = false) {
      const clone = this.ownerDocument.createElement(this.localName);
      for (const [name, value] of this._attributes) clone.setAttribute(name, value);
      clone.value = this.value;
      clone.checked = this.checked;
      clone.disabled = this.disabled;
      if (deep) clone.append(...this.childNodes.map((node) => node.cloneNode(true)));
      return clone;
    }
  }

  class TestFragment extends TestElement {
    constructor(ownerDocument) {
      super('#document-fragment', ownerDocument);
      this.nodeType = 11;
      this.nodeName = '#document-fragment';
      this.localName = '#document-fragment';
    }
  }

  class TestTemplate extends TestElement {
    constructor(ownerDocument) {
      super('template', ownerDocument);
      this.content = new TestFragment(ownerDocument);
    }

    get innerHTML() {
      return this.content.textContent;
    }

    set innerHTML(value) {
      const fragment = parseHtml(value, this.ownerDocument);
      this.content.replaceChildren(...fragment.childNodes);
    }
  }

  class TestDocument {
    constructor() {
      this.activeElement = null;
      this.body = new TestElement('body', this);
      this.documentElement = new TestElement('html', this);
      this.documentElement.append(this.body);
    }

    createElement(tagName) {
      return String(tagName).toLowerCase() === 'template'
        ? new TestTemplate(this)
        : new TestElement(tagName, this);
    }

    createTextNode(value) {
      return new TestText(value, this);
    }

    createDocumentFragment() {
      return new TestFragment(this);
    }

    querySelector(selector) {
      if (this.documentElement.matches(selector)) return this.documentElement;
      return this.documentElement.querySelector(selector);
    }

    querySelectorAll(selector) {
      const matches = this.documentElement.matches(selector) ? [this.documentElement] : [];
      return matches.concat(this.documentElement.querySelectorAll(selector));
    }
  }

  const savedGlobals = new Map();
  for (const name of [
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'ResizeObserver',
    'MutationObserver',
  ]) {
    savedGlobals.set(name, Object.hasOwn(globalThis, name) ? globalThis[name] : undefined);
  }
  globalThis.document = new TestDocument();
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}
    takeRecords() { return []; }
    disconnect() {}
  };

  test.after(() => {
    for (const [name, value] of savedGlobals) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });

  const ownDiffKeys = ['path', 'status', 'added', 'removed'];
  const source = 'session-file-change';

  function file(path, status = 'M', added = 0, removed = 0) {
    return { path, status, added, removed };
  }

  function packetWith(changes, eventOverrides = {}) {
    return {
      sessionId: 'session-1',
      event: {
        type: 'tool_call',
        tool: 'fileChange',
        toolCallId: 'diff-1',
        payload: { changes },
        ...eventOverrides,
      },
    };
  }

  function activity(changes, eventOverrides = {}) {
    return sessionActivityEvent(packetWith(changes, eventOverrides), 'session-1');
  }

  function cards(root) {
    return root.querySelectorAll('[data-chat-diff-card]');
  }

  function descendantsIncluding(element) {
    return [element, ...element.querySelectorAll('*')];
  }

  function exactTextElements(element, expected) {
    return descendantsIncluding(element).filter((candidate) => candidate.textContent === expected);
  }

  function assertPresents(element, expected, field) {
    assert.ok(
      exactTextElements(element, expected).length > 0,
      `${field} must be presented as one exact canonical text value`,
    );
  }

  function assertDoesNotPresent(element, unexpected, field) {
    assert.equal(
      exactTextElements(element, unexpected).length,
      0,
      `${field} from the replaced card must be absent`,
    );
  }

  function assertCardFields(card, active, activeIndex, length) {
    assertPresents(card, chatDiffStatusText(active.status), 'status');
    assertPresents(card, chatDiffPathText(active.path), 'path');
    assertPresents(card, chatDiffAddedText(active.added), 'added count');
    assertPresents(card, chatDiffRemovedText(active.removed), 'removed count');
    assertPresents(card, chatDiffPositionText(activeIndex, length), 'position');
  }

  function mount(options = {}) {
    const root = buildChat({ title: 'fixture', seed: 0, ...options });
    assert.ok(root instanceof TestElement, 'buildChat must return a mounted root element');
    assert.equal(typeof root.addDiff, 'function', 'the armed public root must expose addDiff');
    return root;
  }

  function dispose(root) {
    if (typeof root.dispose === 'function') root.dispose();
    root.remove();
  }

  function addValid(root, values = {}) {
    const files = values.files ?? [file('src/default.js', 'M', 1, 1)];
    root.addDiff({ source, files, ...values });
    return files;
  }

  test('structured file changes are ordered exact records and never inferred from prose', () => {
    const changes = [
      file('src/first.js', 'added', 4, 0),
      file('src/second.js', 'modified', 7, 3),
      file('src/third.js', 'renamed', 0, 0),
    ];
    const row = activity(changes);

    assert.equal(row.kind, 'call');
    assert.equal(row.toolCallId, 'diff-1');
    assert.equal(row.tool, 'fileChange');
    assert.deepEqual(row.fileChanges, [
      file('src/first.js', 'A', 4, 0),
      file('src/second.js', 'M', 7, 3),
      file('src/third.js', 'R', 0, 0),
    ]);
    for (const normalized of row.fileChanges) {
      assert.deepEqual(Object.keys(normalized), ownDiffKeys);
      assert.deepEqual(Reflect.ownKeys(normalized), ownDiffKeys);
    }

    const proseRecord = file('src/prose-only.js', 'A', 9, 2);
    const prose = JSON.stringify(proseRecord);
    const proseRow = activity(undefined, {
      payload: { detail: prose, output: prose },
      output: prose,
    });
    assert.equal(proseRow.kind, 'call');
    assert.equal(proseRow.tool, 'fileChange');
    assert.equal(Object.hasOwn(proseRow, 'fileChanges'), false);

    assert.equal(sessionActivityEvent(packetWith(changes), 'session-2'), null);

    const otherRows = [
      sessionActivityEvent(packetWith(changes, { tool: 'shell' }), 'session-1'),
      sessionActivityEvent(packetWith(changes, { type: 'tool_result' }), 'session-1'),
    ];
    assert.equal(otherRows[0].kind, 'call');
    assert.equal(otherRows[0].tool, 'shell');
    assert.equal(otherRows[1].kind, 'result');
    assert.equal(otherRows[1].tool, 'fileChange');
    for (const otherRow of otherRows) assert.equal(Object.hasOwn(otherRow, 'fileChanges'), false);
  });

  test('every status alias normalizes and malformed members are dropped rather than repaired', () => {
    const aliases = [
      ['a', 'A'], ['AdD', 'A'], ['aDdEd', 'A'],
      ['m', 'M'], ['MoDiFy', 'M'], ['mOdIfIeD', 'M'],
      ['d', 'D'], ['DeLeTe', 'D'], ['dElEtEd', 'D'],
      ['r', 'R'], ['ReNaMe', 'R'], ['rEnAmEd', 'R'],
    ];
    const aliasRow = activity(aliases.map(([status], index) => file(`alias-${index}`, status, index, index)));
    assert.equal(aliasRow.fileChanges.length, aliases.length);
    aliasRow.fileChanges.forEach((normalized, index) => {
      assert.deepEqual(Object.keys(normalized), ownDiffKeys);
      assert.equal(normalized.status, aliases[index][1]);
      assert.equal(normalized.path, `alias-${index}`);
    });

    const zero = file('honest-zero', 'modified', 0, 0);
    const boundary = file('x'.repeat(4096), 'added', 0, 0);
    assert.deepEqual(activity([zero, boundary]).fileChanges, [
      file('honest-zero', 'M', 0, 0),
      file('x'.repeat(4096), 'A', 0, 0),
    ]);

    const missing = (key) => {
      const candidate = file(`missing-${key}`, 'M', 1, 1);
      delete candidate[key];
      return candidate;
    };
    const inheritedPath = Object.assign(Object.create({ path: 'inherited-path' }), {
      status: 'M', added: 1, removed: 1,
    });
    const rejected = [
      ['non-text path', file(42, 'M', 1, 1)],
      ['blank path', file(' \t\n', 'M', 1, 1)],
      ['overlong path', file('x'.repeat(4097), 'M', 1, 1)],
      ['unsupported status', file('copied', 'copied', 1, 1)],
      ['missing path', missing('path')],
      ['missing status', missing('status')],
      ['missing added', missing('added')],
      ['missing removed', missing('removed')],
      ['inherited path', inheritedPath],
      ['extra own key', { ...file('extra-key', 'M', 1, 1), extra: true }],
      ['added non-number', file('added-string', 'M', '1', 1)],
      ['removed non-number', file('removed-string', 'M', 1, '1')],
      ['added non-finite', file('added-infinite', 'M', Number.POSITIVE_INFINITY, 1)],
      ['removed non-finite', file('removed-nan', 'M', 1, Number.NaN)],
      ['added negative', file('added-negative', 'M', -1, 1)],
      ['removed negative', file('removed-negative', 'M', 1, -1)],
      ['added fractional', file('added-fractional', 'M', 0.5, 1)],
      ['removed fractional', file('removed-fractional', 'M', 1, 0.5)],
    ];

    // Mutation D2: default missing or invalid `added`/`removed` to zero; the
    // exact-key and invalid-member rejection cases turn red while honest zero
    // remains a positive control.
    for (const [name, candidate] of rejected) {
      const row = activity([zero, candidate]);
      assert.deepEqual(row.fileChanges, [file('honest-zero', 'M', 0, 0)], name);
    }
    const allRejected = activity(rejected.map(([, candidate]) => candidate));
    assert.equal(allRejected.kind, 'call');
    assert.equal(Object.hasOwn(allRejected, 'fileChanges'), false);
  });

  test('the active file, exact position, and complete Windows and POSIX paths are presented', () => {
    const opened = [];
    const root = mount({ onOpenDiff: (record) => opened.push(record) });
    const files = [
      file('src/first.js', 'A', 2, 0),
      file('src/second.js', 'M', 18, 4),
      file('src/third.js', 'D', 0, 7),
    ];
    root.addDiff({ source, files, activeIndex: 1 });
    assert.equal(cards(root).length, 1);

    // Mutation D1: replace the validated active index and length with constant
    // first-of-one; the second-of-three and one-of-one controls turn red.
    assertCardFields(cards(root)[0], files[1], 1, 3);

    const oneRoot = mount({ onOpenDiff: () => {} });
    const oneFile = file('src/only.js', 'R', 0, 0);
    oneRoot.addDiff({ source, files: [oneFile], activeIndex: 0 });
    assert.equal(cards(oneRoot).length, 1);
    assertCardFields(cards(oneRoot)[0], oneFile, 0, 1);

    const defaultRoot = mount({ onOpenDiff: () => {} });
    defaultRoot.addDiff({ source, files });
    assert.equal(cards(defaultRoot).length, 1);
    assertCardFields(cards(defaultRoot)[0], files[0], 0, files.length);

    // Mutation D5: normalize paths by splitting only on `/`; the Windows
    // exact-path fixture turns red.
    for (const exactPath of ['C:\\work\\src\\panel.js', '/workspace/src/panel.js']) {
      const pathRoot = mount({ onOpenDiff: () => {} });
      const exactFile = file(exactPath, 'M', 5, 2);
      pathRoot.addDiff({ source, files: [exactFile] });
      assert.equal(cards(pathRoot).length, 1);
      assert.equal(chatDiffPathText(exactPath), exactPath);
      assertPresents(cards(pathRoot)[0], chatDiffPathText(exactPath), 'complete path');
      dispose(pathRoot);
    }

    dispose(root);
    dispose(oneRoot);
    dispose(defaultRoot);
  });

  test('invalid indices, provenance, and file collections reject the whole candidate card', () => {
    const root = mount({ onOpenDiff: () => {} });
    const validFiles = [file('src/a.js', 'A', 1, 0), file('src/b.js', 'M', 2, 1)];
    addValid(root, { id: 'positive-control', files: validFiles, activeIndex: 0 });
    assert.equal(cards(root).length, 1);
    assertCardFields(cards(root)[0], validFiles[0], 0, validFiles.length);

    const invalidIndices = [
      ['negative', -1],
      ['fractional', 0.5],
      ['non-finite NaN', Number.NaN],
      ['non-finite infinity', Number.POSITIVE_INFINITY],
      ['non-number', '1'],
      ['out of range', validFiles.length],
    ];
    for (const [name, activeIndex] of invalidIndices) {
      root.addDiff({ source, id: `bad-index-${name}`, files: validFiles, activeIndex });
      assert.equal(cards(root).length, 1, name);
    }

    const invalidCandidates = [
      { source: 'other-source', id: 'wrong-source', files: validFiles },
      { source, id: 'non-array-null', files: null },
      { source, id: 'non-array-object', files: {} },
      { source, id: 'empty-files', files: [] },
      { source, id: 'all-invalid', files: [{ ...file('bad-extra', 'M', 1, 1), extra: true }] },
    ];
    for (const candidate of invalidCandidates) {
      root.addDiff(candidate);
      assert.equal(cards(root).length, 1, candidate.id);
    }
    dispose(root);
  });

  test('non-empty identities replace every field while missing identities append', () => {
    const root = mount({ onOpenDiff: () => {} });
    const firstFiles = [
      file('old/first.js', 'A', 31, 0),
      file('old/active.js', 'M', 32, 33),
    ];
    root.addDiff({ source, id: 'stable-identity', files: firstFiles, activeIndex: 1 });
    assert.equal(cards(root).length, 1);
    assertCardFields(cards(root)[0], firstFiles[1], 1, firstFiles.length);

    const replacementFiles = [
      file('new/active.js', 'D', 7, 41),
      file('new/second.js', 'R', 8, 42),
      file('new/third.js', 'A', 9, 43),
    ];
    root.addDiff({ source, id: 'stable-identity', files: replacementFiles, activeIndex: 0 });
    assert.equal(cards(root).length, 1);
    const replacement = cards(root)[0];
    assertCardFields(replacement, replacementFiles[0], 0, replacementFiles.length);
    assertDoesNotPresent(replacement, chatDiffStatusText(firstFiles[1].status), 'status');
    assertDoesNotPresent(replacement, chatDiffPathText(firstFiles[1].path), 'path');
    assertDoesNotPresent(replacement, chatDiffAddedText(firstFiles[1].added), 'added count');
    assertDoesNotPresent(replacement, chatDiffRemovedText(firstFiles[1].removed), 'removed count');
    assertDoesNotPresent(replacement, chatDiffPositionText(1, firstFiles.length), 'position');

    const appendRoot = mount({ onOpenDiff: () => {} });
    const equivalent = [file('src/equivalent.js', 'M', 3, 2)];
    appendRoot.addDiff({ source, files: equivalent });
    assert.equal(cards(appendRoot).length, 1);
    appendRoot.addDiff({ source, files: equivalent });
    assert.equal(cards(appendRoot).length, 2);
    for (const card of cards(appendRoot)) assertCardFields(card, equivalent[0], 0, 1);

    dispose(root);
    dispose(appendRoot);
  });

  test('each activation receives one fresh exact record and cannot mutate stored card data', () => {
    const received = [];
    const root = mount({ onOpenDiff: (record) => received.push(record) });
    const active = file('src/callback.js', 'R', 12, 6);
    root.addDiff({ source, files: [active] });
    assert.equal(cards(root).length, 1);
    const control = cards(root)[0].querySelector('[data-chat-open-diff]');
    assert.ok(control, 'the callback-enabled card must expose its activation control');
    assert.equal(control.textContent, CHAT_DIFF_OPEN_TEXT);
    assert.equal(control.getAttribute('aria-label'), chatDiffOpenLabel(active.path));

    control.click();
    assert.equal(received.length, 1);
    assert.notStrictEqual(received[0], active);
    assert.deepEqual(Object.keys(received[0]), [...ownDiffKeys, 'edits', 'patches', 'substringEdits', 'originalCapture', 'editsReversible', 'complete']);
    assert.deepEqual(received[0], { ...active, edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: false, complete: false });

    received[0].path = 'mutated-path';
    received[0].status = 'A';
    received[0].added = 999;
    received[0].removed = 999;
    received[0].extra = true;
    control.click();
    assert.equal(received.length, 2);
    assert.notStrictEqual(received[1], received[0]);
    assert.notStrictEqual(received[1], active);
    assert.deepEqual(Object.keys(received[1]), [...ownDiffKeys, 'edits', 'patches', 'substringEdits', 'originalCapture', 'editsReversible', 'complete']);
    assert.deepEqual(received[1], { ...active, edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: false, complete: false });
    assertCardFields(cards(root)[0], active, 0, 1);
    assert.equal(control.getAttribute('aria-label'), chatDiffOpenLabel(active.path));

    // Mutation D3: replace the open callback with a no-op or allocate a new
    // door per activation; callback counts and same-door evidence turn red.
    dispose(root);
  });

  test('the actual open handler reuses one door and preloads the selected session file', () => {
    const doorCalls = [];
    const door = {
      open(...argumentsReceived) {
        doorCalls.push({ receiver: this, argumentsReceived });
      },
    };
    const handler = createChatDiffOpenHandler(door);
    assert.equal(typeof handler, 'function');
    const root = mount({ onOpenDiff: handler });
    root.addDiff({ source, files: [file('src/door.js', 'M', 2, 2)] });
    assert.equal(cards(root).length, 1);
    const control = cards(root)[0].querySelector('[data-chat-open-diff]');
    assert.ok(control);

    control.click();
    control.click();
    assert.equal(doorCalls.length, 2);
    for (const call of doorCalls) {
      assert.strictEqual(call.receiver, door);
      assert.deepEqual(call.argumentsReceived, [{ ...file('src/door.js', 'M', 2, 2), edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: true, complete: false }]);
    }
    dispose(root);
  });

  test('metadata renders without a handler and the card never duplicates editor semantics', () => {
    const root = mount();
    const active = file('src/metadata-only.js', 'M', 10, 5);
    root.addDiff({ source, files: [active] });
    assert.equal(cards(root).length, 1);
    const card = cards(root)[0];
    assertCardFields(card, active, 0, 1);
    assert.equal(card.querySelector('[data-chat-open-diff]'), null);

    const withHandler = mount({ onOpenDiff: () => {} });
    withHandler.addDiff({ source, files: [active] });
    assert.equal(cards(withHandler).length, 1);
    const handlerCard = cards(withHandler)[0];
    const control = handlerCard.querySelector('[data-chat-open-diff]');
    assert.ok(control);
    assert.equal(control.textContent, CHAT_DIFF_OPEN_TEXT);
    assert.equal(control.getAttribute('aria-label'), chatDiffOpenLabel(active.path));

    // Mutation D4: append a local diff overlay or pane under the card;
    // semantic non-duplication assertions turn red.
    const semanticCategories = {
      'editor overlay': /(?:diff[-_ ]?editor|diff[-_ ]?overlay|editor[-_ ]?overlay)/i,
      'original or proposed pane': /(?:(?:original|proposed)[-_ ]?pane|diff[-_ ]?pane)/i,
      'file picker': /(?:file[-_ ]?picker|pick[-_ ]?file)/i,
      'save control': /(?:diff[-_ ]?save|save[-_ ]?diff)/i,
      'line-number gutter': /(?:line[-_ ]?number|line[-_ ]?gutter)/i,
      'unified-diff body': /(?:unified[-_ ]?diff|diff[-_ ]?body)/i,
    };
    const subtree = descendantsIncluding(handlerCard);
    assert.ok(subtree.length > 1, 'the exercised card subtree must exist before negative checks');
    for (const [category, pattern] of Object.entries(semanticCategories)) {
      const marked = subtree.filter((element) => element.attributeEntries().some(([name, value]) => (
        pattern.test(name) || pattern.test(value)
      )));
      assert.deepEqual(marked, [], `${category} must not exist under the card`);
    }
    const forbiddenTags = new Set(['input', 'textarea', 'select', 'pre', 'code']);
    assert.deepEqual(
      subtree.filter((element) => forbiddenTags.has(element.localName)),
      [],
      'file controls, editable text, and synthesized diff bodies must be absent',
    );
    assert.deepEqual(
      subtree.filter((element) => (
        element.getAttribute('contenteditable') === 'true'
        || element.getAttribute('role') === 'textbox'
        || element.getAttribute('role') === 'dialog'
      )),
      [],
      'editable regions and editor overlays must be absent',
    );
    assert.deepEqual(
      subtree.filter((element) => element.localName === 'button' && element !== control),
      [],
      'the card must not add picker or save buttons beside its one door control',
    );

    dispose(root);
    dispose(withHandler);
  });

  test('unknown-count edits restore visibly and mixed changes keep measured counts marked partial', () => {
    const unknown = { path: '/workspace/code.js', status: 'C', added: null, removed: null };
    const calls = [];
    const root = mount({ onOpenDiff: selected => calls.push(selected), history: [{ who: 'diff', source, id: 'unknown', files: [unknown] }] });
    assert.equal(cards(root).length, 1);
    assert.equal(cards(root)[0].querySelector('[data-chat-diff-additions]').textContent, 'Line counts unavailable, see the diff');
    root.querySelector('[data-changes-toggle]').click();
    let row = root.querySelector('[data-change-path]');
    assert.match(row.getAttribute('aria-label'), /line counts unavailable/);
    assert.equal(row.querySelector('.session-change-added').textContent, '—');
    assert.equal(row.querySelector('.session-change-removed').textContent, '—');
    row.click();
    assert.equal(calls[0].unmeasuredEdits, 1);
    assert.equal(calls[0].complete, false);
    root.addDiff({ source, id: 'known', files: [file(unknown.path, 'M', 7, 2)] });
    row = root.querySelector('[data-change-path]');
    assert.equal(row.querySelector('.session-change-added').textContent, '+7*');
    assert.equal(row.querySelector('.session-change-removed').textContent, '−2*');
    assert.match(root.querySelector('[data-changes-limit]').textContent, /Partial counts/);
    assert.match(row.getAttribute('aria-label'), /additional line counts unavailable/);
    dispose(root);
  });

  test('normalized live replacement restores exactly across fresh history mounts', () => {
    const initialActivity = activity([
      file('live/old-a.js', 'added', 1, 0),
      file('live/old-b.js', 'modified', 2, 1),
    ]);
    const restoredActivity = activity([
      file('restore/first.js', 'deleted', 0, 11),
      file('restore/active.js', 'renamed', 12, 3),
      file('restore/third.js', 'modified', 14, 4),
    ]);
    assert.equal(initialActivity.kind, 'call');
    assert.equal(restoredActivity.kind, 'call');
    const initialFiles = initialActivity.fileChanges;
    const files = restoredActivity.fileChanges;
    for (const normalized of [...initialFiles, ...files]) assert.deepEqual(Object.keys(normalized), ownDiffKeys);

    const id = 'restored-identity';
    const at = '2026-08-29T12:00:00.000Z';
    const activeIndex = 1;
    const liveReceived = [];
    const liveRoot = mount({ onOpenDiff: (record) => liveReceived.push(record) });
    liveRoot.addDiff({ source, id, at, files: initialFiles, activeIndex: 0 });
    assert.equal(cards(liveRoot).length, 1);
    assertCardFields(cards(liveRoot)[0], initialFiles[0], 0, initialFiles.length);
    liveRoot.addDiff({ source, id, at, files, activeIndex });
    assert.equal(cards(liveRoot).length, 1);
    assertCardFields(cards(liveRoot)[0], files[activeIndex], activeIndex, files.length);
    cards(liveRoot)[0].querySelector('[data-chat-open-diff]').click();
    assert.deepEqual(liveReceived, [{ ...files[activeIndex], edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: false, complete: false }]);
    assert.notStrictEqual(liveReceived[0], files[activeIndex]);
    dispose(liveRoot);

    const entry = { who: 'diff', source, id, at, files, activeIndex };
    const historyCalls = [];
    const firstHistory = mount({
      onOpenDiff: (record) => historyCalls.push(record),
      history: [entry],
    });
    assert.equal(cards(firstHistory).length, 1);
    assertCardFields(cards(firstHistory)[0], files[activeIndex], activeIndex, files.length);
    cards(firstHistory)[0].querySelector('[data-chat-open-diff]').click();
    assert.deepEqual(historyCalls, [{ ...files[activeIndex], edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: false, complete: false }]);
    assert.notStrictEqual(historyCalls[0], files[activeIndex]);
    dispose(firstHistory);

    const reopenCalls = [];
    const secondHistory = mount({
      onOpenDiff: (record) => reopenCalls.push(record),
      history: [entry],
    });
    assert.equal(cards(secondHistory).length, 1);
    assertCardFields(cards(secondHistory)[0], files[activeIndex], activeIndex, files.length);
    cards(secondHistory)[0].querySelector('[data-chat-open-diff]').click();
    assert.deepEqual(reopenCalls, [{ ...files[activeIndex], edits: 1, patches: [], substringEdits: [], originalCapture: null, editsReversible: false, complete: false }]);
    assert.notStrictEqual(reopenCalls[0], files[activeIndex]);

    // Mutation D6: omit the `who: 'diff'` history branch or route it around
    // ordinary validation/replacement; restoration/reopen or invalid-history
    // assertions turn red.
    const guardedHistory = mount({
      onOpenDiff: () => {},
      history: [
        entry,
        { ...entry, id: 'wrong-who', who: 'agent' },
        { ...entry, id: 'wrong-source', source: 'other-source' },
      ],
    });
    assert.equal(cards(guardedHistory).length, 1);
    assertCardFields(cards(guardedHistory)[0], files[activeIndex], activeIndex, files.length);

    dispose(secondHistory);
    dispose(guardedHistory);
  });
  /* T288. The card's path, status and position had no test evidence under
     their stable selectors, though the counts and the open control did. These
     are the three things a person reads to decide whether to open a diff at
     all: WHICH file, WHAT happened to it, and WHERE it sits among the others.
     Asserted through the selectors the card actually carries, so the coverage
     gate can see them and so a rename has to come here. */
  test('a diff card names the file, what happened to it, and where it sits', () => {
    const first = { path: '/workspace/alpha.js', status: 'M', added: 3, removed: 1 };
    const second = { path: '/workspace/beta.js', status: 'A', added: 9, removed: 0 };
    const root = mount({ history: [{ who: 'diff', source, id: 'named', files: [first, second] }] });
    const shown = cards(root);
    /* ONE CARD SHOWS ONE FILE AT A TIME out of the set, which is why it
       carries a position at all -- measured here rather than assumed: a first
       version of this case expected one card per file and got one card. */
    assert.equal(shown.length, 1, 'a change set is one card');

    const path = shown[0].querySelector('[data-chat-diff-path]');
    assert.ok(path, 'a card must say which file it is about');
    assert.equal(path.textContent, chatDiffPathText(first.path));

    const status = shown[0].querySelector('[data-chat-diff-status]');
    assert.ok(status, 'a card must say what happened to that file');
    assert.equal(status.textContent, chatDiffStatusText(first.status));

    const position = shown[0].querySelector('[data-chat-diff-position]');
    assert.ok(position, 'a card must say where this file sits among the changed files');
    assert.equal(position.textContent, chatDiffPositionText(0, 2), 'the first of two');
  });
}
