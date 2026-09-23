import { focusKeeper } from './focus-keep.js'
const UNAVAILABLE = 'History adoption is unavailable. Return to live Ledger data and review it again.'
const KIND_WORD = Object.freeze({ R: 'rule', T: 'task', A: 'ask', P: 'purchase' })
/* THE RECORDS BEFORE THE DECISION (T1548): a Review that showed only a count
   asked the person to adopt records they could not see. The dialog lists
   those the preview names (id, kind, the start of the words, when each last
   changed), folded away when there are many, and says how many more there
   are beyond them. */
function recordsList(doc, snapshot) {
  const rows = Array.isArray(snapshot.records) ? snapshot.records : []
  if (!rows.length) return null
  const holder = doc.createElement(rows.length > 10 ? 'details' : 'div')
  holder.className = 'ledger-custody-records'
  if (rows.length > 10) {
    const summary = doc.createElement('summary')
    summary.textContent = `Show the ${rows.length} records this covers`
    holder.append(summary)
  } else {
    const lead = doc.createElement('p')
    lead.textContent = rows.length === 1 ? 'The record this covers:' : `The ${rows.length} records this covers:`
    holder.append(lead)
  }
  const list = doc.createElement('ul')
  for (const row of rows) {
    const item = doc.createElement('li')
    item.dataset.custodyRecord = row.id
    const when = row.changedAt && Number.isFinite(Date.parse(row.changedAt))
      ? `, last changed ${new Date(row.changedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : ''
    item.textContent = `${row.id} (${KIND_WORD[row.kind] || 'record'})${row.words ? `: ${row.words}` : ''}${when}`
    list.append(item)
  }
  holder.append(list)
  if (snapshot.count > rows.length) {
    const more = doc.createElement('p')
    more.textContent = `And ${snapshot.count - rows.length} more not listed here.`
    holder.append(more)
  }
  return holder
}
const FAILED = 'Ledger history adoption was not confirmed. Review its history again before retrying.'
const validSnapshot = value => value?.ok === true && Number.isSafeInteger(value.count) && value.count >= 0
  && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)

export function mountLedgerCustodyControls(root, { bridge, onAdopt = () => {} } = {}) {
  const group = root.querySelector('[data-ledger-custody]')
  const button = root.querySelector('[data-ledger-custody-review]')
  const status = root.querySelector('[data-ledger-custody-status]')
  const supported = typeof bridge?.ledgerCustodyPreview === 'function' && typeof bridge?.ledgerCustodyConfirm === 'function'
  let enabled = false, busy = false, destroyed = false, version = 0, closeDialog = null
  function update(options = {}) {
    if (options.enabled !== undefined) {
      if (enabled && options.enabled !== true) { version += 1; closeDialog?.() }
      enabled = options.enabled === true
    }
    if (group) group.hidden = !supported
    if (button) button.disabled = !supported || !enabled || busy
  }
  const current = generation => !destroyed && enabled && generation === version
  function warning(snapshot, generation) {
    return new Promise(resolve => {
      const doc = root.ownerDocument
      const dialog = doc.createElement('dialog')
      dialog.className = 'ledger-reset-dialog'
      dialog.setAttribute('aria-labelledby', 'ledger-custody-title')
      dialog.setAttribute('aria-describedby', 'ledger-custody-description')
      dialog.innerHTML = '<h2 id="ledger-custody-title">Adopt the current Ledger records?</h2><p id="ledger-custody-description"></p><p role="status"></p><div class="ledger-reset-actions"><button type="button" class="ledger-ctl" data-custody-cancel autofocus>Cancel</button><button type="button" class="ledger-ctl" data-custody-confirm>Adopt current records</button></div>'
      dialog.querySelector('#ledger-custody-description').textContent = `${snapshot.count} Ledger ${snapshot.count === 1 ? 'record has' : 'records have'} saved changes whose history cannot be confirmed. Adopting keeps the current records and records your decision so new writes can continue. It does not reconstruct or verify the missing history.`
      const listed = recordsList(doc, snapshot)
      if (listed) dialog.querySelector('#ledger-custody-description').after(listed)
      const cancel = dialog.querySelector('[data-custody-cancel]')
      const confirm = dialog.querySelector('[data-custody-confirm]')
      const result = dialog.querySelector('[role="status"]')
      let submitting = false, settled = false
      function finish() {
        if (settled) return
        settled = true
        dialog.close(); dialog.remove(); closeDialog = null
        resolve()
      }
      closeDialog = () => {
        confirm.disabled = true
        if (!submitting) finish()
      }
      cancel.addEventListener('click', () => { if (!submitting) finish() })
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!submitting) finish() })
      confirm.addEventListener('click', async () => {
        if (settled || submitting || confirm.disabled || !current(generation)) return
        submitting = true; cancel.disabled = true; confirm.disabled = true
        result.textContent = 'Recording your adoption decision…'
        try {
          const reply = await bridge.ledgerCustodyConfirm({ revision: snapshot.revision, token: snapshot.token })
          if (reply?.ok !== true) throw new Error(reply?.reason || FAILED)
          if (current(generation)) {
            status.textContent = `Adopted ${reply.count} Ledger ${reply.count === 1 ? 'record' : 'records'}. Earlier unconfirmed history remains marked as unverified.`
            onAdopt(reply)
          }
          finish()
        } catch (error) {
          if (current(generation)) result.textContent = error?.message || FAILED
        } finally {
          submitting = false
          if (!settled) {
            cancel.disabled = false
            cancel.textContent = 'Close'
            // A retry needs a fresh preview, including after an uncertain write.
            if (!current(generation)) finish()
          }
        }
      })
      doc.body.append(dialog)
      dialog.showModal(); cancel.focus()
    })
  }
  const reviewFocus = focusKeeper()
  async function review() {
    if (!supported || !enabled || busy || destroyed) return
    const generation = version
    // the button disables itself while it checks; it gets focus back after (T1559)
    reviewFocus.hold(button)
    busy = true; update()
    status.textContent = 'Checking the saved Ledger history…'
    try {
      const snapshot = await bridge.ledgerCustodyPreview({})
      if (!current(generation)) { if (!destroyed) status.textContent = UNAVAILABLE; return }
      if (!validSnapshot(snapshot)) throw new Error(snapshot?.reason || 'The Ledger history warning could not be verified. Try reviewing it again.')
      if (!snapshot.count) { status.textContent = 'No Ledger records need history adoption.'; return }
      status.textContent = 'Review the history warning before deciding whether to adopt.'
      await warning(snapshot, generation)
    } catch (error) {
      if (!destroyed) status.textContent = error?.message || FAILED
    } finally { busy = false; if (!destroyed) { update(); reviewFocus.restore(button) } }
  }
  button?.addEventListener('click', review)
  update()
  return {
    update,
    destroy() { destroyed = true; version += 1; closeDialog?.(); button?.removeEventListener('click', review) },
  }
}
