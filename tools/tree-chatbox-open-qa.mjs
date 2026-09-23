#!/usr/bin/env node

/* DOES THE CHATBOX OPEN, ON EVERY STATE A NODE CAN BE IN?
 *
 * THE REPORT THIS ANSWERS. Owner, on the installed build: "The chatboxes also
 * dont open, we had this right in the past and it had the buttons in the chat
 * window so maybe it just got disabled on accident but thats a happy path i
 * want resolved."
 *
 * TWO SURFACES CARRY THAT NAME, and a driver that measures one and reports
 * about "the chatbox" is guessing. They are:
 *
 *   THE COMPACT CARD  the chip beside the circle. Pressing it expands the chip
 *                     into a chat (src/tree-graph.js openChat -> .as-chat).
 *   THE RAIL CHAT     the right-hand panel's Chat tab, opened by pressing the
 *                     circle itself (showTreeNodeControls -> [data-rail-chat-host]).
 *
 * A previous lane checked ONLY for `.as-chat` and missed that the rail had in
 * fact opened, so this one records both on every press, plus the buttons inside
 * whichever chat appeared. "It opened" is never asserted from one class name.
 *
 * THE FOUR STATES ARE SEEDED, NOT SIMULATED. A node's state lives in the
 * person's own saved record (src/fleet-trees.js, localStorage
 * `mc.fleet.trees.v1:<computerId>`), and a returning user's tree is read back
 * out of exactly that. Seeding it is how this run reaches a FINISHED and a
 * FAILED node without spending three real agent runs -- the product path from
 * storage to canvas to press is untouched, and the record written here is the
 * record the product itself writes. tools/claude-tree-start-proof.mjs is the
 * companion that starts a real agent and asks a different question.
 *
 * EVERY PRESS IS A REAL PRESS: move, down, up at coordinates taken from the
 * element's own box, with document.elementFromPoint checked first, and the
 * press refused BY NAME if something else is on top. No el.click(), no
 * dispatchEvent, no assigned .value.
 *
 *   node tools/tree-chatbox-open-qa.mjs
 *   node tools/tree-chatbox-open-qa.mjs --visible
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const findings = []
/* The negative control below is run once, on the first node that opens a card:
   it is a statement about the measurement, not about any one node. */
let controlProven = false
/* THE EXIT CODE IS SET WHEN THE FINDING IS MADE, not at the end.
 *
 * Measured on this driver 2026-08-18: a run that printed three FAIL lines
 * exited 0 and never reached its own summary. The teardown awaits
 * closeWindow(), a debugger call resolves only when the debugger answers and
 * never rejects when the socket is already gone, so the promise cannot
 * settle, Node's event loop empties and the process exits 0 with the verdict
 * unwritten. tools/uninstall-reset-packaged-qa.mjs carries the same hazard
 * and documents it. Recording the failure into process.exitCode at the
 * moment it is observed means the worst this can now do is lose the summary,
 * never the answer. */
const note = (level, text) => {
  findings.push({ level, text })
  if (level === 'FAIL') process.exitCode = 1
  console.log(`  ${level.padEnd(5)} ${text}`)
}

/* The four states, and what each one is meant to prove. `running` is stored and
   comes back as `starting` by design (src/fleet-trees.js: nothing comes back off
   disk running), which is the state a person finds after a restart and still the
   state that holds a session id. */
const SEEDED = [
  { key: 'started', status: 'running', sessionId: 'sess-started-1', tier: 'claude-sonnet', message: 'Read the build log and tell me what broke.', reply: '' },
  { key: 'finished', status: 'finished', sessionId: 'sess-finished-1', tier: 'luna', message: 'Summarise the release notes.', reply: 'The release notes name three fixes and one known issue.' },
  { key: 'failed', status: 'failed', sessionId: 'sess-failed-1', tier: 'sol', message: 'Run the packaging step.', reply: '' },
  /* THE STATE THE OWNER IS ACTUALLY IN, and the one the first version of this
     file left out. submitCompose() marks a node `failed` and leaves sessionId
     NULL when the start itself is refused -- which is every start on a build
     that answers AGENT_TIER_NO_LAUNCHER. A person whose starts are all refused
     has a tree made entirely of these. */
  { key: 'refused', status: 'failed', sessionId: null, tier: 'claude-opus', message: 'Read the release notes and summarise them.', reply: '' },
  /* No tier at all: the record a person made before tiers were kept. The Engine
     row must say so rather than naming a default nobody picked. */
  { key: 'draft', status: 'draft', sessionId: null, tier: '', message: 'Draft: nothing has been started for this one yet.', reply: '' },
]

/* A read that THREW is not a read that found nothing, and the first version of
   this driver could not tell them apart: a syntax error in the page expression
   returned `undefined` for every field and the report read as four dead states.
   Anything that comes back from the harness carrying __evaluateThrew is raised
   as a driver fault here, never printed as a product finding. */
function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (!value || typeof value !== 'object') throw new Error(`the page expression for ${what} answered ${JSON.stringify(value)}`)
  return value
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
}

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(600)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

/* WHAT IS ON THE GLASS AFTER A PRESS, read from both surfaces at once so a
   report can never say "the chatbox did not open" about the surface it did not
   look at. `buttons` is the list of pressable controls INSIDE whichever chat
   appeared -- the owner's "it had the buttons in the chat window". */
const READ_CHAT = `function readChat(nodeId) {
  const describe = (chat) => {
    if (!chat) return null
    const named = [...chat.querySelectorAll('button')].map(b => ({
      hook: b.dataset.chatAttach !== undefined ? 'attach'
        : b.dataset.chatMention !== undefined ? 'mention'
        : b.dataset.chatActions !== undefined ? 'actions'
        : b.classList.contains('chat-send') ? 'send'
        : b.classList.contains('chat-close') ? 'close'
        : b.classList.contains('chat-queue-cancel') ? 'unqueue'
        : (b.className || 'unnamed'),
      label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40),
    }))
    const input = chat.querySelector('.chat-input input')
    return {
      messages: chat.querySelectorAll('.msg').length,
      said: [...chat.querySelectorAll('.msg')].map(m => (m.textContent || '').trim().slice(0, 80)),
      hasComposer: Boolean(input),
      inputDisabled: Boolean(input && input.disabled),
      cannotSend: chat.classList.contains('chat-cannot-send'),
      nosend: (chat.querySelector('.chat-nosend')?.textContent || '').trim().slice(0, 160),
      readonly: chat.classList.contains('chat-readonly'),
      popRows: [...chat.querySelectorAll('.chat-actions-pop .chat-actions-row')]
        .map(r => (r.querySelector('span, b')?.textContent || r.textContent || '').trim().slice(0, 40)),
      buttons: named,
    }
  }
  const chip = document.querySelector('.chip[data-agent-id="' + nodeId + '"]')
  const railHost = document.querySelector('[data-rail-chat-host]')
  const railBody = document.querySelector('[data-rail-body="chat"]')
  return {
    chipPresent: Boolean(chip),
    chipAsChat: Boolean(chip && chip.classList.contains('as-chat')),
    chipChat: describe(chip && chip.querySelector('.chat')),
    railOpen: Boolean(document.querySelector('.ctl-page.is-active')),
    railChatHost: Boolean(railHost),
    railChat: describe(railHost && railHost.querySelector('.chat')),
    railChatTabWords: railBody ? (railBody.innerText || '').trim().slice(0, 200) : null,
  }
}`

/* CAN THE SEND BUTTON BE PRESSED, MEASURED IN POINTS RATHER THAN IN CLASSES?
 *
 * The compact card is `overflow: hidden` and is far narrower than the page
 * composer .chat-input was written for. `.chat-input input` carried `flex: 1`
 * and no `min-width`, so it kept its default `min-width: auto` -- the field's
 * MIN-CONTENT width, which is the widest word of its placeholder
 * ("Message <agent name>...") -- and refused to shrink. The row then overflowed
 * the card and Send was pushed past the clipped edge: present in the DOM,
 * carrying its aria-label, counted by every check that asks whether the button
 * EXISTS, and unpressable by a person.
 *
 * So this asks the only question that distinguishes those two worlds: over a
 * 9x5 grid inside the button's own box, does a press at that point reach the
 * button? `document.elementFromPoint` answers for the real compositor, and the
 * rule is the harness's own -- the target itself or one of its descendants,
 * never an ancestor, because a click bubbles UP from what it hits.
 *
 * The button's box is ALSO compared against the card's clipped box, so a
 * failure says which of the two it is: covered by something, or outside the
 * card entirely. A disabled Send is measured exactly the same way -- nothing in
 * the stylesheet takes its pointer events away, and a person on a node that
 * cannot send still has to be able to see where the control is. */
const SEND_REACH = `function sendReach(nodeId) {
  const chip = document.querySelector('.chip[data-agent-id="' + nodeId + '"]')
  const card = chip && chip.querySelector('.chat')
  const button = chip && chip.querySelector('.chat-send')
  if (!chip || !card || !button) return { points: 0, hits: 0, absent: true }
  const box = button.getBoundingClientRect()
  const cardBox = chip.getBoundingClientRect()
  /* SAMPLED INSIDE THE SHAPE, NOT ACROSS THE BOUNDING BOX.
     The first version put its outermost points one pixel in from each edge and
     reported 44/45 with the miss always at the same corner, hitting
     DIV.chat-input -- the row behind the button. That is not a defect: this
     control is rounded and its box's corner belongs to whatever is underneath,
     and a fractional layout box puts the last column a fraction outside the
     painted edge. An instrument that calls a rounded corner a clipped button
     is manufacturing reds. The grid therefore spans the middle 80% in each
     direction -- for this 38px button that is a ~3.8px margin, clear of both
     the 3px corner radius and any subpixel edge -- and still walks the whole
     face, which is what the measurement is about. */
  const points = []
  for (let column = 0; column < 9; column += 1) {
    for (let row = 0; row < 5; row += 1) {
      points.push({
        x: box.left + box.width * (0.1 + (0.8 * column) / 8),
        y: box.top + box.height * (0.1 + (0.8 * row) / 4),
      })
    }
  }
  const missed = []
  let hits = 0
  for (const point of points) {
    const hit = document.elementFromPoint(point.x, point.y)
    if (hit && (hit === button || button.contains(hit))) { hits += 1; continue }
    missed.push({
      x: Math.round(point.x), y: Math.round(point.y),
      hit: hit ? hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nothing',
    })
  }
  return {
    points: points.length,
    hits,
    missed: missed.slice(0, 4),
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    card: { x: Math.round(cardBox.x), y: Math.round(cardBox.y), w: Math.round(cardBox.width), h: Math.round(cardBox.height) },
    insideCard: box.right <= cardBox.right + 0.5 && box.left >= cardBox.left - 0.5,
    disabled: button.disabled === true,
  }
}`

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'tree-chatbox-qa-'))
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)
    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)

    /* The write switch ships off, so a fresh profile refuses every start. Seeded
       for the same reason the shared harness seeds the machine record: a person
       who has a tree with agents in it has already turned it on, and driving the
       Settings toggle is a different question with its own coverage. */
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1000)
    await window.evaluate(`location.reload()`)
    await delay(3800)

    const computerId = await window.evaluate(`window.__mcGraph?.computer?.id || null`)
    if (!computerId) {
      note('FAIL', 'HARNESS STATE: the computers page never handed the graph a computer, so nothing below would be about a tree.')
      return
    }
    note('info', `the page is showing computer ${JSON.stringify(computerId)}`)

    const stamp = new Date().toISOString()
    const record = {
      version: 1,
      computerId,
      trees: [{ id: 'tree-chatbox-qa', name: 'Chatbox states', createdAt: stamp, updatedAt: stamp, profileId: null }],
      nodes: SEEDED.map((seed, index) => ({
        id: `node-${seed.key}`,
        treeId: 'tree-chatbox-qa',
        parentId: index === 0 ? null : 'node-started',
        role: index === 0 ? 'coordinator' : 'worker',
        message: seed.message,
        status: seed.status,
        statusNote: seed.key === 'refused'
          ? 'Nothing was started. This copy of ToolsEnabled does not carry the part that runs a Claude agent.'
          : seed.status === 'failed' ? 'The packaging step refused to run.' : '',
        reply: seed.reply,
        tier: seed.tier,
        sessionId: seed.sessionId,
        createdAt: stamp,
        updatedAt: stamp,
      })),
    }
    await window.evaluate(`localStorage.setItem(${JSON.stringify(`mc.fleet.trees.v1:${computerId}`)}, ${JSON.stringify(JSON.stringify(record))})`)
    await window.evaluate(`location.reload()`)
    /* WAIT FOR THE LAYOUT, NOT FOR THE CLOCK. This was a flat delay(4200), and
       on the 2026-08-19 re-cut confirming run -- the machine churning under the
       whole packaged suite -- 4.2s bought a canvas with every circle on ONE
       row (presses at y=474 for all five; this page does not scroll, so those
       are real positions) and the overlap engine culling three of the five
       chips, which this driver then reported as "NO CARD" about a product
       whose layout had simply not arrived. Alone on the same tree the same
       day: two rows, all five chips offered, 54/54 -- and the layout and
       culling engines (src/tree-graph.js/.css) have no commit in the window
       the red was blamed on. The mechanism is the one tools/page2-qa.cjs
       documents: a window that is never composited measures its container
       late, and layout work lands whenever the machine lets it.
       So the instrument waits for what it is about to measure: every seeded
       node drawn, more than one row (this seed is a root with four children;
       one row IS the not-yet-laid-out state), and positions still across two
       samples. If that never comes, it refuses as HARNESS STATE, naming what
       the canvas showed -- it does not fail the product over the weather, and
       it does not press circles whose positions are still moving. Every
       product assertion below is unchanged and now runs on a canvas that is
       actually finished drawing. */
    const layout = await (async () => {
      const deadline = Date.now() + Number(process.env.TCB_LAYOUT_DEADLINE_MS || 25000)
      let previous = null
      let sample = null
      for (;;) {
        sample = await window.evaluate(`(() => {
          const nodes = [...document.querySelectorAll('.node[data-agent-id]')]
          const boxes = nodes.map(n => { const b = n.getBoundingClientRect(); return [n.dataset.agentId, Math.round(b.x), Math.round(b.y)].join('@') })
          const rows = new Set(nodes.map(n => Math.round(n.getBoundingClientRect().y / 24))).size
          return { count: nodes.length, rows, print: boxes.join('|') }
        })()`)
        const moving = !sample || previous !== sample.print
        const ready = sample && sample.count === SEEDED.length && sample.rows >= 2 && !moving
        if (ready) return { ok: true, moving: false, ...sample }
        if (Date.now() > deadline) return { ok: false, moving, ...(sample || {}) }
        previous = sample ? sample.print : null
        await delay(400)
      }
    })()
    if (!layout.ok) {
      note('FAIL', `HARNESS STATE: the canvas never finished laying out (${layout.count ?? '?'} of ${SEEDED.length} node(s), ${layout.rows ?? '?'} row(s), still moving=${layout.moving}). Nothing below would have been a measurement of the product.`)
      return
    }

    const drawn = await window.evaluate(`(() => {
      const ids = [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId)
      const chips = [...document.querySelectorAll('.chip[data-agent-id]')].map(n => n.dataset.agentId)
      return { ids, chips }
    })()`)
    const seededDrawn = SEEDED.filter(seed => drawn.ids.includes(`node-${seed.key}`))
    if (seededDrawn.length !== SEEDED.length) {
      note('FAIL', `HARNESS STATE: only ${seededDrawn.length}/${SEEDED.length} seeded nodes reached the canvas (${JSON.stringify(drawn.ids)}). The saved record was refused; nothing below is a measurement of the product.`)
      return
    }
    note('ok', `all four states are on the canvas: ${JSON.stringify(drawn.ids)}`)
    note('info', `chips drawn for: ${JSON.stringify(drawn.chips)}`)

    for (const seed of SEEDED) {
      const nodeId = `node-${seed.key}`
      console.log(`\n[${seed.key}] (stored ${seed.status})`)
      /* An open card sits ON TOP of the next circle -- measured: the second
         node's press came back "covered by DIV.chip". Escape is the graph's own
         close gesture (_escapeTopChat), so the reset is a real keystroke. */
      await key(window, 'Escape', 27)
      await delay(700)

      /* THE CIRCLE FIRST -- the gesture the owner uses. One click opens the
         rail, which is where the tree node's real conversation lives. */
      const bubble = await press(window, `.node[data-agent-id="${nodeId}"]`)
      note(bubble.pressed ? 'ok' : 'FAIL',
        `pressed the circle${bubble.pressed ? ` at (${bubble.at.x}, ${bubble.at.y})` : `: ${bubble.why}`}`)
      const afterBubble = readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the state after the circle press')
      note(afterBubble.railChat ? 'ok' : 'FAIL',
        `circle -> rail chat: ${afterBubble.railChat
          ? `${afterBubble.railChat.messages} message(s), composer=${afterBubble.railChat.hasComposer}, buttons=${JSON.stringify(afterBubble.railChat.buttons.map(b => b.hook))}`
          : `NO CHAT. railOpen=${afterBubble.railOpen} host=${afterBubble.railChatHost} words=${JSON.stringify(afterBubble.railChatTabWords)}`}`)

      /* THE OWNER'S SECOND HALF: "it had the buttons in the chat window". The
         rail carried the actions button all along; the compact card did not.
         Both are checked by name on every state. */
      if (afterBubble.railChat) {
        const hooks = afterBubble.railChat.buttons.map(b => b.hook)
        note(hooks.includes('actions') ? 'ok' : 'FAIL', `rail chat carries the actions button: ${JSON.stringify(hooks)}`)
      }

      /* THEN THE CHIP -- the compact card on the canvas. */
      const chip = await press(window, `.chip[data-agent-id="${nodeId}"]`, 5000)
      const afterChip = readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the state after the chip press')
      note(chip.pressed ? 'ok' : 'info',
        `pressed the chip${chip.pressed ? ` at (${chip.at.x}, ${chip.at.y})` : `: ${chip.why}`}`)
      note(afterChip.chipChat ? 'ok' : 'FAIL',
        `chip -> compact card: ${afterChip.chipChat
          ? `${afterChip.chipChat.messages} message(s), composer=${afterChip.chipChat.hasComposer}, buttons=${JSON.stringify(afterChip.chipChat.buttons.map(b => b.hook))}`
          : `NO CARD. as-chat=${afterChip.chipAsChat} chipPresent=${afterChip.chipPresent} (the rail is ${afterChip.railChat ? 'showing a chat' : 'not showing a chat'})`}`)

      if (afterChip.chipChat) {
        const hooks = afterChip.chipChat.buttons.map(b => b.hook)
        /* THE ASSERTION THAT FAILS ON THE OLD CODE. src/tree-graph.js used to
           hand buildChat a hand-picked six fields, so `actions` -- added to the
           SHARED config at 7cce02c and taken up by the rail the same day --
           never reached the card. Measured absent on 4a839f3, present here. */
        note(hooks.includes('actions') ? 'ok' : 'FAIL', `compact card carries the actions button: ${JSON.stringify(hooks)}`)

        /* AND THE BUTTON IS PRESSED, not merely counted. A control that is in
           the DOM and opens nothing is the same defect wearing a passing test. */
        /* THE COMPOSER'S PROMISE, PER STATE, read BEFORE the popup is opened.
           The first version read it after an Escape -- and Escape closes the
           card itself (the graph's _escapeTopChat), so it was measuring an
           element that had just been removed and printing `undefined` as a
           product finding. A node with a session may be typed into; one
           without must say why it cannot, with a box that is genuinely
           disabled rather than merely styled that way. */
        const card = afterChip.chipChat
        if (seed.sessionId) {
          note(card.hasComposer && !card.inputDisabled ? 'ok' : 'FAIL',
            `the card can be typed into: composer=${card.hasComposer} disabled=${card.inputDisabled}`)
        } else {
          note(card.cannotSend && card.inputDisabled && card.nosend ? 'ok' : 'FAIL',
            `the card refuses to send and says why: disabled=${card.inputDisabled} said=${JSON.stringify(card.nosend || '')}`)
        }

        /* THE CLIPPED SEND BUTTON, measured before anything is pressed. */
        const reach = readOrThrow(await window.evaluate(`(${SEND_REACH})(${JSON.stringify(nodeId)})`), 'the send button reach')
        note(reach.points > 0 && reach.hits === reach.points ? 'ok' : 'FAIL',
          `the card's Send button is reachable: ${reach.hits}/${reach.points} hit points`
          + `${reach.absent ? ' — NO SEND BUTTON IN THE CARD' : ''}`
          + ` (button ${JSON.stringify(reach.box)} in card ${JSON.stringify(reach.card)}, `
          + `insideCard=${reach.insideCard}, disabled=${reach.disabled})`
          + `${reach.missed && reach.missed.length ? ` missed: ${JSON.stringify(reach.missed)}` : ''}`)

        /* THE NEGATIVE CONTROL, REBUILT ON THE SPOT.
         *
         * 45/45 is only worth reading if the same instrument can be made to
         * report the defect. `min-width: 0` in src/styles.css is the whole fix,
         * so putting `auto` back on this one field restores the exact
         * pre-fix layout -- the field refuses to shrink below its placeholder's
         * min-content width and pushes Send past the card's clipped edge -- and
         * the count has to fall. It is set inline on ONE card, measured, and
         * removed again, so nothing after this line is measured on a page this
         * driver changed. Run once, on the first state that has a card.
         */
        if (!controlProven) {
          await window.evaluate(`(() => {
            const input = document.querySelector('.chip[data-agent-id="${nodeId}"] .chat-input input')
            if (!input) return false
            input.style.minWidth = 'auto'
            return true
          })()`)
          await delay(260)
          const broken = readOrThrow(await window.evaluate(`(${SEND_REACH})(${JSON.stringify(nodeId)})`), 'the send button reach with the fix removed')
          await window.evaluate(`(() => {
            const input = document.querySelector('.chip[data-agent-id="${nodeId}"] .chat-input input')
            if (input) input.style.minWidth = ''
            return true
          })()`)
          await delay(260)
          const restored = readOrThrow(await window.evaluate(`(${SEND_REACH})(${JSON.stringify(nodeId)})`), 'the send button reach after restoring the fix')
          controlProven = true
          note(broken.hits < broken.points && restored.hits === restored.points ? 'ok' : 'FAIL',
            `the measurement can still see the defect: with the field's min-width put back to auto, `
            + `${broken.hits}/${broken.points} hit points (button ${JSON.stringify(broken.box)}, insideCard=${broken.insideCard}); `
            + `restored, ${restored.hits}/${restored.points}`)
        }

        const opened = await press(window, `.chip[data-agent-id="${nodeId}"] [data-chat-actions]`, 5000)
        const afterActions = readOrThrow(await window.evaluate(`(${READ_CHAT})(${JSON.stringify(nodeId)})`), 'the state after the actions press')
        const rows = afterActions.chipChat?.popRows || []
        note(opened.pressed && rows.length > 0 ? 'ok' : 'FAIL',
          `pressed the card's actions button${opened.pressed ? '' : `: ${opened.why}`} -> ${rows.length} row(s): ${JSON.stringify(rows.slice(0, 4))}`)
        await key(window, 'Escape', 27)
        await delay(300)
      }

      /* THE ENGINE ROW ON THE SAME PANEL, read where a person reads it. The
         owner reported the tree panel naming Codex as the engine on a build
         that starts Claude; the row is derived from the shell's own answer
         now, and this is where that is seen rather than argued. Real press on
         the Details tab, then read the two lines out of the Setup box. */
      const detailsPressed = await press(window, '[data-rail-tab="details"]', 5000)
      const engine = readOrThrow(await window.evaluate(`(function readEngine() {
        const rows = [...document.querySelectorAll('[data-tree-move] .ctl-row')]
        const row = rows.find(r => (r.querySelector('.cl')?.textContent || '').trim() === 'Engine')
        const note = document.querySelector('[data-tree-move] .board-absent-copy')
        return {
          label: (row?.querySelector('.cv')?.textContent || '').trim(),
          note: (note?.textContent || '').trim().slice(0, 200),
        }
      })()`), 'the engine row')
      note(detailsPressed.pressed && engine.label ? 'ok' : 'FAIL',
        `Details -> Engine: ${JSON.stringify(engine.label)} / ${JSON.stringify(engine.note)}`)

      /* Close whatever opened so the next node starts from the same place --
         with a real press on the card's own Collapse button, never a synthetic
         event. Absent when no card opened, which is itself the finding above. */
      if (afterChip.chipChat) await press(window, `.chip[data-agent-id="${nodeId}"] .chat-close`, 3000)
      await delay(300)
    }
  } finally {
    if (window) {
      /* BOUNDED. See the note on `note` above: an unbounded await here is what
         swallowed a whole run's verdict. Reaping by pid is what actually ends
         the process, and it does not need the debugger's cooperation. */
      await Promise.race([
        closeWindow(window).catch(() => {}),
        delay(15_000),
      ])
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }

  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
