/* EVERY WORD OF THE START-AN-AGENT-FROM-THE-TREE FLOW, IN ONE PLACE.
 *
 * THE FLOW THESE WORDS BELONG TO. A fresh computer draws an EMPTY tree. The
 * graph draws empty nodes a person can press. Pressing one opens a panel on the
 * right where they choose a role and say what they want done. Submitting starts
 * a real agent. A computer may hold more than one tree.
 *
 * WHY THE WORDS ARE A MODULE AND NOT SIX FILES' WORTH OF TEMPLATE LITERALS.
 * Six surfaces render one flow: the computers view, the graph, the layout, the
 * tree list, the panel and the declared-fleet adapter. Copy written inline in
 * six places becomes six voices inside a week, and the empty state -- the one
 * screen every new customer sees -- is where a second voice costs the most.
 * src/first-run-needs.js and src/agent-availability-copy.js already work this
 * way for their own screens, and this is the same rule for this flow.
 *
 * THE OWNER'S STANDING COMPLAINT IS THE SPEC: "the wording is dense and not
 * easy to consume or friendly for users." A person decides inside ten minutes
 * whether to trust a program that can reach their files, their mail and their
 * machine, and they decide it from the words. So: short sentences, plain words,
 * one idea per line, and no failure sentence that ends without something to do.
 * tools/check-plain-language.mjs holds every string here to that.
 *
 * FIVE RULES THIS MODULE KEEPS, AND TWO OF THEM ARE KEPT MECHANICALLY.
 *
 *   1. A KEY IS NEVER PUT IN FRONT OF A PERSON. Role keys (`coordinator`,
 *      `shadow`) are join keys in src/vocab.js and mean nothing outside this
 *      repository. roleLabel() is the ONLY way to name a role in this flow, it
 *      reads src/vocab.js ROLES for the label, and a key it does not recognise
 *      comes back as the plain word "Agent" -- never as the key itself. A
 *      caller that interpolates a role key directly is the defect this function
 *      exists to make unnecessary.
 *   2. A REFUSAL NEVER ARRIVES AS A CODE. startRefusalSentence() takes the
 *      whole refusal and returns a sentence. It has no parameter that would let
 *      a caller ask for the identifier, for the same reason
 *      src/refusal-copy.js's refusalSentence() has none.
 *   3. EVERY FAILURE SENTENCE ENDS WITH SOMETHING TO DO. "Every seat is busy"
 *      is a capacity answer and is worded as one -- wait, or stop one -- and
 *      never as "your setup is wrong", because sending somebody to repair a
 *      queue that would have cleared on its own costs them an afternoon.
 *   4. NOTHING HERE CLAIMS THE PRODUCT DOES AN OPERATING-SYSTEM JOB FOR
 *      SOMEBODY. It cannot install Codex and it does not offer to. It says
 *      which window to open and which line to type, and the commands are
 *      imported from src/agent-availability-copy.js rather than retyped,
 *      because the copy that goes stale is always the one nobody is looking at.
 *   5. ONE VOICE. Where this product already has a sentence for a refusal, this
 *      module defers to it instead of writing a second one. The four refusals
 *      below are written here because this panel is a different place to be
 *      standing: the tree is on screen, so "stop one from the tree" is the true
 *      instruction where the shared table has to say "the fleet page".
 *
 * IT TOUCHES NO DOM AND BUILDS NO MARKUP, so a plain `node --test` process can
 * import it and assert on the sentence a state produces. That is the property
 * src/refusal-copy.js and src/agent-availability-copy.js keep for the same
 * reason: a copy test written against source text passes when the table is
 * right and the lookup is wrong.
 */

import { CODEX_SETUP_COMMANDS, UNAVAILABLE_TEXT, unavailableReason } from './agent-availability-copy.js'
import { NODE_REMOVE_REFUSALS, NODE_STATUS_UNREADABLE } from './fleet-trees.js'
import { GENERIC_REMEDY, isBareIdentifier, refusalCodeOf, refusalRemedy, refusalSentence } from './refusal-copy.js'
import { LAUNCH_TIERS } from './orchestration-controls.js'
import { ROLES } from './vocab.js'

/* ---------------------------------------------------------------
   Roles, by label and never by key.
   --------------------------------------------------------------- */

/* WHAT A PERSON IS CALLED WHEN THIS COPY DOES NOT RECOGNISE THEIR ROLE.
   A tree drawn from a saved organisation can carry a role this build has no
   entry for -- an organisation file written by a newer copy, or one hand-edited
   on this computer. The old shape of that bug is to fall back to `String(role)`
   and print the key. "Agent" is true of every one of them and is a word a
   person already has. */
export const UNKNOWN_ROLE_LABEL = 'Agent'

/** The label for a role, for anywhere a person will read it. Never the key. */
export function roleLabel(role) {
  const key = typeof role === 'string'
    ? role.trim()
    : (role && typeof role === 'object' && typeof (role.id || role.role) === 'string'
        ? String(role.id || role.role).trim()
        : '')
  /* An authoritative custom role has no entry in the shipped UI vocabulary,
     but mcOrg.read() supplies its person-facing name. Accepting that label as
     part of the display value lets every custom role read by name without
     turning arbitrary stored ids into copy. */
  const supplied = role && typeof role === 'object' && typeof (role.label || role.name) === 'string'
    ? String(role.label || role.name).trim()
    : ''
  const entry = key && Object.prototype.hasOwnProperty.call(ROLES, key) ? ROLES[key] : null
  const label = entry && typeof entry.label === 'string' ? entry.label.trim() : ''
  return supplied || label || UNKNOWN_ROLE_LABEL
}

/** Is this a role this copy has words for? Used to drop a clause rather than
    print a vague one -- "It will take the Agent role" says nothing. */
export function isKnownRole(role) {
  if (role && typeof role === 'object' && typeof (role.label || role.name) === 'string') {
    return Boolean(String(role.label || role.name).trim())
  }
  const key = typeof role === 'string' ? role.trim() : ''
  return Boolean(key) && Object.prototype.hasOwnProperty.call(ROLES, key)
}

/* THE ROLES A PERSON MAY PICK, AND THE ONE THEY MAY NOT.
 *
 * `spawned` is deliberately absent. Its label is "Agent spawned", and that is
 * what an agent BECOMES when another agent starts it -- it is a fact about how
 * something came to exist, not a job anybody hands out. Offering it in a picker
 * would invite a person to choose a state instead of a role. roleLabel() still
 * answers for it, because the graph has to draw those agents.
 *
 * EACH LINE DESCRIBES WHERE THE ROLE SITS IN YOUR TREE, not a guarantee about
 * what the agent will do. What a role is actually ALLOWED to do is set by the
 * organisation declared on this computer (src/org-controls.js shows those rules
 * beside each role), and a picker that promised behaviour this module cannot
 * enforce would be writing a cheque the product does not sign.
 *
 * The label is read from src/vocab.js at load, so a profile that renames a role
 * renames it here too and this file cannot drift from the graph's legend. */
export const ROLE_CHOICES = Object.freeze([
  Object.freeze({ role: 'coordinator', label: roleLabel('coordinator'), summary: 'Sits at the top of the tree and decides what happens next.' }),
  Object.freeze({ role: 'helper', label: roleLabel('helper'), summary: 'Works beside the coordinator and takes work off it.' }),
  Object.freeze({ role: 'shadow', label: roleLabel('shadow'), summary: 'Keeps watch on the work and speaks up when something looks off.' }),
  Object.freeze({ role: 'manager', label: roleLabel('manager'), summary: 'Looks after one branch of the tree and the agents under it.' }),
  Object.freeze({ role: 'default', label: roleLabel('default'), summary: 'Just does the job you describe. Pick this one if you are not sure.' }),
])

/* Offered when the tree is empty, because the first agent on an empty tree is
   the one everything else hangs under. It is a suggestion about SHAPE, which is
   a thing this product really does draw, and not advice about what will run. */
export const FIRST_ROLE_SUGGESTION = Object.freeze({
  role: 'coordinator',
  line: 'A coordinator sits at the top of a tree, so it is an easy first choice.',
})

/* THE SUGGESTION NAMES A ROLE THE MENU REALLY HAS (T1437). On a computer with
   a Role library the menu lists that library, whose top-of-tree role is the
   one marked orgRoot (Controller today) -- the same capability rootSeatFor()
   in src/views/computers.js reads. The shipped list above is only the browser
   preview's fallback, where the coordinator is the top. A menu with neither
   gets no suggestion rather than advice about a role it does not offer. */
export function firstRoleSuggestionLine(choices = []) {
  const list = Array.isArray(choices) ? choices.filter(Boolean) : []
  const keyOf = choice => String(choice.id || choice.role || '').trim()
  const fromLibrary = list.some(choice => typeof choice.orgRoot === 'boolean')
  const root = fromLibrary
    ? list.find(choice => choice.orgRoot === true)
    : list.find(choice => keyOf(choice) === FIRST_ROLE_SUGGESTION.role)
  if (!root) return ''
  if (!fromLibrary) return FIRST_ROLE_SUGGESTION.line
  const label = String(root.label || roleLabel(keyOf(root))).trim()
  return label ? `A ${label} sits at the top of a tree, so it is an easy first choice.` : ''
}

/* ---------------------------------------------------------------
   The empty tree, and the empty node inside it.
   --------------------------------------------------------------- */

/* THE EMPTY STATE IS THE SHIPPING STATE. Every fresh computer opens here, so
   these three lines are the first thing most people ever read on this page.
   They say what the screen is FOR before they say that it is empty, and they
   say that empty is normal -- a new customer's first question is whether they
   have broken something. */
export const EMPTY_TREE = Object.freeze({
  title: 'Nothing has run on the computer you are driving yet',
  body: 'This is where your agents appear once you start one. An empty tree is normal on a new computer.',
  hint: 'Press any empty spot in the tree to start your first agent.',
})

/* THE WORDS ON THE NODE ITSELF, which have room for about three of them. The
   node is a control, so it says what pressing it does. */
export const EMPTY_NODE = Object.freeze({
  label: 'Empty spot',
  hint: 'Press to start an agent here',
  /* For screen readers, where the label and the hint arrive as one name. */
  ariaLabel: 'Empty spot. Press to start an agent here.',
})

/* ---------------------------------------------------------------
   The panel on the right.
   --------------------------------------------------------------- */

/* ONE QUESTION AND A BUTTON, AND THE INTRO SAYS SO. A person looking at a new
   panel is deciding whether this is a form they can finish; telling them how
   short it is answers that before they start reading the labels.
   The field labels are questions rather than nouns. "Role" and "Message" are
   what the fields are called in the code; "What kind of agent is this?" is what
   a person is actually being asked.

   IT SAID "TWO ANSWERS AND IT RUNS" UNTIL THE ROLE STOPPED BEING REQUIRED.
   Owner, 2026-08-19: "users shouldnt be forced to choose a role". Exactly one
   question on this panel has no answer until a person gives one, and that is
   the brief; the role, the model, the effort and the folder all arrive
   answered. An intro that goes on claiming two are needed would be the panel
   contradicting its own button, which is the defect the tier help text was
   fixed for two days earlier. */
export const START_PANEL = Object.freeze({
  title: 'Start an agent here',
  /* "Everything else already has an answer" IS ABOUT THE FIELDS AND READS AS
     A PROMISE ABOUT THE PRESS. On the browser preview, and on any copy with no
     assistant program installed, pressing Start does not run anything -- so a
     panel that opens by saying everything is answered is the last thing a
     person reads before a refusal. The claim it was making is a narrower and
     more useful one: you only have to fill in the brief. */
  intro: 'Say what you want done, and press Start. The brief is the only thing you have to fill in; every other field below already has an answer.',
  /* WHERE THE NEW AGENT IS GOING, and there are two of these because a node's
     name is not always known. The named form is a FUNCTION rather than a
     fragment a caller glues a name onto: a fragment invites `${name}` at the
     end of somebody else's sentence, and the first person with an awkward name
     gets a line that does not parse. Passing the name in means the sentence is
     always whole and the name always has words around it.
     A name here is data this repository did not write, so whoever renders it
     puts it on the page as TEXT and never as markup. */
  underNamed: (name) => `This agent will work under ${name}.`,
  underUnnamed: 'This agent joins your tree under the spot you pressed.',
  roleLabel: 'What kind of agent is this?',
  /* THE ROLE IS OFFERED, NOT DEMANDED (owner, 2026-08-19: "users shouldnt be
     forced to choose a role"). The help has to say BOTH halves, because a menu
     that no longer refuses looks exactly like a menu that still does: what a
     role is for, and what leaving it alone actually means. The second half is
     not a reassurance -- it is the measured behaviour. A start with no role
     stores no role, and every surface that has to put a word on that agent
      already has one: the canvas draws it in the neutral role, the circle is
      called "Agent", and the brief tells it the same address it would have had.
      The launcher also gives it a declared identity so it can safely delegate,
      but that does not invent a selected canvas role or change this answer. */
  roleHelp: 'Optional. Pick where it sits in your tree, or leave it and this agent just does the job you describe.',
  /* THE FOLDER, ASKED WHERE THE OWNER SAID IT SHOULD BE ASKED.
   *
   * Owner, 2026-08-16: "when a user starts a tree they should select a folder,
   * they can have a default folder, where the agents spawn". It was only ever
   * askable AFTER the fact, on an existing tree's rail, which is why he came
   * back on 2026-08-19 asking what had happened to it.
   *
   * ONLY WHEN A TREE IS BEING STARTED. A start under an existing agent joins a
   * tree that already has a folder, and offering the menu there would let one
   * nested start silently re-point every agent in the tree. So this field is
   * drawn for a new tree and for nothing else -- the same `newTree` the panel
   * already computes.
   *
   * THE MENU IS THE PROFILES THAT EXIST, NEVER A PATH THIS PANEL INVENTED.
   * Making a named folder stays in ONE place, the fleet rail, so there is no
   * second folder-creation mechanism to keep in step with the first. */
  workspaceLabel: 'Work on',
  workspaceFolder: 'Working folder',
  workspaceResearch: 'Research project',
  projectPrompt: 'Choose a project',
  projectHelp: 'This tree and its child agents will work on this project. Any role can be used.',
  projectEmpty: 'Create a project on the Research page, then choose it here.',
  projectRequired: 'Choose a research project first.',
  projectInherited: name => `Research project: ${name}.`,
  folderLabel: 'Which folder do its agents work in?',
  folderHelp: 'Every agent in this tree starts in this folder and reads the instructions there.',
  /* THE FIRST ROW MEANS "NAME NO FOLDER", AND WHAT THAT RESOLVES TO IS NOT ALWAYS
   * THE SAME PLACE. THESE TWO PAIRS SAY WHICH, AND THE DIFFERENCE WAS MEASURED.
   *
   * shell/main.cjs, at the one seam where a start with no profileId is resolved:
   * "A START THAT NAMES NO FOLDER RUNS IN THE ONE THE PERSON CHOSE IN SETUP"
   * (chosenWorkspaceCwd(), landed 2026-08-18). <userData>\workspace survives only
   * as the fallback for a machine where nobody was ever asked.
   *
   * This module was still saying the pre-2026-08-18 thing, and on the happy path
   * it was simply false. Two runs of the packaged build, same panel, same
   * sentence, two different signed spawn records:
   *
   *   finished setup, took the suggested folder   cwd = <home>\Documents\AI Workspace
   *   skipped setup, nobody was ever asked        cwd = null -> the product's workspace
   *
   * So the person who had just answered the folder question two screens earlier
   * was told their agent would work somewhere else, and pointed at a control to
   * "add one" for work they had already done -- four lines above a footer, on the
   * same panel, that said "It may change files only inside the folder you chose."
   * One panel, two answers.
   *
   * THE PATH ARRIVES AS DATA AND IS NEVER ASSEMBLED HERE, the same rule
   * underNamed() follows: the caller reads it from mcSetup.workspaceState(), and
   * whoever renders it puts it on the page as TEXT. */
  folderWorkspace: 'The product’s own workspace',
  folderWorkspaceChosen: 'The folder you chose in setup',
  /* Not a refusal: starting works fine without a named folder. It is a pointer to
     where named folders are made, named exactly as the rail names that section so
     a person can go find it. */
  folderNone: 'No folders set up yet — these agents will work in the product’s own workspace. Add one under “Folders your agents work in” on this page.',
  folderNoneChosen: (folder) => `No named folders yet — these agents work in the folder you chose in setup, ${folder}. Name one under “Folders your agents work in” on this page to keep different kinds of work apart.`,
  /* THE FIRST ROW OF THE ROLE MENU, AND IT IS NOW AN ANSWER RATHER THAN A
     PROMPT. A menu must have something selected, and pre-selecting a real role
     would answer the panel's own question for the person and let a role nobody
     chose through on a single press. So the first row still carries no role and
     is still what the menu opens on -- what changed is that pressing Start on it
     now WORKS, so the row has to say what it means instead of nagging.
     "Choose a role" was an instruction to do something the panel no longer
     requires; this is the state it leaves the agent in. A blank first row would
     do the same job for a screen reader, which reads the label, and would read
     as a rendering fault to everybody else. */
  rolePrompt: 'No particular role',
  /* THE MODEL QUESTION, and it is worded as one. "Tier" is what the wire calls
     it; a person is being asked what their agent runs on. Unlike the role menu
     this one arrives answered: the product has a default engine, so the menu
     preselects it (DEFAULT_TIER below) instead of asking a question the
     product already has an answer to. The Claude rows are offered on purpose
     and refuse by name when picked -- hiding them would make a chosen model
     quietly become Codex, the exact defect the tier channel closed. */
  tierLabel: 'What does it run on?',
  /* THE LAST PLACE THE DEAD END WAS STILL WRITTEN DOWN.
   *
   * This line read "Claude cannot start from a tree yet; to use Claude, hand the
   * work over on the agent page instead." Both halves were removed everywhere
   * else on 2026-08-17 and this one survived, because it is help text under the
   * menu rather than a refusal, so no test about refusals looked at it. It was
   * found by DRIVING the panel and reading what was actually on the glass.
   *
   * BOTH HALVES WERE WRONG BY THEN. The destination was driven from the state a
   * person reads this in -- a set-up machine, a tree -- and had ZERO doors:
   * no link, no enabled control, and the agent route is not on the ring. And
   * "cannot start from a tree" is now decided per build by the shell, not by
   * this file: tierChoicesFor() labels each row from what
   * mc-agent:startable-tiers actually answered, so a build carrying the engine
   * shows "Sonnet · Claude" while this sentence underneath still said it could
   * not start. The menu and its own help contradicted each other on one screen.
   *
   * So the help says only what is true of every build: which row is a good
   * default. What a given row can do is on the row, where it is computed. */
  tierHelp: 'A default is selected. Each row says so if this copy cannot start it.',
  effortLabel: 'How hard should it think?',
  effortHelp: 'Harder thinking is slower and costs more. The tier picks a sensible default; change it here for this agent.',
  messageLabel: 'What do you want it to do?',
  messageHelp: 'Write it the way you would ask a person. One clear job is enough to start.',
  messagePlaceholder: 'Read the notes in my documents folder and list what is unfinished.',
  /* KEPT for whatever still reads the single-button word; nothing in this
     product writes a panel with one button any more (owner: "ITS SUPPOSED TO
     HAVE SET OR START AS OPTIONS"). See submitSet/submitStart below. */
  submit: 'Start this agent',
  /* THE TWO PRESSES, NEVER ONE BUTTON DECIDING FOR THE PERSON. Same job in
     both cases -- write the draft -- and then Set stops there while Start
     also launches it; the words say which is about to happen, in the
     person's own words, not the tree's status. */
  submitSet: 'Set this agent',
  submitStart: 'Start this agent',
  // The window of an agent that is set but has never started (T1352).
  draftWindowStart: 'This agent is set but has not started. Start it here when you are ready.',
  cancel: 'Not now',
  /* THE MARK THAT SAYS THERE IS MORE TO READ, AND WHY IT IS A CHARACTER.
   *
   * Owner, 2026-08-19, on this panel for the second time: "pg 2 right pnel
   * STILL reads ugly and messy. Make some of the tips only show on hover ...
   * so it isnt so messy". A tip that is hidden with nothing standing where it
   * was is not tidier, it is gone -- so each field that HAS one says so, right
   * after the question it belongs to.
   *
   * It is one character because this product has no icon set: every glyph on
   * this rail today is either a typographic character or a CSS shape, and
   * introducing an image for five hints would be new visual vocabulary from
   * the one module whose whole promise is that it adds none. It is marked
   * aria-hidden where it is drawn, because it is not the tip and it is not a
   * control -- a screen reader gets the tip itself, unchanged, through the
   * field's own aria-describedby, which is exactly where it got it before. */
  tipMark: '?',
  /* THE ONE WAY LEFT TO PRESS START TOO EARLY. It says what is missing and what
     to do, in that order, and it does not scold.

     THERE WERE TWO. `needRole` -- "Pick a role first, then press Start." -- was
     removed on 2026-08-19 on the owner's words: "users shouldnt be forced to
     choose a role". It is not moved, softened or hidden behind anything; the
     refusal it belonged to is gone, so the sentence is gone with it. The role
     menu keeps its place at the top of the form and rolePrompt above says what
     the untouched row means.

     THE BRIEF IS STILL REQUIRED, and that is not an oversight. A start with no
     role has a real answer at every surface that must name it; a start with no
     brief has nothing to send, so it would open a session and hand it silence. */
  /* Said after Set as well as after Start (T1471), so it names neither
     button: a person who only wanted a draft must not be sent to Start. */
  needMessage: 'Say what you want done first.',
  /* A picture pasted into the brief is not attached to anything yet (T1511):
     say where it can go instead of dropping it without a word. */
  pictureInBrief: 'A picture cannot be added to the brief. Set or start this agent, then paste the picture into its chat.',
})

/* THE TIER MENU'S ROWS, derived from the one table the dispatch API actually
   honours (src/orchestration-controls.js LAUNCH_TIERS, which the
   orchestration-controls suite pins against the engine). The label names the
   model and what it runs on; the id rides on the option value where only the
   program reads it, the same split the role menu keeps. */
const TIER_PROVIDER_WORDS = Object.freeze({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', local: 'the computer you are driving' })
/* THE ONE PROVIDER THIS TREE CAN START. shell/agent-host.cjs resolveStartTier()
   refuses every other provider by name (AGENT_TIER_NO_LAUNCHER); the same fact
   is written on the row so a person sees it BEFORE pressing, on every surface
   that draws these rows -- the compose panel and the research designer's tier
   checkboxes both render `label`. The wording matches the running-session
   model menu in src/views/computers.js, so the product says it one way. */
/* WHAT THIS COPY CAN START, WHEN NOBODY HAS ASKED THE SHELL YET.
 *
 * This list used to be the ANSWER -- a frozen ['codex'] that decided the label
 * on every surface drawing these rows. The shell stopped agreeing with it: since
 * the tier gate opens on the payload genuinely carrying an engine (an actual
 * require() that must export a start function), a build WITH the Claude engine
 * would start a Claude tier while these rows went on saying it could not. A menu
 * that contradicts the button is worse than either answer alone.
 *
 * So this is now only the FALLBACK, and it is the pessimistic one on purpose: a
 * renderer with no bridge behind it (a plain browser), a payload older than the
 * channel, or a reply this build cannot parse all land here, and all of them are
 * builds where exactly the three Codex tiers start. Guessing wider would put
 * "startable" under a row that refuses. */
export const TREE_DEFAULT_STARTABLE_TIERS = Object.freeze(['astra', 'luna', 'terra', 'sol'])
/* "from a tree", not "here". A person reads this row on the tree, where it is
   true, and the same product hands work to a Claude assistant on the agent page,
   where it is not. The old wording made those two screens contradict each other. */
export const TIER_CANNOT_START_HERE = 'cannot start from a tree yet'
/* WHAT A ROW SAYS WHEN THE SHELL NEVER SPOKE, which is not what it says when
   the shell answered "no launcher".

   TIER_CANNOT_START_HERE is a claim about the BUILD: this copy carries nothing
   to start that tier, and no amount of signing in or installing will change it.
   Printing it because a local IPC call threw tells somebody their product is
   missing a feature it ships, and sends them nowhere. This sentence is a claim
   about the MOMENT instead, and it names the one thing that actually clears the
   failure it comes from -- the shell's own refusal for that code reads "Close
   ToolsEnabled, reopen it normally, and try again". The rows keep re-asking on
   their own (see the view's probe), so most people never read this at all. */
/* "that computer", and the remedy names WHERE. Both this sentence and
   TREE_ENGINE.unknownNote below are drawn for a signed-in browser driving a
   machine it is not sitting at, and NEITHER reaches readerRemedy():
   tierChoicesFor()'s `why` becomes a disabledHint at views/computers.js:9483
   and treeEngineFace() returns its `note` verbatim at :8664. A REMOTE_TWIN
   would therefore clear tools/lib/desk-phrase-scan.mjs without changing one
   word anybody reads -- the decoration that scan's own header warns about.
   The machine was already named in the third person in both, so naming it
   once more in the instruction costs a desk reader nothing and stops telling
   a remote one to reopen an application they cannot reach. */
export const TIER_ANSWER_UNKNOWN = 'that computer did not answer; reopen ToolsEnabled there if it stays this way'
/* THE OTHER REASON A ROW CANNOT START, AND THE ONE tierHelp WAS PROMISING AND
 * NOT DELIVERING.
 *
 * `startable` above answers ONE question: does this payload carry a launcher for
 * that tier. shell/agent-host.cjs resolveStartTier() returns the row for any
 * provider === 'codex' unconditionally, so it structurally cannot see a missing
 * sign-in -- and a missing sign-in is exactly what refuses the press, by name,
 * as AGENT_CONFINEMENT_SIGNED_OUT.
 *
 * MEASURED ON THE PACKAGED BUILD, one machine, one moment, cold install:
 *   mcProviders.presence()      codex installed yes, signedIn "no"
 *   mcAgent.startableTiers()    luna, terra, sol  (and the three Claude tiers)
 *   the rows drawn              "Luna · Codex", saying nothing
 *   the press                   "Nothing was started. This session needs a
 *                                Codex sign-in, and this computer does not
 *                                hold one."
 * Re-read after the press, with a completed round trip behind it: identical. And
 * the discriminating arm -- the same build with presence flipped to signedIn
 * "yes" -- drew rows that were byte-identical, so the rows were not a function of
 * it at all. Meanwhile "Local · your computer — cannot start from a tree yet"
 * printed correctly throughout, which is what proves the rows CAN say so.
 *
 * ONLY THE PROVEN NEGATIVE REACHES THIS, and shell/provider-cli-presence.cjs is
 * where that discipline is already written: only Codex treats a missing sign-in
 * file as proof ('no'), "because this shell already refuses a start on exactly
 * that basis". Everything else -- 'yes', 'unknown', no answer yet, no bridge --
 * says nothing, because a file that exists is not a working sign-in and rounding
 * an "I could not tell" up to a warning would put a terminal command in front of
 * somebody who is already signed in. */
export const TIER_NOBODY_SIGNED_IN = provider => `nobody is signed in to ${provider} on the computer you are driving`
/* AND THE MACHINE THAT NEVER HAD THE PROGRAM, which the sentence above sends to
 * a dead end.
 *
 * `codex login` is a SUBCOMMAND OF THE PROGRAM ITSELF, so on a computer with no
 * Codex the sign-in line asks a person to run something that answers "'codex' is
 * not recognized" -- which is, verbatim, what this product's first external user
 * hit on 1.0.20. The row was right that it could not start and wrong about what
 * to do next, which costs more than silence: it spends the one instruction the
 * person is going to try.
 *
 * BOTH FLAGS ARE TRUE ON THAT MACHINE, so the order is what does the work.
 * shell/provider-cli-presence.cjs gives Codex `signInProves: 'absence'`, so a
 * computer with no Codex reports installed:'no' AND signedIn:'no' -- the sign-in
 * file cannot be there when the program never was. Measured against the rows as
 * they stood: that machine drew "nobody is signed in to Codex on this computer"
 * and said nothing about installing anything.
 *
 * THE ORDER IS ALREADY THIS CODEBASE'S RULE, and it is copied rather than
 * invented. codexCommandIsMissing() in shell/agent-host.cjs checks the program
 * BEFORE the sign-in and states why: "Reporting the CLI first yields the only
 * sequence that terminates: install, then sign in, each step true when it is
 * shown." A row and the refusal a press would give now name the same first step.
 *
 * 'unknown' IS STILL NEVER ROUNDED UP. presence() answers 'unknown' when it
 * could not read PATH at all, which is not an empty PATH; turning that into
 * "you have not installed it" would tell somebody to redo an install that
 * worked, which is the mirror of the defect above. */
const TIER_NOT_INSTALLED_WORDS = Object.freeze({
  desk: provider => `${provider} is not installed on this computer`,
  remote: provider => `${provider} is not installed on the computer you are driving`,
})

export const TIER_NOT_INSTALLED = (provider, subject = 'this computer') => subject === 'this computer'
  ? TIER_NOT_INSTALLED_WORDS.desk(provider)
  : TIER_NOT_INSTALLED_WORDS.remote(provider)
/**
 * Which tiers this copy can really start, out of what the shell answered.
 *
 * THE SHELL IS THE ONLY PARTY THAT KNOWS. mc-agent:startable-tiers does not
 * keep a list; it runs the SAME resolveStartTier() the press resolves from, so
 * the menu and the button cannot disagree by construction. This function's only
 * job is to refuse to believe anything else.
 *
 * AN EMPTY ARRAY IS AN ANSWER, NOT A FAILURE, and it is the one case worth
 * spelling out. `{ok: true, tiers: []}` means the shell resolved every tier and
 * none of them can start -- so every row says so. It does NOT fall back to the
 * three Codex tiers: that would be this file overruling the shell on the one
 * question the shell was asked, and it would put "startable" under a row that
 * refuses. A reply that is missing, rejected, malformed, or names tiers this
 * build has never heard of is a different thing entirely -- nothing was
 * learned -- and that lands on the pessimistic default above.
 */
export function startableTierIds(reply) {
  return startableTierAnswer(reply).tiers
}

/**
 * The same reading, plus WHETHER ANYTHING WAS LEARNED -- and that second half
 * is the whole point of this function existing.
 *
 * THE DEFECT IT CLOSES, from the owner: "why cant i launch claude or gemini or
 * grok or like. why only codex wtf." Every launcher was present and every
 * account was signed in. What had happened is that one `mc-agent:startable-tiers`
 * call threw (code OWNER_HOST_CREDENTIAL_HYGIENE_FAILED, logged twice during a
 * restart), the caller fell to TREE_DEFAULT_STARTABLE_TIERS, and because that
 * fallback is exactly the four Codex tiers the tree went on offering Codex and
 * marking Claude, Gemini and Grok TIER_CANNOT_START_HERE -- "cannot start from
 * a tree yet" -- for the rest of the view. The list is fetched once per view,
 * so nothing re-asked.
 *
 * THE FALLBACK IS STILL RIGHT. A renderer with no shell behind it really can
 * only start those four, and widening the guess would put "startable" under a
 * row that refuses. What was wrong is that the fallback was INDISTINGUISHABLE
 * from an answer: one value carried both "the shell said no launcher" and "the
 * shell never spoke", and only the first of those deserves the sentence the
 * rows were printing. So the reading now carries its own provenance, and
 * tierChoicesFor takes `answered` to say which sentence is true.
 *
 * `answered` is false in both of the cases the reading is discarded in --
 * a missing/rejected/malformed reply, AND a reply that names only tiers this
 * build has never heard of. The second is as much "nothing was learned" as the
 * first; it is an answer about a product this one is not.
 *
 * @returns {{answered: boolean, tiers: ReadonlyArray<string>}}
 */
export function startableTierAnswer(reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true || !Array.isArray(reply.tiers)) {
    return UNANSWERED_TIERS
  }
  const known = reply.tiers.filter(id => typeof id === 'string' && LAUNCH_TIERS.some(tier => tier.id === id))
  /* Every entry unrecognised while the list was not empty means this renderer
     and that shell do not share a tier table -- an answer about a product this
     one is not, so it is discarded rather than half-read. */
  if (reply.tiers.length > 0 && known.length === 0) return UNANSWERED_TIERS
  return Object.freeze({ answered: true, tiers: Object.freeze(known) })
}
const UNANSWERED_TIERS = Object.freeze({ answered: false, tiers: TREE_DEFAULT_STARTABLE_TIERS })

/**
 * The menu rows, labelled by what this copy can actually start.
 *
 * @param startable      tier ids the shell resolved, from startableTierIds().
 * @param signedOutOf    provider ids this computer is PROVABLY not signed in to
 *                       -- `presence()` answering 'no', never 'unknown'. Empty
 *                       by default, so a caller that has not asked, or cannot,
 *                       gets exactly the rows it got before this parameter
 *                       existed.
 *
 * @param notInstalledOf  provider ids whose PROGRAM this computer provably does
 *                       not have -- `presence()` answering installed:'no',
 *                       never 'unknown'. Empty by default, for the same reason.
 *
 * @param answered       whether `startable` is something the shell SAID, from
 *                       startableTierAnswer(). False means the reading is the
 *                       pessimistic fallback and nothing was learned, and the
 *                       rows say that instead of claiming this build carries no
 *                       launcher. True by default, so every caller that has an
 *                       answer -- and TIER_CHOICES, which is the answer-shaped
 *                       default -- reads exactly as it did before.
 *
 * ONE ROW SAYS ONE THING, AND THE ORDER IS THE WHOLE POINT, because a machine
 * can hold more than one of these at once and only the first is worth acting on:
 *
 *   no launcher   >  no program  >  no sign-in
 *
 * NO LAUNCHER OUTRANKS BOTH: a copy that carries nothing to start cannot be
 * fixed by installing or signing into anything, so naming either would be
 * sending someone to do work that changes nothing.
 *
 * NO PROGRAM OUTRANKS NO SIGN-IN, and that pair is not hypothetical -- a
 * computer with no Codex reports BOTH, because `codex login` is a subcommand of
 * the missing program and its sign-in file cannot exist without it. Saying
 * "sign in" there spends the person's one instruction on a command that answers
 * "'codex' is not recognized". codexCommandIsMissing() in shell/agent-host.cjs
 * orders its own refusals this way for exactly this reason.
 */
export function tierChoicesFor(startable = TREE_DEFAULT_STARTABLE_TIERS, signedOutOf = [], notInstalledOf = [], subject = 'this computer',
  { answered = true } = {}) {
  const canStart = new Set(Array.isArray(startable) ? startable : TREE_DEFAULT_STARTABLE_TIERS)
  const signedOut = new Set(Array.isArray(signedOutOf) ? signedOutOf.filter(id => typeof id === 'string') : [])
  const noProgram = new Set(Array.isArray(notInstalledOf) ? notInstalledOf.filter(id => typeof id === 'string') : [])
  return Object.freeze(LAUNCH_TIERS.map(tier => {
    const provider = TIER_PROVIDER_WORDS[tier.provider] || tier.provider
    let why = ''
    if (!canStart.has(tier.id)) why = answered ? TIER_CANNOT_START_HERE : TIER_ANSWER_UNKNOWN
    else if (noProgram.has(tier.provider)) why = TIER_NOT_INSTALLED(provider, subject)
    else if (signedOut.has(tier.provider)) why = TIER_NOBODY_SIGNED_IN(provider)
    return Object.freeze({
      id: tier.id,
      label: why ? `${tier.label} · ${provider} — ${why}` : `${tier.label} · ${provider}`,
      enabled: !why,
      why: why || null,
    })
  }))
}

/**
 * Which providers this computer is PROVABLY not signed in to, out of a
 * `mcProviders.presence()` reply.
 *
 * The whole judgement lives here rather than at the call site for the same
 * reason startableTierIds() does: it is the place that refuses to believe
 * anything but a proven negative, and a second copy of that rule at a caller is
 * a second copy that softens. Anything that is not `ok:true` with a providers
 * array teaches nothing and yields nothing.
 */
export function signedOutProviderIds(reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true || !Array.isArray(reply.providers)) return Object.freeze([])
  return Object.freeze(reply.providers
    .filter(row => row && typeof row.id === 'string' && row.signedIn === 'no')
    .map(row => row.id))
}

/**
 * Which providers this computer provably does not HAVE THE PROGRAM for, out of
 * the same reply.
 *
 * Its own function beside the one above rather than a second field threaded out
 * of one call, because they are two different proofs about two different things
 * -- a missing program and a missing sign-in -- and only one of them is worth
 * telling a person about at a time. `installed: 'no'` is the only answer that
 * reaches here: 'unknown' means presence() could not read PATH at all, which is
 * not the same as an empty one, and reporting it as absent would tell somebody
 * to redo an install that worked.
 */
export function notInstalledProviderIds(reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true || !Array.isArray(reply.providers)) return Object.freeze([])
  return Object.freeze(reply.providers
    .filter(row => row && typeof row.id === 'string' && row.installed === 'no')
    .map(row => row.id))
}

/* WHAT A NODE'S ENGINE ROW SAYS, DERIVED RATHER THAN DECLARED.
 *
 * THE SENTENCE THIS REPLACES, and the owner's report about it: the tree node
 * panel's Setup box carried a hardcoded `TREE_ENGINE_LABEL = 'Codex'` and a
 * note reading "Agents you start from this tree run on Codex. You pick the
 * model in the start panel; the Claude choices are listed there and say so
 * when they cannot start yet." Both were written when Codex was the only
 * engine in the payload. capability/src/lib/agent-engine/claude-cli-process.js
 * ships now, resolveStartTier() stops refusing the Claude tiers, and the panel
 * went on naming Codex as THE engine on a build that starts Claude.
 *
 * IT IS TRUE BY CONSTRUCTION NOW, not by upkeep -- the same discipline
 * tierChoicesFor() already applies to the start menu. The words come from what
 * mc-agent:startable-tiers actually answered, which is the SAME
 * resolveStartTier() a press runs, so this row and the button cannot disagree.
 * A build that gains or loses an engine changes this sentence with no edit
 * here, and there is no argument that makes it name a provider the shell did
 * not list.
 *
 * A node that HAS run says what it ran on instead, from the tier recorded on
 * it -- that is history, and it stays true after the payload changes. */
export function tierProviderWord(tierId) {
  const row = LAUNCH_TIERS.find(candidate => candidate.id === tierId)
  if (!row) return null
  return TIER_PROVIDER_WORDS[row.provider] || row.provider
}

/** The distinct provider words behind a set of startable tier ids, in menu order. */
export function startableProviderWords(startable = TREE_DEFAULT_STARTABLE_TIERS) {
  const ids = new Set(Array.isArray(startable) ? startable : TREE_DEFAULT_STARTABLE_TIERS)
  const words = []
  for (const tier of LAUNCH_TIERS) {
    if (!ids.has(tier.id)) continue
    const word = TIER_PROVIDER_WORDS[tier.provider] || tier.provider
    if (!words.includes(word)) words.push(word)
  }
  return Object.freeze(words)
}

export const TREE_ENGINE = Object.freeze({
  /* An older record has no tier on it. "Not recorded", never a guess: naming
     the default here would put a provider on a run that may not have used it. */
  unrecorded: 'not recorded',
  /* The shell resolved every type and can start none of them. Said plainly,
     because the start panel is about to refuse and this is the warning. */
  none: 'nothing yet',
  noneNote: 'This copy cannot start any agent type from a tree yet. The start panel marks every type, and says so before you press.',
  /* THE SILENCE, WHICH IS NOT AN ANSWER AND MUST NOT BE DRAWN AS ONE. Without
     this the row read "Codex" whenever the probe failed -- the fallback's own
     provider words, printed as a fact about the payload -- on a copy that
     starts Claude, Gemini and Grok perfectly well. */
  unknown: 'not answered',
  unknownNote: 'That computer has not said which agent types it can start. It keeps asking; reopen ToolsEnabled there if this stays.',
  note: words => `Agents you start from this tree run on the type you pick in the start panel. This copy can start ${listWords(words)}.`,
  /* For a node that already ran: what it ran on, not what this copy could
     start today. */
  ran: word => `This agent ran on ${word}.`,
})

/* "Codex and Claude", not "Codex, Claude" -- the panel is prose, and a comma
   list of two reads as a fragment beside the sentences around it. */
function listWords(words) {
  const list = Array.isArray(words) ? words.filter(Boolean) : []
  if (list.length === 0) return 'nothing'
  if (list.length === 1) return list[0]
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/* The rows a surface gets when it has not asked. Same value this constant has
   always had, so every existing importer is unchanged. */
export const TIER_CHOICES = tierChoicesFor()

/* Preselected, not prompted: the engine has a default, so the menu states it.
   An empty first row here would be a question the product already answers. */
/* Codex's gpt-6 line is what a NEW circle starts on as of 2026-09-07 (1.0.42).
   Existing circles and saved conversations keep the tier they were started on;
   only new starts read this. The three gpt-5.6 tiers stay selectable and
   nothing is deprecated -- the catalog marks no model deprecated and none is
   hidden. */
export const DEFAULT_TIER = 'astra'

/* EFFORT, IN WORDS A PERSON WEIGHS. The engine's four keys are a real
   difference paid for in time and money, so each row says what it costs
   rather than leaving a bare key on the glass (write-surfaces.js already set
   this register: "thinks a little / harder / hardest"). The menu defaults
   from the chosen tier's own effort, so leaving it alone means the tier's
   judgment, not a hidden fifth value. */
/* THE PROVIDER'S OWN DEPTHS, IN THE PROVIDER'S OWN WORDS.
 *
 * Owner, iteration 7: "there are STANDARD per provider effort names. Use
 * those" — and he was right that these had been invented here. What stood
 * in this list was four made-up labels ("Quick — thinks briefly, cheapest")
 * over four of the eight values codex accepts, which meant the product could
 * not even ask for the other four. `ultra` was the costly one to miss: it is
 * not a bigger number, it is the switch for automatic task delegation, and
 * his own ~/.codex/config.toml runs it.
 *
 * Ids and descriptions below are transcribed from `model/list` on
 * codex-cli 0.146.0 (gpt-5.6 line, 2026-08-16), and RE-VERIFIED unchanged
 * against codex-cli 0.153.4 on 2026-09-07 when the gpt-6 line arrived: all six
 * ids and their descriptions still match, so nothing was added here. Note the
 * per-model shape this list cannot express -- gpt-6-astra offers all six while
 * gpt-5.6-luna offers five (no `ultra`) -- which is why the picker asks the
 * engine per model and only falls back to this. This list is the FALLBACK:
 * a running session lets the app ask the engine what the chosen model
 * really supports, and that answer wins — see readEngineCatalog in
 * src/views/computers.js. The name is the label; the provider's sentence is
 * the help text beside it. */
export const EFFORT_CHOICES = Object.freeze([
  Object.freeze({ id: 'low', label: 'low', description: 'Fast responses with lighter reasoning' }),
  Object.freeze({ id: 'medium', label: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' }),
  Object.freeze({ id: 'high', label: 'high', description: 'Greater reasoning depth for complex problems' }),
  Object.freeze({ id: 'xhigh', label: 'xhigh', description: 'Extra high reasoning depth for complex problems' }),
  Object.freeze({ id: 'max', label: 'max', description: 'Maximum reasoning depth for the hardest problems' }),
  Object.freeze({ id: 'ultra', label: 'ultra', description: 'Maximum reasoning with automatic task delegation' }),
])

/** One depth, as a menu row reads it: the provider's name, then the
 *  provider's own sentence. Composed HERE rather than in the panel, because
 *  this module owns every word the start flow puts on screen — a panel that
 *  assembles its own line is a second voice, which is the drift this file
 *  exists to prevent. */
export function effortOptionLabel(choice) {
  if (!choice || typeof choice !== 'object') return ''
  const name = typeof choice.label === 'string' && choice.label ? choice.label : String(choice.id || '')
  const description = typeof choice.description === 'string' ? choice.description.trim() : ''
  return description ? `${name} — ${description}` : name
}

/* ---------------------------------------------------------------
   Starting, and running.
   --------------------------------------------------------------- */

/* THE ANSWER, ON THE SAME PAGE THE QUESTION WAS ASKED. Measured 2026-08-13 on
   the installed 1.0.7: a tree-started agent ran, the engine answered, and no
   surface on the tree page rendered a word of it -- the person read "starting"
   forever and concluded agents do not respond. The agent page repaired this
   exact defect once already (see the CORRECTED note beside its onEvent
   listener); this is the same repair for the tree rail, with its own register.
   The empty-turn sentence follows rule 3: it ends with something to do. */
export const SAID_PANEL = Object.freeze({
  /* "Its latest answer", because that is what the box holds: the reply is
     overwritten every turn, while the brief box above it shows the message
     written once at start. "What it said" read as the other half of one
     exchange, and the pairing was false. */
  title: 'Its latest answer',
  waiting: 'No answer yet. Words appear here as the agent writes them.',
  emptyTurn: 'The turn finished without any words back. Check any tool activity above first. Ask again only if that work is not done.',
})

/* A TURN THAT FAILED, ON A SESSION THAT REALLY STARTED. Measured on the
   2026-08-18 fresh-install walkthrough: a real Fable turn ended in the
   engine's own sentence -- "You're out of usage credits · resets Aug 25,
   12am" -- and the card said "The turn finished without any words back" while
   the chip said "did not start", over a session whose start the signed spawn
   record shows. Two lies from one gap: the failure's sentence never left the
   engine, and the only failure word the store had was the start-failure one.

   These are the words for the state that was missing. 'turn-failed' is a
   store status beside 'finished' (see NODE_STATUS_WORDS below); the reply
   carries the engine's sentence verbatim, because the provider's own words
   are the ones a person can act on. */
export const TURN_FAILED = Object.freeze({
  word: 'the last turn failed',
  reply: sentence => `The last turn failed: ${sentence}`,
})

/* A native cancelled completion is not a failed turn and not Halt. ACP can
   end a prompt as cancelled after a refused permission, or for other reasons.
   The chip must not say the last turn failed, and must not say "stopped by you"
   unless Halt was recorded. */
export const TURN_CANCELLED = Object.freeze({
  word: 'this turn ended',
  note: 'This turn ended without finishing.',
  refused: 'A permission was refused. This turn ended.',
})

/* THE CHIP WORD FOR EVERY STATUS THE STORE ACCEPTS -- one table, read by the
   chip on the canvas, the rail behind it, and the tooltip, so no surface can
   invent its own word for a state. 'failed' is a START that never happened
   ("did not start"); 'turn-failed' is a TURN that ended badly on a session
   that genuinely ran. Collapsing those two into one word is the measured
   defect this table exists to keep fixed: the card un-said a start the
   signed record shows. */
export const NODE_STATUS_WORDS = Object.freeze({
  draft: 'not started yet',
  starting: 'starting',
  running: 'running',
  finished: 'finished',
  failed: 'did not start',
  'turn-failed': TURN_FAILED.word,
  cancelled: TURN_CANCELLED.word,
  /* A deliberate stop is the person's act, not the product's failure. Written
     only when THIS window initiated the interrupt (both doors — the palette
     row and the composer's Stop face — reach one handler that records the
     press); an organic failure in the same instant still reads as one,
     because the record is consumed per turn. Measured 2026-08-19: without
     this word, pressing Stop mid-stream painted "the last turn failed" beside
     a transcript honestly saying "Interrupted." */
  interrupted: 'stopped by you',
  /* A STATUS WORD THIS BUILD CANNOT READ gets its own word rather than the
     fallthrough. The node is kept (T162, 2026-09-19: one such row used to
     empty the whole canvas) with the word another build wrote preserved on
     the record; what this build can honestly say about it is only that it
     cannot read the state, and that it is not running anything here. */
  [NODE_STATUS_UNREADABLE]: 'state unreadable by this build',
})

/* THE WORDS ONE COMPLETED TURN LEAVES ON THE NODE, decided in one place.
 *
 * `spoken` is what the agent really streamed; it is never discarded. The
 * engine's sentence is what a FAILED turn ended with -- often the only human
 * sentence the whole turn produced (a refused model answers with no assistant
 * text at all). A failed turn that streamed nothing shows the failure
 * sentence; one that streamed words keeps them and the sentence both, because
 * dropping either would hide something that happened. Only when there is
 * genuinely nothing -- no words, no sentence -- does the honest empty-turn
 * line show. */
export function turnCompletionWords({ succeeded, spoken = '', engineSentence = null, userStopped = false, cancelled = false, refused = false }) {
  const said = typeof spoken === 'string' ? spoken.trim() : ''
  if (!succeeded && userStopped) return said || PALETTE_PANEL.interruptDone
  if (!succeeded && cancelled) return said || (refused ? TURN_CANCELLED.refused : TURN_CANCELLED.note)
  const sentence = !succeeded && typeof engineSentence === 'string' ? engineSentence.trim() : ''
  if (sentence) return said ? `${said}\n\n${TURN_FAILED.reply(sentence)}` : TURN_FAILED.reply(sentence)
  return said || SAID_PANEL.emptyTurn
}

/* MOVING AN AGENT, in words. The owner's ask, verbatim: "there needs to be a
   way to quickly connect nodes and change hierarchies too". The picker offers
   only what the store's movePoints() would accept, so every sentence here is
   about a legal move or the reason there is none — the menu and the refusal
   can never disagree. */
export const MOVE_PANEL = Object.freeze({
  title: 'Reports to',
  help: 'Pick which agent this one works under — in this tree or another. Everything under it moves with it.',
  prompt: 'Choose a new parent',
  save: 'Save',
  needChoice: 'Pick a parent first, then press Save.',
  empty: 'Every agent this one could work under is already full or sits below it, so there is nowhere else to move it.',
  staleChoice: 'The tree changed while this menu was open. Close and reopen this agent, then pick again.',
  notSaved: 'The move was not saved. Pick another parent and try again.',
  saved: (name, parent) => `Saved. ${name} now reports to ${parent}.`,
  addressNotUpdated: count => `The move was saved, but ${count === 1 ? 'one running agent was' : `${count} running agents were`} not reconnected to the new branch. Restart ${count === 1 ? 'that agent' : 'those agents'} to apply the saved tree address.`,
  mixed: 'Your own tree agents and the declared fleet stay separate. Drag a tree agent onto a tree agent, or a fleet agent onto a fleet agent.',
  /* The drag refusals. A drop that cannot be accepted says WHY in a sentence,
     never a silent snap-back — a wiggle animation with no words reads as a
     bug, not a rule. */
  alreadyUnder: (name, parent) => `${name} already reports to ${parent} — dropping it there changes nothing.`,
  wouldCycle: (name, target) => `${target} works under ${name}, so ${name} cannot also report to ${target}.`,
  notDraggable: (name) => `${name} is this tree's coordinator and stays at the top. Move its agents instead.`,
})

/* REMOVING AN AGENT, in words. The owner's finding, verbatim: "there was also
   no way to remove an old node you wanted to delete." The two refusal
   sentences are the STORE's own (src/fleet-trees.js NODE_REMOVE_REFUSALS,
   re-exported here by identity, not copied), so the row's reason and the
   store's refusal are one string. The confirm stage says what goes BEFORE it
   goes — the agent, by name, and its saved conversation on this computer —
   and says what stays: the signed run records are the permanent record of
   what ran, and a removal never touches them. */
export const REMOVE_PANEL = Object.freeze({
  action: 'Remove this agent',
  hint: 'Takes this agent off your tree. Nothing goes until you confirm.',
  whyRunning: NODE_REMOVE_REFUSALS.running,
  whyChildren: NODE_REMOVE_REFUSALS.children,
  /* The name is data the person typed around; whoever renders this puts it on
     the page as TEXT, the same rule START_PANEL.underNamed states. */
  confirm: name => `This removes ${name} and its saved conversation here. The signed run records are kept.`,
  go: 'Remove',
  done: name => `Removed ${name} and its saved conversation here. The signed run records are kept.`,
  notRemoved: 'That agent was not removed. Open the menu and try again.',
})

/* SESSION PROFILES, in words. A profile is a name and a folder; agents in a
   tree assigned one wake up in that folder, which is where their instructions
   live -- so "different onboarding for different work" is a folder choice,
   said plainly. The renderer never invents or displays a path of its own; the
   folder in a row is the one the person picked in the system dialog. */
export const PROFILE_PANEL = Object.freeze({
  title: 'Works in',
  /* TWO HEADINGS THAT SAY "FOLDER", BECAUSE "WORKS IN" AND "SESSION PROFILES"
     BOTH FAILED TO.
     Owner, 2026-08-19: "what happened to sessions and choosing a folder for
     each tree and such? ther right panel on page 2 is still so complicated i
     think its in there maybe somewhere". It WAS in there: on the overview rail
     under "Session profiles", 1152px down a 1524px scroll, and on a tree node
     under "Setup" > "Works in". Neither heading contains the word he was
     hunting for. These two do. `title` is kept as it was for the select's own
     aria-label, which names the field rather than the panel. */
  overviewTitle: 'Folders your agents work in',
  nodeTitle: 'Folder these agents work in',
  help: 'A profile is a name and a folder. Agents in a tree that uses a profile start in that folder and read its instructions, so different kinds of work stay apart.',
  treeHelp: 'Where agents in THIS TREE start. Applies to agents started after you change it.',
  productWorkspace: 'The product’s own workspace',
  setupWorkspace: folder => `The folder you chose in setup · ${folder}`,
  none: 'No profiles yet. Name one and pick its folder.',
  namePlaceholder: 'Name the profile…',
  add: 'Pick a folder…',
  remove: 'Remove',
  nameFirst: 'Name the profile first, then pick its folder.',
  cancelled: 'No folder was picked, so nothing was saved.',
  refused: 'That profile could not be saved. Try another name.',
  needsApp: 'Profiles need the installed app, and this window cannot reach it.',
  /* THE FOLDER PICKER IS A WINDOW ON THAT COMPUTER, so it is offered only
     where somebody can see it. Reading the folders already saved works from
     anywhere, which is why this refusal belongs on the ADD control and not on
     the panel: shell/agent-facade.cjs leaves agent:profile-create out of the
     route table by name, and the browser binding does not define profileCreate
     at all. Without this the control rendered enabled over the relay and the
     press threw inside its own handler -- the button did nothing, forever. */
  addNeedsMachine: 'Picking a folder opens a window on that computer, so it cannot be done from here. Open ToolsEnabled on the computer itself to add a folder.',
  /* The remove press used to discard whatever came back and redraw the panel,
     which is what a person sees when it worked. A refusal -- web-drive off, an
     id the machine no longer has -- has to say so. */
  removeFailed: 'That folder was not removed, so it is still here. Try it again in a moment.',
  assigned: (name) => `Agents in this tree now start in ${name}.`,
  cleared: 'Agents in this tree now start in the product’s own workspace.',
  /* The mid-conversation half of the owner's ask ("change session profiles
     halfway through - with a warning because of possible token burn"): the
     assignment itself only touches FUTURE starts, so moving the agent on
     screen is a separate, warned press. */
  switchOffer: 'This agent keeps its current folder until it restarts. Restarting re-sends its saved conversation, which costs tokens.',
  switchGo: 'Restart it in the new folder',
  /* SAVED IN THIS WINDOW IS NOT SAVED, AND THE MENU COULD NOT TELL THE
     DIFFERENCE. setTreeProfile() reports a refused write in the snapshot it
     returns, never in `ok` -- the assignment really did happen in memory -- so
     the only guard the menu had (`!saved.ok`) stayed false and the panel said
     "Agents in this tree now start in <name>" over a record that reloads as the
     OLD folder. Measured against the real store with a seam whose setItem
     throws QuotaExceededError, which is what a browser does once the saved
     transcripts have filled the origin the forest lives in: ok=true,
     persistenceFailed=true, and re-parsing what is actually stored gives back
     the previous profile.

     IT SAYS BOTH HALVES, because both are true and only one of them is the
     comfortable one: the choice IS live for anything started right now, and it
     is live nowhere else. Saying only "could not be saved" would read as "your
     press did nothing", which would send a person to press it again. */
  notSaved: (name) => `Agents you start now use ${name}, but this folder could not be saved on this computer: reload and this tree goes back to the folder it had.`,
  notSavedCleared: 'Agents you start now use the product\u2019s own workspace. That choice could not be saved on this computer: reload and this tree goes back to the folder it had.',
  /* THE FOLDER THIS TREE IS SET TO, WHICH THIS COMPUTER NO LONGER HAS.
     Removing a folder in Settings does not clear the trees that used it, so the
     pointer outlives the folder. The menu used to show the product's workspace
     in that case -- the default, silently, over a record that said something
     else. These two say what is true instead: the row names the gap, the line
     says what it means for a start. Neither names the id, because a profile id
     means nothing to the person who chose a folder. */
  missingFolderOption: 'The folder this tree was set to (no longer on this computer)',
  missingFolder: 'The folder this tree was set to is not on this computer any more, so agents started here will be refused until you pick another. Nothing has been changed for you.',
})

/* THE FOUR WAYS WORK GETS STARTED, BEHIND ONE NAMED PRESS.
 *
 * WHAT WAS MEASURED (tools/rail-inventory-drive.mjs, packaged, 2026-08-20): the
 * tree node's Details tab is nine stacked panels, and Launch, Team, Loop and
 * Codex Cloud are the last four of them. They are already ONE idea -- the
 * builder's own comment calls them "the four answers to how work gets started
 * from this computer" -- so they read better as one group than as four peers of
 * the conversation and the folder.
 *
 * COLLAPSED, NEVER HIDDEN. The owner's rule for this page is that no control
 * hides harder than it has to, so the group is a real <button> with
 * aria-expanded and a chevron, it NAMES all four of its panels on its own line,
 * and the state it was left in is remembered. Nothing is removed and nothing
 * inside the four boxes changes.
 *
 * AND IT PUTS A REMOUNT TRIGGER BEHIND A DELIBERATE PRESS. When cloud launching
 * is switched off, src/cloud-tasks.js appends "Turn on Codex Cloud launching"
 * into the Codex Cloud box's header, and that press calls setWriteEnabled --
 * which tears down and rebuilds this whole view, discarding unsaved edits
 * elsewhere on the page. Collapsed, it is no longer sitting in a person's
 * scroll path. That is a mitigation, not the fix; the fix is another lane's. */
export const START_WORK_GROUP = Object.freeze({
  title: 'Start more work',
  contents: 'Launch, Team, Loop and Codex Cloud',
  expandLabel: 'Show the ways to start more work: Launch, Team, Loop and Codex Cloud',
  collapseLabel: 'Hide the ways to start more work',
})

/* RESUMING A DEAD SESSION (iteration 5 W7). A session cannot be reopened —
   the engine process is gone — so resume is honest about what it does: a
   FRESH agent starts and its first message is the saved conversation. The
   hint carries the token cost, because the press re-sends every saved word. */
export const RESUME_PANEL = Object.freeze({
  action: 'Resume with a fresh agent',
  hint: 'Starts a new agent whose first message is the saved conversation. Re-sending it costs tokens.',
  nothing: 'Nothing is saved here to resume from.',
  busy: 'This agent is still running — stop it first, or just keep talking to it.',
  /* A second press while the first resume is mid-flight used to start a
     SECOND agent: the node's status stays a finished one until the new
     session opens, so nothing in the row's own enabled/busy reading said a
     resume was already happening. Both agents would then be live, only the
     last one to answer would own the node, and the other would keep working
     and spending with no control on screen able to reach it. */
  underway: 'This agent is already being resumed. Starting a second one would leave one of them running with no way to reach it.',
  failed: 'The resume did not happen. The saved conversation is untouched; press again to retry.',
  /* STOP IS STILL WORTH TRYING FIRST, BUT IT IS NOT ALWAYS THE WAY OUT, and
     saying only "Press Stop" left people pressing a control that does not
     always clear this. MEASURED 2026-09-19 on two wedged circles
     (node-35-4f5a2c39, node-19-c4a71b16): Stop answered a bare internal error
     on five consecutive calls, and on one of them answered
     MC_TREE_COMMAND_SESSION_ENDED first and the internal error afterwards --
     so Stop did not even agree with itself between calls on one circle.
     Remove cleared a circle in that state with the application running. Both
     are named here, in the order worth trying, so the sentence still has a way
     out when the first one does not take. */
  closeFailed: 'The agent was not restarted because its old session was not confirmed closed. Press Stop and try again; if Stop will not clear it either, "Remove this agent" will, and it leaves every other agent running.',
  done: 'Resumed. A fresh agent is reading the conversation and will pick it up from there.',
  /* The real one: the engine still held the thread, so the SAME agent came
     back with its own memory. Nothing was re-sent and nothing was charged,
     which is the difference worth saying out loud. */
  continued: 'Back. This is the same agent, with everything it already remembered — nothing had to be re-sent.',
  marker: 'Resumed — the saved conversation above was sent to a fresh agent.',
})

/* WHERE THE VERB REALLY IS, for a rail that is not the tree rail.
 *
 * The fleet-record rail (showProjectionControls in src/views/computers.js)
 * carries Pause, Resume and Respawn switched off, and two of those three
 * excuses had gone false. "nothing can be paused, so nothing can be resumed"
 * makes resume a consequence of pause, and it never was: resume is its own
 * verb here (RESUME_PANEL) and it runs on an agent in the tree. "respawn is
 * performed by the supervisor sweep from a persisted checkpoint" named a
 * mechanism that appears nowhere in this repository -- it was the only
 * occurrence of the phrase -- which is worse than an unhelpful reason,
 * because a person can go looking for it.
 *
 * A disabled control still owes a true reason, and the true one is that this
 * box describes a RECORD, not a live agent in the tree: it has no node, no
 * saved conversation and no session, so neither verb can act from here. The
 * label is passed in from the row that really performs it, so this sentence
 * cannot start naming a menu entry that has been renamed. */
export const recordRailVerbElsewhere = verb => 'This box describes a record on file, not an agent in your tree. '
  + `Select that agent on the canvas and press “${verb}” on its chat Actions menu.`

/* A CHAT OVER AN AGENT THAT IS NOT RUNNING, WHICH IS STILL A CHAT.
 *
 * WHAT THIS REPLACED, and why it was the owner's report. Both chat surfaces on
 * the tree -- the compact card on the canvas and the rail's Chat tab -- were
 * gated on the node holding a session id, so a node whose START WAS REFUSED
 * opened nothing at all. That is not a rare state: submitCompose() marks a
 * refused start `failed` and leaves the session id null, so on a build that
 * cannot start the picked engine EVERY node a person makes is one of these, and
 * "the chatboxes dont open" is the exact and correct description of it.
 *
 * IT DOES NOT BECOME A TEXT BOX THAT SWALLOWS WORDS. src/node-chatbox.js's
 * header states the rule this obeys: a composer must never pretend to reach a
 * process that cannot hear it. So the chat opens over the real conversation --
 * what the person asked for, and the reply if there ever was one -- with the
 * message box disabled and one of these sentences in its place. The actions
 * button stays, because the things that CAN still be done to an agent that
 * never started (start one under it, move it, copy its brief) all live there.
 *
 * The refusal is not rewritten here. `refused` composes the node's OWN
 * statusNote, which is the sentence the start path already wrote, so this
 * surface and the panel that reported the refusal cannot drift apart. */
export const CHAT_NOT_RUNNING = Object.freeze({
  subtitle: 'your agent · not running',
  /* Composed after the node's own refusal sentence. */
  refused: reason => `${reason} Nothing can be sent to an agent that did not start.`,
  /* No refusal on file: the start was never attempted, or the record predates
     status notes. Never says the start failed, because nothing says it did. */
  neverStarted: 'This agent is not running, so there is nothing here to send a message to. What you asked for is above, and its answer arrives here when it runs.',
})

/* CHANGING HOW HARD IT THINKS, MID-CONVERSATION (iteration 5 W10). The wire
   has no mid-session knob — depth is bound when the engine process starts —
   so the menu says what really happens: a restart that re-reads the saved
   conversation at the new depth, warned before it fires. */
/* SWITCH AND CONTINUE (owner T381, 2026-09-18: "if that account cant then pop
   up a switch accounts, then let them switch account, model (and provider),
   effort, so that they can continue. like it should be super easy.").
   ONE dialog on the circle, opened by the app when the saved account cannot
   continue and reachable from Actions at any time. The choice decides the
   route, and the route decides the cost line, so the person is told before
   pressing: the same account on another model or depth is a real resume of the
   same thread (nothing re-sent); another account or another provider is a
   fresh session that reads the saved conversation, which costs tokens. */
export const SWITCH_PANEL = Object.freeze({
  action: 'Switch and continue',
  title: 'Switch and continue',
  hint: 'Pick another account, model or depth and carry this conversation on.',
  account: 'Account',
  model: 'Model',
  effort: 'How hard it thinks',
  keepAccount: 'Keep this account',
  refused: 'refused',
  noAccounts: 'No other signed-in account is registered. Add one on the Accounts page, or pick another model or depth.',
  costResume: 'Same account: the same conversation resumes on this model and depth. Nothing is re-sent.',
  costHandoff: 'Another account or provider: a fresh session reads the saved conversation — that part costs tokens. The circle, its reports and its queued messages are kept.',
  continue: 'Continue',
  cancel: 'Not now',
  opened: 'This agent could not continue on its account. Choose how to carry on below.',
  busy: 'Wait for this agent to finish its turn before switching.',
  continuing: 'Continuing…',
  failed: 'The switch did not take. The saved conversation and queued messages are kept.',
  /* The pane beside the menu (owner T775): which circle this dialog is for,
     and its saved conversation, so a dialog that opened on its own is never a
     menu with no name on it. */
  target: 'This agent',
  targetHint: 'Its saved conversation is shown here so you can see which agent this restart is for.',
  noConversation: 'No saved messages yet.',
  targetChanged: 'This agent has changed since this was opened. Close this and open Switch and continue again from the agent.',
})

/* Which Send-next sentence is true right now. `turnRunning` is the composer's
   own busy reading; anything else is "no turn", and no turn means the words
   go when the agent is back, not when a turn finishes. */
export function movedFrontSentence({ turnRunning = false } = {}) {
  return turnRunning === true ? QUEUE_PANEL.movedFront : QUEUE_PANEL.movedFrontIdle
}

export const EFFORT_SWITCH = Object.freeze({
  /* Said when the engine changed a RUNNING thread's depth in place, which is
     the ordinary case now: no restart, nothing re-sent, nothing charged. */
  changed: depth => `Now thinking at ${depth}. Nothing was restarted and nothing was re-sent.`,
  title: 'How hard it thinks',
  help: 'Changing depth restarts this agent: a fresh session reads the saved conversation at the new depth.',
  warn: 'Restarting re-sends the saved conversation, which costs tokens.',
  go: 'Restart at this depth',
  keep: 'Keep its current depth',
})

/* MESSAGING A DEAD AGENT JUST WORKS (iteration 6, owner: "We still get this
   message" — the sessionGone refusal). The send now recovers by itself: a
   fresh agent reads the saved conversation and the typed message waits in
   the queue, visibly, until the reading turn finishes. The sentence says
   all three honest parts: what ended, what it costs, when the words go. */
export const RECOVERED_SESSION = Object.freeze({
  /* Said BEFORE the outcome is known, so it claims nothing about cost. The
     old wording promised a token-burning summary every time, which is now
     the rarer of the two paths — the engine usually still holds the thread
     and brings the same agent back for nothing. */
  reconnecting: 'That agent’s session had ended. Bringing it back now…',
  /* The fallback, said only when it really happened. */
  summarised: 'Its conversation was no longer on the computer you are driving, so a fresh agent is reading the saved summary instead — that part costs tokens. Your message goes the moment it catches up.',
  bare: 'That agent’s session had ended, so a fresh one started in its place. Your message is going now.',
})

/* THE STATE AN APP RESTART LEAVES BEHIND.
 *
 * A session is a child process, so closing ToolsEnabled ends it. The RECORD of
 * the node survives, still saying what it was doing at the moment the window
 * went away, and on the next launch that record used to be read as a running
 * agent: a ticking clock, a chip reading "starting", and a Stop button over
 * something that had stopped hours earlier.
 *
 * These are the words for what really happened. They say the session ended,
 * they say why, and each one ends with the thing to do next, because a person
 * looking at this node is looking for the way out of it. */
export const ENDED_SESSION = Object.freeze({
  word: 'stopped',
  subtitle: 'your agent · this session is no longer open',
  said: 'This session ended before the work finished. Type a message to bring it back, or use Resume with a fresh agent.',
  note: 'The agent session ended before the work finished. Start a fresh agent to continue.',
})

/* THE ACTIONS PALETTE — now the chat composer's popup. Every row is an
   action this build really performs on this node, today. What the product
   cannot do is one honest sentence in the footer, never a disabled control
   pretending — the temperature-slider rule.
   Refusal/confirmation sentences follow the house register. */
/* THE FLEET PANEL WHEN ONLY THE DECLARED RECORD IS AVAILABLE.
 *
 * Owner-visible defect, quoted from their own capture: one panel read
 * "Trees 3 / Agents in trees 10 / Working 4 / Needs review 3" and then, a few
 * lines below, "Check the fleet connection / No local agent fleet host
 * detected on this machine." It counted ten agents and denied a host in the
 * same view.
 *
 * BOTH HALVES WERE TRUE ABOUT DIFFERENT THINGS, which is why neither looked
 * wrong on its own. computers.js reads the fleet projection; when that read
 * fails it falls back to declaredFleetData(), which returns
 * `computers: [{ id: THIS_COMPUTER_ID }]` built from this machine's own org
 * record. So the counts are real and they are THIS COMPUTER'S. The sentence
 * beside them is the reason a fleet-wide report was unavailable.
 *
 * WHAT WAS ACTUALLY WRONG WAS THE HEADING. "Check the fleet connection" names
 * an action that does not exist: there is no setting that connects a fleet
 * host and no command that installs one, which is the same flat fact
 * src/first-run-needs.js keeps for its `host` need. A reader told to check a
 * connection goes looking for one. So the heading now says what the panel is
 * showing, and the body says why both numbers and absence can be true at once.
 * The provider's own reason string is still printed verbatim underneath. */
export const FLEET_DECLARED_NOTE = Object.freeze({
  title: 'These counts are this computer only',
  body: 'The numbers above are this computer\u2019s own trees, read from its record. A fleet host is what would add other computers to them.',
})

export const PALETTE_PANEL = Object.freeze({
  groupCommon: 'Common functions',
  cloud: 'Cloud swarm',
  cloudHint: 'Have this agent organize cloud workers and check their results. Optional worker limits are here; /cloud uses automatic choices.',
  cloudAuto: 'Automatic · up to 5 workers',
  cloudChoiceHint: 'Choose a limit, then send your request. The agent handles the accounts, work split, progress, and results.',
  cloudComposeHint: 'Send this request to have the agent manage a cloud swarm. Leave the request empty to use the current objective.',
  cloudQueueEdit: 'Finish editing this queued message before choosing cloud options.',
  goal: '/goal',
  goalHint: 'Set a goal and this agent keeps working toward it on its own. It stops when it reports the goal achieved, when you clear it, or when you press Stop. Type what you want done after /goal. Add an existing request ID first to also record a build-queue item.',
  goalQueueEdit: 'Finish editing this queued message before composing a goal.',
  loop: '/loop',
  loopHint: 'Set how often an agent runs. Review the setup, then press Start loop.',
  loopExample: 'Switch to this computer to set up a loop.',
  loopOpened: 'Loop setup is open. Review the interval and runs, then press Start loop.',
  loopUnavailable: 'Loop setup could not be opened. Select the agent and try again.',
  title: 'Actions',
  filter: 'Filter actions…',
  back: '‹ Agent',
  none: 'No action matches that. Clear the filter to see them all.',
  footer: 'Not possible yet, so not listed: attaching a text file’s contents — mention the file instead, and the agent reads it itself.',
  rewind: 'Rewind to one of your messages',
  rewindHint: 'Pick one of your messages; the agent forgets everything said after it.',
  switchModel: 'Switch model',
  switchModelHint: 'The change holds until you change it back; the conversation continues.',
  attach: 'Attach an image',
  attachHint: 'Opens a file picker. The picked image rides with your next message.',
  attachPicked: 'Attached. It rides with the next message you send.',
  attachCancelled: 'Nothing was attached.',
  pasteTooLarge: 'That pasted image was too large to attach. Try a smaller image, or use the attach button to pick a file.',
  pasteFailed: 'That pasted image could not be attached. Try again, or use the attach button instead.',
  mention: 'Mention a file',
  mentionHint: 'Opens a file picker and writes the path into your message. The agent reads it itself, under its own permissions.',
  /* ITS OWN SENTENCE. A cancelled mention used to say "Nothing was attached."
     which is true of a different action, and a person who had just pressed
     Mention read a sentence about Attach. */
  mentionCancelled: 'No file was mentioned.',
  mentionWritten: 'Written into your message box. Finish the sentence and send it.',
  mentionFailed: 'A file could not be mentioned. Your message is unchanged. Try Mention a file again.',
  mentionSessionUnavailable: 'This session is not open here. Use an open agent’s chat to mention a file. Your message here is unchanged.',
  clear: 'Start this conversation over',
  clearHint: 'The agent forgets everything said here. Its place in your tree and its brief stay.',
  cleared: 'Started over. It remembers nothing from before — say what you want from the message box or the queue.',
  clearFailed: 'The conversation was not restarted. Check its status before trying Start over again.',
  restartBriefFailed: 'The agent restarted, but its saved brief was not delivered. Send it a message to continue.',
  clearStopFailed: 'The conversation was not cleared because the old session was not confirmed closed. Press Stop, then try again.',
  interrupt: 'Interrupt the running turn',
  interruptHint: 'Stops what it is writing now. The session stays open.',
  interruptDone: 'Interrupted.',
  interruptMissed: 'Nothing was interrupted; the turn may already be over.',
  interruptFailed: () => 'The stop request was not confirmed. This session may still be running; try Halt again, or press Stop before starting it again.',
  stop: 'Stop this agent',
  stopHint: 'Closes the session. Queued messages are dropped; the reply it already gave stays.',
  stopped: 'Stopped. The session is closed.',
  stopFailed: 'The agent was not confirmed stopped. It may still be running; press Stop again.',
  child: 'Start an agent under this one',
  childHint: 'Opens the start panel with this agent as the parent.',
  queueFocus: 'Queue a message',
  queueFocusHint: 'Focuses the message box — while the agent works, a send waits its turn and shows above the box.',
  moveFocus: 'Change who it reports to',
  moveFocusHint: 'Opens the Reports-to menu on the Details tab.',
  copyBrief: 'Copy what you asked for',
  copyReply: 'Copy what it said',
  /* THE GROUPS, because eleven mixed-severity rows in source order put "Stop
     this agent" beside "Copy what it said". Three headings, and the one that
     ends or forgets something is last and on its own. */
  groupConversation: 'This conversation',
  groupAgent: 'This agent',
  groupDanger: 'Stop or start over',
  /* WHY A ROW CANNOT BE PRESSED, one sentence each, shown in place of the hint
     on a row that is switched off. A disabled control that will not say why is
     the exact class of thing the owner keeps filing. Each names the state and
     none of them says what to do about it, because the way out is the row
     itself becoming pressable once the state changes. */
  whyNotRunning: 'This agent is not running right now.',
  whyNotStarted: 'This agent has not started yet.',
  whyNoTurns: 'You have not sent it a message yet.',
  /* Measured 2026-08-18: after a restart this row said "You have not sent it a
     message yet." beside a panel showing four sent messages. The sent-count the
     row read is window memory and resets with the window; the saved
     conversation does not. This is the sentence for that state -- the record is
     real, and rewind's reach is not. */
  whyOnlySavedTurns: 'Your saved messages are from before this window opened, and rewind cannot reach them. Send a new message first.',
  whyNoBrief: 'Nothing was asked here yet.',
  whyNoReply: 'It has not answered yet.',
  whyNoSaved: 'There is no saved conversation to resume from.',
  whyNoPicker: 'This page cannot open a file picker. Use the installed app.',
  copied: 'Copied.',
  nothingToCopy: 'There is nothing to copy yet.',
  clipboardRefused: 'Select the text on the agent page instead — the clipboard refused this copy.',
  done: 'Done.',
})

/* Electron preserves the safe error's message, not its custom code property.
   Paste has its own two remedies, not agent-start copy. Recognize only the
   exact size-refusal token and never display any text from the error itself. */
export function pasteRefusalSentence(error) {
  const declared = typeof error?.code === 'string' ? error.code.trim() : ''
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : ''
  const code = declared || message.match(/(?:^|[^A-Za-z0-9_])(MC_AGENT_PASTE_IMAGE_TOO_LARGE|MC_AGENT_PASTE_REQUIRES_WINDOW|MC_AGENT_PASTE_UNAVAILABLE)(?=$|[^A-Za-z0-9_])/)?.[1]
  if (code === 'MC_AGENT_PASTE_IMAGE_TOO_LARGE') return PALETTE_PANEL.pasteTooLarge
  if (code === 'MC_AGENT_PASTE_REQUIRES_WINDOW' || code === 'MC_AGENT_PASTE_UNAVAILABLE') return unavailableReason(code)
  return PALETTE_PANEL.pasteFailed
}

/* A rejected picker is different from Cancel. Match only the safe code that
   survives Electron invoke; neither an error's message nor its path is copy.
   An unknown session can belong to another window, so do not promise that
   resuming this node would make that session available. */
export function mentionRefusalSentence(error) {
  const declared = typeof error?.code === 'string' ? error.code.trim() : ''
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : ''
  const code = declared || message.match(/(?:^|[^A-Za-z0-9_])(MC_AGENT_UNKNOWN_SESSION|MC_AGENT_SESSION_ENDED|MC_AGENT_DIALOG_REQUIRES_WINDOW)(?=$|[^A-Za-z0-9_])/)?.[1]
  if (code === 'MC_AGENT_UNKNOWN_SESSION' || code === 'MC_AGENT_SESSION_ENDED') return PALETTE_PANEL.mentionSessionUnavailable
  if (code === 'MC_AGENT_DIALOG_REQUIRES_WINDOW') return PALETTE_PANEL.whyNoPicker
  return PALETTE_PANEL.mentionFailed
}

/* THE QUEUE'S WORDS. The owner's ask: "can we add a que/unque for messages."
   A busy agent refuses an overlapping send by design; the queue is where the
   next message waits, visibly, until the turn completes and the view sends
   exactly one.

   WHETHER THE WORDS OUTLIVE THE WINDOW IS NOT SAID HERE ANY MORE. This copy
   used to promise "Kept only while this window is open", which stopped being
   true when src/session-outbox.js started saving the queue, and would have
   become a lie in the other direction on a computer whose storage refuses the
   write. Only the store knows which of the four states it is in, so it owns
   that sentence (persistence().sentence) and enqueue() hands it back with the
   entry. cardQueued below is what a caller says when it was given no sentence
   at all -- true in every state, and it claims nothing about saving. */
// A send rejection can follow a transport write. These preflight refusals
// prove no turn was accepted; every other code remains delivery-unconfirmed.
export function sendFailureIsUnconfirmed(code) {
  /* THE PICTURE REFUSALS ARE PREFLIGHT, AND THAT WAS MEASURED, NOT ASSUMED.
     ClaudeCliAdapter.sendTurn builds every image block BEFORE it installs the
     turn -- its own note says so, "a refused picture leaves no turn behind to
     time out" -- and a 4 321 918-byte PNG against the real adapter on
     2026-09-16 produced CLAUDE_CLI_IMAGE_TOO_LARGE with `transport writes: 0`.
     Nothing was written, so nothing is unconfirmed; calling it unconfirmed
     would pause automatic sending and tell the person to go and check a
     conversation the message never entered. */
  return !['AGENT_TURN_ACTIVE', 'MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED', 'AGENT_SESSION_UNKNOWN', 'AGENT_SESSION_ENDED', 'MC_AGENT_FOREIGN_SESSION', 'MC_AGENT_NOT_OWNER', 'AGENT_INVALID_INPUT'].includes(code)
    && pictureSendRefusalSentence(code) === null
}

/* A REFUSAL THAT WAS ABOUT THE PICTURE HAS TO SAY SO.
 *
 * MEASURED 2026-09-16 against the real adapter: a 4 321 918-byte PNG -- inside
 * the 8 MiB the app's own paste door accepts -- came back from
 * ClaudeCliAdapter.sendTurn as CLAUDE_CLI_IMAGE_TOO_LARGE with zero transport
 * writes, so the person lost the picture AND their words. shell/main.cjs
 * rendererSafeAgentError keeps only the CODE, so the adapter's own "A picture
 * may be at most 3000000 bytes" never reaches the window, and every one of
 * these fell through to "Check that this agent is still available, then try
 * again" -- about an agent that was available, advising a retry that does the
 * same thing forever. The owner's report was "sending images doesnt work".
 *
 * Each row below is one adapter refusal code, and each says the ONE thing a
 * person can act on. They are deliberately not one sentence: "too large" and
 * "not a picture" need different next moves. The engine's own ceiling is not
 * quoted as a number here -- only the code crosses the boundary, and a number
 * written twice is how the app's cap and the engine's came to disagree at all.
 *
 * The attachment doors now refuse an over-size picture BEFORE the send
 * (shell/agent-command-surface.cjs pictureTooLargeToDeliver), which is where a
 * person should meet this. These stay as the backstop for what that door cannot
 * measure: a held paste bound to a session later, a file changed on disk after
 * it was attached, a picture a future provider refuses for its own reason. */
const PICTURE_REFUSALS = Object.freeze({
  CLAUDE_CLI_IMAGE_TOO_LARGE: 'That picture is too large for this agent to read, so nothing was sent — not your message either. Send a smaller copy.',
  CLAUDE_CLI_IMAGE_EMPTY: 'That file holds no picture, so nothing was sent. Attach the picture again.',
  CLAUDE_CLI_IMAGE_NOT_AN_IMAGE: 'That file is not a picture this agent can read, so nothing was sent. Attach a PNG, JPEG, GIF or WebP.',
  CLAUDE_CLI_IMAGE_UNREADABLE: 'That picture could not be read from disk, so nothing was sent. Check the file is still there, then attach it again.',
  CLAUDE_CLI_IMAGE_PATH_INVALID: 'That picture could not be read from disk, so nothing was sent. Check the file is still there, then attach it again.',
  CLAUDE_CLI_IMAGE_INVALID: 'That file is not a picture this agent can read, so nothing was sent. Attach a PNG, JPEG, GIF or WebP.',
  CLAUDE_CLI_IMAGE_REMOTE_UNSUPPORTED: 'This agent can be sent a picture from this computer, not one named by web address, so nothing was sent.',
  CLAUDE_CLI_IMAGES_UNSUPPORTED: 'This agent cannot look at pictures, so nothing was sent. Start an agent that can, or describe what is in the picture.',
  ACP_IMAGE_UNSUPPORTED: 'This agent cannot look at pictures, so nothing was sent. Start an agent that can, or describe what is in the picture.',
  ACP_IMAGE_INVALID: 'This agent cannot look at pictures, so nothing was sent. Start an agent that can, or describe what is in the picture.',
  AGY_CLI_IMAGES_UNSUPPORTED: 'This agent cannot look at pictures, so nothing was sent. Start an agent that can, or describe what is in the picture.',
  LOCAL_NODE_IMAGES_UNSUPPORTED: 'This agent cannot look at pictures, so nothing was sent. Start an agent that can, or describe what is in the picture.',
  /* THE ONE REFUSAL ONLY A PICTURE CAN CAUSE, AND THE ONLY ONE `agent:send`
     RAISES IN ITS OWN BODY. shell/agent-command-surface.cjs checks every
     `request.images` path against the session's own allowlist and, for a path
     that session never issued, throws before sendTurn is called at all: "An
     attached file was not picked in this session, so nothing was sent". The
     window disagreed with the shell about what had just happened -- with no
     row here the code fell through to sendFailureIsUnconfirmed's TRUE branch,
     so the composer read "This message's delivery could not be confirmed" for
     a message that never entered a conversation, and marked the send
     unconfirmed, which pauses automatic sending. Neither half named a picture,
     and retrying restores the same chip and refuses the same way for ever:
     "sending images doesnt work", in the product's own words.
     A row here fixes both halves at once, because sendFailureIsUnconfirmed
     already reads this table to decide what was written. */
  MC_AGENT_ATTACHMENT_UNKNOWN: 'That picture was not attached in this conversation’s current session, so nothing was sent — not your message either. Remove the picture, attach or paste it again here, then send.',
})

export function pictureSendRefusalSentence(code) {
  return (typeof code === 'string' && PICTURE_REFUSALS[code]) || null
}

export function sendRefusalSentence(code) {
  if (code === 'CODEX_PROTOCOL_INVALID') return 'The agent connection stopped responding correctly. This message’s delivery could not be confirmed. Check the conversation before retrying or resuming the agent.'
  if (code === 'AGENT_TURN_ACTIVE') return 'The agent is still finishing its current turn. Your message remains queued.'
  const picture = pictureSendRefusalSentence(code)
  if (picture) return picture
  if (!sendFailureIsUnconfirmed(code)) return 'The message was not sent. Check that this agent is still available, then try again.'
  return 'This message’s delivery could not be confirmed. Check the conversation before trying again.'
}

export const QUEUE_PANEL = Object.freeze({
  unconfirmed: 'Delivery unconfirmed; automatic sending paused. Check the conversation before retrying.',
  retryUnconfirmed: 'Retry send',
  /* THE NAMED HOLD A SEND NOW LANDS IN WHEN THE AGENT NEVER REPORTS IDLE.
     The composer waits a bounded time (its release budget) for the stopped
     turn to actually release; past that it neither stalls silently nor
     bounces the words back with a refusal. The row says which state it is in
     and keeps its two doors, Retry send and Unqueue. The words are still
     queued and still go on their own at the next turn boundary, which is why
     this sentence promises that and nothing stronger. Keyed by the reason the
     store carries on the entry, so a row can only claim a hold the store
     actually recorded. */
  heldReasons: Object.freeze({
    SEND_NOW_RELEASE_BUDGET: 'Held: the agent has not released its turn yet. It goes when the turn ends, or press Retry send.',
  }),
  blockedUnconfirmed: 'Check the message with unconfirmed delivery, then retry or unqueue it before automatic sending continues.',
  title: 'Waiting to send',
  placeholder: 'Write the next message…',
  queue: 'Queue',
  unqueue: 'Unqueue',
  note: 'Sends by itself when the agent finishes its current turn.',
  sentNext: 'Sent the next queued message.',
  /* Unqueue puts the words back in the box. When the box already holds a
     draft, that draft is the person's too and is not overwritten -- the
     unqueued words are said here instead, so neither text is lost. */
  unqueuedIntoNote: 'Took this back out of the queue. The box already had a draft, so the message is here instead:',
  cardQueued: 'Queued — sends by itself when this turn finishes.',
  /* NAME A CONTROL THIS BUILD ACTUALLY DRAWS. This said "Choose Resume" and no
     control anywhere was named Resume: the only Resume-named row is "Resume
     with a fresh agent", a DIFFERENT act (a new agent, the saved conversation
     re-sent, tokens spent). The controls that really bring this agent back
     are another send, which queues and starts a resume, and the switch dialog
     on the circle (SWITCH_PANEL.action below), which is what the app opens
     when the saved account cannot continue. Both are named; the fresh-agent
     route is left as the separate, costlier thing it is. */
  waitingForResume: 'Your message has not been sent and stays in the queue. Send another message to bring this agent back, or use Switch and continue on the circle to pick another account, model or depth.',
  turnBecameBusy: 'The agent was still finishing its current turn, so this message is next and will send automatically.',
  busyAttachment: 'The agent became busy before this message could go. The file is still attached; send again when this turn finishes.',
  heldAttachment: 'Send this message when the current turn finishes. Your text and file are still in the composer.',
  /* "NOTHING RETRIES IT ON ITS OWN" IS THE PROMISE THAT WAS WRONG, AND IT
     ASKED FOR THE ONE THING THIS STORE REFUSES TO RISK.
     The previous sentence ended "send it again when you are ready". The row
     carries no plain Send door (the owner removed it, W18c), so "send it
     again" reads as: type the words a second time. Meanwhile the refused
     entry is back at the FRONT (session-outbox.js requeueFront, `unshift`)
     and IS taken by the ordinary boundary drain -- takeNext's skip is
     `entry.deliveryUnconfirmed !== true`, and this sentence is only ever
     shown on the branch where `unconfirmed` is FALSE (computers.js
     drainOutboxMessage; the unconfirmed branch says queuedSendRefusalSentence
     instead). So the old sentence talked a person into delivering one
     instruction twice -- exactly the duplicate takeNext's own note refuses a
     timeout-retry to avoid ("a duplicated instruction is not [recoverable]").
     Measured at the lane tip 2026-09-19.
     What stays true from the old comment: nothing STARTS a turn for it. The
     drain fires from a turn completing (the turn-completed branch), from a
     successful resume, from a reconnect whose last turn succeeded, and from
     queueForSession at an idle node -- never from a timer. So the sentence
     promises the boundary and names the door that does not wait for one. */
  notSent: 'The queued message did not reach the agent, so it is back at the front of the queue. It goes automatically when this agent next finishes a turn. It does not start a turn itself. Press Send now on the row to send it straight away, or unqueue it.',
  emptyQueueCommand: 'Write the message after /queue, and it will wait its turn.',
  /* THE UP-ARROW WALK MUST NOT BECOME A THIRD DOOR PAST THE COMMAND PARSE.
     Every other way into this outbox parses slash commands first, on purpose:
     `/goal`, `/Request…` and `/interrupt` are acts this app performs, and a
     queued message is DRAINED STRAIGHT TO THE MODEL when the turn ends, so a
     command written into a waiting message would arrive at the agent as
     ordinary text with the parse skipped. Rewriting a queued message into a
     command is refused by name, and the message keeps the words it had. */
  commandNotAWaitingMessage: 'A command is not a waiting message. Unqueue this one, then type the command in the box.',
  /* THE PROMOTE DOOR'S ANSWERS. A turn is running, so the words cannot go
     into it -- the engine refuses an overlapping send by design -- and the
     only thing "first" can honestly mean is the head of the queue. Said out
     loud, because a row that silently changes place is a control a person
     cannot check.

     TWO SENTENCES, BECAUSE THE DOOR IS REACHABLE IN TWO STATES. The comment
     above assumed a turn was always running when this fires; the strip's row
     controls are drawn on an IDLE session too. MEASURED 2026-09-18: pressed on
     an idle agent, the product answered "it goes the moment this turn finishes"
     with no turn running and nothing that would start one. A sentence that
     describes a turn the person does not have is worse than no sentence -- they
     wait for an event that is not coming. `movedFrontIdle` says what is
     actually true in that state. */
  movedFront: 'Moved to the front — it goes the moment this turn finishes.',
  /* THE SAME DOOR WITH NO TURN RUNNING. A queued row exists at an idle agent
     too -- the resume was refused, or the session ended -- and "the moment this
     turn finishes" then names a turn that does not exist. movedFrontSentence
     below chooses between the two. */
  movedFrontIdle: 'Moved to the front. This agent is not running anything right now, so it waits here until its next turn finishes.',
  moveGone: 'That message is not waiting any more, so there was nothing to move.',
  /* QUEUED WITH NOTHING TO WAIT BEHIND. drainOutboxMessage's own note has
     always named this caller ("and from the queue strip when a person queues
     at an idle session") and there was none: /queue at an idle agent answered
     "sends by itself when this turn finishes" and parked the words in a queue
     only a turn COMPLETION drains -- and no turn was running to complete. It
     goes now instead, and the answer says which of the two happened. */
  cardQueuedIdle: 'Nothing was running to wait behind, so it went now.',
})

/* THE REWIND MENU. The engine forks the conversation at one of the person's
   own turns — proven live before this shipped (tools/agent-rewind-probe.mjs:
   the fork remembered everything up to the picked turn and nothing after).
   The menu lists the person's own words, which is the only honest way to name
   a point in time they can recognise. */
export const REWIND_PANEL = Object.freeze({
  title: 'Rewind',
  help: 'Pick one of your messages. The agent keeps everything up to it and forgets everything after it.',
  button: 'Rewind',
  done: 'Rewound. The agent remembers everything up to that message and nothing after it.',
  busy: 'Interrupt the running turn first — a rewind needs the agent idle.',
  empty: 'Send a message first; your messages appear here to rewind to.',
  failed: 'The rewind did not happen; the conversation is unchanged. Try once more.',
  /* A PERMANENT refusal is not a retry. MEASURED on the shipped build,
     2026-08-19: rewinding a Claude session always fails -- the host rewinds by
     forking the thread and that engine cannot fork (CLAUDE_CLI_FORK_UNSUPPORTED,
     shell/agent-host.cjs rewindSession) -- and the sentence above told the
     person to try once more, forever. This one says what is true and names the
     door that does work. */
  cannotFork: 'This agent runs on an engine that cannot rewind a conversation, so nothing was changed. To continue from the saved conversation, use "Resume with a fresh agent" in this menu.',
})

/* Permission choices come from the running provider. Native option ids are
   opaque; their protocol kind supplies the human-visible scope. Both the
   chat strip and tree rail use these same words. */
export const APPROVAL_PANEL = Object.freeze({
  waiting: count => `${count} permissions waiting. Answering this one shows the next.`,
  title: 'It is asking permission',
  command: prefix => `It wants to run: ${prefix}`,
  file: 'It wants to change files.',
  tool: title => `It wants to use: ${title}`,
  toolInputs: inputs => `Inputs: ${inputs}`,
  generic: 'It is asking to go further.',
  answered: 'Your choice was sent.',
  refused: 'Refused. The tool was not run.',
  failed: 'The answer did not land; the agent is still waiting. Press a choice again.',
  ended: 'This permission is no longer waiting. Your choice could not be confirmed.',
  /* THE CARD MUST NEVER STAND EMPTY. A request whose choices this build cannot
     send back is a question nobody can answer, and an empty row of buttons says
     nothing about why. This sentence names the refusal and names the door that
     does work, because the agent really is still stopped. */
  unanswerable: 'This build cannot answer this kind of request from here, so the agent is stopped on it. Stop the turn to release it.',
  words: Object.freeze({
    accept: 'Allow once',
    acceptForSession: 'Allow for this session',
    decline: 'Refuse',
    cancel: 'Cancel this step',
  }),
  permissionWords: Object.freeze({
    allow_once: 'Allow once',
    allow_always: 'Always allow',
    reject_once: 'Refuse',
    reject_always: 'Always refuse',
  }),
})

export function approvalDecisionIsReject(decision, decisionKinds = {}) {
  const kind = decisionKinds && Object.hasOwn(decisionKinds, decision) ? decisionKinds[decision] : null
  if (kind === 'reject_once' || kind === 'reject_always') return true
  return decision === 'decline' || decision === 'reject-once' || decision === 'refuse'
}

export function approvalAnswerSentence(decision, decisionKinds = {}) {
  return approvalDecisionIsReject(decision, decisionKinds) ? APPROVAL_PANEL.refused : APPROVAL_PANEL.answered
}

export function approvalDecisionWord(decision, decisionKinds = {}) {
  const kind = decisionKinds && Object.hasOwn(decisionKinds, decision) ? decisionKinds[decision] : null
  if (Object.hasOwn(APPROVAL_PANEL.permissionWords, kind)) return APPROVAL_PANEL.permissionWords[kind]
  if (Object.hasOwn(APPROVAL_PANEL.words, decision)) return APPROVAL_PANEL.words[decision]
  return String(decision || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

/* THE CHOICES THIS BUILD'S REPLY PATH CAN ACTUALLY CARRY.
 *
 * The reply is one word: shell/agent-command-surface.cjs bounds `decision` to a
 * 512-character string and shell/agent-host.cjs sends it as
 * `response: {decision}`. Two of the engine's own command decisions are refused
 * BY NAME in that spelling -- src/lib/agent-engine/codex-adapter.js,
 * commandDecision(): "Structured command approval decisions require their
 * generated response payload" for acceptWithExecpolicyAmendment and
 * applyNetworkPolicyAmendment. A button for either could only ever come back
 * CODEX_APPROVAL_INVALID, so the card would keep telling a person to press a
 * choice again forever.
 *
 * This is the drawn-control rule this product already enforces elsewhere
 * (tools/test/settings-rows-do-something.test.mjs): a control that cannot
 * succeed is not drawn, and its absence is explained rather than left blank.
 * Nothing here widens anything -- it only removes presses that provably fail.
 *
 * Returns the pressable identifiers and, when there are none, the sentence the
 * card shows in their place. */
const STRUCTURED_DECISIONS_NEEDING_A_PAYLOAD = Object.freeze([
  'acceptWithExecpolicyAmendment',
  'applyNetworkPolicyAmendment',
])

export function approvalCardChoices(availableDecisions, decisionKinds = {}) {
  const offered = Array.isArray(availableDecisions) ? availableDecisions : []
  const decisions = offered.filter(decision => typeof decision === 'string'
    && decision.length > 0 && decision.length <= 512
    && (!STRUCTURED_DECISIONS_NEEDING_A_PAYLOAD.includes(decision)
      || (decisionKinds && Object.hasOwn(decisionKinds, decision)
        && Object.hasOwn(APPROVAL_PANEL.permissionWords, decisionKinds[decision])))).slice(0, 32)
  return Object.freeze({
    decisions: Object.freeze(decisions),
    note: decisions.length === 0 ? APPROVAL_PANEL.unanswerable : '',
  })
}

/* THE MODEL MENU on a running conversation. Codex accepts a model per turn, so
   switching is real there and the conversation continues — this is not the
   respawn semantics of starting a new agent. Every tier is shown so a person
   can see what exists, and the ones this conversation cannot move to say why.

   WHAT THIS COMMENT USED TO CLAIM, and it is worth keeping the correction
   visible. It said Claude rows are "refused honestly when picked, exactly like
   the start menu". Neither half survived measurement (2026-08-20): the rows
   were not pickable at all — they were drawn disabled and labelled "Claude —
   cannot start here yet" — and the start menu no longer refuses Claude, because
   the payload now carries the engine. See sessionModelChoices() below. */
export const MODEL_PANEL = Object.freeze({
  title: 'What it runs on',
  currentDefault: 'Runs on the model its tier chose when it started.',
  /* STICKY, and the sentence says so. The override map keeps the choice until
     a person changes it back — "your next message" implied one message and
     then a revert, which is not what the mechanism does, and clearing the map
     after one send to match the words would have made the menu's selected
     state lie in the other direction. The words follow the mechanism. */
  next: model => `Messages run on ${model} until you change it back. The conversation continues.`,
  keep: 'Keep the tier’s model',
  /* OWNER REQUEST T137 (2026-09-16): a model the running thread cannot take in
     place -- every Claude model, every other provider -- is reached by
     continuing the conversation in a fresh session on that tier, from the same
     handoff "Continue on another account" sends. The words say what ends and
     what stays, because a person pressing this is ending a session. */
  continueOn: label => `Continue on ${label}`,
  continueHint: (fromWord, toLabel) => `Starts a fresh session on ${toLabel} from a handoff of this conversation. This agent keeps its name, its place on the tree, its reports and its saved conversation; the ${fromWord} session ends.`,
  continueBusy: 'Wait for this agent to finish its turn, then switch.',
})

/* WHICH PROVIDERS CAN CHANGE MODEL WITHOUT RESTARTING, as a property of the
 * ENGINE rather than a preference.
 *
 * Codex reads a per-turn model: the host forwards `options.model` and the
 * adapter passes it to the running thread.
 *
 * Claude does not, and this is not an oversight to be worked around. The CLI is
 * spawned once with `--model <alias>` (claudeArgs() in the payload's
 * claude-cli-adapter.js) and its sendTurn() destructures `{ threadId, text,
 * images }` — `options` is validated by the engine contract and then never
 * read. So an "enabled" Claude row would not switch anything; it would tell the
 * person their messages now run on another model while the child process went
 * on running the one it was launched with. A row that silently does nothing is
 * the worst of the three possible answers, worse than refusing, because it
 * cannot be noticed.
 *
 * `local` is the SAME SHAPE as Claude, and this file used to say otherwise.
 * What stood here until 2026-09-19 read "`local` has no interactive runner in
 * this copy at all — the shell refuses it at start (resolveStartTier)". That
 * sentence outlived the runner. The payload carries
 * src/lib/agent-engine/local-node-process.js exporting BOTH startLocalSession
 * and resumeLocalSession, shell/agent-host.cjs lists `local` in START_TIERS,
 * and resolveStartTier() returns that row on the same terms as every other
 * provider — `if (row.provider === 'local' && localEngine) return row`. So a
 * conversation CAN be continued on it. What local shares with Claude is only
 * the narrow fact: local-node-adapter.js sendTurn() destructures
 * `{ threadId, text, images }`, so no model can be taken in place mid-thread.
 * The cost of the stale sentence was a whole provider missing from the switch
 * menu on a build that ships it, which is owner request R1238. No provider is
 * named when deciding what can start any more — see sessionModelChoices(). */
const PROVIDERS_THAT_SWITCH_MID_THREAD = Object.freeze(['codex'])

const MODEL_SWITCH_REFUSAL = Object.freeze({
  /* The cross-provider and bound-at-start refusals that stood here until
     2026-09-16 are gone: owner request T137 turned both cases into
     continuation rows (sessionModelChoices below), so the only refusals left
     are the three that are still true. */
  /* WHAT THIS COPY CANNOT START, asked of the shell rather than asserted from a
     provider name. What stood here was a `local:` sentence claiming a missing
     interactive runner, printed under every local row on a payload that ships
     one; it was the only reason `local` could never be continued to. The
     authority on this is resolveStartTier(), and startableTiers() runs that
     exact function, so a row drawn from its answer and the press behind the row
     cannot disagree. */
  notStartable: label => `This copy cannot start ${label}, so this conversation cannot be continued on it.`,
  /* AND "NOBODY HAS ANSWERED YET", which is a different fact and gets a
     different sentence -- the same distinction tierChoicesFor() already draws
     between TIER_CANNOT_START_HERE and TIER_ANSWER_UNKNOWN. Claiming a build
     lacks a feature it ships, because a local call had not returned, is the
     mistake the line above just finished paying for. */
  startUnknown: label => `This screen has not been told yet whether ${label} can start here, so it is not offering to continue on it.`,
  /* PESSIMISTIC BY CONSTRUCTION. An older node record carries no tier, so this
     menu cannot know which program is on the other end. Guessing would mean
     offering a switch that may be a silent no-op, which is the exact defect
     this function exists to end. */
  unknownTier: 'This conversation did not record which model it started on, so it cannot be switched. Start a new agent to choose one.',
  /* THE ROW FOR THE MODEL IT IS ALREADY ON, when that model cannot be switched
     in place: not a refusal of anything, just the fact. */
  current: label => `This conversation is running on ${label} now.`,
})

/**
 * The "What it runs on" rows for a conversation that is ALREADY RUNNING, and
 * the honest reason under every row it may not use.
 *
 * THE DEFECT THIS CLOSES, measured 2026-08-20 on the shipped build. These rows
 * were built inline in src/views/computers.js from two hardcodes: a label
 * reading `Claude — cannot start here yet` and `enabled: tier.provider ===
 * 'codex'`. The label states something false about the product — the shell's
 * own startableTiers(), constructed over release/win-unpacked's payload,
 * answers ["luna","terra","sol","claude-fable","claude-sonnet","claude-opus"] —
 * and it answers a question these rows are not asking, since they set a
 * per-turn override rather than starting anything.
 *
 * IT GATES ON THE SESSION'S PROVIDER, NEVER ON A PROVIDER NAME. The old test
 * was `tier.provider === 'codex'` with no reference to the conversation at all,
 * which is upside down the moment Claude sessions exist: it would refuse
 * sonnet→opus on a Claude conversation while permitting `gpt-5.6-luna` on that
 * same conversation, because that row's provider happens to be the one string
 * the check allowed. The only combination it let through was the impossible
 * one.
 *
 * Every tier still gets a row. Hiding the models a person cannot pick would
 * leave them wondering whether the product has them; showing them with the
 * reason underneath is how the rest of this menu already behaves.
 */
export function sessionModelChoices(sessionTierId, { startable = null, answered = true } = {}) {
  const session = LAUNCH_TIERS.find(tier => tier.id === sessionTierId) || null
  const sessionWord = session ? (TIER_PROVIDER_WORDS[session.provider] || session.provider) : null
  const canSwitch = Boolean(session) && PROVIDERS_THAT_SWITCH_MID_THREAD.includes(session.provider)
  /* WHAT THIS COPY CAN REALLY START, when the caller has asked the shell.
     `null` -- the default -- means nobody asked, and it gates nothing: a caller
     written before this parameter existed, or a screen whose probe has not
     landed, keeps exactly the rows it had. An array, INCLUDING AN EMPTY ONE, is
     an answer and is honoured; that is the same rule startableTierAnswer()
     applies, and it is why this takes a list rather than a boolean. */
  /* `answered` GUARDS THE LIST, and that pairing is the whole correctness of
     this parameter. A caller's pre-answer list is TREE_DEFAULT_STARTABLE_TIERS
     -- the four Codex tiers -- which is the right pessimistic default for a
     menu that STARTS something and the wrong one for a menu that would REMOVE
     a row. Reading the list before the shell spoke deleted the working
     "Continue on Opus · Claude" row outright; t158-cross-provider-model-switch
     caught it. Unanswered therefore gates nothing at all. */
  const startableIds = answered && Array.isArray(startable) ? new Set(startable) : null

  return Object.freeze(LAUNCH_TIERS.map(tier => {
    const word = TIER_PROVIDER_WORDS[tier.provider] || tier.provider
    const label = `${tier.label} · ${word}`
    const enabled = canSwitch && tier.provider === session.provider
    /* OWNER REQUEST T137 (2026-09-16 02:58Z): "switch models still doesnt work.
       and it should work for even different providers because we can just hand
       the context to the next agent." A row the thread cannot switch to in
       place is offered as a CONTINUATION instead of a refusal: a fresh session
       on that tier, started from the same handoff an account continuation
       sends (src/manual-account-continuation.js manualModelHandoff). What stays
       refused is what is still true: an unrecorded tier cannot be continued
       from (nothing says what it was), and the row for the model it already
       runs on is a fact rather than a switch.

       OWNER REQUEST R1238 (2026-09-19): "why cant i choose to switch models
       between codex or claude or local or grok or gemini mid session. this was
       built. why does the button hide now it needs to work." The provider name
       is out of this test. `tier.provider !== 'local'` stood here as the last
       hardcode, and it was wrong in exactly the way the paragraph above this
       function warns about -- it answered "can this tier run" from a name
       rather than from the shell, and it had been wrong since the payload
       started carrying local-node-process.js. A row is a continuation when the
       thread cannot take it in place AND this copy can actually start it. That
       admits local, gemini and grok on a build whose payload carries their
       engines, keeps refusing them with a true sentence on one that does not,
       and needs no edit here when a provider is added. */
    const startsHere = startableIds ? startableIds.has(tier.id) : tier.provider !== 'local'
    const continuation = Boolean(session) && !enabled && tier.id !== session.id && startsHere
    let disabledHint = ''
    if (!enabled && !continuation) {
      if (!session) disabledHint = MODEL_SWITCH_REFUSAL.unknownTier
      /* The session's own row first: "you are already here" is true whether or
         not the tier is startable, and it is the more useful of the two. */
      else if (tier.id === session.id) disabledHint = MODEL_SWITCH_REFUSAL.current(label)
      else disabledHint = answered ? MODEL_SWITCH_REFUSAL.notStartable(label) : MODEL_SWITCH_REFUSAL.startUnknown(label)
    }
    return Object.freeze({
      id: tier.id,
      model: tier.model,
      label,
      enabled,
      disabledHint,
      continuation,
      continuationHint: continuation ? MODEL_PANEL.continueHint(sessionWord, label) : '',
    })
  }))
}

/* THE RUNNING NARRATION, one line at a time. The engine says what it is doing
   -- a command starts, a command finishes, a file changes, an approval is
   wanted -- and this turns that data (sessionActivityEvent in
   src/agent-session-events.js) into one plain line for the rail. A command is
   the person's own machine doing something, so the command TEXT rides in the
   line as data, bounded so a long script cannot swallow the rail. */
const ACTIVITY_COMMAND_MAX = 120

/* THE SAME NARRATION, AS A ROW RATHER THAN A LINE.
 *
 * activityLine above answers "what is it doing right now" and is overwritten by
 * the next event. A chat row is the opposite: it stays, it is one of many, and
 * it has to keep reading correctly hours later. So it is three short pieces
 * rather than a sentence -- the tool's own name, the thing it was pointed at,
 * and what became of it.
 *
 * THE TOOL NAMES ARE THE ENGINES' OWN and are not shown raw. codex says
 * `commandExecution`; the Claude CLI says `Bash`. Neither is a word a person
 * asked for, so each known one has a plain name here and an unknown one falls
 * back to a word that is true of all of them. */
const ACTION_TOOL_WORDS = Object.freeze({
  commandExecution: 'Command',
  fileChange: 'Edit',
  mcpToolCall: 'Tool',
  call_mcp_tool: 'Tool',
  dynamicToolCall: 'Tool',
  Bash: 'Command',
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  Glob: 'Search',
  Grep: 'Search',
  WebFetch: 'Web',
  WebSearch: 'Web',
  Task: 'Helper',
  command: 'Command',
  other: 'Tool',
})

const ACTION_STATE_WORDS = Object.freeze({
  working: 'running',
  done: 'finished',
  /* "did not finish" rather than a failure word: this is a row label, and a
     bare failure word with no way forward is the dead end the words gate is
     there to catch. The command and its output are one press away, which is
     where a person can actually see what happened. */
  undone: 'did not finish',
  /* NOT "did not finish", BECAUSE IT NEVER STARTED. The engine declined the
     command before running it -- on a fresh profile every shell command a real
     agent tries comes back this way (measured 2026-08-20). Four identical red
     "did not finish" rows against `node --version` sent a reader looking for a
     fault in their own commands; the truth is that this computer would not let
     the agent run one. A person has to be able to tell a refusal from a crash
     at a glance, so the word differs and so does the edge colour: the amber it
     shares with "waiting for you", because both are about permission, while
     red stays for things that genuinely broke. */
  refused: 'refused',
  waiting: 'waiting for you',
  closed: 'no longer waiting',
  /* THE OUTCOME NOBODY MEASURED. The turn ended and this call's result never
     arrived, so the only two words that would fit the slot are both untrue:
     "finished" invents a success and "did not finish" invents a failure. The
     row says the thing that is actually known. Kept in the neutral edge colour
     for the same reason -- green would claim it went well, red would send a
     person hunting a fault that may not exist. See settleUnfinished() in
     src/agent-session-events.js for when a row lands here. */
  unknown: 'no result came back',
})

/* THE COMMAND, NOT ITS DELIVERY VAN. On Windows the codex engine runs every
   shell line as
     "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '...'
   so every command row in a chat opened with the same fifty-six characters of
   wrapper and the part a person asked about was past the ellipsis — measured
   on a staged packaged build 2026-08-20, where two different commands drew
   two visually identical rows. The row is a summary, so it shows what the
   agent ran; the full line, wrapper and all, stays in the opened body and the
   hover title, because the summary must never be the only record.

   RECOGNISED, NEVER GUESSED: the first token must BE a known shell (by its
   basename), the flags between it and the command text must be from the short
   known list, and the command-carrying flag must be present. Anything else
   comes back untouched — a path, a URL, or a shell line in a spelling this
   has not measured is shown exactly as it arrived. */
const SHELL_NAMES = Object.freeze(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'bash', 'bash.exe', 'sh', 'sh.exe', 'zsh'])

export function commandSummary(command) {
  if (typeof command !== 'string' || command.length === 0) return command
  const first = /^\s*(?:"([^"]+)"|(\S+))\s+([\s\S]+)$/.exec(command)
  if (!first) return command
  const executable = (first[1] || first[2] || '').split(/[\\/]/).pop().toLowerCase()
  if (!SHELL_NAMES.includes(executable)) return command
  let rest = first[3]
  for (;;) {
    const flag = /^(?:-NoProfile|-NonInteractive|-NoLogo|-ExecutionPolicy\s+\S+|\/d|\/s|-l)\s+/i.exec(rest)
    if (!flag) break
    rest = rest.slice(flag[0].length)
  }
  const intro = /^(?:-Command|-lc|-c|\/c)\s+/i.exec(rest)
  if (!intro) return command
  rest = rest.slice(intro[0].length).trim()
  const quoted = /^'([\s\S]*)'$/.exec(rest) || /^"([\s\S]*)"$/.exec(rest)
  const bare = (quoted ? quoted[1] : rest).trim()
  return bare.length > 0 ? bare : command
}

/* AN MCP TOOL CARRIES ITS OWN NAME, in its own spelling: mcp__<server>__<tool>.
   MEASURED on the shipped build (2026-08-19): a child's two calls to
   mcp__toolsenabled__agent_comms_send_local each drew "Step Step finished" --
   raw name unrecognised, detail empty, fallback word in both slots -- so the
   one thing a person wanted from the row (WHICH tool ran) was the one thing it
   left out. The name is used as the DETAIL fallback only; a detail the event
   did carry still wins. */
const MCP_TOOL_NAME = /^mcp__([^_].*?)__(.+)$/

export function actionRowWords(row) {
  if (!row || typeof row !== 'object') return { tool: 'Step', detail: '', state: '' }
  const raw = typeof row.tool === 'string' ? row.tool : ''
  const mcp = MCP_TOOL_NAME.exec(raw)
  /* A dotted id is one of the product's own tools, reached by the local
     model under that exact name (memory.set, agent_comms.send_local). */
  const product = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(raw)
  const tool = ACTION_TOOL_WORDS[raw]
    || (mcp || product ? 'Tool' : (row.kind === 'approval' ? 'Approval' : (row.kind === 'thinking' ? 'Thinking' : 'Step')))
  /* The summary drops a recognised shell wrapper (see commandSummary above);
     details that are not wrapped shell lines pass through untouched. */
  let detail = commandSummary(typeof row.detail === 'string' ? row.detail : '')
  if (detail.length === 0 && mcp) detail = `${mcp[2]} · ${mcp[1]}`
  return {
    tool,
    detail: detail.length > ACTIVITY_COMMAND_MAX ? `${detail.slice(0, ACTIVITY_COMMAND_MAX)}…` : detail,
    state: Object.hasOwn(ACTION_STATE_WORDS, row.state) ? ACTION_STATE_WORDS[row.state] : ACTION_STATE_WORDS.unknown,
  }
}

/* THE RECORD ADMITS WHAT IT COULD NOT KEEP. A saved conversation is an
   excerpt with bounds, and when those bounds really bite the shortened version
   must not be shown as if it were the whole thing. */
export const TRANSCRIPT_TRIMMED_NOTE = 'Some older messages were left out so the newest ones would fit.'

/* AND A CONVERSATION LONGER THAN THE CHAT SHOWS SAYS SO TOO (T1404). The chat
   holds the newest page of a saved conversation; the rest is kept on disk and
   read in Saved conversation. Without this line a reopened conversation of 150
   messages started at message 91 with nothing above it, and Search found
   nothing older, as if the first 90 had never been said. */
export const TRANSCRIPT_OLDER_NOTE = 'Older messages are not shown or searched here. They are kept in Saved conversation.'
export const TRANSCRIPT_OLDER_DOOR = 'Open Saved conversation'

/* THE HEADING OVER THE TREE'S OWN WORDS IN A CONVERSATION. The address block
   rides with every tree start as its own entry (the person can see everything
   a session was given), and without a name of its own it wore the person's
   "YOU" — a wall of plumbing attributed to them. Three plain words say whose
   words they are; the entry itself stays whole. */
export const TREE_CONTEXT_LABEL = 'added by the tree'
export const TREE_PREVIEW_OPEN = 'Open side chat'

/* THE CLOSED LINE, WHICH HAS TO EARN THE PRESS.
 *
 * The aside is folded shut by default because it measured 298px in a 371px log
 * -- a first-timer's first screen of their first conversation was internal
 * plumbing. A fold nobody opens is no better, so the line says what is inside
 * in the person's own words and how much of it there is. The size is in WORDS
 * because that is the unit a person reads in; characters would be the
 * program's unit, not theirs. */
export function treeContextSummary(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return `what the tree told this agent when it started · ${words} words`
}

/* A CONVERSATION CONTINUED ON ANOTHER ACCOUNT, IN ONE LINE. The handoff its new
   session started from is the product's words, not the person's, and it can run
   to 48,000 characters; folded, it reads as one status line, and the whole text
   stays one press away. */
export const HANDOFF_CONTEXT_LABEL = 'continued on another account'
/* THE SAME FOLD FOR A MODEL CONTINUATION (owner request T137), named for what
   the person actually did. */
export const MODEL_HANDOFF_CONTEXT_LABEL = 'continued on another model'
export function handoffContextLabel({ model = false } = {}) {
  return model ? MODEL_HANDOFF_CONTEXT_LABEL : HANDOFF_CONTEXT_LABEL
}
export function handoffContextSummary(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  return `the handoff this new session started from · ${words} words`
}

/* WHAT THE CAP TOOK, SAID OUT LOUD. A per-turn cap a person cannot see is a
   cap that lies about how much the agent did. */
export function foldedActionsLine(count) {
  const many = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (many === 0) return ''
  return many === 1 ? 'and 1 more step' : `and ${many} more steps`
}

/* Keep unsuccessful outcomes visible when consecutive tool calls fold into
   one summary. Use the row's plain wording: the internal key `undone` does
   not mean that a command's changes were rolled back. The summary opens the
   retained rows, so it can also say where to read what happened. */
export function actionRunLine(count, { undone = 0, refused = 0, unknown = 0 } = {}) {
  const many = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (many === 0) return ''
  const calls = many === 1 ? '1 tool call' : `${many} tool calls`
  const held = []
  const undoneCount = Number.isFinite(undone) && undone > 0 ? Math.floor(undone) : 0
  const refusedCount = Number.isFinite(refused) && refused > 0 ? Math.floor(refused) : 0
  const unknownCount = Number.isFinite(unknown) && unknown > 0 ? Math.floor(unknown) : 0
  if (undoneCount > 0) held.push(`${undoneCount} did not finish`)
  if (refusedCount > 0) held.push(`${refusedCount} refused — press to read`)
  else if (held.length) held[0] += ' — press to read'
  /* A missing result is neither success nor failure. Components already
     counts these rows when repainting a run; omitting that count here made an
     unknown tool disappear from the only line visible while the run was
     folded. Keep the neutral wording from ACTION_STATE_WORDS and point to the
     retained row so the person can inspect it. */
  if (unknownCount > 0) held.push(`${unknownCount} no result came back — press to read`)
  return held.length ? `${calls} · ${held.join(' · ')}` : calls
}

/* RECEIPT-BACKED ELAPSED TIME, with no clock or status fallback. Components
   import these words and units so every duration surface shares one contract. */
export function formatActionDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return ''
  return durationMs < 10_000
    ? `${(durationMs / 1000).toFixed(1)}s`
    : `${Math.round(durationMs / 1000)}s`
}

export function actionRunTotalText(totalMs, measuredCount) {
  if (!Number.isInteger(measuredCount) || measuredCount <= 0 || !Number.isFinite(totalMs) || totalMs < 0) return ''
  return formatActionDuration(totalMs)
}

export function actionRunDisclosureWord(open) {
  return open === true ? 'Collapse' : 'Expand'
}

export function activityLine(activity) {
  if (!activity || typeof activity !== 'object') return ''
  if (activity.kind === 'call') {
    if (activity.command) {
      /* Same summary rule as the chat rows: the command, not the shell
         wrapper the engine delivered it in. */
      const spoken = commandSummary(activity.command)
      const command = spoken.length > ACTIVITY_COMMAND_MAX
        ? `${spoken.slice(0, ACTIVITY_COMMAND_MAX)}…`
        : spoken
      return `Running a command: ${command}`
    }
    if (activity.tool === 'fileChange') return 'Editing files.'
    return 'Using a tool.'
  }
  if (activity.kind === 'result') {
    if (activity.exitCode === 0) return 'The last command finished.'
    /* Action first, failure second — and not only for the reader: the checker
       scans template fragments separately, so a sentence that OPENS with the
       failure clause presents a dead-end fragment no trailing words can cure. */
    if (typeof activity.exitCode === 'number') return `Watch here for what the agent tries next — its last command failed with exit code ${activity.exitCode}.`
    return 'The last step finished.'
  }
  if (activity.kind === 'approval') return 'Waiting for an approval before going further.'
  if (activity.kind === 'thinking') return 'Thinking.'
  return ''
}

/* WHAT THE SESSION HAS USED, as one sentence. The engine reports token usage
   on every update; the reader (sessionUsageEvent) admits only numeric fields,
   and this turns the common ones into words. Field names vary by engine
   version, so each is looked up by its known spellings and a reading with
   nothing recognisable says so instead of inventing a number. */
function usageNumber(usage, names) {
  for (const name of names) {
    if (Number.isFinite(usage?.[name])) return usage[name]
  }
  return null
}

function tokensWord(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)} million tokens`
  if (count >= 10_000) return `${Math.round(count / 1000)} thousand tokens`
  return `${count} tokens`
}

export function usageSentence(usage) {
  const input = usageNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'])
  const output = usageNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'])
  const cached = usageNumber(usage, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens'])
  const total = usageNumber(usage, ['total_tokens', 'totalTokens'])
    ?? (input !== null || output !== null ? (input || 0) + (output || 0) : null)
  if (total === null) return 'The engine reported its usage in a form this copy does not recognise yet.'
  const parts = []
  if (input !== null) parts.push(`${tokensWord(input)} read`)
  if (output !== null) parts.push(`${tokensWord(output)} written`)
  if (cached !== null && cached > 0) parts.push(`${tokensWord(cached)} of the reading served from cache`)
  const window = usageNumber(usage, ['modelContextWindow', 'contextWindow'])
  const windowSentence = window !== null && window > 0
    ? ` The model's window holds ${tokensWord(window)}.`
    : ''
  return (parts.length
    ? `About ${tokensWord(total)} so far — ${parts.join(', ')}.`
    : `About ${tokensWord(total)} so far.`) + windowSentence
}

/* THE WAIT IS THE PART PEOPLE DISTRUST. A start crosses a background service
   and a program that is not this one, so it is not instant; a spinner with no
   words beside it is where somebody presses the button a second time. These say
   that waiting is expected, and the running line says where to go next rather
   than leaving a person on a screen with nothing left to do. */
export const START_PROGRESS = Object.freeze({
  starting: 'Starting your agent. This takes a few seconds.',
  running: 'Your agent is running. Open it any time to see what it is doing.',
})

/* WHEN "A FEW SECONDS" HAS STOPPED BEING TRUE.
 *
 * MEASURED on production on 2026-08-22, driving a real machine from a browser:
 * a start the machine accepted, whose engine then never launched, left
 * "Starting your agent. This takes a few seconds." on screen with the node
 * reading "not started yet". The request does eventually fail -- at the
 * transport's own five-minute ceiling. Five minutes is not "a few seconds", and
 * for all of it the screen keeps promising one.
 *
 * TWO BUDGETS, BECAUSE A RELAY ROUND TRIP IS LEGITIMATELY SLOWER than an IPC
 * call to a program on the same computer. Telling somebody driving a machine in
 * another building that it is late, at the same moment we would tell somebody
 * at their own desk, would cry wolf on every slow network.
 *
 * IT IS NOT A FAILURE MESSAGE. Nothing has been refused at this point and the
 * start may still land, so the sentence says what is true -- it is late, it may
 * still arrive -- and the one thing a person must not do, which is press Start
 * again and get two agents for one job. */
const START_STALL_HERE_MS = 20_000
const START_STALL_DRIVING_MS = 45_000

/** How long before a start that has not settled is worth mentioning. */
export function startStallMs({ driving = false } = {}) {
  return driving ? START_STALL_DRIVING_MS : START_STALL_HERE_MS
}

/** What to say when it has taken longer than it should. */
export function startStalledLine({ driving = false } = {}) {
  const lead = 'Still starting. This usually takes a few seconds, so something is holding it up, '
    + 'and it may still arrive.'
  const twice = 'Do not press Start again: that would start a second agent for the same job.'
  /* Driving from a browser, the person cannot glance at the machine to see what
     happened, so the sentence has to tell them where to look. At their own desk
     they are already there. */
  return driving
    ? `${lead} ${twice} If nothing appears, open ToolsEnabled on that computer and look there.`
    : `${lead} ${twice}`
}

/** What the panel says while the agent is starting. */
export function startingLine(role) {
  if (!isKnownRole(role)) return START_PROGRESS.starting
  return `Starting your agent. It will take the ${roleLabel(role)} role in this tree.`
}

/** What the panel says once it is running. */
export function runningLine(role) {
  if (!isKnownRole(role)) return START_PROGRESS.running
  return `Your agent is running in the ${roleLabel(role)} role. Open it any time to see what it is doing.`
}

/* ---------------------------------------------------------------
   Refusals. Four of them, and each one ends somewhere.
   --------------------------------------------------------------- */

/* The half of a refusal only this flow knows: whatever else happened, no agent
   is running from this press. Composed in front of a curated diagnosis by
   startRefusalSentence() below, never shown on its own. */
const NOTHING_STARTED = 'Nothing was started.'

export const START_REFUSAL = Object.freeze({
  /* NO ASSISTANT PROGRAM ON THIS COMPUTER. Not a fault in the install and the
     wording must not read like one: ToolsEnabled has never contained the
     program that runs an agent, and Codex is a separate install. It walks the
     person to the two lines they have to type; it does not offer to type them,
     because it cannot. The commands are imported, not retyped. */
  /* NOT "in the same window" for the sign-in. That wording stuck the first
     external user: the window the install ran in never re-reads the PATH the
     installer wrote, and answers "'codex' is not recognized". Reproduced
     2026-08-19; src/first-run-needs.js carries the full account. */
  assistantProgramMissing: `Nothing was started. Codex is the program that actually runs an agent, and this computer does not have it yet. Open Windows Terminal and run "${CODEX_SETUP_COMMANDS.install}". Then open a new terminal window and run "${CODEX_SETUP_COMMANDS.signIn}". Come back here and press Start again.`,
  /* The second line of the same answer, kept apart so the panel can show it
     quietly. A machine that already has Node usually has the second route. */
  assistantProgramNote: `If the computer you are driving already has Node, "${CODEX_SETUP_COMMANDS.installWithNode}" does the same job there.`,

  /* THE PART THAT STARTS AN AGENT IS NOT IN THIS BUILD. An incomplete download,
     not a mistake the person made, so the sentence spends itself on the one
     thing that clears it. It names no module: the file name is a support
     detail, and the person reading this has a reinstall to do. */
  enginePartMissing: 'Nothing was started. This copy of ToolsEnabled was built without the part that starts an agent. Reinstall ToolsEnabled from a complete build, then open this panel again.',

  /* A CAPACITY ANSWER, AND IT MUST NOT READ AS A FAULT. Every agent this copy
     can run at once is carrying work. Nothing is misconfigured and nothing
     needs repairing, so the two things offered are both about the agents that
     are already running. Wording this as a setup problem would send somebody
     off to edit their fleet over a queue that clears on its own. */
  everyAgentBusy: 'Nothing new was started, and nothing is wrong. Every agent this copy can run at once is already working. Wait for one to finish, or stop one in the tree, and then start this again.',

  /* A START THAT FAILED AND SAID NOTHING. The one case where the product owes
     the most and knows the least, so it admits that plainly and still ends with
     a next move. It does not guess at a cause: advice that confident and that
     wrong costs a person their window and lands them back here. */
  noReasonGiven: 'Nothing was started, and this copy was not told why. Try once more. If it refuses again, close ToolsEnabled, open it, and start from this panel.',

  /* Role directions are an exact saved snapshot. A stale or unknown row is
     never softened into an unroled start, because that would make the picker
     decorative while reporting success. */
  roleStale: 'Nothing was started because the organisation or role directions changed after this panel was opened. Reload this page, choose the role again, and then press Start.',
  roleUnknown: 'Nothing was started because that role is no longer in the Role library. Reload this page, pick a current role, and then press Start.',
  roleUnavailable: 'Nothing was started because this copy could not read the saved directions for that role. Reload this page and try again. If it still refuses, update ToolsEnabled before starting this agent.',
  roleBindingInvalid: 'Nothing was started because the selected role was not tied to a complete saved snapshot. Reload this page, choose the role again, and then press Start.',

  /* A NODE THAT OUTLIVED ITS SESSION. The tree is saved on this computer and
     survives closing ToolsEnabled; the agent sessions behind it do not. So a
     spot from an earlier run still shows its ask and its last reply, and a
     message written to it reaches a session this run does not hold. Retrying
     can never deliver it -- the truthful next move is a fresh agent. */
  sessionGone: 'Start a new agent for this spot. The one it was talking to ended when ToolsEnabled closed, so this message was not sent. Sending again cannot reach it.',

  /* A PANEL WIRED TO NOTHING, AND WHY IT MUST NOT BORROW THE SENTENCE ABOVE.
     noReasonGiven says "Try once more", which is right for a start that failed
     once and might not fail twice. This is the other thing: the panel has no
     receiver at all, so pressing again cannot ever work, and telling somebody
     to retry sends them round a loop with no exit. That is the dead end this
     whole module exists to remove -- technically survivable, practically
     nowhere. It also says whose fault it is, because a person who has just
     pressed a button that did nothing assumes it was theirs. */
  notWired: 'Nothing happened, and it is not something you did. This copy of the app has a fault: this panel is not connected to anything that can start an agent. Close ToolsEnabled and open it again.',
})

/* WHICH REFUSAL FROM THE ENGINE IS WHICH OF THE FOUR ABOVE.
 *
 * Only the codes that mean exactly what one of these sentences says are mapped.
 * Everything else falls through on purpose: src/agent-availability-copy.js has
 * curated, MORE SPECIFIC sentences for the rest of the agent-start vocabulary
 * -- being signed out of Codex, a permission level that cannot be read, a build
 * missing the part that keeps a session off a billed account -- and replacing
 * any of those with a general line here would be trading a good answer for a
 * shorter one. */
const REFUSAL_BY_CODE = Object.freeze({
  AGENT_CODEX_CLI_NOT_INSTALLED: START_REFUSAL.assistantProgramMissing,
  CODEX_CLI_NOT_FOUND: START_REFUSAL.assistantProgramMissing,

  AGENT_ENGINE_UNAVAILABLE: START_REFUSAL.enginePartMissing,
  BRIDGE_ALL_SEATS_BUSY: START_REFUSAL.everyAgentBusy,
  LAUNCH_FANOUT_EXCEEDED: START_REFUSAL.everyAgentBusy,
  AGENT_SESSION_FAILED: START_REFUSAL.noReasonGiven,
  MC_AGENT_UNKNOWN_SESSION: START_REFUSAL.sessionGone,
  MC_AGENT_ROLE_STALE: START_REFUSAL.roleStale,
  MC_AGENT_ROLE_UNKNOWN: START_REFUSAL.roleUnknown,
  MC_AGENT_ROLE_UNAVAILABLE: START_REFUSAL.roleUnavailable,
  MC_AGENT_ROLE_BINDING_INVALID: START_REFUSAL.roleBindingInvalid,
})

/* The two codes above whose shared answer is Windows-shaped. Named once, so
   startRefusalSentence's platform branch and this table cannot disagree about
   which codes they cover. */
const CODEX_ABSENT_CODES = new Set(['AGENT_CODEX_CLI_NOT_INSTALLED', 'CODEX_CLI_NOT_FOUND'])


/** True when the panel should also offer the Node line beside the sentence. */
export function refusalNeedsAssistantProgram(result) {
  const code = refusalCodeOf(result)
  return Boolean(code) && REFUSAL_BY_CODE[code] === START_REFUSAL.assistantProgramMissing
}

/* Join a sentence to what follows it without doubling the full stop. */
function endSentence(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return ''
  return /[.!?…]$/.test(value) ? value : `${value}.`
}

/* The availability table's sentences are written lower-case first because two
   of their three surfaces read "unavailable · <phrase>" and "refused ·
   <phrase>" (agent-session.js), where a capital would be wrong. This surface
   is the third, and it puts a full stop in front of them -- which rendered
   "Nothing was started. this copy starts Codex agents…" on the installed
   1.0.17, measured. Capitalise HERE, at the one join that needs it, rather
   than in twenty strings the other two surfaces also read. */
function startCapital(text) {
  const value = String(text ?? '')
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

/* DID THE PRODUCT ACTUALLY LEARN ANYTHING? The engine's own `reason` is good
   English and worth showing, but two things arrive in that field that are not:
   an empty string, and a `reason` that is itself a machine code, which really
   happens when a thrown error's message is one. Both mean the same thing to the
   person in the panel -- nobody said why. The test for a code is imported from
   src/refusal-copy.js rather than retyped so the two cannot drift. */
function readableReason(result) {
  const value = result && typeof result === 'object' && typeof result.reason === 'string' ? result.reason.trim() : ''
  if (value.length === 0 || isBareIdentifier(value) || !/[a-z]/.test(value)) return ''
  return value
}

/**
 * THE ONLY WAY THIS FLOW SAYS THAT A START DID NOT HAPPEN.
 *
 * Give it the whole refusal, whatever shape it arrived in -- a result object, a
 * rejected call's error, nothing at all -- and it returns one sentence that
 * says what happened and what to do about it. It cannot return a code, it
 * cannot return an empty string, and there is no argument that would let a
 * caller ask for either.
 *
 * The order is most-specific-first, and the LAST branch is the point of the
 * whole function:
 *
 *   1. the four sentences above, for the refusals this panel words itself;
 *   2. this product's own curated answer for the rest of the agent-start
 *      vocabulary, with "Nothing was started" in front of it, because those
 *      sentences are written to be composed and none of them says it;
 *   3. src/refusal-copy.js's shared composer, whenever there is something real
 *      to pass on -- the engine's own English, or a curated remedy for the code.
 *      This branch must NOT prefix anything: a timeout deliberately says it is
 *      not known whether anything happened, and "Nothing was started" in front
 *      of it would be this module inventing a fact it does not have;
 *   4. and when there is neither a reason nor a remedy anybody wrote for this
 *      code, the fourth sentence above -- a start that failed and said nothing.
 *      Falling through to the shared generic remedy here produced two "Nothing"
 *      sentences back to back, which is the density this flow exists to remove.
 */
/* WHAT IS MISSING FOR THE TIER THAT WAS ACTUALLY REFUSED, AND NOTHING ELSE.
 *
 * THE DEFECT THIS CLOSES. AGENT_TIER_NO_LAUNCHER is raised by resolveStartTier()
 * for whichever provider THIS build carries no launcher for, and the shared
 * table in src/agent-availability-copy.js is keyed by the code alone -- so its
 * sentence had to describe every provider the code could ever be raised for. It
 * named Claude and local together, and then the Claude engine shipped
 * (capability/src/lib/agent-engine/claude-cli-process.js, present in the
 * installed 1.0.20) and the gate stopped raising it for Claude. The sentence
 * went on naming Claude anyway, on a build that runs Claude.
 *
 * THE TREE IS THE ONE SURFACE THAT KNOWS WHICH TIER WAS PICKED, because the
 * press carried it: startAgentForNode() has the tier in hand when it calls this,
 * and passes it back in. So this names the provider of the tier that was
 * refused, which the refusal itself proves has no launcher here, and never a
 * provider that was not asked for.
 *
 * IT IS TRUE BY CONSTRUCTION RATHER THAN BY UPKEEP. The sentence is only ever
 * produced for a tier the shell just refused, and the refusal MEANS this build
 * has no launcher for that tier. A build that gains an engine stops raising the
 * code for it and this sentence stops being said about it, with no edit here.
 * An unknown or absent tier returns null and the caller falls back to the shared
 * table, which names no provider at all.
 */
const TIER_PROVIDER_MISSING = Object.freeze({
  codex: Object.freeze({ desk: 'the part that runs a Codex agent', remote: 'the part that runs a Codex agent' }),
  claude: Object.freeze({ desk: 'the part that runs a Claude agent', remote: 'the part that runs a Claude agent' }),
  gemini: Object.freeze({ desk: 'the part that runs a Gemini agent', remote: 'the part that runs a Gemini agent' }),
  grok: Object.freeze({ desk: 'the part that runs a Grok agent', remote: 'the part that runs a Grok agent' }),
  /* Not "a local agent": the phrase a person can act on is what the machine
     would be doing, and "on this computer itself" is the distinction from the
     two above -- both of which also run on this computer, through a program
     signed in to a service. */
  local: Object.freeze({
    desk: 'the part that runs an agent on this computer itself',
    remote: 'the part that runs an agent on the computer you are driving itself',
  }),
})

export function tierNoLauncherSentence(tier, { subject = 'this computer' } = {}) {
  const row = LAUNCH_TIERS.find(candidate => candidate.id === tier)
  const words = row ? TIER_PROVIDER_MISSING[row.provider] : null
  const missing = words ? words[subject === 'this computer' ? 'desk' : 'remote'] : null
  if (!missing) return null
  return `Nothing was started. This copy of ToolsEnabled does not carry ${missing}, and nothing on the computer you are driving is broken. The model menu marks every type this copy cannot start; pick one it does not mark.`
}

/* THE OTHER HALF OF "THIS TYPE CANNOT START HERE", AND IT IS NOT THE SAME HALF.
 *
 * AGENT_TIER_NO_LAUNCHER means this build carries no program for the chosen
 * type. AGENT_TIER_SESSION_ACTOR_UNSUPPORTED means it carries the program and
 * this installation will not seat that type, which is how every Grok tree start
 * failed on 2026-09-11.
 *
 * WHAT THIS SENTENCE MAY NOT DO, and its first version did all three. The owner
 * read it and said so: keep customer wording short and actionable, do not
 * explain session authorities or parts handing out identities in the flow, and
 * stop telling people to reload. The version this replaces opened with "The
 * part of ToolsEnabled on this computer that hands out agent identities", spent
 * a clause denying that reloading would help, and ran to four clauses. Every
 * word of it was true and none of it was any use to the person reading it.
 *
 * THE MECHANISM IS NOT LOST, IT IS FILED WHERE IT BELONGS. The typed code rides
 * to the same status line as `data-refusal-code` (markRefusalCode in
 * src/refusal-copy.js), and the precise reason -- which tier, which provider,
 * which actors are accepted -- is in the shell's own fail() message. That
 * message never reaches a renderer: rendererSafeAgentError in shell/main.cjs
 * rebuilds every agent error as `new Error(code)`, so the words are main-process
 * diagnostics by construction and cannot leak into this flow.
 *
 * NAMED BY THE TIER THE PRESS CARRIED, the way tierNoLauncherSentence() is, so
 * it can only ever name a type this computer just refused. */
const TIER_ACTOR_WORDS = Object.freeze({
  codex: 'a Codex agent',
  claude: 'a Claude agent',
  gemini: 'a Gemini agent',
  grok: 'a Grok agent',
  local: 'a local agent',
})

export function tierSessionActorSentence(tier, { subject = 'this computer' } = {}) {
  const row = LAUNCH_TIERS.find(candidate => candidate.id === tier)
  const named = row ? TIER_ACTOR_WORDS[row.provider] : null
  if (!named) return null
  return subject === 'this computer'
    ? `This installation cannot start ${named}. Update ToolsEnabled or choose another model.`
    : `The computer you are driving cannot start ${named}. Update ToolsEnabled there, or choose another model.`
}

export function startRefusalSentence(result, { tier = null, subject = 'this computer', platform = globalThis.mcSetup?.platform } = {}) {
  const code = refusalCodeOf(result)
  /* Before the tables, because both of them answer this code without the one
     fact that makes the answer specific. A tier this module does not recognise
     falls through to the shared sentence rather than inventing a provider. */
  if (code === 'AGENT_TIER_NO_LAUNCHER') {
    const named = tierNoLauncherSentence(tier, { subject })
    if (named) return named
  }
  if (code === 'AGENT_TIER_SESSION_ACTOR_UNSUPPORTED') {
    const named = tierSessionActorSentence(tier, { subject })
    if (named) return named
  }
  /* ON LINUX AND MACOS THESE TWO CODES MAY NOT TAKE THE TABLE SHORTCUT.
     REFUSAL_BY_CODE answers both with START_REFUSAL.assistantProgramMissing,
     which names Windows Terminal and winget; measured on this machine, a Linux
     owner pressing Start was told to run "winget install OpenAI.Codex" in
     Windows Terminal. The UNAVAILABLE_TEXT branch immediately below already
     composes a platform-correct sentence for exactly these codes through
     unavailableReason(), so they are allowed to reach it rather than being
     answered from the Windows-shaped table. No new prose is written here. */
  if ((platform === 'linux' || platform === 'darwin') && CODEX_ABSENT_CODES.has(code)) {
    return `${NOTHING_STARTED} ${startCapital(endSentence(unavailableReason(code, { platform })))}`
  }
  if (code && Object.prototype.hasOwnProperty.call(REFUSAL_BY_CODE, code)) return REFUSAL_BY_CODE[code]
  if (code && Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, code)) {
    return `${NOTHING_STARTED} ${startCapital(endSentence(unavailableReason(code)))}`
  }
  if (readableReason(result) || refusalRemedy(code) !== GENERIC_REMEDY) return refusalSentence(result)
  return START_REFUSAL.noReasonGiven
}

// A restart can refuse before the old session closes, or after it has closed.
// Its failure must explain the cause without claiming every old session ended.
// Resource holds here require another press; this action has no launch queue.
export function restartRefusalSentence(result, options = {}) {
  const code = refusalCodeOf(result)
  if (code === 'MC_TREE_COMMAND_CLOSE_FAILED' || code === 'MC_TREE_COMMAND_CLOSE_UNAVAILABLE') return PALETTE_PANEL.clearStopFailed
  if (code === 'MC_TREE_COMMAND_ALREADY_RUNNING') return 'This conversation is already being restarted or resumed. Wait for that attempt to finish.'
  if (code === 'MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED') return 'The conversation was not restarted because its saved transcript could not be cleared. Try Start over again.'
  if (code === 'MC_TREE_COMMAND_DIFF_RESET_FAILED') return 'The conversation was not restarted because its saved file changes could not be cleared. Try Start over again.'
  if (code === 'MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE') return 'The conversation was not restarted because its agent identity could not be confirmed. Check the agent role, then try Start over again.'
  if (code === 'AGENT_RESOURCE_PRESSURE') return 'The conversation was not restarted because CPU use or app responsiveness is under pressure. Let the computer recover, then try Start over again.'
  if (code === 'AGENT_RESOURCE_UNKNOWN' || code === 'AGENT_RESOURCE_WARMING') return 'The conversation was not restarted because fresh, stable resource readings are still needed. Wait a few seconds, then try Start over again.'
  if (code === 'AGENT_RESOURCE_STARTS_BUSY' || code === 'AGENT_RESOURCE_PACING') return 'The conversation was not restarted because other agents are still starting. Let those starts settle, then try Start over again.'
  if (code === 'AGENT_MEMORY_LOW') return 'The conversation was not restarted because there is too little free memory. Free some memory on the computer running it, then try Start over again.'
  if (code && (Object.hasOwn(REFUSAL_BY_CODE, code) || Object.hasOwn(UNAVAILABLE_TEXT, code))) {
    return startRefusalSentence({ code }, options)
  }
  return PALETTE_PANEL.clearFailed
}

/* ---------------------------------------------------------------
   More than one tree on one computer.
   --------------------------------------------------------------- */

/* WHY "TREE" AND NOT "TEAM". src/agent-teams.js already owns the word team in
   this product, and it means something narrower there: a lead that is
   dispatched first with members nested under its launch. Two meanings for one
   word on adjacent screens is the kind of density this flow exists to avoid.
   A person looking at this page can see a tree, so the tree is what it is
   called. */
export const SECOND_TREE = Object.freeze({
  name: 'Another tree',
  action: 'Start another tree',
  help: 'A tree is one group of agents that work together. Start another when you want to keep two jobs apart.',
  /* A tree added on a computer that already has one. It is not the first-run
     empty state -- this person has done this before -- so it is one line. */
  empty: 'This tree is empty. Press a spot in it to start an agent here.',
  /* The drag-out gesture's answer, in the move vocabulary the rail already
     speaks. Named with the node so a person who dropped the wrong thing sees
     it immediately. */
  detached: (name) => `${name} is now its own tree. Everything under it came along.`,
  /* THE GESTURE WAS UNDERSTOOD AND NOTHING MOVED, which is a third answer and
     used to be reported as the first. fleet-trees.js accepts a drag-out of a
     node that is ALREADY the sole root of its own tree -- correctly, the
     gesture's meaning is satisfied -- and answers `unchanged: true`. The page
     printed "is now its own tree" over it anyway, so a person was told a move
     had happened when the tree was exactly as before. */
  alreadyOwnTree: (name) => `${name} is already its own tree, so nothing moved.`,
})

/**
 * LEGACY NAMING HELPER, NOT THE TAB OR HEADING'S LIVE SOURCE.
 *
 * createFleetTreeStore().treeLabel(treeId) owns that job now: it prefers a
 * person's name, then the first message, and only then a counted fallback. The
 * live computers view calls that store method. Keep this export only while a
 * coordinated removal can also retire any downstream import outside this repo.
 *
 * Numbered, because a person with two of them needs to tell them apart and
 * nobody has been asked to name anything yet. A position that is not a counting
 * number returns the plain word rather than "Tree undefined", which is the
 * absence-read-as-a-value mistake this codebase keeps making.
 */
export function treeName(position) {
  return Number.isInteger(position) && position > 0 ? `Tree ${position}` : 'Tree'
}
