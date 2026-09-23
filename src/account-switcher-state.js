/* THE ACCOUNTS MENU: everything it decides, and none of what it draws.
 *
 * WHY THIS IS ITS OWN FILE. Every sentence a person reads here, and every rule
 * about what a reply means, is checkable only if it is a VALUE. The rest of
 * this codebase already learned that twice -- src/first-run-needs.js and
 * src/account-panel-copy.js both say it in their own headers -- and the plain
 * language gate (tools/check-plain-language.mjs) walks values, so copy written
 * inside a render function is copy nothing measures. The DOM half next door
 * (src/account-switcher.js) holds NO sentence of its own: every word it puts on
 * the glass, down to the progress words and the two row flags, is a key of
 * COPY below, so tools/test/product-account-surface.test.mjs can register each
 * one and the gate can measure it.
 *
 * WHAT THE MENU IS FOR. A person can hold several Codex, Claude or Gemini
 * accounts. Until now the only way to see them was a form buried on the guide
 * page, the only way to change which one was in use was to start an agent and
 * hope, and the only way to control automatic switching was a single yes/no
 * question asked once during the first-run walkthrough. The owner's word for
 * it was "really bad and annoying". This is the one control that does all
 * four: see them, add one, switch to one, and choose how the computer picks.
 *
 * ADDING ONE IS A FEW CLICKS, NOT A FORM. The owner, on this exact surface:
 * "it should just be easy to add them in the app, just a few clicks" and "let
 * the customer set it up easily". So the menu asks for no folder. Pressing a
 * program's name asks the shell to make a folder of its own choosing for the
 * new account (accountAddManaged) and then to open that program's sign-in
 * window aimed at it (accountSignIn). The person signs in there; this menu
 * never sees what they type.
 *
 * FAIL CLOSED, IN THE ONE DIRECTION THAT MATTERS HERE. An unread allowance is
 * NEVER rendered as 0%, and an unrecognised reply is never rendered as a
 * healthy account. Those two are the same defect -- absence read as consent --
 * and on this surface it would put somebody's next run on an account nothing
 * had vouched for.
 */

/* THE WAYS TO PICK, IN THE ORDER THE MENU OFFERS THEM.
 *
 * The ids are the engine's (capability/src/lib/multi-account/selection-modes.js)
 * and they are the contract; the words are this file's. `manual` is first
 * because it is the safest and it is what every unreadable answer falls back
 * to. The DEFAULT when nobody has chosen is `priority`: the owner (2026-09-02)
 * added two accounts, signed them in, and expected them to rotate on their
 * own -- "they should stay signed in once i sign in - and then auto rotate".
 * tools/test/account-switcher-state.test.mjs holds this
 * list equal to the packaged engine's and the shell's, so a mode added to one
 * of the three and not the others cannot ship as a dropdown choice the computer
 * does not honour.
 *
 * Each `help` describes an OUTCOME rather than an algorithm, because the person
 * choosing is deciding what they want to happen, not how it is computed. Each
 * one says only what the code does: the manual help used to promise that this
 * menu would name the ready account when work stopped, and nothing delivered
 * that sentence, so it was cut to the half that is true. */
import { withDeadline } from './read-deadline.js'
import { readAllowanceBuckets, bucketHasMeasurement } from './allowance-buckets.js'
import { applyDeferredAccountPolicy } from './setup-intent-commit.js'

export const SELECTION_MODE_CHOICES = Object.freeze([
  Object.freeze({
    id: 'manual',
    label: 'Stop and let me switch',
    help: 'Never changes account on its own. When the one in use runs out, work stops until you switch here.',
  }),
  Object.freeze({
    id: 'priority',
    label: 'In the order listed',
    help: 'Uses the first account here until it runs out, then the next one down.',
  }),
  Object.freeze({
    id: 'rotate',
    label: 'Rotate',
    help: 'Each new run takes the next signed-in account in the listed order, skipping accounts at their limit. Remembers the last account across restarts.',
  }),
  Object.freeze({
    id: 'most-available',
    label: 'Most room left first',
    help: 'Starts each run on whichever account has the most of its 5-hour and weekly allowance still free. Best for long runs that must not stop halfway.',
  }),
  Object.freeze({
    id: 'least-available',
    label: 'Least room left first',
    help: 'Finishes off the account closest to its limit before touching the others, so the rest stay whole as a reserve.',
  }),
  Object.freeze({
    id: 'even',
    label: 'Keep them even',
    help: 'Spreads work so every account ends the week at about the same place. An account whose 5-hour window is spent waits its turn.',
  }),
  Object.freeze({
    id: 'dynamic',
    label: 'Dynamic',
    help: 'Drains one account at a time while there is plenty spare, then spreads the load once every account is getting tight.',
  }),
  /* Owner, 2026-09-02: "maybe expiring first could be a option too". Room left
     in a window is gone when that window turns over, so this spends the
     account whose window resets soonest. The engine ranks on the reset times
     the programs report; an account that reported none cannot be placed and
     waits behind the rest, which the second sentence says. */
  Object.freeze({
    id: 'resets-soonest',
    label: 'Resetting soonest first',
    help: 'Uses the account whose window resets soonest, so room that would be lost at the reset gets used first. An account that has not said when it resets waits behind the rest.',
  }),
])

export const SELECTION_MODE_IDS = Object.freeze(SELECTION_MODE_CHOICES.map(choice => choice.id))
export const DEFAULT_SELECTION_MODE = 'priority'
/* What an id this build does not know reads as: the stop, because the
   unreadable choice might have been the stop. Distinct from the default. */
export const UNRECOGNISED_SELECTION_MODE = 'manual'
export const DEFAULT_RESERVE_PERCENT = 25

/* THE MODES THAT RANK ON ALLOWANCE. Under these the engine honours a manual
   switch exactly once -- the next run starts on the chosen account, and every
   run after that is placed by the ranking -- so the confirmation a person
   reads after pressing "Use this one" has to say so. Under `manual` and
   `priority` the switch simply holds. */
export const RANKED_MODE_IDS = Object.freeze(['most-available', 'least-available', 'even', 'dynamic', 'resets-soonest'])
/* The id the last mode shipped under for a few hours; a shell that still
   answers it is read as the current id. Mirrors the engine's table. */
export const LEGACY_SELECTION_MODES = Object.freeze({ 'expiring-first': 'resets-soonest' })

/* WHICH WINDOW A RANKED MODE READS (owner, 2026-09-02: "maybe a weekly/hourly
   choice"). The ids are the engine's RANK_WINDOW_IDS; the words are here. */
export const RANK_WINDOW_CHOICES = Object.freeze([
  Object.freeze({ id: 'either', label: 'Whichever window is tighter' }),
  Object.freeze({ id: 'hourly', label: '5-hour window' }),
  Object.freeze({ id: 'weekly', label: 'Weekly window' }),
])
export const RANK_WINDOW_IDS = Object.freeze(RANK_WINDOW_CHOICES.map(choice => choice.id))
export const DEFAULT_RANK_WINDOW = 'either'
export function normalizeRankWindow(value) {
  return RANK_WINDOW_IDS.includes(value) ? value : DEFAULT_RANK_WINDOW
}
export function rankWindowChoice(id) {
  return RANK_WINDOW_CHOICES.find(choice => choice.id === id) || null
}

export function isRankedMode(id) {
  return RANKED_MODE_IDS.includes(id)
}

export function selectionModeChoice(id) {
  return SELECTION_MODE_CHOICES.find(choice => choice.id === id) || null
}

/** Anything this build does not recognise means `manual`. */
export function normalizeSelectionMode(value) {
  const known = Object.hasOwn(LEGACY_SELECTION_MODES, value) ? LEGACY_SELECTION_MODES[value] : value
  return SELECTION_MODE_IDS.includes(known) ? known : UNRECOGNISED_SELECTION_MODE
}

/* The three programs this menu can hold accounts for, and their own names for
   themselves. Kept as a table so a provider added later has one place to be
   named rather than a string in six branches. */
export const PROVIDER_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' })
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_LABELS))

/* Programs with established period-window slots, also drawn before a read.
   Other provider readings draw only the periods or independent buckets they
   actually report; this table is not an inventory of checker capabilities. */
export const USAGE_MEASURED_PROVIDERS = Object.freeze(['codex', 'claude'])

export function providerMeasuresUsage(id) {
  return USAGE_MEASURED_PROVIDERS.includes(id)
}

export function providerLabel(id) {
  return PROVIDER_LABELS[id] || String(id || 'unknown')
}

export const COPY = Object.freeze({
  title: 'Accounts',
  computerAccounts: 'On this computer',
  connectedAccounts: 'Connected accounts',
  switchingSettings: 'Switching & recovery',
  close: 'Close accounts',
  searchAccounts: 'Find an account',
  searchPlaceholder: 'Search name, sign-in or plan',
  filterProvider: 'Filter by program',
  allProviders: 'All programs',
  clearSearch: 'Clear filters',
  noMatches: 'No accounts match these filters.',
  matchingAccounts: (shown, total) => `${shown} of ${total} accounts shown`,
  identityNotReported: 'Sign-in identity not reported',
  accountActions: (name, program) => `${name} (${program})`,
  allowanceNotChecked: 'Not checked',
  allowanceHeading: 'Allowance remaining',
  providerAccountCount: count => `${count} ${count === 1 ? 'account' : 'accounts'}`,
  allowanceCheckFailed: 'Couldn’t check allowances',
  accountCheckFailed: 'Couldn’t check',
  allowanceCheckTimeUnknown: 'Check time not reported',
  allowanceOlderReading: 'Older reading',
  bucketScopeUnknown: 'Model not reported',
  bucketTokenUnknown: 'Token scope not reported',
  bucketScopes: 'Each limit applies to its reported model and token scope.',
  bucketPartial: 'Some allowance details could not be read.',
  bucketUnknown: 'No allowance amounts were reported.',
  bucketInvalid: 'The allowance reply could not be read.',
  bucketResetUnknown: 'Reset time not reported',
  bucketAmount: value => `${value} remaining`,
  bucketFraction: value => `${value}% remaining`,
  bucketInvalidScope: 'The model or token scope could not be read; its amount is unavailable.',
  bucketInvalidFraction: 'The remaining percentage could not be read.',
  bucketInvalidAmount: 'The remaining amount could not be read.',
  bucketInvalidReset: 'The reset time could not be read.',
  bucketDuplicate: 'The provider repeated this limit.',
  bucketConflict: 'The provider gave different readings for this limit. Use Check allowances to try again.',
  bucketInvalidEntry: 'Some reported limits could not be read.',
  bucketLimit: 'The reply contained more limits than this copy can display.',
  allowanceLastChecked: age => `Last checked ${age}`,
  allowanceNoReading: 'No allowance reading reported',
  allowanceSomeFailed: count => `Couldn’t check allowances for ${count} ${count === 1 ? 'account' : 'accounts'}. See each account for details.`,
  percentRemaining: percent => `${percent}% remaining`,
  loading: 'Loading accounts…',
  accountSummary: (count, providers) => `${count} ${count === 1 ? 'account' : 'accounts'} across ${providers} ${providers === 1 ? 'provider' : 'providers'}`,
  listUnavailable: 'Could not load accounts. Try Refresh accounts.',
  autosave: 'Changes save automatically',
  editing: 'Finish editing to save changes',
  saved: 'All changes saved',
  saveFailed: 'Some changes could not be saved',
  savedRefreshFailed: 'Changes saved. Could not refresh accounts; try Refresh accounts.',
  refreshAccounts: 'Refresh accounts',
  refreshingAccounts: 'Refreshing…',
  accountsRefreshed: 'Accounts and saved settings refreshed.',
  refreshFailed: 'Could not refresh the account list. Try Refresh accounts.',
  recoveryLabel: 'Continue agents after a limit',
  recoveryHelp: 'Try another available account with the agent’s brief and recent conversation. Keep its name and reporting relationships. If none is available, keep the handoff for retry.',
  recoverySaved: enabled => enabled ? 'Automatic recovery is on.' : 'Automatic recovery is off.',
  /* WHAT THE BUTTON SAYS WHEN NOTHING HAS BEEN READ YET, and it is not a
     number. A chip reading "0%" before the first read would be a measurement
     nobody took. */
  buttonUnread: 'Accounts',
  buttonMultiple: count => `Accounts · ${count} in use`,
  modeLabel: 'Default account rule',
  rankLabel: 'Rank on',
  rankHelp: 'Which window the ranking reads. The tighter one is the window closer to running out.',
  /* One program's own rule, or the rule above. */
  providerRule: program => `${program} rule`,
  sameAsAbove: 'Use default',
  rankSaved: label => `Ranking on: ${label}.`,
  providerRuleSaved: (program, label) => `${program} now follows: ${label}.`,
  /* SAID WHEN THE DEFAULT IS NOT WHAT RUNS. A program that recorded a rule of
     its own keeps it when the rule above changes -- that is what "Default
     account rule" means, and dropping those rules from here would throw away
     a choice the person made for a program they were not even looking at.
     What they are owed instead is the REASON their choice did not reach every
     program. The owner measured 18 of the last 30 starts on one account while
     this menu read Rotate (T378): the mode saved correctly, Claude was simply
     following a "Dynamic" rule of its own, which drains one account while
     there is room. Naming the programs is the whole notice. */
  overrideNotice: (programs, count, mode) => count === 1
    ? `${programs} has a rule of its own, so it is not following "${mode}".`
    : `${programs} have rules of their own, so they are not following "${mode}".`,
  /* The one thing here that changes anything, and only on a click. It presses
     the same "Use default" the person already has on each program's own row,
     rather than writing a second way to clear a rule. */
  overrideNoticeApply: 'Apply the default to these programs',
  modeHelpLead: 'What this does:',
  reserveLabel: 'Treat an account as tight below',
  reserveUnit: '% free',
  reserveHelp: 'Only “Dynamic” reads this. It is the point where an account stops counting as having plenty spare.',
  /* Said instead of saving. An empty box used to be sent as 0, which turned
     "I cleared the field" into "treat nothing as tight" with a "Saved"
     confirmation on top of it. */
  reserveInvalid: 'Type a number from 0 to 100.',
  refresh: 'Check allowances',
  refreshing: 'Checking…',
  /* THE SENTENCE THAT ENDS A CHECK. The first draft cleared the status line
     on success, which hid it, so a screen reader heard "Checking…" and then
     nothing at all -- only sighted eyes saw the bars change. A press that
     announces its start announces its end. */
  checked: 'Checked. The bars show what each account reported.',
  /* Said out loud, because this read starts a short-lived program per account
     and a person is entitled to know why the menu paused.
     IT DOES NOT SAY "STARTS NOTHING", and the first draft did. That was false:
     checking runs one short-lived program per Codex account (`codex
     app-server`) and one per Claude account (`claude`), each asked only its
     zero-token account questions; a Gemini account is a file presence check
     and starts nothing. What is true is the thing a person actually wants to
     know before pressing it -- no allowance is spent and no agent is started
     -- so that is what it says. */
  refreshCost: 'Checks the latest allowance information for each account. This does not start an agent.',
  switchTo: 'Use this one',
  inUse: 'In use now',
  /* WHEN THE COMPUTER IS RUNNING SOMETHING OTHER THAN WHAT WAS CHOSEN.
     MEASURED 2026-09-03 on the owner's machine: a hand switch to one account,
     a start 87 seconds later that could not use it, and a menu that from then
     on showed the other account "In use now" with nothing anywhere saying a
     choice had been made -- which reads as a pick that reverted itself. The
     choice still stands; this says so, and says what stopped it, so the person
     can wait, pick another, or fix the account rather than guess. */
  chosenLabel: 'Chosen',
  movedOff: (chosen, using) => `“${chosen}” is the account you chose. It could not be used, so this computer is on “${using}” for now and returns to “${chosen}” once it can serve.`,
  /* The chosen account's OWN line from the start that moved off it. Said only
     when there is one: a start that never reached the account carries no
     reason for it, and "could not look" is not "not there". */
  movedOffWhy: reason => `Why: ${reason}`,
  signIn: 'Sign in',
  /* THE TWO ROW FLAGS, three-valued with the reply that feeds them: "no" draws
     the first, an answer this build did not recognise draws the second, and
     "yes" draws neither. */
  notSignedIn: 'not signed in',
  signInUnchecked: 'sign-in not checked',
  notKnown: 'not known',
  /* An account that reported one window and not the other: the other is not
     unread, the plan simply has none (Codex Pro meters only a week). */
  noneReported: 'none reported',
  rename: 'Rename',
  renameSave: 'Save',
  renameCancel: 'Cancel',
  renaming: 'Renaming…',
  remove: 'Remove',
  removeArmed: 'Press again to remove',
  removing: 'Removing…',
  checkedJustNow: 'Checked just now.',
  checkedAgo: text => `Checked ${text}.`,
  /* THE ONE SENTENCE THAT SAYS A FAILOVER HAPPENED.
   *
   * The menu could say WHEN this computer last changed account and never what
   * the change WAS -- the shell answered the clock time off the record and
   * threw the rest away. An automatic switch is exactly the change nobody was
   * present for, so it is the one that has to be readable afterwards: a person
   * who finds their work on a different sign-in is owed which one it left,
   * which one it is on, and that the computer did it rather than them.
   *
   * FOUR SENTENCES BECAUSE THERE ARE FOUR FACTS TO TELL APART, not four
   * phrasings of one. A change the person made must never read as one the
   * computer made, and a record that did not say which it was must say neither
   * -- `automatic` is three-valued the whole way to here for that reason. */
  switchAuto: (from, to, when) => `This computer moved from “${from}” to “${to}” on its own, ${when}.`,
  switchAutoFirst: (to, when) => `This computer chose “${to}” on its own, ${when}.`,
  switchByHand: (to, when) => `You switched to “${to}” ${when}.`,
  /* Neither said. Said flatly, because "changed" is the whole of what is
     known and any verb with a subject in it would be inventing one. */
  switchUnstated: (to, when) => `The account in use changed to “${to}” ${when}.`,
  /* WHICH PROGRAM CHANGED, when the record says. Without it the sentence reads
     as though every agent on the computer moved, and only one program's
     accounts ever move at a time. */
  switchFor: (program, sentence) => `${program}: ${sentence}`,
  /* The switcher's own words for why, kept whole rather than paraphrased here:
     a second wording of a sentence another program writes is free to drift
     from it, and this one is shown beside the change it explains. */
  switchWhy: reason => `It gave this reason: ${reason}`,
  /* A record with no readable time still describes a real change. Saying so is
     not the same as having no record, and neither is worth hiding. */
  switchWhenUnknown: 'at a time this computer did not record',
  renamed: (from, to) => `Renamed “${from}” to “${to}”.`,
  renameRefused: 'That account was not renamed. Nothing changed.',
  removed: name => `Removed “${name}” from the list. Its folder and sign-in stay where they are.`,
  removeRefused: 'That account was not removed. Nothing changed.',
  /* THE PROGRESS WORDS. Each is on the status line for the length of one
     round trip, so a person who pressed something knows the press landed. */
  saving: 'Saving…',
  switching: 'Switching…',
  adding: 'Adding…',
  /* IT NAMES THE ACCOUNT because it is said once per account and the run below
     says it several times over. "Opening the sign-in window…" three times in a
     row tells a person nothing about which of three windows is arriving. */
  openingSignIn: name => `Opening the sign-in window for “${name}”…`,
  addHeading: 'Add an account',
  addName: 'Name (optional)',
  addNamePlaceholder: 'work',
  addProvider: 'Add an account for',
  providerSetup: 'Set up programs in Settings',
  setupProvider: program => `Set up ${program}`,
  setupHelp: 'Install the program in Settings, under "This computer", then refresh accounts to add it here.',
  policyNeedsAccount: 'Add an account to set switching rules and recovery.',
  /* IT SAYS WHAT ARRIVES, in the order it arrives. The first draft said "its
     own sign-in window opens", which described neither of the two things a
     person actually sees: a terminal window with the program's own sign-in
     running in it, and then that program sending them to their browser. */
  addHelp: 'Press the program you want another account for. A terminal window opens, named for the account; sign in there and in your browser. A name only helps tell accounts apart.',
  none: 'No accounts are listed here yet. Add your first account to manage it here. Any existing default sign-in stays available.',
  damaged: 'The list of accounts on this computer could not be read, so none are shown. Nothing has been lost.',
  unavailable: 'The copy installed on the computer you are driving cannot change assistant accounts. Update it there, then try again.',
  previewTitle: 'Example, not your accounts',
  previewHelp: 'This demo has no connected computer. Sign in and connect a computer running ToolsEnabled to manage your assistant accounts.',
  previewSignIn: 'Sign in',
  /* The same example on the desktop, where the switch put it there: say whose
     accounts these are not, and which switch brings back the person's own. */
  previewHelpDesktop: 'These are the example fleet’s accounts, not yours. Turn off “Show the example fleet” in Settings, under What the screens show, to manage your own.',
  usageUnavailable: 'This copy cannot check how much of each account is left. Everything else on this menu still works.',
  /* THE ONE SENTENCE THAT MAKES AN UNMEASURED ACCOUNT READABLE. It is a state,
     not a fault, and it must not look like one: a Claude account reports
     nothing at all until its own program has fetched usage once. */
  usageUnknown: 'How much is left is not known for this account.',
  usageUnknownWhy: 'That is normal until the program has looked once itself. It does not mean anything is wrong.',
  /* Before a Gemini checker result arrives, say only that this view has not
     checked it. Supported readings and explicit limitations use the returned
     bucket envelope or checker explanation instead of this initial state. */
  usageNotMeasured: 'Gemini allowance has not been checked in this view.',
  /* THE SAME FACT FOR A PROGRAM THAT HAS A READ OF ITS OWN (Grok's billing
     read, Antigravity's /quota) but did not report a figure on this check.
     Named for the program, because the sentence above says "Gemini" and was
     being printed under Grok rows. */
  usageNotReportedFor: program => `${program} did not report how much of this account is used, so it stays not known.`,
  /* THE PLAN THE PROGRAM ITSELF REPORTED ("max", "pro", "X Premium+"), shown
     as the program's own word and only when it said one. */
  planLine: plan => `Plan: ${plan}.`,
  /* When a program reported its period's end but no percentage, the end is
     still a fact a person can plan around. */
  periodResets: phrase => `This period ${phrase}.`,
  /* WHICH ACCOUNT THIS ROW IS ACTUALLY SIGNED IN AS.
     The name on a row is what a person typed. Pressing Sign in opens the
     program's own window, and whichever account the browser was already
     holding is the one that gets signed in -- nothing in this product sees
     that choice or can correct it. So the row could read "work" over a home
     signed in as somebody else, every later start would use that account, and
     the first sign of it was the wrong allowance draining. This is the line
     that makes it visible, and it is quiet on purpose: on a row that is right
     it is a detail, and it only has to be noticeable when it is wrong. */
  signedInAs: address => `Signed in as ${address}.`,
  /* THE TWO WINDOWS, NAMED FOR WHAT THEY ARE. The short one is five hours long
     for both programs that report it (Codex `primary`, Claude `five_hour`), and
     the first draft called it "this hour" -- which put "12% free this hour ·
     resets in 4h" on screen, two clauses that could not both be true. */
  /* THE LIMIT CONTROLS. "Move off" rather than "stop", because that is what
     the number does: the account keeps its remaining allowance and stops
     being chosen for new work. */
  limitsLabel: 'Move agents off an account at',
  limitWeeklyLabel: 'this week',
  limitHourlyLabel: '5-hour window',
  limitUnit: '%',
  limitHelp: 'The two allowances refill at very different speeds, so each gets its own number. A weekly allowance is worth leaving early; a 5-hour one refills while you work.',
  limitInherited: single => `using ${single}% for both`,
  limitSaved: (windowLabel, percent) => `Saved. Agents move off an account at ${percent}% of ${windowLabel}.`,
  limitRefused: 'That limit was not saved. Nothing changed.',
  hourly: 'this 5-hour window',
  weekly: 'this week',
  hourlyBar: '5-hour window',
  weeklyBar: 'this week',
  monthlyBar: 'this month',
  /* THE WEEK, WHEN THERE IS MORE THAN ONE OF IT. Claude meters the week twice
     -- once across every model and once for the model in use -- and until this
     the menu drew ONE "this week" bar holding whichever of the two was worse
     (owner: "i think fable weekly limit instead of all models weekly limit is
     shown for claude we should include both"). Both are drawn now, so both
     have to say which they are. The plain 'this week' above still stands where
     a plan reports only one week, because "(all models)" beside a lone bar
     would invite a person to look for the other one. */
  weeklyAll: 'this week (all models)',
  weeklyModel: model => `this week (${model})`,
  /* Two weeks, neither of which named a model: the provider's own word for
     each is the only thing that tells them apart, so it is shown rather than
     one of them being dropped for being unnameable. */
  weeklyNamed: label => `this week (${label})`,
  roomLeft: (percent, { model = null, shared = false } = {}) => model
    ? `${percent}% left for ${model}` : shared ? `${percent}% shared allowance left` : `${percent}% left`,
  percentFree: percent => `${percent}% free`,
  percentUsed: percent => `${percent}% used`,
  switched: name => `Now using “${name}”. The next run starts on it.`,
  switchedRotate: name => `Now using “${name}”. Rotate will choose the next available account when you start a run.`,
  switchedRanked: (name, modeLabel) => `Now using “${name}”. The next run starts on it; after that, “${modeLabel}” picks.`,
  switchedAlready: name => `Already using “${name}”. Nothing changed.`,
  switchRefused: 'That account was not switched to. Nothing changed.',
  modeSaved: label => `Saved. This computer now picks: ${label}.`,
  modeRefused: 'That setting was not saved. Nothing changed.',
  /* THE ADD CONFIRMATION BORROWS THE SIGN-IN ONE rather than repeating it, so
     the two can never describe the same window differently. */
  added: (name, title) => `Added “${name}”. ${COPY.signInOpened(name, title)}`,
  /* The account was added and the window did not open: two facts, said in that
     order, with the shell's own reason (or signInRefused) appended after. */
  addedOnly: name => `Added “${name}”.`,
  addRefused: 'That account was not added. Nothing changed.',
  /* WHAT THE PERSON WILL ACTUALLY SEE, AND WHAT IT IS CALLED.
     The old sentence said "a sign-in window opened for “work”", which named
     neither of the two places the sign-in happens and gave nobody a way to pick
     the right window out of several: every one of them runs the same command
     and, until 2026-09-03, every one of them was untitled. The title is the
     shell's own word for the window (shell/provider-login.cjs
     signInWindowTitle) rather than a second copy of the format built here, so
     the sentence cannot describe a window by a name it does not have. A shell
     that answered no title -- an older copy on the computer being driven -- is
     a different answer from a window with no name, and gets the second
     sentence: the account is still named, and nothing is invented. */
  signInOpened: (name, title) => (title
    ? `A terminal window named “${title}” opened. Sign in there and in your browser, then press Check allowances.`
    : `A terminal window opened for “${name}”. Sign in there and in your browser, then press Check allowances.`),
  signInRefused: 'The sign-in window did not open. Press Sign in on that row to try again.',
  /* THE TWO SENTENCES NOBODY PRESSES FOR. After a Sign in press the shell
     watches that one folder, so when the program writes its sign-in there the
     row changes on its own -- and a row that changed while a person was looking
     at the terminal window needs to say so, or they will not know it happened.
     The second is the other real outcome: the window was closed without
     finishing, and "still" is the word that says nothing was lost. */
  signInSeen: name => `“${name}” is signed in now.`,
  signInStillOut: name => `“${name}” is still not signed in. Finish in the window that opened, or press Sign in again.`,
  /* THE ONE CONTROL THAT WORKS THROUGH EVERY ACCOUNT THAT NEEDS SIGNING IN.
     Its label says "one at a time" because that is what a press does and
     because the alternative is what the person is afraid of: six windows at
     once is the state this whole change exists to end. */
  signInEach: count => (count === 1
    ? 'Sign in the last one that needs it'
    : `Sign in the ${count} that need it, one window at a time`),
  signInEachDone: 'That was the last one that needed it.',
  /* THE PROGRAM IS NOT INSTALLED, SAID FOR THIS MENU. The shell's own sentence
     for that state ends "Press Install first", because in Settings, under
     "This computer", an Install button stands beside it. This menu has no Install button, and on
     the first live drive the shell's sentence reached it verbatim: a person
     was told to press a button that was not there. So the shell's CODE is
     answered in this menu's words -- where Install is, and which press here
     comes after it. */
  notInstalled: program => `${program} is not on this computer yet. Install it in Settings, under "This computer", first, then press Sign in on that row.`,
  programUnnamed: 'That program',
  /* WHY THE ORDER IS WHAT IT IS, when two programs' orders have different
     explanations: each is named for the program it explains, so "“work” has
     the most left" and "no account reported" cannot read as one paragraph
     contradicting itself. A sentence both programs share is said once. */
  orderFor: (programs, why) => `${programs}: ${why}`,
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, limit) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, limit)
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
}

function sameName(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

/* ONE WINDOW, NORMALISED, OR NULL.
 *
 * `null` is returned for every shape this build does not recognise, and that is
 * what keeps a missing reading out of the bars. There is deliberately no branch
 * here that turns an absent percent into a number.
 *
 * `kind` COMES FROM THE SLOT, NOT THE PAYLOAD. readWindows below knows which
 * window it is unpacking; a payload that forgot to say `kind` on its weekly
 * window used to be sentenced as the short one while sitting in the bar
 * labelled "this week". The slot is the fact; the field is a courtesy. */
export function readWindow(value, kind = 'hourly') {
  if (!isPlainObject(value) || !finitePercent(value.usedPercent)) return null
  return Object.freeze({
    kind: kind === 'weekly' ? 'weekly' : 'hourly',
    usedPercent: value.usedPercent,
    remainingPercent: finitePercent(value.remainingPercent)
      ? value.remainingPercent
      : Math.max(0, 100 - value.usedPercent),
    resetsAt: boundedText(value.resetsAt, 40),
    label: boundedText(value.label, 60),
    /* WHICH MODEL THIS CEILING COVERS, when the engine said. Null is "the
       whole plan", which is a different fact from "the engine did not say" --
       and only a payload carrying more than one week has to tell them apart at
       all, so an engine that never sent this reads exactly as it always did. */
    model: boundedText(value.model, 60),
  })
}

const NO_WEEKLY_WINDOWS = Object.freeze([])
const NO_WINDOWS = Object.freeze({ hourly: null, weekly: null, weeklyWindows: NO_WEEKLY_WINDOWS })

/* HOW MANY WEEKLY CEILINGS ONE ROW MAY DRAW. Claude's schema names four
   (`seven_day` and three scoped ones); eight is room for a plan this build has
   not met without letting a damaged reply grow a row without end. */
const MAX_WEEKLY_WINDOWS = 8

function readWeeklyWindows(value) {
  if (!Array.isArray(value) || value.length === 0) return NO_WEEKLY_WINDOWS
  const windows = value.slice(0, MAX_WEEKLY_WINDOWS).map(entry => readWindow(entry, 'weekly')).filter(Boolean)
  return windows.length > 0 ? Object.freeze(windows) : NO_WEEKLY_WINDOWS
}

export function readWindows(value) {
  if (!isPlainObject(value)) return NO_WINDOWS
  return Object.freeze({
    hourly: readWindow(value.hourly, 'hourly'),
    weekly: readWindow(value.weekly, 'weekly'),
    /* EVERY weekly ceiling the engine reported, and EMPTY when it reported no
       list at all. Empty is not "no week": it is "this engine sends one week",
       and the bars fall back to the `weekly` slot, which is what every build
       before this one drew. */
    weeklyWindows: readWeeklyWindows(value.weeklyWindows),
  })
}

/* The engine's own default when a registry names no limit at all. Kept here
   so a menu drawn before the shell answers shows the number a start would
   actually use rather than a blank. */
const DEFAULT_EXHAUSTED_AT_PERCENT = 99

const NO_POLICY = Object.freeze({
  /* Matches the shell's own default, for the reason stated two fields below
     DEFAULT_EXHAUSTED_AT_PERCENT above: a menu drawn before the shell answers
     must show what a start would actually do. Drawn as off while the shell
     answers on, the checkbox told the person recovery was off when it was on. */
  autoRecoverOnLimit: true,
  selectionMode: DEFAULT_SELECTION_MODE,
  recorded: false,
  reservePercent: DEFAULT_RESERVE_PERCENT,
  exhaustedAtPercent: DEFAULT_EXHAUSTED_AT_PERCENT,
  exhaustedAtPercentHourly: null,
  exhaustedAtPercentWeekly: null,
})

/* WHICH ACCOUNT EACH PROGRAM IS ON, one name per provider or null.
   Returns null (not an empty table) when the shell did not say, so the merge
   below can tell "the shell answered per provider" from "an older shell
   answered one name for everything" and fall back only in the second case. */
function readActiveByProvider(value) {
  if (!isPlainObject(value)) return null
  const table = {}
  for (const provider of PROVIDER_IDS) {
    const entry = value[provider]
    table[provider] = typeof entry === 'string'
      ? boundedText(entry, 64)
      : (isPlainObject(entry) ? boundedText(entry.name, 64) : null)
  }
  return Object.freeze(table)
}

/* WHAT MOVED OFF THE CHOSEN ACCOUNT, PER PROGRAM. Only rows that name both
   accounts survive: a row that cannot say what is running instead explains
   nothing, and a half-drawn sentence is worse than none. The reason is
   optional on purpose -- a start that never reached the chosen account has no
   line for it -- and it is bounded like every other string that came off a
   file this window does not own. */
function readMovedOffByProvider(value) {
  if (!isPlainObject(value)) return null
  const table = {}
  for (const provider of PROVIDER_IDS) {
    const entry = value[provider]
    const chosen = isPlainObject(entry) ? boundedText(entry.chosen, 64) : null
    const using = isPlainObject(entry) ? boundedText(entry.using, 64) : null
    table[provider] = chosen && using
      ? Object.freeze({ chosen, using, at: boundedText(entry.at, 40), reason: boundedText(entry.reason, 400) })
      : null
  }
  return Object.freeze(table)
}

/**
 * The shell's account list, normalised.
 *
 * A reply this build does not recognise is `available: false` WITH a reason,
 * never an empty list: "there are no accounts" and "nobody answered" send a
 * person to two different places, and only one of them is an invitation to add
 * a first account.
 */
/* Which fields of a program's rule are its own. A shell that answered one
   boolean for the whole entry is read as all-or-nothing. */
const NO_OWN = Object.freeze({ selectionMode: false, reservePercent: false, rankWindow: false })
function readOwn(value) {
  if (value === true) return Object.freeze({ selectionMode: true, reservePercent: true, rankWindow: true })
  if (!isPlainObject(value)) return NO_OWN
  return Object.freeze({
    selectionMode: value.selectionMode === true,
    reservePercent: value.reservePercent === true,
    rankWindow: value.rankWindow === true,
  })
}

/* THE LAST CHANGE OF ACCOUNT, or null when this computer has never made one.
 *
 * `automatic` stays three-valued all the way to the screen. A record written
 * before the field existed did not say, and drawing "not stated" as "you did
 * this yourself" would tell somebody they made a change nobody made. */
function readLastSwitch(value) {
  if (!isPlainObject(value)) return null
  const at = boundedText(value.at, 40)
  const to = boundedText(value.to, 64)
  /* A switch with neither a time nor a destination describes nothing a person
     could read, and an entry of six nulls would draw as though something had
     happened. */
  if (!at && !to) return null
  return Object.freeze({
    at,
    from: boundedText(value.from, 64),
    to,
    provider: PROVIDER_IDS.includes(value.provider) ? value.provider : null,
    automatic: typeof value.automatic === 'boolean' ? value.automatic : null,
    reason: boundedText(value.reason, 240),
  })
}

export function readAccountList(value) {
  if (!isPlainObject(value) || value.ok !== true || !Array.isArray(value.accounts)) {
    return Object.freeze({
      available: false,
      damaged: false,
      accounts: Object.freeze([]),
      active: null,
      activeAt: null,
      activeProvider: null,
      activeByProvider: null,
      lastSwitch: null,
      chosenByProvider: null,
      movedOffByProvider: null,
      policy: NO_POLICY,
      note: COPY.unavailable,
    })
  }
  const accounts = value.accounts
    .filter(isPlainObject)
    .map(account => Object.freeze({
      name: boundedText(account.name, 64) || '',
      provider: PROVIDER_IDS.includes(account.provider) ? account.provider : null,
      directory: boundedText(account.directory, 1024),
      allowanceBinding: readAllowanceBinding(account.allowanceBinding),
      ...(Object.hasOwn(account, 'authGeneration') ? { authGeneration: readAuthGeneration(account.authGeneration) } : {}),
      ...(account.provider === 'gemini' && account.client === 'antigravity' ? { client: 'antigravity' } : {}),
      priority: Number.isSafeInteger(account.priority) ? account.priority : null,
      /* THREE-VALUED ON PURPOSE. The shell answers 'yes' or 'no' from a single
         existence check; anything else is a build that did not say, and a
         missing answer must not draw as "not signed in" -- that sends somebody
         to sign in to a folder that already is. */
      signedIn: account.signedIn === 'yes' ? true : account.signedIn === 'no' ? false : null,
      command: boundedText(account.command, 600),
    }))
    .filter(account => account.name && account.provider)

  const policySource = isPlainObject(value.policy) && isPlainObject(value.policy.policy)
    ? value.policy.policy
    : (isPlainObject(value.policy) ? value.policy : null)

  const active = isPlainObject(value.active) ? value.active : null

  return Object.freeze({
    available: true,
    damaged: value.damaged === true,
    accounts: Object.freeze(accounts),
    active: active ? boundedText(active.name, 64) : null,
    /* The shell's last allowance read, already in the shape loadUsage() gives,
       so the rows and the chip can paint from it before any program starts.
       Null when the shell had none or the reply did not carry one. */
    cachedUsage: readCachedUsage(value.usageCache),
    activeAt: active ? boundedText(active.at, 40) : null,
    activeProvider: active && PROVIDER_IDS.includes(active.provider) ? active.provider : null,
    activeByProvider: readActiveByProvider(value.activeByProvider),
    /* WHAT THE LAST CHANGE WAS, not only when it happened. `activeAt` above is
       the clock time off this same record, and it was all the menu had -- so it
       could say the computer changed account and never that it changed FROM
       one account TO another, or that it did so on its own. A failover is
       precisely the change nobody was present for. */
    lastSwitch: readLastSwitch(value.lastSwitch),
    /* THE ACCOUNT EACH PROGRAM WAS TOLD TO USE, AND WHAT MOVED OFF IT.
       Separate from `activeByProvider` because they answer different
       questions: that one is where the computer is, this one is where the
       person put it. Null from a shell that does not say -- which is not the
       same as a table saying nobody chose. */
    chosenByProvider: readActiveByProvider(active && active.chosenByProvider),
    movedOffByProvider: readMovedOffByProvider(active && active.movedOffByProvider),
    policy: Object.freeze({
      /* Same asymmetry as the shell: absent is "nobody decided", literal false
         is a decision. A shell that has not answered yet leaves this undefined,
         and undefined must not draw as off -- see NO_POLICY above. */
      autoRecoverOnLimit: policySource?.autoRecoverOnLimit !== false,
      selectionMode: (policySource && policySource.selectionMode != null ? normalizeSelectionMode(policySource.selectionMode) : DEFAULT_SELECTION_MODE),
      /* "Nobody has chosen" is not "somebody chose the cautious one". The menu
         draws the difference, so it has to survive this far. */
      recorded: Boolean(policySource && policySource.recorded === true),
      reservePercent: policySource && finitePercent(policySource.reservePercent)
        ? policySource.reservePercent
        : DEFAULT_RESERVE_PERCENT,
      rankWindow: normalizeRankWindow(policySource && policySource.rankWindow),
      /* Null means this window has no limit of its own and is using the
         single number. The menu draws that difference rather than showing an
         inherited number as though somebody had chosen it. */
      exhaustedAtPercent: policySource && finitePercent(policySource.exhaustedAtPercent)
        ? policySource.exhaustedAtPercent
        : DEFAULT_EXHAUSTED_AT_PERCENT,
      exhaustedAtPercentHourly: policySource && finitePercent(policySource.exhaustedAtPercentHourly)
        ? policySource.exhaustedAtPercentHourly : null,
      exhaustedAtPercentWeekly: policySource && finitePercent(policySource.exhaustedAtPercentWeekly)
        ? policySource.exhaustedAtPercentWeekly : null,
      /* Each program's rule in force (own or inherited) and whether it is its
         own, so the per-program control can read "same as above" honestly.
         An older shell that did not say answers the global rule for each. */
      byProvider: Object.freeze(Object.fromEntries(PROVIDER_IDS.map(id => {
        const entry = policySource && isPlainObject(policySource.byProvider) && isPlainObject(policySource.byProvider[id])
          ? policySource.byProvider[id] : null
        return [id, Object.freeze({
          selectionMode: entry && entry.selectionMode != null ? normalizeSelectionMode(entry.selectionMode)
            : (policySource && policySource.selectionMode != null ? normalizeSelectionMode(policySource.selectionMode) : DEFAULT_SELECTION_MODE),
          reservePercent: entry && finitePercent(entry.reservePercent) ? entry.reservePercent
            : (policySource && finitePercent(policySource.reservePercent) ? policySource.reservePercent : DEFAULT_RESERVE_PERCENT),
          rankWindow: normalizeRankWindow(entry && entry.rankWindow != null ? entry.rankWindow : (policySource && policySource.rankWindow)),
          own: readOwn(entry && entry.own),
        })]
      }))),
    }),
    note: value.damaged === true ? COPY.damaged : (accounts.length === 0 ? COPY.none : null),
  })
}

/**
 * The allowance reading, normalised.
 *
 * Every failure resolves to `ok: false` with a sentence and an EMPTY readings
 * map, which the merge below turns into "not known" per account rather than
 * into zeroes.
 */
function readAllowanceBinding(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

function readAuthGeneration(value) {
  if (value?.kind === 'file' && readAllowanceBinding(value.token)) return Object.freeze({ kind: 'file', token: value.token })
  if (value && ['absent', 'unavailable', 'unsupported'].includes(value.kind) && value.token === null) {
    return Object.freeze({ kind: value.kind, token: null })
  }
  return null
}

function sameFileGeneration(left, right) {
  return left?.kind === 'file' && right?.kind === 'file' && readAllowanceBinding(left.token) && left.token === right.token
}

// Only a completed explicit bridge read grants this in-memory context. Neither
// JSON nor the cache parser can grant it, and callers retire it with their view.
const explicitUsageReadings = new WeakSet()
export function revokeExplicitUsage(usage) {
  for (const reading of Object.values(usage?.readings || {})) explicitUsageReadings.delete(reading)
}

function unverifiedUsage(reading) {
  return ['ACCOUNT_USAGE_AUTH_CHANGED', 'ACCOUNT_USAGE_AUTH_UNAVAILABLE'].includes(reading?.usageCode)
    && reading.status === 'transient' && reading.usageStatus === 'unavailable'
    && !reading.email && !reading.planType && reading.usedPercent === null && !hasUsageMeasurements(reading)
}

function matchesUsageGeneration(account, reading) {
  if (sameFileGeneration(account.authGeneration, reading.authGeneration)) return true
  // Untagged values remain usable for legacy direct/example surfaces. Disk
  // records are always tagged and strictly validated by readCachedUsage below.
  if (!Object.hasOwn(account, 'authGeneration') && !Object.hasOwn(reading, 'authGeneration')) return true
  if (!explicitUsageReadings.has(reading)) return false
  if (unverifiedUsage(reading)) return true
  return ['absent', 'unsupported'].includes(account.authGeneration?.kind)
    && account.authGeneration.kind === reading.authGeneration?.kind
}

function readCachedUsage(value) {
  // Old disk records joined by display label alone. They cannot establish
  // which account was checked after that label is removed and reused.
  if (!isPlainObject(value) || !Array.isArray(value.accounts)
    || value.accounts.some(row => !isPlainObject(row) || !readAllowanceBinding(row.allowanceBinding))) return null
  const accounts = value.accounts.filter(row => readAuthGeneration(row.authGeneration)?.kind === 'file')
  const removedProviders = new Set(value.accounts.filter(row => !accounts.includes(row)).map(row => row.provider))
  value = { ...value, accounts, orders: (Array.isArray(value.orders) ? value.orders : []).filter(order => !removedProviders.has(order?.provider)) }
  return readUsageReply(value)
}

function readReportedUsage(value) {
  if (!isPlainObject(value) || !finitePercent(value.usedPercent) || !['month', 'week'].includes(value.period)) return null
  const resetsAt = boundedText(value.resetsAt, 40)
  return Object.freeze({ usedPercent: value.usedPercent, remainingPercent: 100 - value.usedPercent,
    period: value.period, resetsAt: resetsAt && Number.isFinite(Date.parse(resetsAt)) ? resetsAt : null })
}

function hasUsageMeasurements(reading) {
  return Boolean(reading?.reportedUsage || reading?.windows?.hourly || reading?.windows?.weekly || reading?.windows?.weeklyWindows?.length
    || reading?.allowanceBuckets?.buckets.some(bucketHasMeasurement))
}

export function readUsageReply(value) {
  if (!isPlainObject(value) || value.ok !== true || !Array.isArray(value.accounts)) {
    return Object.freeze({
      ok: false,
      reason: isPlainObject(value) && typeof value.reason === 'string' && value.reason
        ? value.reason
        : COPY.usageUnavailable,
      readings: Object.freeze({}),
      orders: Object.freeze([]),
    })
  }
  const readings = {}
  for (const row of value.accounts) {
    if (!isPlainObject(row)) continue
    const name = boundedText(row.name, 64)
    const provider = PROVIDER_IDS.includes(row.provider) ? row.provider : null
    if (!name || !provider) continue
    readings[`${provider}:${name.toLowerCase()}`] = Object.freeze({
      allowanceBinding: readAllowanceBinding(row.allowanceBinding),
      ...(Object.hasOwn(row, 'authGeneration') ? { authGeneration: readAuthGeneration(row.authGeneration) } : {}),
      readAt: Object.hasOwn(row, 'readAt') ? boundedText(row.readAt, 40) : boundedText(value.readAt, 40),
      usageStatus: ['measured', 'unavailable', 'not_reported', 'unsupported'].includes(row.usageStatus) ? row.usageStatus : null,
      usageSource: boundedText(row.usageSource, 80),
      usageCode: boundedText(row.usageCode, 80),
      usageReason: boundedText(row.usageReason, 400),
      reportedUsage: readReportedUsage(row.reportedUsage),
      allowanceBuckets: readAllowanceBuckets(row.allowanceBuckets, provider),
      status: boundedText(row.status, 32),
      canServe: row.canServe === true,
      usedPercent: finitePercent(row.usedPercent) ? row.usedPercent : null,
      windows: readWindows(row.windows),
      planType: boundedText(row.planType, 40),
      /* THE ROW'S OWN RESET TIME, KEPT SO THE MENU CAN SAY IT IN WORDS.
         The engine's sentences no longer carry an ISO string (the accounts
         cache measured 2026-09-03 had "; resets 2026-09-07T02:29:34.000Z."
         inside the prose), so the machine value now arrives only as this
         field -- and it is the ONLY place a reset time survives for a row
         the engine timed but did not measure a window for. rowLines() turns
         it into a clause with resetPhrase(); nothing paints it raw. */
      resetsAt: boundedText(row.resetsAt, 40),
      /* WHICH ACCOUNT THE PROGRAM SAYS IT IS SIGNED IN AS, kept rather than
         dropped. The engine has always reported it and this reader threw it
         away, so a row labelled "work" over a home signed in as somebody else
         looked exactly like a row that was right, and the first thing anybody
         noticed was the other account's allowance draining. Null for a reply
         that did not say -- "not answered" and "signed in as nobody" are not
         the same fact, and rowLines below prints neither as a name. */
      email: boundedText(row.email, 254),
      reason: boundedText(row.reason, 400),
    })
  }
  const orders = (Array.isArray(value.orders) ? value.orders : [])
    .filter(isPlainObject)
    .map(order => Object.freeze({
      provider: PROVIDER_IDS.includes(order.provider) ? order.provider : null,
      names: Object.freeze((Array.isArray(order.names) ? order.names : []).map(name => boundedText(name, 64)).filter(Boolean)),
      why: boundedText(order.why, 400),
    }))
    .filter(order => order.provider)

  return Object.freeze({
    ok: true,
    reason: null,
    readings: Object.freeze(readings),
    orders: Object.freeze(orders),
    /* When it was read, or null for a reply that did not say. */
    readAt: boundedText(value.readAt, 40),
  })
}

/* HOW OLD A READ MAY BE BEFORE THE MENU RE-READS ON ITS OWN WHEN OPENED. Five
   minutes: fresher than that and a second read would only repeat the same
   numbers at the cost of a program start per account. */
export const USAGE_STALE_MS = 5 * 60 * 1000

export function usageIsStale(usage, { now = Date.now() } = {}) {
  if (!usage || usage.ok !== true) return true
  const at = Date.parse(usage.readAt || '')
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) return true
  return now - at > USAGE_STALE_MS
}

/** "just now", "3 min ago", "2h ago", "3 days ago", or null when unparseable. */
export function agePhrase(readAt, { now = Date.now() } = {}) {
  const at = Date.parse(readAt || '')
  if (!Number.isFinite(at)) return null
  const ms = Math.max(0, now - at)
  if (ms < 60000) return 'just now'
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * The last change of account, in one sentence, or null when there has been none.
 *
 * Returns { text, reason, automatic } so the surface drawing it can mark a
 * change the computer made without re-deciding which sentence it was. `reason`
 * is the switcher's own words and is null unless it wrote some.
 */
export function lastSwitchSentence(list, { now = Date.now() } = {}) {
  const change = list && isPlainObject(list.lastSwitch) ? list.lastSwitch : null
  if (!change || !change.to) return null
  const when = agePhrase(change.at, { now }) || COPY.switchWhenUnknown
  let text
  if (change.automatic === true) {
    text = change.from ? COPY.switchAuto(change.from, change.to, when) : COPY.switchAutoFirst(change.to, when)
  } else if (change.automatic === false) {
    text = COPY.switchByHand(change.to, when)
  } else {
    text = COPY.switchUnstated(change.to, when)
  }
  /* The program is named only when the record named it. Guessing it from the
     account name would be the same guess isActiveRow() below refuses, and here
     it would tell somebody their Codex work moved when their Claude work did. */
  if (change.provider) text = COPY.switchFor(providerLabel(change.provider), text)
  return Object.freeze({
    text,
    reason: change.reason ? COPY.switchWhy(change.reason) : null,
    automatic: change.automatic,
  })
}

/* IS THIS ROW THE ONE ITS PROGRAM IS ON?
 *
 * The registry allows one name per provider, so "school" can be both a Codex
 * and a Claude account, and the first draft marked both rows active whenever
 * either was. The shell now says which account each program is on
 * (activeByProvider), and that table is the answer when it is present. An
 * older shell that answered one name for everything gets the name honoured
 * ONLY when it names exactly one row -- two rows sharing it would mean
 * guessing, and a guess here hides a "Use this one" button somebody needs. */
function isActiveRow(list, account) {
  if (list.activeByProvider) {
    return sameName(list.activeByProvider[account.provider], account.name)
  }
  if (list.active === null || !sameName(list.active, account.name)) return false
  if (list.activeProvider) return list.activeProvider === account.provider
  return list.accounts.filter(entry => sameName(entry.name, account.name)).length === 1
}

/** Join the list with whatever was measured about it. Unmeasured stays unmeasured. */
export function mergeAccounts(list, usage, { now = Date.now() } = {}) {
  const readings = usage && isPlainObject(usage.readings) ? usage.readings : {}
  return Object.freeze(list.accounts.map(account => {
    const candidate = readings[`${account.provider}:${account.name.toLowerCase()}`] || null
    const reading = candidate && readAllowanceBinding(account.allowanceBinding)
      && candidate.allowanceBinding === account.allowanceBinding && matchesUsageGeneration(account, candidate) ? candidate : null
    const windows = reading ? reading.windows : NO_WINDOWS
    const measured = hasUsageMeasurements(reading)
    const usageReadAt = reading ? reading.readAt : null
    const failed = Boolean(usage?.ok === false || (reading && (reading.usageStatus === 'unavailable' || reading.status === 'transient'
      || (!measured && reading.status === null))))
    const usageState = failed ? 'failed' : !measured ? 'unknown'
      : reading.usageStatus === 'not_reported' || usageIsStale({ ok: true, readAt: usageReadAt }, { now }) ? 'stale' : 'current'
    return Object.freeze({
      ...account,
      active: isActiveRow(list, account),
      /* THE ROW THE PERSON PICKED, which is not always the row in use. Drawn
         beside "In use now" rather than instead of it: while a chosen account
         is out of allowance the two are different rows, and a menu that shows
         only the second is where a choice appears to have reverted itself. */
      chosen: Boolean(list.chosenByProvider && sameName(list.chosenByProvider[account.provider], account.name)),
      status: reading ? reading.status : null,
      canServe: reading ? reading.canServe : null,
      reason: reading ? reading.reason : null,
      resetsAt: reading ? reading.resetsAt : null,
      /* The account the program answered with, or null when nothing has been
         read yet. Not defaulted to the row's own name: the row's name is what
         a person typed, and the whole point of this field is that the two can
         differ without anybody being told. */
      email: reading ? reading.email : null,
      /* The plan the program reported, or null when it named none. */
      planType: reading ? reading.planType : null,
      windows,
      reportedUsage: reading?.reportedUsage || null,
      allowanceBuckets: reading?.allowanceBuckets || null,
      usageStatus: reading?.usageStatus || null,
      usageSource: reading?.usageSource || null,
      usageCode: reading?.usageCode || null,
      usageReason: reading?.usageReason || null,
      measured,
      usageReadAt,
      usageState,
      usageError: failed ? (usage?.ok === false ? usage.reason : reading?.usageReason || reading?.reason || null) : null,
      /* The window this account hits FIRST, which is the honest single number.
         Null when nothing was read; never the larger of two absent values. */
      binding: bindingOf(windows),
    })
  }))
}

function bindingOf(windows) {
  const both = [windows.hourly, windows.weekly].filter(Boolean)
  if (both.length === 0) return null
  return both.reduce((worst, entry) => (entry.usedPercent > worst.usedPercent ? entry : worst))
}

/* The closed account menu is shared by every agent. A Fable-only ceiling
   cannot stand for the allowance an Opus session shares with other models.
   Keep every ceiling in the open menu, and name the scope of its summary. */
export function accountRoomLeft(account) {
  const windows = account?.windows || NO_WINDOWS
  const weeklies = windows.weeklyWindows?.length ? windows.weeklyWindows : [windows.weekly]
  const all = [windows.hourly, ...weeklies].filter(Boolean)
  const shared = all.filter(window => !window.model)
  const candidates = shared.length ? shared : all
  if (!candidates.length) return null
  const binding = candidates.reduce((worst, window) => window.usedPercent > worst.usedPercent ? window : worst)
  return COPY.roomLeft(Math.round(binding.remainingPercent), {
    model: binding.model,
    shared: all.some(window => window.model),
  })
}

/** Accounts grouped by program, so a menu can head each group with its name. */
export function groupByProvider(accounts) {
  return Object.freeze(PROVIDER_IDS
    .map(provider => Object.freeze({
      provider,
      label: providerLabel(provider),
      accounts: Object.freeze(accounts.filter(account => account.provider === provider)),
    }))
    .filter(group => group.accounts.length > 0))
}

/* THE TWO WAYS A ROW CAN BE SIGNED OUT, AND THE ONE FLAG THEY SHARE.
 *
 * The shell answers signedIn from a file's presence; the engine, when asked,
 * answers a status of its own, and `signed_out` is its word for the same
 * fact. The first draft drew one flag per source, so after Check allowances a
 * row read "not signed in signed out" -- one fact, said twice, in two
 * vocabularies (measured on the first live drive). One flag is drawn, in the
 * menu's words. The same test decides whether the row offers a Sign in press:
 * an engine that LOOKED and found no sign-in is not the menu guessing.
 *
 * THE ENGINE'S REASON IS NOT REPEATED FOR A SIGN-OUT. For signed_out the
 * engine's sentence tells a person to set CODEX_HOME or GEMINI_CLI_HOME by
 * hand, beside a row whose flag and Sign in button already say everything
 * they can act on; it is dropped. For every other status the engine's word is
 * the only explanation there is, so it stays -- in the tooltip AND as a line
 * under the row (rowLines), because a title on a span is read by a pointer
 * and by nothing else. */
const SIGNED_OUT_STATUS = 'signed_out'

function engineSaysSignedOut(account) {
  return account.canServe === false
    && typeof account.status === 'string'
    && account.status.toLowerCase() === SIGNED_OUT_STATUS
}

export function needsSignIn(account) {
  return account.signedIn === false || engineSaysSignedOut(account)
}

/* HOW ONE ROW IS REMEMBERED BETWEEN TWO READS OF THE LIST. Names are unique
   PER PROGRAM and not across them -- shell/account-registry.cjs says "school"
   may be both a Codex account and a Claude one -- so the program is half the
   key, and the name is compared the way every other comparison on this surface
   compares it (sameName above, case-insensitively). */
export function accountKey(account) {
  return `${account.provider}:${String(account.name || '').toLowerCase()}`
}

/* WHAT A "SIGN IN THE ONES THAT NEED IT" PRESS STILL HAS TO OPEN.
 *
 * WHY THE OPENED ONES ARE PASSED IN RATHER THAN DERIVED. Signing in happens in
 * the person's own window, and this product reads nothing of it -- that is the
 * rule shell/provider-login.cjs is built on. So an account whose window was
 * opened a second ago still reads as "not signed in" on the next list read,
 * for as long as the person takes to finish, and a queue recomputed from
 * needsSignIn alone would offer the same account for ever. The caller
 * remembers what it has already opened; this decides what is left, in the
 * order the list is in.
 *
 * ONE WINDOW PER PRESS IS THE WHOLE POINT. Nothing here loops: opening six
 * windows from one press is the state this exists to end, and there is no
 * signal that a sign-in finished to sequence them on. So a press opens the
 * first of these and the control offers the next. */
export function signInQueue(accounts, opened = new Set()) {
  return Object.freeze((accounts || []).filter(account => needsSignIn(account) && !opened.has(accountKey(account))))
}

/* THE ENGINE'S OWN VERDICT ON A ROW, when this menu has no word of its own for
   it: a status under which the account cannot serve, other than signed_out.
   The status word is spoken rather than shouted ("exhausted", not
   "EXHAUSTED"), and the reason sentence comes along when the engine gave one.
   One predicate feeds both the flag and the line under the row, so the two
   cannot disagree about whether there is a fault. */
function engineFault(account) {
  if (account.canServe !== false || !account.status || engineSaysSignedOut(account)) return null
  return Object.freeze({
    status: String(account.status).replace(/_/g, ' ').toLowerCase(),
    reason: typeof account.reason === 'string' && account.reason ? account.reason : null,
  })
}

/* DOES A WINDOW ON THIS ROW ALREADY SAY WHEN IT COMES BACK? windowSentence()
   ends "· resets in 3h" for every window that carries a reset time, so a row
   with one has the clause on its own loud line already. */
function windowsNameAReset(windows) {
  if (!isPlainObject(windows)) return false
  return Boolean((windows.hourly && windows.hourly.resetsAt) || (windows.weekly && windows.weekly.resetsAt))
}

/* THE ENGINE'S FAULT SENTENCE, PLUS THE ONE CLAUSE THIS MENU ADDS TO IT.
 *
 * The engine's sentences no longer name a reset time. MEASURED 2026-09-03 in
 * the installed copy's accounts-usage-cache.json, they did: an exhausted
 * Claude row ended "...92% of its weekly allowance is used; resets
 * 2026-09-03T17:00:00.309845+00:00." and a healthy Codex row ended "; resets
 * 2026-09-07T02:29:34.000Z." -- microsecond ISO strings on a screen a person
 * reads. The time still arrives, as the row's `resetsAt`, and THIS is where it
 * becomes words, through the same resetPhrase() the rest of the menu uses.
 *
 * ADDED ONLY WHEN NO WINDOW SAID IT. A row whose loud line already reads
 * "8% free this week · resets in 11h" does not need the same fact again one
 * line down; "one fact, said twice, in two vocabularies" is the defect this
 * file has now recorded three times. A row the engine timed but measured no
 * window for is the case that has nowhere else to say it, and it is the case
 * this serves. */
export function faultLine(account, { now = Date.now() } = {}) {
  const fault = engineFault(account)
  if (!fault || !fault.reason) return ''
  if (windowsNameAReset(account.windows)) return fault.reason
  const phrase = resetPhrase(account.resetsAt, { now })
  if (!phrase) return fault.reason
  return `${fault.reason} ${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`
}

/** The flags beside a row's name: each a text, a tone and an optional tooltip. */
export function rowFlags(account, { now = Date.now() } = {}) {
  const flags = []
  const signedOut = engineSaysSignedOut(account)
  if (needsSignIn(account)) {
    flags.push({ text: COPY.notSignedIn, tone: signedOut ? 'bad' : 'plain', title: null })
  } else if (account.signedIn === null) {
    flags.push({ text: COPY.signInUnchecked, tone: 'plain', title: null })
  }
  const fault = engineFault(account)
  /* The tooltip is the SAME sentence the quiet line under the row carries,
     reset clause included -- a pointer and a screen reader must not be told
     two different things about one row. */
  if (fault) flags.push({ text: fault.status === 'transient' ? COPY.accountCheckFailed : fault.status, tone: 'bad', title: faultLine(account, { now }) || null })
  return Object.freeze(flags.map(flag => Object.freeze(flag)))
}

/* THE ONE LINE FOR AN UNMEASURED ROW OF A PROGRAM OUTSIDE THE MEASURED TABLE.
 *
 * A Gemini CLI row with no reading is unchecked. A checker refusal uses its
 * explicit reason, and independent bucket replies have their own display.
 * Grok and Antigravity retain their existing status/period explanations:
 * before any check (or signed out,
 * which the flag and the Sign in press already say) it is simply not known;
 * after a check that found no figure it is the engine's own sentence (which
 * says why), with the period's end as a quiet line under it when the program
 * reported one. Beside a fault that has a reason there is no allowance line at
 * all: the fault's own line below says it once, and a "did not report"
 * sentence above an "exhausted" or "signed in as someone else" one would
 * contradict it. */
function ownsAllowanceRead(account) {
  return account.provider === 'grok' || (account.provider === 'gemini' && account.client === 'antigravity')
}

function unmeasuredLines(account, { now = Date.now() } = {}) {
  if (!ownsAllowanceRead(account)) return [{ text: COPY.usageNotMeasured, quiet: false }]
  if (!account.status || engineSaysSignedOut(account)) return [{ text: COPY.usageUnknown, quiet: false }]
  const fault = engineFault(account)
  if (fault) return fault.reason ? [] : [{ text: COPY.usageNotReportedFor(providerLabel(account.provider)), quiet: false }]
  if (!account.reason) return [{ text: COPY.usageNotReportedFor(providerLabel(account.provider)), quiet: false }]
  const phrase = resetPhrase(account.resetsAt, { now })
  return [{ text: account.reason, quiet: false }, ...(phrase ? [{ text: COPY.periodResets(phrase), quiet: true }] : [])]
}

/* THE LINES UNDER A ROW'S NAME, in order, each marked quiet or not.
 *
 * ONE SENTENCE FOR A PROGRAM NOBODY MEASURES. A Gemini row used to read "How
 * much is left is not known for this account." and then "This copy does not
 * measure how much a Gemini account has left, so it stays not known." -- the
 * same fact twice, the second already carrying the first. A provider whose
 * allowance this copy never reads gets the second sentence alone, as the
 * row's one line rather than as a footnote to a line that is not there.
 *
 * A measured-provider row that has not been read gets its "not known" line
 * and the quiet reassurance under it, as before. And a fault the engine
 * reported (faultLine, which is engineFault's sentence plus this menu's own
 * reset clause) is printed as a quiet line, so that a keyboard or
 * screen-reader user can read the sentence a pointer would find in the
 * flag's tooltip. */
export function rowLines(account, { now = Date.now(), includeIdentity = true, includeAllowance = true } = {}) {
  const lines = []
  if (includeAllowance && account.allowanceBuckets) {
    lines.push(...allowanceBucketNotes(account.allowanceBuckets).map(text => ({ text, quiet: false })))
  } else if (includeAllowance && !account.measured && account.usageReason
      && ['unsupported', 'not_reported'].includes(account.usageStatus)
      && !engineFault(account) && !engineSaysSignedOut(account)) {
    lines.push({ text: account.usageReason, quiet: false })
  } else if (includeAllowance && !account.measured && !providerMeasuresUsage(account.provider)) {
    lines.push(...unmeasuredLines(account, { now }))
  } else if (includeAllowance) {
    lines.push({ text: accountSentence(account, { now }), quiet: false })
    if (!account.measured) lines.push({ text: COPY.usageUnknownWhy, quiet: true })
  }
  /* AFTER THE ALLOWANCE BLOCK, so the "not known" sentence and the "that is
     normal" one under it stay next to each other, and BEFORE the fault, which
     is the line a person acts on. Printed for every program that answered one,
     not only for the one whose mismatch prompted this: an identity nobody can
     see is the same defect on every row. */
  if (includeIdentity && account.email) lines.push({ text: COPY.signedInAs(account.email), quiet: true })
  if (includeIdentity && account.planType) lines.push({ text: COPY.planLine(account.planType), quiet: true })
  /* MERGE 2026-09-03: the identity lane wrote engineFault(account).reason here;
     the reset-clause lane had already replaced that call with faultLine(), which
     is the same engine sentence plus this menu's own "Resets in 3h." clause.
     faultLine() is kept so neither lane's line is lost. */
  const fault = faultLine(account, { now })
  if (fault) lines.push({ text: fault, quiet: true })
  return Object.freeze(lines.map(line => Object.freeze(line)))
}

/* WHY THE ORDER IS WHAT IT IS, SAID ONCE. The engine explains each program's
   order separately, and two programs with nothing measured explain themselves
   in the same sentence; the first draft joined the explanations and printed
   that sentence twice (measured on the first live drive, with a Claude and a
   Gemini account). A shared sentence is said once; sentences that differ are
   each named for the program they are about.

   A PROGRAM NOBODY MEASURES HAS NO ORDER TO EXPLAIN. The engine sends an
   order for every program with accounts, Gemini included, and for Gemini it
   always reads "No account reported how much of its allowance is left" --
   which, above a row saying this copy never measures Gemini, reads as a
   fault. Orders for a provider outside USAGE_MEASURED_PROVIDERS are dropped
   before a word is written. */
export function orderExplanation(orders) {
  const programsBySentence = new Map()
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!isPlainObject(order) || typeof order.why !== 'string' || !order.why) continue
    if (!providerMeasuresUsage(order.provider)) continue
    const programs = programsBySentence.get(order.why) || []
    if (PROVIDER_IDS.includes(order.provider) && !programs.includes(order.provider)) programs.push(order.provider)
    programsBySentence.set(order.why, programs)
  }
  if (programsBySentence.size === 0) return ''
  if (programsBySentence.size === 1) return [...programsBySentence.keys()][0]
  return [...programsBySentence]
    .map(([why, programs]) => COPY.orderFor(programs.map(providerLabel).join(' and '), why))
    .join(' ')
}

/* THE PARAGRAPH UNDER THE LIST, OR NOTHING. Under "stop and let me switch" and
   "in the order listed" the order IS the list, and the engine's sentence for
   both ("In the order the accounts are listed.") is filler under rows that
   already show it -- the first draft printed it anyway. Only the modes that
   rank on allowance (RANKED_MODE_IDS) have an order that needs words, and
   only a read that succeeded has any. */
export function orderParagraph(mode, usage) {
  if (!isRankedMode(mode)) return ''
  if (!isPlainObject(usage) || usage.ok !== true) return ''
  return orderExplanation(usage.orders)
}

/* WHAT THE MENU SAYS WHEN THE COMPUTER IS NOT ON THE ACCOUNT THAT WAS CHOSEN.
 *
 * One line per program that moved off its choice, each naming the chosen
 * account, the account running instead and -- when the start recorded one --
 * the chosen account's own reason, which is where the figure and the reset
 * live. Empty when nothing moved off anything, and empty for a shell that
 * does not answer: "this build cannot say" must not draw as "nothing
 * happened", it draws as nothing at all, which is what the rest of this menu
 * does with an absent optional read. */
export function movedOffParagraph(listing) {
  if (!isPlainObject(listing) || !isPlainObject(listing.movedOffByProvider)) return ''
  const lines = []
  for (const provider of PROVIDER_IDS) {
    const row = listing.movedOffByProvider[provider]
    if (!isPlainObject(row)) continue
    const said = COPY.movedOff(row.chosen, row.using)
    lines.push(row.reason ? `${said} ${COPY.movedOffWhy(row.reason)}` : said)
  }
  return lines.join(' ')
}

/** "82% free this 5-hour window · resets in 3h", or the stated unknown. */
export function windowSentence(window, { now = Date.now(), where = null } = {}) {
  if (!window) return COPY.usageUnknown
  /* `where` is passed only by accountBars below, which is the one caller that
     can see the OTHER ceilings on the same row and so is the only one that can
     say "all models" rather than plain "this week". On its own a window knows
     the model it is scoped to and nothing about its siblings. */
  const names = where || (window.kind === 'weekly'
    ? (window.model ? COPY.weeklyModel(window.model) : COPY.weekly)
    : COPY.hourly)
  const resets = window.resetsAt ? ` · ${resetPhrase(window.resetsAt, { now })}` : ''
  return `${COPY.percentFree(Math.round(window.remainingPercent))} ${names}${resets}`
}

/* WHICH WEEK THIS ONE IS, said among the weeks drawn beside it.
 *
 * A ceiling scoped to a model is named for that model. An unscoped one is
 * "this week" when it is the only week on the row and "this week (all models)"
 * when a scoped one sits under it -- because that is the pair the owner could
 * not tell apart, and "(all models)" is only true as a contrast. Two unscoped
 * weeks fall back to the provider's own word for each rather than either being
 * dropped or both reading the same. */
function weeklyPhrase(window, siblings) {
  if (window.model) return COPY.weeklyModel(window.model)
  if (siblings.length < 2) return COPY.weekly
  if (siblings.some(other => other && other !== window && other.model)) return COPY.weeklyAll
  return window.label ? COPY.weeklyNamed(window.label) : COPY.weekly
}

/**
 * THE BARS ONE ROW DRAWS, decided here and only drawn next door.
 *
 * One short window, then EVERY weekly ceiling the engine reported, in the
 * engine's order. MEASURED 2026-09-02 (Claude Code 2.1.258): Claude answers
 * `get_usage` with a week across all models AND a week for the model in use --
 * 25% and 46% used on the owner's own account -- and the menu had one weekly
 * slot, so it drew the worse of the two under the word "this week" and a
 * person could tell neither which week that was nor that the other existed.
 *
 * A reading with no list -- a Codex account, or an engine older than this --
 * draws the single `weekly` slot under the plain label, which is what the menu
 * has always drawn. An unread window is still a bar: `window` is null and the
 * caller says "not known" or "none reported" in its place, because a window
 * nobody could ask about has to keep its row.
 */
export function accountBars(account, { now = Date.now() } = {}) {
  const windows = account && isPlainObject(account.windows) ? account.windows : NO_WINDOWS
  const weeklies = Array.isArray(windows.weeklyWindows) && windows.weeklyWindows.length > 0
    ? windows.weeklyWindows
    : [windows.weekly]
  const bars = [Object.freeze({
    key: 'hourly',
    label: COPY.hourlyBar,
    window: windows.hourly,
    sentence: windowSentence(windows.hourly, { now }),
  })]
  weeklies.forEach((window, index) => {
    const where = window ? weeklyPhrase(window, weeklies) : null
    bars.push(Object.freeze({
      key: `weekly-${index}`,
      /* The label a person reads and the sentence a screen reader hears name
         the SAME ceiling in the same words. Two bars whose accessible names
         differed only by a percentage would be the very confusion this fixes,
         said again to the person least able to check it against the picture. */
      label: where || COPY.weeklyBar,
      window,
      sentence: windowSentence(window, { now, where }),
    }))
  })
  // A reported billing period is a display fact, not a window for account
  // ranking. Keep its own period and do not repeat an existing shared week.
  const reported = account?.reportedUsage
  if (reported && finitePercent(reported.usedPercent) && ['month', 'week'].includes(reported.period)
      && !(reported.period === 'week' && weeklies.some(window => window && !window.model))) {
    const where = reported.period === 'month' ? COPY.monthlyBar : COPY.weeklyBar
    const window = Object.freeze({ usedPercent: reported.usedPercent,
      remainingPercent: 100 - reported.usedPercent, resetsAt: reported.resetsAt || null })
    // Do not surround a real monthly reading with imaginary hourly/weekly
    // slots. Existing measured windows keep their labels and positions.
    for (let index = bars.length - 1; index >= 0; index--) if (!bars[index].window) bars.splice(index, 1)
    bars.push(Object.freeze({ key: `reported-${reported.period}`, label: where, window,
      sentence: windowSentence(window, { now, where }) }))
  }
  if (account?.allowanceBuckets) {
    // Independent provider scopes cannot supply imaginary period slots.
    for (let index = bars.length - 1; index >= 0; index--) if (!bars[index].window) bars.splice(index, 1)
    for (const bucket of account.allowanceBuckets.buckets) {
      bars.push(Object.freeze({ key: `bucket:${bucket.key}`, label: bucket.modelId || COPY.bucketScopeUnknown,
        tokenLabel: bucket.tokenType || COPY.bucketTokenUnknown, bucket }))
    }
  }
  return Object.freeze(bars)
}

export function allowanceBucketNotes(reading) {
  if (!reading) return Object.freeze([])
  const notes = reading.status === 'partial' ? [COPY.bucketPartial] : reading.status === 'unknown' ? [COPY.bucketUnknown] : []
  for (const issue of reading.issues) {
    const text = issue.code === 'invalid_reading' || issue.code === 'invalid_buckets' ? COPY.bucketInvalid
      : issue.code === 'bucket_limit_exceeded' ? COPY.bucketLimit : COPY.bucketInvalidEntry
    if (!notes.includes(text)) notes.push(text)
  }
  if (reading.issues.some(issue => issue.code === 'invalid_reading' || issue.code === 'invalid_buckets')) {
    return Object.freeze(notes.filter(text => text !== COPY.bucketUnknown))
  }
  return Object.freeze(notes)
}

export function allowanceBucketIssueNotes(bucket) {
  const textFor = { invalid_modelId: COPY.bucketInvalidScope, invalid_tokenType: COPY.bucketInvalidScope,
    invalid_remainingFraction: COPY.bucketInvalidFraction, invalid_remainingAmount: COPY.bucketInvalidAmount,
    invalid_resetsAt: COPY.bucketInvalidReset, duplicate_bucket: COPY.bucketDuplicate, conflicting_buckets: COPY.bucketConflict }
  return Object.freeze([...new Set(bucket.issues.map(issue => textFor[issue]).filter(Boolean))])
}

export function allowanceBucketPercent(fraction) {
  const percent = fraction * 100
  if (percent > 0 && percent < 0.1) return '<0.1'
  if (percent < 100 && percent > 99.9) return '>99.9'
  return String(Math.round(percent * 10) / 10)
}

/* WHEN IT COMES BACK, IN WORDS RATHER THAN AS A TIMESTAMP. An ISO string is an
   accurate answer to a question nobody asked; "in about 3 hours" is what a
   person is actually deciding on. A time that cannot be parsed returns the
   empty string so the caller drops the clause rather than printing "Invalid
   Date" -- and a reset already in the past says so, because that is a real and
   readable state (the window has turned over and nothing has re-read it). The
   last thirty seconds say "under a minute" rather than rounding to "0 min",
   which is a number that reads as never. */
export function resetPhrase(resetsAt, { now = Date.now() } = {}) {
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return ''
  const ms = at - now
  if (ms <= 0) return 'due to reset'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'resets in under a minute'
  if (minutes < 60) return `resets in ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `resets in ${hours}h`
  return `resets in ${Math.round(hours / 24)} days`
}

/** The one line under an account's name in the list. */
export function accountSentence(account, { now = Date.now() } = {}) {
  if (!account.measured) return COPY.usageUnknown
  /* THE SAME LIST THE BARS DRAW, so the line and the pictures above it cannot
     name a different set of ceilings. An unread window is left out of the
     sentence (the bar beside it already says "not known" in its own words). */
  return accountBars(account, { now })
    .filter(bar => bar.window)
    .map(bar => bar.sentence)
    .join(' · ')
}

/* ---- THE BRIDGE, AND WHAT IT MAY NOT DO ----
 *
 * Nothing on this bridge carries a credential, and nothing here ever will.
 * accountSignIn() asks the shell to OPEN the provider's own sign-in window,
 * aimed at the account's folder; what the person types there goes to that
 * program and never passes through this window. accountAddManaged() asks the
 * shell to make a folder of its own choosing for a new account, so a person
 * adding one is never asked for a path. Everything below moves NAMES,
 * PROVIDERS, STATUSES, PERCENTAGES and -- since the row began saying which
 * account it is signed in as -- the ADDRESS each program reports for its own
 * sign-in.
 *
 * THAT ADDRESS IS AN IDENTITY AND NOT A CREDENTIAL, and the difference is the
 * whole of why it may cross. It is what the program answers when asked who it
 * is; it opens nothing, and no read anywhere in this path touches a sign-in
 * file. It reaches this window over mc-accounts:usage, which the shell refuses
 * for any sender but the application's own main frame, so it is on the owner's
 * screen and nowhere else -- an agent gains nothing it could not already ask
 * for. Nothing here asks a person to TYPE an address, which is the separate
 * promise the product account surface makes and keeps.
 *
 * Every wrapper answers a record and never throws, and a refusal record from
 * the shell -- { ok: false, code, reason } -- keeps its own sentence, so the
 * status line can say WHY (no accounts yet; the list could not be read; that
 * name is unknown) rather than one generic "nothing changed" for every cause.
 */
export function accountsBridge(scope = globalThis) {
  const bridge = scope && scope.mcProviders
  if (!bridge || typeof bridge.accounts !== 'function') return null
  return bridge
}

function refusalOf(value, fallback) {
  const reason = isPlainObject(value) ? boundedText(value.reason, 400) : null
  const code = isPlainObject(value) ? boundedText(value.code, 80) : null
  return Object.freeze({ ok: false, code, reason: reason || fallback })
}

/** Ask for the list. Never throws; a rejected invoke reads as unavailable. */
export async function loadAccounts(scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge) return readAccountList(null)
  try { return readAccountList(await bridge.accounts()) } catch { return readAccountList(null) }
}

// This is the same file-presence read used by the Settings section This
// computer. It launches no
// provider and never treats an unreadable or older bridge as a missing program.
/* THE KEY A CONTROL IS GATED BY, and it is a pair rather than a name.
 *
 * A Gemini agent runs under one of two clients, and each is a different
 * executable on this computer. A control declared data-provider="gemini"
 * data-client="antigravity" must be gated by `agy`, and the plain one by
 * `gemini`. Keying the map on the provider alone is what let one word decide
 * both, so the key carries the client whenever there is one. A control with no
 * client keeps exactly the key it has always had, so every existing reader is
 * unchanged. */
export function programKey(provider, client = null) {
  return client ? `${provider}:${client}` : String(provider)
}

export async function loadProviderPrograms(scope = globalThis) {
  const bridge = accountsBridge(scope)
  let answer = null
  try {
    if (typeof bridge?.presence === 'function') answer = await withDeadline(bridge.presence(), 10_000)
  } catch { /* Unknown remains usable; the shell checks again before adding. */ }
  const providers = answer?.ok === true && Array.isArray(answer.providers) ? answer.providers : []
  /* An older shell answers no client axis at all. That is read as "nothing was
     said", which becomes 'unknown', which withdraws nothing -- the same rule
     the provider half already follows, and the reason a payload cut before the
     axis existed keeps drawing exactly the buttons it draws today. */
  const clients = answer?.ok === true && Array.isArray(answer.clients) ? answer.clients : []
  const word = value => (value === 'yes' || value === 'no' ? value : 'unknown')
  return Object.freeze({
    ...Object.fromEntries(PROVIDER_IDS.map(id =>
      [programKey(id), word(providers.find(provider => provider?.id === id)?.installed)])),
    ...Object.fromEntries(clients
      .filter(row => row && typeof row.provider === 'string' && typeof row.client === 'string')
      .map(row => [programKey(row.provider, row.client), word(row.installed)])),
  })
}

/** Ask how much is left. Never throws; a failure reads as "not known". */
export async function loadUsage(scope = globalThis, { previousUsage = null } = {}) {
  const bridge = accountsBridge(scope)
  let answer = readUsageReply(null)
  if (bridge && typeof bridge.accountUsage === 'function') {
    try {
      answer = readUsageReply(await bridge.accountUsage())
      if (answer.ok) for (const reading of Object.values(answer.readings)) {
        if (['absent', 'unsupported'].includes(reading.authGeneration?.kind) || unverifiedUsage(reading)) explicitUsageReadings.add(reading)
      }
    } catch { /* The prior file-bound check keeps its original age. */ }
  }
  if (!isPlainObject(previousUsage?.readings)) return answer
  if (answer.ok) {
    const readings = Object.fromEntries(Object.entries(answer.readings).map(([key, current]) => {
      const previous = previousUsage.readings[key]
      const sameIdentity = readAllowanceBinding(current.allowanceBinding)
        && current.allowanceBinding === previous?.allowanceBinding
        && sameFileGeneration(current.authGeneration, previous?.authGeneration)
        && (!current.email || !previous.email || current.email.toLowerCase() === previous.email.toLowerCase())
      if (current.usageStatus !== 'unavailable' || current.allowanceBuckets || hasUsageMeasurements(current) || !sameIdentity
        || !['healthy', 'exhausted'].includes(current.status) || !hasUsageMeasurements(previous)) return [key, current]
      // Retain measurement data only. Current authentication, identity and the
      // failed check remain authoritative; the old reading keeps its own age.
      return [key, Object.freeze({ ...current, windows: previous.windows, reportedUsage: previous.reportedUsage,
        allowanceBuckets: previous.allowanceBuckets,
        usedPercent: previous.usedPercent, resetsAt: previous.resetsAt, readAt: previous.readAt,
        usageSource: previous.usageSource })]
    }))
    return Object.freeze({ ...answer, readings: Object.freeze(readings) })
  }
  revokeExplicitUsage(previousUsage)
  return Object.freeze({ ...answer, readings: Object.freeze(Object.fromEntries(Object.entries(previousUsage.readings)
    .filter(([, reading]) => readAuthGeneration(reading.authGeneration)?.kind === 'file'))),
    readAt: previousUsage.readAt || null })
}

/** Record how this computer picks between accounts. */
export async function saveSelectionMode(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountPolicy !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountPolicy(request)
    if (!isPlainObject(answer) || answer.ok !== true) return refusalOf(answer, COPY.modeRefused)
    return Object.freeze({ ok: true, code: null, reason: null })
  } catch (error) {
    return refusalOf(error, COPY.modeRefused)
  }
}

/** Give a listed account a new name. The folder and its sign-in stay. */
export async function renameAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountRename !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountRename(request)
    if (!isPlainObject(answer) || answer.ok !== true) return refusalOf(answer, COPY.renameRefused)
    return Object.freeze({ ok: true, renamed: answer.renamed === true, name: boundedText(answer.name, 64), reason: null })
  } catch (error) {
    return refusalOf(error, COPY.renameRefused)
  }
}

/** Take a listed account off the list. The folder and its sign-in stay. */
export async function removeAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountRemove !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountRemove(request)
    if (!isPlainObject(answer) || answer.ok !== true) return refusalOf(answer, COPY.removeRefused)
    return Object.freeze({ ok: true, removed: answer.removed === true, reason: null })
  } catch (error) {
    return refusalOf(error, COPY.removeRefused)
  }
}

/** Point the next run at one of the listed accounts. */
export async function switchAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountSwitch !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountSwitch(request)
    if (!isPlainObject(answer) || answer.ok !== true) return refusalOf(answer, COPY.switchRefused)
    /* `ok` means nothing went wrong; `switched` means it HAPPENED. The two are
       different answers and the sentence a person reads differs with them --
       src/reply-outcome.js records the same distinction for removals, where
       collapsing them once told somebody an account was gone that never was. */
    const active = isPlainObject(answer.active) ? answer.active : null
    return Object.freeze({
      ok: true,
      code: null,
      switched: answer.switched === true,
      active: active && PROVIDER_IDS.includes(active.provider) && boundedText(active.name, 64)
        ? Object.freeze({ name: boundedText(active.name, 64), provider: active.provider })
        : null,
      reason: null,
    })
  } catch (error) {
    return refusalOf(error, COPY.switchRefused)
  }
}

/**
 * Put a new account on the list in a folder the shell chooses. Signs nothing
 * in; the shell answers the name it settled on (the person's, or one it made
 * up when the box was empty), and that name is what the sign-in is opened for.
 */
export async function addRegisteredAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountAdd !== 'function') return refusalOf(null, COPY.unavailable)
  try {
    const answer = await bridge.accountAdd(request)
    if (answer?.ok !== true) return refusalOf(answer, COPY.addRefused)
    /* A setup answer that waited for the first account is applied now (T1582). */
    await applyDeferredAccountPolicy(scope).catch(() => null)
    return { ok: true, name: request.name, provider: request.provider, client: request.client || null }
  } catch (error) { return refusalOf(error, COPY.addRefused) }
}

export async function addManagedAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountAddManaged !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountAddManaged(request)
    if (!isPlainObject(answer) || answer.ok !== true) return refusalOf(answer, COPY.addRefused)
    const name = boundedText(answer.name, 64) || (isPlainObject(request) ? boundedText(request.name, 64) : null)
    const provider = PROVIDER_IDS.includes(answer.provider)
      ? answer.provider
      : (isPlainObject(request) && PROVIDER_IDS.includes(request.provider) ? request.provider : null)
    if (!name || !provider) return refusalOf(null, COPY.addRefused)
    /* A setup answer that waited for the first account is applied now (T1582). */
    await applyDeferredAccountPolicy(scope).catch(() => null)
    return Object.freeze({ ok: true, code: null, name, provider, reason: null })
  } catch (error) {
    return refusalOf(error, COPY.addRefused)
  }
}

/* The shell's code for "that program is not installed". Its sentence is worded
   for Settings, under "This computer", where an Install button stands; here it
   is answered in this menu's words (COPY.notInstalled) and the code is kept. */
export const NOT_INSTALLED_CODE = 'PROVIDER_LOGIN_NOT_INSTALLED'

/** Open the program's own sign-in window for one listed account. */
export async function signInAccount(request, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.accountSignIn !== 'function') {
    return refusalOf(null, COPY.unavailable)
  }
  try {
    const answer = await bridge.accountSignIn(request)
    if (!isPlainObject(answer) || answer.ok !== true) {
      const refusal = refusalOf(answer, COPY.signInRefused)
      if (refusal.code !== NOT_INSTALLED_CODE) return refusal
      const provider = isPlainObject(request) ? request.provider : null
      const program = PROVIDER_IDS.includes(provider) ? providerLabel(provider) : COPY.programUnnamed
      return Object.freeze({ ok: false, code: refusal.code, reason: COPY.notInstalled(program) })
    }
    /* THE WINDOW'S OWN NAME, when the shell said one. It is bounded like every
       other string that crosses, and absent rather than invented when an older
       copy on the computer being driven does not answer it -- COPY.signInOpened
       has a sentence for each case, because "no title" and "a window with no
       name" are different answers. */
    return Object.freeze({ ok: true, code: null, title: boundedText(answer.title, 120), reason: null })
  } catch (error) {
    return refusalOf(error, COPY.signInRefused)
  }
}

/* THE ANSWER THAT ARRIVES WITHOUT A PRESS, AND THE ONLY ONE THAT DOES.
 *
 * A Sign in press arms a watch in the shell on THAT ONE account's folder
 * (shell/account-registry.cjs watchSignIn). When its sign-in file changes, the
 * shell pushes that one account's fresh answer here. It is the same three
 * words the list answers with, so a row painted from this packet and a row
 * painted from a fresh list cannot disagree.
 *
 * IT IS NOT A SUBSCRIPTION TO ANYTHING ELSE. Nothing arrives until somebody
 * presses Sign in, nothing arrives for an account nobody pressed, and the
 * packet carries a name, a program and a word -- never a folder, never a byte.
 * The menu's rule that opening it starts no program is untouched: this starts
 * none either, at any point.
 *
 * A PACKET THIS BUILD CANNOT READ IS NOT TAKEN. It is a hint to look again,
 * never the source of truth -- the list read the menu does next is the answer
 * -- so an unrecognised one is dropped rather than turned into a row state
 * nobody can stand behind. */
export function readSignInChange(value) {
  if (!isPlainObject(value)) return null
  const name = boundedText(value.name, 64)
  const provider = PROVIDER_IDS.includes(value.provider) ? value.provider : null
  if (!name || !provider) return null
  return Object.freeze({
    name,
    provider,
    /* Three-valued for the same reason readAccountList() is: a word this build
       does not know must not draw as "not signed in". */
    signedIn: value.signedIn === 'yes' ? true : value.signedIn === 'no' ? false : null,
  })
}

/**
 * Listen for that one account's sign-in changing. Answers an unsubscribe, or
 * null when the copy on the computer being driven has no such push -- in which
 * case the menu behaves exactly as it did before: Check allowances is the
 * fresh signal, and nothing is broken by its absence.
 */
export function onSignInChanged(listener, scope = globalThis) {
  const bridge = accountsBridge(scope)
  if (!bridge || typeof bridge.onAccountSignInChanged !== 'function' || typeof listener !== 'function') return null
  try {
    const detach = bridge.onAccountSignInChanged(packet => {
      const change = readSignInChange(packet)
      if (change) listener(change)
    })
    return typeof detach === 'function' ? detach : null
  } catch {
    return null
  }
}
