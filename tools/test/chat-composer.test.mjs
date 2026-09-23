// The live composer (src/components.js buildChat, iteration 6): the send
// button's two faces, the queue strip, and the actions popup. The rules being
// pinned are the owner's, near-verbatim: "stop should be a button that
// replaces the send button when a agent is replying, unless a user types then
// it turns back into a send to send while the agent is working, unless the
// have que on then it gets loaded and waits and we should [show] a little
// preview of it waiting to be sent" — and the popup is "a clean pop up just
// like vscode is" behind a button "next to the attachments icon".
//
// Source pins, deliberately: buildChat needs a DOM to run, and the harness
// here has none. Each assertion anchors on the code shape that carries the
// rule, so the day the shape changes this suite says which rule to re-measure.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))

test('every new power is optional; the old callers compile unchanged', () => {
  assert.match(chat.slice(0, 800), /status = null, queue = null, actions = null, actionsNote = null, onStop = null/,
    'a new composer option lost its null default; agent.js and comms.js would have to change')
  /* views/comms.js left this list when it stopped calling buildChat at all:
     its expanded tile is a header and a log with no composer (nothing on
     that page can send). Keeping it here made the pin vacuous -- indexOf
     returning -1 sliced an empty string that matched nothing. */
  for (const caller of ['views/agent.js']) {
    const source = readFileSync(join(SRC, caller), 'utf8')
    const call = source.slice(source.indexOf('buildChat('), source.indexOf('buildChat(') + 1400)
    assert.ok(!/onStop|queue:|actions:|status:/.test(call),
      `${caller} passes a live-composer option; those belong to the fleet page's config alone`)
  }
})

test('the stop face shows only while busy with an empty input, and a press stops', () => {
  /* REANCHORED: the stop-face rule moved out of syncComposer into
     syncSendButton when the typing path was split off (T382), so a window cut
     from `const syncComposer` no longer contains the rule and this went RED on
     a change that did not touch the behaviour at all. The rule is pinned where
     it now lives; its intent is unchanged. */
  const sync = chat.slice(chat.indexOf('const syncSendButton'), chat.indexOf('const syncSendButton') + 700)
  assert.match(sync, /isBusy\(\) && !input\.value\.trim\(\) && pendingAttachments\.length === 0 && typeof onStop === 'function'/,
    "the stop-face rule changed — it must be exactly: busy AND empty input AND a stop handler")
  assert.match(sync, /is-stop/, 'the stop face lost its class; the button cannot morph')
  const send = chat.slice(chat.indexOf('const send = ()'), chat.indexOf('const send = ()') + 900)
  assert.match(send, /if \(isBusy\(\) && typeof onStop === 'function'\) void runStop\(\)/,
    'pressing the empty-input button while busy no longer stops')
  /* Typing repaints instantly — the moment there are words, the arrow is
     back, because sending the person's words outranks the interrupt. */
  assert.match(chat, /input\.addEventListener\('input', onInputTyped\)/, 'typing no longer repaints the composer; the stop face lingers over words')
})

test('a busy typed send queues with NO me-bubble — the strip is the preview', () => {
  /* REANCHORED 2026-08-24: this used to slice send() up to the first
     `replyQueue.push`, which assumed delivery lived INSIDE send(). Delivery
     was extracted into deliverTurn() (one path serving both plain send and
     the queue's Send now), moving that anchor above send() and collapsing
     the old slice to ''. The behaviours pinned here did not change; the
     anchors now name the structure instead of the old layout. */
  const send = chat.slice(chat.indexOf('const send = ()'), chat.indexOf('const sendNowFromInput'))
  const busyBranch = send.slice(send.indexOf('if ((isBusy() || queueRequired()) && queue)'), send.indexOf('deliverTurn(v)'))
  assert.ok(busyBranch.includes('queue.add(v)'), 'a busy typed send no longer queues')
  assert.ok(!/addMsg\('me'/.test(busyBranch),
    'the busy queue branch prints a me-bubble — that claims the words were SENT when they are waiting')
  assert.match(chat, /queueStrip\.hidden = entries\.length === 0/, 'the strip no longer follows the queue')
  /* The person's words render as text, never markup. */
  assert.match(chat, /text\.textContent = entry\.text/, "the strip renders the person's words some way other than textContent")
  assert.match(chat, /queue\.cancel\(entry\.id\)/, 'a waiting row lost its way out (Unqueue)')
})

test('a waiting row can go NOW, and all send doors deliver exactly once', async () => {
  // The old pin required an exact argument spelling and a retired busy-only
  // keyboard guard. Drive the mounted controls to verify the actual sends.
  const meBubbles = chat.match(/addMsg\('me'/g) || []
  assert.equal(meBubbles.length, 1,
    `expected exactly one me-bubble call (the shared delivery path); found ${meBubbles.length}`)
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn()
  const { buildChat } = await import('../../src/components.js')
  const sent = []
  let waiting = [{ id: 'queued-row', text: 'from the row' }]
  let root
  try {
    root = buildChat({
      title: 'agent', seed: 0, status: { busy: () => false },
      queue: {
        list: () => waiting,
        cancel: id => {
          const present = waiting.some(entry => entry.id === id)
          waiting = waiting.filter(entry => entry.id !== id)
          return present
        },
      },
      onSend: text => { sent.push(text) },
    })
    const input = root.querySelector('.chat-input input')
    input.value = 'from the arrow'
    root.querySelector('.chat-send').dispatch('click')
    root.querySelector('.chat-queue-now').dispatch('click')
    input.value = 'from Shift+Enter'
    input.dispatch('keydown', { key: 'Enter', shiftKey: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(sent, ['from the arrow', 'from the row', 'from Shift+Enter'])
    assert.deepEqual(waiting, [], 'the delivered row must not stay queued for another send')
    assert.equal(root.querySelectorAll('.msg').filter(node => node.classList.contains('me')).length, 3,
      'each accepted message paints once')
  } finally {
    root?.dispose()
    dom.restore()
  }
})

test('the actions button sits in the composer row and the popup closes honestly', async () => {
  assert.match(chat, /data-chat-actions/, 'the composer lost its actions button')
  /* Placement: after the mention button, before the input — "next to the
     attachments icon". Pinned by order of appearance in the template. */
  const template = chat.slice(0, chat.indexOf('const log ='))
  const attachAt = template.indexOf('data-chat-attach')
  const actionsAt = template.indexOf('data-chat-actions')
  const inputAt = template.indexOf('<input type="text"')
  assert.ok(attachAt < actionsAt && actionsAt < inputAt, 'the actions button left its place beside the attach and mention tools')
  assert.match(chat, /addEventListener\('pointerdown', onDocPointer, true\)/, 'the popup no longer closes on an outside press')
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn()
  const listeners = new Map()
  dom.document.addEventListener = (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener])
  dom.document.removeEventListener = (type, listener) => listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== listener))
  const { buildChat } = await import('../../src/components.js')
  let root
  try {
    root = buildChat({ title: 'agent', onSend: () => {}, actions: () => [{ id: 'inspect', label: 'Inspect', run: () => {} }] })
    dom.document.body.appendChild(root)
    const button = root.querySelector('[data-chat-actions]')
    button.dispatch('click')
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    let stopped = 0
    for (const listener of listeners.get('keydown') || []) listener({ key: 'Escape', stopPropagation: () => { stopped++ } })
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    assert.equal(stopped, 1, 'Escape closes one layer and does not reach the surrounding sheet')
    button.dispatch('click')
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    for (const listener of listeners.get('pointerdown') || []) listener({ target: dom.document.body })
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'an outside press closes the actual mounted popup')
  } finally {
    // Let the mounted component's already queued font-ready callback settle
    // before removing the DOM provided by this test.
    await dom.document.fonts.ready
    root?.dispose()
    dom.restore()
  }
  assert.match(chat, /'openActions'/, 'root.openActions vanished — the slash commands and palette ids have no door to the stages')
  /* Dispose tears the popup and the subscriptions down with the chat. */
  /* The WHOLE dispose body, located by its own closing brace. A fixed character
     window silently stopped covering the later teardown lines as dispose grew:
     measured 2026-09-09 at app 6909208e, statusUnsub sat at offset 1385 but
     queueUnsub at 1467 and chipsUnsub at 1519, so a 1400 window reported
     "dispose leaks the queue subscription" while dispose unsubscribes on the
     very next line. A pin that silently stops measuring is worse than no pin. */
  const disposeAt = chat.indexOf('const dispose = ()')
  const dispose = chat.slice(disposeAt, chat.indexOf('\n  }', disposeAt) + 4)
  assert.match(dispose, /closeActionsPop\(\)/, 'dispose leaves the popup standing over a dead chat')
  assert.match(dispose, /statusUnsub\?\.\(\)/, 'dispose leaks the status subscription')
  assert.match(dispose, /queueUnsub\?\.\(\)/, 'dispose leaks the queue subscription')
})

test('composer controls are not mislabeled as transcript tool-use rows', () => {
  const template = chat.slice(0, chat.indexOf('const log ='))
  assert.doesNotMatch(template, /class="chat-tool"/,
    'a composer control wears the transcript-row class and is measured as overlapping scrolled messages')
  assert.equal((template.match(/class="chat-composer-control"/g) || []).length, 3,
    'attach, mention, and actions must share the composer-control class')
})

test('the effort stage cannot restart without the token-cost sentence', () => {
  /* The warned-restart contract survives the move into the popup: the pick
     shows EFFORT_SWITCH.warn as the confirm row's hint, and only the confirm
     row's own press reaches resumeNodeSession. */
  const view = readFileSync(join(SRC, 'views', 'computers.js'), 'utf8')
  const effortStage = view.slice(view.indexOf('const effortRows'), view.indexOf('const modelRows'))
  assert.match(effortStage, /hint: EFFORT_SWITCH\.warn/, 'the depth confirm lost its token-cost warning')
  const warnAt = effortStage.indexOf('EFFORT_SWITCH.warn')
  const restartAt = effortStage.indexOf('resumeNodeSession')
  assert.ok(warnAt !== -1 && restartAt > warnAt, 'the restart comes before the warning — the pick restarts silently')
})

/* ==================================================================
   THE ACTIONS POPUP IS A COMMAND PALETTE, which is the substance of the
   owner's "this menu needs to be more like vscode, much more intuitive".

   Measured before this: the popup's entire keyboard handler was one line for
   Escape; rows were plain buttons reachable only by Tab or mouse; the filter
   carried no aria-controls, no aria-activedescendant and no arrow keys. What
   VS Code's quick pick has is not a look. It is that the whole thing is
   driven from the filter box and the row under the cursor is announced.

   Source pins, like the rest of this file: buildChat needs a DOM to run.
   tools/palette-keyboard-qa.mjs drives the real thing with real keys.
   ================================================================== */
const pop = chat.slice(chat.indexOf('THE ACTIONS POPUP'), chat.indexOf("Object.defineProperty(root, 'openActions'"))

test('the popup is driven from the filter: arrows move, Enter runs, Escape closes', () => {
  assert.ok(pop.length > 2000, 'the popup block could not be found')
  const keys = pop.slice(pop.indexOf('const onPopKeys'), pop.indexOf('const renderPopStage'))
  assert.ok(keys.length > 100, 'the keyboard model left the popup; only Escape is handled again')
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End']) {
    assert.ok(keys.includes(`event.key === '${key}'`), `${key} no longer does anything in the popup`)
  }
  assert.match(keys, /movePopActive\(1\)/, 'ArrowDown no longer moves the cursor down')
  assert.match(keys, /movePopActive\(-1\)/, 'ArrowUp no longer moves the cursor up')
  assert.match(keys, /runPopRow\(entry\)/, 'Enter no longer runs the active row')
  /* Escape stays at the document, in capture, so it works from wherever focus
     has wandered -- the row model is a superset of it, not a replacement. And
     it stops the event: one press, one layer. Without the stop, Escape over
     the popup also closed the layer behind it (the phone sheet, the agent
     rail) in the same key -- measured on the phone press-through 2026-08-27. */
  const escapeAt = pop.indexOf('const onPopKeydown = (event) => {')
  assert.ok(escapeAt !== -1,
    'the document-level Escape handler was removed; a person whose focus left the filter cannot close the popup')
  const escapeBody = pop.slice(escapeAt, pop.indexOf('closeActionsPop()', escapeAt) + 'closeActionsPop()'.length)
  assert.match(escapeBody, /event\.key !== 'Escape'/, 'the document handler stopped filtering for Escape')
  assert.match(escapeBody, /event\.stopPropagation\(\)/,
    'the popup Escape no longer stops the event, so one press collapses the popup AND the layer behind it')
  assert.match(pop, /popEl\.addEventListener\('keydown', onPopKeys\)/, 'the keyboard model is not bound to the popup')
})

test('the active row is announced: combobox over listbox with aria-activedescendant', () => {
  const template = pop.slice(pop.indexOf('popEl = el('), pop.indexOf('root.appendChild(popEl)'))
  assert.match(template, /role="combobox"/, 'the filter is not a combobox; assistive tech hears a plain text box')
  assert.match(template, /aria-controls="\$\{listId\}"/, 'the filter does not name the list it controls')
  assert.match(template, /role="listbox"/, 'the list is not a listbox')
  assert.match(pop, /setAttribute\('role', 'option'\)/, 'rows are not options; the active one cannot be announced')
  assert.match(pop, /setAttribute\('aria-activedescendant', activeId\)/, 'the active row is never named to assistive tech')
  assert.match(pop, /setAttribute\('aria-selected', on \? 'true' : 'false'\)/, 'the active row does not carry aria-selected')
  /* Stable ids for one opening, so a second chat's popup cannot collide. */
  assert.match(pop, /popSerial \+= 1/, 'ids are no longer per-opening')
  assert.match(pop, /chat-actions-opt-\$\{popSerial\}-\$\{index\}/, 'the option ids lost their per-opening family')
  assert.match(pop, /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/, 'the cursor can leave the visible rows')
})

test('rows are grouped, and headings are never options', () => {
  assert.match(pop, /row\.group/, 'the row shape lost its group field; the list is flat again')
  const heading = pop.slice(pop.indexOf("heading.className = 'chat-actions-group'"), pop.indexOf("heading.className = 'chat-actions-group'") + 300)
  assert.match(heading, /setAttribute\('role', 'presentation'\)/, 'a group heading is counted as an option')
  assert.match(pop, /group !== lastGroup/, 'a heading is emitted for every row rather than at each change of group')
  /* Arrow keys walk the row ARRAY, so a heading is skipped by construction. */
  assert.match(pop, /popRendered\.push\(entry\)/, 'rows are no longer collected into the walk order')
  assert.doesNotMatch(pop, /popRendered\.push\(\{ button: heading/, 'a heading was pushed into the walk order')
})

test('a disabled row shows why, and Enter on it speaks the reason', () => {
  assert.match(pop, /const why = disabled && typeof row\.disabledHint === 'string' \? row\.disabledHint : ''/,
    'a disabled row no longer reads its own reason')
  assert.match(pop, /hint\.textContent = why \|\| row\.hint/, 'the reason is not shown in place of the hint')
  assert.match(pop, /'chat-actions-hint chat-actions-why'/, 'the reason has no class of its own; the eye cannot tell it from a hint')
  const run = pop.slice(pop.indexOf('const runPopRow'), pop.indexOf('const paintPopActive'))
  assert.match(run, /if \(out && entry\.disabledHint\) out\.textContent = entry\.disabledHint/,
    'Enter on a disabled row is silent again')
})

test('the popup closes when focus leaves it, and only then', () => {
  assert.match(pop, /popEl\.addEventListener\('focusout', onPopFocusOut\)/, 'the popup no longer closes on focus loss')
  const out = pop.slice(pop.indexOf('const onPopFocusOut'), pop.indexOf('function closeActionsPop'))
  assert.match(out, /setTimeout\(/, 'the focus-out check is not deferred; hiding the filter on a sub-stage closes the whole popup')
  assert.match(out, /if \(popEl\.contains\(active\)\) return/, 'moving focus within the popup closes it')
  assert.match(out, /actionsButton\.contains\(active\)/, 'pressing the actions button to close it closes twice')
})
