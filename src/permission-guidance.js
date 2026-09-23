/* WHAT A SETTING GRANTS, WHAT IT RISKS, AND THE STEP WE WALK YOU THROUGH
 * RATHER THAN TAKE FOR YOU.
 *
 * The owner, R1529, in two messages that are one instruction:
 *
 *   "user settings should restrict and user computer settings should restrict
 *    but users should be prompted and guided through changing the settings and
 *    told what each step does and not pushed to take each step but offered that
 *    its not required and give the additional capabilities vs risks"
 *
 *   "if a user changes a agent setting in our system, and it requires uac
 *    elevtaion we walk them through the way to disable uac checks, we dont do it
 *    for trhem and we let them know the pros and cons and that they dont need to
 *    do it for the setting to be enable but it might not work fully"
 *
 * and then, as an eighth requirement: "additionally we also give them the
 * capabilities and risks granted from each setting of ours" -- not only the ones
 * with an outside step. Every setting.
 *
 * BOTH HALVES ARE BINDING AND NEITHER IS TRADED FOR THE OTHER. The restriction
 * stays real: nothing in this file loosens a default, and nothing here turns
 * anything on. What it does is make every withheld state answer three questions
 * -- what is off, what would turn it on, and what that gains and risks -- so
 * that a person meets an explanation instead of an absence.
 *
 * WHY THIS IS DATA AND NOT COPY WRITTEN AT EACH SURFACE. The product already had
 * one setting whose consequence was written where the choice is made, and it
 * worked; the problem was that it was the only one. A sentence written by hand
 * at each surface is a sentence that exists at whichever surfaces somebody
 * remembered, which is how the same switch came to say one thing on the setup
 * review and nothing at all in Settings. So the statements live here, once, and
 * every surface asks this module rather than authoring its own.
 *
 * THE RISK LINES ARE ALLOWED TO SAY THERE IS NO RISK. Several do. A menacing
 * sentence attached to a row that changes a colour is not caution -- it is how a
 * person learns to skip every risk line in the product, including the ones about
 * sending mail under their name. Where a family of settings genuinely shares one
 * risk (the appearance rows really are all the same), it is declared once as a
 * PROFILE and named by each row, rather than reworded ninety times into ninety
 * slightly different lies.
 *
 * ABSENCE IS NAMED, NEVER FILLED IN. An id with no declaration comes back
 * `declared: false` with a sentence saying so. It does not come back as a
 * setting with no risks, and it does not come back as an empty walkthrough that
 * renders as though a step existed. Absence-as-consent is this codebase's
 * recurring defect and it is not repeated here.
 *
 * NO DOM. Same reason src/setup-profile.js has none: this decides what a
 * stranger is told about their own computer, so it has to be exercisable in
 * `node --test` without a browser.
 */

/* ---------- things outside this product's control ---------- */

/* Each of these is a capability this product DEPENDS ON and DOES NOT PROVIDE.
 * The shape carries the owner's three properties as data rather than as prose,
 * because prose can be rewritten into something else and a literal cannot:
 *
 *   required: false             the in-product setting turns on without this.
 *   neverPerformedForYou: true  we print the step; we do not run it.
 *   withoutIt                   what honestly happens if you decline -- which is
 *                               a partial function stated out loud, never a
 *                               silent failure and never a refusal to save.
 *   gains / costs               what doing the step buys, and what it costs.
 *
 * `gains` AND `costs` WERE MISSING, AND THE SCREEN WAS ALREADY ASKING FOR THEM.
 * src/guided-step.js rendered `capability.capabilitiesGained`, a field no entry
 * in this file has ever had, so `group()` was handed an empty array and returned
 * an empty string on every one of them. A heading a person never saw, above a
 * list that was never there, for the whole life of the feature -- and nothing
 * went red, because an absence rendered as nothing looks exactly like a decision
 * not to render anything. That is this codebase's signature defect appearing in
 * the module written to prevent it.
 *
 * So the field exists now, under the name the renderer will use, with a real
 * statement in every entry -- and validateGuidance() below requires both halves,
 * so an entry added later cannot arrive with the gain and no cost. THE COST IS
 * REQUIRED SEPARATELY FROM `withoutIt` because they answer different questions:
 * `withoutIt` is what happens if you SKIP the step, and `costs` is what it takes
 * from you if you DO it. A person weighing an outside step needs both, and until
 * now the product only ever said one of them.
 *
 * `elevation: true` marks the ones that need an administrator, which is the case
 * the owner named. This product does not ask Windows for administrator rights,
 * does not weaken any Windows security setting, and does not do either on your
 * behalf. It prints what you would run and leaves the choice with you.
 *
 * ONLY CAPABILITIES THIS PRODUCT ACTUALLY DEPENDS ON APPEAR HERE. There is no
 * entry for a firewall rule or a scheduled task, because nothing this
 * application does needs one: the audited connection it uses is on this computer
 * only. Those two cases are real, and they belong to settings that live in the
 * engine's own catalogue, where they are declared in the same shape. Inventing
 * an app-side one to make this list look complete would be claiming a capability
 * that does not exist. */
/* HOW OFTEN THIS ASKS SOMETHING OF YOU (owner, R1536).
 *
 *   "It should be labeled as typically requires a user step, rarely, sometimes
 *    etc so they know."
 *
 * Four words and no fifth, so the label can be a badge rather than another
 * sentence to read, and so the vocabulary cannot drift into "occasionally",
 * "may", or "in some cases" -- the words a product reaches for when it would
 * rather not commit to anything.
 *
 * THE LABEL IS A CLAIM ABOUT COMPUTERS IN GENERAL, AND EVERY ONE HAS TO SHOW
 * ITS WORKING. `frequencyBecause` is required beside it so a later reader can
 * ARGUE with the claim instead of inheriting it. That is not ceremony. The
 * finding this lane corrects -- "no setting here needs administrator rights" --
 * was true only of one machine, whose Windows approval prompt is switched off,
 * and it went unchallenged for exactly as long as nobody had written down what
 * it rested on. A label reasoned from "it never asked me" is the same mistake
 * wearing a badge, and being made to write the sentence is what exposes it. */
export const FREQUENCIES = Object.freeze(['typically', 'sometimes', 'rarely', 'never'])

export const FREQUENCY_WORDING = Object.freeze({
  typically: 'Typically needs a step from you',
  sometimes: 'Sometimes needs a step from you',
  rarely: 'Rarely needs a step from you',
  never: 'Needs nothing from you',
})

export const EXTERNAL_CAPABILITIES = Object.freeze({
  /* THE TWO COMMANDS THAT USED TO BE IN THIS ROW ARE GONE.
   *
   * It printed "Open Windows Terminal and run: winget install OpenAI.Codex"
   * and "Then sign in to it: codex login", which was a second, harder way to
   * do something Settings, under "This computer", now does at the press of a
   * button -- and the harder way is the one that failed a real person: the
   * window their install ran in could not see the new program and answered
   * "'codex' is not recognized". This settings row has no buttons on it, so it
   * names the section that does rather than reprinting the commands. */
  'codex-installed': Object.freeze({
    id: 'codex-installed',
    name: 'Codex installed and signed in on the computer you are driving',
    whatItDoes: 'Codex is a separate free program from OpenAI. It is the thing that actually runs an assistant; this product drives it.',
    elevation: false,
    frequency: 'typically',
    frequencyBecause: 'Codex is a separate program that Windows does not ship, so a computer that has never had it installed does not have it. Almost everybody meets this step once. It installs under your own account and needs no administrator, which is a different question from how often it comes up.',
    required: false,
    neverPerformedForYou: true,
    gains: Object.freeze([
      'An assistant can actually run on the computer you are driving, which is the thing every other switch here is about.',
      'It runs on the computer you are driving, so what it reads and writes stays on that computer.',
    ]),
    costs: Object.freeze([
      'You install a program from OpenAI and sign in to it. That account and that password are theirs, not this program’s.',
      'It takes disk space and a few minutes, and it is yours to update afterwards.',
      'Running an assistant on the computer you are driving uses its processor while it works.',
    ]),
    steps: Object.freeze([
      Object.freeze({
        do: 'Open Settings, under "This computer", and find Codex there',
        why: 'That section lists the three assistant programs, says what this copy does with each one, and tells you whether Codex is already here.',
      }),
      Object.freeze({
        do: 'Press Install, and when it finishes press Sign in',
        why: 'Install fetches Codex from OpenAI, straight to your own computer. Sign in opens a terminal window and runs the sign-in in it. You finish it there, and no password or key comes anywhere near this product.',
      }),
    ]),
    verify: 'The home screen stops saying "Not ready yet" and says agents can run on the computer you are driving.',
    withoutIt: 'The switch stays on and the Start control appears. Pressing it will report that Codex is not installed or not signed in, and point you at the row in Settings that fixes it. Nothing fails quietly and nothing is switched back off behind you.',
  }),
  'codex-cloud-account': Object.freeze({
    id: 'codex-cloud-account',
    name: 'A Codex Cloud account the computer you are driving can reach',
    whatItDoes: 'Codex Cloud runs a task on OpenAI’s computers instead of on the computer you are driving. It needs an account there and a working internet connection.',
    elevation: false,
    frequency: 'typically',
    frequencyBecause: 'Signing in to a service is something the service asks of everybody once. A Codex Cloud account is not created by installing anything on the computer you are driving. Nobody reaches this feature already signed in, unless they signed in for another reason first.',
    required: false,
    neverPerformedForYou: true,
    gains: Object.freeze([
      'Work can run while the computer you are driving is busy, asleep, or switched off.',
      'You can watch a cloud task from the agent page beside everything running here.',
    ]),
    costs: Object.freeze([
      'It is real, billable work on OpenAI’s computers. You pay them for it, not us.',
      'Whatever the task is given to work on leaves the computer you are driving.',
      'Once a cloud task has been accepted it cannot be cancelled.',
    ]),
    steps: Object.freeze([
      Object.freeze({
        do: 'Open Settings, under "This computer", find Codex, and press Sign in there with an account that has Codex Cloud',
        why: 'The sign-in happens in a terminal window, inside Codex itself. This product never asks for that password and never holds it.',
      }),
    ]),
    verify: 'The Codex Cloud panel on the agent page stops saying it cannot reach the service, and a launch returns a task you can watch.',
    withoutIt: 'The switch stays on and the launch form appears. A launch will report that the service could not be reached, and nothing is started or charged. It is not silently retried somewhere else.',
  }),
  'audited-connection': Object.freeze({
    id: 'audited-connection',
    name: 'The audited connection on the computer you are driving',
    whatItDoes: 'The audited connection is the part of this product that carries out an action and writes the permanent record of it. It runs on this computer and is not reachable from anywhere else.',
    elevation: false,
    frequency: 'rarely',
    frequencyBecause: 'This is part of this program rather than something separate to install, and it starts with it. It only needs something from you when it has not finished starting, or has stopped. That is the exception, not the ordinary case.',
    required: false,
    neverPerformedForYou: true,
    gains: Object.freeze([
      'Every action this program takes for you is carried out and written down in the same moment.',
      'The record is kept and signed on the computer you are driving, so you can check afterwards exactly what was done.',
    ]),
    costs: Object.freeze([
      'Nothing to set up and nothing to pay. It starts and stops with ToolsEnabled on the computer you are driving.',
      'It has to be answering before an audited control will do anything. A panel can be waiting on it for a few seconds after the app opens.',
    ]),
    steps: Object.freeze([
      Object.freeze({
        do: 'Leave ToolsEnabled open on the computer you are driving. The connection starts with it.',
        why: 'It is part of this program, not a separate service you have to install or keep running.',
      }),
      Object.freeze({
        do: 'If a panel says it is unavailable, press Retry on that panel.',
        why: 'It is usually still starting. Nothing outside this computer is involved, so there is nothing to sign in to.',
      }),
    ]),
    /* It named the OLD status line, word for word: "audited bridge ready". Two
       mechanism names, and now not even the words on the screen -- the panel
       says "Ready" (src/write-surfaces.js). A verification step that quotes a
       string is a step that goes wrong the day the string improves, so this one
       describes what the person will SEE instead. */
    verify: 'The panel says it is ready, and its buttons stop being greyed out.',
    withoutIt: 'The switch stays on and the controls appear, disabled, with the reason on the panel. Nothing is sent and nothing is recorded until the connection answers.',
  }),
})

/* Has the outside thing actually been found? Three answers, and the third one
 * is the one that matters: a probe that could not run reports UNKNOWN, and a
 * surface built on this says it could not check rather than picking the
 * convenient side. Reporting "missing" would be alarming and unfounded;
 * reporting "available" would be worse. */
export const CAPABILITY_STATES = Object.freeze(['available', 'missing', 'unknown'])

export function capabilityState(probeResult) {
  if (probeResult === true) return 'available'
  if (probeResult === false) return 'missing'
  return 'unknown'
}

export function externalCapability(id) {
  return EXTERNAL_CAPABILITIES[id] || null
}

/* ---------- what will happen on THIS computer (owner, R1536 tier 1) ---------- */

/* The owner, R1536: "if we can grab their settings then just tell them and let
 * them choose to change their settings right there or if we cant grab them then
 * direct them how to".
 *
 * So there are three tiers and they are in preference order:
 *
 *   TIER 1  we read their actual computer and say what IT will do. No generic
 *           likelihood at all -- telling somebody what will happen on their
 *           machine beats telling them what usually happens on machines.
 *   TIER 2  we could not read it, so we say so and walk them through it rather
 *           than guessing on their behalf.
 *   TIER 3  the general label, which every capability carries either way.
 *
 * THE READING IS PASSED IN, NOT TAKEN. This module has no registry and no
 * child processes by design (see the header: it has to run in `node --test`
 * without a browser, and it decides what a stranger is told about their own
 * computer). The engine reads the posture -- src/lib/uac-posture.js, which
 * never writes -- and hands the answer here. A surface with no reading passes
 * nothing and lands in tier 2, which is a real answer and not a failure.
 *
 * AND THE HARD LINE FROM R1529 IS NOT BLURRED BY "RIGHT THERE". Where the thing
 * to change is one of OUR settings, the control is on the screen and we change
 * it when they choose. Where it is a Windows setting, the choice and the
 * walkthrough are presented in the same place at the same moment -- and the
 * product still does not perform it. Same screen, their hands. */
const POSTURE_LABELS = Object.freeze({
  silent: 'On the computer you are driving: runs without asking you',
  consent: 'On the computer you are driving: asks you to approve it',
  credentials: 'On the computer you are driving: asks for a password',
  refused: 'On the computer you are driving: cannot run without the step below',
  allowed: 'On the computer you are driving: nothing is needed from you',
})

/**
 * The label to show for one capability, with a real reading allowed to overrule.
 *
 * @param capability  an EXTERNAL_CAPABILITIES entry.
 * @param posture     optional { outcome, sentence } from the engine's reader.
 *                    An outcome outside the set above, or none, is tier 2.
 */
export function frequencyFor(capability, posture = null) {
  const declared = capability && FREQUENCIES.includes(capability.frequency) ? capability.frequency : null
  const general = declared ? FREQUENCY_WORDING[declared] : ''
  const outcome = posture && typeof posture.outcome === 'string' ? posture.outcome : ''
  const specific = Object.prototype.hasOwnProperty.call(POSTURE_LABELS, outcome) ? POSTURE_LABELS[outcome] : ''
  if (!specific) {
    return Object.freeze({
      tier: 2,
      source: 'general',
      label: general,
      /* SAID OUT LOUD RATHER THAN LEFT AS A GAP. A person who is being told
         what usually happens, rather than what will happen to them, is owed the
         difference -- otherwise a general statement reads as a specific one. */
      detail: posture && typeof posture.sentence === 'string' && posture.sentence !== ''
        ? posture.sentence
        : 'This copy could not check the settings of the computer you are driving. This is what is usually true rather than what is true there.',
      declared,
    })
  }
  return Object.freeze({
    tier: 1,
    source: 'measured',
    label: specific,
    detail: typeof posture.sentence === 'string' ? posture.sentence : '',
    /* The general claim is kept beside the specific one rather than replaced by
       it, so a reader can still see what was asserted about computers in
       general and disagree with it. */
    declared,
  })
}

/* ---------- what a family of settings grants and risks ---------- */

/* A profile is one honest statement shared by rows that genuinely share it.
 * Naming the same truth once is not boilerplate; rewording it ninety times so
 * each row looks bespoke is. Any row that differs declares its own. */
export const RISK_PROFILES = Object.freeze({
  appearance: Object.freeze({
    capabilities: Object.freeze(['Changes how this app looks on your screen, so you can make it easier on your eyes.']),
    risks: Object.freeze(['None worth the word. This changes what you see, not what this program is allowed to do, what it can reach, or what leaves the computer you are driving.']),
  }),
  reading: Object.freeze({
    capabilities: Object.freeze(['Changes how text is sized and spaced, so long screens are easier to read.']),
    risks: Object.freeze(['None worth the word. Nothing about what this program may do changes with it.']),
  }),
  motion: Object.freeze({
    capabilities: Object.freeze(['Changes how much this app animates, which some people find calmer and which uses a little less battery.']),
    risks: Object.freeze(['None worth the word. Turning animation down hides no information; every number it moves is still shown.']),
  }),
})

/* THE `demonstration` PROFILE WAS REMOVED WITH THE ROWS THAT NAMED IT. It
 * described the Data & Sim section as a family -- the seven per-view live-data
 * switches and the demonstration-speed slider that drove the retired
 * simulation engine. That section now holds ONE row, the example toggle, and
 * a row that decides what every screen shows is not cosmetic: it carries its
 * own declaration in SUBJECTS below (`example_mode`) rather than a family
 * statement. A section whose every row declares itself needs no profile, and
 * leaving one would assert a shared claim nothing consults -- the same reason
 * `Ledger` has no mapping below. */

/* THREE PROFILES WERE REMOVED ON 2026-08-20 -- `layout`, `performance` and
 * `developer` -- because every section that named them is gone.
 *
 * They were the sharp edge of the defect, not collateral of it. This file
 * asserted "Changes how a screen arranges what it is already showing you" over
 * Fleet Graph, Metrics, Chat & Threads, Comms Board and Ledger; "Trades how
 * smooth this app feels against how much battery and processor it uses" over
 * Performance; and "Shows extra internal detail" over Developer. Not one row
 * under any of those headings was read by anything. So the product was not
 * merely shipping controls that did nothing -- it was, in its own most careful
 * voice, in the place a person goes to find out what a switch will do,
 * CLAIMING AN EFFECT FOR THEM. A dead control is a disappointment; a dead
 * control with a reasoned explanation of its effect is a false statement.
 *
 * The wording is kept in docs/design/UNBUILT-SETTINGS-ROWS-2026-08-20.md with
 * the rows it described. If one of those features is built, the profile comes
 * back with it -- after the behaviour exists, not before. */

/* Which family each settings section belongs to. A section that is not here has
 * no profile, which is an ABSENCE and is reported as one -- it is not quietly
 * treated as harmless. */
export const SECTION_RISK_PROFILE = Object.freeze({
  Appearance: 'appearance',
  'Text & Reading': 'reading',
  'Motion & Effects': 'motion',
  /* `Data & Sim` is deliberately absent rather than mapped, as of the one-
     toggle change: its one row, `example_mode`, decides what every screen in
     the product shows, and carries its own declaration in SUBJECTS below.
     A family statement over a one-row section would never be consulted. */
  /* `Ledger` is deliberately absent rather than mapped. Its one surviving row,
     `ledger_archive`, carries its own declaration in SUBJECTS below -- which is
     the honest one, because archiving records is not "rearranging what a screen
     is already showing you". A section mapping here would never be consulted
     for it, and leaving one would assert a family statement over a section that
     has no row needing it. */
})

/* ---------- the rows that are not just presentation ---------- */

/* Everything below is a row where the profile above would be a lie, because the
 * row decides something real. Each states its own capabilities and its own
 * risks, and names the outside capability its full function depends on where
 * there is one. */
export const SUBJECTS = Object.freeze({
  /* --- custom settings rows whose state is owned outside the catalogue --- */
  'connect_computer': Object.freeze({
    whatItDoes: 'Joins the computer you are driving to your ToolsEnabled account, or clears the account connection it holds so it can be joined again.',
    capabilities: Object.freeze([
      'Your account page can identify this computer and show it among the computers linked to you.',
      'When browser control is allowed here, a signed-in browser can use this computer through your account.',
    ]),
    risks: Object.freeze([
      'Joining leaves an account credential on this computer until you disconnect it here.',
      'Allowing browser control lets someone using your signed-in account operate this computer through ToolsEnabled.',
    ]),
    turnOnAt: 'Settings → Connect this computer',
  }),
  'update_policy': Object.freeze({
    whatItDoes: 'Decides whether ToolsEnabled asks before checking for a newer version, checks on its own, or does not check.',
    capabilities: Object.freeze([
      'You can choose whether each launch asks before looking for a newer version, looks automatically, or leaves the check to you.',
    ]),
    risks: Object.freeze([
      'A check contacts toolsenabled.ai. Turning checks off can leave this installation on an older version until you check another way.',
    ]),
    turnOnAt: 'Settings → System → Checking for updates',
  }),

  /* --- the write actions. src/write-flags.js owns the ids; these explain them. --- */
  'write_dispatch': Object.freeze({
    whatItDoes: 'Shows the form that hands a job to an assistant and starts it working in your folder.',
    capabilities: Object.freeze([
      'You can hand a written job to an assistant and have it work on it in the folder you chose.',
      'Every hand-off is written into the permanent record on the computer you are driving, so you can see afterwards exactly what was asked for.',
    ]),
    risks: Object.freeze([
      'An assistant given a job will read and change files inside your chosen folder without asking again for each one.',
      'A job written loosely can be read more broadly than you meant, and the work is done before you see it.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Hand out work to agents',
    externalCapability: 'audited-connection',
  }),
  'write_decision': Object.freeze({
    whatItDoes: 'Shows Approve and Decline buttons on the requests in your ledger.',
    capabilities: Object.freeze([
      'You can approve or decline a request from this screen instead of somewhere else.',
      'Each decision is written down and kept, with your reason attached to it.',
    ]),
    risks: Object.freeze([
      'An approval recorded here is what other parts of the system act on, so an approval given by mistake is acted on.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Approve or decline',
    externalCapability: 'audited-connection',
  }),
  'write_queue': Object.freeze({
    whatItDoes: 'Shows the controls that take a waiting piece of work or mark one finished.',
    capabilities: Object.freeze([
      'You can claim a queued item so nobody else picks it up, and close it when it is done.',
    ]),
    risks: Object.freeze([
      'Closing an item tells everything else that the work is finished. If it was not, the rest of the system now believes it was.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Take or finish queued work',
    externalCapability: 'audited-connection',
  }),
  'write_thread-reply': Object.freeze({
    whatItDoes: 'Lets you type replies into the conversation with your coordinator.',
    capabilities: Object.freeze([
      'You can answer a question from this screen instead of waiting until you are somewhere else.',
    ]),
    risks: Object.freeze([
      'A reply is sent and recorded as soon as you send it, and assistants act on what it says. There is no draft step.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Reply to your coordinator',
    externalCapability: 'audited-connection',
  }),
  'write_report-read': Object.freeze({
    whatItDoes: 'Shows an assistant’s written reports on its page.',
    capabilities: Object.freeze([
      'You can read what an assistant wrote about its own work, from inside this app.',
    ]),
    risks: Object.freeze([
      'Very little. This reads a file in your chosen folder and changes nothing. It is here as a switch because reading a file is still reaching your disk, and this product does not do that without being asked.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Read agent reports',
    externalCapability: 'audited-connection',
  }),
  'write_agent-session': Object.freeze({
    whatItDoes: 'Lets the Start controls launch an assistant, which can then be watched and stopped from here.',
    capabilities: Object.freeze([
      'Starting an assistant is available. While this is off, each place that starts one stays unavailable and says why.',
      'You can watch a running session as it works and stop it at any point.',
    ]),
    risks: Object.freeze([
      'A running assistant reads and changes files inside the folder you chose, and does so while you are watching rather than asking about each one.',
      'Turning this on starts nothing by itself. It enables the Start controls; you still decide what to run.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Run an agent session',
    /* Provider-neutral on purpose. Codex, Claude and the other offered engines
       have different setup states, and Settings, under "This computer", owns
       that live list. Naming the Codex walkthrough here sent a Claude-ready
       computer through an unrelated install. */
  }),
  'write_cloud-launch': Object.freeze({
    whatItDoes: 'Lets you start a task on Codex Cloud, which runs on OpenAI’s computers rather than the computer you are driving. You watch it from the agent page.',
    capabilities: Object.freeze([
      'Work can run somewhere else while the computer you are driving is busy, asleep or switched off.',
      'You can watch a cloud task from the agent page alongside everything running here.',
    ]),
    risks: Object.freeze([
      'A cloud task is real, billable work on someone else’s computers, and once it has been accepted it cannot be cancelled.',
      'Whatever the task is given to work on leaves the computer you are driving.',
      'Each launch still asks you for approval first, so nothing starts without a second press.',
    ]),
    turnOnAt: 'Settings → Things it may do for you → Launch Codex Cloud tasks',
    externalCapability: 'codex-cloud-account',
  }),

  /* --- the row that decides what every screen is showing you --- */
  /* This replaced `live_view`, the one declaration the seven per-view rows
     shared. The example is not a second render any more: it is data fed
     through the same screens as your own records, so what the switch decides
     is only WHOSE data those screens draw -- and every screen drawing the
     example labels it, because the badge follows the source. */
  'example_mode': Object.freeze({
    whatItDoes: 'Decides whether every screen shows your own activity or the product’s built-in example.',
    capabilities: Object.freeze([
      'On, every screen shows the labelled example — the same worked fleet a signed-out visitor to the website sees. Useful on a new install where your own records are still empty.',
      'Off, the screens show what has actually happened on your own computer.',
    ]),
    risks: Object.freeze([
      'None to your computer. The example is invented data fed through the same screens as your own, and every screen showing it says so.',
    ]),
    turnOnAt: 'Settings → What the screens show',
  }),

  /* --- the rows that decide something durable --- */
  'uninstall_data': Object.freeze({
    whatItDoes: 'Decides what happens to your saved sign-ins, your permanent record of what was done, and your settings when you uninstall this program.',
    capabilities: Object.freeze([
      'On "keep my data", reinstalling later picks up exactly where you left off.',
      'On "remove everything", uninstalling actually removes it, rather than leaving it on the disk after the program is gone.',
    ]),
    risks: Object.freeze([
      'On "keep my data", your saved sign-ins and the permanent record stay on this computer after the program is gone. Anyone else using this computer could find them.',
      'On "remove everything", it is gone. There is no undo and no copy kept anywhere else.',
    ]),
    turnOnAt: 'Settings → Data & Privacy',
  }),
  /* src/vault-credentials-settings.js is the control this row mounts. It
     never draws a value, a masked prefix or a length -- only names -- so the
     grant/risk statement below stays at the same level: what the row lets a
     person DO to the vault, never what any record in it holds. `disclosure:
     false` on the catalogue row only suppresses the settings-page disclosure
     BOX, because the panel already explains itself inline; it is not an
     exemption from having a statement, which is the gap this entry closes. */
  'vault_credentials': Object.freeze({
    whatItDoes: 'Lists the names of the records in this computer’s encrypted vault. Lets you ask for a new one to be added, or remove one you already have. What a record holds is never shown here, and this row never asks for or displays a value.',
    capabilities: Object.freeze([
      'You can see which named credentials this computer already holds, without a value, a masked prefix, or a length ever being drawn on screen.',
      'Asking for a new one opens this computer’s own entry form. What you type there goes straight into the encrypted vault; it never passes through this settings screen.',
      'Removing one takes it out of the vault for good, once you approve it.',
    ]),
    risks: Object.freeze([
      'Removal is real deletion. Once your approval finishes it, the record is gone from this computer’s vault, with no undo and no copy kept anywhere else.',
      'Anyone who can drive this computer and approve its prompts can remove a credential a provider, tool, or agent depends on. That stops whatever used it from working until it is added back.',
    ]),
    turnOnAt: 'Settings → Data & Privacy → Credentials stored on this computer',
  }),
  /* Said in the engine's own terms (capability/tools/ledger-archive.js): an
     archive retires a request to COOLING and it stays on every list until
     three sessions have seen it. The earlier draft said "out of the main list",
     which the next page load would have contradicted. */
  'ledger_archive': Object.freeze({
    whatItDoes: 'The first press shows which finished or superseded requests qualify. The second archives them one at a time, each through its own preview, and says which it left where it was and why.',
    capabilities: Object.freeze([
      'Finished work is recorded as finished and cooling, with a reason for each request, and can be put back.',
    ]),
    risks: Object.freeze([
      /* The first clause is pinned word for word in tools/test/permission-guidance.test.mjs
         (the absolute-claim registry); the rest carries no absolute so it
         needs no pin. */
      'Very little. The first press only shows you what would move; nothing moves until you press again. An archived request is not deleted: it is marked finished and cooling, stays on this page’s list, and can be put back.',
    ]),
    turnOnAt: 'Settings → Ledger',
  }),
  /* THE TWO NOTIFICATION ROWS. Declared rather than left to the section family
     for the reason the write flags are: a family statement would say something
     about "rearranging what a screen shows you", and these two are the only
     switches in this product that let it reach OUTSIDE its own window. What a
     person is owed here is what leaves the window and what does not, which is
     why the risks lead with what a notification puts on a shared screen. */
  'notify_agent_finished': Object.freeze({
    whatItDoes: 'Your computer shows a short notification when an agent you started finishes its turn.',
    capabilities: Object.freeze([
      'You can leave an agent running, go and do something else, and be told when it is done.',
      /* THIS USED TO PROMISE MORE THAN THE MECHANISM DELIVERS, and it was
         registered as an absolute claim on that strength: "Nothing appears
         while this window has focus and you are already watching that agent."
         The suppression needs the page's own report of what it is showing to
         have ARRIVED, and every way that report can be missing -- a bridge that
         refused, a window that has not reported yet -- ends in a notification
         rather than in silence. That is the right direction to fail in and it
         is the opposite of what the old sentence said.
         So the promise is now two sentences: what usually happens, and what
         happens when the program cannot tell. The second one is the absolute,
         it is the one that is genuinely true of every path, and it is what is
         registered in tools/test/permission-guidance.test.mjs. Two entries
         rather than one string of two sentences, because that registry pins a
         whole statement: an absolute buried beside a softer sentence could
         never be matched on its own. */
      'A notification is skipped while this window has focus and that agent is the one on screen.',
      'When this page has not said what it is showing, nothing is held back and you are told.',
    ]),
    risks: Object.freeze([
      'The notification appears on whatever screen you are sharing or projecting, in front of whoever is looking at it. It says only that an agent finished.',
      'Your computer decides how it is shown and how long it is kept, including whether it stays in a list you can scroll back through.',
    ]),
    turnOnAt: 'Settings → Notifications → Tell me when an agent finishes',
  }),
  'notify_agent_error': Object.freeze({
    whatItDoes: 'Your computer shows a short notification when an agent stops before it finishes.',
    capabilities: Object.freeze([
      'You find out that work has stopped without going and looking at the page it stopped on.',
      /* WHICH STOPS, SAID OUT LOUD. This row governed only the first of these
         when it landed, and a reader had no way to tell. See the catalogue
         comment in src/views/settings.js for the two endings. */
      'It covers a turn that ended badly and an agent whose program went away on its own. '
        + 'One stop is one notification, however the program found out about it.',
      'While that agent is on screen and this window has focus, the page tells you instead.',
    ]),
    risks: Object.freeze([
      'It appears on whatever screen you are sharing, and it says an agent stopped — which you may not want read over your shoulder.',
      /* NOT "the reason the engine gave", which was the earlier wording: the
         second ending this row covers is a program that went away, and a
         program that went away often said nothing on its way out. The page
         keeps whatever there was, which may be nothing, and that is what this
         promises. */
      'It says that an agent stopped and not why. Whatever that agent did say stays on its own page, which is where you have to go to read it.',
    ]),
    turnOnAt: 'Settings → Notifications → Tell me when an agent stops with a problem',
  }),
  /* Said in the engine's own terms (src/lib/cloud-agent/cloud-mirror.js), which
     matters here more than usual: this row is the only place a person learns
     that cloud work runs against a COPY. The risks are stated as what the
     registration actually reaches -- the provider and the mirror repository --
     rather than as reassurance, because a person handing a whole folder to a
     remote repository is entitled to know which one and on whose word. */
  'cloud_mirror_setup': Object.freeze({
    whatItDoes: 'Sets up the folder a cloud helper works from on the computer you are driving. It also sets up the dedicated private place on GitHub where its copy is kept. You enter that place, then choose the Cloud environment bound to it.',
    capabilities: Object.freeze([
      'Cloud helpers work from a private copy of a folder, so your own work on the computer you are driving is left as it is.',
      'A cloud job that would work from an out-of-date copy is refused before it starts.',
    ]),
    risks: Object.freeze([
      'The private copy receives the classified contents of the folder you choose. Setting it up asks GitHub whether the exact place you entered is private. It checks that the selected Cloud environment names that same place. It also checks that the computer you are driving can send there before saving anything. Privacy is checked again before every publication. What it does not check is whether the folder you picked is the one you meant.',
    ]),
    turnOnAt: 'Settings → Things it may do for you',
  }),
  /* THE ONE ROW THAT LETS A PERSON WRITE A FILE BY HAND. Everything else in
     this section decides what an assistant may do; this decides what the
     PERSON may do to what the assistant produced, which makes the risk half
     unusual -- the danger is not that something acts without asking, it is
     that a save is immediate and nothing takes it back. The owner ruled that
     this is deliberate ("this is their manual override of the agent"), so the
     statement says it plainly instead of hedging it. */
  'compare_files': Object.freeze({
    whatItDoes: 'Opens two files side by side in one window and lets you edit both. Each side has its own save, which replaces that file where it sits.',
    capabilities: Object.freeze([
      'You can read what an agent changed and correct it by hand before anything else runs.',
      'Both sides open and save inside the folder your assistants work in, and nowhere else.',
    ]),
    risks: Object.freeze([
      'A save replaces the file straight away and nothing here undoes it. Keep a copy first if you are not sure.',
      'The file may have moved since an agent produced the version you are reading. This window warns you before each save, and you may ask it to stop warning you.',
    ]),
    turnOnAt: 'Settings → Things it may do for you',
  }),
  /* ONE DECLARATION OVER THREE HUNDRED ROWS, and that is the honest shape here
     rather than an economy. The tools page (src/views/tools.js) shows a row per
     tool, and what a person needs to know about a WITHHELD one is the same
     sentence every time: what having a tool available means, what it costs, and
     that the answer was decided at setup and not on that page. Writing three
     hundred bespoke paragraphs would be three hundred chances to say something
     that is true of one tool and false of the next. The row's own name carries
     which tool it is; this carries what the state means. */
  'agent_tool': Object.freeze({
    whatItDoes: 'Decides whether your assistants may use one particular tool on this computer, and whether each use waits for your say-so.',
    capabilities: Object.freeze([
      'An assistant can finish a job that needs this one tool, instead of stopping at it and handing the rest back to you.',
      'You can leave a tool available and still require your approval for each use, so it is neither open nor shut.',
    ]),
    risks: Object.freeze([
      'A tool left available is used by an assistant on its own judgement, at whatever moment it decides it needs one.',
      'The more tools you leave available, the further into this computer and your accounts a single run can reach.',
    ]),
    turnOnAt: 'ToolsEnabled setup, where you chose what the assistants on this computer may reach',
  }),
  /* `mock_failures` was declared here until 2026-08-20 and its row is gone: it
     wrote a key nothing read, so no practice failure ever appeared and the
     honest risk statement it carried ("Leave this on and you will eventually
     not believe a real one") described something that could not happen. Its
     `turnOnAt` also named "Settings → Developer", a section that no longer
     exists -- a declaration outliving its row would send a person to a heading
     that is not there. */
})

/* The setup walkthrough's own answers. Kept here with everything else so the
   walkthrough, the settings page and the agent page cannot describe one choice
   three ways -- which is precisely what happened before this file existed. */
export const ANSWER_SUBJECTS = Object.freeze({
  observe: Object.freeze({
    whatItDoes: 'Switches on nothing that acts. Every screen still reads and reports.',
    capabilities: Object.freeze([
      'You can look at every screen and read everything before anything is able to run.',
    ]),
    risks: Object.freeze([
      'Nothing on this computer will be able to start an assistant while this is the answer, so there is no Start control to find.',
    ]),
    turnOnAt: 'Settings → Setup → How much it does without asking',
  }),
  assisted: Object.freeze({
    whatItDoes: 'Switches on the controls you press yourself, and leaves off everything that would act without you.',
    capabilities: Object.freeze([
      'You can start an assistant, hand it work, read its reports, and start a cloud task.',
      'It stops and asks you whenever it reaches something it needs permission for.',
    ]),
    risks: Object.freeze([
      'An assistant you start reads and changes files inside the folder you chose.',
      'Nothing runs until you press something, and approving, closing queue items and replying stay off.',
    ]),
    turnOnAt: 'Settings → Setup → How much it does without asking',
  }),
  autonomous: Object.freeze({
    whatItDoes: 'Switches on everything your permission level allows, including approving and replying.',
    capabilities: Object.freeze([
      'Assistants can approve items, close queued work and reply on your behalf without stopping for you.',
    ]),
    risks: Object.freeze([
      'When an assistant reaches something it needs permission for, it decides for itself instead of waiting. Work can travel a long way before you read it.',
      'Approvals and replies made this way are recorded as yours.',
    ]),
    turnOnAt: 'Settings → Setup → How much it does without asking',
  }),
})

/* ---------- resolving ---------- */

const ABSENT = Object.freeze({
  declared: false,
  whatItDoes: '',
  capabilities: Object.freeze([]),
  risks: Object.freeze([]),
  required: false,
  turnOnAt: '',
  externalCapability: null,
  /* THE SENTENCE FOR AN UNDECLARED SETTING, and it says the true thing rather
     than the reassuring one. "We have not written this yet" is honest; "there
     are no risks" is a claim nobody checked. */
  absenceNote: 'Nobody has written down yet what this one grants and what it risks. Until somebody does, treat that as unknown rather than as nothing.',
})

function frozenGuidance(source) {
  return Object.freeze({
    declared: true,
    whatItDoes: source.whatItDoes || '',
    capabilities: source.capabilities || Object.freeze([]),
    risks: source.risks || Object.freeze([]),
    /* NEVER ANYTHING BUT FALSE, and it is a literal rather than a field a
       caller passes in. No setting in this product is allowed to describe
       itself as required, because the whole directive is that a person is
       offered a step and not pushed into one. */
    required: false,
    turnOnAt: source.turnOnAt || '',
    externalCapability: source.externalCapability || null,
    absenceNote: '',
  })
}

/**
 * What does this subject grant, and what does it risk?
 *
 * @param id  a settings row id (`theme`, `write_dispatch`, `example_mode`), or an
 *            answer value from the walkthrough (`observe`).
 * @param options.section  the settings section the row is in, used to fall back
 *            to that family's shared statement. Omitted or unknown falls
 *            through to the honest absence, never to "harmless".
 */
export function describeSubject(id, { section = null } = {}) {
  if (typeof id !== 'string' || id.trim() === '') return ABSENT
  const direct = SUBJECTS[id] || ANSWER_SUBJECTS[id]
  if (direct) return frozenGuidance(direct)
  /* A write flag with no declaration is the case that must NOT fall through to
     a family statement: these are the rows that decide what this program may
     do, and an unexplained one has to be visible as unexplained. */
  if (id.startsWith('write_')) return ABSENT
  const profile = RISK_PROFILES[SECTION_RISK_PROFILE[section]]
  if (profile) return frozenGuidance(profile)
  return ABSENT
}

/**
 * The guided step for a subject, with the outside capability's state applied.
 *
 * @param id  the subject id.
 * @param options.probe  a function (capabilityId) -> true | false | anything
 *            else. Anything else is UNKNOWN, and unknown is reported as unknown.
 *            A missing probe is the same as one that could not answer.
 *
 * Returns null when the subject depends on nothing outside this product, so a
 * caller cannot render an empty walkthrough by accident.
 */
export function guidedStepFor(id, { probe = null, posture = null } = {}) {
  const guidance = describeSubject(id)
  if (!guidance.declared || !guidance.externalCapability) return null
  const capability = externalCapability(guidance.externalCapability)
  if (!capability) return null
  let probed
  try { probed = typeof probe === 'function' ? probe(capability.id) : undefined } catch { probed = undefined }
  const state = capabilityState(probed)
  return Object.freeze({
    capability,
    state,
    /* WHAT WE SAY AT EACH STATE. `unknown` is a first-class answer with its own
       sentence, because "we could not check" and "it is missing" are different
       facts and a person acts on them differently. */
    /* THE HEADLINES SAY WHAT COMES NEXT, AND ONE OF THEM USED TO SAY IT TWICE.
     *
     * `missing` read "${name} — not found on this computer", and the first
     * capability's own name ends "...on this computer" -- so the line rendered
     * as "Codex installed and signed in on this computer — not found on this
     * computer". It also stopped at the bad news: a heading that reports a
     * failure and names nothing to do about it is the shape this pass exists to
     * remove, and the steps sitting underneath it do not excuse the heading,
     * because the heading is what decides whether anybody opens the disclosure.
     *
     * `unknown` keeps the words "could not check" verbatim. They are pinned by
     * tools/test/permission-guidance.test.mjs and by the tier suite, and rightly
     * -- "we did not check" and "it is missing" are different facts. */
    headline: state === 'available'
      ? `${capability.name} — already here`
      : state === 'missing'
        ? `${capability.name} — not here yet. The steps below show what to do.`
        : `${capability.name} — this copy could not check whether it is here.`,
    showSteps: state !== 'available',
    withoutIt: capability.withoutIt,
    verify: capability.verify,
    /* Repeated at the point of the step, not only in the summary above it. A
       person reading a list of commands is at the moment they need to be told
       they can walk away from it.
       IT DOES NOT ASSERT THE SWITCH'S CURRENT STATE. It said "it is already on
       and saved", which was written while looking at a switch that was on, and
       read as a lie on the packaged window the first time it was seen under a
       switch that was off -- a small false sentence sitting directly under a
       true one, which is the fastest way to lose a reader. What is true in both
       states is that the step is not what decides it. */
    optionalNote: 'You do not have to do this for the setting to be on. The setting turns on and saves either way; this is what would make it work fully.',
    neverPerformedForYou: capability.neverPerformedForYou,
    /* R1536. Present on every step, at every state, because a person deciding
       whether to open the disclosure at all is asking "is this going to want
       something from me" before they are asking anything else. */
    frequency: frequencyFor(capability, posture),
  })
}

/**
 * The three questions every withheld state has to answer.
 *
 * What is off, what would turn it on, and what that gains and risks. Built from
 * the declarations above so a refusal cannot go vaguer than the setting it is
 * refusing, and cannot go stale when the setting's own statement changes.
 *
 * @param id      the subject that is off.
 * @param label   what to call it in the sentence, usually the row's own name.
 * @param reason  optional: why it is off, when that is more than "it is off".
 */
export function explainWithheld(id, { label = '', reason = '' } = {}) {
  const guidance = describeSubject(id)
  const name = label || id
  if (!guidance.declared) {
    return Object.freeze({
      declared: false,
      what: `${name} is switched off.`,
      whatItDoes: '',
      why: reason || '',
      turnOnAt: '',
      capabilities: Object.freeze([]),
      risks: Object.freeze([]),
      optional: 'It is off, and leaving it off is a complete answer.',
      absenceNote: guidance.absenceNote,
    })
  }
  return Object.freeze({
    declared: true,
    /* The heading is the STATE only. It carried the state and the description in
       one bolded run-on, which read as a paragraph shouted rather than a
       heading; the description is its own line below, where it is read. */
    what: `${name} is switched off.`,
    whatItDoes: guidance.whatItDoes,
    why: reason || '',
    turnOnAt: guidance.turnOnAt,
    capabilities: guidance.capabilities,
    risks: guidance.risks,
    /* THE SENTENCE THE DIRECTIVE IS ABOUT. It is generated for every withheld
       state rather than written per surface, because the one thing a person
       must never have to infer is whether they are being pushed. */
    optional: 'Turning it on is optional. Nothing else stops working while it is off, and you can turn it on later from the place named above.',
    absenceNote: '',
  })
}

/* ---------- the guarantees, checkable ---------- */

/**
 * Every declaration in this file, checked for the properties the directive
 * turns on. Exported so the test suite asserts the real exported values rather
 * than a regex over this file, and so a declaration added later cannot skip it.
 */
export function validateGuidance() {
  const errors = []
  const text = (value) => typeof value === 'string' && value.trim() !== ''
  const list = (value) => Array.isArray(value) && value.length > 0 && value.every(text)

  for (const [id, subject] of [...Object.entries(SUBJECTS), ...Object.entries(ANSWER_SUBJECTS)]) {
    if (!text(subject.whatItDoes)) errors.push(`${id}: whatItDoes must say plainly what it does`)
    if (!list(subject.capabilities)) errors.push(`${id}: capabilities must be a non-empty list of statements`)
    if (!list(subject.risks)) errors.push(`${id}: risks must be a non-empty list of statements`)
    if (!text(subject.turnOnAt)) errors.push(`${id}: turnOnAt must name where the switch is`)
    if (Object.prototype.hasOwnProperty.call(subject, 'required')) errors.push(`${id}: no setting may declare itself required`)
    if (subject.externalCapability && !EXTERNAL_CAPABILITIES[subject.externalCapability]) {
      errors.push(`${id}: names an outside capability that is not declared: ${subject.externalCapability}`)
    }
  }
  for (const [id, profile] of Object.entries(RISK_PROFILES)) {
    if (!list(profile.capabilities)) errors.push(`profile ${id}: capabilities must be a non-empty list`)
    if (!list(profile.risks)) errors.push(`profile ${id}: risks must be a non-empty list`)
  }
  for (const [section, profileId] of Object.entries(SECTION_RISK_PROFILE)) {
    if (!RISK_PROFILES[profileId]) errors.push(`section ${section}: names a profile that does not exist: ${profileId}`)
  }
  for (const [id, capability] of Object.entries(EXTERNAL_CAPABILITIES)) {
    if (capability.id !== id) errors.push(`${id}: declared under a different id than it carries`)
    if (!text(capability.name)) errors.push(`${id}: needs a name`)
    if (!text(capability.whatItDoes)) errors.push(`${id}: needs a plain statement of what it does`)
    if (capability.required !== false) errors.push(`${id}: an outside step may never be required`)
    if (capability.neverPerformedForYou !== true) errors.push(`${id}: must declare that this product never performs the step`)
    if (typeof capability.elevation !== 'boolean') errors.push(`${id}: must say whether the step needs an administrator`)
    /* R1536. The label is required of every outside capability, and the
       reasoning behind it is required beside it -- a claim nobody has to
       justify is a claim nobody can argue with, which is precisely how the
       wrong finding survived. `elevation: true` is called out separately
       because that is the case the owner named, and a future entry that needs
       an administrator must not be able to arrive without one. */
    if (!FREQUENCIES.includes(capability.frequency)) errors.push(`${id}: frequency must be one of ${FREQUENCIES.join(', ')}`)
    if (!text(capability.frequencyBecause)) errors.push(`${id}: must record how its frequency label was derived, so a reader can challenge it`)
    if (capability.elevation === true && !FREQUENCIES.includes(capability.frequency)) {
      errors.push(`${id}: a step that can need an administrator must say how often it asks something of you`)
    }
    /* THE THREE THINGS EVERY PERMISSION CONTROL HAS TO SAY, required here so a
       capability added later cannot arrive with two of them. `gains` and `costs`
       are checked as a PAIR and separately from `withoutIt`, because a step's
       cost and the consequence of skipping it are different facts: the renderer
       showed a heading for the first of these for the whole life of the feature
       and had nothing to put under it, and nothing was red. */
    if (!list(capability.gains)) errors.push(`${id}: must say what doing this step would let the person do`)
    if (!list(capability.costs)) errors.push(`${id}: must say what the step COSTS -- time, money, an account elsewhere, or what leaves this computer. A gain with no cost beside it is an advertisement`)
    if (!text(capability.withoutIt)) errors.push(`${id}: must say what still works without the step`)
    if (!text(capability.verify)) errors.push(`${id}: must say how the person knows it worked`)
    if (!Array.isArray(capability.steps) || capability.steps.length === 0) errors.push(`${id}: needs at least one step`)
    else for (const [index, step] of capability.steps.entries()) {
      if (!text(step.do)) errors.push(`${id}: step ${index} has nothing to do`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Ids from a settings catalogue that this file has nothing to say about. */
export function unexplainedSettingIds(settings) {
  if (!Array.isArray(settings)) return []
  return settings
    .filter(setting => !describeSubject(setting?.id, { section: setting?.section }).declared)
    .map(setting => setting?.id)
    .sort()
}
