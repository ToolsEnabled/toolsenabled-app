/* THE WORDS FOR "YOU HAVE MORE THAN ONE ACCOUNT", AND THE WARNING THAT SHIPS
 * BESIDE THE CLAUDE ONE.
 *
 * WHY THE COPY IS HERE AND NOT IN THE VIEW. src/views/guide.js is a renderer;
 * every sentence it draws already comes from src/first-run-needs.js, for the
 * reason that file's own header gives -- copy inside a render function can only
 * be checked by reading the render function. The plain-language gate
 * (tools/check-plain-language.mjs) and the suites walk VALUES, so a sentence
 * written inline is a sentence nothing measures.
 *
 * WHAT THE PANEL IS FOR. A person can hold two accounts with the same program:
 * a school one and a personal one is the ordinary case. Each keeps its sign-in
 * in a folder of its own. Until this panel there was no way to see that list or
 * add to it from inside the product -- the only route was hand-writing a file
 * in a directory a customer has no reason to know exists.
 *
 * NOTHING HERE ASKS FOR A SIGN-IN. The panel shows the COMMAND a person runs
 * themselves, in their own terminal, which is the one arrangement where this
 * product never touches a credential. There is deliberately no field for a key
 * and no button that signs anybody in.
 */

import { terminalName } from './terminal-name.js'

export const ACCOUNT_PANEL = Object.freeze({
  /* THE PROGRAM'S NAME IS IN THE HEADING, and that is not decoration. On the
     rendered guide the word "account" appeared thirteen times and every one of
     them meant a Codex or Claude sign-in folder -- read by somebody who had
     arrived looking for the ToolsEnabled account they had just paid for. A
     heading reading "Accounts you have added", under a program's name but
     above a form, is exactly the shape that confusion takes. */
  heading: (program) => `${program} accounts you have added`,

  /* The whole idea in two short sentences. "One account, one folder" is the
     rule the engine actually enforces, said as a person would say it. */
  help: 'One account, one folder. Each folder keeps its own sign-in, so two accounts never write over each other.',

  /* THE EMPTY STATE IS NOT A FAILURE AND MUST NOT READ AS ONE. Almost everybody
     has exactly one sign-in, and that is a working setup, not a missing step.
     So this says what IS true first, and offers the addition second. */
  none: 'Nothing is listed here, so this copy uses the one sign-in already on this computer. Add a name and a folder below to keep a second account.',

  /* Absence and damage are different, and only one of them means a list is
     still there. This is the second. */
  unreadable: 'This copy could not read its list of accounts, so none are shown. Nothing has been lost; open this page again to retry.',

  inUse: 'In use now',
  activeNote: 'The mark shows the account the computer you are driving switched to last.',

  signedIn: 'Signed in',
  notSignedIn: 'No sign-in in that folder yet',

  /* The terminal noun comes from src/terminal-name.js because
     src/refusal-copy.js keys this sentence's remote twin on the same words.
     See that module's header. */
  commandLead: `To sign this folder in, paste this line into ${terminalName()}:`,
  commandNote: 'Nothing here runs that line, and nothing here reads what it writes.',

  namePlaceholder: 'Name this account…',
  folderPlaceholder: 'Folder that holds its sign-in…',
  nameLabel: 'Name for this account',
  folderLabel: 'Folder that holds its sign-in',
  add: (program) => `Add a ${program} account`,
  remove: 'Remove',

  /* THE SAME BUTTON ON EVERY ROW, AND WHY EACH ONE SAYS WHICH ACCOUNT.
     A screen reader announces a button by its own name, not by the row it
     sits in, so a panel that exists precisely because there is more than one
     account gave every button the one word "Remove" and left no way to tell
     them apart but counting. Miscounting takes the wrong account off the
     list, which is the exact belief removeScope below is written to protect.
     The visible word is unchanged -- the row already names the account and a
     longer button would crowd the list. This is the accessible name only, and
     it LEADS with the visible word so that somebody saying "click Remove" to
     a voice driver still matches it. */
  removeAccount: (name) => `Remove ${name}`,
  
  /* WHAT REMOVE DOES, AND WHAT IT DELIBERATELY DOES NOT.
     shell/account-registry.cjs remove() edits this list and nothing else. The
     folder and the provider sign-in inside it are untouched -- on purpose:
     engine/src/lib/multi-account holds that a person's provider home is theirs,
     "their file, their terminal, their business", and deleting somebody's paid
     sign-in is not this product's to do.
     The button said only "Remove", so the account vanished from the list and a
     person could reasonably believe the sign-in went with it. Somebody handing a
     laptop on is exactly who presses this. Saying the scope is the fix; deleting
     their credential is not. */
  removeScope: 'Remove takes the account off this list. The folder it names, and the sign-in inside it, stay on this computer — sign out in that program if you want the sign-in gone too.',
  removeDidNothing: 'That account was not on the list, so nothing was removed. The folder and its sign-in are untouched.',

  needBoth: 'Type a name and a folder, then press the button again.',
  refused: 'That account was not added. Pick a different name or folder, then press the button again.',
  removeRefused: 'That account is still listed. Press Remove again.',
  unavailable: 'The copy installed on the computer you are driving cannot change assistant accounts. Update the app on that computer, then try again.',
})

/* The guide is painted both at the desk and through the relay. Keep the desk
   vocabulary above canonical, and declare its remote twin beside it so the
   painter chooses a subject instead of performing a blanket word swap. */
const ACCOUNT_PANEL_REMOTE = Object.freeze({
  ...ACCOUNT_PANEL,
  none: [
    'Nothing ',
    'is listed on the computer you are driving, so that copy uses ',
    'the one sign-in already there. Add a name and a folder below to keep a second account.',
  ].join(''),
})

export function accountPanelCopy({ viaRelay = false } = {}) {
  return viaRelay ? ACCOUNT_PANEL_REMOTE : ACCOUNT_PANEL
}

/* THE WORDS AROUND THE TWO BUTTONS EVERY ASSISTANT PROGRAM GETS.
 *
 * WHY THERE ARE BUTTONS. The first external user of 1.0.20 followed the
 * guide's commands by hand and got stuck exactly where the owner predicted:
 * the window their install ran in could not see the new program and called
 * "codex login" not a command. So there are no commands to copy any more.
 * Install happens for the person. Sign in opens a fresh window with the
 * program's own sign-in already running in it -- fresh, because a window
 * opened after an install can always see what the install just put there.
 *
 * THE SAME TWO SENTENCES FOR ALL THREE PROGRAMS. Codex, Claude and Gemini each
 * get Install and Sign in, worded identically, with the program's own name
 * dropped in. A program singled out in this copy would read as a program that
 * works differently here, and none of them does.
 *
 * WHAT THE WORDS MUST HOLD. The buttons run the OFFICIAL install and the
 * program's OWN sign-in and nothing else; the sentences must never suggest
 * this product collects, sees, or keeps a sign-in, because it structurally
 * cannot -- the installer's input is closed, its files are never read, and the
 * sign-in happens in a window this product does not listen to. */
export const PROVIDER_SIGN_IN = Object.freeze({
  button: (program) => `Sign in to ${program}`,
  stopButton: 'Stop',
  lead: (program) => `One press opens a terminal window with ${program}'s own sign-in already running in it. You finish it there, and nothing here sees your password or your key.`,
  /* Absence names the fix that is already on screen -- the Install button sits
     right beside this one. */
  absent: (program) => `${program} is not on this computer yet. Press Install, and then Sign in.`,
  unsure: (program) => `This copy could not tell whether ${program} is on the computer you are driving. Both buttons still work; press the one you need.`,
  /* Presence already says "Installed here, and signed in." right above; this
     is the button's own answer to "then what does pressing it do?" */
  alreadyIn: 'You are signed in already. Pressing this opens a window and runs the sign-in again, which is how accounts are switched.',
  /* The one sentence a press leaves behind. It says what to look for, because
     the window can open behind this one. */
  opened: (program) => `A terminal window opened and is running ${program}'s sign-in. Finish it there, then close that window.`,
  refused: 'That could not be started. Press the button again in a moment.',
  signInUnavailable: 'Sign in is unavailable because the copy installed on the computer you are driving has no sign-in action. Update ToolsEnabled on that computer, then try again.',
  installUnavailable: 'Install is unavailable because the copy installed on the computer you are driving has no install action. Update ToolsEnabled on that computer, then try again.',
  stopUnavailable: 'Stop is unavailable because the copy installed on the computer you are driving has no stop action. Update ToolsEnabled on that computer before starting an install.',

  /* THE INSTALL HALF, added with the owner's one-click ruling. The programs
     are not bundled -- Claude Code's licence grants no redistribution, and the
     legal record REQ-engine-bundle-provider-clis.md settles the others the same
     way for now -- so the button runs the official package install and this
     computer fetches the program from its maker's own channel. The sentences
     must say that plainly: the download is the provider's, not ours. */
  installButton: (program) => `Install ${program}`,
  /* NO SECOND COPY (rc-0922). A program that is already here is used, not
     installed again; a private copy is the person's explicit choice and goes
     into ToolsEnabled's own folder. */
  usesYours: (program) => `${program} is already on this computer, and ToolsEnabled uses it. There is nothing to install.`,
  privateButton: 'Use a private copy',
  privateLead: (program) => `A private copy of ${program} goes into ToolsEnabled's own folder. The copy you have stays as it is.`,
  copyWho: Object.freeze({
    toolsenabled: 'installed by ToolsEnabled in its own folder',
    native: "installed by its maker's own installer",
    standalone: "installed by its maker's own installer",
    'npm-global': 'installed with npm',
    unknown: 'installed on this computer',
  }),
  copyLine: ({ version, who, copies }) => `${version ? `Version ${version}, ${who}` : `${who.charAt(0).toUpperCase()}${who.slice(1)}`}.${copies > 1 ? ` ${copies} copies are on this computer; ToolsEnabled uses this one.` : ''}`,
  copyUpdate: (command) => `To update it, run ${command} in a terminal.`,
  installLead: (program) => `One press downloads ${program} from its maker's own channel and installs it for you. ToolsEnabled does not ship it or change it.`,
  installRunning: 'The installer is running. What it prints appears below, and it can take a few minutes.',
  installStopping: 'The installer is stopping. Wait for its processes to finish before starting another install.',
  installCleanupUnconfirmed: 'The installer could not confirm that all its processes stopped. Press Stop to retry. Another install stays unavailable until cleanup is confirmed.',
  installBusy: 'An installer is already running for this program.',
  installDone: 'The installer finished. The program’s current status appears above.',
  installDoneFail: 'The install stopped without finishing. Its own words are above; press the button to try again.',
  installStopped: 'The install was stopped. Press the button to start it again.',
  installTimeoutLead: 'The install reached its time limit.',
  installTimedOut: 'The install reached its time limit before finishing. Check your connection, then press Install to try again.',
})

/* `absent` composes the program name into its sentence, so an exact-match
   remedy cannot see the desk phrase inside the finished composite. Its remote
   twin has the same function-shaped slot and is selected before composition. */
const PROVIDER_SIGN_IN_REMOTE = Object.freeze({
  ...PROVIDER_SIGN_IN,
  absent: (program) => `${program} is not on the computer you are driving yet. Press Install, and then Sign in.`,
})

export function providerSignInCopy({ viaRelay = false } = {}) {
  return viaRelay ? PROVIDER_SIGN_IN_REMOTE : PROVIDER_SIGN_IN
}

/* THE FOUR THINGS A PERSON IS OWED BEFORE THEY RUN CLAUDE FROM HERE.
 *
 * These four, in this order, are the whole instrument. The legal position
 * dropped every cap and every restriction on the Claude path -- the user decides
 * -- and this warning is what makes that a real choice rather than a shrug. So
 * each point is a finding a person can act on, and not one of them is
 * boilerplate:
 *
 *   1. it is THEIR account that carries the consequence, said first
 *   2. the provider can change it without telling anybody
 *   3. how much you run is what gets noticed, not what you ran it from
 *   4. the one correlation that is concrete enough to avoid
 *
 * THE FOURTH SENTENCE OF `today` IS WHERE THIS BUILD DIFFERS FROM THE ADVICE IT
 * FOLLOWS. The position says to name key-based sign-in as the alternative in the
 * same breath. This build does not carry it -- the transport is approved and
 * unwritten -- and a screen that offered a door with nothing behind it would be
 * a worse failure than the one the warning exists to prevent. So the alternative
 * named here is the one that is real today: do the work by hand, outside this
 * window.
 */
export const CLAUDE_ACCOUNT_RISK = Object.freeze({
  heading: 'Before you run Claude from here',
  points: Object.freeze([
    'If Anthropic acts on this, it acts on your own account, not on ours. That is why the choice is yours to make.',
    'Anthropic can change this or shut it off at any time, and it does not have to tell you first.',
    'How much you run is the signal, not which program you run it from. Heavy or unattended use is what draws attention.',
    'One pattern is worth naming: changing your plan while heavy automation is running. Most reported blocks followed a payment or a plan change.',
  ]),
  today: 'This copy starts Claude on your own sign-in and offers no other way in. If you would rather not take that risk, run Claude by hand outside this window.',
})
