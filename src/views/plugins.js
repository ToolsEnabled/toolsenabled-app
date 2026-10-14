/* /plugins — what you have added, and your answer for each thing it asked for.
 *
 * WHAT THIS PAGE IS. A consent screen, and only that. It does not install, update
 * or remove anything: a plugin is a folder the person downloaded and put in place
 * themselves, and this page is where they decide what it may do.
 *
 * THREE DECISIONS THE LAYOUT MAKES, EACH TO AVOID A KNOWN FAILURE.
 *
 * 1. EVERY CAPABILITY THE PACKAGE ASKED FOR HAS A ROW, INCLUDING THE DECLINED
 *    ONES. src/views/tools.js exists because withheld tools used to be COUNTED
 *    rather than listed, and a count is the shape of an answer without being one.
 *    Same rule here: a person can see what a plugin wanted and what they said.
 *
 * 2. A FOLDER THAT WOULD NOT LOAD GETS A CARD, WITH THE REFUSAL VERBATIM. The one
 *    dangerous outcome for this page is a person believing a plugin is running when
 *    it is not, and skipping a broken folder produces exactly that.
 *
 * 3. SAVING IS ABSOLUTE AND EXPLICIT. The boxes are a draft until Save; the
 *    request carries the WHOLE set, not a change to it. An incremental API would
 *    make "what is allowed" depend on the order clicks arrived in, and a consent
 *    screen must not have a history. Nothing is saved by ticking a box.
 *
 * WHY IT SAYS THE APP MUST RESTART. A plugin's tools reach the tool registry
 * through src/lib/tool-pack-registry.js, which is frozen when the engine builds
 * the registry at start -- a pack registered later would silently not exist. So a
 * grant takes effect next launch, and the page says so on every card rather than
 * letting somebody grant a capability and wonder why nothing appeared.
 */

import { el } from '../components.js'
import { pageMarkup } from '../plugins-markup.js'
import { PAGE_WITHDRAW_REASON, capabilityPhrase } from '../plugin-copy.js'
import '../settings.css'
import '../plugins.css'

export function pluginsView({ plugins } = {}) {
  const bridge = plugins || (typeof globalThis !== 'undefined' ? globalThis.window?.mcPlugins : null)

  const root = el(`<div class="view-pad plugins-page">
    <header class="plugins-header">
      <p class="plugins-eyebrow">Plugins</p>
      <h1 class="plugins-h1">What you have added, and what each one may do</h1>
      <p class="plugins-lede">A plugin is a folder you downloaded and put in place yourself. There is no store, nothing
        arrives on its own, and adding one grants it nothing until you decide here.</p>
      <div class="plugins-header-actions">
        <button type="button" class="ctl-btn" data-plugins-refresh>Refresh</button>
      </div>
    </header>
    <p class="plugins-status" data-plugins-status aria-live="polite"></p>
    <div class="plugins-list" data-plugins-list></div>
  </div>`)

  const list = root.querySelector('[data-plugins-list]')
  const status = root.querySelector('[data-plugins-status]')

  function say(text, kind = '') {
    status.textContent = text || ''
    status.className = `plugins-status${kind ? ` is-${kind}` : ''}`
  }

  /* `quiet` redraws the cards without touching the status line. Save and
     Withdraw use it: their answer is what the person is waiting for, and a
     refresh that then said "Reading…" and the plugin count would wipe the
     engine's refusal sentence, or "takes effect the next time you open the app",
     a few milliseconds after it appeared. A list that cannot be read is still
     drawn as a card that says so, so a quiet failure is not a silent one. */
  async function refresh({ quiet = false } = {}) {
    if (!bridge || typeof bridge.list !== 'function') {
      /* The page is reachable in a build where the bridge is not wired. Saying so
         is better than an empty list, which would read as "no plugins". */
      list.innerHTML = pageMarkup({ ok: false, code: 'PLUGIN_BRIDGE_ABSENT',
        reason: 'This copy of the app has no plugin bridge, so no plugin can be read or allowed anything.' })
      return
    }
    if (!quiet) say('Reading…')
    let result
    let failure = ''
    try {
      result = await bridge.list()
    } catch (error) {
      failure = String((error && error.message) || error || '')
      result = { ok: false, code: 'PLUGIN_BRIDGE_FAILED', reason: failure }
    }
    list.innerHTML = pageMarkup(result, { writable: true })
    if (quiet) return
    if (result && result.ok) {
      const allowed = result.packages.filter(entry => entry.granted.length).length
      say(`${result.packages.length} plugin${result.packages.length === 1 ? '' : 's'}`
        + `, ${allowed} allowed something`
        + (result.refused.length ? `, ${result.refused.length} could not be read` : ''))
    } else {
      say(failure ? `The plugin list could not be read: ${failure}` : 'The plugin list could not be read.', 'bad')
    }
  }

  /* A bridge call that failed outright is not a refusal: nothing answered it.
     The person is told that, in the failure's own words, and where to look. */
  function notAnswered(what, error) {
    const detail = String((error && error.message) || '').trim().replace(/\.$/, '')
    return `That was not ${what}${detail ? `: ${detail}` : ''}. Refresh to see what is in force now.`
  }

  /* The ticked boxes on one card, as the whole set to put in force. Read off the
     DOM at Save time rather than tracked in a variable: the markup is the draft,
     and a second copy of it is a second thing that can disagree with what the
     person is looking at. */
  function wantedFor(card) {
    return [...card.querySelectorAll('input[type=checkbox][data-capability]')]
      .filter(box => box.checked)
      .map(box => box.getAttribute('data-capability'))
  }

  root.addEventListener('click', async (event) => {
    const refreshButton = event.target.closest('[data-plugins-refresh]')
    if (refreshButton) { await refresh(); return }

    const save = event.target.closest('.plugin-save')
    if (save) {
      const card = save.closest('.plugin-card')
      const sha256 = save.getAttribute('data-sha256')
      save.disabled = true
      let answer
      try {
        const result = await bridge.grant({ sha256, capabilities: wantedFor(card) })
        if (result && result.ok) {
          answer = [result.capabilities.length
            ? `Saved. It may ${capabilityPhrase(result.capabilities)}. This takes effect the next time you open the app.`
            : 'Nothing is allowed for that plugin now.', 'good']
        } else {
          /* The engine's refusal is shown as written. It names the capability or
             the field and what to do about it; a summary here would throw that
             away. */
          answer = [`${(result && result.reason) || 'That was refused. Refresh to see what is in force now.'}`, 'bad']
        }
      } catch (error) {
        answer = [notAnswered('saved', error), 'bad']
      } finally {
        save.disabled = false
      }
      // The cards first, then the answer, so the answer is what stays on screen.
      await refresh({ quiet: true })
      say(...answer)
      return
    }

    const revoke = event.target.closest('.plugin-revoke')
    if (revoke) {
      const sha256 = revoke.getAttribute('data-sha256')
      revoke.disabled = true
      let answer
      try {
        const result = await bridge.revoke({ sha256, reason: PAGE_WITHDRAW_REASON })
        answer = [result && result.ok
          ? (result.removed
            ? `Withdrawn. It may no longer ${capabilityPhrase(result.withdrawn, 'or')}. That takes effect the next time you open the app.`
            : 'That plugin already had nothing.')
          : `${(result && result.reason) || 'That was refused. Refresh to see what is in force now.'}`,
        result && result.ok ? 'good' : 'bad']
      } catch (error) {
        answer = [notAnswered('withdrawn', error), 'bad']
      } finally {
        revoke.disabled = false
      }
      await refresh({ quiet: true })
      say(...answer)
    }
  })

  /* say() sets textContent, so the message is text already; escaping it here
     as well would put "&lt;" on the screen. */
  refresh().catch((error) => {
    say(`The plugin list could not be read: ${(error && error.message) || ''}`, 'bad')
  })

  return { el: root, refresh }
}
