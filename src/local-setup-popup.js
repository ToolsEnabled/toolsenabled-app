/* "SET UP LOCAL MODELS": ONE POPUP, ONLY THE STEPS STILL NEEDED.
 *
 * The popup asks the machine what is already done (shell/local-model-setup.cjs
 * status(), answered from the same engine probes an agent start uses) and draws
 * only what is left, in this order:
 *   Get Ollama      only when no Ollama is here and nothing answers;
 *   Start Ollama    only when it is here but not answering at the saved address;
 *   Choose a model  only when no chosen model is downloaded, or the person asks
 *                   for another -- models that fit the graphics card first;
 *   Ready           saves the address and the default model through
 *                   window.mcSettings.setMany (the path the Settings page saves
 *                   with), then asks the engine whether a Local agent can start.
 *
 * NOTHING HERE LOADS A MODEL. "Ready" is the engine's own start check
 * (resolveLocalTarget), which reads settings and lists models; loading weights
 * waits for a real agent turn. A model whose need is close to the memory free
 * right now is marked before it is chosen.
 *
 * Opened from Settings → Local models, from a Local start that was refused, and
 * from choosing the Local model for a new agent. One popup at a time: a second
 * open brings the first one forward.
 */
import { LOCAL_SETUP_POPUP as COPY } from './local-model-setup-copy.js'

const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

/* The start refusals this popup is the way out of. */
export const LOCAL_SETUP_CODES = Object.freeze(['LOCAL_NODE_RUNTIME_UNAVAILABLE', 'LOCAL_NODE_MODEL_NOT_INSTALLED'])
export function offersLocalSetup(code) {
  return typeof code === 'string' && LOCAL_SETUP_CODES.includes(code)
}

/* Download sizes the way the model library prints them: decimal units. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/* WHICH STEPS THIS COMPUTER STILL NEEDS, from one status answer. A step that
   is already done is not listed at all. `blocker` names a state no button
   here can fix (an address on another computer, one that cannot be used, a
   computer with no Ollama download); the popup says what to do instead. */
export function localSetupPlan(status) {
  if (!status || status.ok !== true) return Object.freeze({ steps: Object.freeze([]), blocker: null })
  if (status.ready) return Object.freeze({ steps: Object.freeze([]), blocker: null })
  const steps = []
  if (!status.running) {
    if (!status.address?.usable) return Object.freeze({ steps: Object.freeze([]), blocker: 'unusable' })
    if (!status.address?.local) return Object.freeze({ steps: Object.freeze([]), blocker: 'remote' })
    if (!status.installed) {
      if (!status.installSupported && !status.installerReady) return Object.freeze({ steps: Object.freeze([]), blocker: 'unsupported' })
      steps.push('install')
    }
    steps.push('start')
  }
  if (!status.running || !status.chosen?.installed) steps.push('choose')
  steps.push('finish')
  return Object.freeze({ steps: Object.freeze(steps), blocker: null })
}

/* A refusal or failure, as the sentence a person reads. */
export function setupSentence(answer) {
  const code = typeof answer === 'string' ? answer : answer?.code
  if ((code === 'LOCAL_SETUP_DISK_FULL') && Number.isFinite(answer?.needBytes) && Number.isFinite(answer?.freeBytes)) {
    return COPY.diskFull(formatBytes(answer.needBytes), formatBytes(answer.freeBytes))
  }
  if (code === 'LOCAL_SETUP_DISK_FULL') return COPY.refusals.LOCAL_SETUP_PULL_DISK_FULL
  return (typeof code === 'string' && COPY.refusals[code]) || COPY.fallback
}

function machineSentence(hardware) {
  if (!hardware || !Number.isFinite(hardware.ramBytes)) return ''
  return COPY.machine({
    ram: formatBytes(hardware.ramBytes),
    gpu: hardware.gpuName || '',
    vram: formatBytes(hardware.vramBytes),
  })
}

function modelRows(status) {
  const held = Array.isArray(status?.held) ? status.held : []
  const offered = (Array.isArray(status?.catalogue) ? status.catalogue : []).filter(entry => !entry.downloaded)
  return { held, offered }
}

function rowFor(status, id) {
  const { held, offered } = modelRows(status)
  const found = held.find(row => row.id === id)
  if (found) return { ...found, downloaded: true }
  const entry = offered.find(row => row.id === id)
  return entry ? { ...entry, downloaded: false } : null
}

/* The model pre-selected when the step opens: the one already chosen when it
   is downloaded, else the suggested one (the largest that fits the graphics
   card and is not tight right now), else nothing. */
function defaultPick(status) {
  const chosen = status?.chosen?.name
  if (chosen && rowFor(status, chosen)) return chosen
  if (status?.recommended && rowFor(status, status.recommended)?.fit !== 'too-big') return status.recommended
  return null
}

let openPopup = null

/**
 * Open the popup (or bring the open one forward).
 *
 * @param bridge    window.mcProviders: localSetupStatus/Install/CancelInstall/
 *                  RunInstaller/Start/Pull/CancelPull/Check, onLocalSetupEvent.
 * @param settings  window.mcSettings: setMany, the Settings page's own writer.
 * @param reason    an optional sentence saying why it opened (a refusal).
 * @param onReady   called once a Local agent can start.
 * @param onClose   called once, however the popup leaves.
 */
export function openLocalModelSetup({
  document = globalThis.document,
  host = globalThis.document?.body,
  bridge = globalThis.window?.mcProviders ?? globalThis.mcProviders,
  settings = globalThis.window?.mcSettings ?? globalThis.mcSettings,
  reason = '',
  onReady = () => {},
  onClose = () => {},
} = {}) {
  if (!document || !host) return null
  if (openPopup && !openPopup.isClosed()) {
    openPopup.listen({ onReady, onClose })
    openPopup.focus()
    return openPopup
  }
  const readyListeners = [onReady]
  const closeListeners = [onClose]
  const uid = `local-setup-${Math.random().toString(36).slice(2, 8)}`
  const root = document.createElement('dialog')
  root.className = 'local-setup'
  root.setAttribute('aria-labelledby', `${uid}-title`)
  root.setAttribute('data-local-setup', '')
  root.innerHTML = `
    <form method="dialog" class="local-setup-form">
      <h3 id="${uid}-title" class="local-setup-title">${escapeMarkup(COPY.title)}</h3>
      ${reason ? `<p class="local-setup-why" data-local-setup-why>${escapeMarkup(reason)}</p>` : ''}
      <ol class="local-setup-steps" data-local-setup-steps></ol>
      <div class="local-setup-body" data-local-setup-body></div>
      <p class="local-setup-status" role="status" aria-live="polite" data-local-setup-status></p>
      <div class="local-setup-actions" data-local-setup-actions></div>
    </form>`

  const available = bridge && typeof bridge.localSetupStatus === 'function'
  let status = null
  let plan = null
  let picked = null
  let chosenHere = false
  let wantsAnother = false
  let busy = null
  let message = ''
  let detail = ''
  let installing = null
  let pulling = null
  let installerOpen = false
  let readyReported = false
  let closed = false
  let unsubscribe = null
  let lastView = ''

  const opener = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null
  const part = name => root.querySelector(`[data-local-setup-${name}]`)

  function view() {
    if (!available) return 'absent'
    if (!status) return 'checking'
    if (status.ok !== true) return 'unreadable'
    const blocker = localSetupPlan(status).blocker
    if (blocker && !status.running) return blocker
    if (status.ready && !wantsAnother) return 'ready'
    if (!status.running) return status.installed ? 'start' : 'install'
    if (wantsAnother || (!status.chosen?.installed && !chosenHere) || pulling) return 'choose'
    return 'finish'
  }

  function stepsMarkup(current) {
    if (!plan || !plan.steps.length) return ''
    const steps = plan.steps
    const at = steps.indexOf(current === 'ready' ? 'finish' : current)
    return steps.map((step, index) => {
      const state = current === 'ready' || (at >= 0 && index < at) ? 'done' : index === at ? 'current' : 'next'
      return `<li class="local-setup-step is-${state}" data-local-setup-step="${step}"${state === 'current' ? ' aria-current="step"' : ''}>`
        + `<span class="local-setup-step-count">${escapeMarkup(COPY.stepOf(index + 1, steps.length))}</span> `
        + `<span class="local-setup-step-name">${escapeMarkup(COPY.stepNames[step])}</span>`
        + `${state === 'done' ? ` <small class="local-setup-step-done">${escapeMarkup(COPY.stepDone)}</small>` : ''}</li>`
    }).join('')
  }

  function progressMarkup(done, total) {
    const value = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? Math.min(1000, Math.round((done / total) * 1000)) : null
    return value === null
      ? '<progress class="local-setup-progress" data-local-setup-progress max="1000"></progress>'
      : `<progress class="local-setup-progress" data-local-setup-progress max="1000" value="${value}"></progress>`
  }

  function installLine() {
    const progress = installing || {}
    if (progress.phase === 'download') return COPY.downloading(formatBytes(progress.received || 0), progress.total ? formatBytes(progress.total) : '')
    if (progress.phase === 'verify') return COPY.verifying
    if (progress.phase === 'unpack') return COPY.unpacking
    return COPY.release
  }

  function pullLine() {
    const row = rowFor(status, pulling?.model)
    const label = row?.label || pulling?.model || ''
    return COPY.pulling(label, formatBytes(pulling?.completed || 0), pulling?.total ? formatBytes(pulling.total) : '')
  }

  function button(action, label, { primary = false, disabled = false } = {}) {
    return `<button type="button" class="local-setup-btn${primary ? ' is-primary' : ''}" data-local-setup-action="${action}"${primary ? ' data-local-setup-primary' : ''}${disabled ? ' disabled' : ''}>${escapeMarkup(label)}</button>`
  }

  function modelRowMarkup(row, downloaded) {
    const checked = row.id === picked
    const tooBig = row.fit === 'too-big'
    const facts = [
      downloaded ? COPY.downloaded : (row.downloadBytes ? COPY.size(formatBytes(row.downloadBytes)) : ''),
      downloaded && row.sizeBytes ? COPY.heldSize(formatBytes(row.sizeBytes)) : '',
      COPY.fit[row.fit] || COPY.fit.unknown,
    ].filter(Boolean).join(' · ')
    const summary = COPY.summaries[row.id] || (row.listed === false ? '' : COPY.genericSummary)
    return `<label class="local-setup-model${checked ? ' is-picked' : ''}${tooBig ? ' is-off' : ''}" data-local-setup-model="${escapeMarkup(row.id)}" data-fit="${escapeMarkup(row.fit || 'unknown')}">`
      + `<input type="radio" name="${uid}-model" value="${escapeMarkup(row.id)}" data-local-setup-pick="${escapeMarkup(row.id)}"${checked ? ' checked' : ''}${tooBig || pulling ? ' disabled' : ''}>`
      + ` <span class="local-setup-model-name">${escapeMarkup(row.label || row.id)}</span>`
      + `${row.id === status?.recommended ? ` <span class="local-setup-model-tag" data-local-setup-recommended>${escapeMarkup(COPY.recommended)}</span>` : ''}`
      + `${summary ? ` <small class="local-setup-model-summary">${escapeMarkup(summary)}</small>` : ''}`
      + ` <small class="local-setup-model-facts">${escapeMarkup(facts)}</small>`
      + `${row.tight ? ` <small class="local-setup-model-warn" data-local-setup-tight>${escapeMarkup(COPY.tight)}</small>` : ''}`
      + '</label>'
  }

  function settingNotes(model) {
    const notes = []
    const row = rowFor(status, model)
    if (row?.fit === 'cpu' && status?.gpuPolicy === 'Require GPU') notes.push(`<p class="local-setup-note" data-local-setup-cpu>${escapeMarkup(COPY.cpuPolicy)}</p>`)
    if (status?.provider && !['Ollama', 'Not configured', ''].includes(status.provider) && status.savedEndpoint) {
      notes.push(`<p class="local-setup-note" data-local-setup-replaces>${escapeMarkup(COPY.replaces(status.provider, status.savedEndpoint))}</p>`)
    }
    return notes.join('')
  }

  function paint() {
    if (closed) return
    const current = view()
    if (status && status.ok === true && (!plan || (current !== 'ready' && !plan.steps.includes(current) && ['install', 'start', 'choose', 'finish'].includes(current)))) {
      plan = wantsAnother ? Object.freeze({ steps: Object.freeze(['choose', 'finish']), blocker: null }) : localSetupPlan(status)
    }
    const focusedAction = root.contains(document.activeElement) ? document.activeElement?.getAttribute?.('data-local-setup-action') : null
    part('steps').innerHTML = stepsMarkup(current)
    let body = ''
    let actions = ''
    const address = status?.address?.url || ''
    if (current === 'absent') {
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.noBridge)}</p>`
      actions = button('close', COPY.close, { primary: true })
    } else if (current === 'checking') {
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.checking)}</p>`
      actions = button('close', COPY.close)
    } else if (current === 'unreadable') {
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.unreadable)}</p>`
      actions = button('check', COPY.checkAgain, { primary: true }) + button('close', COPY.close)
    } else if (current === 'unusable' || current === 'remote' || current === 'unsupported') {
      const sentence = current === 'unusable' ? COPY.unusable(address) : current === 'remote' ? COPY.remote(address) : COPY.installUnsupported
      body = `<p class="local-setup-lead" data-local-setup-blocker="${current}">${escapeMarkup(sentence)}</p>`
      actions = button('check', COPY.checkAgain, { primary: true }) + button('close', COPY.close)
    } else if (current === 'install') {
      const how = COPY.installHow[status.platform] || COPY.installHow.linux
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.installLead)}</p><p class="local-setup-note">${escapeMarkup(how)}</p>`
      if (installing) {
        body += `${progressMarkup(installing.received, installing.total)}<p class="local-setup-progress-line" data-local-setup-progress-line>${escapeMarkup(installLine())}</p>`
          + `<p class="local-setup-note">${escapeMarkup(COPY.background)}</p>`
        actions = button('cancel-install', COPY.cancel, { primary: true }) + button('close', COPY.close)
      } else if (status.installerReady) {
        body += `<p class="local-setup-note" data-local-setup-installer>${escapeMarkup(installerOpen ? COPY.installerRunning : COPY.installerReady)}</p>`
        actions = button('run-installer', COPY.runInstaller, { primary: true, disabled: installerOpen }) + button('check', COPY.checkAgain) + button('close', COPY.close)
      } else {
        /* Check again is here too: a person may install Ollama another way
           while this is open. */
        actions = button('install', COPY.installButton, { primary: true }) + button('check', COPY.checkAgain) + button('close', COPY.close)
      }
    } else if (current === 'start') {
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.startLead(address))}</p>`
      actions = button('start', COPY.startButton, { primary: true, disabled: busy === 'start' }) + button('check', COPY.checkAgain) + button('close', COPY.close)
    } else if (current === 'choose') {
      if (!picked || !rowFor(status, picked)) picked = defaultPick(status)
      const { held, offered } = modelRows(status)
      const machine = machineSentence(status.hardware)
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.chooseLead)}</p>${machine ? `<p class="local-setup-note" data-local-setup-machine>${escapeMarkup(machine)}</p>` : ''}`
      if (held.length) body += `<fieldset class="local-setup-group" data-local-setup-held><legend>${escapeMarkup(COPY.heldHeading)}</legend>${held.map(row => modelRowMarkup(row, true)).join('')}</fieldset>`
      if (offered.length) body += `<fieldset class="local-setup-group" data-local-setup-offered><legend>${escapeMarkup(COPY.offeredHeading)}</legend>${offered.map(row => modelRowMarkup(row, false)).join('')}</fieldset>`
      body += settingNotes(picked)
      if (pulling) {
        body += `${progressMarkup(pulling.completed, pulling.total)}<p class="local-setup-progress-line" data-local-setup-progress-line>${escapeMarkup(pullLine())}</p>`
          + `<p class="local-setup-note">${escapeMarkup(COPY.background)}</p>`
        actions = button('cancel-pull', COPY.cancel, { primary: true }) + button('close', COPY.close)
      } else {
        const row = rowFor(status, picked)
        actions = button(row?.downloaded ? 'use' : 'download', row?.downloaded ? COPY.useButton : COPY.downloadButton, { primary: true, disabled: !row || row.fit === 'too-big' || Boolean(busy) })
          + button('close', COPY.close)
      }
    } else if (current === 'finish') {
      const model = picked || status.chosen?.name || status.chosen?.model || ''
      body = `<p class="local-setup-lead">${escapeMarkup(COPY.finishLead)}</p>${settingNotes(model)}`
      actions = button('finish', COPY.finishButton, { primary: true, disabled: Boolean(busy) }) + button('check', COPY.checkAgain, { disabled: Boolean(busy) }) + button('close', COPY.close)
    } else if (current === 'ready') {
      const model = status.chosen?.name || status.chosen?.model || ''
      const sentence = readyReported ? COPY.ready(model, address) : COPY.alreadyReady(model, address)
      body = `<p class="local-setup-lead" data-local-setup-ready>${escapeMarkup(sentence)}</p>`
      const row = rowFor(status, model)
      if (row?.tight) body += `<p class="local-setup-note" data-local-setup-tight>${escapeMarkup(COPY.tight)}</p>`
      if (status.startedHere) body += `<p class="local-setup-note">${escapeMarkup(COPY.startedHere)}</p>`
      actions = button('done', COPY.done, { primary: true }) + button('another', COPY.another)
    }
    /* The Ollama this app started keeps running when its log cannot be
       written; the popup says the log is not being saved. */
    const logUnsaved = status?.startedHere && ['choose', 'finish', 'ready'].includes(current) ? COPY.logUnsaved[status.logProblem] : null
    if (logUnsaved) body += `<p class="local-setup-note" data-local-setup-log>${escapeMarkup(logUnsaved)}</p>`
    part('body').innerHTML = body
    part('actions').innerHTML = actions
    part('status').textContent = [message, detail].filter(Boolean).join(' ')
    root.dataset.localSetupView = current
    const refocus = (focusedAction && root.querySelector(`[data-local-setup-action="${focusedAction}"]`)) || null
    const target = refocus && !refocus.disabled ? refocus : (current !== lastView || !root.contains(document.activeElement) ? part('primary') : null)
    lastView = current
    if (target && !target.disabled) { try { target.focus() } catch { /* not focusable */ } }
    /* The picked model is kept in view inside its scrolling list. */
    if (current === 'choose' && picked) {
      const row = [...root.querySelectorAll('[data-local-setup-model]')].find(node => node.getAttribute('data-local-setup-model') === picked)
      try { row?.scrollIntoView?.({ block: 'nearest' }) } catch { /* nothing to scroll */ }
    }
  }

  /* Progress arrives several times a second; only the bar and its line are
     rewritten, so the Cancel button keeps the keyboard. */
  function paintProgress() {
    const bar = part('progress')
    const line = part('progress-line')
    if (!bar || !line) { paint(); return }
    const source = view() === 'install' ? installing : pulling
    if (!source) { paint(); return }
    const done = view() === 'install' ? source.received : source.completed
    if (Number.isFinite(done) && Number.isFinite(source.total) && source.total > 0) bar.setAttribute('value', String(Math.min(1000, Math.round((done / source.total) * 1000))))
    line.textContent = view() === 'install' ? installLine() : pullLine()
  }

  async function refresh() {
    let answer = null
    try { answer = await bridge.localSetupStatus() } catch { answer = null }
    if (closed) return status
    status = answer && typeof answer === 'object' ? answer : { ok: false }
    if (status.ok === true) {
      const activity = status.activity || {}
      installing = activity.install?.running ? { ...activity.install } : null
      pulling = activity.pull?.running ? { ...activity.pull } : null
    }
    if (status.ready && !wantsAnother && !readyReported && chosenHere) {
      readyReported = true
      announceReady()
    }
    paint()
    return status
  }

  async function act(call, { busyAs = null, before = '' } = {}) {
    busy = busyAs
    message = before
    detail = ''
    paint()
    let answer = null
    try { answer = await call() } catch { answer = null }
    busy = null
    if (closed) return null
    if (!answer || answer.ok !== true) {
      message = setupSentence(answer)
      detail = typeof answer?.detail === 'string' && answer.detail.trim() ? COPY.ollamaSaid(answer.detail.trim()) : ''
      paint()
      return null
    }
    return answer
  }

  async function saveAndCheck(model) {
    const row = rowFor(status, model)
    const items = [
      { id: 'model.provider', value: 'Ollama' },
      { id: 'model.endpoint', value: status.address.url },
      { id: 'model.local_agent_name', value: model },
    ]
    if (row?.fit === 'cpu' && status.gpuPolicy === 'Require GPU') items.push({ id: 'model.local_gpu_policy', value: 'Allow CPU fallback' })
    busy = 'save'
    message = COPY.saving
    detail = ''
    paint()
    let answer = null
    try { answer = typeof settings?.setMany === 'function' ? await settings.setMany(items) : null } catch { answer = null }
    const results = Array.isArray(answer?.results) ? answer.results : []
    const saved = results.length === items.length && results.every(result => result?.ok === true)
    if (closed) return
    if (!saved) {
      busy = null
      message = COPY.saveRefused
      paint()
      return
    }
    chosenHere = true
    wantsAnother = false
    busy = 'check'
    message = COPY.checkingReady
    paint()
    await refresh()
    busy = null
    if (closed) return
    if (status?.ready) {
      message = ''
      if (!readyReported) {
        readyReported = true
        announceReady()
      }
    } else {
      message = status?.readyCode && COPY.refusals[status.readyCode] ? COPY.refusals[status.readyCode] : COPY.notReadyYet
    }
    paint()
  }

  async function handle(action) {
    if (closed) return
    if (action === 'close' || action === 'done') { close(); return }
    if (action === 'check') { message = ''; detail = ''; await refresh(); return }
    if (action === 'another') { wantsAnother = true; chosenHere = false; picked = defaultPick(status); plan = null; message = ''; paint(); return }
    if (action === 'install') {
      const answer = await act(() => bridge.localSetupInstall())
      if (answer) { installing = { phase: 'release' }; message = ''; paint() }
      return
    }
    if (action === 'cancel-install') { try { await bridge.localSetupCancelInstall() } catch { /* the event says what happened */ } return }
    if (action === 'run-installer') {
      const answer = await act(() => bridge.localSetupRunInstaller())
      if (answer) { installerOpen = true; message = ''; paint() }
      return
    }
    if (action === 'start') {
      const answer = await act(() => bridge.localSetupStart(), { busyAs: 'start', before: COPY.starting })
      if (answer) { message = answer.startedHere ? COPY.startedHere : ''; await refresh() }
      return
    }
    if (action === 'use') {
      if (!picked) { message = COPY.pickFirst; paint(); return }
      await saveAndCheck(picked)
      return
    }
    if (action === 'download') {
      if (!picked) { message = COPY.pickFirst; paint(); return }
      const model = picked
      const answer = await act(() => bridge.localSetupPull({ model }))
      if (answer) { pulling = { model, completed: 0, total: rowFor(status, model)?.downloadBytes || null }; message = ''; paint() }
      return
    }
    if (action === 'cancel-pull') { try { await bridge.localSetupCancelPull() } catch { /* the event says what happened */ } return }
    if (action === 'finish') {
      const model = picked || status?.chosen?.name || status?.chosen?.model
      if (!model) { message = COPY.pickFirst; paint(); return }
      await saveAndCheck(model)
    }
  }

  async function onEvent(packet) {
    if (closed || !packet || typeof packet !== 'object') return
    if (packet.kind === 'install') {
      if (['release', 'download', 'verify', 'unpack'].includes(packet.phase)) {
        const phaseChanged = installing?.phase !== packet.phase
        installing = { ...packet }
        if (phaseChanged) paint(); else paintProgress()
        return
      }
      installing = null
      if (packet.phase === 'failed' || packet.phase === 'cancelled') message = setupSentence(packet)
      else if (packet.phase === 'done' && packet.version) message = COPY.installed(packet.version)
      else message = ''
      await refresh()
      return
    }
    if (packet.kind === 'installer') {
      installerOpen = false
      message = packet.phase === 'done' ? '' : setupSentence(packet)
      await refresh()
      return
    }
    if (packet.kind === 'pull') {
      if (pulling && packet.model && packet.model !== pulling.model) return
      if (packet.phase === 'progress') {
        pulling = { ...(pulling || {}), ...packet }
        paintProgress()
        return
      }
      const model = pulling?.model || packet.model
      pulling = null
      if (packet.phase === 'done') {
        const row = rowFor(status, model)
        message = COPY.pullDone(row?.label || model)
        detail = ''
        await refresh()
        if (!closed) await saveAndCheck(model)
        return
      }
      message = setupSentence(packet)
      detail = packet.detail && packet.code !== 'LOCAL_SETUP_CANCELLED' ? COPY.ollamaSaid(packet.detail) : ''
      await refresh()
    }
  }

  root.addEventListener('click', event => {
    const control = event.target?.closest?.('[data-local-setup-action]')
    if (!control || control.disabled || !root.contains(control)) return
    event.preventDefault?.()
    void handle(control.getAttribute('data-local-setup-action'))
  })
  root.addEventListener('change', event => {
    const input = event.target?.closest?.('[data-local-setup-pick]')
    if (!input || !root.contains(input)) return
    picked = input.getAttribute('data-local-setup-pick')
    message = ''
    paint()
  })
  root.addEventListener('cancel', event => { event.preventDefault?.(); close() })

  function close() {
    if (closed) return
    closed = true
    try { unsubscribe?.() } catch { /* already detached */ }
    try { if (typeof root.close === 'function' && root.open) root.close() } catch { /* already closed */ }
    root.remove()
    if (openPopup === controller) openPopup = null
    if (opener && opener.isConnected !== false && !root.contains(opener)) { try { opener.focus() } catch { /* the opener may be gone */ } }
    for (const listener of closeListeners) {
      try { listener({ ready: Boolean(status?.ready) }) } catch { /* a release hook must not keep the popup on screen */ }
    }
  }

  function announceReady() {
    for (const listener of readyListeners) {
      try { listener(status) } catch { /* the caller's hook must not keep the popup open */ }
    }
  }

  const controller = {
    root,
    close,
    dispose: close,
    isClosed: () => closed,
    focus: () => { const target = part('primary'); try { (target || root).focus() } catch { /* not focusable */ } },
    refresh,
    listen: ({ onReady: ready, onClose: closing } = {}) => {
      if (typeof ready === 'function') readyListeners.push(ready)
      if (typeof closing === 'function') closeListeners.push(closing)
    },
    state: () => ({ view: view(), plan: plan ? [...plan.steps] : [], picked, busy, message }),
  }
  openPopup = controller
  host.appendChild(root)
  if (available && typeof bridge.onLocalSetupEvent === 'function') {
    try { unsubscribe = bridge.onLocalSetupEvent(packet => { void onEvent(packet) }) } catch { unsubscribe = null }
  }
  paint()
  try { if (typeof root.showModal === 'function') root.showModal() } catch { root.open = true }
  controller.ready = available ? refresh() : Promise.resolve(null)
  return controller
}

/* Whether the popup has anything to do on this computer right now. A read that
   cannot answer says nothing is needed: the start refusal still offers the
   popup if it turns out to be. */
export async function localSetupNeeded(bridge = globalThis.window?.mcProviders ?? globalThis.mcProviders) {
  if (!bridge || typeof bridge.localSetupStatus !== 'function') return false
  try {
    const status = await bridge.localSetupStatus()
    return Boolean(status && status.ok === true && status.ready !== true)
  } catch {
    return false
  }
}

/* Open the popup and settle with whether it ended ready. */
export function openLocalModelSetupUntilClosed(options = {}) {
  return new Promise(resolve => {
    let ready = false
    const popup = openLocalModelSetup({
      ...options,
      onReady: status => { ready = true; options.onReady?.(status) },
      onClose: result => { options.onClose?.(result); resolve(ready || Boolean(result?.ready)) },
    })
    if (!popup) resolve(false)
  })
}

/* The Settings → Local models entry: one sentence and the button. */
export function localSetupEntryElement(document) {
  const entry = document.createElement('div')
  entry.className = 'local-setup-entry'
  entry.setAttribute('data-local-setup-entry', '')
  entry.innerHTML = `<p class="settings-desc local-setup-entry-lead">${escapeMarkup(COPY.entryLead)}</p>`
    + `<button type="button" class="ctl-btn local-setup-entry-btn" data-local-setup-open>${escapeMarkup(COPY.openButton)}</button>`
  return entry
}
