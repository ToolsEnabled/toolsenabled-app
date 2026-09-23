/* THE PANEL THAT ASKS A PERSON WHAT THE NEW AGENT IS AND WHAT IT SHOULD DO.
 *
 * Owner, on pressing an empty node in the fleet tree: "then they should be able
 * to assign role and message and such from the right side panel".
 *
 * So this is two fields and two buttons. The whole design argument is about what
 * it deliberately does NOT do, because every one of those omissions is a lie
 * this product has told before in some other shape.
 *
 * 1. IT WRITES NO WORDS OF ITS OWN. Every sentence, label, prompt and refusal in
 *    here comes from src/fleet-tree-copy.js, which owns the copy for this whole
 *    flow -- the empty tree, the empty node, this panel, the start, the four
 *    refusals. Six surfaces render one flow, and copy written inline in six
 *    places becomes six voices inside a week. This file's job is which string
 *    goes where and when, never what the string says. Where the flow needs a
 *    string that module does not have, the answer is to get it added there; the
 *    two places that happens are marked below by name.
 *
 * 2. IT STARTS NOTHING. It collects a role and a brief and hands them to a
 *    callback. It never touches the agent runner, never posts to the audited
 *    connection, never writes a node into the tree. That is not a limitation to
 *    be fixed later: a panel that both collects a draft and spawns a child
 *    process has two failure modes wearing one button, and the person cannot
 *    tell which of them happened. The caller owns starting, owns the draft node,
 *    and owns every sentence about whether starting worked. This file owns the
 *    form. The button says "Start this agent" because that is what the person's
 *    press does END TO END, and the copy module is written for the flow rather
 *    than for this module -- so a caller that will NOT start anything must not
 *    mount this panel at all.
 *
 * 3. IT NEVER SHOWS A ROLE KEY. Role keys are join keys in src/vocab.js and mean
 *    nothing outside this repository. roleLabel() is the only way a role is
 *    named here, and a key it does not recognise comes back as the plain word
 *    "Agent" rather than as the key. The key rides on the option's value, which
 *    is where a key belongs -- between two pieces of program.
 *
 * 4. TWO THINGS ON THIS PANEL COME FROM OUTSIDE THIS REPOSITORY, AND THEY BOTH
 *    ARRIVE THROUGH ONE DOOR EACH. The pressed node's NAME, which is only ever
 *    rendered inside START_PANEL.underNamed() -- a name is never put on the
 *    page bare, because a bare name is a fragment a reader has to guess the
 *    meaning of, and it is put there as TEXT and never as markup. And a REFUSAL
 *    SENTENCE from the caller, which the caller is answerable for under the same
 *    plain-language gate. Nothing else: not an id, and never an Error's own
 *    words, which are written for whoever holds the repository and routinely
 *    carry a path, a code or an internal name.
 *
 * 5. IT CAN BE COMPLETED WITHOUT A MOUSE. Every control is a real focusable
 *    element with a real label bound to it by id. Nothing here is a div wearing
 *    a click handler. Escape cancels, because a panel that opens over a keyboard
 *    user's tree and can only be closed by finding a button with the Tab key is
 *    a trap. The refusals are marked as alerts and named in their own field's
 *    description, so a screen reader reads the problem when focus lands on the
 *    field that has it.
 *
 * WHY THE STYLES ARE NOT IMPORTED HERE. src/agent-compose-panel.css is imported
 * by the VIEW that mounts this, the same way src/views/computers.js imports
 * board.css. A `import './agent-compose-panel.css'` in this file would make the
 * module unloadable in `node --test`, which is where every behaviour below is
 * proven; a component that cannot be tested without a browser gets tested by
 * looking at it, which is how the empty states in this product got wrong twice.
 */

import {
  DEFAULT_TIER,
  firstRoleSuggestionLine,
  ROLE_CHOICES,
  START_PANEL,
  START_REFUSAL,
  TIER_CHOICES,
  EFFORT_CHOICES,
  effortOptionLabel,
  roleLabel,
  startingLine,
} from './fleet-tree-copy.js'
import { LAUNCH_TIERS } from './orchestration-controls.js'
import { railTitleRowElement } from './rail-title.js'
import { controlState, pastedImageFromClipboard } from './components.js'

const asText = value => (typeof value === 'string' ? value : '')
const asTrimmed = value => asText(value).trim()
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/* A failed attempt to change an availability switch is not evidence that the
   old availability reading is still true. Keep this machine-readable answer
   beside the boundary that produces it: callers can distinguish an ordinary
   `false` (the write was read back and did not take) from a throw (the read or
   write could not be completed). The sentence deliberately claims no absence. */
export const COMPOSE_ACTION_COULD_NOT_TELL = 'COMPOSE_ACTION_COULD_NOT_TELL'
export const COMPOSE_ACTION_COULD_NOT_TELL_SENTENCE =
  'The change could not be checked. This does not mean the unavailable condition is still present.'

/* Ids have to be unique on the page for `for`/`aria-describedby` to bind, and
   two of these panels can exist at once -- one being closed by a fade while the
   next node's opens. A counter is enough; nothing persists it and nothing reads
   it back. These ids are never rendered as text. */
let panelSequence = 0

/**
 * The roles a person may choose from, as `{ id, label, summary }`.
 *
 * THE LIST IS NOT INVENTED HERE. ROLE_CHOICES in src/fleet-tree-copy.js is the
 * product's own pick list: its labels are read from src/vocab.js ROLES at load,
 * so a profile that renames a role renames it here too, and it leaves out the
 * one role nobody hands out -- "Agent spawned" is what an agent BECOMES when
 * another agent starts it, not a job. That reasoning belongs with the copy, and
 * this file defers to it rather than filtering the vocabulary itself.
 *
 * A caller may pass a narrower list, because the tree owner may know something
 * this form does not. Three shapes are accepted, since three already exist on
 * this tree: `{ role, label }` (the copy module's own), `{ id, label }`, and a
 * bare array of role keys. A LABEL IS NEVER REQUIRED and a key is never printed
 * when one is missing: roleLabel() supplies the word, and answers "Agent" for a
 * key it does not know.
 *
 * AN EMPTY RESULT FALLS BACK TO THE PRODUCT'S OWN LIST rather than rendering an
 * empty menu under a live button. A form nobody can complete needs a sentence
 * saying why, that sentence would have to be invented here, and a caller that
 * hands over nothing is a wiring fault rather than a state a person can reach.
 * If a real "no role can be assigned in this tree" state ever exists, it needs
 * its own sentence in src/fleet-tree-copy.js and its own branch here.
 */
export function assignableRoles(source = ROLE_CHOICES) {
  const entries = []
  const seen = new Set()
  const add = (id, label, summary, orgRoot) => {
    const key = asTrimmed(id)
    if (!key || seen.has(key)) return
    seen.add(key)
    entries.push(Object.freeze({ id: key, label: asTrimmed(label) || roleLabel(key), summary: asTrimmed(summary),
      ...(typeof orgRoot === 'boolean' ? { orgRoot } : {}) }))
  }

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string') add(entry, '', '')
      else if (isRecord(entry)) add(entry.role || entry.id || entry.key, entry.label, entry.summary, entry.orgRoot)
    }
  } else if (isRecord(source)) {
    for (const [id, entry] of Object.entries(source)) {
      add(id, isRecord(entry) ? entry.label : entry, isRecord(entry) ? entry.summary : '')
    }
  }

  return Object.freeze(entries.length > 0 ? entries : assignableRoles(ROLE_CHOICES))
}

/**
 * The role a draft actually carries, out of what the menu is offering.
 *
 * THE ROLE IS OPTIONAL AND THIS IS WHAT MAKES THAT SAFE. Owner, 2026-08-19:
 * "users shouldnt be forced to choose a role". The panel no longer refuses a
 * draft with no role -- so the question stopped being "may this press through"
 * and became "what does this draft say the role is", which is a different
 * function and belongs in its own.
 *
 * ANYTHING NOT ON THE MENU RESOLVES TO NO ROLE. That case was already handled
 * by refusing the press, and refusing is gone; letting it through instead would
 * put a key nobody offered into the store, where roleLabel() has no word for it
 * and every surface would print the product's fallback over it. Resolving it to
 * the same honest absence a person gets by leaving the first row alone means
 * there is one no-role state in this flow rather than two that look alike.
 *
 * It is only reachable when a caller assigns a value from outside the menu: a
 * real <select> handed a value with no matching option reports '' by itself.
 */
export function composeDraftRole(role = '', roles = ROLE_CHOICES) {
  const picked = asTrimmed(role)
  return assignableRoles(roles).some(choice => choice.id === picked) ? picked : ''
}

/**
 * What is wrong with the draft, as one sentence per problem.
 *
 * A pure function, separate from the DOM on purpose: refusals are the part of a
 * form that a screenshot never proves and a unit test proves exactly. Returns an
 * empty list when the draft may be handed over.
 *
 * THE ROLE IS NOT ONE OF THEM ANY MORE (owner, 2026-08-19: "users shouldnt be
 * forced to choose a role"). It is not softened, not deferred and not hidden
 * behind a hover -- the refusal is gone, and START_PANEL.needRole went with it.
 * A start with no role is a real start: fleet-trees.js stores an empty role by
 * design, startingLine() and runningLine() drop the role clause rather than
 * printing a vague one, treeNodeName() answers with the product's own word for
 * an agent it cannot name. At launch, computers.js supplies a bounded declared
 * identity even for this blank canvas choice so a started circle can delegate;
 * that identity is not a role selection and does not alter what this panel
 * stores or displays. composeDraftRole() above is what keeps the visible
 * absence honest.
 *
 * THE BRIEF IS STILL REQUIRED. The sentence is START_PANEL's, so this file
 * cannot drift from the rest of the flow's voice.
 *
 * @returns [{ field: 'message', sentence: string }]
 */
export function composeDraftProblems({ message = '' } = {}) {
  const problems = []

  if (!asTrimmed(message)) {
    problems.push({ field: 'message', sentence: START_PANEL.needMessage })
  }

  return Object.freeze(problems.map(problem => Object.freeze(problem)))
}

/* THE FIVE PARAGRAPHS THAT TAUGHT, AND WHERE THEY WENT.
 *
 * Owner, 2026-08-19, on this panel for the second time: "pg 2 right pnel STILL
 * reads ugly and messy. Make some of the tips only show on hover (give it a
 * nice clean box in theme and give it a slightly longer delay like 1s) so it
 * isnt so messy".
 *
 * THE LINE THIS DRAWS, AND IT IS THE ONLY ONE THAT MATTERS HERE. A tip EXPLAINS
 * a control: it is true on every computer, it says the same thing whatever this
 * machine happens to be, and a person who already knows the product never needs
 * to read it again. A FACT states something about THIS computer or THIS press --
 * a refusal, a warning, a permission level, an honest empty state -- and hiding
 * one behind a gesture would be undoing the work that put it on the glass. So
 * exactly five strings move and they are all field help:
 *
 *   HIDDEN (tips)   roleHelp, tierHelp, effortHelp, messageHelp, and folderHelp
 *                   -- but only when the folder hint is really folderHelp
 *   VISIBLE (facts) folderNone / folderNoneChosen (this computer has no named
 *                   folders, and where a start would actually land), the
 *                   under-line naming the pressed node, the panel notice
 *                   (every refusal and stated absence), the confinement line,
 *                   the progress line, the brief's refusal, and every tier row
 *                   that says nobody is signed in or the program is not here
 *   VISIBLE (kept)  the intro and the empty-tree suggestion: one short line
 *                   each, they orient rather than teach, and the owner asked
 *                   for SOME of the tips. The chosen role's summary stays too
 *                   -- it appears only after a deliberate choice and is the
 *                   answer to that choice.
 *
 * HOW IT IS HIDDEN, AND WHAT IS NOT HIDDEN WITH IT. The paragraph stays in the
 * page and stays named by its field's aria-describedby: it is taken out of the
 * FLOW (absolutely positioned) and faded, never `display: none` and never
 * `visibility: hidden`, both of which would take it out of the accessibility
 * tree as well. A screen reader reads exactly what it read yesterday. What
 * changed is only what a sighted person sees at rest.
 *
 * AND IT COMES BACK FOR A KEYBOARD. The reveal is the LABEL being hovered or
 * THE FIELD'S OWN CONTROL taking a visible focus -- so tabbing onto the menu
 * shows its explanation, with no new tab stop invented to hold a tip. See
 * src/agent-compose-panel.css for both selectors and the 1s delay.
 *
 * AND FOR A FINGER, AND FOR A DISABLED FORM. A press on the label toggles the
 * tip (fieldLabel below), because the two reveals above both die exactly where
 * this panel is read first: the preview ships every field disabled, a disabled
 * control cannot take focus, and a touch screen has no hover. The disabled
 * form's own notice still carries the refusal; the tips stay reachable beside
 * it rather than becoming four marks that answer nothing. */

/* Built element by element, never from a markup string, and every string in it
   comes from src/fleet-tree-copy.js. `underLine` is the one place a name the
   caller supplied reaches the page, already wrapped in the copy module's own
   sentence before it gets here. */

/* A FIELD LABEL, AND WHETHER IT SAYS ITS FIELD HAS A TIP BEHIND IT.
 *
 * The mark is `aria-hidden` and lives INSIDE the label rather than beside it,
 * so it adds no tab stop, no accessible name and no second control. The label
 * is the press-and-hover target: a person reading the question is exactly the
 * person who wants the sentence under it, and the tip opens BELOW the whole
 * field so it never lands on top of the control they are travelling towards.
 *
 * A PRESS ON THE LABEL HOLDS THE TIP OPEN, hover or no hover. Measured on the
 * desktop and phone press-throughs (2026-08-27): with the panel's fields
 * shipped disabled — the preview, where a new person reads this panel first —
 * the four "?" marks answered nothing at all. Hover was suppressed by a CSS
 * rule for disabled forms, focus-reveal cannot fire on a control that refuses
 * focus, and touch has no hover to begin with. So the label now toggles
 * `tip-open` on its field: one press shows the sentence, a second puts it
 * away, and it works identically on a disabled form and under a finger. The
 * class is spelled through className rather than classList so the panel keeps
 * running over the suite's deliberately narrow fake DOM. */
const TIP_OPEN_CLASS = 'tip-open'
function toggleTipOpen(field) {
  if (!field) return
  const classes = String(field.className || '').split(/\s+/).filter(Boolean)
  const at = classes.indexOf(TIP_OPEN_CLASS)
  if (at === -1) classes.push(TIP_OPEN_CLASS)
  else classes.splice(at, 1)
  field.className = classes.join(' ')
}
function fieldLabel(doc, { forId, words, tipped }) {
  const label = doc.createElement('label')
  label.className = 'cl'
  label.setAttribute('for', forId)
  label.textContent = words
  if (tipped) {
    const mark = doc.createElement('span')
    mark.className = 'tip-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = START_PANEL.tipMark
    label.appendChild(mark)
    label.addEventListener('click', () => toggleTipOpen(label.parentNode))
  }
  return label
}

/* THE HELP UNDER A FIELD. `tipped` decides whether it stands on the page or
   waits behind the label -- and it is a parameter rather than a rule because
   one of these elements carries a TIP in one state and a FACT about this
   computer in another (see the folder field). */
function fieldHint(doc, { id, words, tipped }) {
  const hint = doc.createElement('p')
  hint.className = tipped ? 'agent-compose-hint tip-box' : 'agent-compose-hint'
  hint.setAttribute('id', id)
  if (tipped) hint.setAttribute('data-compose-tip', 'hover')
  hint.textContent = words
  return hint
}
function buildPanel(doc, { choices, newTree, underLine, tiers = TIER_CHOICES, folders = [], folderSelectedId = null, defaultFolder = '', researchProjects = [], researchUnavailableReason = '' }) {
  const id = `agent-compose-${panelSequence += 1}`

  const root = doc.createElement('section')
  root.className = 'agent-compose'
  root.setAttribute('data-agent-compose', 'open')
  root.setAttribute('aria-labelledby', `${id}-title`)
  /* Programmatically focusable, never in the tab order. The Escape handler
     below sits on this root and hears only keys that bubble up from INSIDE the
     panel -- so whoever mounts this panel must put focus inside it, and for a
     pointer open the right landing place is the root itself (no caret jumps
     into a field out from under the mouse). Measured on the packaged build
     2026-08-20: a mouse-opened panel left focus on the page behind it and
     Escape -- the panel's own documented cancel -- did nothing until a field
     was clicked. Without tabindex="-1" a browser bounces that focus call. */
  root.setAttribute('tabindex', '-1')

  /* The nav row first, so Cancel sits in the SAME back slot every rail page
     puts its back button in (owner defect 6: no mouse travel between pages).
     Cancel keeps its honest word -- this button discards a draft, it does not
     merely navigate -- but it lives where the going-back muscle memory already
     points. Same element, same data attribute, same disable wiring as when it
     sat at the bottom. NO aria-label: the visible words ARE the declared copy,
     and an accessible name that differs from them fails both the speech-input
     rule and agent-start-flow-qa's copy check -- measured, not hypothetical.
     The panel's title rides in the row's own title slot rather than a second
     heading element: the row was already there, and the heading's 30px was
     exactly what pushed Start below the fold of an 832px window. */
  const nav = railTitleRowElement(doc, {
    back: { label: START_PANEL.cancel, attrs: { 'data-compose-action': 'cancel' } },
    title: START_PANEL.title,
    titleId: `${id}-title`,
  })
  root.appendChild(nav.row)
  const cancel = nav.backButton

  /* EVERYTHING BELOW THE NAV ROW SCROLLS, and it has to.
     The rail is a fixed box (`.rail { overflow: hidden }`) whose pages are
     `position: absolute; inset: 0`, so this panel can never make the rail
     taller -- it can only overflow it and be clipped. That is exactly what
     happened: the owner reported "I cant scroll down to even press start",
     because this panel wants ~810px and the rail gives 560-700 on an
     ordinary window. The previous answer was to buy 30px by deleting a
     heading, and the next feature (the effort row) spent it 3.6x over.
     A budget is not a fix; a scroller is. `.rail-scroll` is the same class
     the stats page and the Details tab already scroll with, so this panel
     now behaves like every other rail page: the nav row stays put and the
     form scrolls under it. */
  const body = doc.createElement('div')
  body.className = 'rail-scroll agent-compose-body'
  body.setAttribute('data-compose-body', 'form')
  root.appendChild(body)

  /* "Two answers and it runs" -- a person looking at a new panel is deciding
     whether this is a form they can finish, and the length is the answer. */
  const intro = doc.createElement('p')
  intro.className = 'agent-compose-intro'
  intro.textContent = START_PANEL.intro
  body.appendChild(intro)

  /* WHERE THIS AGENT IS GOING, which is the one question a person has after
     pressing a spot in a tree. Absent on an empty tree: there is nothing to go
     under yet, and the suggestion below is the line that belongs there. */
  if (underLine) {
    const under = doc.createElement('p')
    under.className = 'agent-compose-under'
    under.setAttribute('data-compose-under', 'parent')
    /* textContent, so a node named by nobody on this team is characters. */
    under.textContent = underLine
    body.appendChild(under)
  }

  /* THE FIRST AGENT ON AN EMPTY TREE IS THE ONE EVERYTHING ELSE HANGS UNDER, so
     the suggestion is shown only there. On a tree that already has agents the
     person has done this before and does not need it. It is a suggestion about
     SHAPE and it selects nothing: pre-picking a role would answer the panel's
     own question for them. */
  const suggestionLine = newTree ? firstRoleSuggestionLine(choices) : ''
  if (suggestionLine) {
    const suggestion = doc.createElement('p')
    suggestion.className = 'agent-compose-suggestion'
    suggestion.setAttribute('data-compose-suggestion', 'first-role')
    suggestion.textContent = suggestionLine
    body.appendChild(suggestion)
  }

  /* THE PANEL-WIDE LINE, and it carries two different kinds of news. A refusal
     that came back from the caller is an alert, because it is the answer to a
     button the person just pressed. A stated absence handed in by the caller
     before anything is pressed is not urgent and would interrupt a screen
     reader mid-sentence, so the role is set per message rather than fixed
     here. */
  const notice = doc.createElement('p')
  notice.className = 'agent-compose-notice'
  notice.setAttribute('data-compose-notice', 'panel')
  notice.setAttribute('hidden', 'hidden')
  body.appendChild(notice)

  /* THE WAY OUT OF A STATED ABSENCE, WHEN THERE IS ONE.
   *
   * A notice that names a switch and leaves the person to find it is only half
   * an answer: the panel is open, they are looking at it, and the remedy is one
   * setting away on another screen. This is that switch, in the place the
   * question was asked -- the same shape src/agent-session.js already uses on
   * the agent page, where the off state renders the reason AND the control
   * rather than rendering nothing.
   *
   * IT IS ONLY EVER DRAWN WHEN THE CALLER HANDS ONE OVER, and the caller hands
   * one over only for a reason it can actually undo. A missing application or
   * an unreadable saved forest have no button, because there is nothing this
   * press could do about them, and a control that cannot work is worse than the
   * sentence alone.
   *
   * NOTHING IS WRITTEN UNTIL IT IS PRESSED. The owner's rule for this flag is
   * that his recorded answer stands until he changes it himself, so no render,
   * no mount and no open touches it -- only this click handler, and only
   * through the caller's own `run`, which owns the write. */
  const unavailableAction = doc.createElement('button')
  unavailableAction.type = 'button'
  /* THE PANEL'S OWN BUTTON VOCABULARY, not a new one. `ctl-btn` is what
     agent-compose-submit already wears, so this control arrives styled and
     this module keeps its promise to add no visual vocabulary of its own. */
  unavailableAction.className = 'ctl-btn agent-compose-enable'
  unavailableAction.setAttribute('data-compose-unavailable-action', 'panel')
  unavailableAction.setAttribute('hidden', 'hidden')
  body.appendChild(unavailableAction)

  const roleField = doc.createElement('div')
  roleField.className = 'agent-compose-field'
  const roleLabelNode = fieldLabel(doc, { forId: `${id}-role`, words: START_PANEL.roleLabel, tipped: true })
  const roleHint = fieldHint(doc, { id: `${id}-role-hint`, words: START_PANEL.roleHelp, tipped: true })
  const roleSelect = doc.createElement('select')
  roleSelect.className = 'agent-compose-select'
  roleSelect.setAttribute('id', `${id}-role`)
  roleSelect.setAttribute('data-compose-field', 'role')
  /* THE HINT ALONE. The brief's description names a problem line as well, empty
     or not, because the brief can be refused; this field cannot be, so there is
     no problem element to name. Pointing a description at an element nothing
     will ever write into would be describing a control by a sentence that does
     not exist. */
  roleSelect.setAttribute('aria-describedby', `${id}-role-hint`)
  /* THE FIRST ROW CARRIES NO ROLE, AND IT IS A REAL ANSWER. A menu must have
     something selected, and pre-selecting a real role would answer the panel's
     own question for the person and let a role nobody chose through on one
     press. So the first row is the copy module's own row for no role and its
     value is empty. It used to be refused on Start; since 2026-08-19 (owner:
     "users shouldnt be forced to choose a role") it starts, and the row says
     what it leaves the agent as rather than telling a person to choose. */
  const placeholder = doc.createElement('option')
  placeholder.value = ''
  placeholder.textContent = START_PANEL.rolePrompt
  roleSelect.appendChild(placeholder)
  for (const choice of choices) {
    const option = doc.createElement('option')
    /* The key rides on the value, where only the program reads it. The label is
       the only part with a reader. */
    option.value = choice.id
    option.textContent = choice.label
    roleSelect.appendChild(option)
  }
  roleSelect.value = ''
  /* WHERE THE ROLE SUMMARIES GO. Each choice carries a line about where that
     role sits in the tree, and a menu cannot show five of them at once. The
     line for the CHOSEN role appears here and changes with the choice, so the
     words are read at the moment they are useful and the rail keeps its
     height. */
  const roleSummary = doc.createElement('p')
  roleSummary.className = 'agent-compose-summary'
  roleSummary.setAttribute('data-compose-summary', 'role')
  roleSummary.setAttribute('hidden', 'hidden')
  /* NO PROBLEM LINE UNDER THIS FIELD. There was one, and it carried exactly one
     sentence -- "Pick a role first, then press Start." -- which the owner
     retired on 2026-08-19. An alert element that nothing can ever fill is not
     harmless: it is a slot the next lane finds and fills with something this
     flow never proofread, and it keeps a marked-invalid state alive for a
     control that can no longer be wrong. */
  /* THE HINT NOW COMES AFTER THE CONTROL, and the order is load-bearing rather
     than cosmetic: the reveal rules in the stylesheet are sibling combinators
     (`.cl:hover ~ .agent-compose-hint`, `select:focus-visible ~ ...`), which can
     only reach a LATER sibling. Nothing moves on screen -- a tipped hint is out
     of the flow entirely and is positioned under the whole field. */
  roleField.appendChild(roleLabelNode)
  roleField.appendChild(roleSelect)
  roleField.appendChild(roleHint)
  roleField.appendChild(roleSummary)
  body.appendChild(roleField)

  /* THE MODEL MENU. Unlike the role menu it arrives ANSWERED -- the engine has
     a default, so the default is preselected when that row is available and
     there is no placeholder row. Rows this computer cannot start stay visible
     with the refusal sentence supplied by the shell, but are not selectable. */
  const tierField = doc.createElement('div')
  tierField.className = 'agent-compose-field'
  const tierLabelNode = fieldLabel(doc, { forId: `${id}-tier`, words: START_PANEL.tierLabel, tipped: true })
  /* THE HELP GOES BEHIND HOVER; THE ROWS DO NOT. tierHelp says which row is a
     good default, which is true on every computer. What a given row CANNOT do
     -- "nobody is signed in to Codex on this computer", "Codex is not installed
     on this computer" -- is a fact about this machine and it is written on the
     row itself, in the menu, where it stays visible and unhidden. */
  const tierHint = fieldHint(doc, { id: `${id}-tier-hint`, words: START_PANEL.tierHelp, tipped: true })
  const tierSelect = doc.createElement('select')
  tierSelect.className = 'agent-compose-select'
  tierSelect.setAttribute('id', `${id}-tier`)
  tierSelect.setAttribute('data-compose-field', 'tier')
  tierSelect.setAttribute('aria-describedby', `${id}-tier-hint`)
  for (const choice of tiers) {
    const option = doc.createElement('option')
    /* Same split as the role menu: the id rides on the value, the label is the
       only part with a reader. */
    option.value = choice.id
    option.textContent = choice.label
    option.disabled = choice.enabled === false
    tierSelect.appendChild(option)
  }
  const defaultTier = tiers.find(choice => choice.id === DEFAULT_TIER)
  const selectedTier = defaultTier && defaultTier.enabled !== false
    ? defaultTier
    : (tiers.find(choice => choice.enabled !== false) || defaultTier || tiers[0])
  tierSelect.value = selectedTier?.id || ''
  tierField.appendChild(tierLabelNode)
  tierField.appendChild(tierSelect)
  tierField.appendChild(tierHint)

  /* EFFORT RIDES BESIDE THE TIER (owner, iteration 5: "I need to be able to
     choose effort levels when starting an agent … just like vscode"). The
     menu re-defaults to the tier's own effort whenever the tier changes, so
     an untouched row means the tier's judgment — a person only overrides it
     by choosing. */
  const effortField = doc.createElement('div')
  effortField.className = 'agent-compose-field'
  const effortLabelNode = fieldLabel(doc, { forId: `${id}-effort`, words: START_PANEL.effortLabel, tipped: true })
  const effortHint = fieldHint(doc, { id: `${id}-effort-hint`, words: START_PANEL.effortHelp, tipped: true })
  const effortSelect = doc.createElement('select')
  effortSelect.className = 'agent-compose-select'
  effortSelect.setAttribute('id', `${id}-effort`)
  effortSelect.setAttribute('data-compose-field', 'effort')
  effortSelect.setAttribute('aria-describedby', `${id}-effort-hint`)
  for (const choice of EFFORT_CHOICES) {
    const option = doc.createElement('option')
    option.value = choice.id
    /* The provider's name leads, its own sentence explains — and the line is
       composed in the copy module, which owns every word this panel shows. */
    option.textContent = effortOptionLabel(choice)
    effortSelect.appendChild(option)
  }
  const tierEffort = (tierId) => LAUNCH_TIERS.find(tier => tier.id === tierId)?.effort || 'medium'
  effortSelect.value = tierEffort(DEFAULT_TIER)
  tierSelect.addEventListener('change', () => { effortSelect.value = tierEffort(tierSelect.value) })
  effortField.appendChild(effortLabelNode)
  effortField.appendChild(effortSelect)
  effortField.appendChild(effortHint)

  /* THE FOLDER THIS TREE'S AGENTS WORK IN, ASKED AT THE MOMENT THE TREE STARTS.
   *
   * See START_PANEL.folderLabel in src/fleet-tree-copy.js for the owner's words
   * and why this is drawn for a NEW TREE ONLY. `newTree` is the same flag the
   * "This agent will work under ..." line already keys off, so there is one
   * answer in this panel to "is a tree being created", not two.
   *
   * NULL IS A REAL ANSWER AND IT IS THE FIRST ROW -- the same null
   * `submitCompose` has always sent. WHERE THAT NULL LANDS IS NOT THIS PANEL'S
   * TO GUESS: shell/main.cjs resolves it to the folder the person chose in
   * setup, and only falls back to the product's own workspace on a machine
   * where nobody was ever asked. So the caller hands in `defaultFolder` -- the
   * path that null resolves to on THIS computer, or empty when it resolves to
   * the product's workspace -- and the first row and the hint say which.
   * See START_PANEL.folderWorkspaceChosen for the two measurements. */
  let folderSelect = null
  let folderField = null
  let updateFolders = () => {}
  if (newTree) {
    folderField = doc.createElement('div')
    folderField.className = 'agent-compose-field'
    /* ONE ELEMENT, TWO KINDS OF SENTENCE, AND ONLY ONE OF THEM MAY HIDE.
     *
     * With named folders on this computer this line is folderHelp -- it
     * explains what the menu does and is true everywhere, so it goes behind
     * the label with the rest of the field help.
     *
     * With NO named folders it is folderNone or folderNoneChosen, and those
     * are facts read off this machine: that none exist, where a start with no
     * folder would actually land, and where to go and make one. That is an
     * honest empty state, and an honest empty state a person has to hover to
     * find is an empty state that is not being told. It stays on the page and
     * the label carries no mark, because there is nothing behind it. */
    const folderLabelNode = fieldLabel(doc, {
      forId: `${id}-folder`,
      words: START_PANEL.folderLabel,
      tipped: false,
    })
    const folderHint = fieldHint(doc, {
      id: `${id}-folder-hint`,
      words: '',
      tipped: false,
    })
    folderSelect = doc.createElement('select')
    folderSelect.className = 'agent-compose-select'
    folderSelect.setAttribute('id', `${id}-folder`)
    folderSelect.setAttribute('data-compose-field', 'profile')
    folderSelect.setAttribute('aria-describedby', `${id}-folder-hint`)
    folderLabelNode.addEventListener('click', () => {
      if (folderHint.hasAttribute('data-compose-tip')) toggleTipOpen(folderField)
    })
    // Replace only the options and their help. Refreshing a store reading must
    // preserve the draft, focus, and any submission already in flight.
    updateFolders = (nextFolders, selectedId) => {
      const tipped = nextFolders.length > 0
      folderLabelNode.textContent = START_PANEL.folderLabel
      if (tipped) {
        const mark = doc.createElement('span')
        mark.className = 'tip-mark'
        mark.setAttribute('aria-hidden', 'true')
        mark.textContent = START_PANEL.tipMark
        folderLabelNode.appendChild(mark)
      }
      folderHint.className = tipped ? 'agent-compose-hint tip-box' : 'agent-compose-hint'
      if (tipped) folderHint.setAttribute('data-compose-tip', 'hover')
      else folderHint.removeAttribute('data-compose-tip')
      folderHint.textContent = tipped ? START_PANEL.folderHelp
        : (defaultFolder ? START_PANEL.folderNoneChosen(defaultFolder) : START_PANEL.folderNone)
      folderSelect.textContent = ''
      const workspaceOption = doc.createElement('option')
      workspaceOption.value = ''
      workspaceOption.textContent = defaultFolder ? START_PANEL.folderWorkspaceChosen : START_PANEL.folderWorkspace
      folderSelect.appendChild(workspaceOption)
      for (const folder of nextFolders) {
        const option = doc.createElement('option')
        option.value = folder.id
        option.textContent = folder.name
        folderSelect.appendChild(option)
      }
      folderSelect.value = nextFolders.some(folder => folder.id === selectedId) ? selectedId : ''
    }
    updateFolders(folders, folderSelectedId)
    folderField.appendChild(folderLabelNode)
    folderField.appendChild(folderSelect)
    folderField.appendChild(folderHint)
  }

  let workspaceSelect = null
  let projectSelect = null
  let projectField = null
  let workspaceField = null
  let updateWorkspace = () => {}
  if (newTree) {
    workspaceField = doc.createElement('div')
    workspaceField.className = 'agent-compose-field'
    workspaceField.appendChild(fieldLabel(doc, { forId: `${id}-workspace-kind`, words: START_PANEL.workspaceLabel, tipped: false }))
    workspaceSelect = doc.createElement('select')
    workspaceSelect.className = 'agent-compose-select'
    workspaceSelect.id = `${id}-workspace-kind`
    workspaceSelect.setAttribute('data-compose-field', 'workspace-kind')
    for (const [value, label] of [['folder', START_PANEL.workspaceFolder], ['research', START_PANEL.workspaceResearch]]) {
      const option = doc.createElement('option')
      option.value = value
      option.textContent = label
      workspaceSelect.appendChild(option)
    }
    workspaceSelect.value = 'folder'
    workspaceField.appendChild(workspaceSelect)
    projectField = doc.createElement('div')
    projectField.className = 'agent-compose-field'
    projectField.setAttribute('data-compose-research', '')
    projectField.appendChild(fieldLabel(doc, { forId: `${id}-project`, words: START_PANEL.workspaceResearch, tipped: false }))
    projectSelect = doc.createElement('select')
    projectSelect.className = 'agent-compose-select'
    projectSelect.id = `${id}-project`
    projectSelect.setAttribute('data-compose-field', 'research-project')
    const placeholder = doc.createElement('option')
    placeholder.value = ''
    placeholder.textContent = START_PANEL.projectPrompt
    projectSelect.appendChild(placeholder)
    for (const project of researchProjects) {
      if (project.status === 'archived') continue
      const option = doc.createElement('option')
      option.value = project.projectId
      option.textContent = project.name
      projectSelect.appendChild(option)
    }
    projectSelect.value = ''
    projectField.appendChild(projectSelect)
    const hint = fieldHint(doc, { id: `${id}-project-hint`, tipped: false,
      words: researchUnavailableReason || (researchProjects.length
        ? START_PANEL.projectHelp
        : START_PANEL.projectEmpty) })
    projectSelect.setAttribute('aria-describedby', `${id}-project-hint`)
    projectField.appendChild(hint)
    updateWorkspace = () => {
      const research = workspaceSelect.value === 'research'
      folderField.hidden = research
      projectField.hidden = !research
    }
    workspaceSelect.addEventListener('change', updateWorkspace)
    updateWorkspace()
  }

  const messageField = doc.createElement('div')
  messageField.className = 'agent-compose-field'
  const messageLabel = fieldLabel(doc, { forId: `${id}-message`, words: START_PANEL.messageLabel, tipped: true })
  const messageHint = fieldHint(doc, { id: `${id}-message-hint`, words: START_PANEL.messageHelp, tipped: true })
  const messageInput = doc.createElement('textarea')
  messageInput.className = 'agent-compose-text'
  messageInput.setAttribute('id', `${id}-message`)
  messageInput.setAttribute('data-compose-field', 'message')
  messageInput.setAttribute('rows', '4')
  /* An example of a real job, not a label in disguise: the question is in the
     bound label above, which stays on screen once typing starts. */
  messageInput.setAttribute('placeholder', START_PANEL.messagePlaceholder)
  messageInput.setAttribute('aria-describedby', `${id}-message-hint ${id}-message-problem`)
  messageInput.value = ''
  const messageProblem = doc.createElement('p')
  messageProblem.className = 'agent-compose-problem'
  messageProblem.setAttribute('id', `${id}-message-problem`)
  messageProblem.setAttribute('data-compose-problem', 'message')
  messageProblem.setAttribute('role', 'alert')
  messageField.appendChild(messageLabel)
  messageField.appendChild(messageInput)
  messageField.appendChild(messageHint)
  /* THE REFUSAL IS NOT A TIP AND STAYS LAST IN THE FLOW, under the box it is
     about. It is the answer to a press this person just made. */
  messageField.appendChild(messageProblem)
  /* THE TWO ANSWERS FIRST. This file's own header calls the panel "two fields
     and two buttons": a role and a brief. The assistant and effort choices were
     added later and both carry two lines of help, which pushed the brief -- the
     one thing a person opens this panel to write -- off the bottom of the rail
     at first paint. Measured on installed 1.0.22: role visible, brief not.
     Nothing is removed by this order; the later choices keep their defaults and
     their words, and now sit under the question they qualify. */
  body.appendChild(messageField)
  /* THE FOLDER SITS UNDER THE BRIEF AND ABOVE THE ENGINE. The brief keeps the
     first position it was given for a measured reason (see the note above);
     among the qualifiers, WHERE the work happens outranks what it runs on. */
  if (workspaceField) body.appendChild(workspaceField)
  if (folderField) body.appendChild(folderField)
  if (projectField) body.appendChild(projectField)
  body.appendChild(tierField)
  body.appendChild(effortField)

  /* START DOES NOT SCROLL. IT IS THE POINT OF THE PANEL.
     Owner, twice, months apart: "I cant scroll down to even press start" and
     then "there is no way to start an agent". The first was answered by making
     the form scroll -- which fixed reachability and NOT visibility, because the
     button went into the scroller with everything else. Measured on the
     installed 1.0.21: the form wants about 765px, the rail gives 560-700, so
     the action row began roughly 100px BELOW the fold and the first thing a
     person saw was a form with no way to finish it. A control that exists but
     is off-screen at first paint is, to the person looking at it, absent.
     So Start lives OUTSIDE the scroller, as a sibling of it, exactly as the
     nav row above does: the form scrolls between them and both ends stay put.
     Keep it here -- moving it back into `body` re-creates the owner's defect
     without changing a single visible pixel in a unit test. */
  const actions = doc.createElement('div')
  actions.className = 'agent-compose-actions'
  /* TWO PRESSES, PERSON-CHOSEN (owner: "ITS SUPPOSED TO HAVE SET OR START AS
     OPTIONS"). One submit button used to be built here, its WORD flipped
     between "Set" and "Start" by whether the caller's tree had already begun
     -- so a person composing the first node of a fresh tree could only Set
     it, never Start it immediately, with nothing on the panel offering the
     other choice. Both buttons now reach the SAME caller contract
     (onSubmit(draft) with draft.mode telling it which was pressed); the
     caller already had two outcomes wired to this fact (see src/views/
     computers.js submitCompose, which has branched on `willStart` from the
     day this panel shipped) -- what was missing was ever letting the person
     pick, not the machinery underneath.
     `set` is built first and reads as the secondary action (ctl-btn, not
     -primary): saving a draft to start later is real work but it is not the
     press this panel exists for, per its own header ("collects a role and a
     brief and hands them to a callback" -- END TO END is Start's job). */
  const setBtn = doc.createElement('button')
  setBtn.className = 'ctl-btn agent-compose-set'
  setBtn.type = 'button'
  setBtn.setAttribute('type', 'button')
  setBtn.setAttribute('data-compose-action', 'set')
  setBtn.textContent = START_PANEL.submitSet
  /* Set never depends on whether the CHOSEN tier can start right now -- it
     only writes a draft, and a draft may honestly record a tier this
     computer cannot run yet (a sign-in still pending, say), for a later
     Start to find true or false on its own terms. */
  const startBtn = doc.createElement('button')
  startBtn.className = 'ctl-btn agent-compose-start agent-compose-submit'
  startBtn.type = 'button'
  startBtn.setAttribute('type', 'button')
  startBtn.setAttribute('data-compose-action', 'start')
  startBtn.textContent = START_PANEL.submitStart
  startBtn.disabled = selectedTier?.enabled === false
  /* Cancel is built with the nav row at the top of this function; only these
     two remain down here, full-width in the action row. */
  actions.appendChild(setBtn)
  actions.appendChild(startBtn)
  root.appendChild(actions)

  /* WHAT THE SESSION THIS BUTTON STARTS WOULD BE ALLOWED TO DO.
     UNDER Start and never above it. The comment on the action row above records
     Start being pushed below the fold as an owner-reported defect twice, and a
     block added ahead of the button moves the button down by exactly its own
     height. Under it, the button does not move at all -- and this is still
     outside the scroller, so it cannot be scrolled away from the control it
     qualifies. It is also where src/agent-session.js puts the same reading,
     under the OTHER Start button in this product, so the two agree by shape as
     well as by wording.
     THE WORDS ARE THE CALLER'S, from src/agent-confinement-copy.js. Empty until
     a caller has actually read this computer: an unanswered question renders
     nothing rather than something comfortable. */
  const confinement = doc.createElement('p')
  confinement.className = 'agent-compose-confinement'
  confinement.setAttribute('data-compose-confinement', 'panel')
  confinement.setAttribute('hidden', 'hidden')
  root.appendChild(confinement)

  /* Progress, not problems, and polite on purpose. The wait is the part people
     distrust: a start crosses a background service and a program that is not
     this one, and a button that goes quiet is where somebody presses it a
     second time. */
  /* The progress line rides WITH the button, outside the scroller, for the same
     reason the button does: it answers the press, and an answer a person has to
     scroll to find reads as no answer at all. */
  const status = doc.createElement('p')
  status.className = 'agent-compose-status'
  status.setAttribute('data-compose-status', 'panel')
  status.setAttribute('role', 'status')
  status.setAttribute('hidden', 'hidden')
  root.appendChild(status)

  /* folderSelect is null for a start under an existing agent -- every reader of
     it is written for that, so a missing folder menu is a state, not a fault. */
  return { root, roleSelect, tierSelect, effortSelect, folderSelect, workspaceSelect, projectSelect, updateWorkspace, updateFolders, messageInput, roleSummary, messageProblem, notice, unavailableAction, confinement, status, setBtn, startBtn, cancel }
}

/**
 * Put the compose panel on the page and hand back a handle.
 *
 * MOUNTING RENDERS IT AT ONCE, because the gesture that creates this panel is a
 * press on an empty node -- there is no state in which it exists and is not
 * wanted. A caller that would rather keep one panel for the whole page calls
 * `open()` again with the next node and `close()` when it is done.
 *
 * @param doc                the document. Passed in so the whole component runs
 *                           under `node --test` against a small fake.
 * @param container          the element to mount into. Required: a component
 *                           with nowhere to go builds nothing and says so by
 *                           returning null, rather than appending to the body of
 *                           whatever page happens to be loaded.
 * @param parent             the node that was pressed, `{ id, name }`, or null
 *                           when this begins a new tree. The id travels in the
 *                           draft and is never rendered -- an id in a sentence
 *                           is the defect tools/check-plain-language.mjs exists
 *                           to catch. The name is optional and is rendered only
 *                           inside START_PANEL.underNamed(); a node with no name
 *                           gets the sentence written for that case, never a
 *                           blank line.
 * @param roles              the assignable roles. Defaults to the product's own.
 * @param onSubmit           called with `{ role, tier, message, parentId }` when the
 *                           draft is complete. May return nothing, or
 *                           `{ ok: false, message }` to refuse, or a promise of
 *                           either. While a promise is in flight the panel is
 *                           busy and cannot be pressed again.
 * @param onCancel           called when the person discards the draft.
 * @param unavailableReason  a sentence from the caller saying why the whole
 *                           panel is unavailable. When set, both actions and
 *                           every field are switched off. This retains the
 *                           original option's behaviour for existing callers.
 * @param startUnavailableReason a sentence saying why Start alone is
 *                           unavailable. Set and the fields stay live so the
 *                           person can still record a draft.
 */
export function mountAgentComposePanel({
  doc = typeof document === 'undefined' ? null : document,
  container = null,
  parent = null,
  roles = ROLE_CHOICES,
  onSubmit = null,
  onCancel = null,
  onEscape = null,
  unavailableReason = '',
  startUnavailableReason = '',
  /* `{ label, run }`, or null. Drawn only beside a stated absence, and only
     when the caller can really undo that absence -- see the note on the button
     itself. `run` owns the write and answers `true` when the reason is gone. */
  unavailableAction = null,
  /* THE ENGINE ROWS, WHICH THIS FILE NO LONGER DECIDES. They arrive already
     labelled from src/fleet-tree-copy.js tierChoicesFor(), because only the
     shell knows which engines this payload can actually start and only the
     caller holds a bridge to ask it. A caller that does not pass them gets the
     module's own pessimistic default, which is what every surface got before
     this parameter existed. */
  tiers = TIER_CHOICES,
  /* THE NAMED FOLDERS THIS COMPUTER HAS, `[{ id, name }]`, read by the caller
     from the same main-process store the fleet rail reads. This panel does not
     ask for them and cannot make one: creating a named folder lives in exactly
     one place, and a second door onto it is a second thing to keep in step. */
  folders = [],
  /* Which row the menu opens on -- the folder this person used last. Pre-fill,
     not permission. */
  folderSelectedId = null,
  /* WHERE A START THAT NAMES NO FOLDER ACTUALLY RUNS ON THIS COMPUTER: the path
     the person chose in setup, or empty when this copy would fall back to the
     product's own workspace. Read by the caller from mcSetup.workspaceState(),
     for the same reason the engine rows and the confinement line are: only the
     shell knows, and this panel must not guess. Empty is the honest default --
     it is exactly what every machine did before the setup folder was honoured. */
  defaultFolder = '',
  researchProjects = [],
  researchUnavailableReason = '',
  /* WHAT A SESSION STARTED HERE WOULD BE ALLOWED TO DO, as one line the caller
     has already composed -- startControlLine() in src/agent-confinement-copy.js,
     from the reading mcAgent.confinement() gives it.
     ARRIVES THE SAME WAY THE REFUSAL SENTENCE DOES (header rule 4), and for the
     same reason: this panel does not know what the recorded permission level is
     and must not guess. Empty is the honest default for a caller that has not
     asked yet -- the line stays empty rather than reassuring. */
  confinementLine = '',
} = {}) {
  if (!doc || typeof doc.createElement !== 'function' || !container) return null

  const initialReason = asTrimmed(unavailableReason)
    || (typeof onSubmit === 'function' ? '' : START_REFUSAL.notWired)
  const submitControl = controlState({
    enabled: typeof onSubmit === 'function' && !initialReason,
    why: initialReason,
  })

  let current = {
    parent,
    roles,
    tiers: Array.isArray(tiers) && tiers.length > 0 ? tiers : TIER_CHOICES,
    folders: Array.isArray(folders) ? folders : [],
    folderSelectedId: asTrimmed(folderSelectedId) || null,
    defaultFolder: asTrimmed(defaultFolder),
    researchProjects: Array.isArray(researchProjects) ? researchProjects : [],
    researchUnavailableReason: asTrimmed(researchUnavailableReason),
    unavailableReason: submitControl.why,
    startUnavailableReason: asTrimmed(startUnavailableReason),
    unavailableAction: isRecord(unavailableAction) ? unavailableAction : null,
    confinementLine: asTrimmed(confinementLine),
  }
  let nodes = null
  let destroyed = false
  let busy = false
  /* WHETHER THIS PANEL IS ALREADY ON THE PAGE, kept beside `nodes` rather than
     read from it. render() takes the old root off before it builds the new one,
     so `nodes` is null half-way through EVERY re-render and cannot tell a panel
     that is opening apart from one the shell has just answered with a tier list.
     Only close() and destroy() clear this, because only those two really take
     the panel away. */
  let onPage = false
  /* Every handover gets a number, and a late answer that does not carry the
     current number is dropped. Without it, a caller that takes four seconds to
     start an agent can paint a refusal onto the panel the person has since
     re-opened over a DIFFERENT node -- a sentence about the wrong tree. */
  let attempt = 0

  const removeRoot = () => {
    if (nodes?.root?.parentNode) nodes.root.parentNode.removeChild(nodes.root)
    nodes = null
    busy = false
  }

  const setLine = (element, sentence, liveRole) => {
    if (!element) return
    const words = asTrimmed(sentence)
    element.textContent = words
    if (words) {
      element.removeAttribute?.('hidden')
      if (liveRole) element.setAttribute('role', liveRole)
    } else {
      element.setAttribute('hidden', 'hidden')
    }
  }

  const markInvalid = (field, invalid) => {
    if (!field) return
    if (invalid) field.setAttribute('aria-invalid', 'true')
    else field.removeAttribute?.('aria-invalid')
  }

  const clearProblems = () => {
    if (!nodes) return
    setLine(nodes.messageProblem, '')
    markInvalid(nodes.messageInput, false)
  }

  /* ONE FIELD CAN BE REFUSED, so this reads the map rather than assuming the
     shape: composeDraftProblems() still answers `{ field, sentence }` and a
     future refusal about another field would arrive the same way. What it does
     NOT do any more is paint the role, because that refusal was retired with
     the requirement (owner, 2026-08-19). */
  const paintProblems = (problems) => {
    if (!nodes) return
    const byField = new Map(problems.map(problem => [problem.field, problem.sentence]))
    setLine(nodes.messageProblem, byField.get('message') || '')
    markInvalid(nodes.messageInput, byField.has('message'))
    /* Focus goes to the field a person has to fix. A refusal a keyboard user
       has to go looking for is a refusal they will read as the button being
       broken. */
    if (byField.has('message')) nodes.messageInput.focus?.()
  }

  const paintRoleSummary = () => {
    if (!nodes) return
    const picked = asTrimmed(nodes.roleSelect.value)
    const choice = assignableRoles(current.roles).find(entry => entry.id === picked)
    setLine(nodes.roleSummary, choice?.summary || '')
  }

  const setBusy = (working) => {
    busy = working
    if (!nodes) return
    const stopped = current.unavailableReason ? true : working
    const startStopped = Boolean(current.startUnavailableReason) || stopped
    const tierRefused = current.tiers.find(choice => choice.id === nodes.tierSelect.value)?.enabled === false
    /* Set never carries the tier refusal -- see the note where these buttons
       are built. Start does, because Start is the press that actually needs
       this computer to run that tier right now. */
    nodes.setBtn.disabled = stopped
    nodes.startBtn.disabled = startStopped || tierRefused
    nodes.roleSelect.disabled = stopped
    nodes.tierSelect.disabled = stopped
    nodes.effortSelect.disabled = stopped
    /* Null for a start under an existing agent -- there is no folder menu on
       that panel, and switching off a control that is not there is not an
       error worth throwing over. */
    if (nodes.folderSelect) nodes.folderSelect.disabled = stopped
    if (nodes.workspaceSelect) nodes.workspaceSelect.disabled = stopped
    if (nodes.projectSelect) nodes.projectSelect.disabled = stopped || Boolean(current.researchUnavailableReason)
    nodes.messageInput.disabled = stopped
    /* Cancel goes dead ONLY while a handover is in flight. The caller is part
       way through starting something; a cancel here would discard the draft
       while the work it describes carries on, and the person would be told the
       opposite of what happened. */
    nodes.cancel.disabled = working
    /* Named by role, so the wait says what is being started rather than only
       that something is. */
    setLine(nodes.status, working ? startingLine(asTrimmed(nodes.roleSelect.value)) : '')
  }

  const currentDraft = (mode) => ({
    /* WHICH PRESS THIS WAS, 'set' or 'start' -- the one new fact the caller
       needs to answer "ITS SUPPOSED TO HAVE SET OR START AS OPTIONS" without
       this panel deciding anything on its own behalf. Every other field below
       is unchanged. THE CALLER SIDE OF THIS IS NOT YET WIRED: src/views/
       computers.js's submitCompose still computes its own willStart from
       treeHasStarted() and does not read draft.mode -- that change lands
       separately, after this panel change, on B4's routing-law lane. Until
       then this field rides along unread, and existing behaviour (whichever
       outcome treeHasStarted() picks) is unchanged by this panel alone. */
    mode,
    /* RESOLVED AGAINST THE MENU, never taken raw. Empty is a real answer -- the
       person left the first row alone -- and anything the menu does not offer
       resolves to that same empty rather than travelling into the store. See
       composeDraftRole(). */
    role: composeDraftRole(nodes?.roleSelect?.value, current.roles),
    /* Always a real row: the menu preselects DEFAULT_TIER and has no empty
       first row. The fallback below is for a hand-broken DOM only, and it
       falls back to the same default the engine would apply, never to
       nothing. */
    tier: asTrimmed(nodes?.tierSelect?.value) || DEFAULT_TIER,
    /* The effort key rides beside the tier; an untouched menu carries the
       tier's own default, so this is never an invented fifth value. */
    effort: asTrimmed(nodes?.effortSelect?.value) || null,
    message: asText(nodes?.messageInput?.value).trim(),
    parentId: isRecord(current.parent) ? asTrimmed(current.parent.id) || null : null,
    /* THE FOLDER THE NEW TREE WORKS IN. Null when a tree is not being started
       (there is no menu), and null when the person left the first row alone --
       the same null that has always meant the product's own workspace, so a
       caller that ignores this key behaves exactly as it did before. */
    profileId: nodes?.workspaceSelect?.value === 'research' ? null : asTrimmed(nodes?.folderSelect?.value) || null,
    ...(nodes?.workspaceSelect?.value === 'research' ? {
      workspaceKind: 'research',
      researchProjectId: asTrimmed(nodes?.projectSelect?.value) || null,
      researchProjectName: current.researchProjects.find(project => project.projectId === nodes?.projectSelect?.value)?.name || '',
    } : {}),
  })

  const showNotice = (sentence, liveRole) => {
    if (!nodes) return
    nodes.notice.removeAttribute?.('data-compose-error-code')
    setLine(nodes.notice, sentence, liveRole)
  }

  const showCouldNotTell = () => {
    if (!nodes) return
    setLine(nodes.notice, COMPOSE_ACTION_COULD_NOT_TELL_SENTENCE, 'alert')
    nodes.notice.setAttribute('data-compose-error-code', COMPOSE_ACTION_COULD_NOT_TELL)
  }

  const activeUnavailableReason = () => current.unavailableReason || current.startUnavailableReason

  const replaceActiveUnavailableReason = (reason) => {
    if (current.unavailableReason) return { ...current, unavailableReason: reason, unavailableAction: null }
    return { ...current, startUnavailableReason: reason, unavailableAction: null }
  }

  /* Draw the way out, or draw nothing. Re-read from `current` on every render
     so a panel reopened after the switch was thrown does not keep a stale
     button beside a reason that no longer applies. */
  function paintUnavailableAction() {
    if (!nodes) return
    const action = current.unavailableAction
    const label = isRecord(action) ? asTrimmed(action.label) : ''
    if (!activeUnavailableReason() || !label || typeof action.run !== 'function') {
      nodes.unavailableAction.setAttribute('hidden', 'hidden')
      nodes.unavailableAction.textContent = ''
      return
    }
    nodes.unavailableAction.textContent = label
    nodes.unavailableAction.disabled = false
    nodes.unavailableAction.removeAttribute('hidden')
  }

  /* THE PRESS, AND WHAT IT IS ALLOWED TO CONCLUDE.
   *
   * The caller's `run` owns the write and answers whether the reason is gone.
   * Only a truthy answer reopens the panel working -- a run that refuses, or
   * throws, leaves the panel exactly as it was with its sentence still on it,
   * because a control that clears a refusal it did not actually clear is how a
   * person comes to press Start into a wall.
   *
   * The panel is REOPENED rather than navigated away from: the person pressed a
   * switch and the control they were told about appears where the switch was.
   * That is the property the owner asked for -- no restart, no second journey. */
  async function runUnavailableAction() {
    if (!nodes || destroyed) return
    const action = current.unavailableAction
    if (!isRecord(action) || typeof action.run !== 'function') return
    nodes.unavailableAction.disabled = true
    let outcome
    try {
      outcome = await action.run()
    } catch {
      /* EMFILE, EAGAIN, EIO, EBUSY and unstructured throws all mean the same
         thing here: the action could not answer. They are not collapsed into
         `false`, which is reserved for a completed read-back proving that the
         change did not take. This result is painted only; it never enters
         `current`, so another press retries rather than latching the failure. */
      if (destroyed || !nodes) return
      showCouldNotTell()
      nodes.unavailableAction.disabled = false
      return
    }
    if (destroyed || !nodes) return
    /* A STRING IS A DIFFERENT REASON, NOT A FAILURE. The caller may know that
       the absence it just cleared was hiding a second one -- a switch turned on
       inside a browser with no application behind it is the measured case -- so
       it may answer with the reason that now applies. Showing the OLD sentence
       there would tell a person the switch did not work; showing none would
       hand them a live Start over a page that cannot start anything. */
    if (typeof outcome === 'string' && outcome.trim().length > 0) {
      current = replaceActiveUnavailableReason(outcome.trim())
      render()
      return
    }
    if (outcome !== true) {
      nodes.unavailableAction.disabled = false
      return
    }
    current = replaceActiveUnavailableReason('')
    render()
  }

  const settle = (outcome, token) => {
    if (destroyed || !nodes || token !== attempt) return
    setBusy(false)
    if (isRecord(outcome) && outcome.ok === false) {
      /* The caller's own sentence, because the caller is the only one who knows
         what went wrong -- startRefusalSentence() turns a refusal of any shape
         into one. A refusal that arrives with no words gets the flow's own
         sentence for a start that failed and said nothing. */
      showNotice(asTrimmed(outcome.message) || START_REFUSAL.noReasonGiven, 'alert')
      return
    }
    close()
  }

  function attemptSubmit(mode) {
    if (!nodes || busy || destroyed) return
    if (current.unavailableReason) {
      showNotice(current.unavailableReason, 'alert')
      return
    }
    if (mode === 'start' && current.startUnavailableReason) {
      showNotice(current.startUnavailableReason, 'alert')
      return
    }
    /* THE TIER REFUSAL ONLY STOPS A START. Setting a draft against a tier this
       computer cannot run yet is an honest record of what was asked for --
       the same reason setBtn's own disabled state (above) never carries this
       refusal either. A Start attempted against the same tier still has to
       stop here, unchanged from before this panel had two buttons. */
    const tierChoice = current.tiers.find(choice => choice.id === nodes.tierSelect.value)
    if (mode === 'start' && tierChoice?.enabled === false) {
      showNotice(tierChoice.label, 'alert')
      return
    }
    const draft = currentDraft(mode)
    if (draft.workspaceKind === 'research' && (!draft.researchProjectId || current.researchUnavailableReason)) {
      showNotice(current.researchUnavailableReason || START_PANEL.projectRequired, 'alert')
      nodes.projectSelect?.focus?.()
      return
    }
    /* The draft is already resolved against the menu by currentDraft(), so the
       role list is no longer part of deciding whether this press may go. */
    const problems = composeDraftProblems(draft)
    clearProblems()
    showNotice(mode === 'set' ? current.startUnavailableReason : '')
    if (problems.length > 0) {
      paintProblems(problems)
      return
    }
    if (typeof onSubmit !== 'function') {
      /* Nothing to hand the work to: a fault in this copy of the app, not
         something the person did. Its own sentence rather than the one for a
         start that failed -- that one says "try once more", and pressing again
         here can never work. */
      showNotice(START_REFUSAL.notWired, 'alert')
      return
    }
    const token = attempt += 1
    let outcome
    try {
      outcome = onSubmit(draft)
    } catch (error) {
      /* Deliberately NOT error.message. See point 4 in the header. */
      showNotice(START_REFUSAL.noReasonGiven, 'alert')
      return
    }
    if (!outcome || typeof outcome.then !== 'function') {
      settle(outcome, token)
      return
    }
    setBusy(true)
    outcome.then(
      value => settle(value, token),
      () => {
        if (destroyed || !nodes || token !== attempt) return
        setBusy(false)
        showNotice(START_REFUSAL.noReasonGiven, 'alert')
      },
    )
  }

  function cancel() {
    if (!nodes || busy || destroyed) return
    close()
    if (typeof onCancel === 'function') onCancel()
  }

  function close() {
    onPage = false
    removeRoot()
  }

  function render({ preserveDraft = Boolean(nodes) } = {}) {
    if (destroyed) return null
    /* IS THIS PANEL OPENING, or is it the same open panel being painted again?
       Read HERE, before removeRoot() below makes the two states identical. */
    const opening = !onPage
    // Readiness replies repaint this same form while a person types or starts
    // an agent. Keep its draft and in-flight attempt; a new parent resets both.
    const fields = ['roleSelect', 'tierSelect', 'effortSelect', 'folderSelect', 'workspaceSelect', 'projectSelect', 'messageInput']
    const saved = preserveDraft && nodes ? Object.fromEntries(fields
      .filter(key => nodes[key]).map(key => [key, nodes[key].value])) : null
    const focused = saved ? fields.find(key => nodes[key] === doc.activeElement) : null
    const selection = focused === 'messageInput'
      ? [nodes.messageInput.selectionStart, nodes.messageInput.selectionEnd, nodes.messageInput.selectionDirection]
      : null
    const wasBusy = preserveDraft && busy
    if (!preserveDraft) attempt += 1
    removeRoot()
    /* THE THREE CASES, AND EACH ONE IS A DIFFERENT FACT. An empty tree has
       nothing to go under and gets the suggestion instead. A node with a name
       is named, inside the copy module's sentence. A node this app cannot name
       gets the sentence written for exactly that -- never a blank line, and
       never its id. */
    const parentName = isRecord(current.parent)
      ? asTrimmed(current.parent.name) || asTrimmed(current.parent.label)
      : ''
    let underLine = ''
    if (isRecord(current.parent)) {
      underLine = parentName ? START_PANEL.underNamed(parentName) : START_PANEL.underUnnamed
      if (current.parent.researchProjectName) underLine += ` ${START_PANEL.projectInherited(current.parent.researchProjectName)}`
    }

    nodes = buildPanel(doc, {
      choices: assignableRoles(current.roles),
      newTree: !isRecord(current.parent),
      underLine,
      tiers: current.tiers,
      folders: current.folders,
      folderSelectedId: current.folderSelectedId,
      defaultFolder: current.defaultFolder,
      researchProjects: current.researchProjects,
      researchUnavailableReason: current.researchUnavailableReason,
    })
    if (saved) {
      for (const [key, value] of Object.entries(saved)) {
        const field = nodes[key]
        if (field && (key === 'messageInput' || [...field.children].some(option => option.value === value))) {
          field.value = value
        }
      }
    }

    nodes.updateWorkspace()
    nodes.setBtn.addEventListener('click', () => attemptSubmit('set'))
    nodes.startBtn.addEventListener('click', () => attemptSubmit('start'))
    nodes.cancel.addEventListener('click', () => cancel())
    /* Escape from anywhere inside the panel. The listener sits on the root and
       reads the event that bubbles to it, so it never touches the document and
       cannot swallow a key press meant for the page behind it. */
    const escapeRoot = nodes.root
    escapeRoot.addEventListener('keydown', (event) => {
      if (event?.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      // A nested chooser consumes Escape without discarding its surrounding form.
      if (['select', '[role="combobox"]', '[role="listbox"]', '[role="menu"]'].some(selector => event.target?.closest?.(selector))) {
        event.preventDefault?.()
        return
      }
      event.preventDefault?.()
      // A replaced or removed form's listener must not act for the current one.
      if (!nodes || destroyed || busy || !onPage || nodes.root !== escapeRoot) return
      // Home captures the still-live form while returning to overview. cancel()
      // removes controls before onCancel, so that path cannot retain a draft.
      if (typeof onEscape === 'function') onEscape()
      else cancel()
    })
    /* Choosing a role only changes the line under the menu now. It must NOT
       clear the refusal about the brief: answering a different question is not
       answering that one, and wiping the sentence would leave a person who
       pressed Start with nothing on screen explaining why nothing happened. */
    nodes.roleSelect.addEventListener('change', () => { paintRoleSummary() })
    nodes.tierSelect.addEventListener('change', () => {
      const choice = current.tiers.find(entry => entry.id === nodes.tierSelect.value)
      /* Start only -- see the note where these buttons are built and in
         setBusy(): a tier this computer cannot run yet blocks launching it,
         never recording it. */
      nodes.startBtn.disabled = busy || Boolean(current.unavailableReason) || Boolean(current.startUnavailableReason) || choice?.enabled === false
    })
    /* A refusal about a field stops being true the moment the person edits that
       field. Leaving it on screen teaches people to ignore the red line. */
    nodes.messageInput.addEventListener('input', () => {
      setLine(nodes.messageProblem, '')
      markInvalid(nodes.messageInput, false)
    })
    /* A PICTURE PASTED INTO THE BRIEF WAS DROPPED WITHOUT A WORD, and an agent
       started on "fix what this screenshot shows" never got the screenshot
       (T1511). The brief is text only, so the paste is claimed and the line
       under the brief says where a picture can go. Text pastes as before. */
    nodes.messageInput.addEventListener('paste', (event) => {
      if (!pastedImageFromClipboard(event?.clipboardData)) return
      event.preventDefault?.()
      setLine(nodes.messageProblem, START_PANEL.pictureInBrief)
    })
    nodes.unavailableAction.addEventListener('click', () => { void runUnavailableAction() })

    container.appendChild(nodes.root)
    onPage = true

    /* Not marked as a live region. It is a standing fact about this computer,
       rendered with the panel; an assertive role here would make a screen
       reader interrupt whatever the person was reading every time the panel is
       re-opened. */
    setLine(nodes.confinement, current.confinementLine)

    const unavailable = activeUnavailableReason()
    if (unavailable) showNotice(unavailable, 'status')
    setBusy(wasBusy)
    paintUnavailableAction()
    paintRoleSummary()
    if (focused && nodes[focused] && !nodes[focused].disabled) {
      nodes[focused].focus?.({ preventScroll: true })
      if (selection && Number.isInteger(selection[0]) && Number.isInteger(selection[1])) {
        nodes.messageInput.setSelectionRange?.(...selection)
      }
    }
    if (opening) revealOnOpen(nodes.root)
    return nodes.root
  }

  /* AND IF IT OPENED BELOW THE FOLD, BRING IT INTO VIEW -- ONCE.
   *
   * On a phone the computers page stacks: the tree canvas on top, the rail
   * under it, and the PAGE is what scrolls (see the narrow-width block in
   * src/agent-compose-panel.css). A press on an empty node therefore opens this
   * panel several hundred pixels down a page nobody has scrolled, and without
   * this the person presses a node and nothing they can see changes.
   *
   * ONLY ON A CLOSED -> OPEN TRANSITION. `open()` is called again every time the
   * shell answers a question this panel asked -- the startable engines, the
   * folder list, the line about what the session may do -- and each of those
   * re-renders the whole form. An unconditional scroll would yank the page out
   * from under somebody half-way through reading it.
   *
   * `block: 'nearest'` IS THE SECOND GUARD, and it is the browser's own: it does
   * nothing at all when the element is already fully visible, which is every
   * ordinary desktop window, and otherwise moves the least it can.
   *
   * ON A MICROTASK, because the caller mounts this panel and only THEN puts its
   * page on screen -- src/views/computers.js calls activateRail() after
   * mountAgentComposePanel() returns. Scrolling during the render would measure
   * a page that is still hidden and still absolutely positioned, which is not
   * the box the person ends up looking at. By the time the microtask runs, the
   * caller's whole open is finished and scrollIntoView measures the real one.
   *
   * Optional-called throughout: a document that is not a browser has no such
   * method, and this panel is proven under `node --test`.
   */
  function revealOnOpen(target) {
    if (!target) return
    void Promise.resolve().then(() => {
      /* Closed, destroyed or re-rendered in the meantime: the box this was
         about is gone, and scrolling to whatever replaced it is not what the
         person asked for. */
      if (destroyed || nodes?.root !== target || !target.parentNode) return
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    })
  }

  render()

  return {
    element: () => nodes?.root || null,
    isOpen: () => Boolean(nodes),
    /** Refresh the canonical folder choices without reopening the draft. */
    updateFolders(folders) {
      if (destroyed || !Array.isArray(folders)) return
      current.folders = folders
      const selectedId = nodes?.folderSelect?.value ?? current.folderSelectedId
      current.folderSelectedId = folders.some(folder => folder.id === selectedId) ? selectedId : null
      nodes?.updateFolders(folders, current.folderSelectedId)
    },
    /** Point the panel at another node. The previous draft is discarded. */
    open(next = {}) {
      if (destroyed) return null
      current = {
        parent: 'parent' in next ? next.parent : current.parent,
        roles: 'roles' in next ? next.roles : current.roles,
        tiers: 'tiers' in next && Array.isArray(next.tiers) && next.tiers.length > 0 ? next.tiers : current.tiers,
        /* CARRIED FORWARD WHEN NOT RESTATED. readStartableTiers() re-opens an
           already-open panel with `{ tiers }` alone the moment the shell
           answers; a merge that reset these would empty the folder menu out
           from under someone reading it. */
        folders: 'folders' in next && Array.isArray(next.folders) ? next.folders : current.folders,
        folderSelectedId: 'folderSelectedId' in next ? asTrimmed(next.folderSelectedId) || null : current.folderSelectedId,
        /* CARRIED FORWARD WHEN NOT RESTATED, for the same reason the folders and
           the confinement line are: the ordinary re-open is `{ parent }` alone,
           and losing this reading would put the panel back to describing a
           folder the start will not use. */
        defaultFolder: 'defaultFolder' in next ? asTrimmed(next.defaultFolder) : current.defaultFolder,
        researchProjects: 'researchProjects' in next && Array.isArray(next.researchProjects) ? next.researchProjects : current.researchProjects,
        researchUnavailableReason: 'researchUnavailableReason' in next ? asTrimmed(next.researchUnavailableReason) : current.researchUnavailableReason,
        unavailableReason: 'unavailableReason' in next ? asTrimmed(next.unavailableReason) : current.unavailableReason,
        startUnavailableReason: 'startUnavailableReason' in next
          ? asTrimmed(next.startUnavailableReason)
          : current.startUnavailableReason,
        unavailableAction: 'unavailableAction' in next
          ? (isRecord(next.unavailableAction) ? next.unavailableAction : null)
          : current.unavailableAction,
        /* CARRIED FORWARD WHEN NOT RESTATED, for the same reason the folders
           are: a caller that re-opens this panel with `{ parent }` alone -- the
           ordinary case, pressing a different empty node -- must not lose the
           reading of this computer and start describing nothing. */
        confinementLine: 'confinementLine' in next ? asTrimmed(next.confinementLine) : current.confinementLine,
      }
      return render({ preserveDraft: Boolean(nodes) && !('parent' in next) })
    },
    /** Take it off the page and discard the draft. No callback: closing is not cancelling. */
    close,
    /** The draft as it stands, in the shape the callback receives. */
    draft: () => (nodes ? currentDraft() : null),
    /** Move focus to the first field, for a caller that opens this from a key
     * press. When the form ships switched off the role select is disabled and
     * a real browser refuses to focus it -- focus would stay OUTSIDE the panel
     * and Escape would be dead exactly there, so the root takes it instead. */
    focus: () => {
      if (!nodes) return
      const target = nodes.roleSelect && !nodes.roleSelect.disabled ? nodes.roleSelect : nodes.root
      target?.focus?.()
    },
    /** Make the panel the keyboard context without putting the caret in a
     * field -- for a pointer open. Escape must cancel however the panel was
     * opened, and it can only be heard from inside. */
    focusRoot: () => { nodes?.root?.focus?.() },
    /**
     * Show the caller's own refusal sentence on the panel.
     *
     * For a caller that reports a failure LATER -- after the panel has already
     * been told the handover was accepted. Produce the sentence with
     * startRefusalSentence() in src/fleet-tree-copy.js; this file will not
     * invent one, and it will not print a code.
     */
    showProblem: (sentence) => {
      if (!nodes) return
      /* This ends the handover it is reporting on. Without the bump, a caller
         that says "this failed" and then lets its own promise resolve happily
         would close the panel out from under the sentence it just showed --
         the person reads a failure and watches the form vanish. */
      attempt += 1
      setBusy(false)
      showNotice(asTrimmed(sentence) || START_REFUSAL.noReasonGiven, 'alert')
    },
    destroy: () => {
      destroyed = true
      onPage = false
      removeRoot()
    },
  }
}
