import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate as defer } from 'node:timers/promises'
import { test } from 'node:test'

import {
  applyOwnerPopupTheme,
  createOwnerPromptController,
  formatExactAmount,
  normalizeOwnerPromptSnapshot,
  purchaseDecisionBody,
  renderOwnerPrompt,
} from '../../src/owner-popup.js'
import {
  decideOwnerPrompt,
  markOwnerPromptPresented,
  ownerPromptSnapshot,
  resetBridgeSession,
} from '../../src/mission-bridge.js'

function themeManifest() {
  const palette = suffix => ({
    bg: `color-bg-${suffix}`, bg2: `color-bg2-${suffix}`, surface: `color-surface-${suffix}`,
    sheet: `color-sheet-${suffix}`, ink: `color-ink-${suffix}`, ink2: `color-ink2-${suffix}`,
    ink25: `color-ink25-${suffix}`, ink3: `color-ink3-${suffix}`, line: `color-line-${suffix}`,
    line2: `color-line2-${suffix}`, good: `color-good-${suffix}`, serious: `color-serious-${suffix}`,
  })
  return {
    schemaVersion: 1,
    defaultTheme: 'white',
    fonts: { ui: 'Fixture UI', mono: 'Fixture Mono', nativeUiFamilies: ['Fixture UI'], nativeMonoFamilies: ['Fixture Mono'] },
    metrics: { radiusSmall: 2, radiusMedium: 3, radiusLarge: 3, space1: 4, space2: 8, space3: 12, space4: 16, space5: 24 },
    common: { accent: 'color-accent', accentFloor: 'color-accent-floor', focus: 'color-focus', onAccent: 'color-on-accent' },
    roles: { coordinator: 'color-coordinator', helper: 'color-helper', shadow: 'color-shadow', manager: 'color-manager' },
    themes: { white: palette('white'), tan: palette('tan'), black: palette('black') },
  }
}

function purchasePrompt() {
  return {
    id: 'owner-prompt-sample-1',
    kind: 'purchase_batch',
    title: 'Review this shopping list',
    message: 'Each line is decided independently.',
    createdAt: '2026-08-09T08:00:00.000Z',
    expiresAt: '2026-08-09T08:15:00.000Z',
    state: 'pending',
    defaultDecision: 'deny',
    items: [
      { id: 'line-tools', description: 'Developer tool license', amountCents: 973, currency: 'USD', merchant: 'Example Tools', purpose: 'Build verification' },
      { id: 'line-data', description: 'Test dataset', amountCents: 425, currency: 'USD', merchant: 'Example Data', purpose: 'Regression coverage' },
    ],
    totalCents: 1398,
    currency: 'USD',
  }
}

function snapshot(prompt = purchasePrompt()) {
  return {
    ok: true,
    schemaVersion: 1,
    generatedAt: '2026-08-09T08:00:01.000Z',
    theme: themeManifest(),
    prompts: [prompt],
  }
}

class FakeStyle {
  constructor() { this.values = new Map() }
  setProperty(name, value) { this.values.set(name, value) }
  getPropertyValue(name) { return this.values.get(name) || '' }
}

class FakeElement {
  constructor(documentRef, tagName) {
    this.ownerDocument = documentRef
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = new FakeStyle()
    this.className = ''
    this.disabled = false
    this.tabIndex = 0
    this.offsetParent = {}
    this.listeners = new Map()
    this._text = ''
    this._connected = false
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this._text = String(value); this.children = [] }
  set innerHTML(value) {
    this._text = ''
    this.children = []
    for (const match of String(value).matchAll(/<\s*(img|script)\b[^>]*>/gi)) {
      this.append(this.ownerDocument.createElement(match[1]))
    }
  }
  get isConnected() { return this._connected || Boolean(this.parentNode?.isConnected) }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
  }
  appendChild(node) { this.append(node); return node }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) {
    const enabled = force === undefined ? !this.hasAttribute(name) : Boolean(force)
    if (enabled) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return enabled
  }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }
  dispatch(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event) }
  click() { if (!this.disabled) this.dispatch('click', { target: this }) }
  focus() { this.ownerDocument.activeElement = this }
  contains(node) {
    if (node === this) return true
    return this.children.some(child => child.contains(node))
  }
  remove() {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
  getBoundingClientRect() {
    return this.isConnected
      ? { width: 820, height: 620, top: 20, left: 20, right: 840, bottom: 640 }
      : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  }
  querySelectorAll(selector) {
    const all = walk(this).slice(1)
    if (selector.includes('button')) return all.filter(node => node.tagName === 'BUTTON')
    return []
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement(this, 'html')
    this.documentElement.dataset.theme = 'tan'
    this.documentElement._connected = true
    this.body = new FakeElement(this, 'body')
    this.body._connected = true
    this.mount = new FakeElement(this, 'div')
    this.mount._connected = true
    this.stage = new FakeElement(this, 'main')
    this.stage._connected = true
    this.drawer = new FakeElement(this, 'aside')
    this.drawer._connected = true
    this.drawerButton = new FakeElement(this, 'button')
    this.drawer.append(this.drawerButton)
    this.header = new FakeElement(this, 'header')
    this.header._connected = true
    this.initialFocus = new FakeElement(this, 'button')
    this.initialFocus._connected = true
    this.activeElement = this.initialFocus
    this.focused = true
    this.listeners = new Map()
    this.defaultView = null
  }
  createElement(tagName) { return new FakeElement(this, tagName) }
  getElementById(id) {
    if (id === 'owner-popup-root') return this.mount
    if (id === 'stage') return this.stage
    if (id === 'drawer') return this.drawer
    return null
  }
  querySelector(selector) { return selector === 'header.topbar' ? this.header : null }
  hasFocus() { return this.focused }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry !== listener))
  }
  dispatch(name, event) { for (const listener of this.listeners.get(name) || []) listener(event) }
}

class FakeWindow {
  constructor(documentRef) {
    this.document = documentRef
    this.listeners = new Map()
    this.nextTimer = 1
  }
  requestAnimationFrame(callback) { queueMicrotask(() => callback(0)); return 1 }
  setInterval() { return this.nextTimer++ }
  clearInterval() {}
  getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' } }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(listener)
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry !== listener))
  }
  dispatch(name) { for (const listener of this.listeners.get(name) || []) listener() }
}

function walk(root) {
  return [root, ...root.children.flatMap(walk)]
}

function setupDom() {
  const documentRef = new FakeDocument()
  const windowRef = new FakeWindow(documentRef)
  documentRef.defaultView = windowRef
  return { documentRef, windowRef }
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await defer()
}

test('strict snapshot accepts the canonical shared theme and public prompt kinds only', () => {
  const normalized = normalizeOwnerPromptSnapshot(snapshot())
  assert.equal(normalized.prompts[0].items[0].merchant, 'Example Tools')
  assert.equal(normalized.theme.common.accent, 'color-accent')

  const credentialLike = { ...purchasePrompt(), kind: 'credential', fields: [{ id: 'card_number' }] }
  assert.throws(() => normalizeOwnerPromptSnapshot(snapshot(credentialLike)), /malformed/)
  assert.throws(() => normalizeOwnerPromptSnapshot(snapshot({ ...purchasePrompt(), cardNumber: 'not-accepted-here' })), /malformed/)

  const notice = {
    id: 'notice-1', kind: 'notice', title: 'Complete', message: 'The task completed.',
    createdAt: '2026-08-09T08:00:00.000Z', expiresAt: '2026-08-09T08:15:00.000Z',
    state: 'presented', defaultDecision: 'acknowledge',
  }
  assert.equal(normalizeOwnerPromptSnapshot(snapshot(notice)).prompts[0].defaultDecision, 'acknowledge')
})

test('runtime theme properties come from the manifest common and selected-theme roles', () => {
  const { documentRef } = setupDom()
  const selected = applyOwnerPopupTheme(documentRef.mount, themeManifest(), 'black')
  assert.equal(selected, 'black')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-bg'), 'color-bg-black')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-accent'), 'color-accent')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-accent-floor'), 'color-accent-floor')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-on-accent'), 'color-on-accent')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-font-ui'), 'var(--font-ui)')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-font-mono'), 'var(--font-mono)')
  assert.equal(documentRef.mount.style.getPropertyValue('--op-space5'), '24px')
})

test('credential surfaces spend the shared colour, radius, spacing, motion, type, and elevation registers', () => {
  const ownerCss = readFileSync(new URL('../../src/owner-popup.css', import.meta.url), 'utf8')
  const approvalsCss = readFileSync(new URL('../../src/ledger-prompt-queue.css', import.meta.url), 'utf8')
  const settingsCss = readFileSync(new URL('../../src/settings.css', import.meta.url), 'utf8')
  const connectCss = readFileSync(new URL('../../src/connect-computer-settings.css', import.meta.url), 'utf8')

  assert.doesNotMatch(`${ownerCss}\n${approvalsCss}`, /#[0-9a-f]{3,8}\b|rgba?\(/i,
    'credential styles must not carry a private palette')
  assert.doesNotMatch(`${ownerCss}\n${approvalsCss}`, /border-radius\s*:\s*\d+px/i,
    'credential radii must come from the shared radius register')
  assert.doesNotMatch(ownerCss, /(?:padding|padding-inline|padding-block|margin|gap)\s*:[^;]*\b\d+px/i,
    'credential spacing must come from the shared spacing register')
  assert.match(ownerCss, /\.owner-popup-dialog\s*\{[^}]*box-shadow:\s*var\(--elev-3\)/s)
  assert.doesNotMatch(ownerCss, /var\(--(?:dur-[123]|track-caps)\s*,/,
    'motion and caps tracking must not carry stale literal fallbacks')
  assert.match(settingsCss, /\[data-account-section\] code\s*\{\s*font-family:\s*var\(--font-mono\)/)
  assert.match(connectCss, /\.connect-note\s*\{[^}]*font-weight:\s*500/s)
})

test('shopping-list DOM renders exact amounts, merchant, purpose, total, and visible default deny', () => {
  const { documentRef } = setupDom()
  const prompt = normalizeOwnerPromptSnapshot(snapshot()).prompts[0]
  const submissions = []
  const rendered = renderOwnerPrompt(documentRef, prompt, { dismiss() {}, submit(value) { submissions.push(value) } })
  documentRef.mount.append(rendered.overlay)
  const text = rendered.dialog.textContent
  assert.match(text, /Developer tool license/)
  assert.match(text, /Each line is decided independently/)
  assert.match(text, /\$9\.73/)
  assert.match(text, /Example Tools/)
  assert.match(text, /Build verification/)
  assert.match(text, /\$13\.98/)
  assert.match(text, /Any line left undecided is denied/)
  assert.match(text, /Closing this window denies every line/)

  const rows = walk(rendered.dialog).filter(node => node.className === 'owner-popup-item')
  assert.deepEqual(rows.map(row => row.dataset.decision), ['undecided', 'undecided'])
  const buttons = walk(rendered.dialog).filter(node => node.tagName === 'BUTTON')
  const deny = buttons.find(button => button.textContent === 'Deny')
  const submit = buttons.find(button => button.textContent === 'Submit decisions')
  for (const control of rendered.gatedControls) control.disabled = false
  deny.click()
  submit.click()
  assert.equal(rows[0].dataset.decision, 'denied')
  assert.equal(rows[1].dataset.decision, 'undecided')
  assert.deepEqual(submissions, [{
    promptId: prompt.id,
    decision: 'submit',
    itemDecisions: [{ itemId: 'line-tools', decision: 'deny' }],
  }])
})

test('decision payload deliberately omits undecided lines for backend default-deny materialization', () => {
  const prompt = normalizeOwnerPromptSnapshot(snapshot()).prompts[0]
  const decisions = new Map([['line-tools', 'approve']])
  assert.deepEqual(purchaseDecisionBody(prompt, decisions), {
    promptId: prompt.id,
    decision: 'submit',
    itemDecisions: [{ itemId: 'line-tools', decision: 'approve' }],
  })
  assert.equal(formatExactAmount(1398, 'USD'), '$13.98')
  assert.equal(formatExactAmount(973, 'JPY'), '¥973')
})

test('confirmation and notice DOM use the same popup and emit only their bounded decisions', () => {
  const base = {
    id: 'public-prompt-1', title: 'Confirm change', message: 'Apply the requested change?',
    createdAt: '2026-08-09T08:00:00.000Z', expiresAt: '2026-08-09T08:15:00.000Z', state: 'pending',
  }
  for (const [kind, defaultDecision, buttonLabel, expectedDecision] of [
    ['confirmation', 'deny', 'Deny', 'deny'],
    ['notice', 'acknowledge', 'Acknowledge', 'acknowledge'],
  ]) {
    const prompt = normalizeOwnerPromptSnapshot(snapshot({ ...base, kind, defaultDecision })).prompts[0]
    const { documentRef } = setupDom()
    const submitted = []
    const rendered = renderOwnerPrompt(documentRef, prompt, { dismiss() {}, submit(body) { submitted.push(body) } })
    const button = walk(rendered.dialog).find(node => node.tagName === 'BUTTON' && node.textContent === buttonLabel)
    button.disabled = false
    button.click()
    assert.deepEqual(submitted, [{ promptId: 'public-prompt-1', decision: expectedDecision }])
  }
})

test('controller acknowledges only after the dialog is mounted, visible, and focused', async () => {
  const { documentRef, windowRef } = setupDom()
  const evidenceSeen = []
  const controller = createOwnerPromptController({
    documentRef,
    windowRef,
    readSnapshot: async () => snapshot(),
    markPresented: async (promptId, evidence) => {
      evidenceSeen.push({ promptId, evidence, inDom: documentRef.mount.children.length === 1, focused: documentRef.activeElement.tagName === 'BUTTON' })
      return { ok: true }
    },
    submitDecision: async () => ({ ok: true }),
  })
  await controller.poll()
  await settle()
  assert.deepEqual(evidenceSeen, [{
    promptId: 'owner-prompt-sample-1',
    evidence: { mounted: true, visible: true, focused: true },
    inDom: true,
    focused: true,
  }])
  assert.equal(documentRef.header.hasAttribute('inert'), true)
  assert.equal(documentRef.stage.hasAttribute('inert'), true)
  assert.equal(documentRef.drawerButton.hasAttribute('inert'), true)
  controller.destroy()
  assert.equal(documentRef.header.hasAttribute('inert'), false)
  assert.equal(documentRef.drawerButton.hasAttribute('inert'), false)
  assert.equal(documentRef.activeElement, documentRef.initialFocus)
})

test('an unfocused window sends no presentation acknowledgement until it gains focus', async () => {
  const { documentRef, windowRef } = setupDom()
  documentRef.focused = false
  let acknowledgements = 0
  const controller = createOwnerPromptController({
    documentRef,
    windowRef,
    readSnapshot: async () => snapshot(),
    markPresented: async () => { acknowledgements += 1; return { ok: true } },
    submitDecision: async () => ({ ok: true }),
  })
  await controller.poll()
  await settle()
  assert.equal(acknowledgements, 0)
  assert.match(documentRef.mount.textContent, /Until then, the action is refused/)
  documentRef.focused = true
  windowRef.dispatch('focus')
  await settle()
  assert.equal(acknowledgements, 1)
  controller.destroy()
})

test('closing a presented shopping list submits no line choices, so every line defaults to deny', async () => {
  const { documentRef, windowRef } = setupDom()
  const submissions = []
  const controller = createOwnerPromptController({
    documentRef,
    windowRef,
    readSnapshot: async () => snapshot(),
    markPresented: async () => ({ ok: true }),
    submitDecision: async body => { submissions.push(body); return { ok: true } },
  })
  await controller.poll()
  await settle()
  const close = walk(documentRef.mount).find(node => node.getAttribute('aria-label') === 'Close and refuse')
  close.click()
  await settle()
  assert.deepEqual(submissions, [{
    promptId: 'owner-prompt-sample-1', decision: 'submit', itemDecisions: [],
  }])
  assert.equal(controller.currentPromptId(), null)
  controller.destroy()
})

test('presentation and decision transport failures stay visible and fail closed', async t => {
  await t.test('presentation rejection never enables decisions', async () => {
    const { documentRef, windowRef } = setupDom()
    const controller = createOwnerPromptController({
      documentRef,
      windowRef,
      readSnapshot: async () => snapshot(),
      markPresented: async () => { throw new Error('offline') },
      submitDecision: async () => assert.fail('decision must remain disabled'),
    })
    await controller.poll()
    await settle()
    assert.match(documentRef.mount.textContent, /Presentation could not be confirmed\. No action was approved\./)
    const decisionControls = walk(documentRef.mount).filter(node => node.tagName === 'BUTTON' && ['Approve', 'Deny', 'Submit decisions'].includes(node.textContent))
    assert.ok(decisionControls.every(node => node.disabled))
    controller.destroy()
  })

  await t.test('decision rejection never closes as success', async () => {
    const { documentRef, windowRef } = setupDom()
    const controller = createOwnerPromptController({
      documentRef,
      windowRef,
      readSnapshot: async () => snapshot(),
      markPresented: async () => ({ ok: true }),
      submitDecision: async () => { throw new Error('offline') },
    })
    await controller.poll()
    await settle()
    const buttons = walk(documentRef.mount).filter(node => node.tagName === 'BUTTON')
    buttons.find(button => button.textContent === 'Submit decisions').click()
    await settle()
    assert.match(documentRef.mount.textContent, /Decision delivery could not be confirmed/)
    assert.equal(controller.currentPromptId(), 'owner-prompt-sample-1')
    controller.destroy()
  })
})

test('owner strings render as inert text rather than HTML elements', () => {
  const hostile = { ...purchasePrompt(), title: '<img src=x onerror=alert(1)>', message: '<script>bad()</script>' }
  const prompt = normalizeOwnerPromptSnapshot(snapshot(hostile)).prompts[0]
  const { documentRef } = setupDom()
  const rendered = renderOwnerPrompt(documentRef, prompt, { dismiss() {}, submit() {} })
  assert.equal(
    walk(rendered.dialog).some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'),
    false,
    'owner strings must render as inert text, never HTML elements',
  )
  assert.match(rendered.dialog.textContent, /<img src=x onerror=alert\(1\)>/)
})

test('authenticated bridge adapter uses the bounded owner-prompt read and action routes', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const proof = 'owner-popup-shell-proof-fixture'.padEnd(43, '0')
  const calls = []
  resetBridgeSession()
  globalThis.window = {
    /* hostname is required since the public-origin gate: ?bridge= is the
       developer override and it is only honoured on a loopback page -- on any
       other origin the gate refuses before the query string is read, which is
       the point of the gate. This fixture describes the desktop renderer,
       served from http://127.0.0.1:<port> (shell/main.cjs, shellOrigin). */
    location: { search: '?bridge=http%3A%2F%2F127.0.0.1%3A4610', hostname: '127.0.0.1' },
    mcShell: { getBridgeProof: async () => ({ ok: true, proof }) },
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/v1/bootstrap')) return { ok: true, status: 200, json: async () => ({ ok: true, token: 'owner-popup-bearer' }) }
    if (String(url).endsWith('/v1/owner-prompts')) return { ok: true, status: 200, json: async () => snapshot() }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  try {
    assert.equal((await ownerPromptSnapshot()).ok, true)
    assert.equal((await markOwnerPromptPresented('prompt-1', { mounted: true, visible: true, focused: true })).ok, true)
    assert.equal((await decideOwnerPrompt({ promptId: 'prompt-1', decision: 'deny' })).ok, true)
    assert.deepEqual(calls.map(call => call.url), [
      `http://127.0.0.1:4610/v1/bootstrap?proof=${proof}`,
      'http://127.0.0.1:4610/v1/owner-prompts',
      'http://127.0.0.1:4610/v1/actions/owner-prompt-presented',
      'http://127.0.0.1:4610/v1/actions/owner-prompt-decision',
    ])
    assert.equal(calls[1].options.method, 'GET')
    assert.equal(calls[2].options.method, 'POST')
    assert.equal(calls[2].options.headers.authorization, 'Bearer owner-popup-bearer')
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      promptId: 'prompt-1', evidence: { mounted: true, visible: true, focused: true },
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
    resetBridgeSession()
  }
})
