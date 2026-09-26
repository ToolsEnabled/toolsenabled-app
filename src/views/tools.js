/* /tools — every tool your assistants can reach, and your answer for each one.
 *
 * Two requirements together: on the tool pop-up every tool has three states
 * (enabled, permissions required, disabled), and tools get their own settings
 * page. This is the page.
 *
 * WHAT IT REPLACES, AND WHY A DRAWER COULD NOT CARRY IT. The list used to be a
 * strip of checkboxes inside the quick-settings drawer, on one route, with two
 * states and one sentence. Two of its defects are the reason this exists:
 *
 *   1. A CHECKBOX HAS TWO STATES. The middle answer -- may be used, one
 *      approval at a time -- had nowhere to live.
 *   2. THE TOOLS THE LEVEL WITHHOLDS HAD NO ROW AT ALL. They were counted:
 *      "N more tools are withheld". A person could not see which ones, why, or
 *      where the decision was made. A count is the shape of an answer without
 *      being one.
 *
 * So every registered tool has a row here, including the withheld ones, and a
 * withheld row says what it is, why it is unavailable, and where that is
 * decided -- through src/guided-step.js, the module the settings page and the
 * setup review already use for exactly that block. There is one wording for a
 * withheld state in this product and this page asks for it rather than writing
 * a second.
 *
 * THE MODEL IS NOT HERE. src/agent-tool-states.js owns the three states, the
 * migration off the old two-state row, and what a session started now would
 * actually be offered. This file draws it. That is the same split the rest of
 * the product uses, and it is what lets the migration be proved without a
 * browser.
 *
 * THE LEVEL IS A CEILING AND THIS PAGE IS UNDERNEATH IT. Nothing here can make
 * a tool more available than the level recorded for this computer allows. The
 * three states choose within that, and the withheld rows are where the ceiling
 * becomes visible instead of being felt.
 */

import { controlState, el } from '../components.js'
import {
  TOOL_STATES_KEY,
  TOOLS_DISABLED_KEY,
  composeToolSurface,
  serializeToolStates,
  parseToolStates,
  toolState,
  withToolState,
} from '../agent-tool-states.js'
import {
  countLine,
  saveRefusalSentence,
  stateSentence,
  toolRowMarkup,
  withheldRowMarkup,
} from '../agent-tools-markup.js'
import '../settings.css'
import '../guided-step.css'
import '../agent-tools.css'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The tools in families by the part of the name before the first dot
   ("fs.read_file" is in "fs"), in the order the computer listed them. Only
   the drawing is grouped; what each row is and does is unchanged. */
function groupsOf(tools) {
  const families = new Map()
  for (const tool of tools) {
    const name = String(tool.name)
    const cut = name.indexOf('.')
    const family = cut > 0 ? name.slice(0, cut) : name
    if (!families.has(family)) families.set(family, [])
    families.get(family).push(tool)
  }
  return [...families]
}

export function toolsView() {
  /* THE LAYOUT (2026-09-23 upgrade). A titled header; one card for the tools
     you decide about (the count line, the status line, then search and the
     three set-every-tool buttons in one toolbar row, column heads, and the rows
     grouped by the part of the name before the first dot); a second card for
     the tools outside this computer's level; and, beside them on a wide window,
     what each answer does. The page no longer borrows the Settings page's
     layout classes, so a change to Settings cannot reshape it. The rows keep
     `.settings-row` and the search keeps `.settings-search`, because the page
     guide points at both. Search and the bulk buttons sit inside
     [data-tool-body], so they appear only once there is a list to act on. */
  const root = el(`<div class="view-pad tools-page">
    <div class="tools-shell">
      <header class="tools-header">
        <div class="tools-title">
          <p class="tools-eyebrow">This computer</p>
          <h1 class="tools-h1">Tools</h1>
          <p class="tools-lede">Every tool your assistants can reach on this computer. Each one has three answers: use it, ask you first, or leave it off. A change reaches the assistants you start afterwards; the ones already running keep the tools they started with.</p>
        </div>
      </header>
      <div class="tools-layout">
        <div class="tools-main">
          <section class="tools-panel" aria-labelledby="tools-list-title">
            <div class="tools-panel-head">
              <h2 class="tools-panel-title" id="tools-list-title">Tools you decide about</h2>
              <p class="tools-count" data-tool-count></p>
            </div>
            <p class="tools-status" data-tool-status>Reading the tool list from the computer you are driving.</p>
            <div class="tools-body" data-tool-body hidden>
              <div class="tools-toolbar">
                <label class="settings-search tools-search"><span class="tools-field-label">Search tools by name</span><input type="search" placeholder="search tools" autocomplete="off" spellcheck="false" data-tool-search-box/></label>
                <div class="tools-bulk" role="group" aria-labelledby="tools-bulk-label">
                  <span class="tools-field-label" id="tools-bulk-label">Set every tool</span>
                  <div class="tools-bulk-buttons">
                    <button type="button" class="ctl-btn" data-tools-all-on>Enable all</button>
                    <button type="button" class="ctl-btn" data-tools-all-ask>Ask first for all</button>
                    <button type="button" class="ctl-btn" data-tools-all-off>Disable all</button>
                  </div>
                </div>
              </div>
              <div class="tools-table-head" aria-hidden="true"><span>Tool</span><span>What happens now</span><span>Your answer</span></div>
              <div class="tools-rows" data-tool-rows></div>
              <p class="tools-no-match" data-tools-no-match hidden>No tool name matches that search.</p>
            </div>
          </section>
          <section class="tools-panel tools-panel-withheld" data-tool-withheld-section hidden aria-labelledby="tools-withheld-title">
            <div class="tools-panel-head">
              <h2 class="tools-panel-title" id="tools-withheld-title">Tools outside this computer's level</h2>
            </div>
            <p class="tools-panel-note">These are real tools this program has. The level chosen when this computer was set up does not carry them, so no answer on this page can switch one on. Each row says what it would do and where that level is chosen.</p>
            <div class="tools-rows" data-tool-withheld-rows></div>
          </section>
        </div>
        <aside class="tools-aside" aria-labelledby="tools-answers-title">
          <h2 class="tools-aside-title" id="tools-answers-title">What each answer does</h2>
          <dl class="tools-answers">
            <div><dt>Enabled</dt><dd>Assistants use the tool whenever they judge they need it.</dd></div>
            <div><dt>Permissions required</dt><dd>Each use waits for your answer in the Ledger. Where this program cannot ask first, the tool is held back instead.</dd></div>
            <div><dt>Disabled</dt><dd>Assistants started after the change cannot use it.</dd></div>
            <div><dt>Outside the level</dt><dd>The level chosen at setup is a ceiling. No answer on this page can switch on a tool above it.</dd></div>
          </dl>
          <p class="tools-aside-note">Changes reach the assistants you start afterwards. Running ones keep the tools they started with.</p>
        </aside>
      </div>
    </div>
  </div>`)

  const status = root.querySelector('[data-tool-status]')
  const body = root.querySelector('[data-tool-body]')
  let destroyed = false

  /* Held in the closure and written through persist(), so the screen and the
     stored row cannot disagree: a rejected write puts the old value back before
     anything is redrawn. */
  let states = Object.freeze({})
  let tools = []
  let writable = controlState({ enabled: false, why: 'The tool list has not been read yet.' })
  /* The old two-state row is cleared only after the new one has been written,
     and only when there WAS one. Clearing it first would leave an account with
     no record at all if the second write failed. */
  let legacyPending = false

  function say(sentence) {
    if (status) status.textContent = sentence
  }

  function paint() {
    const surface = composeToolSurface(tools, states)
    const switchable = tools.filter(tool => tool.allowed === true)
    const withheld = tools.filter(tool => tool.allowed !== true)
    root.querySelector('[data-tool-count]').textContent = countLine(surface, tools.length)
    root.querySelector('[data-tool-rows]').innerHTML = groupsOf(switchable).map(([family, members]) =>
      `<section class="tools-group" data-tools-group aria-label="${esc(family)}">
        <h3 class="tools-group-head"><span class="tools-group-name">${esc(family)}</span><span class="tools-group-count">${members.length} ${members.length === 1 ? 'tool' : 'tools'}</span></h3>
        ${members.map(tool => toolRowMarkup(tool, states, writable.enabled)).join('')}
      </section>`).join('')
    const withheldSection = root.querySelector('[data-tool-withheld-section]')
    withheldSection.hidden = withheld.length === 0
    root.querySelector('[data-tool-withheld-rows]').innerHTML = withheld.map(withheldRowMarkup).join('')
    for (const button of root.querySelectorAll('.tools-bulk button')) {
      button.disabled = !writable.enabled
      if (writable.disabled) button.title = writable.why
    }
    applyFilter()
  }

  /* One row repainted in place. A full repaint on every press would throw away
     the search the person typed and move the control out from under the
     pointer they are still holding it with. */
  function repaintRow(name) {
    /* Found by walking rather than by building a selector out of a name this
       file did not choose. A registry identifier is well behaved today; a
       selector composed from data is the kind of thing that stays correct until
       the day one is not. */
    const row = [...root.querySelectorAll('[data-tool-row]')].find(entry => entry.dataset.toolRow === name)
    const tool = tools.find(entry => entry.name === name)
    if (!row || !tool) return
    const state = toolState(states, name)
    row.querySelector('[data-tool-sentence]').textContent = stateSentence(tool, state)
    for (const button of row.querySelectorAll('button[data-tool-state]')) {
      const on = button.dataset.toolState === state
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    root.querySelector('[data-tool-count]').textContent = countLine(composeToolSurface(tools, states), tools.length)
  }

  function applyFilter() {
    const box = root.querySelector('[data-tool-search-box]')
    const needle = (box?.value || '').trim().toLowerCase()
    for (const row of root.querySelectorAll('[data-tool-search]')) {
      row.hidden = needle !== '' && !row.dataset.toolSearch.includes(needle)
    }
    /* Presentation only: a family whose every row the search hid drops its
       heading too, and an empty result says so instead of showing a bare card. */
    let shown = 0
    for (const group of root.querySelectorAll('[data-tools-group]')) {
      const visible = [...group.querySelectorAll('[data-tool-search]')].filter(row => !row.hidden).length
      group.hidden = visible === 0
      shown += visible
    }
    const noMatch = root.querySelector('[data-tools-no-match]')
    if (noMatch) noMatch.hidden = needle === '' || shown > 0
  }

  async function persist(previous) {
    const account = window.mcAccount
    if (!writable.enabled || typeof account?.putSetting !== 'function') {
      states = previous
      say(writable.why)
      return false
    }
    let result = null
    try { result = await account.putSetting(TOOL_STATES_KEY, serializeToolStates(states)) } catch {}
    if (!result || result.ok !== true) {
      states = previous
      /* The shell's own reason, not a guess about it -- see saveRefusalSentence
         in src/agent-tools-markup.js for which six this can be and why the line
         that used to stand here sent people to do the one thing that cannot
         help. */
      say(saveRefusalSentence(result))
      return false
    }
    if (legacyPending) {
      /* The old row is removed rather than left beside the new one, so a later
         reader cannot find two answers to one question. A failure here is not
         reported: the new row already decides, and the old one is ignored while
         it exists. */
      try { await account.putSetting(TOOLS_DISABLED_KEY, null) } catch {}
      legacyPending = false
    }
    say('Saved. It reaches the assistants you start afterwards.')
    return true
  }

  async function setState(name, state) {
    const previous = states
    states = withToolState(states, name, state)
    repaintRow(name)
    if (!await persist(previous)) repaintRow(name)
  }

  async function setEvery(state) {
    const previous = states
    let next = states
    for (const tool of tools) if (tool.allowed === true) next = withToolState(next, tool.name, state)
    states = next
    paint()
    if (!await persist(previous)) paint()
  }

  root.addEventListener('click', event => {
    const button = event.target.closest?.('button')
    if (!button || button.disabled) return
    if (button.dataset.toolState && button.dataset.toolName) {
      void setState(button.dataset.toolName, button.dataset.toolState)
      return
    }
    if (button.hasAttribute('data-tools-all-on')) void setEvery('enabled')
    else if (button.hasAttribute('data-tools-all-ask')) void setEvery('ask')
    else if (button.hasAttribute('data-tools-all-off')) void setEvery('disabled')
  })

  root.querySelector('[data-tool-search-box]')?.addEventListener('input', applyFilter)

  async function load() {
    const agent = window.mcAgent
    const account = window.mcAccount
    if (typeof agent?.tools !== 'function' || typeof account?.getSetting !== 'function') {
      say('The computer you are driving cannot list its tools. Open the ToolsEnabled app installed on it to change them.')
      return
    }
    let listed = null
    let stored = null
    let legacy = null
    try {
      [listed, stored, legacy] = await Promise.all([
        agent.tools(),
        account.getSetting(TOOL_STATES_KEY),
        account.getSetting(TOOLS_DISABLED_KEY),
      ])
    } catch {}
    if (destroyed || !root.isConnected) return
    if (!listed || listed.ok !== true) {
      say('The tool list could not be read from the computer you are driving, so nothing here was changed.')
      return
    }
    /* NOBODY SIGNED IN IS NOT A READ FAILURE (T1453). Both reads answer
       ACCOUNT_NOT_SIGNED_IN on a fresh install whose setup was skipped; that
       is the normal signed-out state, and the page must ask for a sign-in
       rather than report that saved choices could not be read. */
    const notSignedIn = result => Boolean(result && result.ok === false && result.code === 'ACCOUNT_NOT_SIGNED_IN')
    const signedOut = notSignedIn(stored) || notSignedIn(legacy)
    const settingsRefused = !signedOut && (stored?.ok !== true || legacy?.ok !== true)
    const failedRead = stored?.ok !== true ? stored : legacy
    const storedValue = stored && stored.ok === true ? stored.value : null
    const legacyValue = legacy && legacy.ok === true ? legacy.value : null
    /* A ROW THIS PAGE CANNOT READ STILL GETS A PAGE, and the sentence carries
       the whole of what happened.
       Refusing to draw anything would be a dead end: the enforcement half reads
       the same damaged row and refuses every start, so the only way out is to
       set the answers again, and this is the screen that does that. What must
       never happen is the controls appearing at their defaults while the page
       stays quiet -- a reassuring default in the place a person checks what
       their computer will do. So the defaults are shown AND named as defaults,
       and the refusal is stated above them. */
    const parsed = parseToolStates(storedValue, legacyValue)
    const unreadable = !parsed.ok
    states = unreadable ? Object.freeze({}) : parsed.states
    legacyPending = parsed.ok === true && parsed.migrated
    tools = listed.tools
    writable = controlState({
      enabled: !settingsRefused && !signedOut && typeof account.putSetting === 'function',
      why: settingsRefused
        ? (failedRead?.reason || 'Your saved tool choices could not be read. Check the account connection on this computer and try again.')
        : signedOut
        ? 'Sign in to change these. Your answers about tools belong to your account.'
        : 'This copy cannot save answers about tools. Update the app, then try again.',
    })
    body.hidden = false
    if (settingsRefused) {
      say(`Your saved tool choices could not be read. The choices below show defaults. ${writable.why}`)
    } else if (unreadable) {
      say('The answers saved for these tools could not be read. No agent will start until they are set again. What is shown below is the default, not what was saved.')
    } else {
      say(writable.disabled
        ? writable.why
        : 'A change reaches the assistants you start afterwards. Running sessions keep the tools they started with.')
    }
    paint()
  }

  void load()

  return {
    el: root,
    destroy() { destroyed = true },
  }
}
