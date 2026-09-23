/* SETTINGS, FIRST SECTION: what the chat box on the first page contains.
 *
 * The owner's words: "on the first page in setting they should be able to
 * select which agents context shows up in the chatbox - and if agent runs shows
 * up too or not or only it should be controlled by the settings on that page".
 *
 * Two controls, because that is two requirements, and they are the first thing
 * on the settings page because the box they govern is the first thing in the
 * product. src/chatbox-feed.js owns the settings themselves and the decision
 * they drive; this is only their surface.
 *
 * IT IS A SECTION CONTROLLER, NOT A ROW IN THE SETTINGS TABLE, for one reason:
 * the agent list is DISCOVERED. A row in that table is a static declaration of
 * a control with fixed options, and there is no fixed set of agents -- they are
 * added, renamed and retired, and a list written down here would be one rename
 * away from offering a choice between agents nobody has. So this asks the
 * product what agents it currently knows about, every time the section renders,
 * through the same function the home screen filters with.
 *
 * THREE CASES THE LIST HAS TO SURVIVE, all of them ordinary:
 *   - A FRESH INSTALL knows no agents at all. The section says so plainly and
 *     the runs control still works, because the box still has runs to show.
 *   - AN AGENT APPEARS AFTER THE CHOICE WAS SAVED. On "every agent" it appears
 *     in the box; on "only the ones I pick" it does not, and the control says
 *     which of those two you asked for rather than leaving it to be discovered.
 *   - AN AGENT DISAPPEARS WHILE SELECTED. It stays in the list, still ticked,
 *     marked as not here now. Silently dropping it would change a person's
 *     choice without telling them, and would permanently deselect an agent that
 *     happened to be quiet on the day they opened this screen.
 */

import { fetchAgents, fetchCoordinator } from './live-status.js'
import { resolveDataSource } from './data-source.js'
import { FLEET } from './fleet-profile.js'
import { matchesSettingQuery } from './product-settings-layout.js'
import {
  AGENT_MODES,
  RUNS_MODES,
  agentChoices,
  discoverAgents,
  readAgentSelection,
  readRunsMode,
  runsMode,
  setAgentSelection,
  setRunsMode,
  toggleAgent,
} from './chatbox-feed.js'
import { focusKeeper } from './focus-keep.js'

/* Counted for the settings footer, which states how many settings exist. Two:
   which agents appear, and whether runs do. The agent list is that first
   setting's value, not a third setting. */
export const CHATBOX_SETTING_COUNT = 2

export const CHATBOX_SECTION = 'Home screen'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

export function createChatboxSettings({ stageWrite = null } = {}) {
  const writeSelection = value => stageWrite ? stageWrite('chatbox:agents', value, setAgentSelection) : setAgentSelection(value)
  const writeRuns = value => stageWrite ? stageWrite('chatbox:runs', value, setRunsMode) : setRunsMode(value)
  let hostRoot = null
  let selection = readAgentSelection()
  let runs = readRunsMode()
  /* `null` means nobody has looked yet, which is not the same as having looked
     and found none. The section says which of those two it is. */
  let discovered = null
  let loadStarted = false

  function agentModeMarkup() {
    const current = selection.mode
    return segMarkup('agents', AGENT_MODES.map(mode => ({ value: mode.id, label: mode.label })), current, 'Which agents you see')
  }

  function segMarkup(target, options, current, label) {
    return `<div class="seg settings-seg" role="group" aria-label="${esc(label)}">
      ${options.map(option => `<button type="button" data-chatbox-set="${esc(target)}" data-chatbox-value="${esc(option.value)}" aria-pressed="${option.value === current ? 'true' : 'false'}" class="${option.value === current ? 'on' : ''}">${esc(option.label)}</button>`).join('')}
    </div>`
  }

  function rowMarkup(name, desc, control, id) {
    return `<article class="settings-row" data-chatbox-row="${esc(id)}">
      <div class="settings-copy">
        <div class="settings-name">${esc(name)}</div>
        <div class="settings-desc">${esc(desc)}</div>
      </div>
      <div class="settings-control">${control}</div>
    </article>`
  }

  function agentListMarkup() {
    if (discovered === null) {
      return `<article class="settings-row fleet-profile-block" data-chatbox-row="agent-list">
        <div class="settings-copy">
          <div class="settings-name">The agents</div>
          <div class="settings-desc">Looking for the agents the computer you are driving knows about.</div>
        </div>
      </article>`
    }
    const rows = agentChoices(discovered, selection)
    return `<article class="settings-row fleet-profile-block" data-chatbox-row="agent-list">
      <div class="settings-copy">
        <div class="settings-name">The agents</div>
        <div class="settings-desc">${rows.length
          ? 'Every agent the computer you are driving currently knows about. Untick one and it stops appearing in the box on the first page.'
          : 'No agents have appeared on the computer you are driving yet. When one does it will be listed here, and the box on the first page will show it.'}</div>
      </div>
      <div class="fleet-profile-fields">
        ${rows.length
          ? `<ul class="chatbox-agents">${rows.map(agent => `<li class="chatbox-agent${agent.present ? '' : ' is-gone'}">
              <label>
                <span class="toggle settings-toggle"><input type="checkbox" data-chatbox-agent="${esc(agent.id)}" ${agent.chosen ? 'checked' : ''} /><i></i></span>
                <span class="chatbox-agent-name">${esc(agent.name)}</span>
              </label>
              ${agent.present ? '' : '<span class="chatbox-agent-note">not here now</span>'}
            </li>`).join('')}</ul>`
          : '<p class="fleet-profile-empty">Nothing to choose from yet.</p>'}
      </div>
    </article>`
  }

  function markup({ searchResult = false } = {}) {
    return `<section class="settings-section chatbox-section" data-settings-section="${esc(CHATBOX_SECTION)}" data-chatbox-settings>
      ${searchResult ? '<div class="settings-prefix">Home screen, the box on the first page</div>' : ''}
      <h2 class="settings-section-title">${esc(CHATBOX_SECTION)}</h2>
      <div class="settings-section-rows">
        ${rowMarkup(
          'Which agents you see',
          AGENT_MODES.find(mode => mode.id === selection.mode)?.detail || '',
          agentModeMarkup(),
          'agents',
        )}
        ${agentListMarkup()}
        ${rowMarkup(
          'Agent runs in that box',
          runsMode(runs).detail,
          segMarkup('runs', RUNS_MODES.map(mode => ({ value: mode.id, label: mode.label })), runs, 'Agent runs in that box'),
          'runs',
        )}
      </div>
    </section>`
  }

  const focus = focusKeeper()
  function refresh() {
    if (!hostRoot) return
    const current = hostRoot.querySelector('[data-chatbox-settings]')
    if (!current) return
    const searchResult = current.querySelector('.settings-prefix') !== null
    // the pressed choice or switch keeps keyboard focus across the redraw (T1386)
    focus.hold(current)
    current.outerHTML = markup({ searchResult })
    focus.restore(hostRoot.querySelector('[data-chatbox-settings]'))
  }

  /* Every source the product already has for "who are my agents", asked in one
     place so the settings list and the box being filtered cannot disagree. Each
     one is allowed to be absent: a computer with no register, no conversation
     and no demonstration simply has no agents yet, which is a state this
     section states rather than a failure it reports. */
  async function loadAgents() {
    if (loadStarted) return
    loadStarted = true
    /* This load path is already async, so it resolves the source in the same
       breath the views do rather than trusting currentDataSource()'s cache --
       which is null before anything has resolved, and null must never be
       rounded to a verdict. resolveDataSource() answers from the example
       toggle and the host synchronously enough here, and the worst case is
       one extra ask, not a wrong list. */
    const [register, coordinator, source] = await Promise.all([
      fetchAgents().catch(() => null),
      fetchCoordinator().catch(() => null),
      resolveDataSource().catch(() => null),
    ])
    const turns = coordinator?.ok && Array.isArray(coordinator.data?.data?.thread?.value)
      ? coordinator.data.data.thread.value
      : []
    /* The example's cast counts as agents while the example is what the box is
       showing: they are the agents of the fleet on screen, and a filter that
       could not name them would be a filter over an empty list. Only a KNOWN
       mock source adds them -- an unresolved source (null) adds nothing,
       because inventing example agents beside somebody's real records is
       worse than a list that fills in a moment later. */
    const speakers = source === 'mock' ? (FLEET.speakers || null) : null
    discovered = discoverAgents({
      register: register?.ok ? register.data?.data : null,
      turns,
      speakers,
    })
    refresh()
  }

  function setValue(target, value) {
    if (target === 'runs') {
      if (value === runs) return
      runs = writeRuns(value)
      refresh()
      return
    }
    if (target !== 'agents' || value === selection.mode) return
    selection = value === 'chosen'
      /* Narrowing starts from what is here, not from nothing: a person who
         picks "only the ones I pick" has not yet said which, and emptying the
         box at that moment would look like the control breaking it. */
      ? writeSelection({ mode: 'chosen', ids: (discovered || []).map(agent => agent.id) })
      : writeSelection({ mode: 'all' })
    refresh()
  }

  function handleClick(event) {
    const setter = event.target.closest('[data-chatbox-set]')
    if (!setter || !hostRoot?.contains(setter)) return
    setValue(setter.dataset.chatboxSet, setter.dataset.chatboxValue)
  }

  function handleChange(event) {
    const box = event.target.closest('[data-chatbox-agent]')
    if (!box || !hostRoot?.contains(box)) return
    selection = writeSelection(toggleAgent(selection, box.dataset.chatboxAgent, (discovered || []).map(agent => agent.id)))
    refresh()
  }

  function matches(query) {
    const normalized = String(query || '').trim().toLowerCase()
    if (!normalized) return true
    const haystack = [
      'home screen chat box chatbox first page which agents context agent runs show hide only',
      ...AGENT_MODES.map(mode => `${mode.label} ${mode.detail}`),
      ...RUNS_MODES.map(mode => `${mode.label} ${mode.detail}`),
      ...(discovered || []).map(agent => agent.name),
    ].join(' ').toLowerCase()
    return matchesSettingQuery(normalized, haystack)
  }

  function bind(root) {
    hostRoot = root
    root.addEventListener('click', handleClick)
    root.addEventListener('change', handleChange)
  }

  function afterRender(root = hostRoot) {
    hostRoot = root
    /* Re-read on every render: the walkthrough, another window, or a reset can
       have moved these since this controller was built. */
    selection = readAgentSelection()
    runs = readRunsMode()
    loadAgents()
  }

  function destroy() {
    if (hostRoot) {
      hostRoot.removeEventListener('click', handleClick)
      hostRoot.removeEventListener('change', handleChange)
    }
    hostRoot = null
  }

  return Object.freeze({ markup, matches, bind, afterRender, destroy })
}
