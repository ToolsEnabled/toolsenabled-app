import '../../../src/styles.css'
import '../../../src/chat-presentation.css'
import { buildChat } from '../../../src/components.js'
import { accountRetryStatus } from '../../../src/manual-account-continuation.js'

const DRAFT = 'Retained unsent draft'
const makeInertAttachment = attachmentPath => {
  if (typeof attachmentPath !== 'string' || !attachmentPath) {
    throw new Error('T1033 requires a retained fixture attachment path')
  }
  return {
    path: attachmentPath,
    name: 't1033-inert-attachment.png',
    size: 42,
    mime: 'image/png',
  }
}
const DRAFT_SELECTION = Object.freeze({ start: 2, end: DRAFT.length - 2 })
const REQUIRED_CONTROL_SELECTORS = Object.freeze({
  tier: '[data-chat-chip="tier"]',
  mode: '[data-chat-chip="mode"]',
  effort: '[data-chat-chip="effort"]',
  model: '[data-chat-chip="model"]',
  retry: '[data-chat-chip="account-retry"]',
  retryNow: '[data-chat-chip="account-retry-now"]',
  sendNow: '[data-chat-chip="sendnow"]',
})
const FIXTURES = Object.freeze({
  normal: Object.freeze({
    value: 'keep',
    policy: Object.freeze({ enabled: true, state: 'working' }),
    statusOptions: Object.freeze({ compact: true, busy: false }),
    warning: null,
    disabled: false,
    showAction: true,
    actionDisabled: true,
    target: 'wait',
  }),
  waiting: Object.freeze({
    value: 'wait',
    policy: Object.freeze({
      enabled: true,
      state: 'waiting',
      nextAttemptAt: 1800000000000,
      resetAt: 1800000000000,
    }),
    statusOptions: Object.freeze({ compact: true }),
    warning: null,
    disabled: false,
    showAction: true,
    actionDisabled: false,
    target: 'off',
  }),
  refusal: Object.freeze({
    value: 'keep',
    policy: Object.freeze({
      enabled: true,
      state: 'paused',
      reason: 'This account must be signed in again.',
    }),
    statusOptions: Object.freeze({ compact: true }),
    warning: 'Your retry preference could not be saved.',
    disabled: true,
    showAction: true,
    actionDisabled: true,
    target: null,
  }),
})

let active = null

const settle = async () => {
  if (document.fonts?.ready) await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
const round = value => Math.round(value * 100) / 100
const rect = node => {
  if (!node) return null
  const box = node.getBoundingClientRect()
  return {
    x: round(box.x),
    y: round(box.y),
    top: round(box.top),
    left: round(box.left),
    width: round(box.width),
    height: round(box.height),
    right: round(box.right),
    bottom: round(box.bottom),
  }
}
const visible = node => {
  if (!node || node.hidden) return false
  const style = getComputedStyle(node)
  const box = node.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
}
const inside = (child, parent) => {
  if (!child || !parent || !visible(child)) return null
  const a = child.getBoundingClientRect()
  const b = parent.getBoundingClientRect()
  return a.left >= b.left - 1 && a.right <= b.right + 1
    && a.top >= b.top - 1 && a.bottom <= b.bottom + 1
}
const overlap = (a, b) => {
  if (!visible(a) || !visible(b)) return false
  const first = a.getBoundingClientRect()
  const second = b.getBoundingClientRect()
  return Math.min(first.right, second.right) - Math.max(first.left, second.left) > 0.5
    && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 0.5
}
const activeName = () => {
  const node = document.activeElement
  if (!node) return null
  if (node.matches?.('[data-chat-chip="account-retry"]')) return 'account-retry'
  if (node.matches?.('[data-chat-chip="account-retry-now"]')) return 'account-retry-now'
  if (node.matches?.('.chat-input input')) return 'draft'
  if (node.matches?.('.chat-send')) return 'send'
  return node.tagName.toLowerCase()
}
const serializeAttachment = item => ({
  path: item?.path ?? null,
  name: item?.name ?? null,
  size: item?.size ?? null,
})
const serializeDraft = draft => {
  if (!draft) return null
  return {
    text: draft.text || '',
    attachments: (draft.attachments || []).map(serializeAttachment),
    start: draft.start ?? null,
    end: draft.end ?? null,
  }
}
const fixtureStatus = fixture => accountRetryStatus(fixture.policy, {
  ...fixture.statusOptions,
  ...(fixture.warning ? { warning: fixture.warning } : {}),
})

function mountRoot(width, state, attachmentPath) {
  const fixture = FIXTURES[state]
  if (!fixture) throw new Error('Unknown T1033 fixture state: ' + state)
  active?.root?.dispose?.()
  document.documentElement.style.width = width + 'px'
  document.documentElement.style.minWidth = '0'
  document.documentElement.style.maxWidth = width + 'px'
  document.body.style.margin = '0'
  document.body.style.width = width + 'px'
  document.body.style.minWidth = '0'
  document.body.style.maxWidth = width + 'px'
  document.body.style.background = 'var(--bg)'
  document.body.replaceChildren()
  const changes = []
  const nowCalls = []
  const sendCalls = []
  const status = fixtureStatus(fixture)
  const root = buildChat({
    title: 'Retry layout fixture',
    subtitle: 'Retained local control fixture',
    roleKey: 'coordinator',
    history: [],
    // Explicit inert boundary: capture the real buildChat send contract; never call a provider.
    onSend: async (text, handlers) => {
      sendCalls.push({
        text,
        attachments: (handlers?.attachments || []).map(item => ({
          path: item?.path ?? null,
          name: item?.name ?? null,
          size: item?.size ?? null,
        })),
      })
      handlers?.accepted?.({ id: 't1033-inert-receipt' })
    },
    chips: {
      tier: () => ({ label: 'Permission settings' }),
      model: () => ({ label: 'GPT-5' }),
      onOpenTier: () => {},
      onOpenMode: () => {},
      onOpenEffort: () => {},
      onOpenModel: () => {},
      accountRetry: () => ({
        value: fixture.value,
        status,
        disabled: fixture.disabled,
        showAction: fixture.showAction,
        actionDisabled: fixture.actionDisabled,
      }),
      onAccountRetryChange: value => { changes.push(value) },
      onAccountRetryNow: () => { nowCalls.push('try-now') },
    },
  })
  root.style.width = '100%'
  root.style.maxWidth = '100%'
  root.style.minWidth = '0'
  root.style.flex = 'none'
  document.body.append(root)
  active = { width, state, fixture, status, root, changes, nowCalls, sendCalls }
  root.importDraft({
    text: DRAFT,
    attachments: [makeInertAttachment(attachmentPath)],
    start: DRAFT_SELECTION.start,
    end: DRAFT_SELECTION.end,
  })
  return settle()
}

function measure() {
  if (!active) throw new Error('T1033 fixture is not mounted')
  const { root, width, state, fixture, status: expectedStatus, changes, nowCalls } = active
  const composer = root.querySelector('.chat-compose-surface')
  const inputRow = root.querySelector('.chat-input')
  const chips = root.querySelector('.chat-chips')
  const left = root.querySelector('.chat-chips-left')
  const right = root.querySelector('.chat-chips-right')
  const select = root.querySelector('[data-chat-chip="account-retry"]')
  const action = root.querySelector('[data-chat-chip="account-retry-now"]')
  const notice = root.querySelector('[data-chat-chip="account-retry-status"]')
  const input = root.querySelector('.chat-input input')
  const send = root.querySelector('.chat-send')
  const controls = Object.fromEntries(Object.entries(REQUIRED_CONTROL_SELECTORS).map(([name, selector]) => [
    name,
    root.querySelector(selector),
  ]))
  const nodes = {
    composer,
    inputRow,
    chips,
    left,
    right,
    ...controls,
    notice,
    input,
    send,
  }
  const rootBox = root.getBoundingClientRect()
  const contained = Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, inside(node, root)]))
  const requiredControls = Object.fromEntries(Object.entries(controls).map(([name, node]) => [
    name,
    {
      visible: visible(node),
      text: node?.textContent || '',
      disabled: Boolean(node?.disabled),
      rect: rect(node),
    },
  ]))
  const requiredContainment = Object.fromEntries(Object.keys(controls).map(name => [
    name,
    contained[name] === true,
  ]))
  const requiredContained = Object.values(requiredContainment).every(Boolean)
  const controlNames = ['tier', 'mode', 'effort', 'model', 'retry', 'retryNow', 'sendNow', 'input', 'send', 'notice']
  const overlaps = []
  for (let i = 0; i < controlNames.length; i += 1) {
    for (let j = i + 1; j < controlNames.length; j += 1) {
      const first = controlNames[i]
      const second = controlNames[j]
      if (overlap(nodes[first], nodes[second])) overlaps.push(first + ':' + second)
    }
  }
  const bodyWidth = document.body.scrollWidth - document.body.clientWidth
  const documentWidth = document.documentElement.scrollWidth - document.documentElement.clientWidth
  const rootWidth = root.scrollWidth - root.clientWidth
  const horizontalOverflow = Math.max(0, bodyWidth, documentWidth, rootWidth)
  const statusVisible = visible(notice)
  const exported = serializeDraft(root.exportDraft?.())
  const attachmentChips = Array.from(root.querySelectorAll('.chat-attachment-chip'), chip => chip.textContent || '')
  const selection = {
    start: input?.selectionStart ?? null,
    end: input?.selectionEnd ?? null,
  }
  return {
    width,
    state,
    fixtureValue: fixture.value,
    expectedStatus,
    activeElement: activeName(),
    draft: input?.value || '',
    selection,
    exported,
    attachments: exported?.attachments || [],
    attachmentChips,
    requiredControls,
    requiredContainment,
    requiredContained,
    requiredVisible: Object.values(requiredControls).every(control => control.visible),
    changes: changes.slice(),
    nowCalls: nowCalls.slice(),
    root: {
      rect: rect(root),
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      horizontalOverflow: round(rootWidth),
    },
    overflow: {
      body: round(Math.max(0, bodyWidth)),
      document: round(Math.max(0, documentWidth)),
      root: round(Math.max(0, rootWidth)),
      horizontal: round(horizontalOverflow),
      clear: horizontalOverflow <= 1,
      viewportWidth: window.innerWidth,
      rootWithinViewport: rootBox.left >= -1 && rootBox.right <= window.innerWidth + 1,
    },
    contained,
    allContained: Object.values(contained).every(value => value === null || value === true),
    overlaps,
    select: {
      rect: rect(select),
      value: select?.value,
      disabled: Boolean(select?.disabled),
      options: select ? Array.from(select.options, option => option.textContent) : [],
      ariaLabel: select?.getAttribute('aria-label'),
      focusable: !select?.disabled,
    },
    action: {
      rect: rect(action),
      hidden: Boolean(action?.hidden),
      disabled: Boolean(action?.disabled),
      text: action?.textContent || '',
    },
    status: {
      rect: rect(notice),
      text: notice?.textContent || '',
      visible: statusVisible,
      role: notice?.getAttribute('role'),
      ariaLive: notice?.getAttribute('aria-live'),
      insideLeft: Boolean(left?.contains(notice)),
      insideRight: Boolean(right?.contains(notice)),
      insideChips: Boolean(chips?.contains(notice)),
      siblingOfGroups: notice?.parentElement === chips,
    },
    input: { rect: rect(input), value: input?.value || '' },
    send: { rect: rect(send), disabled: Boolean(send?.disabled) },
    groups: {
      composer: rect(composer),
      inputRow: rect(inputRow),
      chips: rect(chips),
      left: rect(left),
      right: rect(right),
    },
  }
}

window.t844RetryLayout = {
  async ready() {
    await settle()
    return true
  },
  async mount(width, state, attachmentPath) {
    if (![320, 768, 1280].includes(width)) throw new Error('Unsupported T1033 width: ' + width)
    await mountRoot(width, state, attachmentPath)
    return measure()
  },
  focusDraft() {
    const input = active?.root?.querySelector('.chat-input input')
    input?.focus({ preventScroll: true })
    return activeName() === 'draft'
  },
  activeElementName() {
    return activeName()
  },
  async sendInert() {
    const send = active?.root?.querySelector('.chat-send')
    send?.click()
    await Promise.resolve()
    await settle()
    return {
      calls: active?.sendCalls.slice() || [],
      exportedAfterSend: serializeDraft(active?.root?.exportDraft?.()),
    }
  },
  measure,
}
