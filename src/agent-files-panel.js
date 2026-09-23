/* THE FILES AN AGENT LEFT BEHIND, ON SCREEN -- AND A REPORT YOU CAN READ HERE.
 *
 * THE TWO THINGS THE OWNER ASKED FOR, IN ONE PANEL. "pdf and files need to be
 * openable both in mobile and in the app", and "they also need to be able to
 * view reports etc that the agent sends". Before this panel there was no way to
 * do either from inside the application: measured on the tree, `openPath` and
 * `showItemInFolder` appeared zero times in the whole product.
 *
 * WHAT IT IS HONEST ABOUT, AND THIS IS THE FIRST THING IN THE FILE BECAUSE IT
 * IS THE FIRST THING ON THE SCREEN. Nothing in this product records which files
 * an agent wrote. There is no such record in the shell, none in the session
 * events, and none in the transcript -- the only file-shaped fact the session
 * layer keeps is whether a standing rule was filed. So this panel does NOT
 * claim to list what an agent made. It lists the folder that agent works in,
 * newest first, and says so in its own second sentence. A panel headed "what
 * your agent produced" would be a claim nothing on this computer can support,
 * and this codebase's signature defect is exactly that: a screen asserting
 * something no measurement backs.
 *
 * AND IT IS WHY ONE CONTROL ON A ROW CAN BE REFUSED. Because the list cannot
 * tell the person's own file from one an agent wrote, a `cleanup.bat` sitting
 * in that folder is offered beside their invoice. shell/agent-files.cjs decides
 * which kinds may be handed to the operating system at all; this panel renders
 * that answer as a switched-off Open with the reason beside it, and leaves Show
 * in folder and the reading pane live so nothing is hidden from anybody.
 *
 * NO CONTROL HERE IS EVER SILENTLY ABSENT. A row whose file this window cannot
 * show keeps its Read control, disabled, with the reason beside it. A page with
 * no bridge -- a browser, or a build whose preload does not carry it -- keeps
 * every control, disabled, with the reason beside it. The alternative, which
 * this product has shipped before, is a person hunting for a button nobody drew.
 *
 * WHAT IS ON THE SCREEN IS DECIDED SOMEWHERE ELSE. filesPanelSlots() in
 * src/agent-files-copy.js is the whole composition -- which slot carries the
 * condition, which stay empty, and which controls may remain live -- and this
 * file applies it. That split is not tidiness: tools/check-composed-output.mjs
 * measures whole panel states and builds no DOM, so a panel whose composition
 * lives in its render function is a panel that gate cannot see.
 *
 * IT BUILDS ELEMENTS RATHER THAN MARKUP, and that is not a style preference: it
 * is what lets `node --test` drive every state of this panel, including the
 * empty ones and the refusals, which are precisely the states a screenshot is
 * worst at catching. The same reason src/agent-compose-panel.js does it.
 *
 * WHY THE STYLES ARE NOT IMPORTED HERE. src/agent-files-panel.css is imported
 * by the VIEW that mounts this, exactly as src/agent-compose-panel.css is. An
 * `import './agent-files-panel.css'` in this file would make the module
 * unloadable under `node --test`.
 *
 * NOTHING IN THIS FILE JUDGES A PATH, AND NOTHING IN IT DECIDES WHAT MAY RUN.
 * The panel never sees a path: it is given folder ids the main process minted
 * and file names inside them. Whether a file may be opened is answered once, in
 * shell/agent-files.cjs, by the workspace boundary out of this copy of the
 * program and by that module's own list of kinds. A row that arrives with
 * `openable: false` is drawn switched off; it is not re-judged here.
 */

import { markRefusalCode } from './refusal-copy.js'
import { controlState } from './components.js'
import {
  FILES_PANEL,
  fileMetaText,
  filesPanelSlots,
  folderLabel,
  openWhy,
  readWhy,
} from './agent-files-copy.js'

/* The same selector src/owner-popup.js defines, for the same job: which
   elements a Tab press may land on inside an open dialog. */
export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/* THE THREE VERBS A ROW CAN ASK FOR, named rather than trusted. `action` comes
   off a DOM attribute, and `bridge[action]` on an unchecked attribute is a call
   whose name a page decides. */
const ROW_VERBS = Object.freeze(new Set(['open', 'reveal', 'read']))

const asText = value => (typeof value === 'string' ? value : '')

function element(doc, tag, { className = '', text = '', attributes = {} } = {}) {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  return node
}

/* Setting textContent to the empty string removes every child node, in a real
   DOM and in the small fake the suite drives this with. One line, one rule. */
function clear(node) {
  node.textContent = ''
}

/**
 * A control, and the only way this panel makes one.
 *
 * It takes a `controlState`, which THROWS when a control is disabled without a
 * reason. That is the enforcement, not a convention: a control that cannot
 * succeed and does not say why cannot be built by this file at all. The reason
 * goes on the title, for a mouse, AND into a sibling line, for everybody else --
 * a tooltip is not a reason a keyboard or a screen reader ever reaches.
 */
function actionButton(doc, { label, action, name, state }) {
  const button = element(doc, 'button', {
    className: 'agent-files-action',
    text: label,
    attributes: { type: 'button', 'data-files-action': action },
  })
  if (name) button.setAttribute('data-files-name', name)
  if (state.disabled) {
    button.disabled = true
    button.setAttribute('title', state.why)
  }
  return button
}

/**
 * Mount the panel into `container`.
 *
 * @param bridge  window.mcFiles, or null on a page that has no shell. Null is a
 *                first-class state here, not an error: it is what a browser
 *                looking at this product gets, and it renders as every control
 *                disabled with one sentence saying why.
 */
export function mountAgentFilesPanel({
  doc = document,
  container,
  bridge = null,
  locale = undefined,
} = {}) {
  if (!container) throw new Error('the files panel needs somewhere to mount')

  const available = Boolean(bridge)

  const root = element(doc, 'section', {
    className: 'agent-files',
    attributes: { 'data-files-panel': 'agent', 'aria-label': FILES_PANEL.title },
  })

  const header = element(doc, 'header', { className: 'agent-files-header' })
  header.appendChild(element(doc, 'strong', { text: FILES_PANEL.title }))
  const refresh = actionButton(doc, {
    label: FILES_PANEL.refresh, action: 'refresh', state: controlState({ enabled: true, why: '' }),
  })
  header.appendChild(refresh)
  root.appendChild(header)

  root.appendChild(element(doc, 'p', { className: 'agent-files-source', text: FILES_PANEL.source }))
  root.appendChild(element(doc, 'p', { className: 'agent-files-source', text: FILES_PANEL.honesty }))

  const chooser = element(doc, 'label', { className: 'agent-files-chooser', text: FILES_PANEL.folderLabel })
  const folderSelect = element(doc, 'select', {
    attributes: { 'data-files-folder': 'chooser', 'aria-label': FILES_PANEL.folderLabel },
  })
  chooser.appendChild(folderSelect)
  root.appendChild(chooser)

  /* THE ONE LINE THAT EXPLAINS A DISABLED PANEL, in normal flow rather than in
     a tooltip. Present only when there is something to say. */
  const notice = element(doc, 'p', { className: 'agent-files-notice', attributes: { 'data-files-notice': 'panel' } })
  notice.hidden = true
  root.appendChild(notice)

  const listNote = element(doc, 'p', { className: 'agent-files-note', attributes: { 'data-files-note': 'list' } })
  listNote.hidden = true
  root.appendChild(listNote)

  const list = element(doc, 'ul', { className: 'agent-files-list', attributes: { 'data-files-list': 'files' } })
  root.appendChild(list)

  const status = element(doc, 'output', {
    className: 'agent-files-status',
    attributes: { 'data-files-status': 'panel', role: 'status' },
  })
  root.appendChild(status)

  /* THE READING PANE MOUNTS OUTSIDE THE PANEL, and that is not tidiness.
     While it is open the panel is switched off with the `inert` attribute so a
     Tab press cannot walk out of the dialog into the list behind it -- and that
     attribute applies to every descendant. A dialog mounted inside the panel
     would therefore switch ITSELF off: unreachable by keyboard, unclickable by
     mouse, the moment it opened. */
  const viewerRoot = element(doc, 'div', { attributes: { 'data-files-viewer-root': 'panel' } })

  container.appendChild(root)
  container.appendChild(viewerRoot)

  let destroyed = false
  let folders = []
  let viewer = null

  /* EVERYTHING THE PANEL KNOWS, in one place, because the composition is a
     function of all of it at once. `pending` is the only thing that is not a
     reply: it is the line shown while a press is in flight. */
  let shown = { folders: null, list: null, action: null }
  let pending = ''

  /* A BRIDGE THAT THREW TOLD US NOTHING, AND NOTHING IS NOT AN ANSWER. `null`
     in `shown` means "not asked yet", which renders as an empty panel while the
     first read is in flight. A read that came back with nothing has to be a
     refusal instead, or a shell that went away leaves a person looking at a
     blank box -- the state this panel exists to never produce. It carries no
     code, so the sentence is refusalRemedy()'s floor, which is a whole sentence
     with something to do in it. */
  const answered = reply => (reply === null || reply === undefined ? { ok: false } : reply)

  function slotsNow() {
    return filesPanelSlots({ available, ...shown })
  }

  function say(message, tone = '') {
    status.textContent = asText(message)
    if (tone) status.setAttribute('data-tone', tone)
    else status.removeAttribute('data-tone')
  }

  function setNotice(message) {
    notice.textContent = asText(message)
    notice.hidden = asText(message) === ''
  }

  function setListNote(message) {
    listNote.textContent = asText(message)
    listNote.hidden = asText(message) === ''
  }

  /* PUT A CONTROL BACK ON WHEN ITS REASON STOPS BEING TRUE. A Refresh after a
     run that found no folders -- a person setting one up in Settings and coming
     back, which is exactly what the sentence above tells them to do -- must not
     find the control still switched off and still wearing the reason it was
     switched off for. A disabled state that survives the condition that caused
     it is a control that cannot succeed and no longer says anything true about
     why. So this is the only place either control's state is written, and it
     writes both halves every time. */
  function switchControl(node, why) {
    const state = controlState({ enabled: why === '', why })
    node.disabled = state.disabled
    if (state.disabled) node.setAttribute('title', state.why)
    else node.removeAttribute('title')
  }

  /* An empty folder is a SENTENCE, never an empty box. */
  function renderEmpty(message) {
    clear(list)
    const line = element(doc, 'li', { className: 'agent-files-empty', text: message })
    line.setAttribute('data-files-empty', 'panel')
    list.appendChild(line)
  }

  /* The reason beside a control, for everybody a tooltip does not reach. */
  function whyLine(name, action, why) {
    return element(doc, 'span', {
      className: 'agent-files-why',
      text: why,
      attributes: { 'data-files-why': name, 'data-files-why-action': action },
    })
  }

  function renderRows(reply) {
    clear(list)
    for (const file of Array.isArray(reply?.files) ? reply.files : []) {
      const row = element(doc, 'li', { className: 'agent-files-row' })
      row.setAttribute('data-files-row', file.name)
      row.appendChild(element(doc, 'span', { className: 'agent-files-name', text: file.name }))
      row.appendChild(element(doc, 'span', {
        className: 'agent-files-meta', text: fileMetaText(file, { locale }),
      }))
      const actions = element(doc, 'span', { className: 'agent-files-actions' })
      /* THE TWO PER-ROW REFUSALS, AND NEITHER OF THEM IS DECIDED HERE. The
         shell already answered which files this window can show and which kinds
         may be handed to this computer, so the row does not hold a second copy
         of either rule. It renders the answers, disabled, with the reason
         beside them. */
      for (const [action, label, why] of [
        ['open', FILES_PANEL.open, openWhy(file, { available })],
        ['reveal', FILES_PANEL.reveal, available ? '' : FILES_PANEL.needsApp],
        ['read', FILES_PANEL.read, readWhy(file, { available })],
      ]) {
        actions.appendChild(actionButton(doc, {
          label, action, name: file.name, state: controlState({ enabled: why === '', why }),
        }))
        if (why) actions.appendChild(whyLine(file.name, action, why))
      }
      row.appendChild(actions)
      list.appendChild(row)
    }
  }

  /* ---------- one render, from one composition ---------- */

  /* The status line only. Split from the list below because a press must not
     rebuild the rows: the control that was pressed is the node focus returns to
     when the reading pane closes, and a rebuilt row hands that back a node that
     is no longer in the document. */
  function renderStatus() {
    const slots = slotsNow()
    if (pending) {
      say(pending)
      markRefusalCode(status, null)
      return
    }
    say(slots.status, slots.tone)
    markRefusalCode(status, slots.refusal)
  }

  function render() {
    const slots = slotsNow()
    setNotice(slots.notice)
    setListNote(slots.listNote)
    if (slots.rows) renderRows(shown.list)
    else if (slots.listLine) renderEmpty(slots.listLine)
    else clear(list)
    switchControl(refresh, slots.controlsWhy)
    switchControl(folderSelect, slots.controlsWhy || slots.chooserWhy)
    renderStatus()
  }

  async function loadFiles() {
    if (!available || destroyed) return
    const folderId = folderSelect.value
    if (!folderId) return
    pending = FILES_PANEL.loading
    renderStatus()
    let reply
    try { reply = await bridge.list({ folderId }) } catch { reply = null }
    if (destroyed) return
    pending = ''
    shown = { ...shown, list: answered(reply), action: null }
    render()
  }

  async function loadFolders() {
    if (!available) { render(); return }
    let reply
    try { reply = await bridge.folders() } catch { reply = null }
    if (destroyed) return
    shown = { folders: answered(reply), list: null, action: null }
    folders = Array.isArray(reply?.folders) ? reply.folders : []
    clear(folderSelect)
    for (const folder of folders) {
      const option = doc.createElement('option')
      option.value = folder.id
      option.textContent = folderLabel(folder)
      folderSelect.appendChild(option)
    }
    if (folders.length > 0) folderSelect.value = folders[0].id
    render()
    if (folders.length > 0) await loadFiles()
  }

  /* ---------- the reading pane ---------- */

  function closeViewer({ restoreFocus = true } = {}) {
    if (!viewer) return
    const open = viewer
    viewer = null
    doc.removeEventListener('keydown', open.onKeydown)
    root.toggleAttribute('inert', open.hadInert)
    clear(viewerRoot)
    if (restoreFocus && open.priorFocus && typeof open.priorFocus.focus === 'function') open.priorFocus.focus()
  }

  /* The trap owner-popup.js runs, with one deliberate difference: it filters
     its stops on `offsetParent`, which is a layout fact a browser computes and
     nothing else can. This dialog is either mounted or removed, so `hidden` and
     `disabled` are the whole of the question here. */
  function trapFocus(event) {
    if (!viewer) return
    if (event.key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      closeViewer()
      return
    }
    if (event.key !== 'Tab') return
    const stops = [...viewer.dialog.querySelectorAll(FOCUSABLE)]
      .filter(node => !node.disabled && node.hidden !== true)
    if (!stops.length) {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      viewer.dialog.focus()
      return
    }
    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && doc.activeElement === first) {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && doc.activeElement === last) {
      if (typeof event.preventDefault === 'function') event.preventDefault()
      first.focus()
    }
  }

  /* WHERE FOCUS GOES WHEN THE PANE CLOSES, decided at the moment it opens.
     `document.activeElement` alone is not enough: a browser focuses a button
     it is clicked on, but a press delivered any other way -- a driver, an
     assistive technology's activate, a synthetic event -- leaves it elsewhere
     or nowhere, and focus then returns to a node that has been removed. So the
     control that was pressed is passed in and preferred, and the live
     activeElement is the fallback rather than the rule. */
  function openViewer(name, text, trigger) {
    closeViewer({ restoreFocus: false })
    const priorFocus = trigger && typeof trigger.focus === 'function' ? trigger : doc.activeElement
    const overlay = element(doc, 'div', { className: 'agent-files-overlay' })
    const dialog = element(doc, 'div', {
      className: 'agent-files-dialog',
      attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-label': name, tabindex: '-1', 'data-files-dialog': name },
    })
    const bar = element(doc, 'header', { className: 'agent-files-dialog-bar' })
    bar.appendChild(element(doc, 'strong', { text: name }))
    const close = element(doc, 'button', {
      className: 'agent-files-action',
      text: FILES_PANEL.close,
      attributes: { type: 'button', 'data-files-action': 'close' },
    })
    bar.appendChild(close)
    dialog.appendChild(bar)
    /* PLAIN TEXT IN A SCROLLING PANE. A markdown library is a dependency, and
       adding one needs the owner's word; a report read as written is the honest
       rendering either way. `tabindex="0"` because a pane a mouse can scroll
       and a keyboard cannot is not readable. */
    const pane = element(doc, 'pre', {
      className: 'agent-files-report',
      text,
      attributes: { tabindex: '0', 'data-files-report': name },
    })
    dialog.appendChild(pane)
    overlay.appendChild(dialog)
    viewerRoot.appendChild(overlay)

    const hadInert = root.hasAttribute('inert')
    root.setAttribute('inert', '')

    viewer = { dialog, overlay, priorFocus, hadInert, onKeydown: event => trapFocus(event) }
    doc.addEventListener('keydown', viewer.onKeydown)
    close.focus()
  }

  /* ---------- what a press does ---------- */

  async function act(action, name, trigger) {
    if (!available || destroyed || !ROW_VERBS.has(action)) return
    const folderId = folderSelect.value
    pending = action === 'open' ? FILES_PANEL.opening
      : action === 'reveal' ? FILES_PANEL.showing
        : FILES_PANEL.reading
    renderStatus()
    let reply
    try { reply = await bridge[action]({ folderId, name }) } catch { reply = null }
    if (destroyed) return
    pending = ''
    shown = { ...shown, action: { verb: action, result: answered(reply) } }
    renderStatus()
    if (action === 'read' && reply?.ok === true) openViewer(name, asText(reply.text), trigger)
  }

  function onClick(event) {
    const target = event?.target
    if (!target || typeof target.getAttribute !== 'function') return
    /* A DISABLED CONTROL IS NOT A CONTROL. A real browser fires no click on
       one; a driver, an assistive technology and a synthetic event all can, and
       the whole point of a switched-off Open is that no press reaches the
       bridge behind it. */
    if (target.disabled) return
    const action = target.getAttribute('data-files-action')
    if (!action) return
    if (action === 'close') { closeViewer(); return }
    if (action === 'refresh') { void loadFolders(); return }
    void act(action, target.getAttribute('data-files-name'), target)
  }

  function onChange(event) {
    if (event?.target !== folderSelect) return
    void loadFiles()
  }

  root.addEventListener('click', onClick)
  root.addEventListener('change', onChange)
  /* The reading pane is a sibling of the panel, so its Close needs its own
     listener; one handler, two roots. */
  viewerRoot.addEventListener('click', onClick)

  const ready = loadFolders()

  return {
    element: () => root,
    ready: () => ready,
    refresh: () => loadFolders(),
    destroy() {
      if (destroyed) return
      destroyed = true
      closeViewer({ restoreFocus: false })
      root.removeEventListener('click', onClick)
      root.removeEventListener('change', onChange)
      viewerRoot.removeEventListener('click', onClick)
      if (root.parentNode) root.parentNode.removeChild(root)
      if (viewerRoot.parentNode) viewerRoot.parentNode.removeChild(viewerRoot)
    },
  }
}
