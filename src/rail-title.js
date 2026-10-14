/* THE NAV ROW IS THE SAME ROW ON EVERY PAGE.
 *
 * Owner defect 6: "make sure the arrow buttons show up at the same location on
 * every page so a user doesnt have to move their mouse to click through."
 * Before this module, each rail page hand-built its own title line: some had a
 * back button, some had none (the row then collapsed shorter), and every back
 * label named its destination ("‹ Fleet overview", "‹ Statistics"), which
 * moved the button's own centre by tens of pixels between pages even when the
 * row itself stayed put.
 *
 * One definition, three fixed slots (back | title | forward) on a grid whose
 * column widths never depend on content, a minimum height so a page with no
 * buttons keeps the same geometry, and one constant back label -- the
 * destination a person came from is not what the button is for; going back is.
 * An absent button renders an EMPTY SLOT, never a collapsed one.
 *
 * Two forms of the same row: markup for the pages that build innerHTML from
 * template strings, and a DOM builder for agent-compose-panel.js, whose stated
 * doctrine is "built element by element, never from a markup string".
 * The existing pages find their buttons with querySelector('.rail-back') and
 * data attributes; both survive here unchanged.
 */

export const BACK_LABEL = '‹ Back'

/* Mirrors the escape at views/computers.js:146; local so this module imports
 * nothing and can be used from any page. */
const escapeMarkup = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character])

/**
 * @param {object}  [options]
 * @param {boolean|{aria?: string}} [options.back]  render the back button; an
 *        object may carry an aria-label naming the destination for a screen
 *        reader, since the visible label deliberately does not.
 * @param {string}  [options.title]   the page's own name, centred.
 * @param {{label: string, attr?: string}|null} [options.forward]  a forward
 *        action on the right; `attr` is a literal attribute string the caller
 *        already owns (e.g. 'data-open-palette').
 * @returns {string} markup for one title row.
 */
export function railTitleRow({ back = false, title = '', forward = null } = {}) {
  const backCell = back
    ? `<button class="rail-back" type="button"${back.aria ? ` aria-label="${escapeMarkup(back.aria)}"` : ''}>${BACK_LABEL}</button>`
    : ''
  const forwardCell = forward
    ? `<button class="rail-back rail-forward" type="button"${forward.attr ? ` ${forward.attr}` : ''}>${escapeMarkup(forward.label)} ›</button>`
    : ''
  return `<div class="rail-title rail-title-row">`
    + `<span class="rail-title-slot rail-title-slot-back">${backCell}</span>`
    + `<span class="rail-title-slot rail-title-slot-title">${escapeMarkup(title)}</span>`
    + `<span class="rail-title-slot rail-title-slot-forward">${forwardCell}</span>`
    + `</div>`
}

/**
 * The same row as real elements, for callers that never build from markup
 * strings. The back slot's button is returned so the caller can wire and
 * disable the SAME element it always had.
 *
 * @param {Document} doc
 * @param {object}  [options]
 * @param {{label?: string, aria?: string, attrs?: Record<string,string>}|null} [options.back]
 *        `label` overrides the constant only where the button is genuinely not
 *        "back" (the compose panel's Cancel lives in the back slot: same place,
 *        same muscle memory, honest word). No separate aria-label when a label
 *        is given: an accessible name that differs from the visible words
 *        fails both the speech-input rule and the product's own copy checks.
 * @param {string}  [options.title]
 * @param {string}  [options.titleId]  id for the title slot, so a panel can
 *        point its aria-labelledby at the row instead of carrying a second
 *        heading element for the same words.
 * @returns {{row: HTMLElement, backButton: HTMLButtonElement|null}}
 */
export function railTitleRowElement(doc, { back = null, title = '', titleId = null } = {}) {
  const row = doc.createElement('div')
  row.className = 'rail-title rail-title-row'

  const backSlot = doc.createElement('span')
  backSlot.className = 'rail-title-slot rail-title-slot-back'
  let backButton = null
  if (back) {
    backButton = doc.createElement('button')
    backButton.type = 'button'
    // Property AND attribute, deliberately: the compose-panel test harness
    // fakes elements whose getAttribute only sees setAttribute, which is why
    // the button this replaces set both.
    backButton.setAttribute('type', 'button')
    backButton.className = 'rail-back'
    backButton.textContent = back.label || BACK_LABEL
    if (back.aria) backButton.setAttribute('aria-label', back.aria)
    for (const [name, value] of Object.entries(back.attrs || {})) backButton.setAttribute(name, value)
    backSlot.appendChild(backButton)
  }
  row.appendChild(backSlot)

  const titleSlot = doc.createElement('span')
  titleSlot.className = 'rail-title-slot rail-title-slot-title'
  titleSlot.textContent = title
  if (titleId) titleSlot.setAttribute('id', titleId)
  row.appendChild(titleSlot)

  const forwardSlot = doc.createElement('span')
  forwardSlot.className = 'rail-title-slot rail-title-slot-forward'
  row.appendChild(forwardSlot)

  return { row, backButton }
}
