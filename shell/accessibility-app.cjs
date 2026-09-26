'use strict'
// `/guide` is an alias of the Settings section This computer; the engine enum keeps it too.
const ROUTES = Object.freeze(['/', '/computers', '/metrics', '/research', '/comms', '/ledger',
  '/approvals', '/settings', '/tools', '/account', '/guide'])

// Runs only in a private isolated world owned by main. The agent supplies data,
// never JavaScript, selectors or URLs. Inspections issue opaque control ids.
function appControlWorld(request) {
  const fail = message => { throw new Error(message) }
  // This check runs inside the eventual document, after Electron has queued
  // execution. A main-process origin check alone cannot bind that document.
  if (location.origin !== request.origin) return { code: 'ACCESSIBILITY_DOCUMENT_CHANGED' }
  if (request.kind === 'bind-document') {
    const state = globalThis.__toolsEnabledAccessibilityControls ||= { targets: new Map(), documentId: crypto.randomUUID() }
    return state.documentId
  }
  const state = globalThis.__toolsEnabledAccessibilityControls
  if (!state || state.documentId !== request.documentId) return { code: 'ACCESSIBILITY_DOCUMENT_CHANGED' }
  // `/guide` is an alias of the Settings section This computer; the engine enum keeps it too.
  const routes = ['/', '/computers', '/metrics', '/research', '/comms', '/ledger', '/approvals', '/settings', '/tools', '/account', '/guide']
  const protectedName = /password|passcode|secret|api.?key|credential|accessibility|confirm|approve|permission|unrestricted|spawn|start.*agent|create.*role|save.*role|restore.*role|delete|remove/i
  function label(element) {
    return String(element.getAttribute('aria-label') || element.labels?.[0]?.textContent
      || element.getAttribute('title') || element.getAttribute('placeholder')
      || (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ? element.name : element.textContent) || element.tagName).trim().slice(0, 240)
  }
  function allowed(element) {
    if (!element?.isConnected || element.disabled || element.readOnly || !element.getClientRects().length
        || element.closest('[data-accessibility-root],.board-roles-box')) return false
    if (['password', 'file', 'hidden'].includes(element.type)) return false
    const style = getComputedStyle(element)
    if (style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0 || element.closest('[inert],[aria-hidden="true"]')) return false
    if (protectedName.test(label(element)) || /password|cc-|one-time-code/.test(element.autocomplete || '')) return false
    let parent = element.parentElement
    for (let i = 0; parent && i < 3; i++, parent = parent.parentElement) {
      if (['BODY', 'HTML'].includes(parent.tagName)) break
      if (parent.querySelector('[data-compose-field]')) return false
    }
    if (element.tagName === 'A') {
      try {
        const url = new URL(element.href, location.href)
        return url.origin === location.origin && url.pathname === location.pathname && routes.includes(url.hash.slice(1))
      } catch { return false }
    }
    return true
  }
  function fingerprint(element) { return JSON.stringify([element.tagName, element.type, label(element), element.getAttribute('href')]) }
  if (request.kind === 'navigate') {
    if (!routes.includes(request.route)) fail('This application route is not registered.')
    state.targets.clear()
    location.hash = request.route
    return { status: 'completed', route: request.route }
  }
  if (request.kind === 'inspect') {
    state.targets.clear()
    const controls = []
    for (const element of document.querySelectorAll('button,a[href],input,textarea,select,[role="button"]')) {
      if (!allowed(element)) continue
      const id = crypto.randomUUID()
      state.targets.set(id, { element: new WeakRef(element), fingerprint: fingerprint(element), at: Date.now() })
      const actions = element.tagName === 'SELECT' ? ['select'] : ['INPUT', 'TEXTAREA'].includes(element.tagName)
        && !['checkbox', 'radio', 'button', 'submit'].includes(element.type) ? ['type'] : ['click']
      controls.push({ id, label: label(element), type: element.tagName.toLowerCase(), actions,
        ...(element.tagName === 'SELECT' ? { options: [...element.options].slice(0, 100).map(option => ({ value: option.value, label: option.label })) } : {}) })
      if (controls.length >= 150) break
    }
    return { route: location.hash.slice(1) || '/', controls,
      limitations: 'Visible main-frame controls only. Known credential, consent, role-editing and agent-start controls are filtered. This is not an arbitrary-app sandbox. Use assigned agent functions for agent operations.' }
  }
  const target = state.targets.get(request.targetId)
  const element = target?.element.deref()
  if (!target || Date.now() - target.at > 90000 || !allowed(element) || target.fingerprint !== fingerprint(element)) {
    fail('The control changed or expired. Inspect the screen again before requesting an action.')
  }
  state.targets.delete(request.targetId)
  if (request.kind === 'click') element.click()
  else if (request.kind === 'type') {
    if (!['INPUT', 'TEXTAREA'].includes(element.tagName) || typeof request.text !== 'string') fail('This control does not accept text.')
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, request.text)
    if (element.value !== request.text) fail('The field did not accept that exact text. Inspect it before retrying.')
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (request.kind === 'select') {
    if (element.tagName !== 'SELECT' || ![...element.options].some(option => option.value === request.value && !option.disabled)) fail('This option is unavailable.')
    element.value = request.value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  } else fail('This application action is not registered.')
  return { status: 'completed' }
}

function createAccessibilityAppAdapter({ profileRoot, trustedOrigin }) {
  if (typeof trustedOrigin !== 'function') throw new TypeError('Application controls require the trusted document boundary.')
  const catalogs = new WeakMap()
  const versions = new WeakMap(), documents = new WeakMap()
  function capture(owner) {
    let origin
    try { if (!owner.isDestroyed()) origin = trustedOrigin(owner) } catch { /* unknown is not trusted */ }
    if (typeof origin !== 'string' || !origin || origin === 'null') throw new Error('The current document is not the trusted application.')
    return { origin, version: versions.get(owner) || 0 }
  }
  function checkText(value) {
    if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Text must be at most 2000 readable characters.')
    // Refuse explicit references to another Windows profile before a UI field
    // can navigate or open one. This is not a claim to sandbox arbitrary apps.
    for (const match of value.matchAll(/[a-z]:[\\/]users[\\/][^\\/\s"'<>]+/gi)) {
      if (match[0].replaceAll('/', '\\').toLowerCase() !== profileRoot.toLowerCase()) throw new Error('Another Windows account profile is outside this control session.')
    }
    return value
  }
  async function run(owner, request, signal, expected = capture(owner)) {
    function check() {
      if (signal?.aborted) throw new Error('Control was stopped before execution.')
      const current = capture(owner)
      if (current.origin !== expected.origin || current.version !== expected.version) throw new Error('The application document changed. Inspect again.')
    }
    const execute = async (value, gesture) => {
      const result = await owner.executeJavaScriptInIsolatedWorld(1004,
        [{ code: '(' + appControlWorld.toString() + ')(' + JSON.stringify(value) + ')' }], gesture)
      // Electron does not preserve an injected exception's message. Return a
      // closed code across that seam, then report the refusal in main.
      if (result?.code === 'ACCESSIBILITY_DOCUMENT_CHANGED') throw new Error('The trusted application document changed. Inspect again.')
      return result
    }
    check()
    let document = documents.get(owner)
    if (!document || document.origin !== expected.origin || document.version !== expected.version) {
      const id = await execute({ kind: 'bind-document', origin: expected.origin }, false)
      check()
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('The application document could not be bound.')
      document = { ...expected, id }
      documents.set(owner, document)
    }
    // Once bound, a replacement at the same URL lacks this private-world nonce
    // and refuses a queued action independently. First binding also requires
    // main's navigation invalidation: its nonce may be created after a swap.
    const result = await execute({ ...request, origin: expected.origin, documentId: document.id }, true)
    check()
    return result
  }
  return {
    invalidateDocument(owner) {
      versions.set(owner, (versions.get(owner) || 0) + 1)
      documents.delete(owner)
      catalogs.delete(owner)
    },
    async inspect(mode) {
      const result = await run(mode.owner, { kind: 'inspect' }, mode.controller.signal)
      catalogs.set(mode.owner, { mode, controls: new Map(result.controls.map(control => [control.id, control])) })
      return result
    },
    async navigate(owner, route) {
      if (!ROUTES.includes(route)) throw new Error('Choose a registered application screen.')
      return run(owner, { kind: 'navigate', route })
    },
    plan(input, mode) {
      const document = capture(mode.owner)
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['kind', 'route', 'targetId', 'text', 'value'].includes(key))) throw new Error('The application action has unsupported fields.')
      const { kind } = input
      const fields = { navigate: ['kind', 'route'], click: ['kind', 'targetId'], type: ['kind', 'targetId', 'text'], select: ['kind', 'targetId', 'value'] }[kind]
      if (!fields || fields.length !== Object.keys(input).length || fields.some(key => !Object.hasOwn(input, key))) throw new Error('The action requires exactly its documented fields.')
      let summary
      if (kind === 'navigate') {
        if (!ROUTES.includes(input.route) || Object.keys(input).some(key => !['kind', 'route'].includes(key))) throw new Error('Choose a registered application screen.')
        summary = 'Open the ' + (input.route.slice(1) || 'home') + ' screen'
      } else {
        const catalog = catalogs.get(mode.owner)
        const target = catalog?.mode === mode ? catalog.controls.get(input.targetId) : null
        if (!target || !target.actions.includes(kind)) throw new Error('Inspect the application and choose a current control.')
        if (kind === 'type') summary = 'Replace the entire contents of ' + target.label + ' with: ' + checkText(input.text)
        else if (kind === 'select') {
          const option = target.options?.find(option => option.value === input.value)
          if (!option) throw new Error('Choose an option returned by the latest inspection.')
          summary = 'Select ' + option.label + ' in ' + target.label
        } else summary = 'Press ' + target.label
      }
      const action = Object.freeze({ ...input })
      return { kind: 'app.' + kind, summary, execute: signal => run(mode.owner, action, signal, document) }
    },
  }
}
module.exports = { ROUTES, createAccessibilityAppAdapter }
