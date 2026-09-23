const componentsModule = await import('../../src/components.js');
const hasWorkingMetricsSeam = Object.hasOwn(
  componentsModule,
  'CHAT_WORKING_METRICS_SEAM',
);

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

if (!hasWorkingMetricsSeam) {
  test('chat working metrics wait for the public product seam', {
    skip: 'CHAT_WORKING_METRICS_SEAM is not shipped yet',
  }, () => {});
} else {
  const { buildChat } = componentsModule;
  const {
    createActionBuffer,
    normalizeChatPathIdentity,
    sessionActivityEvent,
  } = await import('../../src/agent-session-events.js');
  const {
    chatWorkingCountersLabel,
    chatWorkingCountersText,
  } = await import('../../src/chat-copy.js');

  const CALL_PACKET = {
    sessionId: 's-1',
    event: {
      type: 'tool_call',
      toolCallId: 'call-1',
      tool: 'shell',
      payload: { command: 'node --version' },
    },
  };

  const RESULT_PACKET = {
    sessionId: 's-1',
    event: {
      type: 'tool_result',
      toolCallId: 'call-1',
      tool: 'shell',
      payload: { exitCode: 0 },
    },
  };

  const FULL_COUNTERS = {
    snapshot: { tools: 3, files: 2, added: 64, removed: 12 },
    text: '3 tools · 2 files · +64 −12',
    label: '3 tools used, 2 files touched, 64 lines added, 12 lines removed',
  };

  const TOOLS_ONLY_COUNTERS = {
    snapshot: { tools: 2 },
    text: '2 tools',
    label: '2 tools used',
  };

  function shellCallPacket(toolCallId, command = 'node --version') {
    return {
      sessionId: 's-1',
      event: {
        type: 'tool_call',
        toolCallId,
        tool: 'shell',
        payload: { command },
      },
    };
  }

  function fileChangePacket(toolCallId, changes) {
    return {
      sessionId: 's-1',
      event: {
        type: 'tool_call',
        toolCallId,
        tool: 'fileChange',
        payload: { changes },
      },
    };
  }

  function adapt(packet) {
    return sessionActivityEvent(packet, 's-1');
  }

  function addPacket(buffer, packet, turnId, at) {
    const activity = adapt(packet);
    assert.notEqual(
      activity,
      null,
      'bad value: null would make the packet-to-activity integration proof vacuous',
    );
    return {
      activity,
      outcome: buffer.add(activity, { turnId, at }),
    };
  }

  function camelToDataAttribute(key) {
    return `data-${String(key).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
  }

  class TestNode {
    constructor(ownerDocument, nodeType) {
      this.ownerDocument = ownerDocument;
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
      this._listeners = new Map();
    }

    append(...values) {
      for (const value of values) {
        const node = value instanceof TestNode
          ? value
          : this.ownerDocument.createTextNode(String(value));
        this.appendChild(node);
      }
    }

    appendChild(node) {
      if (node.nodeType === 11) {
        for (const child of [...node.childNodes]) this.appendChild(child);
        return node;
      }
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }

    insertBefore(node, reference) {
      if (reference == null) return this.appendChild(node);
      const index = this.childNodes.indexOf(reference);
      if (index < 0) throw new Error('Reference node is not a child');
      node.remove();
      node.parentNode = this;
      this.childNodes.splice(index, 0, node);
      return node;
    }

    replaceChildren(...values) {
      for (const child of [...this.childNodes]) child.remove();
      this.append(...values);
    }

    replaceWith(...values) {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const index = parent.childNodes.indexOf(this);
      this.remove();
      let offset = 0;
      for (const value of values) {
        const node = value instanceof TestNode
          ? value
          : parent.ownerDocument.createTextNode(String(value));
        node.remove();
        node.parentNode = parent;
        parent.childNodes.splice(index + offset, 0, node);
        offset += 1;
      }
    }

    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.childNodes.indexOf(this);
      if (index >= 0) this.parentNode.childNodes.splice(index, 1);
      this.parentNode = null;
    }

    contains(node) {
      if (node === this) return true;
      return this.childNodes.some((child) => child.contains(node));
    }

    addEventListener(type, listener, options = undefined) {
      const records = this._listeners.get(type) ?? [];
      records.push({ listener, once: options === true ? false : Boolean(options?.once) });
      this._listeners.set(type, records);
      if (this.ownerDocument) this.ownerDocument.listenerAdds += 1;
    }

    removeEventListener(type, listener) {
      const records = this._listeners.get(type) ?? [];
      const next = records.filter((record) => record.listener !== listener);
      if (next.length !== records.length && this.ownerDocument) {
        this.ownerDocument.listenerRemovals += records.length - next.length;
      }
      this._listeners.set(type, next);
    }

    dispatchEvent(event) {
      if (!event.target) Object.defineProperty(event, 'target', { value: this });
      Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        value: this,
      });
      const records = [...(this._listeners.get(event.type) ?? [])];
      for (const record of records) {
        record.listener.call(this, event);
        if (record.once) this.removeEventListener(event.type, record.listener);
      }
      const propertyListener = this[`on${event.type}`];
      if (typeof propertyListener === 'function') propertyListener.call(this, event);
      if (event.bubbles && !event.cancelBubble && this.parentNode) {
        this.parentNode.dispatchEvent(event);
      }
      return !event.defaultPrevented;
    }

    get firstChild() {
      return this.childNodes[0] ?? null;
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    }

    get parentElement() {
      return this.parentNode?.nodeType === 1 ? this.parentNode : null;
    }

    get isConnected() {
      let current = this;
      while (current) {
        if (current.nodeType === 9) return true;
        current = current.parentNode;
      }
      return false;
    }

    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(value) {
      this.replaceChildren();
      if (value !== '' && value != null) {
        this.appendChild(this.ownerDocument.createTextNode(String(value)));
      }
    }
  }

  class TestText extends TestNode {
    constructor(ownerDocument, value) {
      super(ownerDocument, 3);
      this.data = String(value);
      this.nodeName = '#text';
    }

    contains(node) {
      return node === this;
    }

    get textContent() {
      return this.data;
    }

    set textContent(value) {
      this.data = String(value);
    }
  }

  class TestClassList {
    constructor(element) {
      this.element = element;
    }

    values() {
      return this.element.className.split(/\s+/u).filter(Boolean);
    }

    add(...tokens) {
      const values = new Set(this.values());
      for (const token of tokens) values.add(token);
      this.element.className = [...values].join(' ');
    }

    remove(...tokens) {
      const removed = new Set(tokens);
      this.element.className = this.values()
        .filter((token) => !removed.has(token))
        .join(' ');
    }

    toggle(token, force = undefined) {
      const present = this.contains(token);
      const next = force === undefined ? !present : Boolean(force);
      if (next) this.add(token);
      else this.remove(token);
      return next;
    }

    contains(token) {
      return this.values().includes(token);
    }

    toString() {
      return this.element.className;
    }
  }

  function parseSelectorList(selector) {
    const selectors = [];
    let current = '';
    let depth = 0;
    for (const character of String(selector)) {
      if (character === '[' || character === '(') depth += 1;
      if (character === ']' || character === ')') depth -= 1;
      if (character === ',' && depth === 0) {
        selectors.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    if (current.trim()) selectors.push(current.trim());
    return selectors;
  }

  function selectorTokens(selector) {
    const tokens = [];
    let current = '';
    let depth = 0;
    for (const character of selector.trim()) {
      if (character === '[' || character === '(') depth += 1;
      if (character === ']' || character === ')') depth -= 1;
      if (/\s/u.test(character) && depth === 0) {
        if (current) tokens.push(current);
        current = '';
      } else {
        current += character;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function matchesCompound(element, selector) {
    let remaining = selector.trim();
    const notSelectors = [];
    remaining = remaining.replace(/:not\(([^)]+)\)/gu, (_match, inner) => {
      notSelectors.push(inner);
      return '';
    });
    if (notSelectors.some((inner) => matchesCompound(element, inner))) return false;

    const tag = remaining.match(/^[a-zA-Z][\w-]*|^\*/u)?.[0];
    if (tag && tag !== '*' && element.tagName.toLowerCase() !== tag.toLowerCase()) {
      return false;
    }

    for (const id of remaining.matchAll(/#([\w-]+)/gu)) {
      if (element.id !== id[1]) return false;
    }
    for (const className of remaining.matchAll(/\.([\w-]+)/gu)) {
      if (!element.classList.contains(className[1])) return false;
    }
    for (const attribute of remaining.matchAll(
      /\[([\w:-]+)(?:\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/gu,
    )) {
      const [, name, operator, doubleQuoted, singleQuoted, bare] = attribute;
      if (!element.hasAttribute(name)) return false;
      if (!operator) continue;
      const expected = doubleQuoted ?? singleQuoted ?? bare ?? '';
      const actual = element.getAttribute(name) ?? '';
      if (operator === '=' && actual !== expected) return false;
      if (operator === '^=' && !actual.startsWith(expected)) return false;
      if (operator === '$=' && !actual.endsWith(expected)) return false;
      if (operator === '*=' && !actual.includes(expected)) return false;
      if (operator === '~=' && !actual.split(/\s+/u).includes(expected)) return false;
      if (operator === '|=' && actual !== expected && !actual.startsWith(`${expected}-`)) {
        return false;
      }
    }
    return true;
  }

  function matchesSelector(element, selector) {
    return parseSelectorList(selector).some((part) => {
      const tokens = selectorTokens(part);
      if (tokens.length === 0 || !matchesCompound(element, tokens.at(-1))) return false;
      let ancestor = element.parentElement;
      for (let index = tokens.length - 2; index >= 0; index -= 1) {
        while (ancestor && !matchesCompound(ancestor, tokens[index])) {
          ancestor = ancestor.parentElement;
        }
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  class TestElement extends TestNode {
    constructor(ownerDocument, tagName) {
      super(ownerDocument, 1);
      this.tagName = String(tagName).toUpperCase();
      this.nodeName = this.tagName;
      this.attributes = new Map();
      this.classList = new TestClassList(this);
      this.style = {
        cssText: '',
        removeProperty: (name) => {
          const old = this.style[name] ?? '';
          delete this.style[name];
          return old;
        },
        setProperty: (name, value) => {
          this.style[name] = String(value);
        },
      };
      this.dataset = new Proxy({}, {
        get: (_target, key) => this.getAttribute(camelToDataAttribute(key)) ?? undefined,
        set: (_target, key, value) => {
          this.setAttribute(camelToDataAttribute(key), value);
          return true;
        },
        deleteProperty: (_target, key) => {
          this.removeAttribute(camelToDataAttribute(key));
          return true;
        },
      });
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this._rawInnerHtml = '';
    }

    setAttribute(name, value) {
      this.attributes.set(String(name).toLowerCase(), String(value));
    }

    getAttribute(name) {
      return this.attributes.get(String(name).toLowerCase()) ?? null;
    }

    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }

    removeAttribute(name) {
      this.attributes.delete(String(name).toLowerCase());
    }

    toggleAttribute(name, force = undefined) {
      const next = force === undefined ? !this.hasAttribute(name) : Boolean(force);
      if (next) this.setAttribute(name, '');
      else this.removeAttribute(name);
      return next;
    }

    get className() {
      return this.getAttribute('class') ?? '';
    }

    set className(value) {
      if (value == null || value === '') this.removeAttribute('class');
      else this.setAttribute('class', value);
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

    get title() {
      return this.getAttribute('title') ?? '';
    }

    set title(value) {
      this.setAttribute('title', value);
    }

    get type() {
      return this.getAttribute('type') ?? '';
    }

    set type(value) {
      this.setAttribute('type', value);
    }

    get name() {
      return this.getAttribute('name') ?? '';
    }

    set name(value) {
      this.setAttribute('name', value);
    }

    get placeholder() {
      return this.getAttribute('placeholder') ?? '';
    }

    set placeholder(value) {
      this.setAttribute('placeholder', value);
    }

    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1);
    }

    get childElementCount() {
      return this.children.length;
    }

    get firstElementChild() {
      return this.children[0] ?? null;
    }

    get lastElementChild() {
      return this.children.at(-1) ?? null;
    }

    get previousElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) - 1] ?? null;
    }

    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    matches(selector) {
      return matchesSelector(this, selector);
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 1) {
            if (child.matches(selector)) matches.push(child);
            visit(child);
          }
        }
      };
      visit(this);
      return matches;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    insertAdjacentElement(position, element) {
      if (position === 'beforeend') return this.appendChild(element);
      if (position === 'afterbegin') return this.insertBefore(element, this.firstChild);
      if (position === 'beforebegin') {
        if (!this.parentNode) return null;
        return this.parentNode.insertBefore(element, this);
      }
      if (position === 'afterend') {
        if (!this.parentNode) return null;
        return this.parentNode.insertBefore(element, this.nextElementSibling);
      }
      throw new Error(`Unsupported position: ${position}`);
    }

    click() {
      this.dispatchEvent(new TestEvent('click', { bubbles: true }));
    }

    focus() {
      this.ownerDocument.activeElement = this;
      this.dispatchEvent(new TestEvent('focus'));
    }

    blur() {
      if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
      this.dispatchEvent(new TestEvent('blur'));
    }

    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }

    scrollTo(optionsOrX, y = undefined) {
      if (typeof optionsOrX === 'object') {
        this.scrollLeft = optionsOrX.left ?? this.scrollLeft;
        this.scrollTop = optionsOrX.top ?? this.scrollTop;
      } else {
        this.scrollLeft = optionsOrX;
        this.scrollTop = y ?? this.scrollTop;
      }
    }

    getBoundingClientRect() {
      return {
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
      };
    }

    get innerHTML() {
      return this._rawInnerHtml;
    }

    set innerHTML(value) {
      this.replaceChildren();
      this._rawInnerHtml = String(value);
    }

    appendChild(node) {
      this._rawInnerHtml = '';
      return super.appendChild(node);
    }
  }

  class TestFragment extends TestNode {
    constructor(ownerDocument) {
      super(ownerDocument, 11);
      this.nodeName = '#document-fragment';
    }

    querySelectorAll(selector) {
      const wrapper = new TestElement(this.ownerDocument, 'fragment-root');
      for (const child of [...this.childNodes]) wrapper.appendChild(child);
      const found = wrapper.querySelectorAll(selector);
      for (const child of [...wrapper.childNodes]) this.appendChild(child);
      return found;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1);
    }

    get firstElementChild() {
      return this.children[0] ?? null;
    }

    get lastElementChild() {
      return this.children.at(-1) ?? null;
    }
  }

  function decodeHtml(value) {
    return String(value)
      .replace(/&nbsp;/gu, '\u00a0')
      .replace(/&middot;/gu, '·')
      .replace(/&minus;/gu, '−')
      .replace(/&times;/gu, '×')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&#39;|&apos;/gu, "'")
      .replace(/&#(\d+);/gu, (_match, digits) => String.fromCodePoint(Number(digits)))
      .replace(/&#x([\da-f]+);/gui, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
      .replace(/&amp;/gu, '&');
  }

  function parseHtmlInto(parent, html) {
    parent.replaceChildren();
    const stack = [parent];
    const voidTags = new Set([
      'area',
      'base',
      'br',
      'col',
      'embed',
      'hr',
      'img',
      'input',
      'link',
      'meta',
      'param',
      'source',
      'track',
      'wbr',
    ]);
    const tokens = String(html).match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/gu) ?? [];
    for (const token of tokens) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (token.startsWith('<')) {
        const match = token.match(/^<([\w:-]+)([\s\S]*?)(\/?)>$/u);
        if (!match) continue;
        const [, tagName, rawAttributes, slash] = match;
        const element = parent.ownerDocument.createElement(tagName);
        for (const attribute of rawAttributes.matchAll(
          /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
        )) {
          const [, name, doubleQuoted, singleQuoted, bare] = attribute;
          element.setAttribute(
            name,
            decodeHtml(doubleQuoted ?? singleQuoted ?? bare ?? ''),
          );
        }
        stack.at(-1).appendChild(element);
        if (slash !== '/' && !voidTags.has(tagName.toLowerCase())) stack.push(element);
        continue;
      }
      stack.at(-1).appendChild(parent.ownerDocument.createTextNode(decodeHtml(token)));
    }
  }

  class TestTemplate extends TestElement {
    constructor(ownerDocument) {
      super(ownerDocument, 'template');
      this.content = new TestFragment(ownerDocument);
    }

    get innerHTML() {
      return this._rawInnerHtml;
    }

    set innerHTML(value) {
      this._rawInnerHtml = String(value);
      parseHtmlInto(this.content, value);
    }
  }

  class TestEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
      this.cancelable = Boolean(options.cancelable);
      this.defaultPrevented = false;
      this.cancelBubble = false;
      this.detail = options.detail;
      this.key = options.key;
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }

    stopPropagation() {
      this.cancelBubble = true;
    }
  }

  class TestDocument extends TestNode {
    constructor() {
      super(null, 9);
      this.ownerDocument = this;
      this.nodeName = '#document';
      this.listenerAdds = 0;
      this.listenerRemovals = 0;
      this.mutationObserverDisconnects = 0;
      this.resizeObserverDisconnects = 0;
      this.activeElement = null;
      this.documentElement = new TestElement(this, 'html');
      this.head = new TestElement(this, 'head');
      this.body = new TestElement(this, 'body');
      this.documentElement.append(this.head, this.body);
      this.appendChild(this.documentElement);
      this.defaultView = null;
    }

    createElement(tagName) {
      if (String(tagName).toLowerCase() === 'template') return new TestTemplate(this);
      return new TestElement(this, tagName);
    }

    createElementNS(_namespace, tagName) {
      return this.createElement(tagName);
    }

    createTextNode(value) {
      return new TestText(this, value);
    }

    createDocumentFragment() {
      return new TestFragment(this);
    }

    getElementById(id) {
      return this.querySelector(`#${id}`);
    }

    querySelectorAll(selector) {
      const matches = [];
      if (this.documentElement.matches(selector)) matches.push(this.documentElement);
      return matches.concat(this.documentElement.querySelectorAll(selector));
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  function installTestDom() {
    const document = new TestDocument();
    const windowListeners = new Map();
    const window = {
      document,
      location: { hash: '', href: 'https://fixture.invalid/' },
      matchMedia: () => ({
        addEventListener() {},
        matches: false,
        removeEventListener() {},
      }),
      addEventListener(type, listener) {
        const listeners = windowListeners.get(type) ?? [];
        listeners.push(listener);
        windowListeners.set(type, listeners);
        document.listenerAdds += 1;
      },
      removeEventListener(type, listener) {
        const listeners = windowListeners.get(type) ?? [];
        const next = listeners.filter((item) => item !== listener);
        document.listenerRemovals += listeners.length - next.length;
        windowListeners.set(type, next);
      },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
    };
    document.defaultView = window;
    class TestResizeObserver {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
      }

      observe(target) {
        this.targets.add(target);
      }

      unobserve(target) {
        this.targets.delete(target);
      }

      disconnect() {
        this.targets.clear();
        document.resizeObserverDisconnects += 1;
      }
    }
    class TestMutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.targets = new Set();
      }

      observe(target) {
        this.targets.add(target);
      }

      takeRecords() {
        return [];
      }

      disconnect() {
        this.targets.clear();
        document.mutationObserverDisconnects += 1;
      }
    }
    let animationFrameId = 0;
    const globals = {
      CSS: { escape: (value) => String(value) },
      CustomEvent: TestEvent,
      Element: TestElement,
      Event: TestEvent,
      HTMLElement: TestElement,
      MutationObserver: TestMutationObserver,
      Node: TestNode,
      ResizeObserver: TestResizeObserver,
      cancelAnimationFrame() {},
      document,
      getComputedStyle: window.getComputedStyle,
      requestAnimationFrame: () => {
        animationFrameId += 1;
        return animationFrameId;
      },
      window,
    };
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value,
        writable: true,
      });
    }
    return document;
  }

  function createStatusHarness(initialSnapshot = {}, options = {}) {
    let metricState = { type: 'value', value: initialSnapshot };
    let listener = null;
    let metricsReads = 0;
    let subscribeCalls = 0;
    let disposerCalls = 0;

    const status = {
      busy() {
        return true;
      },
      step() {
        return 'Test-owned current step';
      },
      metrics() {
        metricsReads += 1;
        if (metricState.type === 'throw') throw metricState.error;
        return metricState.value;
      },
      subscribe(nextListener) {
        subscribeCalls += 1;
        listener = nextListener;
        if (options.subscribeThrows) {
          nextListener();
          throw new Error('test-owned subscribe failure');
        }
        if (options.nonFunctionSubscription) {
          nextListener();
          return { dispose: false };
        }
        return () => {
          disposerCalls += 1;
          if (options.disposerThrows) throw new Error('test-owned disposer failure');
        };
      },
    };

    return {
      status,
      get disposerCalls() {
        return disposerCalls;
      },
      get listener() {
        return listener;
      },
      get metricsReads() {
        return metricsReads;
      },
      get subscribeCalls() {
        return subscribeCalls;
      },
      notify() {
        assert.equal(
          typeof listener,
          'function',
          'bad value: a missing listener would make a provider notification vacuous',
        );
        listener();
      },
      setSnapshot(snapshot) {
        metricState = { type: 'value', value: snapshot };
      },
      setThrowingMetrics() {
        metricState = {
          type: 'throw',
          error: new Error('test-owned metrics failure'),
        };
      },
    };
  }

  function mountStatus(status) {
    const document = installTestDom();
    const root = buildChat({ title: 'fixture', seed: 0, status, onStop: () => ({ ok: true }) });
    document.body.appendChild(root);
    return { document, root };
  }

  function assertRealWorkingRow(root) {
    const row = root.querySelector('.working-step');
    assert.ok(
      row,
      'bad value: null would show the real working row was replaced by counters',
    );
    assert.equal(
      row.textContent.includes('Test-owned current step'),
      true,
      'bad value: false would show the real non-empty step was removed',
    );
    const cancel = row.querySelectorAll('button')
      .find((button) => button.textContent.trim() === 'Cancel');
    assert.ok(
      cancel,
      'bad value: no Cancel button would show the real control was removed',
    );
    return { cancel, row };
  }

  function counterGroups(root) {
    return root.querySelectorAll('[data-chat-working-counters]');
  }

  function assertPinnedCounter(root, snapshot, expectedText, expectedLabel) {
    assert.equal(
      chatWorkingCountersText(snapshot),
      expectedText,
      `bad value: a formatter drift such as "${expectedText}-changed" must fail`,
    );
    assert.equal(
      chatWorkingCountersLabel(snapshot),
      expectedLabel,
      `bad value: an accessible-copy drift such as "${expectedLabel}-changed" must fail`,
    );
    const groups = counterGroups(root);
    assert.equal(
      groups.length,
      1,
      'bad value: zero or two groups would expose missing or duplicate rendering',
    );
    assert.equal(
      groups[0].textContent,
      expectedText,
      `bad value: stale DOM text such as "${expectedText} · 9 files" must fail`,
    );
    assert.equal(
      groups[0].getAttribute('aria-label'),
      expectedLabel,
      `bad value: a stale accessible label such as "${expectedLabel}, 9 files touched" must fail`,
    );
    return groups[0];
  }

  function assertNoCounterGroup(root, badValue) {
    assert.equal(
      counterGroups(root).length,
      0,
      `bad value: ${badValue} would leave an empty or stale counter group`,
    );
  }

  test('counter copy follows the pinned admission and vocabulary contract', () => {
    const cases = [
      {
        snapshot: { tools: 3, files: 2, added: 64, removed: 12 },
        text: '3 tools · 2 files · +64 −12',
        label: '3 tools used, 2 files touched, 64 lines added, 12 lines removed',
      },
      {
        snapshot: { tools: 1, files: 1, added: 64 },
        text: '1 tool · 1 file · +64',
        label: '1 tool used, 1 file touched, 64 lines added',
      },
      { snapshot: { tools: 2 }, text: '2 tools', label: '2 tools used' },
      { snapshot: { removed: 5 }, text: '−5', label: '5 lines removed' },
      { snapshot: {}, text: '', label: '' },
      { snapshot: null, text: '', label: '' },
      { snapshot: [], text: '', label: '' },
      { snapshot: { tools: -1 }, text: '', label: '' },
      { snapshot: { tools: 2.5 }, text: '', label: '' },
      { snapshot: { tools: Number.NaN }, text: '', label: '' },
      {
        snapshot: { tools: 1, files: null, added: -1, removed: 2.5 },
        text: '1 tool',
        label: '1 tool used',
      },
      {
        snapshot: { tools: 0, files: 0, added: 0, removed: 0 },
        text: '0 tools · 0 files · +0 −0',
        label: '0 tools used, 0 files touched, 0 lines added, 0 lines removed',
      },
    ];

    for (const { snapshot, text, label } of cases) {
      assert.equal(
        chatWorkingCountersText(snapshot),
        text,
        `bad value: formatter text other than pinned ${JSON.stringify(text)} must fail`,
      );
      assert.equal(
        chatWorkingCountersLabel(snapshot),
        label,
        `bad value: formatter label other than pinned ${JSON.stringify(label)} must fail`,
      );
    }
  });

  test('tool calls count once across results and exact replays', () => {
    const buffer = createActionBuffer({ platform: 'win32' });
    const callActivity = adapt(CALL_PACKET);
    const resultActivity = adapt(RESULT_PACKET);
    assert.notEqual(
      callActivity,
      null,
      'bad value: null would hide a call-adapter failure',
    );
    assert.notEqual(
      resultActivity,
      null,
      'bad value: null would hide a result-adapter failure',
    );
    assert.equal(
      callActivity.kind,
      'call',
      'bad value: result would not prove the call path was exercised',
    );
    assert.equal(
      resultActivity.kind,
      'result',
      'bad value: call would not prove the matching result path was exercised',
    );
    assert.equal(
      Object.hasOwn(callActivity, 'fileChanges'),
      false,
      'bad value: a fileChanges field on an ordinary shell call would violate adapter ownership',
    );

    buffer.add(callActivity, { turnId: 't-1', at: 1_000 });
    buffer.add(resultActivity, { turnId: 't-1', at: 1_040 });

    // W1 — result double-count: a bad reducer reports {tools:2} here.
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 1 },
      'bad value: {tools:2} would count the matching result as another tool',
    );

    buffer.add(callActivity, { turnId: 't-1', at: 1_100 });
    buffer.add(resultActivity, { turnId: 't-1', at: 1_140 });

    // W2 — call replay double-count: a bad reducer reports {tools:2} after replay.
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 1 },
      'bad value: {tools:2} would count an exact call replay twice',
    );

    const second = addPacket(
      buffer,
      shellCallPacket('call-2', 'node --help'),
      't-1',
      1_200,
    );
    assert.equal(
      second.activity.kind,
      'call',
      'bad value: result would not prove the new call path was admitted',
    );
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 2 },
      'bad value: {tools:1} would suppress a distinct non-empty call id',
    );
  });

  test('file events add deltas once and new events can revisit a file', () => {
    const twoFileBuffer = createActionBuffer({ platform: 'win32' });
    const twoFileChanges = [
      { path: 'src/alpha.js', status: 'M', added: 7, removed: 2 },
      { path: 'src/beta.js', status: 'A', added: 5, removed: 1 },
    ];
    const twoFile = addPacket(
      twoFileBuffer,
      fileChangePacket('change-1', twoFileChanges),
      't-files',
      2_000,
    );
    assert.deepEqual(
      twoFile.activity.fileChanges,
      twoFileChanges,
      'bad value: a reordered or rewritten fileChanges array would break the exact adapter fixture',
    );
    assert.deepEqual(
      twoFileBuffer.metrics('t-files'),
      { tools: 1, files: 2, added: 12, removed: 3 },
      'bad value: {tools:1,files:2,added:7,removed:2} would miss the second event delta',
    );

    const aliasBuffer = createActionBuffer({ platform: 'win32' });
    const aliasChanges = [
      { path: 'C:\\Work\\src\\A.js', status: 'M', added: 4, removed: 1 },
      { path: 'c:/work/src/a.js', status: 'M', added: 90, removed: 80 },
    ];
    const aliases = addPacket(
      aliasBuffer,
      fileChangePacket('alias-1', aliasChanges),
      't-alias',
      2_100,
    );
    assert.deepEqual(
      aliases.activity.fileChanges,
      aliasChanges,
      'bad value: one missing alias would make first-member dedupe untested',
    );
    assert.deepEqual(
      aliasBuffer.metrics('t-alias'),
      { tools: 1, files: 1, added: 4, removed: 1 },
      'bad value: {tools:1,files:2,added:94,removed:81} would count both aliases',
    );

    const sameReplay = addPacket(
      aliasBuffer,
      fileChangePacket('alias-1', aliasChanges),
      't-alias',
      2_200,
    );
    assert.equal(
      sameReplay.activity.kind,
      'call',
      'bad value: null or result would make the same-delta replay proof vacuous',
    );
    assert.deepEqual(
      aliasBuffer.metrics('t-alias'),
      { tools: 1, files: 1, added: 4, removed: 1 },
      'bad value: {tools:2,files:1,added:8,removed:2} would inflate an exact event replay',
    );

    const changedReplay = addPacket(
      aliasBuffer,
      fileChangePacket('alias-1', [
        { path: 'C:/Work/src/A.js', status: 'M', added: 400, removed: 300 },
      ]),
      't-alias',
      2_300,
    );
    assert.equal(
      changedReplay.activity.kind,
      'call',
      'bad value: null or result would make the changed-delta replay proof vacuous',
    );

    // W4 — event replay delta inflation: changed replay numbers must not replace or add.
    assert.deepEqual(
      aliasBuffer.metrics('t-alias'),
      { tools: 1, files: 1, added: 4, removed: 1 },
      'bad value: added:404 or added:400 would expose replay delta inflation',
    );

    const newEvent = addPacket(
      aliasBuffer,
      fileChangePacket('alias-2', [
        { path: 'c:/work/src/A.js', status: 'M', added: 3, removed: 2 },
      ]),
      't-alias',
      2_400,
    );
    assert.equal(
      newEvent.activity.kind,
      'call',
      'bad value: null or result would make the new-event proof vacuous',
    );

    // W5 — snapshot mistake: a new event's deltas survive prior file identity dedupe.
    assert.deepEqual(
      aliasBuffer.metrics('t-alias'),
      { tools: 2, files: 1, added: 7, removed: 3 },
      'bad value: {tools:2,files:1,added:4,removed:1} would suppress new event deltas',
    );
  });

  test('path identity is platform-aware and root-safe', () => {
    const windowsBackslash = normalizeChatPathIdentity(
      'C:\\Work\\.\\src\\A.js',
      'win32',
    );
    const windowsSlash = normalizeChatPathIdentity('c:/work/src/A.js', 'win32');
    assert.notEqual(
      windowsBackslash,
      null,
      'bad value: null would reject a rooted Windows path before comparison',
    );
    assert.notEqual(
      windowsSlash,
      null,
      'bad value: null would reject a slash-form Windows path before comparison',
    );

    // W3 — platform identity drift: Windows aliases match, other-platform case does not.
    assert.equal(
      windowsBackslash,
      windowsSlash,
      'bad value: differently cased identities would split Windows aliases',
    );

    const otherUpper = normalizeChatPathIdentity('C:\\Work\\src\\A.js', 'linux');
    const otherLower = normalizeChatPathIdentity('c:/work/src/A.js', 'linux');
    assert.notEqual(
      otherUpper,
      null,
      'bad value: null would reject the first non-Windows comparison path',
    );
    assert.notEqual(
      otherLower,
      null,
      'bad value: null would reject the second non-Windows comparison path',
    );
    assert.notEqual(
      otherUpper,
      otherLower,
      'bad value: equal lowercased identities would erase non-Windows case',
    );

    const resolved = normalizeChatPathIdentity(
      'C:\\Work\\src\\..\\lib\\A.js',
      'win32',
    );
    const direct = normalizeChatPathIdentity('c:/work/lib/a.js', 'win32');
    assert.notEqual(
      resolved,
      null,
      'bad value: null would reject an in-root parent resolution',
    );
    assert.equal(
      resolved,
      direct,
      'bad value: an identity retaining a dot-dot segment would miss lexical resolution',
    );
    assert.equal(
      normalizeChatPathIdentity('C:\\..\\escape.js', 'win32'),
      null,
      'bad value: c:/escape.js would allow dot-dot to cross the detected root',
    );
  });

  test('invalid identities add no dimensions while valid calls remain observable', () => {
    const emptyBuffer = createActionBuffer({ platform: 'win32' });
    const blankCall = adapt(shellCallPacket(''));
    assert.notEqual(
      blankCall,
      null,
      'bad value: null would make the blank-call-id reducer proof vacuous',
    );
    emptyBuffer.add(blankCall, { turnId: 't-invalid', at: 3_000 });
    assert.deepEqual(
      emptyBuffer.metrics('t-invalid'),
      {},
      'bad value: {tools:1} would admit a blank call id',
    );

    const missingCall = adapt(shellCallPacket(undefined));
    assert.notEqual(
      missingCall,
      null,
      'bad value: null would make the missing-call-id reducer proof vacuous',
    );
    emptyBuffer.add(missingCall, { turnId: 't-invalid', at: 3_010 });
    assert.deepEqual(
      emptyBuffer.metrics('t-invalid'),
      {},
      'bad value: {tools:1} would admit a missing call id',
    );

    const missingTurn = adapt(shellCallPacket('missing-turn'));
    assert.notEqual(
      missingTurn,
      null,
      'bad value: null would make the missing-turn reducer proof vacuous',
    );
    emptyBuffer.add(missingTurn, { at: 3_020 });
    assert.deepEqual(
      emptyBuffer.metrics(undefined),
      {},
      'bad value: {tools:1} would admit a missing turn under an undefined key',
    );
    assert.deepEqual(
      emptyBuffer.metrics('t-invalid'),
      {},
      'bad value: {tools:1} would let a missing turn leak into another turn',
    );

    const blankTurn = adapt(shellCallPacket('blank-turn'));
    assert.notEqual(
      blankTurn,
      null,
      'bad value: null would make the blank-turn reducer proof vacuous',
    );
    emptyBuffer.add(blankTurn, { turnId: '', at: 3_030 });
    assert.deepEqual(
      emptyBuffer.metrics(''),
      {},
      'bad value: {tools:1} would admit a blank turn id',
    );

    const resultOnly = adapt({
      sessionId: 's-1',
      event: {
        type: 'tool_result',
        toolCallId: 'result-only',
        tool: 'shell',
        payload: { exitCode: 0 },
      },
    });
    assert.notEqual(
      resultOnly,
      null,
      'bad value: null would make the result-only reducer proof vacuous',
    );
    assert.equal(
      resultOnly.kind,
      'result',
      'bad value: call would fail to exercise a result-only row',
    );
    emptyBuffer.add(resultOnly, { turnId: 't-invalid', at: 3_040 });
    assert.deepEqual(
      emptyBuffer.metrics('t-invalid'),
      {},
      'bad value: {tools:1} would count a result-only row',
    );

    const invalidBuffer = createActionBuffer({ platform: 'win32' });
    const invalidChanges = [
      'not-an-array',
      [{ path: ' ', status: 'M', added: 3, removed: 2 }],
      [{ path: 'src/non-finite.js', status: 'M', added: Number.NaN, removed: 2 }],
      [{ path: 'src/negative.js', status: 'M', added: 2, removed: -1 }],
      [{ path: 'src/fraction.js', status: 'M', added: 2.5, removed: 1 }],
    ];

    for (const [index, changes] of invalidChanges.entries()) {
      const driven = addPacket(
        invalidBuffer,
        fileChangePacket(`invalid-${index}`, changes),
        't-malformed',
        3_100 + index,
      );
      assert.equal(
        driven.activity.kind,
        'call',
        'bad value: result would not prove the malformed real call was exercised',
      );
      assert.deepEqual(
        invalidBuffer.metrics('t-malformed'),
        { tools: index + 1 },
        `bad value: files:1 or a line key would admit malformed change ${index}`,
      );
    }

    const zeroLine = addPacket(
      invalidBuffer,
      fileChangePacket('zero-line', [
        { path: 'src/zero.js', status: 'M', added: 0, removed: 0 },
      ]),
      't-malformed',
      3_200,
    );
    assert.deepEqual(
      zeroLine.activity.fileChanges,
      [{ path: 'src/zero.js', status: 'M', added: 0, removed: 0 }],
      'bad value: no fileChanges record would make the zero-line proof vacuous',
    );
    const zeroMetrics = invalidBuffer.metrics('t-malformed');
    assert.deepEqual(
      zeroMetrics,
      { tools: 6, files: 1 },
      'bad value: added:0 or removed:0 would expose zero-filled reducer output',
    );
    assert.equal(
      Object.hasOwn(zeroMetrics, 'added'),
      false,
      'bad value: true would expose a zero added key',
    );
    assert.equal(
      Object.hasOwn(zeroMetrics, 'removed'),
      false,
      'bad value: true would expose a zero removed key',
    );
  });

  test('metrics survive display bounds', () => {
    const buffer = createActionBuffer({
      maxPerSession: 1,
      maxPerTurn: 1,
      platform: 'win32',
    });
    const outcomes = [];
    for (let index = 0; index < 5; index += 1) {
      const driven = addPacket(
        buffer,
        shellCallPacket(`bounded-${index}`, `command-${index}`),
        't-bounded',
        4_000 + index,
      );
      assert.equal(
        driven.activity.kind,
        'call',
        'bad value: result would not prove a bounded real call was exercised',
      );
      outcomes.push(driven.outcome);
    }
    assert.ok(
      outcomes.some((outcome) => outcome.change === 'folded'),
      'bad value: no folded outcome would leave the tiny row cap unexercised',
    );

    // W8 — reset/bounds leak: bounded display rows must not cap live metrics.
    assert.deepEqual(
      buffer.metrics('t-bounded'),
      { tools: 5 },
      'bad value: {tools:1} would derive metrics from the retained display row',
    );
  });

  test('public clear methods clear dedupe identities at exact scope', () => {
    const buffer = createActionBuffer({ platform: 'win32' });
    const turnOnePacket = fileChangePacket('clear-1', [
      { path: 'C:\\Work\\src\\A.js', status: 'M', added: 5, removed: 2 },
    ]);
    const turnTwoPacket = fileChangePacket('clear-2', [
      { path: 'src/other.js', status: 'M', added: 3, removed: 1 },
    ]);

    addPacket(buffer, turnOnePacket, 't-1', 5_000);
    addPacket(buffer, turnTwoPacket, 't-2', 5_010);
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 1, files: 1, added: 5, removed: 2 },
      'bad value: {} would make the exact-turn clear proof vacuous',
    );
    assert.deepEqual(
      buffer.metrics('t-2'),
      { tools: 1, files: 1, added: 3, removed: 1 },
      'bad value: {} would make the untouched-turn proof vacuous',
    );

    buffer.clearMetrics('t-1');
    assert.deepEqual(
      buffer.metrics('t-1'),
      {},
      'bad value: retained tools:1 would leak a cleared turn',
    );
    assert.deepEqual(
      buffer.metrics('t-2'),
      { tools: 1, files: 1, added: 3, removed: 1 },
      'bad value: {} would let exact-turn clear erase another turn',
    );

    addPacket(buffer, turnOnePacket, 't-1', 5_100);
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 1, files: 1, added: 5, removed: 2 },
      'bad value: {} would retain cleared tool/file/delta dedupe keys',
    );
    assert.deepEqual(
      buffer.metrics('t-2'),
      { tools: 1, files: 1, added: 3, removed: 1 },
      'bad value: tools:2 would mutate the untouched turn during re-add',
    );

    buffer.resetMetrics();

    // W8 — reset/bounds leak: reset empties both snapshots and their dedupe keys.
    assert.deepEqual(
      buffer.metrics('t-1'),
      {},
      'bad value: retained tools:1 would leak t-1 through reset',
    );
    assert.deepEqual(
      buffer.metrics('t-2'),
      {},
      'bad value: retained tools:1 would leak t-2 through reset',
    );

    addPacket(buffer, turnOnePacket, 't-1', 5_200);
    addPacket(buffer, turnTwoPacket, 't-2', 5_210);
    assert.deepEqual(
      buffer.metrics('t-1'),
      { tools: 1, files: 1, added: 5, removed: 2 },
      'bad value: {} would show reset kept t-1 dedupe identities',
    );
    assert.deepEqual(
      buffer.metrics('t-2'),
      { tools: 1, files: 1, added: 3, removed: 1 },
      'bad value: {} would show reset kept t-2 dedupe identities',
    );
  });

  test('the real working row starts without zero or empty counters', () => {
    const harness = createStatusHarness({});
    const { root } = mountStatus(harness.status);
    try {
      assertRealWorkingRow(root);
      assert.equal(
        harness.subscribeCalls,
        1,
        'bad value: 0 would leave the live subscription path unexercised',
      );

      // W6 — zero/default rendering: no data means no counter group.
      assertNoCounterGroup(root, 'one zero-filled group');
    } finally {
      root.dispose();
    }
  });

  test('positive counter snapshots repaint by whole replacement', () => {
    const harness = createStatusHarness({});
    const { root } = mountStatus(harness.status);
    try {
      assertRealWorkingRow(root);
      assertNoCounterGroup(root, 'one initial empty group');

      harness.setSnapshot(FULL_COUNTERS.snapshot);
      harness.notify();
      const fullGroup = assertPinnedCounter(
        root,
        FULL_COUNTERS.snapshot,
        FULL_COUNTERS.text,
        FULL_COUNTERS.label,
      );

      harness.setSnapshot(TOOLS_ONLY_COUNTERS.snapshot);
      harness.notify();
      const toolsGroup = assertPinnedCounter(
        root,
        TOOLS_ONLY_COUNTERS.snapshot,
        TOOLS_ONLY_COUNTERS.text,
        TOOLS_ONLY_COUNTERS.label,
      );

      // W7 — patch/stale provider: the smaller whole snapshot removes stale segments.
      assert.equal(
        toolsGroup,
        fullGroup,
        'bad value: a different node would replace rather than repaint the one group',
      );
      assert.equal(
        toolsGroup.textContent.includes('files'),
        false,
        'bad value: true would retain the old file segment after whole replacement',
      );
      assert.equal(
        toolsGroup.textContent.includes('+64'),
        false,
        'bad value: true would retain the old line segment after whole replacement',
      );
      assertRealWorkingRow(root);
    } finally {
      root.dispose();
    }
  });

  test('the DOM mirrors every positive pinned worked example', () => {
    const harness = createStatusHarness({});
    const { root } = mountStatus(harness.status);
    const cases = [
      FULL_COUNTERS,
      {
        snapshot: { tools: 1, files: 1, added: 64 },
        text: '1 tool · 1 file · +64',
        label: '1 tool used, 1 file touched, 64 lines added',
      },
      TOOLS_ONLY_COUNTERS,
      {
        snapshot: { removed: 5 },
        text: '−5',
        label: '5 lines removed',
      },
    ];
    try {
      assertRealWorkingRow(root);
      for (const { snapshot, text, label } of cases) {
        harness.setSnapshot(snapshot);
        harness.notify();
        assertPinnedCounter(root, snapshot, text, label);
      }
    } finally {
      root.dispose();
    }
  });

  test('failed absent invalid and zero providers remove prior counters', () => {
    const harness = createStatusHarness(FULL_COUNTERS.snapshot);
    const { root } = mountStatus(harness.status);
    try {
      assertRealWorkingRow(root);
      assertPinnedCounter(
        root,
        FULL_COUNTERS.snapshot,
        FULL_COUNTERS.text,
        FULL_COUNTERS.label,
      );

      const negativeStates = [
        { name: 'null', value: null, text: '', label: '' },
        { name: 'array', value: [], text: '', label: '' },
        {
          name: 'non-finite',
          value: { tools: Number.POSITIVE_INFINITY },
          text: '',
          label: '',
        },
        { name: 'negative', value: { tools: -1 }, text: '', label: '' },
        { name: 'non-integer', value: { tools: 2.5 }, text: '', label: '' },
        {
          name: 'zero',
          value: { tools: 0, files: 0, added: 0, removed: 0 },
          text: '0 tools · 0 files · +0 −0',
          label: '0 tools used, 0 files touched, 0 lines added, 0 lines removed',
        },
        { name: 'empty', value: {}, text: '', label: '' },
      ];

      harness.setThrowingMetrics();
      harness.notify();
      assertRealWorkingRow(root);
      assertNoCounterGroup(root, 'stale full counters after a thrown read');

      for (const { name, value, text, label } of negativeStates) {
        harness.setSnapshot(FULL_COUNTERS.snapshot);
        harness.notify();
        assertPinnedCounter(
          root,
          FULL_COUNTERS.snapshot,
          FULL_COUNTERS.text,
          FULL_COUNTERS.label,
        );

        assert.equal(
          chatWorkingCountersText(value),
          text,
          `bad value: unpinned formatter text would hide the ${name} provider boundary`,
        );
        assert.equal(
          chatWorkingCountersLabel(value),
          label,
          `bad value: unpinned formatter label would hide the ${name} provider boundary`,
        );

        harness.setSnapshot(value);
        harness.notify();
        assertRealWorkingRow(root);

        // W6/W7 — invalid, zero, or failed whole reads remove rather than merge.
        assertNoCounterGroup(root, `stale full counters after ${name}`);
      }
    } finally {
      root.dispose();
    }
  });

  test('a broken subscription suppresses counters without an uncaught UI error', () => {
    for (const options of [
      { name: 'throwing subscribe', subscribeThrows: true },
      { name: 'non-function subscribe result', nonFunctionSubscription: true },
    ]) {
      const harness = createStatusHarness(FULL_COUNTERS.snapshot, options);
      const positiveRead = harness.status.metrics();
      assert.equal(
        chatWorkingCountersText(positiveRead),
        FULL_COUNTERS.text,
        `bad value: empty text would make the ${options.name} provider non-positive`,
      );
      assert.equal(
        chatWorkingCountersLabel(positiveRead),
        FULL_COUNTERS.label,
        `bad value: empty label would make the ${options.name} provider non-positive`,
      );
      let mounted;
      assert.doesNotThrow(
        () => {
          mounted = mountStatus(harness.status);
        },
        `bad value: an uncaught ${options.name} error would escape buildChat`,
      );
      const { root } = mounted;
      try {
        assertRealWorkingRow(root);
        assert.ok(
          harness.metricsReads > 0,
          `bad value: 0 reads would make the ${options.name} positive provider vacuous`,
        );
        assert.equal(
          harness.subscribeCalls,
          1,
          `bad value: 0 calls would leave ${options.name} unexercised`,
        );
        assertNoCounterGroup(root, `positive counters after ${options.name}`);
      } finally {
        root.dispose();
      }
    }
  });

  test('dispose is idempotent and blocks later provider repaint', () => {
    const harness = createStatusHarness(FULL_COUNTERS.snapshot);
    const { root } = mountStatus(harness.status);
    assertRealWorkingRow(root);
    assertPinnedCounter(
      root,
      FULL_COUNTERS.snapshot,
      FULL_COUNTERS.text,
      FULL_COUNTERS.label,
    );
    assert.equal(
      typeof harness.listener,
      'function',
      'bad value: undefined would leave the live subscription unexercised',
    );

    root.dispose();
    root.dispose();

    // W7 — patch/stale provider: the provider disposer must run exactly once.
    assert.equal(
      harness.disposerCalls,
      1,
      'bad value: 0 or 2 would expose omitted or duplicate provider disposal',
    );

    const before = counterGroups(root).map((group) => ({
      label: group.getAttribute('aria-label'),
      text: group.textContent,
    }));
    harness.setSnapshot({ tools: 99, files: 88, added: 77, removed: 66 });
    assert.doesNotThrow(
      () => harness.listener(),
      'bad value: a post-dispose notification error would escape the UI',
    );
    const after = counterGroups(root).map((group) => ({
      label: group.getAttribute('aria-label'),
      text: group.textContent,
    }));
    assert.deepEqual(
      after,
      before,
      'bad value: 99 tools would show a post-dispose repaint',
    );
    assert.ok(
      after.length <= 1,
      'bad value: 2 groups would show a post-dispose duplicate',
    );
  });

  test('a throwing provider disposer does not stop other chat cleanup', () => {
    const harness = createStatusHarness(FULL_COUNTERS.snapshot, {
      disposerThrows: true,
    });
    const { document, root } = mountStatus(harness.status);
    assertRealWorkingRow(root);
    assertPinnedCounter(
      root,
      FULL_COUNTERS.snapshot,
      FULL_COUNTERS.text,
      FULL_COUNTERS.label,
    );
    assert.ok(
      document.listenerAdds > 0,
      'bad value: 0 listener adds would make listener cleanup unobservable',
    );
    const removalsBefore = document.listenerRemovals;

    assert.doesNotThrow(
      () => root.dispose(),
      'bad value: the test-owned disposer error would escape root.dispose',
    );
    assert.equal(
      harness.disposerCalls,
      1,
      'bad value: 0 would show the throwing provider disposer was never exercised',
    );
    assert.ok(
      document.listenerRemovals > removalsBefore,
      'bad value: unchanged listener removals would show later chat cleanup stopped',
    );

    const before = counterGroups(root).map((group) => group.textContent);
    harness.setSnapshot({ tools: 99 });
    assert.doesNotThrow(
      () => harness.listener(),
      'bad value: a stale listener error would escape after throwing disposal',
    );
    assert.deepEqual(
      counterGroups(root).map((group) => group.textContent),
      before,
      'bad value: 99 tools would show cleanup failed after a throwing disposer',
    );
  });
}
