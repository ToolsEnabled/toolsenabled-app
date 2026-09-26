/* WHAT A TOOL ROW SAYS, SEPARATED FROM THE PAGE THAT MOUNTS IT.
 *
 * src/views/tools.js is a view factory over a live DOM; this is the part of it
 * that is a function from values to markup. The split is the one
 * src/first-run-needs.js and src/views/guide.js already use, and the reason is
 * the same: copy that lives inside a render function can only be checked by
 * reading the render function, and the suite has to be able to walk these
 * sentences without a browser.
 *
 * IT ASKS src/guided-step.js FOR THE WITHHELD BLOCK RATHER THAN WRITING ONE.
 * That module already answers the three questions a withheld state owes a
 * person -- what it would let you do, what it would risk, and where the answer
 * is decided -- and the settings page, the setup review and the agent page all
 * ask it. A second wording here would be a second thing to keep true.
 */

import { TOOL_STATES, TOOL_STATE_LABELS, toolState } from './agent-tool-states.js'
import { withheldMarkup } from './guided-step.js'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The reason a withheld tool is unavailable, in the person's terms rather than
   in the level's own word. The level is named because it is the thing they
   chose and the thing they would go and change. */
export const WITHHELD_REASON = 'The level this computer was set up at does not carry this tool.'

/* The subject the withheld block is built from. One declaration covers every
   tool: see src/permission-guidance.js for why that is the honest shape here
   rather than three hundred paragraphs. */
export const TOOL_SUBJECT = 'agent_tool'

/**
 * The state in words, under the row's name.
 *
 * It leads with the state so it can never be read against the control beside
 * it -- the rule the settings page's own state line follows.
 *
 * THE MIDDLE STATE HAS TWO SENTENCES BECAUSE IT HAS TWO OUTCOMES. This program
 * can stop and ask before a tool runs only where its own approval step already
 * covers that tool. Where it cannot, the answer to a question nobody can put to
 * you is no, so the tool is held back -- and saying so is the difference
 * between a setting and a promise.
 */
export function stateSentence(tool, state) {
  if (state === 'disabled') return 'Off. Assistants started after this cannot use it.'
  if (state === 'ask') {
    return tool.gated
      ? 'Permission required. Each use waits for your answer in the Ledger.'
      : 'Permission required, and this program cannot put that question to you for this one. It is held back rather than used without asking.'
  }
  return tool.gated
    ? 'On, and this program already asks you before each use of this one.'
    : 'On. Assistants use it whenever they judge they need it.'
}

/* The group is NAMED rather than pointed at the row's heading. Three hundred
   rows built from registry identifiers would need three hundred unique element
   ids, and two names that differ only in punctuation would collide into one --
   a duplicate id that reads as one control labelling another. The name is short
   and the reader needs it either way, so it is spelled out here. */
function segMarkup(tool, state, writable) {
  return `<div class="theme-seg tools-seg" role="group" aria-label="${esc(tool.name)}">
    ${TOOL_STATES.map(value => `<button type="button" data-tool-name="${esc(tool.name)}" data-tool-state="${esc(value)}" class="${value === state ? 'on' : ''}" aria-pressed="${value === state ? 'true' : 'false'}"${writable ? '' : ' disabled'}>${esc(TOOL_STATE_LABELS[value])}</button>`).join('')}
  </div>`
}

/** One tool the person can answer for. */
export function toolRowMarkup(tool, states, writable) {
  const state = toolState(states, tool.name)
  return `<article class="settings-row is-engineer tools-row" data-tool-row="${esc(tool.name)}" data-tool-search="${esc(String(tool.name).toLowerCase())}">
    <div class="settings-copy">
      <div class="settings-name">${esc(tool.name)}</div>
      <div class="settings-state" data-tool-sentence>${esc(stateSentence(tool, state))}</div>
    </div>
    <div class="settings-control">${segMarkup(tool, state, writable)}</div>
  </article>`
}

/**
 * One tool the recorded level withholds.
 *
 * A ROW, NOT A NUMBER, and that is the specific defect this page exists to
 * close: the drawer this replaced said "N more tools are withheld" and gave
 * neither a name nor a door. The name is on screen, the reason is beside it,
 * and the disclosure carries the full answer from the shared module.
 */
export function withheldRowMarkup(tool) {
  return `<article class="settings-row is-engineer tools-row is-withheld" data-tool-withheld-row="${esc(tool.name)}" data-tool-search="${esc(String(tool.name).toLowerCase())}">
    <div class="settings-copy">
      <div class="settings-name">${esc(tool.name)}</div>
      <div class="settings-state">${esc(WITHHELD_REASON)}</div>
    </div>
    <div class="settings-control"><span class="tools-withheld-tag">Change at setup</span></div>
    <div class="settings-disclosure">
      <details class="guided-note" data-guided-for="${esc(TOOL_SUBJECT)}">
        <summary class="guided-summary">What this one would do, and where it is decided</summary>
        <div class="guided-body">${withheldMarkup(TOOL_SUBJECT, { label: tool.name, reason: WITHHELD_REASON })}</div>
      </details>
    </div>
  </article>`
}

/** The one line that says where this computer stands, in the page's own words. */
export function countLine(surface, total) {
  return [
    `${total} tools`,
    `${surface.allowed.length} on`,
    `${surface.asking.length} asking first`,
    `${surface.heldBack.length} held back`,
    `${surface.off.length} off`,
    `${surface.withheld.length} need a wider level`,
  ].join(' · ')
}

/* WHY A CHANGE TO A TOOL WAS NOT SAVED, IN THE WORDS THE SHELL ALREADY WROTE.
 *
 * shell/product-account.cjs putSetting() answers six distinct named refusals,
 * each with a sentence written for a person: not signed in, a bad key, a value
 * too long, a DAMAGED partition ("A damaged partition is not overwritten. The
 * person is told; the file that could not be read is left for them to keep or
 * discard"), a settings store that is full, and a write this computer refused.
 * The page threw every one of them away and printed one fixed line ending
 * "Sign in, then set it again."
 *
 * For five of the six that instruction is wrong, and the page cannot even be
 * showing it to somebody who is signed out -- persist() takes the signed-out
 * branch before this is reached, with its own sentence. Signing in again cannot
 * empty a full settings store, repair a damaged partition, or make a refused
 * disk write succeed, so the person is sent to do the one thing that will not
 * help while the thing that would is on the other side of a discarded field.
 *
 * src/views/account.js already established the rule for this exact value: it
 * renders `result.reason`, "which comes from the main process and is written
 * not to quote the input". Same value, same rule, one page later.
 *
 * The consequence is stated first, because that is what a person needs before
 * a reason: nothing on this computer changed. The fallback is used only when
 * there is no reason to give -- the call threw, or answered a shape with none. */
export function saveRefusalSentence(result) {
  const consequence = 'That change was not saved, so nothing on this computer changed.'
  const reason = typeof result?.reason === 'string' ? result.reason.trim() : ''
  if (!reason) return `${consequence} The application did not say why; try again, and if it keeps happening restart it.`
  return `${consequence} ${reason}`
}
