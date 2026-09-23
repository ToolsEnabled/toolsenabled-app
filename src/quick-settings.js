import { THEME_CHOICES, currentTheme } from './theme-choice.js'
import { HOME_CIRCLE_STYLES, currentHomeCircleStyle, setHomeCircleStyle } from './home-circle-choice.js'
import { blobMomentsEnabled, setBlobMomentsEnabled } from './home-circle-playful-moment.js'
import { agentApiSettingMarkup, bindAgentApiSetting } from './agent-api-setting.js'
import { auditPerformanceSettingsMarkup, bindAuditPerformanceSettings } from './audit-performance-settings.js'
/* THE UPPER-RIGHT SETTINGS CONTROL, MADE PAGE-AWARE (owner, R1520).
 *
 * The owner's words: "the settings in the software in the upper right corner
 * still goes to show simulation settings, it should show per page settings
 * with a quick move to settings page and then there is a second way to access
 * it by just going through the pages to the settings page".
 *
 * So the drawer the gear opens is built HERE, fresh at every open, from the
 * route that is on screen: first the settings that belong to that page, then
 * the app-wide controls, then the promoted "all settings" action (the quick
 * move; the second way is the ring — #/settings is a ring stop, see RING in
 * src/main.js). The simulation-pace slider that used to sit in this drawer on
 * every page died with the simulation engine it paced.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE 2026-08-27 PASS CHANGED, AND WHAT IT MEASURED FIRST.
 *
 * The owner: "I also wanted to work on our settings menu in the software the
 * pop out one on each page. It is outdated from earlier days of the program.
 * it needs to provide useful settings in a way more consistent with the theme
 * now."
 *
 * Driven before anything was written (Playwright, vite, 1366x768 and iPhone 13,
 * four routes each). What the measurement found:
 *
 *  1. A WALL OF IDENTICAL BOILERPLATE. Five appearance rows each carried their
 *     own risk disclosure, and src/permission-guidance.js declares those risks
 *     PER FAMILY, not per row — so "What this changes, and what it risks"
 *     printed twice with byte-identical bodies for Theme/Font, and again twice
 *     for Glow/Reduce motion. Four lines of the panel were the same two
 *     sentences said twice. That module's own suite forbids one statement
 *     appearing under two subjects; this surface was doing it on screen. There
 *     is now ONE disclosure per family, under the rows it covers — three
 *     instead of five, and each one says which rows it is about.
 *
 *  2. THE DOOR WAS BELOW THE FOLD. On a 1366x768 window the body scrolled 901px
 *     into 630px, and "Tools your assistants may use" sat at y=890, invisible
 *     without scrolling, on every route. (The settings page carries its own
 *     door to that page, so this was never the only one — it is the only one a
 *     person is offered without leaving the page they are on.) The two rows
 *     that decide something real — the example switch and that door — are now
 *     the first two rows of the group, above the cosmetic block, on screen the
 *     moment the drawer opens.
 *
 *  3. A FILLER LINE COST THREE. "Set here, applied now — the fleet keeps
 *     running." was a mono paragraph promising something every control in the
 *     panel demonstrates by doing it. Retired; the space is the scarce thing
 *     here.
 *
 *  4. TARGETS UNDER THE FLOOR ON A DESKTOP. The disclosure summaries measured
 *     16px tall, the glow slider 22px and the tools door 17px. A phone is
 *     already protected (phone-canvas.css raises every control to 44px); the
 *     desktop had no floor at all. src/settings.css carries one now.
 *
 *  5. A SETTING WITH NO CONTROL ANYWHERE. See THE PAGE ROW below.
 *
 *  6. A CONTROL THE APP HAD ALREADY DECIDED TO HIDE, AND DID NOT. On #/settings
 *     src/main.js sets the footer's `hidden`, because a door out of the room
 *     you are standing in is not a door. `.drawer .drawer-all { display: block }`
 *     out-ranks the UA's `[hidden]` rule, so the bar drew and took presses
 *     anyway. Fixed in src/settings.css beside the rule that caused it.
 * ---------------------------------------------------------------------------
 *
 * WHAT COUNTS AS A PAGE SETTING is bounded by the measured fact recorded in
 * src/chatbox-feed.js: a setting is real only when a module reads it and
 * changes behaviour because of it. The per-view live-data flags that used to
 * be the page settings are gone -- the one switch that replaced them reaches
 * every screen, so it lives with the app-wide rows below. The research page's
 * tool switches were the last page setting, and they are a page of their own
 * now (#/tools), reached from one link below. Every route with nothing of its
 * own still gets the honest "no settings specific to this page" line rather
 * than an invented control (owner, R1502).
 *
 * The markup uses the drawer's existing control language (.set-row, .theme-seg,
 * .toggle) and keeps the historical ids (#theme-seg, #text-seg, #set-glow,
 * #set-motion): the settings page syncs those ids when its own copy of a value
 * changes, and the QA harnesses drive them by id.
 */

import { isExampleMode, setExampleMode } from './data-source.js'
import { rangeFill } from './views/computers.js'
import { bindTouchRange } from './settings-numeric.js'
/* WHAT EACH OF THESE GRANTS AND WHAT IT RISKS (owner, R1529). Both surfaces
   show it -- this drawer and the settings page -- and both ask the same module
   for the words, so the two can never describe one control two ways. That is
   the same rule the live-data row's title already follows. */
import { guidanceMarkup } from './guided-step.js'
import { rememberAppearance } from './appearance-persistence.js'
import { homeStatusQuickMarkup, bindHomeStatusQuickSettings } from './home-status-quick-settings.js'
import './home-status-colors.css'
import {
  FONT_CHOICES,
  FONT_EVENT_ID,
  FONT_STORAGE_KEY,
  applyFontChoice,
  currentFontChoice,
  fontOptionMarkup,
} from './font-choice.js'
/* The single reader of the single phone-mode switch (src/phone-canvas.js owns
   the attribute and is its only writer). Read here, never written. */
import { phoneCanvasOn } from './phone-canvas.js'
/* The body zoom and the --zoom custom property the layout reads have ONE
   writer, src/text-size.js, for the same reason the ledger key below does. */
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_KEY,
  applyTextSize,
  normalizeTextSize,
  textZoom,
} from './text-size.js'
/* The stored ledger choice has ONE writer by licence — src/phone-ledger.js —
   so this drawer asks that module to write it rather than touching the key.
   tools/test/phone-ledger.test.mjs sweeps every file in src/ for the setItem. */
import {
  readPhoneLedgerChoice,
  setPhoneLedgerChoice,
} from './phone-ledger.js'

/* Announced after this drawer applies a value, so an open settings PAGE can
   re-sync its own copy of the same control. detail: { settingId, value },
   settingId in the settings page's vocabulary (theme, text_size, glow,
   reduce_motion, example_mode). */
export const QUICK_SETTING_EVENT = 'mc:quick-setting-changed'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* Current values are read from where they actually live — the DOM state the
   rest of the app obeys — never from a private copy that could drift. */
/* Read back through src/text-size.js rather than re-listing the offered sizes
   here: that module already owns which values exist and how the applied one is
   read, and a second list is a second thing to update when a size is added. */
const currentText = () => String(normalizeTextSize(textZoom()) ?? DEFAULT_TEXT_SIZE)
const currentGlow = () => {
  const v = parseFloat(document.documentElement.style.getPropertyValue('--glow'))
  return Number.isFinite(v) ? Math.round(v * 100) : 100
}

function announce(settingId, value) {
  window.dispatchEvent(new CustomEvent(QUICK_SETTING_EVENT, {
    detail: Object.freeze({ settingId, value }),
  }))
}

/* Options are [value, text] tuples; an optional third member is an inline
   style for that one segment. The font row uses it to write every option in
   the font it would apply — the control is its own preview (R1523). */
function segMarkup(id, dataName, options, current, label) {
  return `<div class="theme-seg" id="${id}" role="group" aria-label="${esc(label)}" aria-describedby="quick-${dataName}-error">
    ${options.map(([value, text, style]) => `<button type="button" data-${dataName}="${esc(value)}"${dataName === 'theme' ? ` data-theme-choice="${esc(value)}"` : ''}${style ? ` style="${esc(style)}"` : ''} class="${value === current ? 'on' : ''}" aria-pressed="${value === current ? 'true' : 'false'}">${dataName === 'font' ? fontOptionMarkup(value) : esc(text)}</button>`).join('')}
  </div>`
}

function errorMarkup(id, message = '') {
  return `<p class="drawer-page-empty" id="quick-${id}-error" data-quick-error="${id}" role="status" aria-live="polite" ${message ? '' : 'hidden'}>${esc(message)}</p>`
}

function groupMarkup(id, label, content) {
  return `<section class="drawer-group" role="group" aria-labelledby="${id}">
    <h3 class="drawer-group-label" id="${id}">${esc(label)}</h3>
    ${content}
  </section>`
}

/* THE PAGE ROW, AND THERE IS EXACTLY ONE IN THE PRODUCT.
 *
 * The phone ledger (src/phone-ledger.js, owner 2026-08-27: "I like the dropdown
 * functions instead of a tree for mobile") decides how ONE page draws — the
 * fleet page's tree, as circles or as rows — and nothing else in the product
 * reads it. That is the definition of a page setting, and it is the first one
 * this drawer has ever had.
 *
 * IT HAD NO CONTROL ANYWHERE. The one way in was /app/?ledger=1, the link on
 * the mobile page, and adoptLedgerEntryFlag stores 'on' when it is followed.
 * Nothing in the shipped product could ever store 'off' again: a phone that
 * pressed that link was in the ledger for good, with the canonical graph
 * reachable only by clearing site data. A door with a handle on one side is
 * the defect this row closes, and this panel is its natural home — it is the
 * only settings surface a phone can reach without leaving the page it is
 * about.
 *
 * WHY IT IS DRAWN ONLY IN PHONE MODE, and why that is not "a control hidden on
 * a device". The mode gate is a STATE, not a width: phoneLedgerDecision refuses
 * unless the phone canvas is already on, and no desktop window at any width can
 * turn that mode on (src/phone-canvas.js, and the 3,000-point matrix in its
 * suite). So on a desktop this row would be a control that cannot move
 * anything, which is the one thing this product does not ship. The owner's rule
 * points the other way — a phone must not LOSE a path a desktop has — and it is
 * kept: nothing a desktop can do disappears here.
 */
function pageRows(routeName) {
  /* THE COLOUR PICKER IS A PAGE SETTING ON BOTH PAGES IT COLOURS. It was
     drawn on #/ only, and the register at #/ledger is the other surface those
     three colours reach (src/ledger.css, `data-owner-status`) -- a control
     offered only on the page a person is not looking at is the same defect as
     the ledger row above, a door with a handle on one side. Same markup, same
     binding, same stored per-theme keys: one picker, two pages, no second
     answer to drift from the first. */
  if (routeName === 'home') return homeStatusQuickMarkup() + `
    <label class="set-row set-toggle">
      <span class="set-label">Playful moments</span>
      <span class="toggle"><input type="checkbox" id="set-blob-moments" ${blobMomentsEnabled() ? 'checked' : ''} aria-describedby="blob-moments-hint quick-blob-moments-error"/><i></i></span>
    </label>
    <div class="set-row">
      <span class="drawer-page-empty" id="blob-moments-hint">A playful break for Blob, roughly every five minutes.</span>
      <div class="theme-seg"><button type="button" id="preview-blob-moment">Preview</button></div>
    </div>
    ${errorMarkup('blob-moments')}`
  if (routeName === 'ledger') return homeStatusQuickMarkup()
  const apiRow = routeName === 'computers' ? agentApiSettingMarkup() + auditPerformanceSettingsMarkup() : ''
  if (routeName === 'computers' && phoneCanvasOn()) {
    /* THE SEGMENT MUST NAME WHAT IS ON THE SCREEN. It reads the same way
       phoneLedgerDecision does — only a stored 'off' withholds the ledger, and
       everything else, 'auto' included, is showing Rows. This line used to say
       `=== 'on' ? 'on' : 'off'`, which matched the old default; when that
       default flipped, leaving it would have made this panel tell a person the
       opposite of what they were looking at, on the one control they would use
       to change it. Pressing Graph still stores 'off' outright — an explicit
       answer, not a return to "nobody has said". */
    let choice = null
    try {
      choice = readPhoneLedgerChoice() === 'off' ? 'off' : 'on'
    } catch {
      /* COULD-NOT-TELL IS NOT "GRAPH". A storage this browser refuses to read
         is refused for mountPhoneLedger too — it returns null on the same
         throw — so the page really is showing the graph; but the SETTING is
         unknown, and a segment drawn as chosen would be this panel asserting a
         value nobody could read. It is also a control that could not work if
         it were live: the press writes nothing, the re-render reads nothing,
         and the tree comes back exactly as it was. So it states the refusal
         instead, which is the house rule for a control that cannot act.
         `choice` is left at null, which is what "could not tell" is. */
    }
    const why = 'This browser will not let the app read or keep its own settings, '
      + 'so this choice cannot be made here. The tree stays as it is drawn.'
    const options = [['off', 'Graph'], ['on', 'Rows']]
    return `${apiRow}<div class="set-row">
      <span class="set-label">Show the tree as</span>
      ${choice === null
        ? `<div class="theme-seg" id="ledger-seg" role="group" aria-label="Show the tree as">
        ${options.map(([value, text]) => `<button type="button" data-ledger="${value}" disabled title="${esc(why)}" aria-pressed="false">${esc(text)}</button>`).join('')}
      </div>`
        : segMarkup('ledger-seg', 'ledger', options, choice, 'Show the tree as')}
    </div>
    ${choice === null ? `<div class="drawer-page-empty">${esc(why)}</div>` : ''}
    ${errorMarkup('ledger')}`
  }
  /* The per-view "Live data" toggle that used to sit here on seven routes is
     gone: the one switch that replaced it reaches every screen, so it lives
     with the app-wide rows in appRows() where "every page" is the honest
     heading for it.
     THE RESEARCH PAGE'S TOOL CHECKBOXES ARE GONE FROM HERE TOO, and that is the
     point of that change rather than a casualty of it. They were a strip of
     two-state checkboxes in a popover, and the tools the permission level
     withholds were a COUNT with no names and no door. They are a page now
     (src/views/tools.js), with three states per tool and a row for every tool
     including the ones this level keeps back; appRows() carries the one link. */
  return apiRow || '<div class="drawer-page-empty">No settings specific to this page.</div>'
}

/* Each drawer row names the SAME setting id the settings page uses, so both
   surfaces resolve to one statement rather than two that drift. */
function appRows() {
  const motion = document.body.classList.contains('reduce-motion')
  let example = null
  try { example = isExampleMode() } catch { /* This control states an unreadable preference below. */ }
  /* ONE DISCLOSURE PER FAMILY, NOT ONE PER ROW. describeSubject() resolves
     Theme and Font to the same `appearance` statement and Glow and Reduce
     motion to the same `motion` statement, so a per-row note printed each of
     those bodies twice, verbatim, four lines apart. The note is placed under
     the rows it covers and its summary names them, which is what a repeated
     line never did. */
  const note = (id, section, summary) => guidanceMarkup(id, { section, summary })
  /* THE TWO ROWS THAT DECIDE SOMETHING REAL COME FIRST. Everything under them
     changes what this window looks like; these two change what it shows you
     and what your assistants may reach. Measured 2026-08-27: with the
     appearance block on top, the tools door landed at y=890 in a 630px body —
     off screen at every open, on every route. The settings page carries its
     own door to that page, so this is not the only one; it is the only one a
     person is offered without leaving the page they are on, which is why the
     drawer has it at all. */
  /* The example row's disclosure is a SIBLING of the label, never inside it.
     A <details> nested in a <label> makes clicking the summary toggle the
     checkbox, so reading about a setting would change it -- which on this
     particular row would silently swap every screen between your own records
     and the example. The title carries the same sentence the settings page
     uses for this switch, so the two surfaces can never describe one control
     two ways. */
  return `<label class="set-row set-toggle" title="Every screen shows the product's built-in example instead of your own activity, and each screen showing it is labelled as an example. It is what a signed-out visitor to the website sees.">
    <span class="set-label">Show the example fleet</span>
    <span class="toggle"><input type="checkbox" data-quick-example aria-describedby="quick-example-error" ${example === null ? 'disabled aria-checked="mixed"' : example ? 'checked' : ''}/><i></i></span>
  </label>
  ${errorMarkup('example', example === null ? 'The example preference could not be read. Reopen quick settings to retry.' : '')}
  ${guidanceMarkup('example_mode', { section: 'What the screens show', summary: 'What this does, and what it risks' })}
  <!-- THE SHORT PATH, AND ONLY THE PATH. The tool answers are three states over
       every tool this computer carries, which is a page and not a drawer. One
       link, so there is one place those answers are made. -->
  <a class="set-row set-link" href="#/tools" data-quick-tools>
    <span class="set-label">Tools your assistants may use</span>
    <span class="set-link-go">open →</span>
  </a>
  <div class="set-row">
    <span class="set-label">Theme</span>
    ${segMarkup('theme-seg', 'theme', THEME_CHOICES.map(choice => [choice.id, choice.label]), currentTheme(), 'Theme')}
  </div>
  ${errorMarkup('theme')}
  <div class="set-row">
    <span class="set-label">Font</span>
    ${segMarkup('font-seg', 'font', FONT_CHOICES.map(choice => [choice.id, choice.label, `font-family:${choice.stack}`]), currentFontChoice(), 'Font')}
  </div>
  ${errorMarkup('font')}
  <div class="set-row">
    <span class="set-label">Home circle</span>
    ${segMarkup('circle-seg', 'circle', HOME_CIRCLE_STYLES.map(choice => [choice.id, choice.label]), currentHomeCircleStyle(), 'Home circle')}
  </div>
  ${errorMarkup('circle')}
  ${note('theme', 'Appearance', 'What Theme and Font change, and what they risk')}
  <div class="set-row">
    <span class="set-label">Text size</span>
    ${segMarkup('text-seg', 'text', [['0.9', 'Small'], ['1', 'Default'], ['1.12', 'Large']], currentText(), 'Text size')}
  </div>
  ${errorMarkup('text')}
  ${note('text_size', 'Text & Reading', 'What Text size changes, and what it risks')}
  <label class="set-row">
    <span class="set-label">Glow intensity</span>
    <input type="range" id="set-glow" min="0" max="200" value="${currentGlow()}" aria-describedby="quick-glow-error" />
  </label>
  ${errorMarkup('glow')}
  <label class="set-row set-toggle">
    <span class="set-label">Reduce motion</span>
    <span class="toggle"><input type="checkbox" id="set-motion" ${motion ? 'checked' : ''} aria-describedby="quick-motion-error"/><i></i></span>
  </label>
  ${errorMarkup('motion')}
  ${note('glow', 'Motion & Effects', 'What Glow and Reduce motion change, and what they risk')}
  <div class="set-row set-build" data-build-row>
    <span class="set-label">This build</span>
    <span class="set-build-value" data-build-value>reading…</span>
  </div>`
}

/* WHICH BUILD IS THIS? Nothing in the app answered that, and it cost a whole
 * walkthrough: a build from a different branch was installed over this one
 * and neither the owner nor I could tell by looking — he reported defects
 * against surfaces that had already been replaced. The packaged artifact has
 * always carried dist/build-info.json (version, refs, and whether the tree
 * was dirty when it was built); it simply had no reader. This is the reader.
 * Absence is stated, never guessed: a copy served without the file says so
 * rather than inventing a version. */
async function fillBuildRow(body) {
  const slot = body.querySelector('[data-build-value]')
  if (!slot) return
  let info = null
  try {
    /* RELATIVE, NOT ROOTED. On the desktop the application is the origin's
       root, so 'build-info.json' and '/build-info.json' are the same file. On
       the website the application is mounted at /app/, and '/build-info.json'
       is the SITE's own record -- a different shape (commit, shortCommit,
       channel) with no version in it -- so this row read "recorded, but names
       no version" on every public visit. Measured on the live site on
       2026-08-22. The vendored copy writes /app/build-info.json with
       appVersion and shortCommit; the relative path reaches it. */
    const answer = await fetch('build-info.json', { cache: 'no-store' })
    if (answer.ok) info = await answer.json()
  } catch { info = null }
  if (!info) {
    slot.textContent = 'not recorded in this copy'
    return
  }
  /* Two writers, two shapes, one reader. The packaged desktop build
     (tools/require-clean-tree.mjs) records { version, app: { ref }, checkedAt,
     dirty }; the vendored web copy (the website's vendor step) records
     { appVersion, shortCommit, commit, channel }. Either is read by name;
     nothing is guessed from the other's fields. */
  const version = typeof info.version === 'string' ? info.version
    : typeof info.appVersion === 'string' ? info.appVersion : null
  const shortRef = typeof info.app?.ref === 'string' ? info.app.ref.slice(0, 7)
    : typeof info.shortCommit === 'string' ? info.shortCommit
      : typeof info.commit === 'string' ? info.commit.slice(0, 7) : null
  const built = typeof info.checkedAt === 'string' ? info.checkedAt.slice(0, 16).replace('T', ' ') : null
  const parts = [
    version,
    shortRef,
    built,
    info.channel === 'web-app' ? 'served from the website' : null,
    info.dirty === true ? 'built with uncommitted changes' : null,
  ].filter(Boolean)
  slot.textContent = parts.length > 0 ? parts.join(' · ') : 'recorded, but names no version'
}

function wire(body) {
  bindAgentApiSetting(body)
  bindAuditPerformanceSettings(body)
  void fillBuildRow(body)
  const syncHomeColors = bindHomeStatusQuickSettings(body, announce)
  const labels = { theme: 'Theme', font: 'Font', text: 'Text size', glow: 'Glow intensity', motion: 'Reduce motion', example: 'The example preference', ledger: 'The tree view', 'blob-moments': 'Playful moments' }
  const persist = (id, write) => {
    const error = body.querySelector(`[data-quick-error="${id}"]`)
    try {
      write()
      if (error) { error.textContent = ''; error.hidden = true }
      return true
    } catch {
      if (error) {
        error.textContent = `${labels[id]} could not be saved. Try again.`
        error.hidden = false
        error.scrollIntoView?.({ block: 'nearest' })
      }
      return false
    }
  }
  body.querySelector('#set-blob-moments')?.addEventListener('change', event => {
    const previous = blobMomentsEnabled()
    if (!persist('blob-moments', () => setBlobMomentsEnabled(event.target.checked))) event.target.checked = previous
  })
  body.querySelector('#preview-blob-moment')?.addEventListener('click', () => {
    const api = document.querySelector('.home-circle')?.homeCircleFluid
    if (api?.playMoment() || api?.stats().moment?.active) {
      document.getElementById('close-settings')?.click()
      return
    }
    const error = body.querySelector('[data-quick-error="blob-moments"]')
    if (error) {
      error.textContent = !blobMomentsEnabled() ? 'Turn on Playful moments to preview.'
        : currentHomeCircleStyle() !== 'standard' ? 'Choose Blob under Home circle to preview.'
          : 'Preview is available while Blob is animating and voice is off.'
      error.hidden = false
    }
  })
  const themeSeg = body.querySelector('#theme-seg')
  themeSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]')
    if (!b) return
    const t = b.dataset.theme
    if (!THEME_CHOICES.some(choice => choice.id === t)) return
    if (!persist('theme', () => localStorage.setItem('mc.theme', t))) return
    document.documentElement.dataset.theme = t
    syncHomeColors()
    for (const btn of themeSeg.querySelectorAll('button')) {
      const on = btn.dataset.theme === t
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    announce('theme', t)
  })

  const fontSeg = body.querySelector('#font-seg')
  fontSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-font]')
    if (!b) return
    const id = b.dataset.font
    if (!FONT_CHOICES.some(choice => choice.id === id)) return
    if (!persist('font', () => localStorage.setItem(FONT_STORAGE_KEY, id))) return
    applyFontChoice(id)
    for (const btn of fontSeg.querySelectorAll('button')) {
      const on = btn.dataset.font === id
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    announce(FONT_EVENT_ID, id)
  })

  const textSeg = body.querySelector('#text-seg')
  textSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-text]')
    if (!b) return
    // Validate before persisting; apply both zoom values only after storage
    // succeeds, so an unavailable preference store cannot alter this visit.
    const v = normalizeTextSize(b.dataset.text)
    if (v === null) return
    if (!persist('text', () => localStorage.setItem(TEXT_SIZE_KEY, String(v)))) return
    applyTextSize(v)
    for (const btn of textSeg.querySelectorAll('button')) {
      const on = parseFloat(btn.dataset.text) === v
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    announce('text_size', String(v))
  })

  /* THE PAGE ROW. The press writes through src/phone-ledger.js — the one
     licensed writer of that key — and that module announces the change; the
     redraw belongs to src/main.js, which owns render(). Nothing is applied
     here, so the drawer cannot hold an opinion the page disagrees with. */
  /* Blob or Simple for the Home circle. setHomeCircleStyle writes the one
     key and announces it; the Home view repaints on that event. */
  const circleSeg = body.querySelector('#circle-seg')
  circleSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-circle]')
    if (!b) return
    let stored
    if (!persist('circle', () => { stored = setHomeCircleStyle(b.dataset.circle) })) return
    for (const btn of circleSeg.querySelectorAll('button')) {
      const on = btn.dataset.circle === stored
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    announce('home_circle_style', stored)
  })
  const ledgerSeg = body.querySelector('#ledger-seg')
  ledgerSeg?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ledger]')
    if (!b) return
    let stored
    if (!persist('ledger', () => { stored = setPhoneLedgerChoice(b.dataset.ledger) })) return
    if (stored === null) return
    for (const btn of ledgerSeg.querySelectorAll('button')) {
      const on = btn.dataset.ledger === stored
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  })

  const glow = body.querySelector('#set-glow')
  if (glow) {
    bindTouchRange(glow)
    glow.addEventListener('input', () => {
      const previous = currentGlow()
      let value
      if (!persist('glow', () => { value = rememberAppearance('glow', Number(glow.value)) })) { glow.value = String(previous); return }
      if (value === null) { glow.value = String(previous); return }
      glow.value = String(value)
      document.documentElement.style.setProperty('--glow', String(value / 100))
      announce('glow', value)
    })
    rangeFill(glow)
  }

  body.querySelector('#set-motion')?.addEventListener('change', (e) => {
    const previous = document.body.classList.contains('reduce-motion')
    const value = Boolean(e.target.checked)
    if (!persist('motion', () => rememberAppearance('reduce_motion', value))) { e.target.checked = previous; return }
    document.body.classList.toggle('reduce-motion', value)
    announce('reduce_motion', value)
  })

  const example = body.querySelector('input[data-quick-example]')
  if (example?.disabled) example.indeterminate = true
  let exampleValue = Boolean(example?.checked)
  example?.addEventListener('change', (e) => {
    /* setExampleMode announces DATA_SOURCE_EVENT itself, which is what makes
       the (inert) page behind this drawer re-resolve its source — the toggle
       is visibly real, and this handler must not dispatch that event again.
       The QUICK_SETTING_EVENT announced here is the drawer's own, separate
       contract: it lets an open settings PAGE re-sync its copy of the row. */
    let enabled
    if (!persist('example', () => { enabled = setExampleMode(e.target.checked) })) { e.target.checked = exampleValue; return }
    exampleValue = enabled
    e.target.checked = enabled
    announce('example_mode', enabled)
  })
}

/* THE PAGE'S NAME, AS THE RAIL PRINTS IT (T1575). The drawer headed its page
   group with the route id, so Messages read 'This page · comms' and every
   other page a lower-case id. The rail's own link is the name a person knows
   the page by; a page with no rail link (Tools, Account, an assistant) gets
   its id with a capital. */
export function pageNameFor(routeName, doc = globalThis.document) {
  const id = String(routeName || '')
  let link = null
  try { link = doc?.querySelector?.(`#tb-nav a[data-route="${id.replace(/["\\]/g, '')}"]`) } catch {}
  const railName = String(link?.textContent || '').trim()
  if (railName) return railName
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'This page'
}

/** Rebuild the drawer body for the page the person is on. */
export function renderQuickSettings(body, routeName) {
  if (!body) return
  body.innerHTML = [
    groupMarkup('drawer-group-page', `This page · ${pageNameFor(routeName)}`, pageRows(routeName)),
    groupMarkup('drawer-group-app', 'Every page', appRows()),
  ].join('')
  wire(body)
}
