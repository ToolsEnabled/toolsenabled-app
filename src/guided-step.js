/* THE MARKUP FOR "WHAT THIS GRANTS, WHAT IT RISKS, AND THE STEP WE WILL NOT
 * TAKE FOR YOU".
 *
 * src/permission-guidance.js holds the statements and knows nothing about a
 * screen; this file turns them into the app's existing control language and
 * knows nothing about what any particular setting means. Same split as
 * src/setup-profile.js and src/setup-profile-settings.js, for the same reason:
 * the part that decides what a stranger is told about their own computer has to
 * be testable without a browser.
 *
 * IT REUSES THE CLASSES THAT ALREADY EXIST -- .settings-desc for body text,
 * .fleet-profile-status for a block that explains rather than controls -- so a
 * guided step reads as part of this product rather than as a panel bolted to
 * it. The few new classes are in src/guided-step.css and do nothing but the
 * disclosure itself.
 *
 * IT IS A <details>, CLOSED BY DEFAULT, AND THAT IS THE DESIGN RATHER THAN AN
 * ECONOMY. A settings page that shouts two paragraphs of risk at every row is a
 * page nobody reads, which produces exactly the outcome the directive is
 * against: a person clicking past warnings. Closed, the line is an offer. Open,
 * it is the whole answer. Nothing is hidden that a person has to hunt for --
 * the summary line is on every row, in the same place, with the same words.
 */

/* THE STYLESHEET IS IMPORTED BY src/main.js, NOT HERE, and the reason is
   mechanical rather than tidiness: this module is reached from
   src/setup-profile-settings.js, which tools/test/setup-profile.test.mjs
   imports, and `node --test` cannot load a .css file. A stylesheet import here
   takes that suite down at module resolution. It also belongs in main.js on its
   own merits -- the drawer renders this markup on every page, so the rules have
   to be present before any view has been visited. */
import { describeSubject, guidedStepFor, explainWithheld } from './permission-guidance.js'
/* THE STEP TEXT IS WRITTEN FOR THE DESK, THEN RE-READ FROM WHERE THE PERSON IS.
 *
 * THE DEFECT THIS CLOSES. src/permission-guidance.js's `codex-installed` and
 * `codex-cloud-account` steps say "Sign in opens a terminal window and runs
 * the sign-in in it. You finish it there" -- and this disclosure sits under
 * "Run an agent session" and "Launch Codex Cloud tasks" in Settings, open to
 * anybody who expands it, on every load, with no refusal in front of it. A
 * browser driving a computer over the relay reads that "there" as the tab it
 * has open; the terminal actually opens on the computer being driven, which
 * this browser cannot see or finish anything in.
 *
 * readerRemedy() already holds the desk-to-remote correspondence for exactly
 * this shape of sentence (src/refusal-copy.js); this disclosure simply never
 * called it. Same fix as src/views/guide.js and src/views/settings.js: the
 * desk sentence is kept byte-for-byte in the data module, and only the READ of
 * it changes here, at the one place that knows whether this page is looking at
 * its own computer or someone else's. */
import { readerRemedy } from './refusal-copy.js'
import { currentDataSource } from './data-source.js'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

const list = items => `<ul class="guided-list">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`

function group(label, items) {
  if (!items || items.length === 0) return ''
  return `<div class="guided-group">
    <span class="guided-label">${esc(label)}</span>
    ${list(items)}
  </div>`
}

/* THE STEP BLOCK. Four things in a fixed order, because the order is the
 * argument: what it would do, what it gains against what it costs, that you do
 * not have to, and only then how. A list of commands above the sentence saying
 * they are optional is a list of commands a person feels they have to run. */
/* THE LINE THAT SAYS WHETHER THIS WILL WANT ANYTHING FROM YOU (owner, R1536).
 *
 * It sits above everything else in the block, because "is this going to ask me
 * for something" is the question a person has before any of the others, and
 * because a badge answered at a glance is what stops somebody skipping the
 * paragraph underneath it.
 *
 * TIER 1 REPLACES THE GENERAL CLAIM RATHER THAN SITTING NEXT TO IT. Where the
 * engine handed us a reading of this actual computer, the badge says what THIS
 * machine will do; the general "typically / sometimes / rarely" is still
 * carried in a data attribute so a surface, a test, or a person with the
 * inspector open can see what was claimed in general and challenge it. Where
 * there is no reading, the general label is shown and the sentence underneath
 * says plainly that it could not be checked here -- which is tier 2, and is an
 * answer rather than a gap. */
function frequencyMarkup(frequency) {
  if (!frequency || (!frequency.label && !frequency.detail)) return ''
  return `<p class="guided-frequency" data-guided-frequency-tier="${esc(frequency.tier)}" data-guided-frequency-source="${esc(frequency.source)}" data-guided-frequency-declared="${esc(frequency.declared || '')}">
    ${frequency.label ? `<span class="guided-frequency-label">${esc(frequency.label)}</span>` : ''}
    ${frequency.detail ? `<span class="guided-frequency-detail">${esc(frequency.detail)}</span>` : ''}
  </p>`
}

/* THE GAIN AND THE COST, AND FOR THE WHOLE LIFE OF THIS FEATURE THERE WAS
 * NEITHER.
 *
 * The gain line below used to read `capability.capabilitiesGained` -- a field no
 * entry in src/permission-guidance.js has ever had. group() was therefore handed
 * an empty array and returned an empty string, every time, on every capability:
 * a heading nobody ever saw, over a list that was never there. Nothing went red,
 * because an absence rendered as nothing is indistinguishable from a decision
 * not to render anything. That is this codebase's signature defect, inside the
 * pair of modules written to prevent it.
 *
 * It reads `capability.gains` now, the field is declared on every capability,
 * and `capability.costs` is printed beside it -- because the owner's shape for a
 * permission control is three things and the third is what it COSTS. A gain
 * printed without its cost is an advertisement. validateGuidance() requires
 * both, so the next capability cannot arrive with only the good half. */
function stepMarkup(step) {
  if (!step) return ''
  const { capability, state } = step
  return `<div class="guided-step" data-guided-step="${esc(capability.id)}" data-guided-state="${esc(state)}">
    <span class="guided-label">${esc(step.headline)}</span>
    ${frequencyMarkup(step.frequency)}
    <p class="settings-desc">${esc(readerSentence(capability.whatItDoes))}</p>
    ${state === 'unknown' ? `<p class="settings-desc guided-unknown">This copy could not check whether this is set up, so it will not tell you either way. The steps below are what it would take if it is not.</p>` : ''}
    ${step.showSteps ? `
      ${group('What doing this would let you do', capability.gains || [])}
      ${group('What it costs you', capability.costs || [])}
      <p class="settings-desc guided-optional">${esc(step.optionalNote)}</p>
      <p class="settings-desc guided-never">${capability.elevation
        ? 'This step needs an administrator. This program does not ask Windows for administrator rights, does not change any Windows security setting, and will not do this for you. The words below are what you would run yourself, and you can close the window and change nothing.'
        : 'This program will not do this for you. The words below are what you would run or set up yourself.'}</p>
      <ol class="guided-steps">
        ${(capability.steps || []).map(item => `<li>
          <span class="guided-do">${esc(item.do)}</span>
          ${item.why ? `<span class="guided-why">${esc(readerSentence(item.why))}</span>` : ''}
        </li>`).join('')}
      </ol>
      <p class="settings-desc"><span class="guided-label-inline">How you will know it worked:</span> ${esc(step.verify)}</p>
    ` : ''}
    <p class="settings-desc guided-without"><span class="guided-label-inline">${step.showSteps ? 'If you skip it:' : 'If this ever stops being true:'}</span> ${esc(step.withoutIt)}</p>
  </div>`
}

/**
 * The disclosure that hangs under one settings row.
 *
 * @param id       the subject id, usually the row's own id.
 * @param options.section  the row's section, for the shared family statement.
 * @param options.probe    (capabilityId) -> true | false | anything else, where
 *                         anything else means "could not check" and is said so.
 * @param options.posture  optional { outcome, sentence } read from this actual
 *                         computer by the engine, which turns the general
 *                         "usually needs a step" into "on your computer this
 *                         will ask you to approve it". Absent is tier 2 and is
 *                         said out loud rather than guessed around.
 * @param options.summary  the summary line, when a surface wants its own.
 */
export function guidanceMarkup(id, { section = null, probe = null, posture = null, summary = 'What this does, and what it risks' } = {}) {
  const guidance = describeSubject(id, { section })
  if (!guidance.declared) {
    /* THE ABSENCE, SHOWN RATHER THAN SWALLOWED. A row with no statement gets
       the honest line, not silence and not a soothing default. Silence here
       would read as "this one has no risks", which is a claim nobody made. */
    return `<details class="guided-note is-undeclared" data-guided-for="${esc(id)}" data-guided-declared="false">
      <summary class="guided-summary">${esc(summary)}</summary>
      <div class="guided-body">
        <p class="settings-desc">${esc(guidance.absenceNote)}</p>
      </div>
    </details>`
  }
  const step = guidedStepFor(id, { probe, posture })
  return `<details class="guided-note" data-guided-for="${esc(id)}" data-guided-declared="true">
    <summary class="guided-summary">${esc(summary)}</summary>
    <div class="guided-body">
      ${guidance.whatItDoes ? `<p class="settings-desc">${esc(guidance.whatItDoes)}</p>` : ''}
      ${group('What it lets happen', guidance.capabilities)}
      ${group('What it risks', guidance.risks.map(readerSentence))}
      ${guidance.turnOnAt ? `<p class="settings-desc guided-where"><span class="guided-label-inline">Where this switch lives:</span> ${esc(guidance.turnOnAt)}</p>` : ''}
      ${stepMarkup(step)}
    </div>
  </details>`
}

/**
 * The block that explains a withheld state, answering all three questions.
 *
 * Used where something is OFF and a person is looking at the space where a
 * control would be. It uses the .fleet-profile-status idiom the rest of the app
 * uses for "this is an explanation, not a control".
 */
export function withheldMarkup(id, { label = '', reason = '', tone = 'is-quiet' } = {}) {
  const withheld = explainWithheld(id, { label, reason })
  if (!withheld.declared) {
    return `<div class="fleet-profile-status ${esc(tone)}" role="status" data-guided-withheld="${esc(id)}" data-guided-declared="false">
      <strong>${esc(withheld.what)}</strong>
      ${withheld.why ? `<span>${esc(withheld.why)}</span>` : ''}
      <span>${esc(withheld.absenceNote)}</span>
      <span>${esc(withheld.optional)}</span>
    </div>`
  }
  return `<div class="fleet-profile-status ${esc(tone)}" role="status" data-guided-withheld="${esc(id)}" data-guided-declared="true">
    <strong>${esc(withheld.what)}</strong>
    ${withheld.whatItDoes ? `<span>${esc(withheld.whatItDoes)}</span>` : ''}
    ${withheld.why ? `<span>${esc(withheld.why)}</span>` : ''}
    ${group('What turning it on would let you do', withheld.capabilities)}
    ${group('What it would risk', withheld.risks)}
    ${withheld.turnOnAt ? `<span><span class="guided-label-inline">Where to turn it on:</span> ${esc(withheld.turnOnAt)}</span>` : ''}
    <span class="guided-optional">${esc(withheld.optional)}</span>
  </div>`
}
