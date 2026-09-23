/* GETTING A NODE ONTO THE FLEET PAGE, THE WAY A PERSON GETS ONE.
 *
 * WHY FOUR DRIVERS SHARE THIS. team-panel-packaged-qa, loop-packaged-qa,
 * example-page-write-fence-qa and refusal-copy-qa each need the SAME
 * precondition -- a node on the live board, selected, with its rail open --
 * and each of them used to assume that precondition instead of establishing
 * it. All four reported the same absence from four directions ("clicking an
 * agent opens the rail board: absent", "UNMEASURED -- the control could not be
 * reached") because on a sterile profile the board opens with an EMPTY tree,
 * which is the owner's own rule for it: "the node tree should be empty unless a
 * user has started a session". Four private copies of this walk would drift;
 * one copy is one thing to keep true.
 *
 * WHAT IT COSTS: NOTHING, AND THAT IS MEASURED RATHER THAN HOPED FOR. The walk
 * ends at "Start this agent" on a profile whose CODEX_HOME is an empty scratch
 * directory, so the shell answers AGENT_CONFINEMENT_SIGNED_OUT and no child
 * process, no provider call and no token is ever spent. The node is created
 * BEFORE the engine is asked (src/views/computers.js writes the draft through
 * fleet-trees.js and only then calls the bridge), so a refused start still
 * leaves exactly what these drivers need: a real node, drawn by the product,
 * carrying the product's own refusal. A harness that needed a signed-in engine
 * to measure a panel's copy would be a harness nobody could run.
 *
 * REAL INPUT ONLY. Every press is a CDP mouse event at a point that
 * elementFromPoint says belongs to the target -- an ancestor hit is refused as
 * `own-ancestor-<tag>`, because a press the control never felt reported as
 * "clicked" is a silent false green. The role <select> is answered the way the
 * rules require: press, Escape the native popup, arrow, Enter. Nothing here
 * assigns a `.value` or calls `.click()`.
 */

export const FLEET_NODE_VISIBLE = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  if (node.matches(':disabled') || node.closest('[inert], [aria-disabled="true"]')) return { state: 'disabled' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden') return { state: 'hidden' }
  for (let current = node; current; current = current.parentElement) {
    if (Number(getComputedStyle(current).opacity) === 0) return { state: 'hidden' }
  }
  try { node.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) { /* detached */ }
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { state: 'offscreen' }
  const hit = document.elementFromPoint(x, y)
  if (!hit) return { state: 'covered', by: 'nothing' }
  const labelFor = hit.closest ? hit.closest('label') : null
  const receives = hit === node || node.contains(hit) || (labelFor && labelFor.control === node)
  if (!receives) {
    const name = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    return { state: 'covered', by: hit.contains(node) ? ('own-ancestor-' + name) : name }
  }
  return { state: 'visible', x, y }
}`

const KEYS = {
  Escape: 27,
  ArrowDown: 40,
  Enter: 13,
}

/* Shared bounded input timing for Page 2. Fixed sleeps made the walk both
   slow on a ready page and flaky while a dialog was still painting. The
   MutationObserver quiet window below adapts to actual DOM work without ever
   waiting forever. */
export const FLEET_INPUT_TIMING = Object.freeze({
  visiblePollMs: 80,
  pressQuietMs: 120,
  pressBudgetMs: 900,
  keyQuietMs: 100,
  keyBudgetMs: 600,
  typeQuietMs: 80,
  typeBudgetMs: 500,
})
// Input settling follows the control that received the gesture. Streaming
// transcripts elsewhere on the page must not spend every input's full budget.
// Callers still wait explicitly for the next route, dialog, or reply they need.
export const INPUT_UI_QUIET = `((quietMs, budgetMs, selector = null) => new Promise(resolve => {
  const started = Date.now()
  let last = started, observed = null, geometry = '', hit = null
  const observer = new MutationObserver(() => { last = Date.now() })
  const sample = () => {
    const target = selector ? document.querySelector(selector) : document.activeElement
    const node = target && target !== document.body && target !== document.documentElement ? target : null
    if (node !== observed) {
      observer.disconnect()
      observed = node
      last = Date.now()
      if (node) observer.observe(node, { childList: true, subtree: true, attributes: true, characterData: true })
    }
    const box = node?.getBoundingClientRect()
    const nextGeometry = box ? [box.x, box.y, box.width, box.height, node.value, node.checked].join('|') : ''
    const nextHit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null
    if (nextGeometry !== geometry || nextHit !== hit) { geometry = nextGeometry; hit = nextHit; last = Date.now() }
  }
  const tick = () => {
    sample()
    const now = Date.now(), settled = now - last >= quietMs
    if (settled || now - started >= budgetMs) {
      observer.disconnect()
      resolve({ waitedMs: now - started, settled, reason: settled ? 'quiet' : 'budget' })
      return
    }
    setTimeout(tick, Math.min(40, Math.max(10, quietMs / 3)))
  }
  sample()
  setTimeout(tick, Math.min(40, Math.max(10, quietMs / 3)))
}))`

export const INPUT_METRIC_LIMIT = 256
export function recordInputMetric(telemetry, entry, settled) {
  telemetry.push({ ...entry, waitedMs: Number(settled?.waitedMs) || 0,
    settled: settled?.settled === true, reason: settled?.reason === 'quiet' ? 'quiet' : settled?.reason === 'budget' ? 'budget' : 'unreported' })
  if (telemetry.length > INPUT_METRIC_LIMIT) telemetry.splice(0, telemetry.length - INPUT_METRIC_LIMIT)
}

/**
 * Press the empty slot, answer the panel, start, and open the node's rail.
 *
 * @param session  the CDP session (needs .send)
 * @param evaluate expression -> value, awaiting promises
 * @param delay    ms -> promise
 * @param brief    what to type into the panel's own message field
 * @returns {{ok: boolean, at: string, detail: string}} `at` names the step that
 *          ended the walk, so a failure says WHICH gesture stopped working
 *          rather than "absent".
 */
export function createPresser({ session, evaluate, delay, timing: timingOverride } = {}) {
  if (!session || typeof session.send !== 'function' || typeof evaluate !== 'function' || typeof delay !== 'function') throw new Error('createPresser requires session, evaluate and delay')
  const timing = { ...FLEET_INPUT_TIMING }
  for (const key of Object.keys(FLEET_INPUT_TIMING)) { const value = Number(timingOverride?.[key]); if (Number.isFinite(value) && value >= 0) timing[key] = Math.min(10_000, value) }
  const telemetry = []
  const visible = async (selector, timeoutMs = 12_000) => {
    const until = Date.now() + timeoutMs
    let last = { state: 'absent' }
    for (;;) {
      last = await evaluate(`(${FLEET_NODE_VISIBLE})(${JSON.stringify(selector)})`)
      if (last?.state === 'visible' || Date.now() >= until) return last
      await delay(timing.visiblePollMs)
    }
  }
  const press = async (selector, timeoutMs = 12_000) => {
    const spot = await visible(selector, timeoutMs)
    if (spot?.state !== 'visible') return spot?.state === 'covered' ? `covered-by-${spot.by}` : (spot?.state || 'unknown')
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.pressQuietMs}, ${timing.pressBudgetMs}, ${JSON.stringify(selector)})`)
    recordInputMetric(telemetry, { kind: 'press', selector }, settled)
    return 'clicked'
  }
  const key = async name => {
    const code = KEYS[name]
    if (code === undefined) throw new Error(`fleet-node key() does not know \"${name}\"`)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, code: name, key: name })
    }
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.keyQuietMs}, ${timing.keyBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'key', name }, settled)
  }
  const type = async text => {
    await session.send('Input.insertText', { text })
    const settled = await evaluate(`${INPUT_UI_QUIET}(${timing.typeQuietMs}, ${timing.typeBudgetMs})`)
    recordInputMetric(telemetry, { kind: 'type', chars: String(text).length }, settled)
  }
  return { visible, press, key, type, metrics: () => telemetry.map(item => ({ ...item })), timing: Object.freeze({ ...timing }) }
}

export async function startFleetNode({ session, evaluate, delay, brief = 'Say ok and stop.' }) {
  const { visible, press, key, type } = createPresser({ session, evaluate, delay })
  const stop = (at, detail) => ({ ok: false, at, detail: String(detail) })

  const alreadyThere = await evaluate(`document.querySelectorAll('.computers .static-tree-node').length`)
  if (!alreadyThere) {
    const slot = await press('.computers .tree-empty-node')
    if (slot !== 'clicked') return stop('the empty slot on the canvas', slot)

    /* THIS WALK STILL CHOOSES A ROLE, AND IT NO LONGER HAS TO.
       The panel used to refuse a start with no role and say so ("Pick a role
       first, then press Start"), which is how this walk learned it was skipping
       a step. That requirement was retired on 2026-08-19 (owner: "users
       shouldnt be forced to choose a role") -- the first row of the menu is now
       a real answer meaning no role, and Start works on it.
       The step is KEPT anyway, deliberately: these drivers exist to walk the
       path a person walks, and the menu is still offered first, so exercising
       it measures more of the panel than skipping it would. What changed is
       what a failure here MEANS. An empty role is no longer a product refusal;
       if the arrows below never take a value, that is this harness failing to
       drive a native <select>, and the stop sentence says so. */
    /* THE DISABLED-SELECT TRAP, MEASURED 2026-08-20, and it made this helper
       accuse the product of a defect it did not have.
​
       On a profile where "running agents" has never been switched on, the role
       <select> carries all six options and is DISABLED. A press on a disabled
       control takes no focus -- so the Escape below, meant for the native popup,
       had nothing focused to land on, bubbled to the panel root, and (since
       3457cfa taught Escape to cancel the start panel however it was opened)
       CLOSED THE WHOLE PANEL. The walk then fell through to "the selector still
       has no value", which reads as a product defect and is not one: measured
       with a standalone probe, the panel goes true -> false across that Escape,
       and ArrowDown never takes a value because the control is disabled.
​
       At least four drivers reach the board through this helper, so the failure
       was reproducible, misleading, and about to be reported as a finding by a
       continuous walker. Refusing here with the real reason is the fix: the
       helper does NOT switch the flag on by itself, because turning on a
       product capability is a decision a driver must make deliberately and say
       it made, not something a shared helper does silently to get past a step. */
    const roleReady = JSON.parse(await evaluate(`(() => {
      const select = document.querySelector('[data-compose-field="role"]')
      if (!select) return JSON.stringify({ present: false })
      return JSON.stringify({ present: true, disabled: Boolean(select.disabled), options: select.options.length })
    })()`))
    if (!roleReady.present) return stop('the role selector in the start panel', 'no [data-compose-field="role"] on the page')
    if (roleReady.disabled) {
      return stop('choosing a role in the start panel',
        `the role selector is DISABLED on this profile (${roleReady.options} options present), which is the product`
        + ' behaving correctly: running agents is switched off. Turn it on first -- the panel offers'
        + ' "Turn on running agents" -- and say in the report that the driver did so. This is NOT a product defect.')
    }

    const roleSelect = await press('[data-compose-field="role"]')
    if (roleSelect !== 'clicked') return stop('the role selector in the start panel', roleSelect)
    /* PRESS -> ESCAPE -> ARROWS, and the arrows are RETRIED rather than sent
       once. A native <select> popup opens on its own schedule inside a window
       started with `show: false`; measured here, a single Escape+ArrowDown
       landed before the popup existed about half the time and left the field
       empty, which this walk then reported as "the selector still has no
       value" -- a harness race wearing a product defect's words. Each pass
       reads the field back, so the loop ends on the first arrow that took. */
    const roleValue = async () => evaluate(`document.querySelector('[data-compose-field="role"]')?.value || ''`)
    await delay(500)
    await key('Escape')
    let role = await roleValue()
    for (let attempt = 0; attempt < 8 && !role; attempt += 1) {
      await key('ArrowDown')
      await delay(200)
      role = await roleValue()
    }
    await key('Enter')
    await delay(200)
    role = await roleValue()
    if (!role) {
      const where = await evaluate(`(() => {
        const select = document.querySelector('[data-compose-field="role"]')
        const active = document.activeElement
        return JSON.stringify({
          options: [...(select?.options || [])].map(o => o.value),
          disabled: select ? select.disabled : null,
          focused: active ? (active.tagName + '/' + (active.getAttribute('data-compose-field') || active.className || '')) : null,
        })
      })()`)
      /* NOT A PRODUCT REFUSAL. An empty role is a valid draft since 2026-08-19;
         what failed is this harness's own way of answering a native <select>. */
      return stop('choosing a role with the keyboard',
        `the arrows never moved the selector off its first row, which is a harness failure`
        + ` driving a native select and NOT the panel refusing an empty role -- an empty role`
        + ` starts fine now; ${where}`)
    }

    const messageField = await press('[data-compose-field="message"]')
    if (messageField !== 'clicked') return stop('the brief field in the start panel', messageField)
    await type(brief)

    const start = await press('[data-compose-action="start"]')
    if (start !== 'clicked') return stop('the Start control in the panel', start)
    /* The draft is written before the bridge is called, so the node is on the
       canvas whether the engine answers or refuses. */
    const drawn = await visible('.computers .static-tree-node', 20_000)
    if (drawn?.state !== 'visible') {
      const said = await evaluate(`document.querySelector('[data-compose-status]')?.textContent.trim().slice(0, 300) || ''`)
      return stop('the node appearing on the canvas', `${drawn?.state}; the panel said: ${JSON.stringify(said)}`)
    }
  }

  const opened = await press('.computers .static-tree-node')
  if (opened !== 'clicked') return stop('opening the node rail', opened)
  /* The rail opens on its Chat tab, which is right: the first thing a person
     wants from an agent they just started is what it is saying. Launch, Team,
     Loop and Codex Cloud live on the other half with the rest of the controls
     that describe the node rather than the conversation, so this walk presses
     the tab a person presses. It is a real press on a real tab, and the tab
     stays where it was put -- the bodies are persistent and only [hidden]
     moves, so nothing below is re-rendered by it. */
  const details = await press('[data-rail-tab="details"]')
  if (details !== 'clicked') return stop('the Details tab on the node rail', details)
  /* AND THEN THE DISCLOSURE, because Launch, Team, Loop and Codex Cloud now sit
     inside one collapsed group ("Start more work"). They measured 2821px of the
     Details tab's 3825px scroll at 1440x900 -- 74% of it -- which is why they
     are behind a press; nothing was removed, and every one of these drivers
     still reaches the same four boxes.
     A PRESS, NOT A FLAG. The group remembers whether it was left open, so on a
     profile that has opened it before the button is already expanded and this
     press would CLOSE it. The state is read first and the press is made only
     when it is needed -- the same rule the drawer helpers in
     tools/test-account-harness.mjs settled on for exactly this reason. */
  const groupClosed = await evaluate(`(() => {
    const toggle = document.querySelector('[data-start-work-toggle]')
    if (!toggle) return 'absent'
    return toggle.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed'
  })()`)
  if (groupClosed === 'closed') {
    const expanded = await press('[data-start-work-toggle]')
    if (expanded !== 'clicked') return stop('the "Start more work" disclosure on the node rail', expanded)
  }
  const rail = await visible('.board-team-box', 12_000)
  if (rail?.state !== 'visible') {
    const boxes = await evaluate(`JSON.stringify([...document.querySelectorAll('.board-box')].map(n => n.className))`)
    return stop('the rail carrying the start-work controls', `${rail?.state}; boxes on the rail: ${boxes}`)
  }
  return { ok: true, at: 'the node rail is open', detail: '' }
}
