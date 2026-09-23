const controls = Object.freeze([
  {
    id: 'audit.activity', label: 'Tool activity audit', choices: ['Full', 'Essential', 'Off'],
    descriptions: {
      Full: 'While Signed activity audit is on, record signed success and failure summaries for completed API calls. Most complete available history; more recording work.',
      Essential: 'While Signed activity audit is on, keep failure summaries and omit successful-call summaries. Less recording work, but successful activity is harder to reconstruct.',
      Off: 'Omit success and failure summaries. Least summary-writing work; those records and their usage measurements cannot be recovered later.',
    },
    note: 'This is a preference for what the signed audit writes: it applies while Signed activity audit is on. With Signed activity audit off, the choice is kept for later and new operations do not request audit records. Work already underway may finish recording. While Signed activity audit is on, required security, approval and protected-action records stay on in every mode, so Off does not mean zero records. Permissions, sandboxing and vault protection stay active regardless. Summary write failures are reported and can leave gaps. Existing history is kept.',
  },
  {
    id: 'tools.throughput', label: 'Tool processing', choices: ['fast', 'strict'],
    descriptions: {
      fast: 'Fast: read calls can run together and arriving audit records share a durable commit. Recorded calls still wait for their records to be saved.',
      strict: 'Strict: one call at a time per connection and separate audit commits. Easier to follow the order, but more waiting; it does not record more detail than Fast.',
    },
    note: 'The persistent local helpers reduce startup work in both choices. Speed depends on the tool, storage and queue load; remote services and approval waits can take longer.',
  },
])

export function auditPerformanceSettingsMarkup() {
  return controls.map(control => `<div data-audit-performance="${control.id}">
    <div class="set-row"><span class="set-label">${control.label}</span>
      <div class="theme-seg" role="group" aria-label="${control.label}">
        ${control.choices.map(value => `<button type="button" data-audit-choice="${value}" aria-pressed="false" disabled>${value[0].toUpperCase() + value.slice(1)}</button>`).join('')}
      </div>
    </div>
    <p class="drawer-page-empty" data-audit-status role="status">Reading the saved choice…</p>
    <p class="drawer-page-empty">${control.note}</p>
  </div>`).join('')
}

export function bindAuditPerformanceSettings(body, shell = globalThis.window?.mcSettings) {
  const roots = controls.map(control => ({ control, root: body.querySelector(`[data-audit-performance="${control.id}"]`) }))
    .filter(item => item.root)
  if (!roots.length) return
  const saved = Promise.resolve().then(() => shell?.read?.())
  for (const { control, root } of roots) {
    const buttons = [...root.querySelectorAll('[data-audit-choice]')]
    const status = root.querySelector('[data-audit-status]')
    let selected = null, busy = true, available = false
    const paint = message => {
      for (const button of buttons) {
        const on = button.dataset.auditChoice === selected
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', String(on))
        button.disabled = busy || !available
      }
      status.textContent = message || control.descriptions[selected] || 'No description was found for the saved choice. Reopen Settings to read it again.'
    }
    void saved.then(result => {
      const row = result?.rows?.find(item => item.id === control.id)
      available = result?.ok === true && result.available === true && row?.present === true
        && row.control === 'seg' && control.choices.every(value => row.options?.includes(value))
        && control.choices.includes(row.value) && typeof shell?.set === 'function'
        && !result.rejected?.some(item => item.id === '*' || item.id === control.id)
      selected = available ? row.value : null
      busy = false
      paint(available ? null : 'This copy cannot read or change this setting. Update the app and try again.')
    }, () => { busy = false; paint('Could not read the saved choice. Reopen Settings to try again.') })
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-audit-choice]')
      if (!button || !root.contains(button) || button.disabled || busy || !available) return
      const value = button.dataset.auditChoice
      if (!control.choices.includes(value) || selected === value) return
      busy = true; paint('Saving…')
      try {
        const result = await shell.set(control.id, value)
        if (result?.ok !== true || result.value !== value) throw new Error('Setting was not saved.')
        selected = result.value; busy = false; paint()
      } catch { busy = false; paint('Could not save the change. The previous choice is still selected; try again.') }
    })
  }
}
