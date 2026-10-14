/* WHAT THIS COPY NEEDS, AND WHY SOME SCREENS ARE EMPTY — said once, here.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (LEGACY-ONB-001, confirmed on machine B and
 * re-measured here on a sterile profile before a line was changed). A person who
 * installs this product and walks the ring is told, in the product's own voice:
 *
 *     home           "This is the only computer connected"          (and nothing more)
 *     fleet graph    "Fleet projection unavailable · No local agent fleet host
 *                     detected on this machine."
 *     comms board    "Channels unavailable — projection" / "Live ops projection is
 *                     unavailable." / "unavailable — No local agent fleet host
 *                     detected on this machine."
 *     settings       nothing at all about any of it
 *
 * Every one of those sentences is TRUE and not one of them is an explanation.
 * Three of them name a mechanism the reader has never heard of, none says what an
 * agent host is, none says whether the person did something wrong, and there is
 * no control anywhere on those four screens that leads to an answer. That is a
 * dead end, and it is the first thing a stranger sees.
 *
 * WHY IT IS THE SHIPPING STATE AND NOT AN EDGE CASE. `dist/data/*.json` — the
 * files these screens read — are BUILD-TIME outputs of tools/gen-*.mjs, which
 * read the builder's own engine roots. They are packed into the read-only asar
 * and no process on a customer machine writes them. So all seven ship as
 * `{"ok": false, "reason": "No local agent fleet host detected on this
 * machine."}` and STAY that way, on every install, forever. The unavailable
 * branch of those screens is the only branch a customer will ever see.
 *
 * WHAT THIS MODULE MAY NOT DO, and the reason it is data rather than prose in
 * four render functions. It may not promise a remedy that does not exist. There
 * is no control in this product that connects an agent host, and writing "connect
 * a computer and this fills in" would be a lie told four times in four different
 * wordings. So the copy below separates the two honestly:
 *
 *   - the things a person CAN clear today, each with the exact command or the
 *     exact switch (`fix: 'self'`); and
 *   - the thing nobody can clear from this window yet, said plainly, so the
 *     reader stops looking for the switch instead of hunting for it in Settings
 *     (`fix: 'none'`).
 *
 * Copy that overstated the second would be worse than the dead end it
 * replaces: a dead end costs a person a minute, and a false remedy costs them an
 * afternoon.
 *
 * THE VOCABULARY IS NOT THE SCREENS'. tools/test/home-screen.test.mjs bans
 * "fleet host", "projection" and the rest of that register from the home screen,
 * and rightly. But a person who has ALREADY READ "No local agent fleet host
 * detected on this machine" on the fleet graph needs those words translated, not
 * withheld — so this copy quotes the sentence verbatim once, and answers it. The
 * copy that goes back onto home and into the empty panels does not.
 */

/* The one address of the connect screen. Read, never spelled: home, the
   computers page, the "This computer" section in Settings and the System row all
   point at it, and a link is
   only correct while every one of them agrees. src/device-claim-flow.js is a
   pure state machine, so this import costs this module none of its
   node-testability. */
import { CONNECT_HREF } from './device-claim-flow.js'

export const SETTINGS_HREF = '#/settings'

/* THE ADDRESS OF ONE ROW, NOT THE TOP OF A LONG PAGE.
 *
 * Three identical "Open Settings" buttons used to sit under three different
 * problems on the guide and all three landed at the top of Settings -- which is
 * roughly six screens above the row each one meant. The `?setting=` mechanism
 * already existed and the home screen already used it correctly. These are the
 * ids of the rows this module actually names. */
const settingRow = id => `${SETTINGS_HREF}?setting=${id}`
export const AGENT_SESSION_SETTING_HREF = settingRow('write_agent-session')
export const THREAD_REPLY_SETTING_HREF = settingRow('write_thread-reply')
export const EXAMPLE_MODE_SETTING_HREF = settingRow('example_mode')

/* THE ONE ADDRESS EVERY EMPTY SCREEN'S DOOR POINTS AT, and it is a row in
 * Settings rather than a screen of its own.
 *
 * It used to be `#/guide`. The owner's instruction was to fold that screen into
 * Settings and make it simpler and more useful, so the live part of it -- the
 * assistant programs, their presence sentence and their Install and Sign in
 * buttons -- is now the section called "This computer", and this constant names
 * its first row. Six screens read this name rather than spelling an address, so
 * all six moved with it and not one of them had to be found. `#/guide` itself
 * stays a routed address in src/main.js and resolves here, so a link somebody
 * has already followed, written down, or shipped inside an older refusal
 * sentence still lands on the answer instead of on nothing. */
export const GUIDE_HREF = settingRow('this_computer_programs')

/* The control that appears on an empty screen. One object, so the fleet graph,
   the comms board, home and settings cannot end up offering four differently
   worded doors to the same place. */
export const GUIDE_ACTION = Object.freeze({
  label: 'This computer, in Settings',
  href: GUIDE_HREF,
})

/**
 * What an empty live screen says, in place of a refusal on its own.
 *
 * `reason` is the projection's own sentence and is passed in rather than
 * assumed: it is the product's honest report of what it looked for and it stays
 * on the glass, verbatim and unsoftened. What changes is that it now arrives
 * INSIDE an explanation and above a door, instead of alone.
 *
 * The absence case is the one that matters here. A caller with no reason at all
 * — a fetch that threw, a malformed envelope, a `reason` field that is an empty
 * string — must still get the explanation, because "we could not read it and
 * cannot say why" is exactly when a person is most lost. So `reason` is
 * OPTIONAL and its absence removes only the quoted line, never the paragraph or
 * the door.
 */
export function hostAbsentNotice(reason) {
  const quoted = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null
  return Object.freeze({
    title: 'Nothing is reporting to this copy yet',
    reason: quoted,
    body: 'This screen draws a report written by an agent host. An agent host is a program that watches the agents running on a group of computers and writes down what they are doing. No agent host has reported to this copy, so there is nothing here to draw. Nothing on the computer you are driving is broken, and nothing is missing from its install.',
    action: GUIDE_ACTION,
  })
}

/* THE SAME NOTICE AS MARKUP, because four screens draw it and four hand-rolled
 * templates is four things to get wrong.
 *
 * IT RETURNS A STRING AND TOUCHES NO DOM API, deliberately: this module is
 * imported by a plain node test and by tools/first-run-recovery-qa.mjs, and one
 * `document.createElement` in here would make both of them impossible. The two
 * callers that need an Element wrap it in their own `el()`.
 *
 * The escaper is local rather than imported from a view for the same reason.
 *
 * `alongside` goes INSIDE the refusal paragraph rather than after it, and that
 * placement has a test behind it. On the fleet graph the refusal and "these are
 * the agents this copy declares, not agents observed running" are one claim:
 * separated, a person can read the first without the second and take a
 * configured agent for a running one. tools/agent-route-reachability.mjs asserts
 * both are in the same visible element, and the first version of this repair
 * split them and turned that suite red.
 *
 * `reasonClass` exists so a host page can keep a selector an existing probe
 * reads. Dropping such a class does not fail the probe -- it makes the probe
 * quietly record nothing, which is worse. */
const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })
const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character])

export function hostAbsentMarkup(reason, { compact = false, alongside = '', reasonClass = '' } = {}) {
  const notice = hostAbsentNotice(reason)
  const classes = ['host-absent-reason', 'projection-unavailable', reasonClass].filter(Boolean).join(' ')
  const rest = alongside ? ` ${alongside}` : ''
  return `<div class="host-absent${compact ? ' is-compact' : ''}" data-host-absent="true">`
    + `<p class="host-absent-title">${escapeMarkup(notice.title)}</p>`
    + (notice.reason ? `<p class="${classes}">${escapeMarkup(notice.reason)}${escapeMarkup(rest)}</p>` : '')
    + `<p class="host-absent-body">${escapeMarkup(notice.body)}</p>`
    + `<a class="host-absent-action" href="${escapeMarkup(notice.action.href)}">${escapeMarkup(notice.action.label)}</a>`
    + `</div>`
}

/**
 * What the comms board says when the record it reads is WORKING and EMPTY.
 *
 * This is a different truth from hostAbsentNotice and must not borrow its
 * words. That notice describes a report nothing has written -- "this screen
 * draws a report written by an agent host" -- and it is what the board shows
 * when the shell cannot read messages at all. But on a build whose payload
 * carries the live message reader, a fresh install answers the read with
 * ok and zero rows: the board is not refused, it is quiet. Describing that
 * as an absent host would be the product blaming a read that worked.
 *
 * MEASURED, 2026-08-19, on the re-cut confirming run: the previous cut's
 * payload had no agent-comms-local.js, the read was refused, and the board
 * fell back to the host-absent notice -- explanation and guide door included.
 * The re-cut's payload can read the journal, the board took its live branch,
 * and the quiet screen carried no explanation and no door: the one screen on
 * the first-run ring without a door at all. These words close that gap
 * for the state the product is actually in.
 *
 * NO REMEDY IS PROMISED. Messages appear here when agents on this computer
 * send them to each other; a person with no agent running yet has the door
 * below, and what it opens says what can be done today. That is the same honesty rule
 * the rest of this module holds itself to.
 */
const COMMS_QUIET_NOTICE = Object.freeze({
  local: Object.freeze({
    title: 'No messages between agents yet',
    body: 'This board shows the messages agents on this computer send each other, read from this computer’s own record. That record was read and it is empty: no agent here has sent another agent a message yet. Nothing on this computer is broken, and nothing is missing from the install.',
    action: GUIDE_ACTION,
  }),
  remote: Object.freeze({
    title: 'No messages between agents yet',
    body: 'This board shows the messages agents on the computer you are driving send each other, read from that computer’s own record. That record was read and it is empty: no agent there has sent another agent a message yet. Nothing on that computer is broken, and nothing is missing from the install.',
    action: GUIDE_ACTION,
  }),
})

export function commsQuietNotice({ viaRelay = false } = {}) {
  return viaRelay ? COMMS_QUIET_NOTICE.remote : COMMS_QUIET_NOTICE.local
}

/* The same notice as markup, for the one screen that draws it. String output
 * with no DOM API, for the same reason hostAbsentMarkup gives: this module is
 * imported by plain node tests and by tools/first-run-recovery-qa.mjs. The
 * host-absent classes are reused deliberately -- the board already styles
 * them, and a second visual dialect for "this screen is empty and here is the
 * door" would be a difference a reader would try to read meaning into. */
export function commsQuietMarkup({ compact = true, viaRelay = false } = {}) {
  const notice = commsQuietNotice({ viaRelay })
  return `<div class="host-absent${compact ? ' is-compact' : ''}" data-comms-quiet="true">`
    + `<p class="host-absent-title">${escapeMarkup(notice.title)}</p>`
    + `<p class="host-absent-body">${escapeMarkup(notice.body)}</p>`
    + `<a class="host-absent-action" href="${escapeMarkup(notice.action.href)}">${escapeMarkup(notice.action.label)}</a>`
    + `</div>`
}

/* The three things a person on a bare machine will notice, in the order they
 * will notice them. Read by src/views/guide.js and asserted by
 * tools/test/first-run-needs.test.mjs.
 *
 * `fix` is the honest half:
 *   'self' — the reader can clear this themselves, and `steps` says exactly how.
 *   'none' — nobody can clear it from this window, and saying so IS the help.
 */
export const FIRST_RUN_NEEDS = Object.freeze([
  /* THE ONE THAT WAS MISSING, AND IT IS FIRST BECAUSE IT IS WHAT THE PERSON
   * CAME HERE FOR.
   *
   * THE DEFECT, in the owner's own words: "as a user I dont even see how after
   * signing up that I now connect my computer". Measured on the rendered guide
   * before this entry existed: the word "account" appeared thirteen times and
   * every single one of them meant a Codex or Claude sign-in folder;
   * "toolsenabled.ai", "website", "signed up", "second computer" and "code"
   * appeared zero times. Somebody arriving from the home row about computers
   * read a page that never mentions the thing they paid for, and then read, two
   * sections down, that there is no setting that connects one.
   *
   * IT IS `fix: 'self'` AND THAT IS NOT A PROMOTION OF A HALF-BUILT FEATURE.
   * The connect screen is built, works end to end, and had no caller anywhere
   * in src/ -- a scout got a real code, a countdown and three named steps out
   * of it by typing the route by hand. The only thing missing was a door. */
  Object.freeze({
    id: 'account',
    fix: 'self',
    title: 'Joining this computer to your ToolsEnabled account',
    body: 'If you signed up at toolsenabled.ai, this is the step that puts this computer on that account. The screen below gives you a short code; you type it into your account page in a browser, and the two halves meet. It is what lets you reach this computer from a browser later. It is a separate thing from the assistant sign-ins further down this page: those are your Codex and Claude accounts, not your ToolsEnabled one.',
    steps: Object.freeze([
      Object.freeze({
        kind: 'link',
        text: 'Open "Connect this computer" in Settings',
        note: 'It shows you the code and counts down how long it is good for. Nothing is sent until you press the button there.',
        href: CONNECT_HREF,
        linkLabel: 'Open the connect screen',
      }),
      Object.freeze({
        kind: 'link',
        text: 'Sign in at toolsenabled.ai in a browser and open your account page',
        note: 'That is where the code is typed. It can be a browser on any device, because the code is short enough to read off this screen and type on a phone.',
        href: '',
        linkLabel: '',
      }),
    ]),
  }),
  Object.freeze({
    id: 'codex',
    fix: 'self',
    title: 'Running an agent on the computer you are driving',
    /* THE TWO COMMANDS THAT USED TO BE HERE ARE GONE, AND THAT IS THE REPAIR.
       This section printed `winget install OpenAI.Codex` and `codex login` for
       a person to copy, a few inches above a section that now installs and
       signs in at the press of a button. Two ways to do one thing is the thing
       the owner ruled out, and the copied one is the one that failed a real
       person: the window their install ran in could not see the new program
       and answered "'codex' is not recognized". So this section says which
       switch to turn on, and points at the buttons for the rest. */
    body: 'ToolsEnabled does not contain the program that runs an agent. Codex, Claude and Gemini are each a separate install. Codex or Claude, signed in on the computer you are driving, is what lets the agent page start a session. Nothing in this copy starts Gemini yet, and its own row below says so. Every run is written down on that computer before it begins.',
    steps: Object.freeze([
      Object.freeze({
        kind: 'link',
        text: 'Install one of the three assistant programs and sign in to it',
        note: 'in Settings, under "This computer". Each one has a button that installs it for you and a button that opens a window and signs you in.',
        href: '',
        linkLabel: '',
      }),
      Object.freeze({ kind: 'switch', text: 'Turn on "Run an agent session"', note: 'in Settings, under Things it may do for you. Every action that writes anything ships switched off.', href: AGENT_SESSION_SETTING_HREF, linkLabel: 'Open that setting' }),
    ]),
  }),
  Object.freeze({
    id: 'host',
    fix: 'none',
    title: 'Why the fleet graph, comms board, metrics and ledger are empty',
    /* THE ONE THAT MUST NOT BE OVERSOLD. Measured, not assumed: the files these
       screens read are packed into the read-only application archive at build
       time. No process on this machine writes them, so no action the reader
       takes will change them. */
    /* THE WORD "ONE" HAD NO ANTECEDENT A READER COULD SEE. Arriving here from
       the home row about computers, "there is no setting that connects one"
       read as "you cannot connect a computer" -- which is the opposite of true
       and is the exact sentence the owner's report is about. The paragraph now
       ends by naming the section that DOES do the other thing.

       THEN THE NOUN ITSELF TURNED OUT TO BE THE DEFECT. This said "an agent
       host, and this copy of ToolsEnabled does not include one" while
       shell/agent-host.cjs was in the build, owning Codex session lifecycles,
       and running sessions -- src/agent-session.js calls that same module "the
       shell's agent host". So one name covered two programs: the one that RUNS
       agents, which ships and works, and the one that REPORTS on a group of
       them, which does not exist here. The true fact about the second was
       printed in the words of the first, and a reader watching an agent run
       was told the product did not include one. The noun is now "fleet host",
       which is what data/fleet.json already calls it ("No local agent fleet
       host detected on this machine."), and the claim is about REPORTING
       rather than inclusion: nothing has reported, and nothing can. The flat
       statement that nothing the reader does will change it is unchanged and
       still true; tools/test/first-run-needs.test.mjs holds it in place. */
    body: 'Those screens read a report from a fleet host, a program that watches agents across several computers. None has reported to this copy. There is no setting that connects one and no command that installs one. Nothing you do will fill those screens today. Agents started on this computer run without it; a fleet host only reports on them. They say so rather than showing numbers that are not yours. This is the honest state of the product, not a fault on the computer you are driving. It says nothing about your ToolsEnabled account. Joining that computer to the account is a different step. It works today, and Settings, under "This computer", is where it is done.',
    quote: 'No local agent fleet host detected on this machine.',
    steps: Object.freeze([
      Object.freeze({ kind: 'switch', text: 'To see what one of those screens looks like with data in it, turn on "Show the example fleet"', note: 'in Settings, under What the screens show. Every screen then shows a worked example, labelled as an example.', href: EXAMPLE_MODE_SETTING_HREF, linkLabel: 'Open that setting' }),
    ]),
  }),
  Object.freeze({
    id: 'messaging',
    fix: 'self',
    title: 'Sending a message to a coordinator',
    /* Both halves, because the switch alone is not the whole answer and a guide
       that gave only the switch would send a person to turn it on and watch
       nothing happen. */
    body: 'The box on the first page has no place to type. Sending replies is switched off, and there is no coordinator on the computer you are driving to send one to. Turning the switch on is worth doing so the box is ready. It will stay quiet until an agent host reports from that computer.',
    steps: Object.freeze([
      /* THE SWITCH IS NOT CALLED THAT. src/write-flags.js labels the row "Reply
         to your coordinator", and a guide that names a control nothing on the
         page is called sends a person hunting through ninety rows. */
      Object.freeze({ kind: 'switch', text: 'Turn on "Reply to your coordinator"', note: 'in Settings, under Things it may do for you.', href: THREAD_REPLY_SETTING_HREF, linkLabel: 'Open that setting' }),
    ]),
  }),
])

/* The guide normally paints the frozen desk table above.  Its relay painter
 * needs an equally frozen twin rather than changing every occurrence of
 * "this": most such words on the page describe the reader's browser and are
 * already right.  In particular, the literal control label "Connect this
 * computer" remains byte-for-byte in the steps. */
export const FIRST_RUN_NEEDS_REMOTE = Object.freeze(FIRST_RUN_NEEDS.map(need => {
  if (need.id !== 'account') return need
  return Object.freeze({
    ...need,
    title: 'Joining the computer you are driving to your ToolsEnabled account',
    body: 'If you signed up at toolsenabled.ai, this is the step that puts the computer you are driving on that account. The screen below gives you a short code; you type it into your account page in a browser, and the two halves meet. It is what lets you reach that computer from a browser later. It is a separate thing from the assistant sign-ins further down this page: those are your Codex and Claude accounts, not your ToolsEnabled one.',
  })
}))

export function firstRunNeeds({ viaRelay = false } = {}) {
  return viaRelay ? FIRST_RUN_NEEDS_REMOTE : FIRST_RUN_NEEDS
}

/* THE THREE ASSISTANT PROGRAMS, WHAT EACH ONE COSTS A PERSON TO SET UP, AND
 * WHAT THIS COPY CAN ACTUALLY DO WITH IT.
 *
 * THE DEFECT. The owner's requirement is that a person can add their Claude,
 * Codex and Gemini sign-ins easily and then have agents run on them. Measured on
 * the packaged product: Codex was the only one of the three named anywhere in
 * the product, Gemini appeared nowhere at all, and the only sentence about
 * sign-ins was in Settings, saying this product never asks for them. That is
 * true and it reads as "there is nothing here for you to do". A person then
 * meets a tier menu where every Claude row says it cannot start, with no screen
 * anywhere that explains what Claude CAN do here or how to set it up.
 *
 * `reach` IS THE HONEST FIELD AND IT IS WHY THIS IS DATA. It says what this copy
 * does with the program TODAY, and the three values are different in kind:
 *
 *   'tree'     the research page starts one from a tree. Codex only.
 *   'handover' work handed over on the agent page runs on it, and a tree start
 *              refuses. Claude. MEASURED on the installed build: that hand-over
 *              spawns the official claude program on the person's own sign-in.
 *   'none'     nothing in this copy starts it. Gemini. Signing in changes
 *              nothing here, and saying so is the whole of the help.
 *
 * A MENU ENTRY THAT CANNOT START IS THE THING THIS MUST NOT BECOME. Gemini is
 * listed because a person comparing the three deserves a straight answer about
 * the third, and the straight answer is "not built". It is not offered as a
 * choice anywhere, and it must not be until something can start it.
 *
 * THERE ARE NO COMMANDS IN THIS LIST ANY MORE, AND THAT IS THE REPAIR.
 *
 * Every entry used to carry two or three lines for a person to copy into a
 * terminal: an install line, a sign-in line, and a line that reported whether
 * the sign-in took. They were correct, they were read off each program's own
 * help rather than remembered, and they were still the wrong shape -- because
 * the guide ALSO grew a button that does each of those things, and a page that
 * offers two ways to do one thing has, in practice, offered the harder one.
 * The harder one is what stuck the first external user of 1.0.20: they typed
 * the install line and then the sign-in line in the same window, and that
 * window answered "'codex' is not recognized", because a shell that is already
 * open never re-reads the PATH an installer wrote.
 *
 * So each entry now carries what it is FOR -- the program's name and a straight
 * sentence about what this copy does with it -- and the two buttons beside it
 * do the work. The buttons are the single path, and they are the same pair for
 * all three programs.
 */
export const PROVIDER_SETUP = Object.freeze([
  Object.freeze({
    id: 'codex',
    name: 'Codex',
    reach: 'tree',
    /* First because it is the default the tier menu preselects, not because it
       is the only one that works. The commands are imported rather than retyped
       for the reason the guide entry below already gives: three screens print
       them now.

       "THIS IS THE ONE THAT WORKS END TO END IN THIS COPY TODAY" CAME OUT, and
       the sentence it left behind is deliberately not exclusive. That clause was
       true while Codex was the only engine in the payload. DRIVEN 2026-08-17 on
       a staged packaged build, real mouse and keyboard, on a profile with a
       Claude sign-in and NO Codex sign-in at all: Sonnet picked from the menu,
       Start pressed, and the agent answered 391 to "What is 17 multiplied by
       23?" -- a number that appears nowhere in what was typed. So the clause was
       a claim about scarcity that the same build disproves. */
    doesHere: 'Starts an agent from a tree on the research page. It runs the work on the computer you are driving, using your own Codex sign-in there.',
    steps: Object.freeze([]),
  }),
  Object.freeze({
    id: 'claude',
    name: 'Claude',
    /* MOVED FROM 'not-from-tree' ON 2026-08-17, and this is the deliberate change
       the reach test asks for. The payload now carries
       capability/src/lib/agent-engine/claude-cli-process.js and
       claude-cli-adapter.js -- present in the installed 1.0.20 under
       resources/capability -- and resolveStartTier() in shell/agent-host.cjs
       opens the three Claude tiers on a real require() of that module. Asked of
       the shell itself rather than read off a list: startableTiers() answers
       luna, terra, sol, claude-fable, claude-sonnet, claude-opus. Only `local`
       is refused now. */
    reach: 'tree',
    /* THIS SENTENCE HAS NOW BEEN WRONG THREE TIMES, EACH FOR A DIFFERENT REASON.
       First "it cannot be started from a tree yet", which read as a fault in the
       program the person had just installed. Then "it runs the work you hand
       over on the agent page", naming a page that was driven on 2026-08-17 and
       found to have no door from where a refused person stands. Then "this copy
       does not carry the part that starts Claude from a tree" -- true when
       written, false by the time it installed, and still on screen beside a menu
       that offers three Claude models.
       It now says what the build actually contains, which is the one claim that
       can be checked without driving anything, and
       tools/test/refusal-engine-honesty.test.mjs fails if a fourth version ever
       claims the opposite of what the payload carries. */
    doesHere: 'Starts an agent from a tree on the research page, using your own Claude sign-in on the computer you are driving. ToolsEnabled does not ask for a key or read that sign-in.',
    steps: Object.freeze([]),
  }),
  Object.freeze({
    id: 'gemini',
    name: 'Gemini',
    reach: 'tree',
    /* Google stopped serving personal Google accounts through Gemini CLI on
       2026-06-18 (github.com/google-gemini/gemini-cli/discussions/28017); a
       Code Assist licence keeps working. The start refusal for a personal
       account names the same Antigravity connection in Accounts. */
    doesHere: 'Gemini can run inside Research trees using ToolsEnabled tools only. Gemini CLI no longer supports a personal Google account: for one, add Antigravity in Accounts and select that connection. With a Gemini Code Assist licence, sign in with its official program, then choose Gemini when starting an agent. The program chooses its current default model.',
    steps: Object.freeze([]),
  }),
  Object.freeze({
    id: 'grok', name: 'Grok', reach: 'tree',
    doesHere: 'Grok can run inside Research trees using ToolsEnabled tools only. Sign in with its official program, then choose Grok when starting an agent. Use a sign-in without extra startup extensions; Research keeps its tools separate.',
    steps: Object.freeze([]),
  }),
  /* THE FOURTH ROW, AND THE FIRST ONE THAT IS NOT A SIGN-IN AT ALL.
   *
   * "the free path is the product, not a consolation" (owner, 2026-08-12,
   * quoted on the engine's own local-node-runtime.js). LAUNCH_TIERS
   * (src/orchestration-controls.js) already carries `local` in the SAME table
   * as the three paid tiers, not a separate one -- this row is that same
   * decision applied here.
   *
   * `reach: 'tree'`, AND THE FOURTH VALUE IS RETIRED.
   * This row carried `reach: 'dispatch'`, rendered as "Starts from Launch
   * controls, not from a tree", on the grounds that resolveStartTier() in
   * shell/agent-host.cjs refused `local` from a tree unconditionally with no
   * engine module to load. That is no longer what the code does. It now reads
   *     if (row.provider === 'local' && localEngine) return row
   * gated on a real require() of the payload module exporting
   * startLocalSession -- the same shape as the claude, gemini and grok gates,
   * every one of which carries `reach: 'tree'`. So `local` resolves as a tree
   * tier whenever this build carries the engine.
   *
   * MEASURED, WHICH IS HOW THIS WAS FOUND: the owner started Local from New
   * tree and the screen was still telling them it does not start from a tree.
   * The `doesHere` paragraph below had already been updated to say "a tree
   * circle can use the Ollama chosen in your model settings"; the tag and this
   * comment were left behind, so one row said both things at once.
   *
   * THE TAG SAYS WHAT THE SURFACE DOES, NOT WHAT THIS MACHINE HAS. A build
   * without the engine still refuses, and the presence line under the row is
   * the slot that reports that -- the same division of labour every other
   * engine-gated provider here already uses.
   *
   * NO SIGN-IN, BY DESIGN, NOT BY OMISSION. local-node-runtime.js's own
   * header: "NO CREDENTIAL, ANYWHERE ON THIS PATH." So this id is
   * deliberately absent from SIGN_IN_PROVIDERS and ACCOUNT_PROVIDERS in
   * src/views/guide.js -- it renders through its own slot instead, backed by
   * detectLocal()/installRuntime()/pullLocalModel() on the same mcProviders
   * bridge. */
  Object.freeze({
    id: 'local',
    name: 'A model on this computer',
    reach: 'tree',
    doesHere: 'The Launch controls and Team panels on the computers page can send work to a model already running on your own hardware. There is no account and no per-token charge. With the local engine installed, a tree circle can use the Ollama chosen in your model settings. The model menu says when this copy cannot start it.',
    steps: Object.freeze([]),
  }),
])

/* WHAT THE MACHINE ACTUALLY SAYS ABOUT ONE PROGRAM, IN ONE SENTENCE.
 *
 * THE GAP THIS CLOSES. The list above tells a person what to type. It could not
 * tell them whether they had already typed it, so somebody who installed Codex
 * last week still met three commands and no acknowledgement. shell/provider-cli-presence.cjs
 * answers presence; this turns that answer into the sentence beside the name.
 *
 * 'unknown' GETS A SENTENCE OF ITS OWN AND IS NOT ROUNDED DOWN. Claude and
 * Gemini can both authenticate in ways a file check cannot see -- the operating
 * system keychain, a key in the environment -- so "no sign-in file here" is not
 * "you are signed out". Printing the confident version would tell somebody to
 * re-run a command that already worked, and they would conclude the product is
 * broken. So the uncertain case says what IS known, and points at the one
 * command that answers it properly.
 *
 * IT NEVER CONTRADICTS THE BUTTONS BELOW IT. A program reported installed and
 * signed in still shows both buttons, because a person may want to install it
 * again after a repair, or sign in to a second account. What changes is the
 * sentence at the top, which is the part a person reads first.
 */
const PRESENCE_SENTENCES = Object.freeze({
  absent: Object.freeze({
    local: 'Not on this computer yet.',
    remote: 'Not on the computer you are driving yet.',
  }),
})

export function presenceSentence(presence, { viaRelay = false } = {}) {
  /* An ARRAY reaches this branch too, and the first version let it through:
     `typeof [] === 'object'` is true, its `installed` is undefined, and the
     function answered "could not tell whether it is installed" about a value
     that was not a presence record at all. A malformed answer must produce
     NOTHING, so the page hides the line, rather than a sentence that reads like
     a real reading of the machine. The field is checked rather than the shape,
     because that is the thing actually being relied on. */
  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) return null
  const { installed, signedIn } = presence
  if (typeof installed !== 'string' || installed.length === 0) return null
  if (installed === 'no') return viaRelay ? PRESENCE_SENTENCES.absent.remote : PRESENCE_SENTENCES.absent.local
  /* "WE COULD NOT FIND IT" IS NOT "YOU HAVE NOT INSTALLED IT", and the second
     half of this sentence is the repair. It used to stop at the uncertainty,
     which reads to somebody who HAS installed the program as the product being
     broken about their own machine -- and the owner met exactly that on his
     second computer, with Codex and Claude both installed and signed in. So it
     says the true thing next to it: it may be here, and reopening the
     application is what lets it be seen. That is not a guess about their
     machine. Windows publishes an install by writing the registry and a running
     program keeps the environment it started with; a fresh launch reads the new
     one. Nothing here tells anybody to install anything. */
  if (installed !== 'yes') return 'We could not tell whether it is here. It may well be installed. Reopening ToolsEnabled lets it see anything added since.'
  if (signedIn === 'yes') return 'Installed here, and signed in.'
  if (signedIn === 'no') return 'Installed here, but nobody is signed in to it.'
  /* IT POINTS AT THE BUTTON, NOT AT A COMMAND. This used to end "run the last
     command below", which was true while three commands were printed under
     every program. They are gone, and a sentence that sends somebody to look
     for one is a dead end on the page written to end dead ends. */
  return 'Installed here. Press Sign in below to see where you stand.'
}

/* What DOES work on one computer with nothing connected. A page of things that
   are missing, and nothing else, reads as a broken product; these are real, they
   are reachable from this window, and each one was checked on a sterile profile
   rather than remembered. */
export const WORKS_HERE = Object.freeze([
  'Every agent run started from this window is written down on the computer you are driving, signed, and listed on the first page.',
  'The fleet graph draws the organisation this copy declares, and each agent on it opens a page of its own.',
  'The permission level you chose during setup is what a session is built from, and it can be changed in Settings.',
])
