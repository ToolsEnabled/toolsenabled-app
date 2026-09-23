import assert from 'node:assert/strict'
import test from 'node:test'

/* THE SHARED DOM STAND-IN, not a thirteenth private one.
 *
 * This file used to carry its own 50-line double. It was replaced rather than
 * extended when the composer's attachment chips began calling
 * `replaceChildren`, which the private copy had never needed and therefore
 * never had -- the failure mode the consolidation exists to end, where a real
 * change to production is reported as a test crash in a fixture nobody owns.
 * Everything the private copy provided is in the shared one: the six globals
 * installed below, document.fonts, dispatch(), the scroll and client metrics,
 * replaceWith, prepend, insertBefore, childElementCount and lastElementChild.
 */
import { installDomStandIn } from './lib/dom-stand-in.mjs'

installDomStandIn()

const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('six chat additions are driven through the mounted surface', async () => {
  let stopped = 0
  const sent = []
  const attachAnswers = [{ ok: true, path: '/tmp/one.png' }, { ok: true, path: null }]
  const status = { busy: () => true, step: () => 'Reading the transcript', subscribe: () => () => {} }
  const chat = buildChat({
    title: 'Lane', history: [{ who: 'agent', text: 'alpha evidence', turnStamp: 'turn-17' }, { who: 'agent', text: 'beta' }],
    actions: () => [{ label: 'Inspect', run() {} }], status, onStop: () => { stopped += 1 },
    /* THE PICKER'S REAL ANSWERS, IN THE ORDER THE PRESSES BELOW ASK FOR THEM.
       This fixture used to return `{ path, kind: 'image' }`, a shape the
       producer has never sent: shell/agent-command-surface.cjs answers
       `{ ok: true, path }` when a file was chosen and `{ ok: true, path: null }`
       when the person cancelled the dialog, and nothing anywhere reads `kind`.
       A fixture richer than its producer lets the surface accept a shape no
       real press can deliver, and hides the cancel, which is half of what this
       control does. Both real answers are driven now. */
    onAttach: async () => attachAnswers.shift(), onSend: (text, context) => sent.push({ text, context }),
  })
  document.body.appendChild(chat)
  const composer = chat.querySelector('.chat-input input')

  const slash = composer.dispatch('keydown', { key: '/' })
  assert.equal(slash.defaultPrevented, true)
  assert.ok(chat.querySelector('.chat-actions-pop'), 'slash on an empty composer opens the one actions popup')
  chat.openActions() // closes/reopens the same popup door
  composer.value = ' '
  assert.equal(composer.dispatch('keydown', { key: '/' }).defaultPrevented, undefined, 'whitespace is not genuinely empty')

  const log = chat.querySelector('.chat-log')
  log.scrollTop = 0; log.scrollHeight = 300; log.clientHeight = 100; log.dispatch('scroll')
  chat.openStream().close('new answer')
  const jump = chat.querySelector('.chat-new-below')
  assert.equal(jump.hidden, false)
  jump.dispatch('click')
  assert.equal(jump.hidden, true); assert.equal(log.scrollTop, log.scrollHeight)

  const originalRows = [...log.children]
  chat.querySelector('.chat-search-toggle').dispatch('click')
  const search = chat.querySelector('.chat-search input'); search.value = 'alpha'; search.dispatch('input')
  assert.deepEqual([...log.children], originalRows, 'search filters the transcript in place instead of cloning it')
  assert.equal(log.querySelectorAll('.msg')[1].hidden, true)
  search.dispatch('keydown', { key: 'Escape' }); assert.ok(originalRows.every(r => !r.hidden))

  assert.equal(chat.querySelectorAll('.turn-stamp').length, 1, 'only supplied turn evidence produces a stamp')
  assert.equal(chat.querySelector('.working-step').hidden, false)
  chat.querySelector('.working-step button').dispatch('click'); await tick(); assert.equal(stopped, 1)

  chat.querySelector('[data-chat-attach]').dispatch('click'); await tick()
  assert.match(chat.querySelector('.chat-attach-strip').textContent, /one\.png/)
  composer.value = 'ship it'; composer.dispatch('keydown', { key: 'Enter' }); await tick()
  assert.deepEqual(
    sent[0].context.attachments,
    [{ ok: true, path: '/tmp/one.png' }],
    'the attachment selected through the surface rides the next send',
  )

  /* THE CANCEL. The producer answers a dismissed dialog with a successful call
     carrying no path, which is not a failure and must not become an
     attachment. The bad value is a chip named "null". */
  chat.querySelector('[data-chat-attach]').dispatch('click'); await tick()
  assert.equal(chat.querySelector('.chat-attach-strip').textContent, '',
    'cancelling the picker attached something, so a dismissed dialog reads as a chosen file')
  composer.value = 'plain'; composer.dispatch('keydown', { key: 'Enter' }); await tick()
  assert.equal(Object.hasOwn(sent[1].context, 'attachments'), false, 'absent attachment state stays absent')
})

/* Exercise the actual component with controlled scroll extents. The stand-in
 * does not lay out text; this models only the browser's scrollTop clamping,
 * and dispatches scroll when the reader moves or a shorter log clamps them.
 * It is not evidence of rendered geometry at a particular font size. */
async function withScrollingChat(check, options = {}) {
  let delivery
  const chat = buildChat({
    title: 'Controller', seed: 0,
    onSend: (_text, context) => { delivery = context },
    ...options,
  })
  document.body.append(chat)
  const log = chat.querySelector('.chat-log')
  log.scrollHeight = 1800
  log.clientHeight = 400
  let position = 1400
  const clamp = value => Math.max(0, Math.min(value, log.scrollHeight - log.clientHeight))
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => (position = clamp(position)),
    set: value => { position = clamp(value) },
  })
  const readAt = top => { log.scrollTop = top; log.dispatch('scroll') }
  const send = async () => {
    const input = chat.querySelector('.chat-input input')
    input.value = 'Inspect this evidence'
    input.dispatch('keydown', { key: 'Enter' })
    await tick()
    assert.equal(typeof delivery?.reply, 'function', 'the real send callback must be reached')
    return delivery
  }
  try { await check({ chat, log, readAt, send }) }
  finally { chat.dispose(); chat.remove() }
}

for (const action of ['open', 'push', 'flush', 'close']) {
  for (const pinned of [false, true]) {
    test(`stream ${action} ${pinned ? 'follows new output at the bottom' : 'preserves an older reading position'}`, async () => {
      await withScrollingChat(({ chat, log, readAt }) => {
        const stream = action === 'open' ? null : chat.openStream()
        readAt(pinned ? 1400 : 120)
        log.scrollHeight = 2000
        if (action === 'open') chat.openStream()
        if (action === 'push') stream.push('A growing **answer** with new evidence.')
        if (action === 'flush') stream.flush()
        if (action === 'close') stream.close('The final answer.')
        assert.equal(log.scrollTop, pinned ? 1600 : 120)
        assert.ok(chat.querySelector('.them'), 'a real streaming row must exist')
      })
    })
  }
}

const changedFile = { path: 'src/evidence.js', status: 'modified', added: 3, removed: 1 }
const diff = files => ({ source: 'session-file-change', id: 'scroll-diff', files })
const incomingRows = [
  ['assistant answer', async ({ send }) => {
    const delivery = await send()
    return { append: () => delivery.reply('New assistant evidence'), selector: '.them', text: 'New assistant evidence' }
  }],
  ['thinking', ({ chat }) => ({
    append: () => chat.addThinking('New working notes'), selector: '.thinking', text: 'New working notes',
  })],
  ['file change', ({ chat }) => ({
    append: () => chat.addDiff(diff([changedFile])), selector: '.chat-diff-card', text: changedFile.path,
  })],
  ['file change update', ({ chat }) => {
    chat.addDiff(diff([changedFile]))
    return {
      append: () => chat.addDiff(diff([{ ...changedFile, path: 'src/updated.js' }])),
      selector: '.chat-diff-card', text: 'src/updated.js',
    }
  }],
  ['approval', ({ chat }) => ({
    append: () => chat.showApproval({ id: 'scroll-approval', summary: 'Review this action' }),
    selector: '.chat-approval', text: 'Review this action',
  })],
  ['approval update', ({ chat }) => {
    chat.showApproval({ id: 'scroll-approval', summary: 'Original request' })
    return {
      append: () => chat.showApproval({ id: 'scroll-approval', summary: 'Updated request' }),
      selector: '.chat-approval', text: 'Updated request',
    }
  }],
  ['previously queued owner message accepted by the host', ({ chat }) => ({
    append: () => chat.addOwnerMessage('Earlier queued request'), selector: '.me', text: 'Earlier queued request',
  })],
  ['tool activity', ({ chat }) => ({
    append: () => chat.addAction({ id: 'scroll-tool', tool: 'Read', detail: 'evidence.txt', state: 'finished', stateKey: 'done' }),
    selector: '.chat-action-run-body .chat-action-detail', text: 'evidence.txt',
  })],
]

for (const [name, prepare] of incomingRows) {
  for (const pinned of [false, true]) {
    test(`${name} ${pinned ? 'follows new output at the bottom' : 'preserves an older reading position'}`, async () => {
      await withScrollingChat(async fixture => {
        const { append, selector, text } = await prepare(fixture)
        fixture.readAt(pinned ? 1400 : 120)
        fixture.log.scrollHeight = 2000
        append()
        assert.equal(fixture.log.scrollTop, pinned ? 1600 : 120)
        assert.equal(fixture.chat.querySelectorAll(selector).length, 1, 'updates must not duplicate a row')
        assert.ok(fixture.chat.querySelector(selector).textContent.includes(text), 'the incoming content must actually render')
      })
    })
  }
}

test('returning near the bottom resumes following, and scrolling away stops it again', async () => {
  await withScrollingChat(({ chat, log, readAt }) => {
    const stream = chat.openStream()
    readAt(120)
    log.scrollHeight = 2000
    stream.push('First addition')
    assert.equal(log.scrollTop, 120)
    readAt(1588) // Within the existing near-bottom allowance, not exactly at the end.
    log.scrollHeight = 2200
    stream.push('Second addition')
    assert.equal(log.scrollTop, 1800)
    readAt(240)
    log.scrollHeight = 2400
    stream.push('Third addition')
    assert.equal(log.scrollTop, 240)
  })
})

test('the explicit new-content jump resumes following without losing its unread indication beforehand', async () => {
  await withScrollingChat(({ chat, log, readAt }) => {
    readAt(120)
    const stream = chat.openStream()
    log.scrollHeight = 2000
    stream.push('New output below')
    const jump = chat.querySelector('.chat-new-below')
    assert.equal(log.scrollTop, 120)
    assert.equal(jump.hidden, false)
    jump.dispatch('click')
    assert.equal(jump.hidden, true)
    assert.equal(log.scrollTop, 1600)
    log.scrollHeight = 2200
    stream.push('Output after the jump')
    assert.equal(log.scrollTop, 1800)
  })
})

test('a deliberate composer send jumps to the latest content even while the reader was unpinned', async () => {
  await withScrollingChat(async ({ chat, log, readAt, send }) => {
    readAt(120)
    log.scrollHeight = 2000
    await send()
    assert.equal(log.scrollTop, 1600)
    assert.ok(chat.querySelector('.me').textContent.includes('Inspect this evidence'))
  })
})

test('a shorter transcript preserves the reader when their position still fits above the bottom', async () => {
  await withScrollingChat(({ chat, log, readAt }) => {
    const stream = chat.openStream()
    readAt(900)
    log.scrollHeight = 1500
    stream.close('A shorter final answer')
    assert.equal(log.scrollTop, 900)
  })
})

for (const remainingHeight of [900, 300]) {
  test(`a transcript reduced to ${remainingHeight}px can resume following after its scroll position clamps`, async () => {
    await withScrollingChat(({ chat, log, readAt }) => {
      const stream = chat.openStream()
      readAt(900)
      log.scrollHeight = remainingHeight
      const clamped = Math.max(0, remainingHeight - log.clientHeight)
      assert.equal(log.scrollTop, clamped)
      log.dispatch('scroll')
      log.scrollHeight = 1300
      stream.push('Output after the reduced transcript')
      assert.equal(log.scrollTop, 900)
    })
  })
}

test('restored context and answers initialize the same scroll policy before the chat mounts', async () => {
  await withScrollingChat(({ chat, log, readAt }) => {
    assert.ok(chat.querySelector('.chat-context').textContent.includes('Full role directions'))
    assert.ok(chat.querySelector('.them').textContent.includes('Restored answer'))
    readAt(120)
    chat.addThinking('New working notes')
    assert.equal(log.scrollTop, 120)
  }, { history: [
    { who: 'context', text: 'Full role directions', summary: 'Role context', label: 'Added by ToolsEnabled' },
    { who: 'agent', text: 'Restored answer' },
  ] })
})
