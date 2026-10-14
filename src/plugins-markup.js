/* WHAT A PLUGIN'S ENTRY SAYS, SEPARATED FROM THE PAGE THAT MOUNTS IT.
 *
 * src/views/plugins.js is a view factory over a live DOM; this is the part of it
 * that is a function from values to markup. It is the split
 * src/agent-tools-markup.js already uses, for the reason that file gives: copy
 * inside a render function can only be checked by reading the render function, and
 * a suite has to be able to walk these sentences without a browser. On a consent
 * screen that matters more than usual -- the sentences ARE the product here.
 *
 * EVERY CAPABILITY THE PACKAGE ASKED FOR GETS A ROW, INCLUDING THE ONES YOU SAID
 * NO TO. This is the same defect src/views/tools.js was built to fix: the tools a
 * level withheld used to be COUNTED rather than listed, and "N more are withheld"
 * is the shape of an answer without being one. A capability a person declined must
 * stay visible, or the only way to find out what a plugin wanted is to read its
 * manifest.
 *
 * NOTHING A PLUGIN WROTE IS TRUSTED AS MARKUP. A name, a summary, a tool
 * description and a badge word all come out of a file a stranger wrote. Every one
 * of them goes through esc() on the way into a string, and the suite asserts it
 * for the shapes that matter.
 */

import {
  CAPABILITY_COPY, IDENTITY_NOTE, PAGE_WITHDRAW_REASON, RESTART_NOTE, effectRaisedSentence, withheldSentence,
} from './plugin-copy.js'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* The digest, shortened for a person and never for a comparison. Sixteen hex
   characters is what a person can carry across to `package-id.py` and check; the
   decision itself is made against all sixty-four, in the engine. */
export function shortId(sha256) {
  return String(sha256 || '').slice(0, 16)
}

/* A withdrawal's moment as a date a person reads, never the stored timestamp
   (the real app showed "until 2026-09-27T06:24:26.717Z"). Null when there is no
   usable moment, and the sentence then says "earlier". */
function withdrawnOn(at) {
  if (typeof at !== 'string' || !at) return null
  const moment = new Date(at)
  if (Number.isNaN(moment.getTime())) return null
  return moment.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

/* THE HEADLINE STATE, IN ONE SENTENCE, LEADING WITH THE ANSWER.
 *
 * It leads with the state rather than the name so it cannot be read against the
 * control beside it -- the rule the settings page's own state line follows. */
export function stateSentence(entry) {
  if (entry.revoked) {
    const on = withdrawnOn(entry.revoked.at)
    const reason = typeof entry.revoked.reason === 'string' && entry.revoked.reason.trim()
      && entry.revoked.reason.trim() !== PAGE_WITHDRAW_REASON ? entry.revoked.reason.trim() : null
    return `Withdrawn. You allowed this plugin ${on ? `until ${esc(on)}` : 'earlier'}, and then withdrew it.`
      + (reason ? ` The reason given: \u201c${esc(reason.replace(/[.\s]+$/, ''))}\u201d.` : '')
      + ' It can do nothing, and its entry is kept so you can see that it once could.'
  }
  if (!entry.granted.length) {
    return 'Not allowed anything. Installing a plugin grants it nothing; until you decide, none of its tools, '
      + 'roles or settings exist.'
  }
  if (entry.withheld.length) {
    return `Allowed ${entry.granted.length} of the ${entry.requested.length} things it asked for. `
      + withheldSentence(entry.withheld)
  }
  return `Allowed everything it asked for (${entry.granted.length}).`
}

/* One capability, as a row with its own two sentences and its own answer. */
export function capabilityRowMarkup(entry, capability, { writable = true } = {}) {
  const copy = CAPABILITY_COPY[capability]
  const allowed = entry.granted.includes(capability)
  /* A capability the build does not describe still gets a row. Falling back to a
     row with the bare name is the only honest option: leaving it out would hide a
     capability from the person deciding, which is the one failure this screen
     cannot have. */
  const title = copy ? copy.title : capability
  const grants = copy ? copy.grants : 'This build of the app has no description for this capability.'
  const risk = copy
    ? copy.risk
    : 'Because it has no description here, treat it as the strongest thing on the list and leave it off unless you '
      + 'know what it does.'
  return `<div class="plugin-cap ${allowed ? 'is-allowed' : 'is-withheld'}" data-capability="${esc(capability)}">`
    + `<div class="plugin-cap-head">`
    + `<label class="plugin-cap-name"><input type="checkbox" data-capability="${esc(capability)}"`
    + `${allowed ? ' checked' : ''}${writable ? '' : ' disabled'}> <span>${esc(title)}</span></label>`
    + `<span class="plugin-cap-state">${allowed ? 'Allowed' : 'Not allowed'}</span>`
    + `</div>`
    + `<p class="plugin-cap-grants">${esc(grants)}</p>`
    + `<p class="plugin-cap-risk">${esc(risk)}</p>`
    + `</div>`
}

/* One tool. Both the plugin's own claim and what it actually counts as, because
   showing only the final answer hides the disagreement and showing only the claim
   repeats it as though it had been checked. */
export function toolRowMarkup(tool) {
  return `<li class="plugin-tool">`
    + `<code class="plugin-tool-name">${esc(tool.name)}</code>`
    + `<p class="plugin-tool-summary">${esc(tool.summary)}</p>`
    + `<p class="plugin-tool-effect">${esc(effectRaisedSentence(tool.declaredEffect, tool.effect))}`
    + ` ${tool.approvalWaived
      ? 'You have said this one may run without asking.'
      : 'It asks you every time it runs.'}</p>`
    + `</li>`
}

/* What a package contributes BESIDES tools, counted plainly and only where the
   capability is actually in force -- a role a plugin ships and was not allowed to
   install does not exist, and saying "3 roles" about it would be a lie of exactly
   the kind this screen is for. */
export function contributionLine(entry) {
  const parts = []
  /* A role of the person's own with the same id wins (the engine's projection),
     so a plugin role it hides is not one the plugin adds. It is named rather than
     silently dropped from the count: the person should know why a role they
     expected from the plugin is not the one in force. */
  const shadowed = entry.inForce.includes('roles') && Array.isArray(entry.shadowedRoles) ? entry.shadowedRoles : []
  /* Counted from the roles the engine read and accepted (`roles`, from the
     catalogue's contributions() read), not from the manifest's list of role
     files. A role file the engine refuses is named under "Parts of this plugin
     could not be read" and adds nothing, and the page used to go on saying "It
     also adds 1 role" about it (1.0.50 release review F3). A listing that carries
     no `roles` list is counted from its files, as before. */
  const added = Array.isArray(entry.roles) ? entry.roles.length : entry.roleCount
  const inUse = entry.inForce.includes('roles') && added ? Math.max(0, added - shadowed.length) : 0
  if (inUse) parts.push(`${inUse} role${inUse === 1 ? '' : 's'}`)
  if (entry.inForce.includes('settings') && entry.declaresSettings) parts.push('settings of its own')
  if (entry.inForce.includes('settings') && entry.declaresRestrictions) parts.push('limits it holds itself to')
  if (entry.inForce.includes('skin') && entry.hasSkin) parts.push('a few colours')
  const hidden = shadowed.length === 1
    ? ` Its role \u201c${shadowed[0]}\u201d is not used, because one of your own roles has that name, and yours is the one in force.`
    : shadowed.length > 1
      ? ` Its roles ${shadowed.slice(0, -1).map(id => `\u201c${id}\u201d`).join(', ')} and \u201c${shadowed[shadowed.length - 1]}\u201d `
        + 'are not used, because your own roles have those names, and yours are the ones in force.'
      : ''
  if (!parts.length) return `It adds nothing besides its tools right now.${hidden}`
  return `It also adds ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}.${hidden}`
}

/* THE SKIN, RE-VALIDATED HERE RATHER THAN TRUSTED.
 *
 * The engine validated these values against a fixed vocabulary before they ever
 * left a manifest, and this checks them again anyway, because they crossed a
 * process boundary on their way to a style attribute. That is the one place in this
 * file where a bad value would stop being text and start being CSS, and "the other
 * side already checked" is the sentence that precedes every such bug. A token that
 * fails is dropped, not corrected: a colour this build cannot parse is not a colour
 * whose intent is guessable.
 *
 * The badge is deliberately NOT emitted as a custom property. It is a word to
 * display, and `content: var(--x)` needs quoting rules that a plugin-supplied
 * string should never be near. It is drawn as escaped text instead. */
const SKIN_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const SKIN_LENGTH = /^(?:0|[1-9]\d{0,2})(?:px|rem)$/
const SKIN_PROPERTY = Object.freeze({
  '--plugin-accent': SKIN_COLOUR,
  '--plugin-accent-text': SKIN_COLOUR,
  '--plugin-surface': SKIN_COLOUR,
  '--plugin-surface-text': SKIN_COLOUR,
  '--plugin-border': SKIN_COLOUR,
  '--plugin-radius': SKIN_LENGTH,
})

/* A SURFACE ONLY WITH A TEXT COLOUR THAT CAN BE READ ON IT (1.0.50 release review
 * F8). The card paints --plugin-surface behind its own text, and that text is the
 * permissions, the risk lines and "Withdraw everything". A light surface under a
 * dark theme's light text (or the reverse) made them close to invisible, while
 * the box said nothing a plugin writes could hide anything. So the two travel
 * together or not at all: both valid, and at least 4.5 to 1 apart (the WCAG ratio
 * for body text). plugins.css sets the card's text to --plugin-surface-text. */
const MIN_SURFACE_CONTRAST = 4.5
function luminance(hex) {
  const digits = hex.length === 4 ? hex.slice(1).split('').map(digit => digit + digit).join('') : hex.slice(1)
  const [red, green, blue] = [0, 2, 4].map(at => parseInt(digits.slice(at, at + 2), 16) / 255)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}
export function contrastRatio(first, second) {
  const [light, dark] = [luminance(first), luminance(second)].sort((left, right) => right - left)
  return (light + 0.05) / (dark + 0.05)
}

export function skinStyle(skin) {
  const valid = {}
  for (const [property, pattern] of Object.entries(SKIN_PROPERTY)) {
    const value = skin && skin[property]
    if (typeof value === 'string' && pattern.test(value)) valid[property] = value
  }
  const surface = valid['--plugin-surface']
  const text = valid['--plugin-surface-text']
  if (!surface || !text || contrastRatio(surface, text) < MIN_SURFACE_CONTRAST) {
    delete valid['--plugin-surface']
    delete valid['--plugin-surface-text']
  }
  return Object.keys(SKIN_PROPERTY).filter(property => Object.hasOwn(valid, property))
    .map(property => `${property}:${valid[property]}`).join(';')
}

export function badgeWord(skin) {
  const value = skin && skin['--plugin-badge']
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/.test(value) ? value : ''
}

/* One of the plugin's OWN settings. It states what it grants and what it risks,
   separately, because the plugin host requires both of a row and refuses one that
   omits either -- and a screen that dropped the risk line would make that
   requirement pointless. */
export function settingRowMarkup(row) {
  const control = row.control === 'toggle'
    ? `<span class="plugin-setting-default">${row.default ? 'On' : 'Off'} by default</span>`
    : row.control === 'select'
      ? `<span class="plugin-setting-default">${esc(String(row.default))} of ${(row.options || []).map(esc).join(' / ')}</span>`
      : `<span class="plugin-setting-default">${esc(String(row.default))}${row.unit ? ` ${esc(row.unit)}` : ''} by default</span>`
  return `<li class="plugin-setting">`
    + `<div class="plugin-setting-head"><span class="plugin-setting-label">${esc(row.label)}</span>${control}</div>`
    + `<p class="plugin-setting-consequence">${esc(row.consequence)}</p>`
    /* Each list says what it is in words. Told apart only by a red bullet, the
       two read as one list to anybody who cannot see that colour (found in the
       real app, 1.0.49 plugins walk). */
    + `<p class="plugin-setting-list-label">What you gain</p>`
    + `<ul class="plugin-setting-gains">${(row.capabilities || []).map(line => `<li>${esc(line)}</li>`).join('')}</ul>`
    + `<p class="plugin-setting-list-label">What could go wrong</p>`
    + `<ul class="plugin-setting-risks">${(row.risks || []).map(line => `<li>${esc(line)}</li>`).join('')}</ul>`
    + `</li>`
}

/* THE LIMITS A PLUGIN HOLDS ITSELF TO, LABELLED AS ITS OWN CLAIM.
 *
 * A restrictions file can only narrow -- the host's shape has no field that widens
 * anything -- but it is still the package talking about itself, and a screen that
 * presented it as enforcement would be handing a stranger's prose the authority of
 * the product. So it is drawn under a heading that says whose claim it is, and the
 * sentence above it says where enforcement actually comes from. */
export function limitsMarkup(limits) {
  if (!limits) return ''
  const blocks = (limits.hardBlocks || []).map(block =>
    `<li><span class="plugin-limit-rule">${esc(block.rule)}</span>`
    + `<span class="plugin-limit-why">${esc(block.why)}</span></li>`).join('')
  const approvals = (limits.requiresHumanApproval || []).map(line => `<li>${esc(line)}</li>`).join('')
  return `<h4>Limits this plugin says it holds itself to</h4>`
    + `<p class="plugin-limits-note">These are the package\u2019s own words, not something this app enforces. What it `
    + `can actually reach is decided by the permissions above and by your tool answers.</p>`
    + (blocks ? `<ul class="plugin-limits">${blocks}</ul>` : '')
    + (approvals ? `<p class="plugin-limits-sub">It says these always need a person:</p><ul class="plugin-limits">${approvals}</ul>` : '')
}

/* A contribution whose file is malformed, named with the engine's own sentence. */
export function contributionRefusedMarkup(refused) {
  if (!refused || !refused.length) return ''
  return `<div class="plugin-contrib-refused"><h4>Parts of this plugin could not be read</h4>`
    + refused.map(entry =>
      `<p class="plugin-contrib-refused-what" data-code="${esc(entry.code)}">Its ${esc(entry.what)}:</p>`
      + `<pre class="plugin-refusal">${esc(entry.message)}</pre>`).join('')
    + `<p class="plugin-limits-note">Everything else about this plugin still works.</p></div>`
}

/* WHETHER IT IS RUNNING, WHEN IT IS NOT (1.0.50 release review F6). Allowed and
   running says nothing more: the state sentence already covers it. The engine's
   own sentence is shown as written, escaped, because it names what to do. */
const RUNNING_PART = Object.freeze({ roles: 'Its roles', tools: 'Its tools', package: 'It' })
export function runningMarkup(running) {
  if (!running || running.state === 'running') return ''
  if (running.state === 'not-yet') {
    return `<p class="plugin-running is-pending">Not running yet. What you allowed takes effect the next time you open the app.</p>`
  }
  if (running.state === 'partly') {
    return `<div class="plugin-running is-bad"><p>Running, but part of it did not start when the app opened:</p>`
      + (running.parts || []).map(part => `<p class="plugin-running-part">${esc(RUNNING_PART[part.part] || 'A part')}:</p>`
        + `<pre class="plugin-refusal">${esc(part.message)}</pre>`).join('')
      + `</div>`
  }
  return `<div class="plugin-running is-bad"><p>Not running. It did not start when the app opened, so none of what is allowed below is in use:</p>`
    + `<pre class="plugin-refusal">${esc(running.reason)}</pre></div>`
}

export function packageMarkup(entry, { writable = true } = {}) {
  const tools = entry.tools && entry.tools.length
    ? `<ul class="plugin-tools">${entry.tools.map(toolRowMarkup).join('')}</ul>`
    : `<p class="plugin-none">It declares no tools.</p>`
  const style = skinStyle(entry.skin)
  const badge = badgeWord(entry.skin)
  const settings = entry.settings && entry.settings.length
    ? `<h4>Its own settings</h4><p class="plugin-limits-note">Shown only. In this version you cannot change these, and the plugin is not told any value.</p><ul class="plugin-settings">${entry.settings
      .filter(row => !row.refused).map(settingRowMarkup).join('')}</ul>`
    : ''
  return `<section class="plugin-card" data-sha256="${esc(entry.sha256)}"${style ? ` style="${esc(style)}"` : ''}>`
    + `<header class="plugin-card-head">`
    + `<h3>${esc(entry.displayName)}${badge ? ` <span class="plugin-badge">${esc(badge)}</span>` : ''}</h3>`
    + `<code class="plugin-id" title="${esc(entry.sha256)}">${esc(shortId(entry.sha256))}</code>`
    + `</header>`
    + `<p class="plugin-summary">${esc(entry.summary)}</p>`
    + `<p class="plugin-state">${stateSentence(entry)}</p>`
    + runningMarkup(entry.running)
    + `<div class="plugin-caps">${entry.requested.map(capability =>
      capabilityRowMarkup(entry, capability, { writable })).join('')}</div>`
    + `<h4>What it would run</h4>${tools}`
    + `<p class="plugin-contrib">${esc(contributionLine(entry))}</p>`
    + settings
    + limitsMarkup(entry.limits)
    + contributionRefusedMarkup(entry.contributionsRefused)
    + `<div class="plugin-actions">`
    + `<button class="plugin-save" data-sha256="${esc(entry.sha256)}"${writable ? '' : ' disabled'}>Save these answers</button>`
    + (entry.granted.length
      ? `<button class="plugin-revoke" data-sha256="${esc(entry.sha256)}"${writable ? '' : ' disabled'}>Withdraw everything</button>`
      : '')
    + `</div>`
    + `<p class="plugin-restart">${esc(RESTART_NOTE)}</p>`
    + `</section>`
}

/* A DIRECTORY THAT WOULD NOT LOAD IS NAMED, WITH THE REFUSAL VERBATIM.
 *
 * The refusal text comes from the engine and it is written to be acted on -- it
 * names the field, the file and what to do. Summarising it here would throw away
 * the only thing that helps. It is escaped, not trusted: part of it is a filename
 * a stranger chose. */
export function refusedMarkup(refused) {
  return `<section class="plugin-card is-refused" data-code="${esc(refused.code)}">`
    + `<header class="plugin-card-head"><h3>${esc(refused.directory)}</h3></header>`
    + `<p class="plugin-summary">This directory is not loaded as a plugin, so nothing in it is running.</p>`
    + `<pre class="plugin-refusal">${esc(refused.message)}</pre>`
    + `</section>`
}

export function emptyMarkup(root) {
  return `<section class="plugin-card is-empty">`
    + `<h3>No plugins added</h3>`
    + `<p class="plugin-summary">A plugin is a folder you downloaded and put here yourself. There is no store, and `
    + `nothing arrives on its own.</p>`
    + `<pre class="plugin-path">${esc(root || '')}</pre>`
    + `<p class="plugin-summary">${esc(IDENTITY_NOTE)}</p>`
    + `</section>`
}

/* THE PAGE'S OWN FAILURE, WHICH IS NOT AN EMPTY LIST. "You have no plugins" and
   "this could not be read" are different answers and the second one must not be
   drawn as the first. */
export function unavailableMarkup(result) {
  return `<section class="plugin-card is-refused" data-code="${esc(result && result.code)}">`
    + `<h3>The plugin list could not be read</h3>`
    + `<pre class="plugin-refusal">${esc(result && result.reason)}</pre>`
    + `<p class="plugin-summary">This is not the same as having no plugins. Nothing has been changed.</p>`
    + `</section>`
}

export function pageMarkup(result, { writable = true } = {}) {
  if (!result || result.ok !== true) return unavailableMarkup(result)
  const cards = [
    ...result.packages.map(entry => packageMarkup(entry, { writable })),
    ...result.refused.map(refusedMarkup),
  ]
  if (!cards.length) return emptyMarkup(result.root)
  return `<p class="plugin-intro">${esc(IDENTITY_NOTE)}</p>${cards.join('')}`
}

export const __esc = esc
