/* THE SETTINGS ROW THAT REMEMBERS HOW UPDATES ARE CHECKED.
 *
 * The owner's words: a launch-time question about checking for updates, a
 * box for "always check automatically" and "never check automatically" so the
 * window need never be seen again, "and then it should be in settings though".
 * This is the "in settings" half. shell/update-check.cjs asks the question at
 * launch and reads `mc.update.policy` to decide whether to; this row is the
 * only place the remembered answer can be changed afterwards, which matters
 * most for `never` -- a choice that, by design, produces no further dialog to
 * undo itself from.
 *
 * WHY A SECTION CONTROLLER AND NOT A CATALOGUE ROW. The catalogue stores every
 * row under `mc.set.<id>` and src/views/settings.js applies each one through
 * applyValue(). This key is read by the installed application, not by the
 * page, and it is outside `mc.set.` on purpose so public/durable-storage.js
 * never mirrors it to the account: which computer checks for updates is a
 * fact about that computer. The web-drive switch in
 * src/connect-computer-settings.js took the same road for the same reason.
 *
 * IT IS A `.seg` AND DELIBERATELY NOT A `.settings-seg`, and its buttons carry
 * `data-update-policy` rather than `data-setting-value`. src/views/settings.js
 * listens for clicks on `button[data-setting-value]` and looks the row up in
 * the catalogue by its setting id; this row is not in that catalogue, so that
 * handler would reach applyValue(undefined) and throw. The attribute names
 * are what keep the page's handler from ever seeing these buttons;
 * handleClick() below is their only listener. The indicator styling falls back
 * to src/styles.css's `.seg:not(:has(> .seg-ind.ready)) > button.on` rule,
 * which exists for exactly a seg that nobody attached an animated indicator
 * to.
 *
 * THE STORE IS THE TRUTH, NEVER THE PRESS. The control is redrawn from the
 * stored value after every change, so a write that failed shows the old value
 * and says why beside it. A window with no durable store draws the sentence
 * and no control: a control whose press cannot be saved is a control that
 * lies.
 */

import { currentDataSource } from './data-source.js'
import { matchesSettingQuery } from './product-settings-layout.js'
import { guidanceMarkup } from './guided-step.js'

export const UPDATE_SECTION = 'System'
export const UPDATE_SETTING_ID = 'update_policy'
export const UPDATE_SETTING_COUNT = 1
export const UPDATE_POLICY_KEY = 'mc.update.policy'
export const UPDATE_CONTROL_LABEL = 'Checking for updates'

/* The three answers, in the order they are drawn. `ask` is the shipped
   default and the one an absent or unknown stored value reads as. */
export const UPDATE_POLICIES = Object.freeze([
  Object.freeze({ value: 'ask', label: 'Ask me' }),
  Object.freeze({ value: 'always', label: 'Always check' }),
  Object.freeze({ value: 'never', label: 'Never check' }),
])
const POLICY_VALUES = UPDATE_POLICIES.map(policy => policy.value)
export const DEFAULT_UPDATE_POLICY = 'ask'

const DOWNLOAD_PAGE = 'toolsenabled.ai/download'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The stored string, read as one of the three words. Anything else is the
   default -- the same rule shell/update-check.cjs applies, so the row and the
   launch question can never disagree about what an odd value means. */
export function readUpdatePolicyValue(value) {
  return POLICY_VALUES.includes(value) ? value : DEFAULT_UPDATE_POLICY
}

/* THE SENTENCE SAYS THE CURRENT TRUTH FIRST, and it must never contradict the
   button that is lit. Each sentence is written for one value and one value
   only, which is how the test holds that rule still. */
export function updateStateSentence(policy) {
  switch (readUpdatePolicyValue(policy)) {
    case 'always':
      return 'Checks on its own at launch, at most once a day, and asks before installing.'
    case 'never':
      return `Never checks. Updates are at ${DOWNLOAD_PAGE}.`
    default:
      return 'Asks at launch whether to check.'
  }
}

export const UPDATE_NO_STORE_SENTENCE = 'This window cannot save that choice, so the launch-time question decides it.'
export const UPDATE_POLICY_READ_FAILED_CODE = 'MC_UPDATE_POLICY_READ_FAILED'
export const UPDATE_POLICY_READ_FAILED_SENTENCE = 'This computer could not read the update choice right now. This does not mean the choice is absent; try again.'
export const UPDATE_SAVE_FAILED = 'That choice could not be saved on this computer, so nothing changed. Try once more; if it still will not save, the settings file could not be written.'
const UPDATE_SAVE_FAILED_RELAY = 'That choice could not be saved on the computer you are driving, so nothing changed. Try once more; if it still will not save, that computer’s settings file could not be written.'

/* THE DEFAULT WRITER GOES THROUGH localStorage, AND THAT IS THE WHOLE WRITE
   ROUTE -- the same one src/connect-computer-settings.js documents for the
   web-drive switch. public/durable-storage.js replaces localStorage in the
   desktop shell with a store whose every write goes over `mcPrefs.write` to
   shell/renderer-prefs.cjs, which is the record shell/update-check.cjs reads at
   launch. No registry row.

   GUARDED ON `window.mcPrefs.available === true`, the exact test
   durable-storage.js makes before installing itself. Without it localStorage
   is the browser's own, the installed application would never see the write,
   and the row would claim to have remembered something it had not. So a window
   without the bridge reads null, and null draws no control.

   THE READ ASKS THE FILE, NOT THE LAUNCH COPY, WHEN IT CAN. durable-storage
   answers getItem from the values it took at boot, and this key is the one
   key the installed application writes AFTER boot -- the launch dialog is what
   writes it. `mcPrefs.read` (mc-prefs:read in shell/main.cjs) reads the file
   now; where a build lacks it, the launch copy is the best there is. */
export function defaultReadUpdatePolicy() {
  const bridge = globalThis.window?.mcPrefs
  if (bridge?.available !== true) return null
  if (typeof bridge.read === 'function') {
    try {
      const live = bridge.read(UPDATE_POLICY_KEY)
      if (live && live.ok === true) return readUpdatePolicyValue(live.value)
      const failure = new Error('The update policy could not be read; this is not an absent policy.')
      failure.code = UPDATE_POLICY_READ_FAILED_CODE
      failure.cause = live?.error
      throw failure
    } catch (cause) {
      if (cause?.code === UPDATE_POLICY_READ_FAILED_CODE) throw cause
      const failure = new Error('The update policy could not be read; this is not an absent policy.')
      failure.code = UPDATE_POLICY_READ_FAILED_CODE
      failure.cause = cause
      throw failure
    }
  }
  return readUpdatePolicyValue(globalThis.localStorage?.getItem?.(UPDATE_POLICY_KEY))
}

export function defaultWriteUpdatePolicy(policy) {
  if (globalThis.window?.mcPrefs?.available !== true) throw new Error('no durable store in this window')
  if (policy === DEFAULT_UPDATE_POLICY) globalThis.localStorage.removeItem(UPDATE_POLICY_KEY)
  else globalThis.localStorage.setItem(UPDATE_POLICY_KEY, policy)
}

function segMarkup(current) {
  return `<div class="seg update-policy-seg" role="group" aria-labelledby="update-policy-label">
      ${UPDATE_POLICIES.map(policy => `<button type="button" data-update-policy="${esc(policy.value)}" aria-pressed="${policy.value === current ? 'true' : 'false'}" class="${policy.value === current ? 'on' : ''}">${esc(policy.label)}</button>`).join('')}
    </div>`
}

function noticeMarkup(notice) {
  if (!notice) return ''
  return `<p class="settings-desc update-policy-notice" data-update-policy-notice role="alert">${esc(notice)}</p>`
}

export function createUpdateSettings({
  stageWrite = null, draft = null,
  readPolicy = defaultReadUpdatePolicy,
  writePolicy = defaultWriteUpdatePolicy,
  readingOverRelay = () => currentDataSource() === 'relay',
  platform = globalThis.mcSetup?.platform,
} = {}) {
  let hostRoot = null
  let notice = ''

  /* Null means the durable store is genuinely unavailable. A failed read is
     deliberately a different answer: it is retried on every call, rather
     than being cached or mistaken for absence. */
  function current() {
    try {
      const value = draft ? draft.value('updates:policy', readPolicy()) : readPolicy()
      return value === null || value === undefined ? null : readUpdatePolicyValue(value)
    } catch (cause) {
      return Object.freeze({ code: UPDATE_POLICY_READ_FAILED_CODE, cause })
    }
  }

  function markup({ searchResult = false } = {}) {
    const unsupported = platform === 'linux' || platform === 'darwin'
    const policy = current()
    const readFailed = policy?.code === UPDATE_POLICY_READ_FAILED_CODE
    const state = unsupported
      ? 'This copy cannot install updates from inside the app. Use the installer or launcher you used to get ToolsEnabled.'
      : readFailed
      ? UPDATE_POLICY_READ_FAILED_SENTENCE
      : policy === null ? UPDATE_NO_STORE_SENTENCE : updateStateSentence(policy)
    return `<section class="settings-section update-section" data-settings-section="${esc(UPDATE_SECTION)}" data-update-settings>
      ${searchResult ? '<div class="settings-prefix">System · updates</div>' : ''}
      <div class="settings-section-rows">
        <article class="settings-row update-policy-row" data-update-policy-row data-setting-id="${esc(UPDATE_SETTING_ID)}">
          <div class="settings-copy">
            <div class="settings-name" id="update-policy-label">${esc(UPDATE_CONTROL_LABEL)}</div>
            <div class="settings-desc" data-update-policy-state>${esc(state)}${unsupported ? '' : ' Ask me means a question at every launch, after setup is finished. Always check means it looks on its own and only asks before installing. Never check means it never looks, and this row is the way back.'}</div>
            ${noticeMarkup(notice)}
          </div>
          ${unsupported || policy === null || readFailed ? '' : `<div class="settings-control">${segMarkup(policy)}</div>`}
          ${unsupported ? '' : `<div class="settings-disclosure">${guidanceMarkup(UPDATE_SETTING_ID, { section: UPDATE_SECTION })}</div>`}
        </article>
      </div>
    </section>`
  }

  function refresh() {
    if (!hostRoot) return
    for (const node of hostRoot.querySelectorAll('[data-update-settings]')) {
      const searchResult = node.querySelector('.settings-prefix') !== null
      node.outerHTML = markup({ searchResult })
    }
  }

  /* THE PRESS MOVES THE STORE, THEN THE SCREEN IS REDRAWN FROM THE STORE. A
     write that throws leaves the record as it was and says so beside the
     control, which springs back on the repaint. */
  function setPolicy(policy) {
    const next = readUpdatePolicyValue(policy)
    notice = ''
    try {
      if (stageWrite) stageWrite('updates:policy', next, writePolicy)
      else writePolicy(next)
    } catch {
      let viaRelay = false
      try { viaRelay = readingOverRelay() === true } catch { /* use the desk sentence */ }
      notice = viaRelay ? UPDATE_SAVE_FAILED_RELAY : UPDATE_SAVE_FAILED
    }
    refresh()
  }

  function handleClick(event) {
    const button = event.target.closest?.('button[data-update-policy]')
    if (!button || !hostRoot?.contains(button)) return
    setPolicy(button.dataset.updatePolicy)
  }

  function matches(query) {
    const normalized = String(query || '').trim().toLowerCase()
    if (!normalized) return true
    const haystack = [
      UPDATE_CONTROL_LABEL,
      'update updates upgrade new version check for updates automatically install installer download',
      UPDATE_POLICIES.map(policy => policy.label).join(' '),
      DOWNLOAD_PAGE,
      updateStateSentence(current()),
    ].join(' ').toLowerCase()
    return matchesSettingQuery(normalized, haystack)
  }

  function bind(root) {
    hostRoot = root
    root.addEventListener('click', handleClick)
  }

  function afterRender(root = hostRoot) {
    hostRoot = root
  }

  function destroy() {
    if (hostRoot) hostRoot.removeEventListener('click', handleClick)
    hostRoot = null
  }

  return Object.freeze({
    markup,
    matches,
    bind,
    afterRender,
    destroy,
    setPolicy,
    getPolicy: current,
  })
}
