import { isDarkTheme } from './theme-choice.js'
import {
  decideOwnerPrompt,
  markOwnerPromptPresented,
  ownerPromptSnapshot,
} from './mission-bridge.js'
import { formatExactAmount } from './exact-amount.js'
import {
  RENEWAL_NOT_RECORDED,
  YEAR_COST_UNKNOWN,
  deadlineDateText,
  deadlineText,
  doNothingText,
  expiryOf,
  readProvenance,
} from './purchase-cart-view.js'

const PROMPT_KINDS = new Set(['purchase_batch', 'confirmation', 'notice'])
const THEME_NAMES = new Set(['white', 'tan', 'black'])
const PROMPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const CURRENCY_RE = /^[A-Z]{3}$/
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const POLL_MS = 750

const REQUIRED_THEME_KEYS = Object.freeze([
  'bg', 'bg2', 'surface', 'sheet', 'ink', 'ink2', 'ink25', 'ink3',
  'line', 'line2', 'good', 'serious',
])
const REQUIRED_COMMON_KEYS = Object.freeze(['accent', 'accentFloor', 'focus', 'onAccent'])
const REQUIRED_METRIC_KEYS = Object.freeze([
  'radiusSmall', 'radiusMedium', 'radiusLarge', 'space1', 'space2',
  'space3', 'space4', 'space5',
])
const REQUIRED_ROLE_KEYS = Object.freeze(['coordinator', 'helper', 'shadow', 'manager'])

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasKeys(value, keys) {
  return plain(value) && keys.every(key => Object.hasOwn(value, key))
}

function exactKeys(value, allowed, required, name) {
  if (!plain(value)) throw new Error(`${name} is malformed`)
  const allowedSet = new Set(allowed)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowedSet.has(key))
      || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${name} is malformed`)
  }
  return value
}

function boundedText(value, name, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim().length === 0)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${name} is malformed`)
  }
  return value
}

function safeCssToken(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || /[;{}<>\u0000-\u001f]/.test(value)) {
    throw new Error(`${name} is not a safe visual token`)
  }
  return value
}

function canonicalDate(value, name) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${name} is malformed`)
  }
  return value
}

function normalizeThemeManifest(manifest) {
  exactKeys(manifest,
    ['schemaVersion', 'defaultTheme', 'fonts', 'metrics', 'roles', 'common', 'themes'],
    ['schemaVersion', 'defaultTheme', 'fonts', 'metrics', 'roles', 'common', 'themes'],
    'the shared popup theme')
  exactKeys(manifest.fonts, ['ui', 'mono', 'nativeUiFamilies', 'nativeMonoFamilies'], ['ui', 'mono'], 'theme fonts')
  exactKeys(manifest.metrics, REQUIRED_METRIC_KEYS, REQUIRED_METRIC_KEYS, 'theme metrics')
  exactKeys(manifest.roles, REQUIRED_ROLE_KEYS, REQUIRED_ROLE_KEYS, 'theme roles')
  exactKeys(manifest.common, REQUIRED_COMMON_KEYS, REQUIRED_COMMON_KEYS, 'theme common roles')
  exactKeys(manifest.themes, [...THEME_NAMES], [...THEME_NAMES], 'theme variants')
  if (!plain(manifest) || manifest.schemaVersion !== 1 || !THEME_NAMES.has(manifest.defaultTheme)
      || !hasKeys(manifest.fonts, ['ui', 'mono'])
      || !hasKeys(manifest.metrics, REQUIRED_METRIC_KEYS)
      || !hasKeys(manifest.roles, REQUIRED_ROLE_KEYS)
      || !hasKeys(manifest.common, REQUIRED_COMMON_KEYS)
      || !hasKeys(manifest.themes, [...THEME_NAMES])) {
    throw new Error('the shared popup theme is malformed')
  }
  for (const key of ['ui', 'mono']) safeCssToken(manifest.fonts[key], `fonts.${key}`)
  for (const key of ['nativeUiFamilies', 'nativeMonoFamilies']) {
    if (manifest.fonts[key] === undefined) continue
    if (!Array.isArray(manifest.fonts[key]) || manifest.fonts[key].length < 1 || manifest.fonts[key].length > 8) {
      throw new Error(`fonts.${key} is malformed`)
    }
    manifest.fonts[key].forEach((value, index) => safeCssToken(value, `fonts.${key}[${index}]`))
  }
  for (const key of REQUIRED_METRIC_KEYS) {
    const value = manifest.metrics[key]
    if (!Number.isFinite(value) || value < 0 || value > 96) throw new Error(`metrics.${key} is malformed`)
  }
  for (const key of REQUIRED_ROLE_KEYS) safeCssToken(manifest.roles[key], `roles.${key}`)
  for (const key of REQUIRED_COMMON_KEYS) safeCssToken(manifest.common[key], `common.${key}`)
  for (const name of THEME_NAMES) {
    const theme = manifest.themes[name]
    exactKeys(theme, REQUIRED_THEME_KEYS, REQUIRED_THEME_KEYS, `themes.${name}`)
    if (!hasKeys(theme, REQUIRED_THEME_KEYS)) throw new Error(`themes.${name} is malformed`)
    for (const key of REQUIRED_THEME_KEYS) safeCssToken(theme[key], `themes.${name}.${key}`)
  }
  return manifest
}

function preferredTheme(documentRef, manifest) {
  const selected = documentRef?.documentElement?.dataset?.theme
  return isDarkTheme(selected) ? 'black' : THEME_NAMES.has(selected) ? selected : manifest.defaultTheme
}

/** Apply the canonical runtime palette without copying its colour values here. */
export function applyOwnerPopupTheme(root, manifestValue, selectedTheme) {
  const manifest = normalizeThemeManifest(manifestValue)
  const themeName = isDarkTheme(selectedTheme) ? 'black' : THEME_NAMES.has(selectedTheme) ? selectedTheme : manifest.defaultTheme
  const theme = manifest.themes[themeName]
  const paletteProperties = {
    bg: '--op-bg', bg2: '--op-bg-2', surface: '--op-surface', sheet: '--op-sheet',
    ink: '--op-ink', ink2: '--op-ink-2', ink25: '--op-ink-25', ink3: '--op-ink-3',
    line: '--op-line', line2: '--op-line-2', good: '--op-good', serious: '--op-serious',
  }
  for (const [key, property] of Object.entries(paletteProperties)) root.style.setProperty(property, theme[key])
  /* Web prompts live inside the product and must follow its live font tokens,
     including the owner's current font choice. The manifest font stacks exist
     for native dialogs that cannot evaluate CSS custom properties; pinning
     them here was a second, stale font path (and still named retired Inter). */
  root.style.setProperty('--op-font-ui', 'var(--font-ui)')
  root.style.setProperty('--op-font-mono', 'var(--font-mono)')
  root.style.setProperty('--op-accent', manifest.common.accent)
  root.style.setProperty('--op-accent-floor', manifest.common.accentFloor)
  root.style.setProperty('--op-focus', manifest.common.focus)
  root.style.setProperty('--op-on-accent', manifest.common.onAccent)
  for (const key of REQUIRED_METRIC_KEYS) {
    root.style.setProperty(`--op-${key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)}`, `${manifest.metrics[key]}px`)
  }
  for (const key of REQUIRED_ROLE_KEYS) root.style.setProperty(`--op-role-${key}`, manifest.roles[key])
  root.dataset.ownerTheme = themeName
  return themeName
}

function normalizeItem(value, seen) {
  exactKeys(value,
    ['id', 'description', 'amountCents', 'currency', 'merchant', 'purpose'],
    ['id', 'description', 'amountCents', 'currency', 'merchant', 'purpose'],
    'purchase item')
  if (!plain(value) || !PROMPT_ID_RE.test(String(value.id || '')) || seen.has(value.id)
      || !Number.isSafeInteger(value.amountCents) || value.amountCents < 1
      || !CURRENCY_RE.test(String(value.currency || ''))) {
    throw new Error('purchase item is malformed')
  }
  seen.add(value.id)
  return Object.freeze({
    id: value.id,
    description: boundedText(value.description, 'purchase description', 300),
    amountCents: value.amountCents,
    currency: value.currency,
    merchant: boundedText(value.merchant, 'purchase merchant', 200),
    purpose: boundedText(value.purpose, 'purchase purpose', 500),
  })
}

function normalizePrompt(value) {
  const baseKeys = ['id', 'kind', 'title', 'message', 'createdAt', 'expiresAt', 'state', 'defaultDecision']
  const purchaseKeys = [...baseKeys, 'items', 'totalCents', 'currency']
  exactKeys(value, value?.kind === 'purchase_batch' ? purchaseKeys : baseKeys,
    value?.kind === 'purchase_batch' ? purchaseKeys : baseKeys, 'owner prompt')
  if (!plain(value) || !PROMPT_ID_RE.test(String(value.id || '')) || !PROMPT_KINDS.has(value.kind)
      || !['pending', 'presented'].includes(value.state)
      || (value.kind === 'notice' ? value.defaultDecision !== 'acknowledge' : value.defaultDecision !== 'deny')) {
    throw new Error('owner prompt is malformed')
  }
  const base = {
    id: value.id,
    kind: value.kind,
    title: boundedText(value.title, 'prompt title', 200),
    message: boundedText(value.message, 'prompt message', 2_000),
    createdAt: canonicalDate(value.createdAt, 'prompt createdAt'),
    expiresAt: canonicalDate(value.expiresAt, 'prompt expiresAt'),
    state: value.state,
    defaultDecision: value.defaultDecision,
  }
  if (Date.parse(base.expiresAt) <= Date.parse(base.createdAt)) throw new Error('prompt expiry is malformed')
  if (value.kind !== 'purchase_batch') return Object.freeze(base)
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100
      || !Number.isSafeInteger(value.totalCents) || value.totalCents < 1
      || !CURRENCY_RE.test(String(value.currency || ''))) {
    throw new Error('purchase prompt is malformed')
  }
  const seen = new Set()
  const items = value.items.map(item => normalizeItem(item, seen))
  if (items.some(item => item.currency !== value.currency)
      || items.reduce((sum, item) => sum + item.amountCents, 0) !== value.totalCents) {
    throw new Error('purchase total is not bound to its line items')
  }
  return Object.freeze({ ...base, items: Object.freeze(items), totalCents: value.totalCents, currency: value.currency })
}

/** Strict public snapshot boundary. Credential fields have no accepted shape. */
export function normalizeOwnerPromptSnapshot(value) {
  exactKeys(value,
    ['ok', 'schemaVersion', 'generatedAt', 'theme', 'prompts'],
    ['ok', 'schemaVersion', 'generatedAt', 'theme', 'prompts'],
    'owner prompt snapshot')
  if (!plain(value) || value.ok !== true || value.schemaVersion !== 1
      || !Array.isArray(value.prompts) || value.prompts.length > 64) {
    throw new Error('owner prompt snapshot is malformed')
  }
  canonicalDate(value.generatedAt, 'snapshot generatedAt')
  const theme = normalizeThemeManifest(value.theme)
  const ids = new Set()
  const prompts = value.prompts.map(entry => {
    const prompt = normalizePrompt(entry)
    if (ids.has(prompt.id)) throw new Error('owner prompt id is duplicated')
    ids.add(prompt.id)
    return prompt
  })
  return Object.freeze({ theme, prompts: Object.freeze(prompts) })
}

/* Money formatting moved to src/exact-amount.js so src/purchase-cart-view.js can
   use the same one without importing this module, which reaches the audited
   connection. Passed straight through, so every existing import still works. */
export { formatExactAmount } from './exact-amount.js'

export function purchaseDecisionBody(prompt, decisions) {
  const chosen = []
  for (const item of prompt.items) {
    const decision = decisions.get(item.id)
    if (decision === 'approve' || decision === 'deny') chosen.push({ itemId: item.id, decision })
  }
  return { promptId: prompt.id, decision: 'submit', itemDecisions: chosen }
}

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function setAttributes(node, attributes) {
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

function actionButton(documentRef, label, className, handler) {
  const button = element(documentRef, 'button', className, label)
  button.type = 'button'
  button.addEventListener('click', handler)
  return button
}

function renderPurchase(documentRef, prompt, callbacks, surface) {
  const body = element(documentRef, 'div', 'owner-popup-body owner-popup-shopping')
  const columnHead = element(documentRef, 'div', 'owner-popup-list-head')
  columnHead.append(
    element(documentRef, 'span', '', 'Item'),
    element(documentRef, 'span', '', 'Exact amount'),
    element(documentRef, 'span', '', 'Decision'),
  )
  body.append(columnHead)

  const decisions = new Map()
  const decisionButtons = []
  for (const item of prompt.items) {
    const row = element(documentRef, 'section', 'owner-popup-item')
    row.dataset.itemId = item.id
    row.dataset.decision = 'undecided'
    /* THE REFERENCE NUMBER COMES OFF BEFORE THE NAME GOES ON THE SCREEN.
       The engine stamps provenance onto the front of the description as text --
       "[From your words: R1234] " -- and this row used to print the whole string.
       That put one of our own record numbers on the surface where he decides
       about money. The FACT is worth keeping and gets its own row below in
       words; the number is not his to have to read. */
    const from = readProvenance(item.description)
    row.dataset.provenance = from.provenance
    setAttributes(row, { 'aria-label': `${from.text}, ${formatExactAmount(item.amountCents, item.currency)}` })

    const details = element(documentRef, 'div', 'owner-popup-item-details')
    details.append(element(documentRef, 'strong', 'owner-popup-item-name', from.text))
    const merchant = element(documentRef, 'div', 'owner-popup-item-meta')
    merchant.append(element(documentRef, 'span', 'owner-popup-meta-label', 'Merchant'), element(documentRef, 'span', '', item.merchant))
    const purpose = element(documentRef, 'div', 'owner-popup-item-meta')
    purpose.append(element(documentRef, 'span', 'owner-popup-meta-label', 'Purpose'), element(documentRef, 'span', '', item.purpose))
    /* WHOSE IDEA THIS LINE WAS, in words. One of the twenty lines on his real
       cart today is stamped as nobody's idea, and until now that stamp was
       buried inside the description text at the front of the item name. */
    const origin = element(documentRef, 'div', 'owner-popup-item-meta owner-popup-item-origin')
    origin.append(element(documentRef, 'span', 'owner-popup-meta-label', 'Whose idea'), element(documentRef, 'span', '', from.label))
    /* WHAT IT COSTS THE SECOND TIME, which no line can say. A stated absence,
       never a blank and never a guessed figure. The reason is under the total. */
    const renewal = element(documentRef, 'div', 'owner-popup-item-meta owner-popup-item-renewal')
    renewal.append(element(documentRef, 'span', 'owner-popup-meta-label', 'Repeats'), element(documentRef, 'span', '', RENEWAL_NOT_RECORDED))
    details.append(merchant, purpose, origin, renewal)

    const amount = element(documentRef, 'div', 'owner-popup-item-amount', formatExactAmount(item.amountCents, item.currency))
    const controls = setAttributes(element(documentRef, 'div', 'owner-popup-item-actions'), {
      role: 'group', 'aria-label': `Decision for ${item.description}`,
    })
    const choose = decision => {
      decisions.set(item.id, decision)
      row.dataset.decision = decision === 'approve' ? 'approved' : 'denied'
      approve.setAttribute('aria-pressed', String(decision === 'approve'))
      deny.setAttribute('aria-pressed', String(decision === 'deny'))
    }
    const approve = setAttributes(actionButton(documentRef, 'Approve', 'owner-popup-choice owner-popup-approve', () => choose('approve')), { 'aria-pressed': 'false' })
    const deny = setAttributes(actionButton(documentRef, 'Deny', 'owner-popup-choice owner-popup-deny', () => choose('deny')), { 'aria-pressed': 'false' })
    approve.disabled = true
    deny.disabled = true
    decisionButtons.push(approve, deny)
    controls.append(approve, deny)
    row.append(details, amount, controls)
    body.append(row)
  }

  const total = element(documentRef, 'div', 'owner-popup-total')
  total.append(element(documentRef, 'span', '', `${prompt.items.length} line${prompt.items.length === 1 ? '' : 's'} total`))
  total.append(element(documentRef, 'strong', '', formatExactAmount(prompt.totalCents, prompt.currency)))
  body.append(total)

  /* WHY THERE IS NO TWELVE-MONTH FIGURE UNDER THAT TOTAL. Several of these
     renew and not one line on the wire carries a renewal amount, so a year
     figure would be a guess printed next to an exact one. Said once, here,
     rather than sixteen times up the list. */
  const yearNote = setAttributes(element(documentRef, 'p', 'owner-popup-year-note', YEAR_COST_UNKNOWN), { role: 'note' })
  body.append(yearNote)

  const defaultRule = setAttributes(element(documentRef, 'p', 'owner-popup-default-rule'), { role: 'note' })
  defaultRule.append(element(documentRef, 'strong', '', 'Default deny. '))
  // Deny-by-default is enforced by the engine, not by this copy: decide()
  // fills every line the owner did not explicitly approve with 'deny'. But the
  // two surfaces differ in what LEAVING means, and saying the popup's sentence
  // on a screen would be a lie. Dismissing the popup submits the defaults, so
  // closing it really does deny. Navigating away from the screen submits
  // NOTHING; the prompt stays pending until it is decided or expires, which is
  // the whole point of a queue he visits on his own time.
  defaultRule.append(element(documentRef, 'span', '', surface === 'screen'
    ? 'Any line you leave undecided is denied when you submit. Leaving this screen submits nothing and decides nothing.'
    : 'Any line left undecided is denied. Closing this window denies every line.'))
  body.append(defaultRule)

  const submit = actionButton(documentRef, 'Submit decisions', 'owner-popup-primary', () => callbacks.submit(purchaseDecisionBody(prompt, decisions)))
  submit.disabled = true
  return { body, footerButtons: [submit], gatedControls: [...decisionButtons, submit], decisions }
}

function renderConfirmation(documentRef, prompt, callbacks, surface) {
  const body = element(documentRef, 'div', 'owner-popup-body')
  body.append(element(documentRef, 'p', 'owner-popup-message', prompt.message))
  const rule = setAttributes(element(documentRef, 'p', 'owner-popup-default-rule'), { role: 'note' })
  rule.append(element(documentRef, 'strong', '', 'Default deny. '), element(documentRef, 'span', '', surface === 'screen'
    ? 'Nothing is approved unless you approve it. Leaving this screen submits nothing and decides nothing.'
    : 'Closing this window refuses the action.'))
  body.append(rule)
  const deny = actionButton(documentRef, 'Deny', 'owner-popup-secondary owner-popup-deny', () => callbacks.submit({ promptId: prompt.id, decision: 'deny' }))
  const approve = actionButton(documentRef, 'Approve', 'owner-popup-primary', () => callbacks.submit({ promptId: prompt.id, decision: 'approve' }))
  deny.disabled = true
  approve.disabled = true
  return { body, footerButtons: [deny, approve], gatedControls: [deny, approve] }
}

function renderNotice(documentRef, prompt, callbacks) {
  const body = element(documentRef, 'div', 'owner-popup-body')
  body.append(element(documentRef, 'p', 'owner-popup-message', prompt.message))
  const acknowledge = actionButton(documentRef, 'Acknowledge', 'owner-popup-primary', () => callbacks.submit({ promptId: prompt.id, decision: 'acknowledge' }))
  acknowledge.disabled = true
  return { body, footerButtons: [acknowledge], gatedControls: [acknowledge] }
}

/**
 * Build the real DOM tree with textContent only; no owner string is HTML.
 *
 * `options.surface` selects which container this card is going into and
 * changes NOTHING about how a line item looks. 'popup' (the default, so every
 * existing caller and test is untouched) is the interrupting modal. 'screen'
 * is the approvals queue the owner navigates to himself: same card, same rows,
 * same classes, but it is not a modal, so it must not claim to be one. A
 * role="dialog" with aria-modal="true" sitting inertly in a list tells a
 * screen reader the rest of the page is inaccessible when it is not, and a
 * close button captioned "Close and refuse" would offer to deny a request the
 * owner merely scrolled past.
 */
export function renderOwnerPrompt(documentRef, prompt, callbacks, options = {}) {
  const surface = options.surface === 'screen' ? 'screen' : 'popup'
  /* `options.now` is injected so a screen and its test agree on the clock
     instead of racing it. Every caller in the product leaves it out. */
  const nowMs = Number.isSafeInteger(options.now) ? options.now : Date.now()
  const overlay = element(documentRef, 'div', 'owner-popup-overlay')
  overlay.dataset.promptId = prompt.id
  const dialog = setAttributes(element(documentRef, 'section', 'owner-popup-dialog'), surface === 'screen'
    ? {
      role: 'group', 'aria-labelledby': `owner-popup-title-${prompt.id}`,
      'aria-describedby': `owner-popup-status-${prompt.id}`,
    }
    : {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `owner-popup-title-${prompt.id}`,
      'aria-describedby': `owner-popup-status-${prompt.id}`, tabindex: '-1',
    })
  const header = element(documentRef, 'header', 'owner-popup-header')
  const heading = element(documentRef, 'div', 'owner-popup-heading')
  heading.append(element(documentRef, 'span', 'owner-popup-kicker', prompt.kind === 'purchase_batch' ? 'Purchase approval' : 'Owner prompt'))
  const title = element(documentRef, 'h2', '', prompt.title)
  title.id = `owner-popup-title-${prompt.id}`
  heading.append(title)
  if (prompt.kind === 'purchase_batch' && prompt.message) {
    heading.append(element(documentRef, 'p', 'owner-popup-heading-message', prompt.message))
  }
  /* WHEN THIS DIES, AND THAT DYING IS A REFUSAL.
   *
   * `expiresAt` has been on every request since the beginning. This module
   * validated it and drew it nowhere, so both of the owner's live shopping
   * lists could reach their date with nothing on any screen having said the
   * date existed. The engine drops a request the moment its expiry passes and
   * files it with the default decision, and the default decision is deny. So
   * silence is not neutral, and the second sentence here says which way it
   * falls. It is on every kind of request, not only on the shopping lists:
   * the two that expire soonest on his real queue are questions, not carts. */
  const expiry = expiryOf(prompt, nowMs)
  const deadline = setAttributes(element(documentRef, 'div', 'owner-popup-deadline'), { role: 'note' })
  deadline.dataset.expired = String(expiry.expired)
  deadline.dataset.remainingDays = String(expiry.remainingDays)
  const spelled = deadlineDateText(expiry)
  deadline.append(element(documentRef, 'strong', 'owner-popup-deadline-when',
    spelled ? `${deadlineText(expiry)} (${spelled})` : deadlineText(expiry)))
  deadline.append(element(documentRef, 'span', 'owner-popup-deadline-consequence', doNothingText(prompt.kind)))
  heading.append(deadline)
  const close = surface === 'screen'
    ? null
    : setAttributes(actionButton(documentRef, '×', 'owner-popup-close', callbacks.dismiss), { 'aria-label': 'Close and refuse' })
  header.append(heading)
  if (close) header.append(close)

  const rendered = prompt.kind === 'purchase_batch'
    ? renderPurchase(documentRef, prompt, callbacks, surface)
    : prompt.kind === 'confirmation'
      ? renderConfirmation(documentRef, prompt, callbacks, surface)
      : renderNotice(documentRef, prompt, callbacks)
  const footer = element(documentRef, 'footer', 'owner-popup-footer')
  const status = setAttributes(element(documentRef, 'p', 'owner-popup-status', surface === 'screen'
    ? 'Checking that this request is on screen…'
    : 'Confirming that this prompt is visible and focused…'), {
    id: `owner-popup-status-${prompt.id}`, role: 'status', 'aria-live': 'polite',
  })
  footer.append(status)
  const actions = element(documentRef, 'div', 'owner-popup-footer-actions')
  actions.append(...rendered.footerButtons)
  footer.append(actions)
  dialog.append(header, rendered.body, footer)
  overlay.append(dialog)
  return { overlay, dialog, close, status, gatedControls: rendered.gatedControls, decisions: rendered.decisions || null }
}

function nextPaint(windowRef) {
  if (typeof windowRef?.requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise(resolve => windowRef.requestAnimationFrame(() => windowRef.requestAnimationFrame(resolve)))
}

export function measuredPresentationEvidence(documentRef, rendered) {
  const view = documentRef.defaultView
  const style = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(rendered.dialog) : null
  const overlayStyle = typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(rendered.overlay) : null
  const rect = typeof rendered.dialog.getBoundingClientRect === 'function'
    ? rendered.dialog.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
  const viewportWidth = Number.isFinite(view?.innerWidth) ? view.innerWidth : Number.POSITIVE_INFINITY
  const viewportHeight = Number.isFinite(view?.innerHeight) ? view.innerHeight : Number.POSITIVE_INFINITY
  const mounted = Boolean(rendered.overlay.isConnected && rendered.overlay.contains(rendered.dialog))
  const visible = Boolean(mounted && rect.width > 0 && rect.height > 0
    && rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight
    && (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'))
    && (!overlayStyle || (overlayStyle.display !== 'none' && overlayStyle.visibility !== 'hidden' && overlayStyle.opacity !== '0')))
  const focused = Boolean((typeof documentRef.hasFocus !== 'function' || documentRef.hasFocus())
    && rendered.dialog.contains(documentRef.activeElement))
  return { mounted, visible, focused }
}

function setControlsEnabled(session, enabled) {
  for (const control of session.rendered.gatedControls) control.disabled = !enabled
}

function setStatus(session, text, kind = 'status') {
  session.rendered.status.textContent = text
  session.rendered.status.dataset.state = kind
  session.rendered.status.setAttribute('role', kind === 'unavailable' ? 'alert' : 'status')
}

function readyStatus(prompt) {
  return prompt.kind === 'purchase_batch'
    ? 'Ready for review. Undecided lines are denied when decisions are submitted.'
    : 'Ready for your decision.'
}

function backgroundNodes(documentRef) {
  const roots = [
    documentRef.querySelector('header.topbar'),
    documentRef.getElementById('stage'),
    documentRef.getElementById('drawer'),
  ].filter(Boolean)
  const drawer = documentRef.getElementById('drawer')
  // The settings module owns an observer that may re-derive inert on the
  // drawer root from its own open/closed state. Guard its focusable children
  // too, so that observer cannot make controls behind this modal reachable.
  const drawerControls = drawer ? [...drawer.querySelectorAll(FOCUSABLE)] : []
  return [...new Set([...roots, ...drawerControls])]
}

export function createOwnerPromptController({
  documentRef = document,
  windowRef = window,
  readSnapshot = ownerPromptSnapshot,
  markPresented = markOwnerPromptPresented,
  submitDecision = decideOwnerPrompt,
  pollMs = POLL_MS,
  measureEvidence = measuredPresentationEvidence,
} = {}) {
  const root = documentRef.getElementById('owner-popup-root')
  if (!root) throw new Error('owner popup mount is unavailable')
  let current = null
  let timer = null
  let polling = false
  let destroyed = false
  let themeManifest = null
  const settled = new Set()

  function unlockBackground(session) {
    for (const entry of session.background) entry.node.toggleAttribute('inert', entry.hadInert)
  }

  function closeCurrent({ restoreFocus = true } = {}) {
    const session = current
    if (!session) return
    current = null
    documentRef.removeEventListener('keydown', session.onKeydown)
    windowRef.removeEventListener('focus', session.onWindowFocus)
    unlockBackground(session)
    session.rendered.overlay.remove()
    if (restoreFocus && session.priorFocus?.isConnected && typeof session.priorFocus.focus === 'function') session.priorFocus.focus()
  }

  async function submit(session, body) {
    if (current !== session || !session.presented || session.submitting) return
    session.submitting = true
    setControlsEnabled(session, false)
    session.rendered.close.disabled = true
    setStatus(session, 'Recording your decision…')
    let result
    try { result = await submitDecision(body) }
    catch { result = { ok: false } }
    if (current !== session) return
    if (result?.ok !== true) {
      session.submitting = false
      session.failed = true
      session.rendered.close.disabled = false
      setStatus(session, 'Decision delivery could not be confirmed. No action is shown as approved; the action remains refused unless a confirmed decision is recorded.', 'unavailable')
      return
    }
    settled.add(session.prompt.id)
    closeCurrent()
    void poll()
  }

  function dismiss(session) {
    if (current !== session) return
    if (session.failed) {
      settled.add(session.prompt.id)
      closeCurrent()
      return
    }
    if (!session.presented) {
      settled.add(session.prompt.id)
      closeCurrent()
      return
    }
    const body = session.prompt.kind === 'purchase_batch'
      ? { promptId: session.prompt.id, decision: 'submit', itemDecisions: [] }
      : session.prompt.kind === 'confirmation'
        ? { promptId: session.prompt.id, decision: 'deny' }
        : { promptId: session.prompt.id, decision: 'acknowledge' }
    void submit(session, body)
  }

  async function confirmPresentation(session) {
    if (current !== session || session.presented || session.presenting || session.failed) return
    await nextPaint(windowRef)
    if (current !== session || session.presented || session.presenting || session.failed) return
    session.rendered.close.focus()
    const evidence = measureEvidence(documentRef, session.rendered)
    if (!evidence.mounted || !evidence.visible) {
      setControlsEnabled(session, false)
      setStatus(session, 'This prompt could not be presented. No action was approved.', 'unavailable')
      return
    }
    if (!evidence.focused) {
      setControlsEnabled(session, false)
      setStatus(session, 'Focus this window to review the prompt. Until then, the action is refused.')
      return
    }
    session.presenting = true
    let result
    try { result = await markPresented(session.prompt.id, evidence) }
    catch { result = { ok: false } }
    session.presenting = false
    if (current !== session) return
    if (result?.ok !== true) {
      session.failed = true
      setControlsEnabled(session, false)
      setStatus(session, 'Presentation could not be confirmed. No action was approved.', 'unavailable')
      return
    }
    session.presented = true
    setControlsEnabled(session, true)
    setStatus(session, readyStatus(session.prompt))
  }

  function trapFocus(session, event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss(session)
      return
    }
    if (event.key !== 'Tab') return
    const stops = [...session.rendered.dialog.querySelectorAll(FOCUSABLE)]
      .filter(node => !node.disabled && node.tabIndex !== -1 && node.offsetParent !== null)
    if (!stops.length) {
      event.preventDefault()
      session.rendered.dialog.focus()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function open(prompt) {
    if (current?.prompt.id === prompt.id) return
    closeCurrent({ restoreFocus: false })
    const session = {
      prompt,
      priorFocus: documentRef.activeElement,
      presented: false,
      presenting: false,
      submitting: false,
      failed: false,
      background: backgroundNodes(documentRef).map(node => ({ node, hadInert: node.hasAttribute('inert') })),
      rendered: null,
      onKeydown: null,
      onWindowFocus: null,
    }
    session.rendered = renderOwnerPrompt(documentRef, prompt, {
      dismiss: () => dismiss(session),
      submit: body => { void submit(session, body) },
    })
    for (const entry of session.background) entry.node.setAttribute('inert', '')
    root.append(session.rendered.overlay)
    session.onKeydown = event => trapFocus(session, event)
    session.onWindowFocus = () => { void confirmPresentation(session) }
    documentRef.addEventListener('keydown', session.onKeydown)
    windowRef.addEventListener('focus', session.onWindowFocus)
    current = session
    void confirmPresentation(session)
  }

  function showKnownPromptUnavailable(message) {
    if (!current) return
    setControlsEnabled(current, false)
    setStatus(current, `${message} No action was approved.`, 'unavailable')
  }

  async function poll() {
    if (destroyed || polling) return
    polling = true
    let raw
    try { raw = await readSnapshot() }
    catch { raw = null }
    polling = false
    if (destroyed) return
    if (raw?.ok !== true) {
      showKnownPromptUnavailable('The owner prompt service is unavailable.')
      return
    }
    let snapshot
    try { snapshot = normalizeOwnerPromptSnapshot(raw) }
    catch {
      showKnownPromptUnavailable('The owner prompt response or shared visual theme is invalid.')
      return
    }
    themeManifest = snapshot.theme
    const activeIds = new Set(snapshot.prompts.map(prompt => prompt.id))
    for (const id of settled) if (!activeIds.has(id)) settled.delete(id)
    try { applyOwnerPopupTheme(root, themeManifest, preferredTheme(documentRef, themeManifest)) }
    catch {
      showKnownPromptUnavailable('The shared visual theme could not be applied.')
      return
    }
    const next = snapshot.prompts.find(prompt => !settled.has(prompt.id))
    if (!next) {
      closeCurrent()
      return
    }
    if (current?.prompt.id === next.id && current.presented && !current.submitting && !current.failed) {
      setControlsEnabled(current, true)
      setStatus(current, readyStatus(current.prompt))
      return
    }
    open(next)
  }

  const themeObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
      if (!themeManifest) return
      try { applyOwnerPopupTheme(root, themeManifest, preferredTheme(documentRef, themeManifest)) }
      catch { showKnownPromptUnavailable('The shared visual theme could not be applied.') }
    })
    : null
  themeObserver?.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  return Object.freeze({
    poll,
    start() {
      if (destroyed || timer !== null) return
      void poll()
      timer = windowRef.setInterval(() => { void poll() }, pollMs)
    },
    destroy() {
      destroyed = true
      if (timer !== null) windowRef.clearInterval(timer)
      timer = null
      themeObserver?.disconnect()
      closeCurrent()
    },
    currentPromptId: () => current?.prompt.id || null,
  })
}

// DELIBERATELY NOT SELF-MOUNTING.
//
// This module used to end by finding #owner-popup-root and starting the
// controller, which made any prompt in the queue interrupt the owner wherever
// he was. The owner replaced that design: "instead of a popup maybe the
// purchase list is just a screen and the user navigates to that screen on
// their own time and approves whatevers in que." Approvals now live at
// #/approvals (src/ledger-prompt-queue.js), which imports the renderer below.
//
// The modal path is kept because it is tested, correct, and the only surface
// that can ever be right for something genuinely blocking. It is now opt-in:
// a caller has to construct createOwnerPromptController() and start it. Do
// not restore an auto-mount here without an explicit owner instruction; it
// would silently turn the queue back into an interruption.
