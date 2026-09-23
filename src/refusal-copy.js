/* WHAT A REFUSAL SAYS WHEN IT IS NOT AN AGENT-START REFUSAL.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. src/agent-availability-copy.js repaired ONE
 * surface -- the agent page's Start control -- by giving every refusal code a
 * sentence that spends its length on the remedy. Every OTHER audited control in
 * this product kept the shape that repair replaced, and did it in nine places:
 *
 *     src/views/computers.js      `refused · ${result.code} · ${result.reason}`
 *     src/write-surfaces.js       `refused · ${result.code} · ${result.reason}`
 *     src/cloud-tasks-controller  `${result.code} · ${result.reason}`   (x5 lines)
 *     src/agent-loops.js          `${result.code}: ${result.reason}`
 *     src/agent-loops.js          `... was NOT confirmed stopped (${code}).`
 *     src/agent-teams.js          `${result.code}: ${result.reason}`   (lead + member)
 *     src/mission-bridge.js       `${code}: ${reason} No stop has been confirmed.`
 *     src/mission-bridge.js       `${result?.code}: ${reason} Nothing moved.` (x2)
 *     src/org-controls.js         `${fallback} (${result.code})`
 *
 * A person reading `BRIDGE_TERMINATE_STALE_PID: ...` is being handed a grep
 * term. It is worse than that on the leading-token sites, because the FIRST
 * thing the eye lands on is the one part of the line that means nothing to
 * anybody who does not have this repository open.
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT WAS MISSING EVERYWHERE.
 *
 *   1. The identifier does not appear in visible text. It is still carried --
 *      every state object below keeps its `code`, and the DOM nodes carry
 *      `data-refusal-code` -- so a support conversation and a test can still
 *      name the exact refusal. It is a machine field, not a sentence.
 *
 *   2. EVERY refusal ends with something to do. The engine's own `reason` is
 *      good English and it stays on the glass verbatim, but almost all of them
 *      are diagnoses ("The audited dependency refused the action.") and a
 *      diagnosis is not a remedy. So a remedy is always appended, chosen by the
 *      code, and when the code is one nobody wrote a sentence for it is chosen
 *      by the code's FAMILY. There is no path through this module that returns
 *      a diagnosis alone.
 *
 * WHY A FAMILY FALLBACK RATHER THAN ONE MORE BIG TABLE. The bridge's code
 * vocabulary is ~70 identifiers today (`grep -rEo "'[A-Z][A-Z0-9_]{5,}'"` over
 * the engine's src/lib/mission-bridge/) and it grows whenever the engine adds a
 * guard. A table alone fails OPEN on the next one added: the code falls through
 * to `String(code)` and a customer sees the identifier again -- which is exactly
 * how the defect this module repairs got shipped in the first place. Families
 * are closed over the PREFIX, so a code nobody has ever seen still produces a
 * whole sentence with an action in it. The curated table is for the refusals a
 * person actually reaches; the families are the floor, and the floor is what
 * makes the rule hold.
 *
 * THE ABSENCE CASE IS THE POINT, not an edge. `refusalSentence()` is given
 * `undefined`, `null`, `{}`, `{ ok: false }`, a reason that is the empty string,
 * and a reason that is ITSELF an identifier -- the last one really happens, via
 * `reason: error?.message` where the thrown error's message is a code. Each of
 * those must produce a whole sentence with a remedy in it, because "it failed
 * and we cannot say why" is precisely when a person has least to go on. This
 * codebase's signature defect is absence read as consent; here it would be
 * absence read as "say nothing", which on a refusal surface is the same
 * mistake wearing a different hat.
 *
 * It is a separate module from the surfaces for the reason the availability
 * table is: a copy test written against source text passes when the table is
 * right and the lookup is wrong. This module imports no DOM and no view, so
 * `node --test` can hold it and assert the SENTENCE a refusal produces.
 *
 * IT IMPORTS NOTHING AT ALL, and that is a decision rather than an accident.
 * The obvious shape was to read src/agent-availability-copy.js's table from
 * here so an AGENT_* code kept the agent page's own wording; but that module
 * needs refusalRemedy() for ITS unknown-code fallback (see unavailableReason
 * there), and the two importing each other is a cycle whose evaluation order
 * decides whether a frozen table is defined when the other module's top level
 * runs. It would work today and break the first time somebody moves a const.
 * So the dependency runs one way -- availability copy imports this -- and the
 * two tables stay separate: agent-start codes are translated by
 * unavailableReason(), everything else by refusalSentence(). Neither surface
 * can reach the other's codes, so nothing is lost by the split.
 */

import { SUBSCRIPTION_DISABLED_HINT } from './subscription-availability.js'
import { terminalName } from './terminal-name.js'

/* An identifier as this product writes them: SCREAMING_SNAKE, at least one
   underscore, no lower case and no spaces. Used two ways -- to recognise a
   `reason` that is secretly a code (and must therefore not be shown as prose),
   and by the suites to assert that no visible string is one. Anchored, so a
   sentence that happens to quote a code is not mistaken for one. */
export const IDENTIFIER_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

/** Does this whole string read as a bare identifier rather than as English? */
export function isBareIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_RE.test(value.trim())
}

/* THE LAST LINE OF DEFENCE, and the only remedy that is true of every refusal
   in the product without knowing anything about it. Reached only when a code is
   absent or matches no family, which is why it says nothing specific: a remedy
   that guessed would send somebody to a switch that has nothing to do with
   their problem. It still names an ACTION and states what did not happen, which
   is the whole contract. */
export const GENERIC_REMEDY = 'Nothing was changed by this attempt. Try it once more, and if it refuses again, close ToolsEnabled and open it a second time before deciding anything on the strength of this screen.'

export const SUBSCRIPTION_COMING_SOON_REMEDY = `Nothing was started and nothing was charged. ${SUBSCRIPTION_DISABLED_HINT} Keep using everything that runs on this computer; it is unaffected.`

/* THE ONE FACT ABOUT THIS PRODUCT'S PLUMBING A PERSON NEEDS, said once. Every
   audited control in the window talks to a background service the app starts
   for itself; when that service is not answering, every one of them refuses,
   and the cure is the same for all of them. Naming a port or a URL here would
   be the BLOCKER-2 defect (a machine detail rendered into the DOM) in its other
   costume, so this says what to DO and never where it listens. */
const RESTART_REMEDY = 'Nothing was sent. ToolsEnabled talks to a background service that starts with this window; close the whole app and open it again, and if it still refuses, reinstall from a complete build.'

/* THE SAME FAILURE, READ FROM SOMEWHERE ELSE. A node keeps the sentence it
   was refused with, and that sentence is written for the person at the desk:
   "close the whole app and open it again". A browser driving the computer
   over the relay reads the same stored note and cannot do any of that from
   where it sits -- measured on the live site on 2026-08-22, a remote reader
   was told to close an app on a computer in another room. So a stored desk
   sentence is re-read for the remote reader by readerRemedy() below; the
   stored bytes are not rewritten. */
const RESTART_REMEDY_REMOTE = 'Nothing was sent. That computer’s background service was not running when this agent was started. On that computer, close ToolsEnabled fully and open it again, then try once more from here.'

/** The remedy a READER should see for a stored refusal sentence: the desk
 *  sentence for the person at the desk, the remote one for a browser reading
 *  the computer over the relay. Any other sentence passes through unchanged. */
/* The sign-in refusals carry the same desk shape: "open a new terminal window
   and run "codex login"" is an instruction for the person at that keyboard.
   Measured 2026-08-23 on the live site, driving a fresh one-computer account
   from a browser: the start was accepted and refused honestly for the missing
   sign-in, and the advice told the remote reader to open a terminal on a
   computer they were not at. The fact stands; only the advice is re-read. */
const DESK_TERMINAL_CLAUSE = /If (Codex|Claude) is installed, open a new terminal window and run "([a-z]+ login)"\. If it is not, run "([^"]+)" first\. Then come back to this screen/
function remoteTerminalClause(match) {
  const [, program, login, install] = match
  return `On that computer, open a terminal and run "${login}" if ${program} is installed, or "${install}" first if it is not; then try again from here`
}

/* THE SAME SHAPE, TEMPLATED BY PROGRAM. src/account-panel-copy.js's
   PROVIDER_SIGN_IN.lead() and .opened() say this once for whichever of
   Codex, Claude or Gemini a person pressed Sign in for, in the Settings section
   This computer -- where every empty relay-served screen's door leads. A literal entry per
   program would need editing again the day a fourth program is added; a
   pattern does not. */
const DESK_SIGNIN_LEAD = /^One press opens a terminal window with (.+)'s own sign-in already running in it\. You finish it there, and nothing here sees your password or your key\.$/
function remoteSignInLead([, program]) {
  return `One press opens a terminal window on that computer with ${program}'s own sign-in already running in it; it has to be finished there, not from here, and nothing here sees your password or your key.`
}

const DESK_SIGNIN_OPENED = /^A terminal window opened and is running (.+)'s sign-in\. Finish it there, then close that window\.$/
function remoteSignInOpened([, program]) {
  return `A terminal window opened on that computer and is running ${program}'s sign-in; it has to be finished there, not from here. Close that window on that computer when it is done.`
}

const DESK_ACCOUNT_ADD_HELP = /^Press the program you want another account for\. A terminal window opens, named for the account; sign in there and in your browser\. A name only helps tell accounts apart\.$/
function remoteAccountAddHelp() {
  return 'Press the program you want another account for on that computer. A terminal window opens there, named for the account; finish the sign-in there and in the browser it opens there. A name only helps tell accounts apart.'
}

const DESK_ACCOUNT_SIGNIN_NAMED = /^(Added “.+?”\. )?A terminal window named “(.+?)” opened\. Sign in there and in your browser, then press Check allowances\.$/
function remoteAccountSignInNamed([, prefix = '', title]) {
  return `${prefix}A terminal window named “${title}” opened on that computer. Finish the sign-in there and in the browser it opens there, then press Check allowances from here.`
}

const DESK_ACCOUNT_SIGNIN_FALLBACK = /^(Added “.+?”\. )?A terminal window opened for “(.+?)”\. Sign in there and in your browser, then press Check allowances\.$/
function remoteAccountSignInFallback([, prefix = '', name]) {
  return `${prefix}A terminal window opened for “${name}” on that computer. Finish the sign-in there and in the browser it opens there, then press Check allowances from here.`
}

const DESK_ACTIONS_REOPEN = /^Nothing was changed\. Close this menu and open it again; if it keeps happening, this is what stopped it: (.+)\.$/
function remoteActionsReopen([, detail]) {
  return `Nothing was changed. Close this menu and open it again from here; if it keeps happening, this is what stopped it: ${detail}.`
}

const DESK_ACTIONS_REOPEN_LITERAL = /^Nothing was changed\. Close this menu and open it again; (.+)$/
function remoteActionsReopenLiteral([, detail]) {
  return `Nothing was changed. Close this menu and open it again from here; ${detail}`
}

/* ONE OF THESE HAS NOTHING LEFT TO NAME. src/account-panel-copy.js's
   ACCOUNT_PANEL.commandLead carries no program and no code -- it is the same
   sentence in front of every account row -- so it is a literal rather than a
   pattern, kept here beside its templated neighbours because it is the same
   defect on the same page. */
const DESK_PATTERNS = Object.freeze([
  [DESK_TERMINAL_CLAUSE, match => match.input.replace(DESK_TERMINAL_CLAUSE, remoteTerminalClause(match)).replace('this computer does not hold one', 'that computer does not hold one')],
  [DESK_SIGNIN_LEAD, remoteSignInLead],
  [DESK_SIGNIN_OPENED, remoteSignInOpened],
  [DESK_ACCOUNT_ADD_HELP, remoteAccountAddHelp],
  [DESK_ACCOUNT_SIGNIN_NAMED, remoteAccountSignInNamed],
  [DESK_ACCOUNT_SIGNIN_FALLBACK, remoteAccountSignInFallback],
  [DESK_ACTIONS_REOPEN, remoteActionsReopen],
  [DESK_ACTIONS_REOPEN_LITERAL, remoteActionsReopenLiteral],
])

/* WHY THIS IS A TABLE NOW AND NOT TWO SPECIAL CASES.
 *
 * readerRemedy used to know exactly two shapes: the RESTART_REMEDY literal and
 * the terminal-clause regex. A desk-reader census measured what that actually
 * covered by running the whitelist against the whole vocabulary: of the 60
 * entries in REFUSAL_REMEDY, SEVEN told a browser reader to close and reopen an
 * application they are not sitting at, and passed through byte for byte. The
 * call sites looked repaired -- they were passing viaRelay -- because the
 * wrapper was the thing that had nothing to say about those sentences.
 *
 * So the correspondence is declared rather than special-cased, and
 * tools/test/reader-remedy-coverage.test.mjs holds it closed from both ends: a
 * remedy that tells someone to do something AT the machine must have a twin
 * here, and every key here must still be a live REFUSAL_REMEDY value. That
 * second half is what stops silent drift -- edit a desk sentence and the key
 * stops matching, which would quietly restore the defect, so the test fails
 * instead.
 *
 * The twins keep the FACT and rewrite only the instruction. Nothing here says
 * where the service listens or names a port; that is the same rule
 * RESTART_REMEDY_REMOTE was written under. */
const REMOTE_TWIN = Object.freeze(new Map([
  [RESTART_REMEDY, RESTART_REMEDY_REMOTE],

  // Home keeps the bare sentence; shared refusals add punctuation and tree
  // starts add their outcome. Each live form keeps the same host repair.
  ['ToolsEnabled could not load the rules needed for this agent. Reinstall or update ToolsEnabled from a complete build, then try again',
    'ToolsEnabled could not load the rules needed for this agent. On that computer, reinstall or update ToolsEnabled from a complete build, then try again from here'],
  ['ToolsEnabled could not load the rules needed for this agent. Reinstall or update ToolsEnabled from a complete build, then try again.',
    'ToolsEnabled could not load the rules needed for this agent. On that computer, reinstall or update ToolsEnabled from a complete build, then try again from here.'],
  ['Nothing was started. ToolsEnabled could not load the rules needed for this agent. Reinstall or update ToolsEnabled from a complete build, then try again.',
    'Nothing was started. ToolsEnabled could not load the rules needed for this agent. On that computer, reinstall or update ToolsEnabled from a complete build, then try again from here.'],

  // Setup names the host's terminal and supports both desktop and relay
  // readers. Its platform matrix checks the actual composed instructions.
  ['Windows Terminal', 'Windows Terminal on that computer'],
  ['Open Windows Terminal and run: winget install OpenAI.Codex',
    'On that computer, open Windows Terminal and run: winget install OpenAI.Codex'],
  ['On Windows, open Windows Terminal and run: winget install OpenAI.Codex',
    'If that computer runs Windows, open Windows Terminal there and run: winget install OpenAI.Codex'],
  ['On Linux or macOS, open a terminal. With Node.js and npm installed, run: npm install -g @openai/codex',
    'If that computer runs Linux or macOS, open a terminal there. With Node.js and npm installed, run: npm install -g @openai/codex'],

  ['the app-owned session authority is no longer available, so the agent was not started. Reopen ToolsEnabled, then retry',
    'The app-owned session authority on that computer is no longer available, so the agent was not started. On that computer, reopen ToolsEnabled, then retry from here.'],
  ['Nothing was started. The app-owned session authority is no longer available, so the agent was not started. Reopen ToolsEnabled, then retry.',
    'Nothing was started. The app-owned session authority on that computer is no longer available. On that computer, reopen ToolsEnabled, then retry from here.'],
  ['The app-owned session authority is no longer available. No agent program was started. Reopen ToolsEnabled, then retry',
    'The app-owned session authority on that computer is no longer available. No agent program was started. On that computer, reopen ToolsEnabled, then retry from here.'],

  ['ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
    'ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. On that computer, close ToolsEnabled and open it again. If it keeps refusing, reset its local agent data there or reinstall from a complete build.'],
  ['Nothing was started. ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build.',
    'Nothing was started. ToolsEnabled could not correctly signal whether this assistant needs browser tools. On that computer, close ToolsEnabled and open it again. If it keeps refusing, reset its local agent data there or reinstall from a complete build.'],

  ['Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. Open ToolsEnabled on your computer to grow a real tree.',
    'Starting an agent needs the installed ToolsEnabled application. This page is a preview of it, so nothing here can start one. On that computer, open ToolsEnabled to grow a real tree.'],

  ['Nothing was sent, on purpose: ToolsEnabled would not hand its credentials to a service it could not confirm was its own. Close the whole app and open it again; if it keeps refusing, something else on this computer is holding the address it uses.',
    'Nothing was sent, on purpose: ToolsEnabled would not hand its credentials to a service it could not confirm was its own. On that computer, close ToolsEnabled fully and open it again, then try once more from here. If it keeps refusing, something else there is holding the address it uses.'],

  ['Nothing was sent. The permission this window holds is no longer being accepted; close ToolsEnabled and open it again to get a fresh one.',
    'Nothing was sent. The permission that computer’s window holds is no longer being accepted. On that computer, close ToolsEnabled and open it again to get a fresh one, then try again from here.'],

  ['Nothing was confirmed. Try once more; if it refuses again, close ToolsEnabled and open it a second time before assuming nothing ran.',
    'Nothing was confirmed. Try once more from here; if it refuses again, close ToolsEnabled on that computer and open it a second time before assuming nothing ran.'],

  ['Nothing was done and this copy was not told why. Try once more, and if it refuses again, close ToolsEnabled and open it a second time.',
    'Nothing was done and this browser was not told why. Try once more from here, and if it refuses again, close ToolsEnabled on that computer and open it a second time.'],

  ['Nothing was sent. A step this computer had already started is still finishing; give it a few seconds and press the button again. If it keeps saying this, close ToolsEnabled and open it a second time.',
    'Nothing was sent. A step that computer had already started is still finishing; give it a few seconds and press the button again. If it keeps saying this, close ToolsEnabled on that computer and open it a second time.'],

  /* --- START_REFUSAL, from src/fleet-tree-copy.js -------------------------
     A SECOND TABLE, and finding it is the reason the first count was wrong.
     The sentences below are not remedies; they are the tree's start refusals,
     and views/computers.js hands them to readerRemedy with viaRelay on the way
     to the glass. Four of them instructed the reader to act at the machine and
     passed through untouched, the worst being a browser reader told to
     `winget install OpenAI.Codex` and `codex login` -- on their own laptop,
     where it changes nothing on the computer they are driving, so the verify
     step never fires and it reads as a failed install.

     THE LITERALS LIVE HERE RATHER THAN AN IMPORT, deliberately: refusal-copy.js
     importing a copy module is how the refusal-copy -> data-source ->
     mission-bridge -> refusal-copy cycle gets built by accident. The
     correspondence is held by the test instead, which may import both. */
  ['Nothing was started. Codex is the program that actually runs an agent, and this computer does not have it yet. Open Windows Terminal and run "winget install OpenAI.Codex". Then open a new terminal window and run "codex login". Come back here and press Start again.',
    'Nothing was started. Codex is the program that actually runs an agent, and that computer does not have it yet. It has to be installed there, not here. On that computer, open Windows Terminal and run "winget install OpenAI.Codex". Then run "codex login" in a new terminal window. Come back here and press Start again.'],

  ['Nothing was started. This copy of ToolsEnabled was built without the part that starts an agent. Reinstall ToolsEnabled from a complete build, then open this panel again.',
    'Nothing was started. The copy of ToolsEnabled on that computer was built without the part that starts an agent. It has to be reinstalled there from a complete build. Then try again from here.'],

  ['Nothing was started, and this copy was not told why. Try once more. If it refuses again, close ToolsEnabled, open it, and start from this panel.',
    'Nothing was started, and this browser was not told why. Try once more from here. If it refuses again, close ToolsEnabled on that computer and open it again.'],

  ['Nothing happened, and it is not something you did. This copy of the app has a fault: this panel is not connected to anything that can start an agent. Close ToolsEnabled and open it again.',
    'Nothing happened, and it is not something you did. The app on that computer has a fault: its panel is not connected to anything that can start an agent. Close ToolsEnabled on that computer and open it again.'],

  ['Nothing was done, deliberately: ToolsEnabled will not take an action it cannot write down. Close the app and open it again, and if it keeps refusing, the record on this computer needs attention before anything else here will work.',
    'Nothing was done, deliberately: ToolsEnabled will not take an action it cannot write down. On that computer, close ToolsEnabled and open it again. If it keeps refusing, the record there needs attention before anything else will work from here.'],

  /* --- UNAVAILABLE_TEXT, from src/agent-availability-copy.js, AS COMPOSED BY
     src/fleet-tree-copy.js startRefusalSentence() ---------------------------
     A THIRD TABLE, reached the same way the second one was found: by running
     every code UNAVAILABLE_TEXT declares through the exact function
     views/computers.js already calls readerRemedy on, rather than trusting
     that "the call site is wrapped" meant "every sentence it can produce is
     translated". Ten of UNAVAILABLE_TEXT's codes are start-time refusals a
     tree press can genuinely raise (mc-agent:start's own vocabulary), every
     one of them was already reaching readerRemedy through startRefusalSentence,
     and nine of the ten passed through untouched -- CODEX_PROTOCOL_VERSION_MISMATCH
     among them, told a browser reader to `npm install -g @openai/codex`
     on their own laptop after Codex on the DRIVEN computer had already moved
     past the version this build speaks to.

     The keys below are the FULL composed sentence -- "Nothing was started. " is
     prepended and the diagnosis is capitalised before this ever reaches
     readerRemedy -- because that composition, not the raw UNAVAILABLE_TEXT
     value, is the string the map is keyed against. src/agent-availability-copy.js's
     own unavailableReason() is also called directly. Those call sites now wrap
     the raw fragment with readerRemedy before adding their surface prefixes
     (readerSentence in views/agent.js and readerSafeReason in
     agent-session.js). Keeping the raw twins below is what lets those wrappers
     translate the same refusal without an import cycle. */
  ['Nothing was started. This copy of ToolsEnabled was built without the part that holds a session to your permission level. It will not start one at a level it cannot hold. Reinstall ToolsEnabled from a complete build.',
    'Nothing was started. The copy of ToolsEnabled on that computer was built without the part that holds a session to your permission level. It will not start one at a level it cannot hold. It has to be reinstalled there from a complete build.'],

  ['Nothing was started. ToolsEnabled could not establish which Windows account owns this installation, so it refused to load an agent. Close ToolsEnabled and open the copy installed for this Windows account.',
    'Nothing was started. ToolsEnabled could not establish which Windows account owns the installation on that computer, so it refused to load an agent. On that computer, close ToolsEnabled and open the copy installed for the Windows account that owns it, then try again from here.'],

  ['Nothing was started. ToolsEnabled is running under a Windows account that does not own this installation, so it refused to load an agent. Close ToolsEnabled and open it from the Windows account that owns it.',
    'Nothing was started. ToolsEnabled on that computer is running under a Windows account that does not own the installation, so it refused to load an agent. On that computer, close ToolsEnabled and open it from the Windows account that owns it, then try again from here.'],

  ['Nothing was started. This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account.',
    'Nothing was started. The agent start on that computer points into a different Windows account, so ToolsEnabled refused it before opening anything there. On that computer, use the copy installed for the account that owns it. Choose a folder owned by that same account, then try again from here.'],

  ['Nothing was started. ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again.',
    'Nothing was started. ToolsEnabled could not safely check an agent path inside the Windows account on that computer, so it refused the start. On that computer, close ToolsEnabled, check that the account folder is available, and then try again from here.'],

  ['Nothing was started. An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account.',
    'Nothing was started. An agent path on that computer crosses a linked folder inside its Windows account, so ToolsEnabled refused it rather than follow the link. On that computer, choose an ordinary folder owned directly by that account, then try again from here.'],

  ['Nothing was started. ToolsEnabled could not construct a safe launch environment for this Windows account, so nothing was started. Close ToolsEnabled and open the copy installed for the account that owns it.',
    'Nothing was started. ToolsEnabled could not construct a safe launch environment for the Windows account that owns the installation on that computer, so nothing was started. On that computer, close ToolsEnabled and open the copy installed for the account that owns it, then try again from here.'],

  ['Nothing was started. ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent.',
    'Nothing was started. ToolsEnabled could not safely resolve the selected assistant account on that computer to one signed-in folder, so nothing was started. On that computer, remove and add that assistant account again in Settings, then start a new agent there.'],

  ['Nothing was started. ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent.',
    'Nothing was started. ToolsEnabled could not safely attach the selected assistant sign-in on that computer to the protected session, so nothing was started. On that computer, close other agent sessions, sign in to that assistant again if needed, then start a new agent there.'],

  ['Nothing was started. ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build.',
    'Nothing was started. ToolsEnabled could not safely build the protected assistant home and tool configuration on that computer, so nothing was started. On that computer, close ToolsEnabled and open it again. If it keeps refusing, reset its local agent data or reinstall it there from a complete build.'],

  ['Nothing was started. ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build.',
    'Nothing was started. ToolsEnabled on that computer could not correctly signal whether this assistant needs browser tools. On that computer, close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build.'],

  ['Nothing was started. This copy of ToolsEnabled was built without the part that keeps a session off your billed account. It will not start one and risk charging you. Reinstall ToolsEnabled from a complete build.',
    'Nothing was started. The copy of ToolsEnabled on that computer was built without the part that keeps a session off your billed account. It will not start one and risk charging you. It has to be reinstalled there from a complete build.'],

  ['Nothing was started. ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again.',
    'Nothing was started. ToolsEnabled could not work out whether an agent can run on that computer, because the question itself was refused. On that computer, close ToolsEnabled and open it again, then try once more from here.'],

  ['Nothing was started. ToolsEnabled is shutting down, so nothing new will be started. Open it again when you want to start an agent.',
    'Nothing was started. ToolsEnabled on that computer is shutting down, so nothing new will be started there. Open it again on that computer when you want to start an agent.'],

  ['Nothing was started. ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again, and if it keeps refusing, reinstall from a complete build.',
    'Nothing was started. ToolsEnabled could not work out whether an agent can run on that computer, because the question itself was refused. On that computer, close ToolsEnabled and open it again; if it keeps refusing, reinstall it there from a complete build.'],

  ['Nothing was started. ToolsEnabled writes down every agent it starts before starting it, and this one could not be written down, so nothing was started. Close ToolsEnabled and open it again; if it still refuses, reinstall from a complete build.',
    'Nothing was started. ToolsEnabled writes down every agent it starts before starting it, and this one could not be written down there, so nothing was started. On that computer, close ToolsEnabled and open it again; if it still refuses, reinstall it there from a complete build.'],

  ['Nothing was started. This request did not come from the ToolsEnabled window itself, so it was refused and nothing was started. Close ToolsEnabled, open it again, and start from the panel in its own window.',
    'Nothing was started. This request did not come from the ToolsEnabled window on that computer itself, so it was refused and nothing was started. On that computer, close ToolsEnabled, open it again, and start from the panel in its own window.'],

  ['Nothing was started. Codex is installed on this computer but did not answer when asked its version, so ToolsEnabled will not build a session on it. Run "codex --version" in Windows Terminal to see what it reports. If that does not explain it, run "codex doctor".',
    'Nothing was started. Codex is installed on that computer but did not answer when asked its version, so ToolsEnabled will not build a session on it. On that computer, open Windows Terminal and run "codex --version" to see what it reports. If that does not explain it, run "codex doctor" there too.'],

  ['Nothing was started. The Codex on this computer did not identify itself as a usable CLI. Open Windows Terminal and run "npm install -g @openai/codex" to repair the Codex installation. "winget install OpenAI.Codex" installs Codex without Node.',
    'Nothing was started. The Codex on that computer did not identify itself as a usable CLI. On that computer, open Windows Terminal and run "npm install -g @openai/codex" to repair the Codex installation. "winget install OpenAI.Codex" installs Codex without Node.'],

  ['Nothing was started. The Codex on this computer cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. Open Windows Terminal and run "codex update", then start again. If Codex is already up to date, update ToolsEnabled.',
    'Nothing was started. The Codex on that computer cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. On that computer, open Windows Terminal and run "codex update", then start again from here. If Codex there is already up to date, update ToolsEnabled on that computer.'],

  ['Nothing was started. This copy could not generate the secure identifier a session is tracked by, so none was started; close ToolsEnabled and open it again.',
    'Nothing was started. The copy on that computer could not generate the secure identifier a session is tracked by, so none was started. On that computer, close ToolsEnabled and open it again, then try once more from here.'],

  /* --- EXTERNAL_CAPABILITIES, from src/permission-guidance.js, read through
     src/guided-step.js -----------------------------------------------------
     A FOURTH TABLE, and the one the census ranked first: it is not a refusal
     at all. Every settings row that names `codex-installed` or
     `codex-cloud-account` (Run an agent session, Launch Codex Cloud tasks)
     hangs a "What this does, and what it risks" disclosure that says HOW to
     sign in, unconditionally, on every load, for anybody who opens it --
     no failure has to occur first. It said "Sign in opens a terminal window
     ... You finish it there", written for the person sitting at the keyboard
     that terminal opens on, and a browser driving that computer over the
     relay was reading its own tab as "there". */
  ['Install fetches Codex from OpenAI, straight to your own computer. Sign in opens a terminal window and runs the sign-in in it. You finish it there, and no password or key comes anywhere near this product.',
    'Install fetches Codex from OpenAI, straight to the computer you are driving, not to this one. On that computer, Sign in opens a terminal window and runs the sign-in in it. It has to be finished there, and no password or key comes anywhere near this product.'],

  ['The sign-in happens in a terminal window, inside Codex itself. This product never asks for that password and never holds it.',
    'The sign-in happens in a terminal window on that computer, inside Codex itself, not in this browser. This product never asks for that password and never holds it.'],

  ['The audited connection is the part of this product that carries out an action and writes the permanent record of it. It runs on this computer and is not reachable from anywhere else.',
    'The audited connection is the part of the product on the computer you are driving. It carries out an action and writes the permanent record of it. It runs on that computer and is not reachable from anywhere else.'],

  ['On "keep my data", your saved sign-ins and the permanent record stay on this computer after the program is gone. Anyone else using this computer could find them.',
    'On "keep my data", your saved sign-ins and the permanent record stay on the computer you are driving after the program is gone. Anyone else using that computer could find them.'],

  /* ACCOUNT_PANEL.commandLead, the sentence in front of every row of the
     multi-account list in that same section: it names no program and takes
     no argument, so it is a literal rather than a pattern, same as the two
     PROVIDER_SIGN_IN entries above are patterns because they take one. */
  [`To sign this folder in, paste this line into ${terminalName()}:`,
    `To sign this folder in on that computer, paste this line into ${terminalName()} there, not here:`],

  /* --- ENGINE_REASON, from src/local-activity.js, read on the HOME SCREEN --
     A FIFTH TABLE, and the one on the page every install lands on first.
     src/views/home.js rendered `fact.text` straight to the DOM with no call to
     readerRemedy at all -- not "wrapped but untranslated" like the tables
     above, just never wrapped -- so a browser driving a fresh one-computer
     account over the relay met "Run winget install OpenAI.Codex in Windows
     Terminal" on the very first screen regardless of any of the fixes above.
     src/views/home.js now reads readerRemedy on every fact; these are its
     twins. Four are ENGINE_REASON's own entries; the fifth is composed inline
     in describeHome() rather than kept in the table, for the `codexSignedOut`
     arm, and is here for the same reason. */
  ['Codex is not installed on this computer, and it is the program that runs an agent. Run "winget install OpenAI.Codex" in Windows Terminal, then "codex login" in a new terminal window',
    'Codex is not installed on that computer, and it is the program that runs an agent. On that computer, run "winget install OpenAI.Codex" in Windows Terminal, then "codex login" in a new terminal window there.'],

  ['Codex is installed but nobody is signed in to it. Run "codex login" in Windows Terminal, then come back to this screen',
    'Codex is installed on that computer, but nobody is signed in to it. On that computer, run "codex login" in Windows Terminal, then come back to this screen from here.'],

  ['Codex could not be found when a session tried to start it. Run "winget install OpenAI.Codex" in Windows Terminal, then "codex login"',
    'Codex could not be found on that computer when a session tried to start it. On that computer, run "winget install OpenAI.Codex" in Windows Terminal, then "codex login" there.'],

  ['the Codex here did not identify itself as a usable CLI. Run "npm install -g @openai/codex" in Windows Terminal to repair the Codex installation',
    'the Codex on that computer did not identify itself as a usable CLI. On that computer, run "npm install -g @openai/codex" in Windows Terminal to repair the Codex installation.'],

  ['The Codex here cannot run a session. It lacks something a session needs, or it gave an answer this copy cannot read. Run "codex update" in Windows Terminal, then start again. If Codex is already up to date, update ToolsEnabled',
    'The Codex on that computer cannot run a session. It lacks something a session needs, or it gave an answer this copy cannot read. On that computer, run "codex update" in Windows Terminal, then start again from here. If Codex there is already up to date, update ToolsEnabled on that computer.'],

  ['This copy can start an agent, but nobody is signed in to Codex yet. Run "codex login" in Windows Terminal, then come back to this screen',
    'The copy on that computer can start an agent, but nobody is signed in to Codex yet. On that computer, run "codex login" in Windows Terminal, then come back to this screen from here.'],

  /* --- UNAVAILABLE_TEXT, RAW -- from src/agent-availability-copy.js, but this
     time the UNCOMPOSED value, which is a DIFFERENT string from the
     "Nothing was started. <Capitalized diagnosis>." entries earlier in this
     map. unavailableReason(code) is called DIRECTLY -- with neither prefix
     nor readerRemedy -- from src/agent-session.js (five call sites, each
     folding the answer into `unavailable · ${...}` or `refused · ${...}`)
     and from src/views/agent.js (the steering controls' result line and the
     chat's own start-refusal composer). tools/test/reader-remedy-coverage.test.mjs
     named this gap in 2026-08-24 and did not close it, because no twin fixes
     a call site that never asks for one; both files now read readerRemedy
     on the raw fragment BEFORE folding it into their own prefix, which is
     why the twins below are keyed to the lower-case fragment rather than the
     capitalized, prefixed sentence used elsewhere in this map. Only the
     entries that actually carry a physical instruction get a twin here --
     see tools/desk-phrase-remote-twin.mjs, which found these by scanning
     every string literal in src/ rather than by reading call sites, and
     found nothing outside this table and the two below it. */
  ['Codex is not installed on this computer, and Codex is the program that actually runs an agent. Open Windows Terminal and run "winget install OpenAI.Codex". If you already have Node, "npm install -g @openai/codex" does the same job. Then open a new terminal window and run "codex login"',
    'Codex is not installed on that computer, and Codex is the program that actually runs an agent. It has to be installed there, not here. On that computer, open Windows Terminal and run "winget install OpenAI.Codex" (or "npm install -g @openai/codex" if it already has Node). Then run "codex login" in a new terminal window there'],

  ['this copy of ToolsEnabled was built without the part that holds a session to your permission level. It will not start one at a level it cannot hold. Reinstall ToolsEnabled from a complete build',
    'the copy of ToolsEnabled on that computer was built without the part that holds a session to your permission level. It will not start one at a level it cannot hold. It has to be reinstalled there from a complete build'],

  ['ToolsEnabled could not establish which Windows account owns this installation, so it refused to load an agent. Close ToolsEnabled and open the copy installed for this Windows account',
    'ToolsEnabled could not establish which Windows account owns the installation on that computer, so it refused to load an agent. On that computer, close ToolsEnabled and open the copy installed for the Windows account that owns it, then try again from here'],

  ['ToolsEnabled is running under a Windows account that does not own this installation, so it refused to load an agent. Close ToolsEnabled and open it from the Windows account that owns it',
    'ToolsEnabled on that computer is running under a Windows account that does not own the installation, so it refused to load an agent. On that computer, close ToolsEnabled and open it from the Windows account that owns it, then try again from here'],

  ['This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account',
    'The agent start on that computer points into a different Windows account, so ToolsEnabled refused it before opening anything there. On that computer, use the copy installed for the account that owns it. Choose a folder owned by that same account, then try again from here'],

  ['ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
    'ToolsEnabled could not safely check an agent path inside the Windows account on that computer, so it refused the start. On that computer, close ToolsEnabled, check that the account folder is available, and then try again from here'],

  ['An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account',
    'An agent path on that computer crosses a linked folder inside its Windows account, so ToolsEnabled refused it rather than follow the link. On that computer, choose an ordinary folder owned directly by that account, then try again from here'],

  ['ToolsEnabled could not construct a safe launch environment for this Windows account, so nothing was started. Close ToolsEnabled and open the copy installed for the account that owns it',
    'ToolsEnabled could not construct a safe launch environment for the Windows account that owns the installation on that computer, so nothing was started. On that computer, close ToolsEnabled and open the copy installed for the account that owns it, then try again from here'],

  ['ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
    'ToolsEnabled could not safely resolve the selected assistant account on that computer to one signed-in folder, so nothing was started. On that computer, remove and add that assistant account again in Settings, then start a new agent there'],

  ['ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
    'ToolsEnabled could not safely attach the selected assistant sign-in on that computer to the protected session, so nothing was started. On that computer, close other agent sessions, sign in to that assistant again if needed, then start a new agent there'],

  ['ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
    'ToolsEnabled could not safely build the protected assistant home and tool configuration on that computer, so nothing was started. On that computer, close ToolsEnabled and open it again. If it keeps refusing, reset its local agent data or reinstall it there from a complete build'],

  ['this copy of ToolsEnabled was built without the part that keeps a session off your billed account. It will not start one and risk charging you. Reinstall ToolsEnabled from a complete build',
    'the copy of ToolsEnabled on that computer was built without the part that keeps a session off your billed account. It will not start one and risk charging you. It has to be reinstalled there from a complete build'],

  ['ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again',
    'ToolsEnabled could not work out whether an agent can run on that computer, because the question itself was refused. On that computer, close ToolsEnabled and open it again, then try once more from here'],

  ['ToolsEnabled is shutting down, so nothing new will be started. Open it again when you want to start an agent',
    'ToolsEnabled on that computer is shutting down, so nothing new will be started there. Open it again on that computer when you want to start an agent'],

  ['ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again, and if it keeps refusing, reinstall from a complete build',
    'ToolsEnabled could not work out whether an agent can run on that computer, because the question itself was refused. On that computer, close ToolsEnabled and open it again; if it keeps refusing, reinstall it there from a complete build'],

  ['ToolsEnabled writes down every agent it starts before starting it, and this one could not be written down, so nothing was started. Close ToolsEnabled and open it again; if it still refuses, reinstall from a complete build',
    'ToolsEnabled writes down every agent it starts before starting it, and this one could not be written down there, so nothing was started. On that computer, close ToolsEnabled and open it again; if it still refuses, reinstall it there from a complete build'],

  ['this request did not come from the ToolsEnabled window itself, so it was refused and nothing was started. Close ToolsEnabled, open it again, and start from the panel in its own window',
    'this request did not come from the ToolsEnabled window on that computer itself, so it was refused and nothing was started. On that computer, close ToolsEnabled, open it again, and start from the panel in its own window'],

  ['the Codex program could not be found when the session tried to start it. Open Windows Terminal and run "winget install OpenAI.Codex". If you already have Node, "npm install -g @openai/codex" does the same job. Then run "codex login"',
    'the Codex program could not be found on that computer when the session tried to start it. On that computer, open Windows Terminal and run "winget install OpenAI.Codex" (or "npm install -g @openai/codex" if it already has Node). Then run "codex login" there'],

  ['Codex is installed on this computer but did not answer when asked its version, so ToolsEnabled will not build a session on it. Run "codex --version" in Windows Terminal to see what it reports. If that does not explain it, run "codex doctor"',
    'Codex is installed on that computer but did not answer when asked its version, so ToolsEnabled will not build a session on it. On that computer, open Windows Terminal and run "codex --version" to see what it reports. If that does not explain it, run "codex doctor" there too'],

  ['the Codex on this computer did not identify itself as a usable CLI. Open Windows Terminal and run "npm install -g @openai/codex" to repair the Codex installation. "winget install OpenAI.Codex" installs Codex without Node',
    'the Codex on that computer did not identify itself as a usable CLI. On that computer, open Windows Terminal and run "npm install -g @openai/codex" to repair the Codex installation. Running "winget install OpenAI.Codex" there installs Codex without Node'],

  ['the Codex on this computer cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. Open Windows Terminal and run "codex update", then start again. If Codex is already up to date, update ToolsEnabled',
    'the Codex on that computer cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. On that computer, open Windows Terminal and run "codex update", then start again from here. If Codex there is already up to date, update ToolsEnabled on that computer'],

  ['the session did not start and this copy could not work out why, which is itself a fault worth reporting. Try once more. If it happens again, reinstall ToolsEnabled from a complete build',
    'the session did not start and this copy could not work out why, which is itself a fault worth reporting. Try once more from here. If it happens again, reinstall ToolsEnabled on that computer from a complete build'],

  ['this copy could not generate the secure identifier a session is tracked by, so none was started; close ToolsEnabled and open it again',
    'the copy on that computer could not generate the secure identifier a session is tracked by, so none was started. On that computer, close ToolsEnabled and open it again, then try once more from here'],

  /* --- app-owned session lifecycle refusals. These are reachable through
     both the raw reader tables and startRefusalSentence(), whose prefix and
     sentence-capitalisation make a distinct exact key. A browser reader must
     never be told to close the browser-side copy of ToolsEnabled. */
  ['ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
    'ToolsEnabled on that computer could not correctly signal whether this assistant needs browser tools, so nothing was started. On that computer, close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build'],
  ['the session did not finish closing, so this screen cannot honestly call it stopped. Close ToolsEnabled to end every session, then open it again',
    'the session on that computer did not finish closing, so this screen cannot honestly call it stopped. On that computer, close ToolsEnabled to end every session, then open it again and retry from here'],
  ['Nothing was started. The session did not finish closing, so this screen cannot honestly call it stopped. Close ToolsEnabled to end every session, then open it again.',
    'Nothing was started. The session on that computer did not finish closing, so this screen cannot honestly call it stopped. On that computer, close ToolsEnabled to end every session, then open it again and retry from here.'],

  ['the app-owned identity channel was not ready, so the named agent was not started. Close ToolsEnabled, open it again, then retry from this screen',
    'the app-owned identity channel on that computer was not ready, so the named agent was not started. On that computer, close ToolsEnabled and open it again, then retry from here'],
  ['Nothing was started. The app-owned identity channel was not ready, so the named agent was not started. Close ToolsEnabled, open it again, then retry from this screen.',
    'Nothing was started. The app-owned identity channel on that computer was not ready, so the named agent was not started. On that computer, close ToolsEnabled and open it again, then retry from here.'],

  ['ToolsEnabled could not establish its app-owned agent identity channel, so it did not start the named agent. Close ToolsEnabled, open it again, then retry',
    'ToolsEnabled on that computer could not establish its app-owned agent identity channel, so it did not start the named agent. On that computer, close ToolsEnabled and open it again, then retry from here'],

  /* --- BRIDGE_IDEMPOTENCY_UNAVAILABLE, a `remedy` OVERRIDE composed inline in
     src/mission-bridge.js createTerminateController() rather than kept in
     REFUSAL_REMEDY -- see the note beside it for why. It reaches the glass
     through src/views/agent.js's terminate control, which now reads
     readerRemedy on `state.message` beside the other steering controls on
     that page. */
  ['No request was sent and nothing has been stopped. Close ToolsEnabled and open it again before pressing stop a second time.',
    'No request was sent and nothing has been stopped. On that computer, close ToolsEnabled and open it again before pressing stop a second time from here.'],

  /* --- BRIDGE_TERMINATE_ALREADY_TERMINAL. The agent page already gives this
     stored remedy to readerRemedy for relay readers; without an exact twin the
     frozen-table value passed through unchanged and named the reader's desk. */
  ['There was nothing left to stop — it had already finished. Nothing on this computer is still running from it.',
    'There was nothing left to stop — it had already finished. Nothing on that computer is still running from it.'],

  /* --- START_REFUSAL_TEXT.AGENT_ENGINE_UNAVAILABLE, local to
     src/views/agent.js's chat start-refusal composer (startRefusal()) --
     a SEVENTH source, and a small one: the file keeps its own four-entry
     table beside the shared one because a code-only match short-circuits
     unavailableReason() for the two BRIDGE_ phrasings (BRIDGE_ALL_SEATS_BUSY,
     BRIDGE_CLAUDE_UNAVAILABLE) and the MC_AGENT_SESSION_LIMIT phrasing that
     page wanted differently worded. Only this one entry carries a physical
     instruction. */
  ['This copy of the app cannot start agents: the agent engine is not part of this build. Reinstalling from a full download is what fixes it.',
    'The copy of the app on that computer cannot start agents: the agent engine is not part of that build. It has to be reinstalled there from a full download.'],

  /* --- LEDGER_UNREADABLE / QUESTIONS_UNREADABLE / KIND_UNREADABLE, from src/ledger-copy.js,
     read by src/views/ledger.js. An EIGHTH source, and unlike the others it
     was never routed through readerRemedy at all: renderRegister() wrote
     `notice.body` straight into `register.innerHTML`. The register is fed by
     the same three-way source (this copy, the relay, or the example fleet)
     views/ledger.js's own comment names for its data rows, so the failure
     path is exactly as reachable over the relay as the success path is --
     src/views/ledger.js now reads readerRemedy on both notice bodies. */
  ['Your requests could not be read, so this page cannot show them. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
    'Your requests could not be read, so this page cannot show them. Nothing was changed. On that computer, close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.'],

  ['Your questions could not be read, so this page cannot show them. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
    'Your questions could not be read, so this page cannot show them. Nothing was changed. On that computer, close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.'],

  ['This list could not be read, so this page cannot show it. Nothing was changed. Close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.',
    'This list could not be read, so this page cannot show it. Nothing was changed. On that computer, close ToolsEnabled and open it again; if it still will not read, this copy needs attention before this page will work.'],

  /* --- the lede for provider sign-ins on the Settings section This computer.
     The call site already reads readerRemedy() on it --
     `${esc(readerSentence('An agent runs on...'))}` -- so this is the rarer
     shape: a wrapped call site with no twin, rather than an unwrapped one.
     UPDATED for the fourth row (B-pool-3, local models): the sentence gained
     a clause about a model on the person's own hardware, which has no
     sign-in at all -- the exact desk text changed, so the twin below is a
     replacement, not an addition beside the old one; the old key would never
     match again and a stale entry left in place would just be dead weight
     REMOTE_TWIN_KEYS carries forever. */
  ['An agent runs on one of these programs, or on a model already running on your own computer. Codex, Claude and Gemini are each a separate install with its own sign-in, and none of them is your ToolsEnabled account. ToolsEnabled never asks for those sign-ins and never keeps one. Each one below has two buttons: Install puts it on this computer, and Sign in opens a terminal window that signs you in. A model on this computer has no sign-in at all; its own section below explains what it needs instead.',
    'An agent runs on one of these programs, or on a model already running on that computer. Codex, Claude and Gemini are each a separate install with its own sign-in, and none of them is your ToolsEnabled account. ToolsEnabled never asks for those sign-ins and never keeps one. Each one below has two buttons: Install and Sign in. Install puts it on that computer, not this one, and Sign in opens a terminal window there that signs you in. A model on that computer has no sign-in at all; its own section below explains what it needs instead.'],
]))

export function readerRemedy(sentence, { viaRelay = false } = {}) {
  if (!viaRelay || typeof sentence !== 'string') return sentence
  const twin = REMOTE_TWIN.get(sentence)
  if (twin) return twin
  for (const [pattern, transform] of DESK_PATTERNS) {
    const match = sentence.match(pattern)
    if (match) return transform(match)
  }
  return sentence
}

/** The declared desk-to-remote correspondence, exported so the coverage test can
 *  check it against the live vocabulary rather than restating it. */
export const REMOTE_TWIN_KEYS = Object.freeze([...REMOTE_TWIN.keys()])

/* WRITTEN FOR THE REFUSALS A PERSON ACTUALLY REACHES, not for the whole
   vocabulary. Each is one sentence that says what did not happen and then
   spends the rest of its length on what to do about it -- the pattern
   src/agent-availability-copy.js set. Where the engine's own `reason` is
   already the better half of the answer it is shown too (see composition in
   refusalSentence); these are the REMEDY half. */
export const REFUSAL_REMEDY = Object.freeze({
  RULES_POLICY_UNAVAILABLE: 'ToolsEnabled could not load the rules needed for this agent. Reinstall or update ToolsEnabled from a complete build, then try again.',
  RULES_CONTEXT_UNAVAILABLE: 'The complete rules could not be read, so your message was not sent. Check the rules in Ledger, then try again after they can be read.',
  RULES_POLICY_CHANGED: 'The rules setting changed before your message was sent. Try sending it again to use the current setting.',
  /* --- the background service is not there, which is most of a clean machine's
         refusals and the reason the whole family shares one cure --- */
  BRIDGE_UNREACHABLE: RESTART_REMEDY,
  BRIDGE_DISCOVERY_UNAVAILABLE: RESTART_REMEDY,
  BRIDGE_OWN_LAYER_INVALID: RESTART_REMEDY,
  BRIDGE_OWN_LAYER_UNCONFIRMED: 'Nothing was sent, on purpose: ToolsEnabled would not hand its credentials to a service it could not confirm was its own. Close the whole app and open it again; if it keeps refusing, something else on this computer is holding the address it uses.',
  BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE: 'Nothing was sent. This page can only do audited work inside the installed ToolsEnabled application; open the installed app rather than this page in a browser.',
  BRIDGE_BOOTSTRAP_REFUSED: RESTART_REMEDY,
  BRIDGE_UNAUTHORIZED: 'Nothing was sent. The permission this window holds is no longer being accepted; close ToolsEnabled and open it again to get a fresh one.',
  BRIDGE_TOKEN_INVALID: 'Nothing was sent. The permission this window holds is no longer being accepted; close ToolsEnabled and open it again to get a fresh one.',
  /* "a second one" WHAT? This is the shared timeout for every audited action --
     approve and decline, report-read, queue, the research snapshot, the owner
     prompt answers -- not only a dispatch. On those screens "start a second
     one" is false and "one" has no antecedent, so the warning was both wrong
     and unreadable exactly where it was needed. The replacement is true of
     every action that can raise this and keeps the warning intact. */
  BRIDGE_TIMEOUT: 'Nothing came back in time, so it is not known whether anything happened. Look at the screen this control belongs to before pressing it again — if the first press did land, a second would repeat it.',
  BRIDGE_REQUEST_FAILED: 'Nothing was confirmed. Try once more; if it refuses again, close ToolsEnabled and open it a second time before assuming nothing ran.',
  BRIDGE_REQUEST_REFUSED: 'Nothing was done. Check what you chose above, try once more, and if it keeps refusing leave it alone rather than pressing repeatedly.',
  BRIDGE_REFUSED: 'Nothing was done and this copy was not told why. Try once more, and if it refuses again, close ToolsEnabled and open it a second time.',

  /* BUSY IS THE ONE REFUSAL ON THE CONNECT SCREEN A PERSON MEETS WITHOUT HAVING
   * DONE ANYTHING, and until this entry existed it fell to the DEVICE_CLAIM_
   * family floor -- "Open your account page to see which computers are joined"
   * -- which is advice about somewhere else entirely for somebody who has just
   * been told to wait.
   *
   * The diagnosis it follows reads "This computer is already in the middle of a
   * connection step. Wait for that one to finish." The honest remedy is the
   * length of the wait and what to do if it does not end, because the step it
   * names is usually one this window started for itself: shell/main.cjs reads
   * the vault at launch, and that read used to collide with the connect
   * screen's own. Concurrent reads now join rather than refuse
   * (shell/device-claim.cjs), so this should be rare -- and a rare refusal with
   * no remedy is worse than a common one, because nobody has learned what it
   * means. */
  DEVICE_CLAIM_BUSY: 'Nothing was sent. A step this computer had already started is still finishing; give it a few seconds and press the button again. If it keeps saying this, close ToolsEnabled and open it a second time.',

  /* --- a reply that arrived but could not be trusted. These must never read as
         "it failed", because the work may well be running; the person's next
         move is to LOOK, not to retry. --- */
  BRIDGE_DISPATCH_RECEIPT_INVALID: 'This may already be running. Do not press it again — open the fleet page and look for it first, and only start another if nothing is there.',
  BRIDGE_TERMINATE_RECEIPT_INVALID: 'Nothing has been confirmed stopped. Refresh this page and look at whether it is still running before pressing stop again.',
  BRIDGE_LEDGER_ARCHIVE_PREVIEW_INVALID: 'Nothing was moved. Ask for the preview again; nothing is retired until a preview you can read has been confirmed.',
  BRIDGE_LEDGER_ARCHIVE_RECEIPT_INVALID: 'Preview it again before any retry, and read the preview: the result did not match what was confirmed, so what moved is not known from this screen.',

  /* --- somebody, or something, is already there --- */
  AGENT_PRESENCE_ACTIVE: 'Nothing new was started, and that is the cap doing its job: this agent already has a session running. Stop the one that is running, or pick a different agent.',
  BRIDGE_AGENT_LANE_COLLISION: 'Nothing new was started, and that is the cap doing its job: this agent already has a lane running. Stop the one that is running, or pick a different agent.',
  LAUNCH_FANOUT_EXCEEDED: 'Nothing new was started. As many agents as this copy will run at once are already running; stop one before starting another.',
  /* A CAPACITY ANSWER, AND IT MUST NOT READ AS A FAULT. The engine allocates a
     free agent from the pool this level shares and refuses only when every one
     of them is carrying work. Nothing is misconfigured, nothing needs fixing,
     and the two things a person can actually do are both about the agents that
     are already running — so this is worded like the cap above it rather than
     like the declaration refusals further down, which ask them to change what
     they chose. Getting that backwards sends somebody to edit their fleet over
     a queue that would have cleared on its own. */
  BRIDGE_ALL_SEATS_BUSY: 'Nothing new was started, and nothing is wrong: every agent this copy can run at this level is already working. Wait for one of them to finish, or stop one from the fleet page, and then start this again.',
  BRIDGE_TERMINATE_IN_PROGRESS: 'A stop for this one is already on its way. Wait for it rather than sending a second.',
  BRIDGE_TERMINATE_ALREADY_TERMINAL: 'There was nothing left to stop — it had already finished. Nothing on this computer is still running from it.',
  BRIDGE_TERMINATE_NOT_ACTIVE: 'There was nothing running to stop. Refresh this page; what it was showing you is out of date.',
  BRIDGE_TERMINATE_STALE_PID: 'Nothing was stopped, because what this page thought was running is not what is running now. Refresh the page and look again before pressing stop.',
  BRIDGE_TERMINATE_STALE_RUN: 'Nothing was stopped, because what this page thought was running is not what is running now. Refresh the page and look again before pressing stop.',

  /* --- refusals that are the product protecting its own record. Each is a
         deliberate stop, so none of them apologises. --- */
  BRIDGE_AUDIT_UNAVAILABLE: 'Nothing was done, deliberately: ToolsEnabled will not take an action it cannot write down. Close the app and open it again, and if it keeps refusing, the record on this computer needs attention before anything else here will work.',
  BRIDGE_GUARD_REFUSED: 'Nothing was done. A rule set on this computer refused it, and the sentence above is that rule speaking — change what you asked for, because nothing else will clear it.',
  BRIDGE_ACTOR_REFUSED: 'Nothing was done. The agent this window is acting as is not the one allowed to do it; pick a different agent, or change which one is in charge from the fleet page.',
  BRIDGE_LEDGER_ARCHIVE_CONFIRMATION_REQUIRED: 'Nothing was moved. Ask for a fresh preview and confirm that, rather than confirming one that has been sitting on screen.',

  /* --- the request itself was wrong, which is the one family where the person
         really can fix it in the box in front of them --- */
  BRIDGE_INPUT_INVALID: 'Nothing was sent. Correct what you typed above and try again.',
  BRIDGE_INPUT_TOO_LARGE: 'Nothing was sent because what you typed is too long. Shorten it and try again.',
  BRIDGE_TARGET_MALFORMED: 'Nothing was sent. Choose the target again from the list rather than typing it.',
  BRIDGE_TIER_REFUSED: 'Nothing was started. Choose one of the agent levels offered in the list above.',
  BRIDGE_ROOT_UNAVAILABLE: 'Nothing was started. The folder this work would run in is not reachable from this computer; pick another from the list.',
  BRIDGE_REPORT_NOT_FOUND: 'Nothing was read, because there is no such report. Check the file name above; only Markdown reports inside a declared folder can be opened here.',
  BRIDGE_REPORT_PATH_REFUSED: 'Nothing was read. Only Markdown reports inside a declared folder can be opened here — a path that points anywhere else is refused on purpose.',

  /* --- Codex Cloud. Money and a remote service, so the reassurance about spend
         comes first and is stated even when the refusal is trivial. --- */
  CLOUD_LAUNCH_SWITCHED_OFF: 'Nothing was launched and nothing was spent. Launching on Codex Cloud is switched off in Settings; turn it on there first.',
  BRIDGE_CLOUD_LAUNCH_DENIED: 'Nothing was launched and nothing was spent, because the approval this launch needed was not given. Open Ledger → Purchases and answer it there, then launch again.',
  BRIDGE_CLOUD_LAUNCH_UNCONFIRMED: 'It is not known whether this launched, so do not press it again yet: open Codex Cloud and look for the task there first.',
  BRIDGE_CLOUD_ENVIRONMENT_NOT_AUTHORIZED: 'Nothing was launched and nothing was spent. The environment chosen above is not one this copy is allowed to launch into; pick another.',
  BRIDGE_CLOUD_REPOSITORY_MISMATCH: 'Nothing was launched and nothing was spent. The environment chosen above belongs to a different repository than the work does; pick the one that matches.',
  BRIDGE_CLOUD_BINDING_UNVERIFIED: 'Nothing was launched and nothing was spent, because this copy could not confirm which cloud account the work would be billed to and it will not guess. Choose the account and environment explicitly above, then try again.',
  /* THESE TWO WERE FOUND BY DRIVING, NOT BY READING. tools/refusal-copy-qa.mjs
     presses the fleet page's Dispatch and the cloud panel's Refresh on a
     sterile profile, and these are the codes that actually come back on a clean
     machine -- neither appears in any list of codes in this repository. Without
     an entry they fell to GENERIC_REMEDY, which is a whole sentence and still
     the wrong advice: "try once more" is useless when what is missing is an
     account registry that no retry will create.

     The engine's own message for ACCOUNTS_REGISTRY_MISSING names the file's
     absolute path. It does NOT reach the glass -- the bridge's typedError()
     replaces the message with "The audited dependency refused the action." and
     keeps only the code -- and this entry must not put it back. */
  /* THE REMEDY CHANGED BECAUSE THE OLD ONE DID NOT WORK. "Sign in to Codex
     Cloud on this machine first" sent a person to run the provider's sign-in,
     which writes a credential and does NOT put an account on this list -- the
     list is a registry the cloud lane reads, and nothing in the product wrote
     it. They came back to the panel and met this same paragraph. The Codex
     Cloud panel has an add-an-account control now, and it is the thing that
     actually ends this state: it makes the folder, writes the entry and opens
     the sign-in in one press. */
  ACCOUNTS_REGISTRY_MISSING: 'Nothing was read and nothing was spent: this computer has no list of Codex Cloud accounts, so there is nothing to launch into. Add an account on the Codex Cloud panel — it needs a name and nothing else.',
  BRIDGE_AGENT_DECLARATION_MISSING: 'Nothing was started. The engine and effort chosen above is not one this copy has an agent declared for; choose a different one from the list.',

  /* --- REFUSALS FROM THE LAUNCH RECORD, which is the gate a dispatch reaches
         AFTER the bridge has resolved which agent to use.
   *
   * WHY THESE ARE HERE NOW. This table curated exactly one of them, and the
   * other twenty-odd fell through every family to the generic remedy — which
   * tells a stranger to close and reopen the application. Not one of these
   * refusals is cured by restarting anything: each is the product declining to
   * start a particular agent for a stated reason, and the person's next move is
   * to choose differently or to change what their own fleet allows. Advice that
   * confident and that wrong is worse than none, because the reader does it,
   * loses their window, and arrives back at the same refusal.
   *
   * They were unreachable on a customer's machine while the shipped default
   * organisation declared a controller and nothing else: every dispatch died one
   * step earlier, before any of these gates could speak. Now that a fresh
   * install ships agents these become live refusals on real installations.
   *
   * NONE OF THEM NAMES THE AGENT. The engine's own messages do — "Agent
   * \"claude-3\" is disabled in the declared org" — but that text never reaches
   * the glass: the bridge replaces it with a generic diagnosis and keeps only
   * the code. These sentences must not put it back, so each says "the agent
   * chosen above", which is what the person is looking at anyway. --- */
  LAUNCH_DISABLED_AGENT: 'Nothing was started. The agent this would have used is switched off in this copy\'s own list of agents; turn it back on from the fleet page, or choose a different agent here.',
  LAUNCH_UNKNOWN_AGENT: 'Nothing was started, because this copy has no agent by the name this screen asked for — usually because the list on screen is older than the one on this computer. Reload the page and choose again.',
  LAUNCH_PHASE_REJECTED: 'Nothing was started. The agent chosen above is not allowed to take this piece of work; pick a different agent, or change what that one may work on from the fleet page.',
  LAUNCH_SCOPE_ACTIVATION_REQUIRED: 'Nothing was started. This agent is deliberately kept switched off and can only be turned on by a specific written permission, which nothing on this screen can give it; choose a different agent.',
  LAUNCH_SCOPE_PROVENANCE_REQUIRED: 'Nothing was started. This agent is deliberately kept switched off and can only be turned on by a specific written permission, which nothing on this screen can give it; choose a different agent.',

  /* --- the declared organisation --- */
  /* The diagnosis this pairs with (ORG_ABSENT_REASON in src/org-controls.js)
     already names the installed app, so repeating it here would say the same
     thing twice in one breath. What it does not say is the consequence, which
     is the half a person needs before they go looking for a switch. */
  ORG_BRIDGE_ABSENT: 'Nothing has been changed by this attempt, and nothing on this page can be changed until you open it there.',
  ORG_READ_FAILED: 'Nothing was changed. Reload this page; if the hierarchy still will not open, the organisation file on this computer needs attention.',
  ORG_READ_THREW: 'Nothing was changed. Reload this page; if the hierarchy still will not open, the organisation file on this computer needs attention.',
  AGENT_ORG_STORE_REVISION_CONFLICT: 'Nothing was changed. Another window changed the organisation first — this page has re-read it, so look at the current hierarchy and make the change again.',

  /* --- "you would have to be subscribed for this", and the one family whose
         remedy the generic floor got actively WRONG ---
   *
   * Measured before this block existed: every one of these codes fell through
   * to GENERIC_REMEDY, so a person who was refused because they are not
   * subscribed was told to try again and then to close and reopen the
   * application. They can do that all day. Restarting is not merely unhelpful
   * here, it is confident advice pointing away from the only thing that would
   * work, on the refusal that is the product's own best moment to say what a
   * subscription is for.
   *
   * EACH ONE NAMES THE PAGE, and none of them is a link. Every surface that
   * renders a refusal puts these sentences in as TEXT -- refusalSentence()
   * returns a string and the nine call sites assign it to textContent -- so an
   * anchor written here would reach a person as visible markup. The page is
   * named in words instead, and it is genuinely reachable in two presses now
   * that the account screen and the home screen both offer a door to it; before
   * this lane there was nowhere to send anybody, which is the other half of why
   * these entries did not exist.
   *
   * NONE OF THEM SAYS THE PERSON HAS LOST ANYTHING. What a subscription buys is
   * the hosted side of the product, and an install that has paid nothing is a
   * complete, supported, permanent state (the engine's UNLICENSED_INSTALL). A
   * remedy that read as "you are locked out until you pay" would contradict the
   * page it is sending them to. */
  ENTITLEMENT_REQUIRED: SUBSCRIPTION_COMING_SOON_REMEDY,
  ENTITLEMENT_TIER_INSUFFICIENT: SUBSCRIPTION_COMING_SOON_REMEDY,
  ENTITLEMENT_EXPIRED: SUBSCRIPTION_COMING_SOON_REMEDY,
  ENTITLEMENT_INACTIVE: SUBSCRIPTION_COMING_SOON_REMEDY,
  ENTITLEMENT_REVOKED: SUBSCRIPTION_COMING_SOON_REMEDY,
  ENTITLEMENT_LICENSE_KEY_INVALID: SUBSCRIPTION_COMING_SOON_REMEDY,
})

/* THE FLOOR. Every code that reaches here without a curated sentence still
   leaves with one, chosen by prefix and ordered most-specific-first because
   `BRIDGE_TERMINATE_` and `BRIDGE_CLOUD_` are both `BRIDGE_`. A code that
   matches nothing at all gets GENERIC_REMEDY, which is still a whole sentence
   with an action in it. This array is the reason a code added to the engine
   next month cannot reach a customer as a bare identifier. */
const FAMILY_REMEDY = Object.freeze([
  /* THE PAID SURFACES, whose whole namespaces are about something a
     subscription pays for, so one sentence is true of every code in them --
     including the ones that mean "we could not confirm what you have paid for"
     rather than "you have not paid". Both leave a person in the same place with
     the same next move, and neither is cured by restarting the application,
     which is what the generic floor was telling them. */
  Object.freeze([/^(HOSTED_RELAY_ENTITLEMENT_|PAID_SURFACE_ENTITLEMENT_|ANYWHERE_TRANSPORT_ENTITLEMENT_)/,
    SUBSCRIPTION_COMING_SOON_REMEDY]),
  Object.freeze([/^BRIDGE_TERMINATE_/, 'Nothing has been confirmed stopped. Refresh this page and look at whether it is still running before pressing stop again.']),
  Object.freeze([/^BRIDGE_CLOUD_/, 'Nothing was launched and nothing was spent. Check the account and environment chosen above, then try again.']),
  Object.freeze([/^BRIDGE_AGENT_/, 'Nothing was started. Check the folder and the agent chosen above, then try once more; if it refuses again, look at the fleet page before starting anything else.']),
  /* THE FLOOR UNDER THE LAUNCH RECORD, and the one this table most needed. Its
     vocabulary is over twenty codes — the widest single family the engine has —
     and every one of them means the same thing to a person: this particular
     agent was not started, and no amount of restarting the application will
     change that. So the floor sends them to the two places that CAN change it,
     the choice in front of them and the fleet page, rather than to the restart
     the generic remedy would have offered. */
  Object.freeze([/^LAUNCH_/, 'Nothing was started, and nothing else was changed. Check the agent and the level chosen above and try once more; if it refuses again, open the fleet page and look at what is already running before starting anything else.']),
  Object.freeze([/^BRIDGE_LEDGER_/, 'Nothing was moved. Ask for a fresh preview and read it before confirming anything.']),
  /* THE ENGINE'S OWN ARCHIVE CODES, which reach this table unchanged:
     capability/tools/ledger-archive.js fails with LEDGER_ARCHIVE_* (protected
     request, exposure not yet sufficient, target ineligible, vetoed, locked,
     plan changed...) and the bridge's typedError() keeps a well-formed code as
     it is. Every one of them means the same thing to a person -- this request
     was left exactly where it was -- and the one thing they can do about a
     row that will not archive is take it off the screen, which the Ledger
     page's × does. Without this floor they fell to GENERIC_REMEDY and were
     told to close and reopen the application, which changes nothing here. */
  Object.freeze([/^LEDGER_ARCHIVE_/, 'Nothing was moved. This request stays where it is; you can hide it from the Ledger page instead.']),
  Object.freeze([/^BRIDGE_(BOOTSTRAP|TOKEN|ORIGIN|PORT|BIND|RUNTIME|SETTINGS|DEPENDENCY)_/, RESTART_REMEDY]),
  Object.freeze([/^BRIDGE_(INPUT|BODY|JSON|CONTENT_TYPE|ROUTE)_/, 'Nothing was sent. Correct what you typed above and try again.']),
  Object.freeze([/^BRIDGE_/, 'Nothing was done. Try once more, and if it refuses again, close ToolsEnabled and open it a second time before assuming anything ran.']),
  Object.freeze([/^(AGENT_ORG_|ORG_)/, 'Nothing was changed. Reload this page and look at the current hierarchy before making the change again.']),
  Object.freeze([/^(CLOUD_|CODEX_CLOUD_)/, 'Nothing was launched and nothing was spent. Check the account and environment chosen above, then try again.']),
  Object.freeze([/^LOOP_/, 'Nothing further was started. Look at the fleet page to see what is already running before starting more.']),
  Object.freeze([/^(AGENT_|SETUP_|CODEX_)/, 'Nothing was started. Open the agent page to see what this copy needs before trying again.']),
  /* CONNECTING THIS COMPUTER, whose fourteen codes all arrive from
     shell/device-claim.cjs with a diagnosis that ALREADY ENDS IN ITS OWN
     REMEDY -- "Updating the app is what fixes it", "Remove it on the account
     page first", "Use up to 64 ordinary characters". Without an entry here
     every one of them fell to GENERIC_REMEDY and was handed a second remedy
     contradicting the first: a name that is too long was answered with "close
     ToolsEnabled and open it a second time", which is the precise mistake the
     LAUNCH_ family above exists to stop. So this floor says only what is true
     of all fourteen and CANNOT CONTRADICT ANY OF THEM -- the two places a
     person can look -- and leaves the specific cure to the sentence the shell
     already wrote. A first draft of this line said "nothing was sent and this
     computer was not joined", which reads as a flat denial of the diagnosis it
     follows on ALREADY_CONNECTED. A floor sentence is appended to refusals
     nobody has read together, so it may only say what is true of all of
     them. */
  Object.freeze([/^DEVICE_CLAIM_/, 'Open your account page to see which computers are joined to your account; a new code comes from this screen.']),
  Object.freeze([/^(MC_ACCOUNT_|ACCOUNT_)/, 'Nothing was recorded. Open Settings, check who is signed in on this computer, then come back to this page.']),
])

/**
 * The remedy half of a refusal: what to do about it, always a whole sentence.
 *
 * Never returns an empty string and never returns the code. An unknown or
 * absent code lands on GENERIC_REMEDY rather than on nothing, because the
 * caller composes this into a sentence and a blank half would produce copy that
 * trails off mid-thought.
 */
export function refusalRemedy(code) {
  const key = typeof code === 'string' ? code.trim() : ''
  if (key && Object.prototype.hasOwnProperty.call(REFUSAL_REMEDY, key)) return REFUSAL_REMEDY[key]
  if (key) {
    for (const [pattern, remedy] of FAMILY_REMEDY) {
      if (pattern.test(key)) return remedy
    }
  }
  return GENERIC_REMEDY
}

/* Pull a code out of a refusal without inventing one. A non-string, an empty
   string, or something that is not shaped like one of this product's
   identifiers is ABSENT, not a code -- otherwise a stray sentence in `.code`
   would be looked up as a key, miss, and be shown as prose. */
export function refusalCodeOf(result) {
  const value = result && typeof result === 'object' && typeof result.code === 'string' ? result.code.trim() : ''
  return IDENTIFIER_RE.test(value) ? value : null
}

/* Pull the DIAGNOSIS out of a refusal, and only if it reads as English.
 *
 * Two things are rejected here and both of them really occur. A `reason` that
 * is itself an identifier arrives through `reason: error?.message` when the
 * thrown error's message is a code -- showing it would put the bare identifier
 * back on the glass through the one door this module left open. A `reason` with
 * no lower-case letter at all is the same problem in a different shape.
 * Everything else is the engine's own English and is shown verbatim: it is the
 * product's honest report of what it looked for. */
function diagnosisOf(result) {
  const value = result && typeof result === 'object' && typeof result.reason === 'string' ? result.reason.trim() : ''
  if (value.length === 0) return null
  if (isBareIdentifier(value)) return null
  if (!/[a-z]/.test(value)) return null
  return value
}

/* Join a diagnosis to a remedy as prose rather than by concatenation, so a
   diagnosis that already ends in a full stop does not get a second one and one
   that ends in no punctuation at all still reads as a sentence. */
function joinSentences(...parts) {
  return parts
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part.length > 0)
    .map(part => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(' ')
}

/**
 * THE ONE FUNCTION EVERY REFUSING SURFACE CALLS.
 *
 * Composition, in order:
 *   diagnosis (the engine's English, verbatim, when there is any)
 *   + remedy   (always, chosen by code, then by family, then generic)
 *
 * `fallback` is what to say when the engine gave no readable diagnosis at all.
 * Callers pass the one sentence only they know -- "The dispatch was refused
 * with no receipt", "The preview receipt was incomplete" -- and it takes the
 * diagnosis slot. With neither a diagnosis nor a fallback the remedy stands
 * alone, which is still a whole sentence about what to do, and is the reason
 * this can never return nothing.
 *
 * `remedy` overrides the table for the rare caller that knows better than it
 * does: the loop panel's stop control, which can honestly add that the run is
 * still bounded by its own cap.
 *
 * IT IS NOT GIVEN THE CODE TO PRINT AND HAS NO PARAMETER THAT WOULD LET A
 * CALLER ASK FOR ONE. That is deliberate: the nine call sites this replaced all
 * printed the code because printing it was the easiest thing to reach for, and
 * an option to do so would be reached for again.
 */
export function refusalSentence(result, { fallback = '', remedy = '' } = {}) {
  const code = refusalCodeOf(result)
  const diagnosis = diagnosisOf(result) || (typeof fallback === 'string' ? fallback.trim() : '')
  const advice = (typeof remedy === 'string' && remedy.trim()) || refusalRemedy(code)
  /* A curated remedy that repeats the diagnosis word for word is shown once. */
  if (diagnosis && advice && diagnosis.includes(advice)) return joinSentences(diagnosis)
  return joinSentences(diagnosis, advice)
}

/**
 * Carry the identifier where a person will not read it but a support
 * conversation and a driver can.
 *
 * Returns the node so it can be used inline. An absent code REMOVES the
 * attribute rather than writing an empty one: `data-refusal-code=""` reads as
 * "there is a code and it is blank", which is the absence-as-value mistake this
 * codebase keeps making, and a probe asserting on presence would pass on it.
 */
export function markRefusalCode(node, result) {
  if (!node || typeof node !== 'object' || typeof node.setAttribute !== 'function') return node
  const code = refusalCodeOf(result)
  if (code) node.setAttribute('data-refusal-code', code)
  else if (typeof node.removeAttribute === 'function') node.removeAttribute('data-refusal-code')
  return node
}
