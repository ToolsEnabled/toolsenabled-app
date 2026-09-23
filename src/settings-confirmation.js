const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

// A confirmation is requested at the moment of saving, so editing other
// settings cannot silently expire or invalidate it before the write starts.
export function createSettingsConfirmation({ shell = globalThis.window?.mcSettings } = {}) {
  let dialog = null
  let cancel = null
  async function confirmWrite(id, value) {
    if (id !== 'purchases.require_owner_approval' || value !== false) return undefined
    if (typeof shell?.confirmation !== 'function') throw new Error('This copy cannot confirm purchase-approval changes. Update the desktop app and try again.')
    const challenge = await shell.confirmation(id, value)
    return confirmAction(challenge, {
      title: 'Let agents approve purchases',
      description: 'Agents will be able to approve purchases without waiting for you. Existing spending limits and payment availability still apply.',
      submitLabel: 'Confirm and save', cancelLabel: 'Keep pending',
      canceledMessage: 'Purchase approval was not changed. Your edit is still pending.',
    })
  }
  function confirmAction(challenge, { title, description, submitLabel = 'Confirm', cancelLabel = 'Cancel', canceledMessage = 'The operation was canceled.' }) {
    if (dialog) throw new Error('Finish the current confirmation first.')
    if (!challenge?.ok || !/^[0-9]{4}$/.test(String(challenge.code))) throw new Error(challenge?.reason || 'The local confirmation could not be prepared.')
    const confirmationDigits = String(challenge.code)
    return new Promise((resolve, reject) => {
      const previousFocus = document.activeElement
      dialog = document.createElement('dialog')
      dialog.className = 'settings-expert-dialog settings-confirmation-dialog'
      dialog.setAttribute('aria-labelledby', 'settings-confirmation-title')
      dialog.setAttribute('aria-describedby', 'settings-confirmation-description')
      dialog.innerHTML = `<form>
        <h2 id="settings-confirmation-title">${escape(title)}</h2>
        <p id="settings-confirmation-description">${escape(description)}</p>
        <label for="settings-confirmation-code">Enter <strong>${escape(confirmationDigits)}</strong> to confirm.</label>
        <input id="settings-confirmation-code" inputmode="numeric" autocomplete="off" pattern="[0-9]{4}" maxlength="4" required autofocus>
        <p data-confirmation-error role="status"></p>
        <div class="settings-dialog-actions"><button type="button" class="ctl-btn" data-confirmation-cancel>${escape(cancelLabel)}</button><button type="submit" class="ctl-btn armed">${escape(submitLabel)}</button></div>
      </form>`
      const finish = accepted => {
        const code = dialog.querySelector('input').value
        dialog.close()
        dialog.remove()
        dialog = null
        cancel = null
        previousFocus?.focus?.()
        if (accepted) resolve({ confirmationId: challenge.confirmationId, code })
        else reject(new Error(canceledMessage))
      }
      cancel = () => finish(false)
      dialog.querySelector('[data-confirmation-cancel]').addEventListener('click', cancel)
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false) })
      dialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault()
        if (dialog.querySelector('input').value !== String(challenge.code)) {
          dialog.querySelector('[data-confirmation-error]').textContent = 'Enter the four digits shown above.'
          dialog.querySelector('input').focus()
          return
        }
        finish(true)
      })
      document.body.appendChild(dialog)
      dialog.showModal()
    })
  }
  return { confirmWrite, confirmAction, destroy() { cancel?.() } }
}
