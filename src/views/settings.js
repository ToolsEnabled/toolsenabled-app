import { createSavedDataMaintenanceSettings } from '../saved-data-maintenance-controls.js'
import { THEME_CHOICES, currentTheme } from '../theme-choice.js'
import {
  HOME_CIRCLE_STYLES, DEFAULT_HOME_CIRCLE_STYLE, currentHomeCircleStyle, setHomeCircleStyle,
  HOME_CIRCLE_MOTIONS, DEFAULT_HOME_CIRCLE_MOTION, currentHomeCircleMotion, setHomeCircleMotion,
} from '../home-circle-choice.js'
import { HOME_STATUS_COLOR_SETTINGS, currentHomeStatusColor, resolvedHomeStatusColor, setHomeStatusColor } from '../home-status-colors.js'
import '../home-status-colors.css'
// /settings — progressively disclosed preferences plus the first-run system
// register. Appearance can fail soft; fleet configuration is correctness data
// and uses the durable profile store instead of the cosmetic setting idiom.
//
// TWELVE CATEGORIES, ONE ON SCREEN. The list down the left is navigation: each
// category has its own address (`#/settings?category=<slug>`) and the page
// draws that one and nothing else. It was a table of contents over a single
// document until 2026-08-26 -- twelve sections rendered at once, a press
// scrolled, and a scroll-spy took the highlight back off whatever was nearest
// the top. See requestedCategory() below for what the address decides.

import { el, attachSeg, controlState } from '../components.js'
import { SETTINGS_MODES, createSettingsMode, readSettingsMode, settingMode, settingsModePanel } from '../settings-mode.js'
import { revealHorizontalSelection } from '../horizontal-selection.js'
import { createCloudMirrorSetup } from '../cloud-mirror-setup.js'
/* The split compare window. Same shape as the mirror dialog above: a
   person-initiated form that mounts its own host node and takes it down again,
   rather than a second half-shaped modal system. */
import { createCompareFilesDoor } from '../diff-editor.js'
import { rangeFill } from './computers.js'
import { syncNumericRange } from '../settings-numeric.js'
import { QUICK_SETTING_EVENT } from '../quick-settings.js'
/* One writer for the text size — the body zoom AND the --zoom property every
   window-bounding length in the sheets divides by. See src/text-size.js. */
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_KEY,
  applyTextSize,
  normalizeTextSize,
  textZoom,
} from '../text-size.js'
import {
  FONT_CHOICES,
  FONT_STORAGE_KEY,
  applyFontChoice,
  currentFontChoice,
  fontStack,
  fontOptionMarkup,
  normalizeFontId,
} from '../font-choice.js'
/* ONE AXIS WHERE SEVEN SWITCHES WERE. The per-view `mc.live.<view>` flags were
   Phase-2 rollback machinery -- seven independent ways for a screen to disagree
   with its neighbour about what world it was in. src/data-source.js replaced
   them with one question ("where does the data on every screen come from") and
   one preference: the example toggle. This page's Data & Sim row is that
   toggle's control; data-source.js is its registry and its enforcement. */
import { DATA_SOURCE_EVENT, announceDataSourceChange, currentDataSource, isExampleMode, previewWithoutHost, resolveDataSource, setExampleMode } from '../data-source.js'
import { notificationDelivery } from '../notification-delivery.js'
import { readerRemedy } from '../refusal-copy.js'
import { WRITE_ACTION_FLAGS, isWriteEnabled, setWriteEnabled } from '../write-flags.js'
/* THE TWO ROWS ON THIS PAGE THAT HAD NOWHERE TO BE WRITTEN DOWN. Glow and
   reduce motion were read back off the DOM alone, so both were thrown away
   when the window closed -- measured on the shipped 1.0.20 installer, where 98
   of the other 100 rows survived the same restart. The module writes them
   under this page's own `mc.set.<id>` keys and puts them back at launch, and
   the drawer's copy of the same two controls writes through it as well. */
import {
  GLOW_SETTING_ID,
  REDUCE_MOTION_SETTING_ID,
  applyAppearance,
  rememberAppearance,
} from '../appearance-persistence.js'
import { createLedgerArchiveController, postBridgeAction } from '../mission-bridge.js'
/* WHAT EVERY ROW GRANTS AND WHAT IT RISKS, stated separately (owner, R1529).
   The statements are data in src/permission-guidance.js and the markup is
   src/guided-step.js, so this page asks for a row's explanation rather than
   carrying ninety of them itself. A row the declarations do not cover is drawn
   saying so, which is why nothing here needs a fallback sentence. */
import { guidanceMarkup } from '../guided-step.js'
import { describeSubject } from '../permission-guidance.js'
import { CAPABILITY_PROBE_EVENT, probe, refreshCapabilityProbes } from '../capability-probes.js'
import { createFleetProfileSettings } from '../fleet-profile-settings.js'
/* The first-run walkthrough's settings. They are a SECTION here rather than a
   screen of their own because the owner's requirement has two halves: the
   walkthrough may infer, and every inferred setting must stay visible and
   editable afterwards. A profile only the walkthrough could edit would satisfy
   the first half and fail the second. */
import { createSetupProfileSettings } from '../setup-profile-settings.js'
import { createWorkingProfileSettings } from '../settings-profile-settings.js'
import { createQuickSliders } from '../settings-quick-sliders.js'
import '../settings-profile-settings.css'
import { createRoleColorSettings } from '../role-color-settings.js'
import { createHandControlSettings } from '../hand-control-settings.js'
import { createScreenControlSettings } from '../screen-control-settings.js'
/* The first section on this page, and first because the box it governs is the
   first thing in the product: which agents' context appears in the chat box on
   the home screen, and whether agent runs appear there too, not at all, or on
   their own. */
import {
  CHATBOX_SECTION,
  createChatboxSettings,
} from '../chatbox-settings.js'
/* THE SETTINGS THE INSTALLED APPLICATION ENFORCES, and the reason this is a
   section module rather than five more entries in SETTINGS below.
   Every row in SETTINGS is a preference of this window, stored by this window.
   These are stored beside the program and read by another process -- so they
   are asked for and written through the installed application, and their value,
   their wording and whether anything enforces them all come back from it rather
   than from this file. Which is also why they are the rows that never went
   dead: their enforcer is named in the register and does the reading. */
import {
  RESEARCH_SECTION,
  LOCAL_MODELS_SECTION,
  PRODUCT_SETTING_IDS,
  sectionOfRow,
  createResearchSettings,
  endpointAddress,
  UNUSABLE_ENDPOINT,
} from '../research-settings.js'
/* THE MISSING HALF OF SIGNING UP, AND WHY IT IS ON THIS PAGE AT ALL.
 *
 * "as a user I dont even see how after signing up that I now connect my
 * computer." The website's account page asks for a code beginning TC-; nothing
 * in this application had ever shown one. Every other piece existed -- the
 * account service, the box on the website, the client inside the installed
 * application -- and there was no screen where a person met their code.
 *
 * IT IS HERE RATHER THAN ON THE THREE SCREENS THAT LOOK LIKELIER. The home
 * screen's fact list is capped at three and enforced at that cap
 * (tools/test/home-screen.test.mjs), so it can only point. `#/account` says in
 * its own copy that the account it means is on this computer and that nothing
 * is sent anywhere, which a hosted claim with an emailed second factor would
 * contradict on the same screen. The fleet page is the wrong altitude for a
 * setup step somebody does once. Settings' 'Start here' group already means
 * "the first page, what setup recorded, and this computer", and it is the group
 * that opens for somebody arriving with no remembered posture -- so this
 * section is on screen on a first visit, which is when it is needed. */
import {
  CONNECT_SECTION,
  CONNECT_SETTING_ID,
  createConnectComputerSettings,
} from '../connect-computer-settings.js'
/* The update-check policy row, drawn under System. It is a section controller
   for the reason the connect section is one: its key is read by the installed
   application at launch, not by this page, and it lives outside `mc.set.` so
   it stays on the computer it describes. See src/update-settings.js. */
import { createUpdateSettings } from '../update-settings.js'
import { createResourceSettings } from '../resource-settings.js'
import { ENTERPRISE_SECTION, enterpriseMatches, enterpriseSearchMarkup } from '../enterprise-settings.js'
/* WHY A SECTION ON THIS PAGE NEEDS A SENTENCE ABOVE ITS SWITCHES.
 *
 * LEGACY-ONB-001, re-measured on a sterile profile: a person whose fleet graph
 * and comms board both say "No local agent fleet host detected on this machine"
 * comes here looking for the switch that fixes it. Under Data and Sim they find
 * six toggles reading "<screen> live data", every one of them already ON, and
 * nothing anywhere on the page telling them that turning them on was never the
 * problem. There is no switch for the thing they are looking for, and the most
 * useful thing this page can do is say so and point at the page that explains it
 * -- otherwise the search ends in them flipping live sources off and concluding
 * the product is fake data. */
import {
  FIRST_RUN_NEEDS,
  THREAD_REPLY_SETTING_HREF,
  WORKS_HERE,
} from '../first-run-needs.js'
/* The connect screen's own address, read from the module that owns the row's
   id, so this link and that row's landing cannot drift apart. */
import { CONNECT_HREF } from '../device-claim-flow.js'
/* THE SECTION THAT REPLACED THE PAGE. src/this-computer-settings.js carries the
   live half of what used to be "What this copy needs": the four program rows
   with their presence sentence and their Install / Sign in buttons, the Codex
   and Claude account lists, the local-model panel and the feedback composer.
   The two notes further down used to send a reader to that page; they now name
   the row, through the constant the module owns, so the id and the link cannot
   drift apart. */
import { createVaultCredentialsSettings } from '../vault-credentials-settings.js'
import {
  THIS_COMPUTER_HREF,
  THIS_COMPUTER_PROGRAMS_ROW,
  THIS_COMPUTER_SECTION,
  createThisComputerSettings,
} from '../this-computer-settings.js'
/* HOW THIS PAGE IS ARRANGED, NOT WHAT IT STORES. The first outside user found
   seventeen flat categories hard to read, so they nest under a handful of
   groups a person scans in one glance (four of them today, twelve sections).
   The groups, the slug each category is addressed by, the remembered
   open-state, the truth-first sentence beside a switch and the System refusal
   translation are all data and pure functions in one DOM-free module, where a
   node test can hold them still. Every row id, storage key and default is
   untouched. */
import {
  FIRST_VISIT_SECTION,
  CATEGORY_DETAILS,
  SETTINGS_GROUPS,
  categorySlug,
  groupOfSection,
  groupsOpenOnArrival,
  readOpenGroups,
  sectionFromSlug,
  writeOpenGroups,
  toggleStateSentence,
} from '../settings-presentation.js'
import { createTranscriptSettings } from '../transcript-settings.js'
import { createDiagnosticSettings } from '../diagnostic-settings.js'
import { createActionPermissionSettings } from '../action-permission-settings.js'
import { createSettingsDraft, draftSettingsBridge, settingsSaveFailureMessage } from '../settings-draft.js'
import { createSettingsConfirmation } from '../settings-confirmation.js'
import { createAuditSettings } from '../audit-settings.js'
import { createTreeContextSettings } from '../tree-context-settings.js'
import '../editor-session-attachments.css'
import { PRODUCT_SECTIONS, TOOL_SECTION, AGENT_SECTION, RULES_SECTION, matchesSettingQuery } from '../product-settings-layout.js'
import '../settings.css'
import '../chatbox-settings.css'
import '../fleet-profile-settings.css'
import '../connect-computer-settings.css'
import '../settings-coherence.css'
import '../resource-settings.css'
import { createRemoteComputerSettings } from '../remote-computer-settings.js'
import '../cloud-mirror-setup.css'
import '../diff-editor.css'
import '../setup.css'
import '../this-computer-settings.css'
import { landOnRow, visibleBoxOf } from '../settings-landing.js'

const SECTIONS = SETTINGS_GROUPS.flatMap(group => group.sections)

/* THE HAND-PLACEMENT SHIM FOR 'Connect this computer' IS GONE, and it was
 * retired by the condition it named for itself.
 *
 * It read: "The moment 'Connect this computer' appears in the 'start' group's
 * `sections` array, groupOfSection() answers for it, this branch stops firing
 * and the ordinary path renders it." That name is now in the array
 * (src/settings-presentation.js), so the branch, CONNECT_HOME_GROUP,
 * connectIsPlacedByThisPage() and homeGroupOf() are all deleted rather than
 * left to sit dead. Every rule that used to ask homeGroupOf() now asks
 * groupOfSection(), which is the one table again.
 *
 * WHAT THE SHIM COST WHILE IT LIVED, measured on a real 1002x650 window: the
 * section rendered in the right place, so nothing looked broken -- but the
 * group head prints `group.sections` while it is CLOSED, and that line is the
 * page's whole answer to "find something without opening anything". A section
 * outside the model is not in that array, so the closed 'Start here' line read
 * "Home screen · Setup · System" and never said the words the owner used:
 * "as a user I dont even see how after signing up that I now connect my
 * computer". A second placement mechanism did not move the section; it moved
 * the section out of the sentence that advertises it.
 */
/* SEVENTY-FOUR ROWS WERE REMOVED FROM THIS CATALOGUE ON 2026-08-20, and the
 * reason is the same one written under `offline_fallback` below.
 *
 * This page built 96 rows and its footer said "116 settings". Seventy-four of
 * them wrote a `mc.set.<id>` key that NOTHING in the product ever read. Six
 * whole sections were inert top to bottom. Every one of those rows moved,
 * filled, reported a percentage and survived a restart, so nothing on screen
 * distinguished them from the twenty-two that worked -- which is the actual
 * harm: a person who moves a control that does nothing stops looking for the
 * real switch, and `contrast_curve` made that promise ("make the lighter,
 * secondary text darker and easier to read") to the person least able to detect
 * that nothing had happened.
 *
 * REMOVING A DEAD ROW IS NOT REMOVING A FEATURE. There was no feature. The
 * behaviours these rows described -- chart quality, a frame cap, a Sankey gap, a
 * thread memory span, a simulation tick bias -- do not exist anywhere in this
 * tree, so "wiring them up" would mean building them.
 *
 * THE WORDING IS NOT LOST. Every removed definition is kept verbatim in
 * docs/design/UNBUILT-SETTINGS-ROWS-2026-08-20.md, with a dated header saying
 * they are unbuilt intentions, so nobody has to re-invent a reviewed sentence
 * when one of these features is actually built.
 *
 * A ROW ADDED HERE WITH NO READER NOW FAILS A TEST.
 * tools/test/settings-rows-do-something.test.mjs derives the dead set from this
 * file at run time and names every offender. There is deliberately no exemption
 * list: if a row acts through a door the test does not know about, teach it the
 * door and the line that reads it. The defect was never that somebody wrote 74
 * bad rows -- it was that nothing could tell a real control from a drawn one. */
/* THE COMPARE WINDOW READS AND WRITES FILES, so it only exists where this page
   is the installed application rather than a look at the screens in a browser.
   Disabled with the reason in the row, never hidden and never live-and-refusing:
   a window that opened with two panes nobody could fill would be the third of
   those, which is the worst one. */
const NO_HOST_COMPARE_REASON = 'This window opens files on your own computer, so it needs the installed program. This page is a look at the screens in a browser. Install ToolsEnabled and the same row opens it.'
const compareFilesBlockedReason = () => (globalThis.mcDiff ? null : NO_HOST_COMPARE_REASON)

/* WHY THE NOTIFICATION ROWS CARRY A blockedReason RATHER THAN A SPECIAL CASE.
 * Two lanes landed the same idea in one week under two names: rowDescription()
 * special-cased these two ids, and rowMessage() read a named blockedReason off
 * the row. The second is the one whose own comment says why -- so the third row
 * that needs it does not become a third special case here -- so it is the one
 * that survived the merge, and these rows joined it.
 *
 * IT IS A ONE-LINE FIELD AND IT SITS AFTER `section:` ON PURPOSE. The catalogue
 * extractor in tools/test/permission-guidance.test.mjs reads the 400 characters
 * following each `id:` and takes the row only if it finds `section:` inside that
 * window. The first version of this put nine lines of comment between the two,
 * pushed `section:` out of the window, and BOTH ROWS VANISHED FROM THE
 * CATALOGUE -- five chain tests went red and none of them said "formatting".
 * Keep the gap between id and section small. */
const notificationBlockedReason = () => {
  const delivery = notificationDelivery()
  return delivery.supported ? null : delivery.why
}

export const SETTINGS = [
  /* "THIS COMPUTER": THE FIVE ROWS THAT REPLACED A PAGE.
   *
   * The owner: "can we get rid of the what this copy needs page and put it
   * nicely into settings and make it more simple and useful". The page said
   * everything at once, in three paragraphs per subject, at an address nothing
   * else in the product was a stop on. These five rows say the same true things
   * in the place a person already goes to change what this copy does.
   *
   * THE ORDER IS THE ORDER SOMEBODY NEEDS THEM. What is installed comes first,
   * because a copy with no assistant program installed cannot start an agent at
   * all and everything else is premature. Then the ToolsEnabled account, then
   * the switch that lets a reply leave this window, then the chat commands, and
   * last the way to say this is not working.
   *
   * FOUR OF THE FIVE ARE LINKS, AND THAT IS THE POINT. Each one is a sentence
   * and a door to the control that already exists somewhere in this product.
   * The page used to describe those controls at length and leave the reader to
   * find them; a row that opens the thing it names cannot go stale the way a
   * description of it can. */
  /* ONE SENTENCE EACH, AND THE SENTENCE IS NOT A DESCRIPTION OF THE CONTROL
     BESIDE IT. The row already shows the live state and carries the door; a
     paragraph restating what the button does is the page reading itself aloud.
     What stays is only what the control cannot say for itself -- for the
     programs row, that ToolsEnabled is not the thing being signed in to. */
  { id: THIS_COMPUTER_PROGRAMS_ROW, section: THIS_COMPUTER_SECTION, name: 'Assistant programs and local models', desc: 'ToolsEnabled never asks for these sign-ins and never keeps one.', depth: 1, type: 'custom', mount: 'this-computer-programs', disclosure: false, def: null },
  { id: 'this_computer_account', section: THIS_COMPUTER_SECTION, name: 'Join this computer to your ToolsEnabled account', desc: 'A short code on the connect screen joins it, so you can reach this computer from a browser.', depth: 1, type: 'link', href: CONNECT_HREF, linkLabel: 'Open the connect screen', disclosure: false, def: null },
  { id: 'this_computer_messaging', section: THIS_COMPUTER_SECTION, name: 'Replying to a coordinator', desc: 'The box on the first page has nowhere to type until this is on.', depth: 1, type: 'link', href: THREAD_REPLY_SETTING_HREF, linkLabel: 'Open that setting', disclosure: false, def: null },
  /* `this_computer_commands` WAS A ROW HERE AND IS NOT ANY MORE (2026-09-10).
     It had no live state and no action: it described where to read about the
     chat commands. A row is one thing with a state you can see and one control
     that changes it; a row that is only a pointer teaches a person that rows
     here may do nothing. The commands themselves are named in the section note
     instead, which costs one door to the setup screen -- recorded in REPORT.md
     rather than quietly dropped. */
  /* THE DOOR IS ABSENT WHEN THE BACKEND SAYS SO, NEVER A DEAD BUTTON -- the
     owner's own rule for this one control, and the reason `absent` exists
     beside `blockedReason` rather than being folded into it. Everything else on
     this page that cannot succeed is drawn DISABLED with its reason beside it,
     which is the right answer for a switch. It is the wrong answer for a way to
     send a message: a greyed-out "Send feedback" tells somebody their report
     cannot be heard, which is worse than never offering. */
  { id: 'this_computer_feedback', section: THIS_COMPUTER_SECTION, name: 'Send feedback', desc: 'Tell us what is not working. It goes to the people who build this.', depth: 1, type: 'action', action: 'this-computer-feedback', actionLabel: 'Write a note', absent: () => thisComputerDoors.feedback !== true, mount: 'this-computer-feedback', disclosure: false, def: null },

  /* THE DEFAULT IS "ASK ME", AND THAT IS THE WHOLE POINT OF THIS ENTRY.
   *
   * Uninstalling used to keep everything and say nothing. Setting the default
   * here to "Keep my data" would leave that behaviour exactly as it is and add a
   * control nobody had to touch -- the same silent retention, now with a setting
   * page that appears to have consented on the person's behalf. The default has
   * to be the QUESTION.
   *
   * It also has to be "ask" for a mechanical reason worth stating: setValue()
   * REMOVES the stored key when the chosen value equals `def` (see the
   * localStorage.removeItem branch below), so "ask" is the one value that is
   * indistinguishable from never having chosen. Making it the default aligns the
   * storage model with shell/uninstall-retention.cjs, where absence and `ask`
   * deliberately resolve to the same thing. Any other default would make
   * "never chose" and "chose the default" mean different things to the
   * uninstaller while looking identical on disk.
   *
   * NEITHER REAL OPTION IS MARKED RECOMMENDED. This product has already shipped
   * a setup screen with both answers labelled "Recommended", which is how it
   * ended up with no Start control anywhere. There is no correct answer here --
   * it depends on whether the person is reinstalling or leaving -- and a hint
   * would be this file deciding for them. */
  {
    id: 'uninstall_data',
    section: 'Data & Privacy',
    name: 'When I uninstall ToolsEnabled',
    desc: 'Uninstalling removes the program. It does not remove your saved credentials, '
      + 'your linked accounts, the signed record of every action taken, your agent history '
      + 'or your settings — those stay on this computer so a reinstall picks up where you '
      + 'left off. Choose what should happen to them.',
    depth: 1,
    type: 'seg',
    options: [['ask', 'Ask me then'], ['keep-my-data', 'Keep my data'], ['remove-everything', 'Remove everything']],
    def: 'ask',
  },

  /* THE OWNER'S ENCRYPTED CREDENTIAL VAULT, MANAGED FROM SETTINGS.
   *
   * A 'custom' ROW, LIKE THE "This computer" ROW ABOVE IT, AND FOR THE SAME
   * REASON: it stores no preference. The vault IS the store, and every honest
   * 'mc.set.*' key this row could have written would be a value nothing reads
   * -- which is the row the suite over this catalogue exists to refuse. So the
   * row hosts a module that acts for itself, and the four things the owner's
   * settings rule asks for are:
   *
   *   REGISTRY     this catalogue entry, id 'vault_credentials'.
   *   READER       shell/vault-presence.cjs -- vaultRecordNames, which runs
   *                tools/secrets.ps1's 'list' verb and answers with record
   *                NAMES and no field that could carry a value, a prefix or a
   *                length.
   *   ENFORCEMENT  shell/vault-credential-page.cjs --
   *                completeCredentialRemoval, which calls no remover at all
   *                until the product's own approvals surface returns an
   *                'approve' for the exact prompt this seam raised for this
   *                exact name (Ledger rule R1225).
   *   CONTROL      src/vault-credentials-settings.js, mounted below.
   *
   * THE ID IS WRITTEN OUT HERE RATHER THAN NAMED BY ITS CONSTANT, and that is
   * deliberate rather than sloppy. The suite over this catalogue resolves an
   * ALL-CAPS identifier through a table of the constants it knows and fails on
   * one it does not, so naming a new constant in a row means teaching the gate
   * about it. The literal keeps the gate untouched; the drift that literal
   * could cause is closed the other way, by
   * tools/test/vault-credentials-settings.test.mjs asserting that
   * VAULT_CREDENTIALS_ROW and VAULT_CREDENTIALS_SECTION still equal what is
   * written above.
   *
   * Driven by tools/test/vault-credential-page.test.mjs and
   * tools/test/vault-credentials-settings.test.mjs. */
  { id: 'vault_credentials', section: 'Data & Privacy', name: 'Credentials stored on this computer', desc: 'The names of the records in this computer’s encrypted vault. What they hold is never shown here.', depth: 1, type: 'custom', mount: 'vault-credentials', disclosure: false, def: null },

  { id: 'theme', section: 'Appearance', name: 'Theme', desc: 'Choose a light surface, warm charcoal, or a deep red or blue glow.', depth: 1, type: 'seg', options: THEME_CHOICES.map(choice => [choice.id, choice.label]), def: 'white' },
  /* The choices live in src/font-choice.js (owner, R1523); each option's
     button is written in the font it applies, here and in the drawer. */
  { id: 'ui_font', section: 'Appearance', name: 'Font', desc: 'Compare the letter shapes, then choose what feels easiest to read. Source Sans 3 is a good starting point for longer reading. Code keeps its monospace font.', depth: 1, type: 'seg', options: FONT_CHOICES.map(choice => [choice.id, choice.label]), def: 'plex' },
  { id: 'home_circle_style', section: 'Appearance', name: 'Home circle', desc: 'Classic is the original still ring with a soft side glow and lower power use. Blob adds an animated fluid character that responds to your agents.', depth: 1, type: 'seg', options: HOME_CIRCLE_STYLES.map(choice => [choice.id, choice.label]), def: DEFAULT_HOME_CIRCLE_STYLE },
  ...HOME_STATUS_COLOR_SETTINGS.map(setting => ({ ...setting, section: 'Appearance', depth: 1, type: 'color', def: 'auto' })),
  { id: 'tree_style', section: 'Appearance', name: 'Agent tree style', desc: 'Circles show separate context cards. Boxes put the context inside each agent. Both use the same tree controls.', depth: 1, type: 'seg', options: [['circles', 'Circles'], ['boxes', 'Boxes']], def: 'boxes' },
  { id: 'tree_cards', section: 'Appearance', name: 'Circle context cards', desc: 'Show context cards beside circle nodes. Click a card for side chat; double-click a circle to open its conversation.', depth: 1, type: 'toggle', def: true },

  { id: 'text_size', section: 'Text & Reading', name: 'Text size', desc: 'Make everything bigger or smaller without changing the layout.', depth: 1, type: 'seg', options: [['0.9', 'Small'], ['1', 'Default'], ['1.12', 'Large']], def: '1' },

  { id: 'reduce_motion', section: 'Motion & Effects', name: 'Reduce motion', desc: 'Turn animation off: things move instantly and nothing pulses in the background.', depth: 1, type: 'toggle', def: false },
  { id: 'home_circle_motion', section: 'Motion & Effects', name: 'Home circle motion', desc: 'For Standard: System follows your device preference, Animate lets the blob move, and Still stops it. Reduce motion always pauses it. Simple stays still with any choice.', depth: 1, type: 'seg', options: HOME_CIRCLE_MOTIONS.map(choice => [choice.id, choice.label]), def: DEFAULT_HOME_CIRCLE_MOTION },
  { id: 'glow', section: 'Motion & Effects', name: 'Glow intensity', desc: 'How brightly the glowing status lights shine.', depth: 1, type: 'range', min: 0, max: 200, step: 1, unit: '%', def: 100 },

  /* WHAT THIS CONTROL DOES, IN THE ENGINE'S OWN TERMS. Its first draft said a
     second click "moves exactly that list into the archive"; the engine
     (capability/tools/ledger-archive.js) archives one target per confirmation
     and retires it to COOLING, where it stays on every list until three
     sessions have seen it. So the sentence says one at a time, says what was
     refused and why, and says nothing is deleted -- because nothing is. */
  /* THE PREREQUISITE FOR EVERY CLOUD DISPATCH, and until this row existed the
     only way to satisfy it was to hand-author state/cloud-mirror/registry.json.
     A cloud agent diffs against a MIRROR -- a private repository holding the
     tree it works from -- and a dispatch with none registered refuses
     CLOUD_MIRROR_NOT_REGISTERED, correctly. The person enters the dedicated
     private GitHub repository, and the dialog proves that exact repository is
     also the one the selected Cloud environment reports. */
  { id: 'cloud_mirror_setup', section: 'App permissions', name: 'Cloud mirror', desc: 'Cloud work runs from a private copy of a folder on this computer, so your own work is left as it is. Enter the dedicated private GitHub repository and choose the Cloud environment bound to that same repository. Public or mismatched destinations are refused.', depth: 1, type: 'action', action: 'cloud-mirror-setup', actionLabel: 'Set up a mirror', def: null },

  /* THE HAND OVERRIDE OF WHAT AN AGENT WROTE. The owner asked for "a basic diff
     editing screen ... the original file and the new file; split; in a popup
     window ... so a user can pull up review and modify diffs easily". It is a
     row here rather than a stop on the ring because it is a person-initiated
     tool with no state of its own, which is what this page already hosts (the
     mirror dialog above opens exactly this way), and because adding a second
     door to a thing that has one is the rule this product does not break. */
  { id: 'compare_files', section: 'App permissions', name: 'Compare two files', desc: 'Open two files side by side and edit either one, then save each side on its own. Use it to review what an agent changed and correct it by hand. Both sides open and save inside the folder your assistants work in.', depth: 1, type: 'action', action: 'compare-files', actionLabel: 'Compare two files', blockedReason: compareFilesBlockedReason, def: null },

  { id: 'ledger_archive', section: 'Rules & approvals', name: 'Archive finished requests', desc: 'The first press shows which finished or superseded requests qualify. The second archives them one at a time, each through its own preview, and says which it left where it was and why. Nothing is deleted: an archived request is marked finished and cooling, stays on this page’s list, and can be put back.', depth: 1, type: 'action', def: null },

  /* 'offline_fallback' was removed 2026-08-13 rather than left as a row: it was
     declared here and read by NOTHING in the tree, so the toggle moved and
     changed no behavior — a control that looks real and is not, the exact
     defect class the owner has ruled on ("a user setting needs registry,
     enforcement, and a control, or it's a lie"). If a demonstration fallback
     for unreadable live data is ever wanted, it gets built first and its row
     returns with a reader. */
  /* ONE ROW WHERE SEVEN WERE, AND THE SWITCH POINTS THE OTHER WAY.
   *
   * The seven `live_<view>` rows this replaces each read ON for "this screen
   * shows your own records" and OFF for "this screen shows the demonstration".
   * This row is the INVERSE: ON means every screen shows the example, OFF
   * means every screen shows your own activity. The old polarity made sense
   * for seven per-screen source switches that shipped on; for one preference
   * whose shipped state is "your own data", the switch has to name the thing
   * turning it on GETS you -- the example -- or the off state reads as a
   * defect. `scenario_tick_rate` ("Demonstration speed") went in the same
   * edit: it drove the retired simulation engine's clock, and the example
   * this row shows is data fed through the ordinary screens, with no clock of
   * its own to pace.
   *
   * The doctrine above (`offline_fallback`) applies to this row and is met:
   * the REGISTRY and the ENFORCEMENT are src/data-source.js -- isExampleMode()
   * owns the stored choice and resolveDataSource() answers 'mock' for every
   * screen while it is on -- and the CONTROL is this row plus the drawer's
   * copy of it. tools/test/settings-rows-do-something.test.mjs walks the
   * wiring rather than trusting this comment. */
  {
    id: 'example_mode',
    section: 'What the screens show',
    name: 'Show the example fleet',
    desc: 'Every screen shows the product’s built-in example instead of your own activity, and each screen showing it is labelled as an example. It is what a signed-out visitor to the website sees. Turn it off to see your own records again.',
    depth: 1,
    type: 'toggle',
    def: false,
  },

  /* The shipped-default sentence moved off the description and into the row's
     STATE line (toggleStateSentence), because here it contradicted the switch:
     driven tonight, a row reading ON carried "This ships switched off" as its
     first claim, and the reader believed the sentence over the switch. The
     state line says the current truth first and the shipped default after. */
  /* THE NOTIFICATIONS, AND WHY THEY SHIP OFF.
   *
   * The owner asked for this in these words: "we need to make sure in the app
   * that notifications are delivered", and decided how it is controlled in
   * these: "settings -> all of these are just settings a user picks". So every
   * trigger is a row here and nothing notifies that a person did not switch on.
   *
   * DEFAULT OFF IS THE RULE, NOT A CAUTIOUS CHOICE. This product does not opt
   * people into interruptions, and the storage model agrees with that rather
   * than merely permitting it: writeStored() below REMOVES a row's key when its
   * value returns to the default, so "off" is the ABSENCE of a key -- which
   * means an unset store, a damaged store and an unreadable store all answer
   * off in shell/agent-notifications.cjs. There is no path by which a settings
   * fault becomes an interruption.
   *
   * THE READER IS THE MAIN PROCESS, which is why these two rows sit under door
   * 2 of tools/test/settings-rows-do-something.test.mjs rather than door 1.
   * Nothing in this window acts on them: shell/agent-notifications.cjs reads
   * `mc.set.notify_agent_finished` and `mc.set.notify_agent_error` out of the
   * durable settings record this page writes through, on every agent event,
   * exactly as shell/uninstall-retention.cjs reads `mc.set.uninstall_data`.
   *
   * THE FINISH ROW IS FED BY ONE EVENT that genuinely happens: `turn_completed`,
   * which every session's events already cross in shell/main.cjs. Which of the
   * two rows it lands on is the engine's own status word, read through the same
   * allowlist src/agent-session-events.js uses -- "completed" or "success" is a
   * finish, and anything else, including the host's synthetic 'failed' for a
   * child that died mid-turn, is a stop.
   *
   * THE STOP ROW IS FED BY TWO, AND SAYING SO IS THE POINT. This product has two
   * endings and shell/main.cjs names them both: a turn that ends badly, and the
   * engine's own child going away -- `host.onSessionExit`, which fires for a
   * process that was killed, ran out of memory, or died between prompts with no
   * turn running at all. The row governed only the first of those on the day it
   * landed, which made "when an agent stops before it finishes" true of half of
   * what it claims and left the reader unable to tell which half. Both endings
   * reach shell/agent-notifications.cjs now, and that file is also what keeps a
   * single stop seen twice from becoming two notifications. */
  {
    id: 'notify_agent_finished',
    section: 'Notifications',
    blockedReason: notificationBlockedReason,
    name: 'Tell me when an agent finishes',
    desc: 'Your computer shows a short notification when an agent you started finishes its turn. '
      + 'It is skipped while this window has focus and that agent is on screen.',
    depth: 1,
    type: 'toggle',
    def: false,
  },
  {
    id: 'notify_agent_error',
    section: 'Notifications',
    blockedReason: notificationBlockedReason,
    name: 'Tell me when an agent stops with a problem',
    desc: 'Your computer shows a short notification when an agent stops before it finishes. '
      + 'That covers a turn that ended badly and an agent whose program went away. '
      + 'The notification says an agent stopped, and its page keeps what it said.',
    depth: 1,
    type: 'toggle',
    def: false,
  },

  ...WRITE_ACTION_FLAGS.map(flag => ({
    id: `write_${flag.id}`,
    section: 'App permissions',
    name: flag.label,
    desc: flag.description,
    depth: ['dispatch', 'report-read'].includes(flag.id) ? 1 : 2,
    type: 'toggle',
    def: false,
  })),

]

/* WHAT THE "This computer" SECTION HAS LEARNED ABOUT ITS OWN DOORS.
   Only the feedback door has an answer that can be absent: null until the probe
   settles, then true or false. It is read by that row's `absent` above, which
   runs at render time, so the row simply is not on the page until the backend
   has said it can be. */
const thisComputerDoors = { feedback: null }

const byId = new Map(SETTINGS.map(setting => [setting.id, setting]))
const writeSettingActions = new Map(WRITE_ACTION_FLAGS.map(flag => [`write_${flag.id}`, flag.id]))
const storageKey = id => `mc.set.${id}`
const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/* Render the machine's desk sentence for the person who is actually reading
 * it. This deliberately shares views/computers.js's one relay verdict and the
 * one declared translation table; Settings does not acquire its own wording or
 * infer remoteness from the browser. */
const readerSentence = sentence => readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })

/* THE EXAMPLE ROW, WHEN IT IS NOT A CHOICE. previewWithoutHost() is
 * data-source.js's answer to "is the example a choice this person made, or the
 * only thing this page could draw" -- src/views/computers.js already asks it
 * for this same row's sibling sentences (exampleBoardText, exampleExitSentence).
 * This row asked isExampleMode() alone and never asked why: with no host at
 * all, the switch reads OFF and every screen still shows the example whichever
 * way the switch is set, so "Turn it off to see your own records again" is a
 * promise this control cannot keep in either position -- there is no host for
 * it to hand real records back from. Disabled, not hidden: the section is not
 * absent, only what this one switch can do this minute. */
const NO_HOST_EXAMPLE_REASON = 'There is no computer connected to this page right now, so every screen shows the example fleet no matter how this switch is set. Install ToolsEnabled, or connect a computer, and this switch decides again.'
const exampleModeControlState = () => controlState({
  enabled: !previewWithoutHost(),
  why: previewWithoutHost() ? NO_HOST_EXAMPLE_REASON : null,
})

/* THE NOTIFICATION ROWS, WHEN THIS COPY CANNOT RAISE ONE.
 *
 * Same shape and same reasoning as the example row directly above. These two
 * switches are switches over something OUTSIDE this window -- the operating
 * system's notification service, reached through the installed application --
 * and there are two states in which turning one on would change nothing: this
 * page open in a browser, where there is no installed application to raise
 * anything, and a computer whose Electron answers isSupported() false.
 *
 * Disabled with the reason beside it, not hidden and not left live. Hidden
 * would leave a person hunting for a notification setting this product does
 * have; live would save a choice and then never produce a notification, which
 * is the drawn-control defect this page has shipped before. Which of the two
 * sentences a person gets is src/notification-delivery.js's answer, because it
 * is the one thing that knows which state this copy is in. */

function optionRecords(setting) {
  return (setting.options || []).map(option => {
    if (Array.isArray(option)) return { value: String(option[0]), label: String(option[1]) }
    const value = String(option)
    return { value, label: value.charAt(0).toUpperCase() + value.slice(1) }
  })
}

function clampNumber(setting, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return setting.def
  return Math.min(setting.max, Math.max(setting.min, number))
}

function readStored(setting) {
  try {
    const raw = localStorage.getItem(storageKey(setting.id))
    if (raw === null) return setting.def
    if (setting.type === 'toggle') return raw === 'true' ? true : raw === 'false' ? false : setting.def
    if (setting.type === 'range' || setting.type === 'stepper') return clampNumber(setting, raw)
    return optionRecords(setting).some(option => option.value === raw) ? raw : setting.def
  } catch { return setting.def }
}

function readValue(setting) {
  /* The applied state lives in src/data-source.js, not under this page's own
     `mc.set.*` key -- same rule as theme and font: the module that enforces a
     value is the one asked for it, never a stored copy that could drift. */
  if (setting.id === 'example_mode') return isExampleMode()
  const writeAction = writeSettingActions.get(setting.id)
  if (writeAction) return isWriteEnabled(writeAction)
  if (setting.id === 'theme') {
    return currentTheme()
  }
  /* Like theme: the applied state on the root element is the truth, not a
     stored copy (src/font-choice.js reads the inline --font-ui property). */
  if (setting.id === 'ui_font') return currentFontChoice()
  if (setting.id === 'home_circle_style') return currentHomeCircleStyle()
  if (setting.id === 'home_circle_motion') return currentHomeCircleMotion()
  if (setting.type === 'color') return currentHomeStatusColor(setting.status)
  /* Same rule for the size: read the applied zoom back through the module
     that applied it (src/text-size.js), rather than keeping a second list of
     which sizes exist here. */
  if (setting.id === 'text_size') return String(normalizeTextSize(textZoom()) ?? DEFAULT_TEXT_SIZE)
  if (setting.id === 'glow') {
    /* The applied value lives on the root element; the drawer's slider is a
       COPY of it and only exists once the drawer has rendered (it is built
       per page since R1520), so the variable is the source and the slider
       only a fallback. */
    const applied = parseFloat(document.documentElement.style.getPropertyValue('--glow'))
    if (Number.isFinite(applied)) return Math.round(applied * 100)
    const drawerValue = Number(document.getElementById('set-glow')?.value)
    return Number.isFinite(drawerValue) ? drawerValue : setting.def
  }
  if (setting.id === 'reduce_motion') return document.body.classList.contains('reduce-motion')
  return readStored(setting)
}

function sameValue(left, right) {
  return String(left) === String(right)
}

function writeStored(setting, value) {
  if (sameValue(value, setting.def)) localStorage.removeItem(storageKey(setting.id))
  else localStorage.setItem(storageKey(setting.id), String(value))
}

function setDrawerSegment(selector, dataName, value) {
  for (const button of document.querySelectorAll(`${selector} button`)) {
    const on = sameValue(button.dataset[dataName], value)
    button.classList.toggle('on', on)
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function formatValue(setting, value) {
  if (setting.type === 'color') return `${value === 'auto' ? 'Theme default · ' : ''}${resolvedHomeStatusColor(setting.status, currentTheme(), value).toUpperCase()}`
  if (setting.type === 'select') {
    return optionRecords(setting).find(option => sameValue(option.value, value))?.label || String(value)
  }
  if (setting.type === 'range' || setting.type === 'stepper') {
    const unit = setting.unit || ''
    const join = unit === '%' || unit === 'px' ? '' : unit ? ' ' : ''
    return `${formatNumber(value)}${join}${unit}`
  }
  return String(value)
}

function controlMarkup(setting) {
  const labelId = `setting-label-${setting.id}`

  /* A ROW WHOSE CONTROL IS SOMEWHERE ELSE. The "This computer" section is four
     sentences and a door each; the door is an ordinary anchor, so the window's
     own routing takes it and this page has nothing to wire. It is drawn with
     the same class the guided steps use, so a link in a row and a link under a
     row do not look like two different affordances. */
  if (setting.type === 'link') {
    return `<a class="settings-jump" href="${escapeHtml(setting.href)}" aria-describedby="${labelId}">${escapeHtml(setting.linkLabel || 'Open')}</a>`
  }

  /* A ROW THAT HOSTS A LIVE ELEMENT SOMEBODY ELSE OWNS. The markup is only the
     empty socket: wireControls() puts the controller's own element into it
     after every render, and that element is the SAME node across renders, so
     the reads it started and the listeners it attached survive a repaint of
     this column. Rendering the controller's markup as a string instead would
     re-create it, and every capability probe would restart its bridge reads. */
  if (setting.type === 'custom') {
    return `<div class="settings-mount" data-settings-mount="${escapeHtml(setting.mount)}"></div>`
  }

  if (setting.type === 'action') {
    /* THE ACTION AND ITS LABEL COME FROM THE SETTING. This branch used to
       emit data-setting-action="ledger-archive" and the words "Preview
       cleanup" for EVERY action row, because there was only ever one. A
       second action row would have rendered the first one's button and run
       the first one's handler -- a control that looks like itself and does
       something else. Fixed when the second row arrived rather than
       duplicated around. */
    const action = setting.action || 'ledger-archive'
    const label = setting.actionLabel || 'Preview cleanup'
    /* A CONTROL THAT CANNOT SUCCEED IS DISABLED, AND THE REASON IS BESIDE IT.
       The reason itself is drawn where the description would be -- see
       rowMessage() -- which is the shape the `example_mode` row already had.
       `blockedReason` is that rule with a name on it, so the third row that
       needs it does not become a third special case here. */
    const blocked = typeof setting.blockedReason === 'function' ? setting.blockedReason() : null
    return `<button type="button" class="ctl-btn" data-setting-action="${escapeHtml(action)}" aria-describedby="${labelId}"${blocked ? ` disabled title="${escapeHtml(blocked)}"` : ''}>${escapeHtml(label)}</button>`
  }
  const value = readValue(setting)

  if (setting.type === 'color') {
    return `<div class="settings-color"><input type="color" data-setting-color value="${resolvedHomeStatusColor(setting.status, currentTheme(), value)}" aria-labelledby="${labelId}"><output data-setting-output>${escapeHtml(formatValue(setting, value))}</output><button type="button" class="ctl-btn" data-setting-value="auto" aria-pressed="${value === 'auto'}">Theme default</button><span data-color-theme>${currentTheme()} theme</span></div>`
  }
  if (setting.type === 'seg') {
    /* The font row's options preview themselves: each button is set in the
       stack it would apply (R1523). Other segs carry no per-option style. */
    const optionStyle = option => setting.id === 'ui_font'
      ? ` style="font-family:${escapeHtml(fontStack(option.value))}"`
      : ''
    // Theme swatches can wrap; use the same static selection as the drawer
    // instead of the one-row sliding indicator attached to ordinary segs.
    return `<div class="${setting.id === 'theme' ? 'theme-seg' : setting.id === 'ui_font' ? 'theme-seg font-options' : 'seg'} settings-seg" role="group" aria-labelledby="${labelId}">
      ${optionRecords(setting).map(option => `<button type="button" data-setting-value="${escapeHtml(option.value)}"${setting.id === 'theme' ? ` data-theme-choice="${escapeHtml(option.value)}"` : ''}${optionStyle(option)} aria-pressed="${sameValue(option.value, value)}" class="${sameValue(option.value, value) ? 'on' : ''}">${setting.id === 'ui_font' ? fontOptionMarkup(option.value) : escapeHtml(option.label)}</button>`).join('')}
    </div>`
  }
  if (setting.type === 'toggle') {
    /* ONE RULE FOR "THIS SWITCH CANNOT SUCCEED", NOT A LADDER OF IDS.
       Three surfaces landed in one week and each wanted a disabled toggle with
       its reason beside it. Left as an id ladder, the fourth becomes another
       branch here and the reason lives in two places -- the row's own
       blockedReason and this list. The row is asked instead; example_mode keeps
       its own resolver only because its answer is about the page's data source
       rather than about the row. */
    const blocked = typeof setting.blockedReason === 'function' ? setting.blockedReason() : null
    const toggleControl = setting.id === 'example_mode'
      ? exampleModeControlState()
      : controlState({ enabled: !blocked, why: blocked })
    const disabledAttrs = toggleControl.disabled ? ` disabled title="${escapeHtml(toggleControl.why)}"` : ''
    return `<label class="toggle settings-toggle${toggleControl.disabled ? ' is-disabled' : ''}"><input type="checkbox" aria-labelledby="${labelId}" ${value ? 'checked' : ''}${disabledAttrs}/><i></i></label>`
  }
  if (setting.type === 'range') {
    return `<div class="settings-range settings-numeric-control"><div class="settings-exact-value"><label for="setting-number-${setting.id}">Value</label><input id="setting-number-${setting.id}" data-setting-number type="number" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" aria-labelledby="${labelId}" aria-describedby="setting-number-context-${setting.id} setting-number-error-${setting.id}"><span>${escapeHtml(setting.unit || '')}</span></div><input type="range" min="${setting.min}" max="${setting.max}" step="${setting.step}" value="${value}" aria-labelledby="${labelId}" aria-describedby="setting-number-context-${setting.id} setting-number-error-${setting.id}"/><output class="settings-sr-only" data-setting-output>${escapeHtml(formatValue(setting, value))}</output><div class="settings-range-labels" aria-hidden="true"><span>${escapeHtml(formatValue(setting, setting.min))}</span><span>${escapeHtml(formatValue(setting, setting.max))}</span></div><div class="settings-numeric-context" id="setting-number-context-${setting.id}" data-setting-number-context></div><div class="settings-numeric-error" id="setting-number-error-${setting.id}" data-setting-number-error role="status" hidden></div></div>`
  }

  const isSelect = setting.type === 'select'
  return `<div class="settings-stepper ${isSelect ? 'is-select' : ''}" role="group" aria-labelledby="${labelId}">
    <button type="button" data-step-delta="-1" aria-label="Previous ${escapeHtml(setting.name)}">&lt;</button>
    <output data-setting-output>${escapeHtml(formatValue(setting, value))}</output>
    <button type="button" data-step-delta="1" aria-label="Next ${escapeHtml(setting.name)}">&gt;</button>
  </div>`
}

function searchHaystack(setting) {
  const guidance = describeSubject(setting.id, { section: setting.section })
  return [
    setting.name, setting.desc, setting.section,
    guidance.whatItDoes, ...guidance.capabilities, ...guidance.risks, guidance.absenceNote,
  ].join(' ').toLowerCase()
}

/* WHERE A ROW'S GUIDANCE CAN SEND YOU: the thing the switch actually gates.
 * One press instead of "read the name, work out which page, walk the ring".
 * Only rows whose gated surface has a stable address get a link; the agent
 * drill-ins have no fixed page to name, so their rows carry none rather than
 * a link that lands somewhere the control is not.
 *
 * The example row's link is a CHOICE OF ONE ADDRESS OVER ALL OF THEM. The
 * seven per-view rows each linked to the one screen they gated; this switch
 * gates every screen at once, so no single link can show its whole effect.
 * The home screen is where a person lands first and where the example's badge
 * is most prominent, so that is where the link goes -- one honest sample of
 * the effect, not a claim that the effect lives there. */
const JUMP_TARGETS = new Map([
  ['example_mode', { href: '#/', label: 'Open the home screen, where this shows first' }],
  ['write_dispatch', { href: '#/computers', label: 'Open the page that shows this control' }],
  ['write_decision', { href: '#/ledger', label: 'Open the ledger this controls' }],
  ['write_queue', { href: '#/ledger', label: 'Open the ledger this controls' }],
  ['write_thread-reply', { href: '#/', label: 'Open the first page, where replies go' }],
])

function jumpMarkup(setting) {
  const target = JUMP_TARGETS.get(setting.id)
  if (!target) return ''
  return `<a class="settings-jump" href="${escapeHtml(target.href)}">${escapeHtml(target.label)}</a>`
}

/* The truth-first sentence beside a switch. Toggles only: every other control
   shows its current value in its own body (the lit option, the number). */
function stateMarkup(setting) {
  if (setting.type !== 'toggle') return ''
  const sentence = toggleStateSentence({
    value: Boolean(readValue(setting)),
    def: setting.def,
    acts: writeSettingActions.has(setting.id),
  })
  return `<div class="settings-state" data-setting-state>${escapeHtml(readerSentence(sentence))}</div>`
}

/* WHAT THE ROW SAYS ABOUT ITSELF, and the two rows where that is not their own
 * description.
 *
 * A disabled control's reason has to be where the eye already is. The title
 * attribute alone is a reason only a mouse can find, and a person reading with
 * a keyboard, or reading quickly, gets a switch that will not move and no
 * sentence. So a row whose control cannot succeed prints the reason WHERE THE
 * DESCRIPTION GOES -- which is what the example row has done since it gained a
 * disabled state, and the two notification rows now do the same thing rather
 * than a second version of it. */

/* ONE ROW ANATOMY, IN ONE ORDER: name — state sentence — description — control
 * — disclosure. The disclosure is a grid row of its OWN, under both columns,
 * because it used to live beside the control with the row centre-aligned:
 * opening it grew the copy column and slid the control 14 to 81px under the
 * pointer mid-press (measured tonight on the driven build). Below the control,
 * opening it moves nothing a pointer is over. */
/* THE SENTENCE A ROW SHOWS, and the one case where it is not the description.
 * A control that cannot succeed says WHY in the place the description would
 * have been, rather than leaving a disabled button with nothing beside it.
 * `example_mode` has done exactly this since the no-host reason was written;
 * `blockedReason` gives that rule a name so the next row does not need another
 * branch here. */
export function rowMessage(setting) {
  if (setting.id === 'example_mode' && previewWithoutHost()) return NO_HOST_EXAMPLE_REASON
  const blocked = typeof setting.blockedReason === 'function' ? setting.blockedReason() : null
  return blocked || readerSentence(setting.desc)
}

/* A ROW THAT MUST BE ABSENT, NOT MERELY DISABLED, AND THE DIFFERENCE MATTERS.
 * `blockedReason` draws the control greyed with the reason beside it, which is
 * the honest answer for a switch that cannot succeed: the person learns the
 * switch exists and why it will not move. `absent` is for the one case where
 * that answer is worse than silence -- a way to SEND something. A greyed
 * "Send feedback" tells a person their report cannot be heard. So the row is
 * not on the page at all until the backend has said it can be, and it carries
 * `hidden` from the first paint rather than appearing and then vanishing. */
function rowAbsent(setting) {
  return typeof setting.absent === 'function' && setting.absent() === true
}

export function rowMarkup(setting, searchResult = false) {
  return `<article class="settings-row ${setting.depth === 4 ? 'is-engineer' : ''}${setting.type === 'custom' ? ' settings-row-wide' : ''}"${rowAbsent(setting) ? ' hidden' : ''} data-setting-id="${setting.id}" data-settings-min-mode="${settingMode(setting.id)}">
    <div class="settings-copy">
      ${searchResult ? `<div class="settings-prefix">${escapeHtml(setting.section)} · ${SETTINGS_MODES.find(mode => mode.id === settingMode(setting.id))?.label || 'Advanced'}</div>` : ''}
      <div class="settings-name" id="setting-label-${setting.id}">${escapeHtml(setting.name)}${setting.type === 'range' ? '' : '<span class="settings-pending-mark" data-local-pending hidden>Unsaved</span>'}</div>
      ${stateMarkup(setting)}
      <div class="settings-desc" data-setting-message>${escapeHtml(rowMessage(setting))}</div>
      ${jumpMarkup(setting)}
    </div>
    <div class="settings-control">${controlMarkup(setting)}</div>
    ${setting.disclosure === false ? '' : `<div class="settings-disclosure">${guidanceMarkup(setting.id, { section: setting.section, probe, summary: 'Details' })}</div>`}
    ${setting.mount === 'this-computer-feedback' ? '<div class="settings-mount" data-settings-mount="this-computer-feedback" hidden></div>' : ''}
  </article>`
}

/* A REVEAL THAT REVEALS NOTHING IS NOT DRAWN, and this is a nesting defect
 * rather than a tidy-up.
 *
 * MEASURED on a real 1002x650 window, before this guard: SIX of the seven
 * catalogue-driven sections carried a pressable "0 more ⌄" under their rows --
 * Data & Privacy, Appearance, Text & Reading, Motion & Effects, Ledger and
 * Data & Sim have no row below depth 1 between them. Write, the one section
 * that does have a second depth, then carried "advanced · 0 more" and
 * "everything · 0 more" INSIDE its opened tier, because nothing lives at depth
 * 3 or 4 anywhere on this page any more.
 *
 * The owner's report was that the nesting is messy. A control offering to
 * unfold an empty fold is the page claiming a level it does not have, on the
 * screen whose whole complaint is about levels -- and it is the same family as
 * the six titled-but-empty headings removed on 2026-08-20, one rung down.
 *
 * The count is derived at render time, so a section that gains a depth-2 row
 * gets its reveal back with no edit here. */
function revealMarkup(section, depth, count, prefix, open) {
  if (!count) return ''
  const controlId = `settings-tier-${SECTIONS.indexOf(section)}-${depth}`
  return `<button class="settings-reveal" type="button" data-reveal-section="${escapeHtml(section)}" data-reveal-depth="${depth}" data-reveal-count="${count}" data-reveal-prefix="${prefix}" aria-controls="${controlId}" aria-expanded="${open ? 'true' : 'false'}">${revealInner(prefix, count, open)}</button>`
}

/* The chevron gets its own element: a cold reader hedged on whether the bare
   "4 more ⌄" line was clickable — the glyph now sits at affordance size and
   answers on hover instead of relying on the reader's faith. */
function revealInner(prefix, count, open) {
  const text = prefix
    ? `${prefix} · ${open ? 'less' : `${count} more`}`
    : `${count} ${open ? 'fewer' : 'more'}`
  return `${escapeHtml(text)}<span class="settings-reveal-glyph" aria-hidden="true">${open ? '⌃' : '⌄'}</span>`
}

function tierMarkup(section, depth, content, open) {
  return `<div class="settings-tier settings-tier-${depth} ${open ? 'is-open' : ''}" id="settings-tier-${SECTIONS.indexOf(section)}-${depth}" data-tier-depth="${depth}" aria-hidden="${open ? 'false' : 'true'}" ${open ? '' : 'inert'}><div class="settings-tier-inner">${content}</div></div>`
}

/* A sentence under a section title, for the two sections whose switches a person
   arrives at with the wrong question. Data, not markup in the render, so the
   words are visible in one place and a third section can be added without
   touching the renderer. A section with no note gets no element at all rather
   than an empty one. */
/* The opening sentences of a copy module's paragraph, so a note can carry the
   part a reader needs without this file retyping -- and drifting from -- words
   another screen also shows. Falls back to the whole body rather than to
   nothing if the text has no sentence end, because a note that silently
   emptied would hide the very gap it exists to name. */
function firstSentences(body, count) {
  const parts = String(body).match(/[^.]+\./g)
  if (!parts || parts.length === 0) return String(body).trim()
  return parts.slice(0, count).join('').trim()
}

const SECTION_NOTES = Object.freeze({
  /* THE ONE NEED NOBODY CAN CLEAR FROM THIS WINDOW, SAID ONCE, AT THE TOP.
   *
   * The sentences are FIRST_RUN_NEEDS `host`, whose `fix` is 'none', and the
   * rule src/first-run-needs.js keeps for it is the rule this note keeps: no
   * promised remedy that does not exist. There is no setting that connects a
   * fleet host and no command that installs one, so this note names no link and
   * offers no next step. A door here would be the product pretending it has an
   * answer it does not have.
   *
   * TWO SENTENCES OF IT, NOT ALL SIX. The need's body was written for a page
   * that had room to reassure: after naming the gap it goes on to say that this
   * is the honest state of the product rather than a fault, that it says
   * nothing about the ToolsEnabled account, and where that account is joined.
   * Every one of those is the product explaining itself to the reader, and the
   * account has a row of its own three lines below. What a person needs from a
   * note is the gap and the flat fact that nothing they do will close it, which
   * is sentence one and sentence two. Taken by counting rather than retyped, so
   * a rewording in the copy module carries straight through.
   *
   * THEN ONE SENTENCE ABOUT WHAT DOES WORK, because a section that only lists
   * absences reads as a broken product. It is taken from WORKS_HERE rather than
   * written here, so it cannot drift from the list every other surface quotes.
   *
   * THEN THE CHAT COMMANDS, which used to be a row and earned no control. */
  [THIS_COMPUTER_SECTION]: Object.freeze({
    text: [
      firstSentences(FIRST_RUN_NEEDS.find(need => need.id === 'host')?.body || '', 2),
      WORKS_HERE[2],
      /* ONE SENTENCE, AND NOT THE SECOND ONE. The row this replaced also said
         that adding Session, Tree or Thread sets how far a command reaches.
         That is a real fact, but it is a refinement of a fact, and a note with
         no door cannot take the reader anywhere to act on it -- so it went with
         the row rather than being kept as the longest line in a note about
         something else. Recorded in REPORT.md, not silently dropped. */
      'Typing /Request, /Task or /Ask in the chat box files a standing rule, a piece of work or a question.',
    ].join(' '),
  }),
  'What the screens show': Object.freeze({
    text: 'This switch chooses between your own records and the product’s built-in example, for every screen at once. It does not connect anything. On a fresh install your own readings are empty, because nothing has reported to this copy yet, and this switch does not change that.',
    link: Object.freeze({ label: 'This computer', href: THIS_COMPUTER_HREF }),
  }),
  'App permissions': Object.freeze({
    text: 'Every action that writes anything ships switched off, so a copy nobody has configured cannot send, start or approve anything by accident. Turning one on here is what makes its control appear.',
    link: Object.freeze({ label: 'This computer', href: THIS_COMPUTER_HREF }),
  }),
  /* THE THIRD SENTENCE IS THE ONE THAT KEEPS SOMEBODY FROM HUNTING.
     "An agent needs your permission" is the notification a person expects to
     find here and it is deliberately not offered: nothing on this build ever
     raises an approval, because approvalPolicy is `never` at every level (the
     reasoning is at answerApproval() in shell/agent-host.cjs, and the answer
     path was landed first on purpose). A switch for it would move, save,
     survive a restart and never once produce a notification. Saying so here
     costs one sentence; leaving it out costs a person the search. */
  Notifications: Object.freeze({
    text: 'Both switches here ship off, so nothing interrupts you until you ask it to. A notification is skipped while this window has focus and you are already watching that agent. An agent that stops to ask for your approval does not raise a notification yet, so there is no switch for that.',
  }),
})

/* A NOTE MAY HAVE NO LINK, and that is not the same as having a bad one.
   Two of the four notes send a reader to "This computer", because both are
   about what this copy still needs from the outside and that section is where
   the doors are. The notifications note is about a choice that is already
   complete here, so it gets no link rather than one pointing somewhere that
   does not answer the question the note raises. The "This computer" note gets
   none for a harder reason: the need it names has no remedy anywhere, and a
   link would be this page inventing one. */
function sectionNoteMarkup(section) {
  const note = SECTION_NOTES[section]
  if (!note) return ''
  const link = note.link
    ? `\n    <a class="host-absent-action" href="${escapeHtml(note.link.href)}">${escapeHtml(note.link.label)}</a>`
    : ''
  return `<p class="settings-section-note host-absent-body" data-section-note="${escapeHtml(section)}">${escapeHtml(readerSentence(note.text))}${link}</p>`
}

/* THE ONE SECTION-LEVEL ONE-PRESS CONTROL LEFT, AND THE ONE THAT DIED WITH
 * THE PER-VIEW FLAGS.
 *
 * Data & Sim used to carry an "every screen at once" pair, because its seven
 * switches were genuinely independent screen-source toggles and pressing
 * them one at a time was busywork. The section now holds ONE switch that
 * reaches every screen by construction, so a bulk press over it would be a
 * second button doing exactly what the switch already does -- it went with
 * the rows.
 *
 * Write keeps its press, and keeps its asymmetry: its switches each let the
 * program ACT, and the product deliberately asks for each grant one row at a
 * time -- the walkthrough's one-answer bulk grant is the sanctioned path,
 * with its consequences stated. So Write gets ONE press for the safe
 * direction only: off. There is deliberately no "turn everything on" press
 * here. */
/* Views change what is shown, never what is saved. Said once, as the switch's
   title and as part of its accessible description. */
const SETTINGS_MODE_NOTE = 'Views change what is shown. Your saved choices stay in effect in every view.'

const BULK_ROWS = Object.freeze({
  'App permissions': `<article class="settings-row settings-bulk-row">
    <div class="settings-copy">
      <div class="settings-name" id="settings-bulk-write-label">Everything off, in one press</div>
      <div class="settings-desc">Turns every action switch in this section off, including those shown in other modes. Turn them on individually. Save settings to apply your changes.</div>
    </div>
    <div class="settings-control">
      <div class="fleet-profile-actions" role="group" aria-labelledby="settings-bulk-write-label">
        <button type="button" class="ctl-btn" data-bulk-write-off>Turn everything off</button>
      </div>
    </div>
  </article>`,
})

function sectionMarkup(section, level) {
  const items = SETTINGS.filter(setting => setting.section === section)
  const at = depth => items.filter(setting => setting.depth === depth)
  const depth4 = tierMarkup(section, 4, at(4).map(setting => rowMarkup(setting)).join(''), level >= 4)
  const depth3Content = [
    ...at(3).map(setting => rowMarkup(setting)),
    revealMarkup(section, 4, at(4).length, 'everything', level >= 4),
    depth4,
  ].join('')
  const depth3 = tierMarkup(section, 3, depth3Content, level >= 3)
  const depth2Content = [
    ...at(2).map(setting => rowMarkup(setting)),
    revealMarkup(section, 3, at(3).length + at(4).length, 'advanced', level >= 3),
    depth3,
  ].join('')
  const hidden = items.filter(setting => setting.depth > 1).length
  /* ...and the tier the reveal would have opened goes with it. An empty tier
     draws nothing today (max-height 0, overflow hidden) but it carries the
     indent rule and the two corner hairlines that MEAN "there is more nested
     here", and syncSectionDepth already tolerates a section with no tier. */
  const depth2 = hidden ? tierMarkup(section, 2, depth2Content, level >= 2) : ''

  return `<section class="settings-section" data-settings-section="${escapeHtml(section)}">
    <h2 class="settings-section-title">${escapeHtml(section)}</h2>
    ${sectionNoteMarkup(section)}
    ${BULK_ROWS[section] || ''}
    <div class="settings-section-rows">${at(1).map(setting => rowMarkup(setting)).join('')}</div>
    ${revealMarkup(section, 2, hidden, '', level >= 2)}
    ${depth2}
    ${items.some(setting => settingMode(setting.id) !== 'simple') ? '<p class="settings-simple-more">More options are available here. <button type="button" class="ctl-btn" data-settings-show-mode="advanced">Show Advanced settings</button></p>' : ''}
  </section>`
}

function setTierFocusable(tier, open) {
  tier.toggleAttribute('inert', !open)
  for (const control of tier.querySelectorAll('button, input, select, textarea, [tabindex]')) {
    if (!open) {
      if (control.dataset.settingsTabindex === undefined) {
        control.dataset.settingsTabindex = control.getAttribute('tabindex') ?? ''
        control.setAttribute('tabindex', '-1')
      }
    } else if (control.dataset.settingsTabindex !== undefined) {
      const previous = control.dataset.settingsTabindex
      if (previous === '') control.removeAttribute('tabindex')
      else control.setAttribute('tabindex', previous)
      delete control.dataset.settingsTabindex
    }
  }
}

/**
 * The one row a link asked for, or null.
 *
 * A LINK MAY NAME A SWITCH, AND ONLY A SWITCH THIS PAGE HAS. The id arrives off
 * the address bar, so it is looked up in this page's own table and anything
 * else is ignored -- an unknown id lands the person at the top of Settings,
 * which is exactly where they landed before this existed, rather than throwing
 * an error at somebody who followed a link.
 */
function requestedSetting(query) {
  const requested = query && typeof query.get === 'function' ? query.get('setting') : null
  const id = requested === 'agent.tool_mode' ? 'agent.agent_api' : requested
  if (typeof id !== 'string' || id.length === 0) return null
  /* THE RESEARCH ROWS ARE LANDABLE TOO, and this is the half that makes the
     research page's sentence true. That page sends a person here for the switch
     that decides whether anything runs; landing needs a section and a depth, and
     these four are not in SETTINGS because they are not this window's own
     preferences. They render at the top of their section, so depth 1 is what
     they are, and the row itself carries data-setting-id like every other row,
     which is what markLanding and scrollToLanding look for. */
  /* The heading is asked for per id rather than assumed, since these rows no
     longer all draw under one: a link that names the wrong section lands a
     person on a heading their row is not under, which is worse than not
     landing at all because it looks like it worked. */
  if (PRODUCT_SETTING_IDS.includes(id)) return { id, section: sectionOfRow(id), depth: 1 }
  /* AND SO IS CONNECTING THIS COMPUTER, for the same reason and a sharper one.
     Until this line nothing in the product could link to the one step that
     turns it from a program on one machine into the product: the row is not in
     SETTINGS -- it is the installed application's business, like the research
     rows above -- so the best any link could do was drop somebody at the top of
     this page. The owner's words were "as a user I dont even see how after
     signing up that I now connect my computer". The id is read from
     src/device-claim-flow.js, which is also what the row stamps on itself, so
     the link and the landing cannot drift apart. */
  if (id === CONNECT_SETTING_ID) return { id, section: CONNECT_SECTION, depth: 1 }
  return byId.get(id) || null
}

/* THE CATEGORY ON SCREEN IS ONE OF TWELVE PAGES, AND THE ADDRESS SAYS WHICH.
 *
 * The owner: "the settings categories should be THEIR OWN SEPERATED FULLY
 * SEPERATE PAGES FOR EACH SECTION so when i press one on the list on the left
 * hand side it pulls up just that category of settings and no other categories
 * from the list."
 *
 * So the rail is navigation, not a table of contents, and a press changes the
 * address the way every other move in this product does -- `#/settings` is one
 * stop in src/main.js and `?category=` is its parameter, the same shape
 * `?setting=` already had. That is what makes reload, the back arrow and a
 * pasted link land on the category the person was looking at.
 *
 * A LINK THAT NAMES A ROW STILL WINS. `?setting=<id>` is how the rest of the
 * product points at one switch, and the only page that can show that switch is
 * the one holding it; a category alongside it would be an address arguing with
 * itself. So the row decides, and the category parameter answers for every
 * other arrival.
 *
 * THE DEFAULT IS THE CATEGORY HOLDING SIGN-IN, and it is the one decision here
 * that is not obvious. A page that draws one category has to choose which one
 * somebody sees when they have chosen nothing, and the product already had an
 * answer to a question one step away from it: FIRST_VISIT_SECTION in
 * src/settings-presentation.js names the section a brand-new person feels the
 * absence of first, because it holds the one persistent door to `#/account`. A
 * measured defect -- that door 0x0 on a first visit, a packaged driver
 * reporting `sign-in-link:zero-size` for a night -- is what put that constant
 * there. Landing anywhere else would take the door off the screen again by a
 * different mechanism, which is not a thing to do to a fix that was measured.
 *
 * An address naming a category this copy does not have lands here too, rather
 * than on an error: an old link is a person, not a fault. */
const DEFAULT_CATEGORY = FIRST_VISIT_SECTION

function requestedCategory(query, landing) {
  if (landing) return landing.section
  const slug = query && typeof query.get === 'function' ? query.get('category') : null
  return sectionFromSlug(slug) || (readSettingsMode() === 'enterprise' ? ENTERPRISE_SECTION : DEFAULT_CATEGORY)
}

/** The address of one category, which is the only thing a rail press changes. */
function categoryHref(section) {
  return `#/settings?category=${categorySlug(section)}`
}

/* NOT NAMED `query`: this view already has a local `query` holding what is
   typed in the search box, and a parameter of the same name is a redeclaration
   the module would not even parse. */
export function settingsView({ query: routeQuery = null, navigate = hash => { location.hash = hash }, accessibilityControls = null } = {}) {
  let destroyed = false
  /* THE EXAMPLE ROW MAY BE THE FIRST THING ON THIS PAGE TO ASK. Every other
     view that reads previewWithoutHost()/currentDataSource() resolves the
     source itself in its own mount (src/views/home.js is the model this
     copies) rather than trusting an earlier view to have done it already --
     a public page reached by a bookmark or a deep link straight to Settings
     has no earlier view. The guess matches home.js's; if the settled verdict
     disagrees, this announces the change, and the DATA_SOURCE_EVENT listener
     wired below repaints the example row with the real answer. */
  const sourceGuess = isExampleMode() || currentDataSource() === 'mock'
  void resolveDataSource().then((settled) => {
    if (!destroyed && (settled === 'mock') !== sourceGuess) announceDataSourceChange('first-resolution')
  }).catch(() => {})

  let landing = requestedSetting(routeQuery)
  let landingNeedsFocus = Boolean(landing)
  /* The one category this page is, for as long as this address is the address.
     Changing it is a navigation, so nothing below ever assigns to it. */
  let activeSection = requestedCategory(routeQuery, landing)
  /* WHICH GROUPS ARE OPEN IN THE RAIL, remembered across visits and restarts,
     and decided in src/settings-presentation.js so a node test can hold the
     rule still. Returning: exactly what this person last left open. Following a
     link that names a row: that row's group as well. ARRIVING with no posture
     at all: the group holding sign-in, because a first visit used to render six
     headings and zero controls -- measured, with the only door to #/account
     0x0 inside it. None of the three writes anything; arriving is not a filing
     decision. */
  const openGroups = groupsOpenOnArrival(globalThis.localStorage, landing ? landing.section : null)
  /* AND THE GROUP HOLDING THE CATEGORY ON SCREEN IS OPEN, whatever the posture
     says. The rail is this page's only statement of where you are, so a menu
     that had the current entry folded away would be disagreeing with the screen
     beside it. It is added here rather than inside the arrival rule because it
     is not about arriving: it is true on every render, including the ones where
     the posture is exactly what the person filed. */
  let activeGroup = groupOfSection(activeSection)
  if (activeGroup) openGroups.add(activeGroup.id)
  const categoryCount = SETTINGS_GROUPS.reduce((total, group) => total + group.sections.length, 0)
  let activeGroupCount = activeGroup?.sections.length ?? 0
  /* WHAT IS OPEN AND WHAT IS FILED ARE NOW TWO DIFFERENT ANSWERS, and keeping
     them in one Set is how the second one gets corrupted.
     Three groups can be open in the rail without the person having opened any
     of them: the one holding the category the address named, the one holding a
     row a link named, and on a first visit the one holding sign-in. Written
     back, each becomes "what this person left open" for every later visit --
     the exact outcome src/settings-presentation.js refuses to produce when it
     says the arrival rule may not write. So the store keeps its own Set,
     starting as whatever is actually in it, and only a press moves it. */
  const filedGroups = readOpenGroups(globalThis.localStorage)
  let rebuildRequested = false
  let maintenanceBusy = false
  let workingProfileBusy = false
  let draftRevision = 0
  let updateDraftStatus = () => {}
  const draft = createSettingsDraft({ onChange: () => { draftRevision += 1; updateDraftStatus() } })
  const numericEdits = new Map()
  const stageWrite = (key, value, write, options) => draft.stage(key, value, write, options)
  const transcriptController = createTranscriptSettings({ draft })
  const savedMaintenanceController = createSavedDataMaintenanceSettings({
    mayRun: () => currentDataSource() === 'local' && !draft.dirty && !draft.saving && !workingProfileBusy,
    blockedReason: () => currentDataSource() === 'mock' ? 'Switch off the example fleet to review your own saved conversations.'
      : currentDataSource() !== 'local' ? 'Open the ToolsEnabled desktop app on this computer to review its saved conversations.'
      : draft.saving ? 'Wait for Settings to finish saving, then review.'
      : workingProfileBusy ? 'Wait for the working profile to finish preparing, then review.'
      : draft.dirty ? 'Save or discard your Settings changes first. Review waits while changes are unsaved.' : '',
    isBlocked: () => maintenanceBusy,
    onBusy: busy => { maintenanceBusy = busy; draftRevision += 1; updateDraftStatus() },
  })
  const diagnosticController = createDiagnosticSettings()
  /* The resume row shows the engine's default for the SAVED working profile
     (automatic at Independent and above). It reads the receipt from the
     working profile's own host read below, never a staged choice. */
  const permissionController = createActionPermissionSettings({ draft, readWorkingProfileReceipt: () => workingProfileController.savedProfile })
  const profileController = createFleetProfileSettings({ stageWrite, setStageError: (key, message) => draft.setError(key, message) })
  const confirmation = createSettingsConfirmation()
  // An empty Service address means not configured; anything else must parse.
  const productDraftError = (id, value) => {
    if (id !== 'model.endpoint' || !String(value ?? '').trim()) return ''
    if (!endpointAddress(value)) return UNUSABLE_ENDPOINT
    const url = new URL(String(value).trim())
    return url.username || url.password || url.search || url.hash ? 'Enter the service address without a user name, password, query or fragment.' : ''
  }
  const productDraftBridge = draftSettingsBridge(window.mcSettings, draft, { confirmWrite: confirmation.confirmWrite, validate: productDraftError })
  const setupController = createSetupProfileSettings({ stageWrite, draft, productSettings: productDraftBridge })
  const chatboxController = createChatboxSettings({ stageWrite })
  // A maintenance interval supersedes an older Save even after it settles.
  const auditController = createAuditSettings({ confirmation, draft, onBusy: busy => { maintenanceBusy = busy; draftRevision += 1; updateDraftStatus() } })
  const treeContextController = createTreeContextSettings({ draft, stageWrite })
  const researchController = createResearchSettings({ shell: productDraftBridge,
    onRender: ({ loaded = false } = {}) => {
      if (loaded && query.trim()) {
        const expected = PRODUCT_SECTIONS.filter(section => researchController.matches(query, section))
        const displayed = [...sectionsNode.querySelectorAll('[data-product-section]')].map(node => node.dataset.productSection)
        if (expected.join('\n') !== displayed.join('\n')) renderSearch()
      }
      markLanding()
      if (landingNeedsFocus) scrollToLanding()
    },
  })
  const connectController = createConnectComputerSettings()
  const remoteComputerController = createRemoteComputerSettings()

  /* "This computer" IS BUILT THE FIRST TIME IT IS DRAWN, AND NOT BEFORE.
   *
   * Creating it reads the machine three times over the provider bridge: what is
   * installed, which accounts exist, and whether a local model runtime is
   * listening. The page it came from could do that at mount because it WAS
   * those reads. Settings is not: it draws one category at a time and a person
   * arriving at Appearance has asked nothing about Codex. So the controller is
   * made on the first render that actually shows the section, and a visit that
   * never opens it never touches the bridge.
   *
   * ONE ELEMENT, REUSED. Its element is put back into the socket after every
   * render rather than re-created, so a repaint -- and the capability probes
   * repaint this column a second or two after it first paints -- cannot restart
   * the reads or drop the listeners it attached to its own buttons. */
  let thisComputer = null
  let thisComputerFeedbackOpen = false
  function ensureThisComputer() {
    if (thisComputer) return thisComputer
    thisComputer = createThisComputerSettings()
    /* The feedback ROW, not merely the composer inside it, is what appears when
       the backend answers. Re-rendering is how the row learns: `absent` is read
       at render time, so the answer arriving is a reason to draw again. */
    thisComputer.onFeedbackAvailable(available => {
      if (destroyed) return
      if (thisComputerDoors.feedback === available) return
      thisComputerDoors.feedback = available
      renderCurrent()
    })
    return thisComputer
  }
  const updateController = createUpdateSettings({ stageWrite, draft })
  const roleColorController = createRoleColorSettings({ stageWrite, setStageError: (key, message) => draft.setError(key, message) })
  const handController = createHandControlSettings({ stageWrite, draft })
  const screenController = createScreenControlSettings()
  const resourceController = createResourceSettings({ stageWrite, draft, onStateChange: () => workingProfileController.sync() })
  const workingProfileController = createWorkingProfileSettings({ draft, productSettings: productDraftBridge,
    setup: setupController, resources: resourceController, localSettings: SETTINGS, onStaged: () => renderCurrent(),
    onBusy: busy => { workingProfileBusy = busy; updateDraftStatus() },
    isBlocked: () => maintenanceBusy,
    onSavedProfileChange: () => permissionController.repaint(),
  })
  /* THE OTHER QUICK SLIDERS (owner, 2026-09-15: "a few sliders for different
     things to be changed quickly ... easily accessible on the settings landing
     page", then "the sliders need like 5-6 options each"). Same draft, same
     bridge, same Save; a stop sets the rows it names and no others. */
  const quickSlidersController = createQuickSliders({ draft, productSettings: productDraftBridge,
    onStaged: () => { renderCurrent(); workingProfileController.sync() },
    onBusy: busy => { workingProfileBusy = busy; updateDraftStatus() },
    isBlocked: () => maintenanceBusy,
  })
  /* The rail carries both levels now: the group lines, and under whichever of
     them are open, the categories -- one button per page this screen can be.
     Every one of them is a link to an address; nothing here scrolls. */
  const railMarkup = () => SETTINGS_GROUPS.map(group => {
    const open = openGroups.has(group.id)
    /* THE CHEVRON AND THE aria-controls MOVED HERE WITH THE GROUPS, and they
       are not decoration. The group head in the main column carried both and
       was measured for both -- a real button, told about, with a glyph big
       enough to see (tools/signin-reach-probe.mjs). That head is gone, so this
       is the only control that opens a group, and a control that opens
       something has to say so to a pointer, a keyboard and a screen reader
       alike. */
    return `<div class="settings-rail-group ${open ? 'is-open' : ''}" data-rail-group-wrap="${escapeHtml(group.id)}">
      <button type="button" class="settings-rail-head" data-rail-group="${escapeHtml(group.id)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="settings-rail-${escapeHtml(group.id)}">${escapeHtml(group.label)}<span class="settings-reveal-glyph" aria-hidden="true">${open ? '⌃' : '⌄'}</span></button>
      <div class="settings-rail-sections" id="settings-rail-${escapeHtml(group.id)}" ${open ? '' : 'hidden'}>
        ${group.sections.map(section => `<button type="button" data-category="${escapeHtml(section)}">${escapeHtml(section)}</button>`).join('')}
      </div>
    </div>`
  }).join('')
  const root = el(`<div class="view-pad settings-page">
    <div class="settings-shell">
      <header class="settings-header m-head">
        <div class="settings-title-stack">
          <h1 class="mt">Settings</h1>
        </div>
        <span class="spacer"></span>
        <label class="settings-search"><span class="settings-sr-only">Search all settings</span><input type="search" placeholder="Search tools, approvals, appearance…" autocomplete="off" spellcheck="false"/></label>
      </header>
      <div class="settings-command-bar">
        <div class="settings-toolbar">
          <div class="settings-mode-picker" role="group" aria-label="Settings view" aria-describedby="settings-mode-description settings-mode-note">
            <span class="settings-mode-label">View</span>
            <div class="seg settings-mode-seg" title="${SETTINGS_MODE_NOTE}">${SETTINGS_MODES.map(mode => `<button type="button" data-settings-mode-choice="${mode.id}" aria-pressed="false">${mode.label}</button>`).join('')}</div>
            <span class="settings-sr-only" id="settings-mode-note">${SETTINGS_MODE_NOTE}</span>
          </div>
          <p id="settings-mode-description" data-settings-mode-description></p>
        </div>
        <div class="settings-save-bar">
          <span data-settings-draft-status role="status">Changes take effect after you save.</span>
          <button type="button" class="ctl-btn" data-settings-discard aria-label="Discard changes" disabled>Discard</button>
          <button type="button" class="ctl-btn armed" data-settings-save disabled>Save settings</button>
        </div>
      </div>
      <section class="settings-quick" data-settings-quick aria-labelledby="settings-quick-title">
        <h2 class="settings-quick-title" id="settings-quick-title">Quick settings</h2>
        <div class="settings-quick-grid">
          ${workingProfileController.markup()}
          ${quickSlidersController.markup()}
        </div>
        ${workingProfileController.reviewMarkup()}
      </section>
      <div class="settings-layout">
        <label class="settings-category-picker">
          <span>Section</span>
          <select data-settings-category-picker aria-label="Settings section">${SETTINGS_GROUPS.map(group => `<optgroup label="${escapeHtml(group.label)}">${group.sections.map(section => `<option value="${escapeHtml(section)}">${escapeHtml(section)}</option>`).join('')}</optgroup>`).join('')}</select>
        </label>
        <nav class="settings-rail" aria-label="Settings categories">
          <div class="settings-rail-intro"><span>Browse categories</span><span class="settings-rail-count">${categoryCount}</span></div>
          ${railMarkup()}
        </nav>
        <div class="settings-main">
          <div class="settings-main-context"></div>
          <div class="settings-sections" aria-live="polite"></div>
          <p class="settings-footer"></p>
        </div>
      </div>
    </div>
  </div>`)

  const saveButton = root.querySelector('[data-settings-save]')
  const discardButton = root.querySelector('[data-settings-discard]')
  const draftStatus = root.querySelector('[data-settings-draft-status]')
  // The category rail clears the complete sticky command bar, including
  // wrapped mode descriptions and save status at larger text sizes.
  const saveBar = root.querySelector('.settings-command-bar')
  const saveBarObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const stickyHeight = getComputedStyle(saveBar).position === 'sticky' ? saveBar.offsetHeight : 0
    root.style.setProperty('--settings-save-height', `${stickyHeight}px`)
  }) : null
  saveBarObserver?.observe(saveBar)
  updateDraftStatus = () => {
    saveButton.disabled = !draft.dirty || !draft.valid || draft.saving || maintenanceBusy || workingProfileBusy
    discardButton.disabled = !draft.dirty || draft.saving || maintenanceBusy || workingProfileBusy
    root.dataset.settingsDirty = String(draft.dirty)
    savedMaintenanceController.afterRender()
    root.dataset.settingsSaveState = maintenanceBusy || workingProfileBusy || draft.saving ? 'busy' : !draft.valid ? 'invalid' : draft.dirty ? 'pending' : 'saved'
    draftStatus.textContent = workingProfileBusy ? 'Preparing profile changes…' : maintenanceBusy ? 'Complete the maintenance operation before changing settings.' : draft.saving ? 'Saving settings…' : !draft.valid
      ? `Correct the highlighted value before saving. ${draft.errors[0].message}`
      : draft.dirty ? `${draft.size} unsaved ${draft.size === 1 ? 'change' : 'changes'}. Save when you are ready.` : 'Changes take effect after you save.'
    sectionsNode.inert = draft.saving || maintenanceBusy || workingProfileBusy
    root.querySelector('.settings-toolbar').inert = draft.saving || maintenanceBusy || workingProfileBusy
    root.querySelector('[data-settings-quick]').inert = draft.saving || maintenanceBusy
    auditController.syncDraft()
    workingProfileController.sync()
    quickSlidersController.sync()
  }
  saveButton.addEventListener('click', async () => {
    if (!draft.dirty || !draft.valid || draft.saving || maintenanceBusy || workingProfileBusy) return
    let completionRevision = null
    try {
      await draft.save()
      if (destroyed) return
      completionRevision = draftRevision
      for (const setting of SETTINGS) syncSetting(setting.id)
      await researchController.refreshSaved()
      // Writes settle before this readback. A successor draft or retired view
      // owns its own status and must not inherit the older Save's reload.
      if (destroyed || completionRevision !== draftRevision) return
      resourceController.refreshSaved()
      treeContextController.refreshSaved()
      await Promise.all([workingProfileController.refresh(), quickSlidersController.refresh(), diagnosticController.refreshSaved()])
      if (destroyed || completionRevision !== draftRevision) return
      draftStatus.textContent = draft.warning || 'Settings saved.'
      if (draft.reloadRequired) window.location.reload()
    }
    catch (error) {
      if (destroyed || (completionRevision !== null && completionRevision !== draftRevision)) return
      completionRevision = draftRevision
      for (const setting of SETTINGS) syncSetting(setting.id)
      await researchController.refreshSaved()
      if (destroyed || completionRevision !== draftRevision) return
      resourceController.refreshSaved()
      treeContextController.refreshSaved()
      await Promise.all([workingProfileController.refresh(), quickSlidersController.refresh(), diagnosticController.refreshSaved()])
      if (destroyed || completionRevision !== draftRevision) return
      draftStatus.textContent = settingsSaveFailureMessage(error, draft)
    }
  })
  discardButton.addEventListener('click', () => {
    draft.discard()
    // A successful profile write can precede a refused later setting. Its
    // reload still belongs to the committed prefix after the rest is discarded.
    if (draft.reloadRequired) { window.location.reload(); return }
    rebuildRequested = true
    navigate(location.hash)
    window.dispatchEvent(new Event('hashchange'))
  })
  const onBeforeUnload = event => {
    if (!draft.dirty && !draft.saving && !maintenanceBusy && !workingProfileBusy) return
    draftStatus.textContent = maintenanceBusy ? 'Wait for the maintenance operation to finish before closing.'
      : draft.saving ? 'Wait for settings to finish saving before closing.'
      : 'Save or discard your Settings changes before closing.'
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  const searchInput = root.querySelector('.settings-search input')
  const sectionsNode = root.querySelector('.settings-sections')
  const contextNode = root.querySelector('.settings-main-context')
  const quickNode = root.querySelector('[data-settings-quick]')
  const footer = root.querySelector('.settings-footer')
  const rail = root.querySelector('.settings-rail')
  let railRevealFrame = null
  const levels = new Map(SECTIONS.map(section => [section, 1]))
  let query = ''
  let personalSection = activeSection === ENTERPRISE_SECTION ? DEFAULT_CATEGORY : activeSection
  const modeController = createSettingsMode({ root, onChange: mode => {
    landing = null
    root.dataset.settingsLanding = 'false'
    for (const row of sectionsNode.querySelectorAll('.is-landed')) row.classList.remove('is-landed')
    for (const section of SECTIONS) levels.set(section, mode === 'expert' ? 4 : 2)
    if (mode === 'enterprise') {
      if (activeSection !== ENTERPRISE_SECTION) personalSection = activeSection
      query = ''; searchInput.value = ''
      if (location.hash !== categoryHref(ENTERPRISE_SECTION)) { navigate(categoryHref(ENTERPRISE_SECTION)); return }
      renderCurrent()
    } else if (activeSection === ENTERPRISE_SECTION) {
      navigate(categoryHref(personalSection)); return
    }
    syncSectionDepth(activeSection)
    // Mode gates change visibility without remounting the resource panel.
    resourceController.afterRender(root)
    updateFooter()
  } })
  for (const section of SECTIONS) levels.set(section, modeController.mode === 'expert' ? 4 : 2)
  let segCleanups = []
  let archiveController

  function syncArchiveControl(state = archiveController?.getState()) {
    if (!state) return
    for (const row of root.querySelectorAll('[data-setting-id="ledger_archive"]')) {
      const button = row.querySelector('button[data-setting-action="ledger-archive"]')
      const message = row.querySelector('[data-setting-message]')
      if (button) {
        button.textContent = state.label
        button.disabled = !state.enabled
        button.title = readerSentence(state.note)
        button.setAttribute('aria-label', `${state.label}: ${readerSentence(state.note)}`)
        button.classList.toggle('is-confirming', state.phase === 'confirm')
        button.classList.toggle('is-pending', state.phase.startsWith('pending'))
        button.classList.toggle('is-success', state.phase === 'success')
      }
      if (message) message.textContent = readerSentence(state.message)
    }
  }

  archiveController = createLedgerArchiveController({ onState: syncArchiveControl })

  /* ONE DIALOG AT A TIME, AND IT CLEANS UP AFTER ITSELF. The host node is
     created on open and removed on close rather than left in the document
     hidden: a role="dialog" with aria-modal sitting inertly in the tree is
     announced to a screen reader as though it were open, which is the note
     owner-popup.js already carries about this exact mistake. */
  let mirrorSetup = null
  function openCloudMirrorSetup() {
    if (mirrorSetup) return
    const host = document.createElement('div')
    document.body.appendChild(host)
    mirrorSetup = createCloudMirrorSetup({
      documentRef: document,
      postAction: postBridgeAction,
      chooseDirectory: globalThis.mcFleetProfile?.chooseDirectory
        ? () => globalThis.mcFleetProfile.chooseDirectory()
        : null,
      onClose: () => { host.remove(); mirrorSetup = null },
    })
    mirrorSetup.open(host)
  }

  /* THE COMPARE WINDOW, mounted the same way and for the same reason as the
     mirror dialog above: a role="dialog" left in the tree while closed is
     announced as though it were open. The mounting itself lives in
     src/diff-editor.js so it can be driven rather than read -- including the
     part this page owes it, which is closing it in destroy() below. It is
     offered only where it can actually work: the bridge in
     shell/fleet-profile-preload.cjs exists in the installed application and not
     in a browser preview, and the row says so rather than opening a window with
     two dead panes in it. */
  const compareFiles = createCompareFilesDoor()

  function cleanupControls() {
    for (const cleanup of segCleanups) cleanup()
    segCleanups = []
  }

  function wireControls() {
    cleanupControls()
    // Wrapped theme/font choices use each button's pressed state. The sliding
    // indicator is only sized for the ordinary single-row segments.
    for (const group of sectionsNode.querySelectorAll('.settings-seg:not(.theme-seg)')) segCleanups.push(attachSeg(group))
    for (const input of sectionsNode.querySelectorAll('input[type="range"]')) rangeFill(input)
    syncArchiveControl()
    transcriptController.afterRender()
    savedMaintenanceController.afterRender()
    diagnosticController.afterRender()
    profileController.afterRender(root)
    setupController.afterRender(root)
    chatboxController.afterRender(root)
    researchController.afterRender(root)
    connectController.afterRender(root)
    updateController.afterRender(root)
    void roleColorController.afterRender(root)
    handController.afterRender(root)
    screenController.afterRender(root)
    resourceController.afterRender(root)
    auditController.afterRender(root)
    treeContextController.afterRender(root)
    accessibilityControls?.attach(root.querySelector('[data-accessibility-settings]'))
    mountThisComputer()
    mountVaultCredentials()
  }

  /* THE SOCKETS ARE FILLED IN THE SAME SYNCHRONOUS BLOCK THE COLUMN WAS DRAWN
     IN. Between `sectionsNode.innerHTML = ...` and this call nothing awaits, so
     the section's element is never detached across a turn and a read that lands
     in between cannot find itself painting into nothing. */
  function mountThisComputer() {
    const programs = sectionsNode.querySelector('[data-settings-mount="this-computer-programs"]')
    const composer = sectionsNode.querySelector('[data-settings-mount="this-computer-feedback"]')
    if (!programs && !composer) return
    const controller = ensureThisComputer()
    if (programs) programs.appendChild(controller.el)
    if (composer) {
      composer.appendChild(controller.feedbackEl)
      composer.hidden = !thisComputerFeedbackOpen
      const button = sectionsNode.querySelector('button[data-setting-action="this-computer-feedback"]')
      button?.setAttribute('aria-expanded', thisComputerFeedbackOpen ? 'true' : 'false')
    }
  }

  /* THE VAULT PANEL, MADE ON THE FIRST RENDER THAT ACTUALLY SHOWS IT.
   *
   * Same rule and same reason as ensureThisComputer above: building it asks the
   * main process to run a PowerShell program against the encrypted store, and
   * somebody who opened Appearance has asked nothing about his credentials. So
   * the controller is constructed the first time the Data & Privacy socket is
   * in the column, and a visit that never opens that category never touches the
   * vault.
   *
   * ONE ELEMENT, REUSED, for the third reason that comment gives: this column is
   * rebuilt whenever anything repaints it, and re-creating the panel would drop
   * a removal the owner is part-way through approving -- which is the one state
   * on this screen that is expensive to lose.
   *
   * THE FIRST READ IS FIRE-AND-FORGET ON PURPOSE. refresh() paints into its own
   * element and guards on its own destroyed flag, so a read that lands after
   * the person has navigated away does nothing; awaiting it here would make
   * drawing the category wait on a spawned process. */
  let vaultCredentials = null
  function mountVaultCredentials() {
    const socket = sectionsNode.querySelector('[data-settings-mount="vault-credentials"]')
    if (!socket) return
    if (!vaultCredentials) {
      vaultCredentials = createVaultCredentialsSettings()
      void vaultCredentials.refresh()
    }
    socket.appendChild(vaultCredentials.element)
  }

  /* THE ARITHMETIC CAME OUT, AND THE PROMISE STAYED.
   *
   * The footer used to read "N settings · M shown · search finds the hidden
   * ones too". Both numbers were wrong and neither was useful. MEASURED: 21
   * rows drawn under a claim of 17, because five section controllers each
   * declare a constant count that nobody re-derives when a row is added or
   * removed -- and with the groups collapsed the last line of the page read
   * "37 settings · 0 shown", which is a page telling a person it is empty.
   * Nobody has ever needed the total. What the sentence was FOR is the last
   * clause: that a row you cannot see is still findable. That part is true, is
   * the only part anyone acts on, and is all that is left.
   *
   * The sentence names what is off screen NOW. It used to say "inside closed
   * groups", which was the whole truth while the page was one long document
   * with collapsed groups in it; the page is one category at a time, so the
   * rows a person cannot see are the ones in the other eleven. */
  function updateFooter() {
    footer.textContent = 'This page shows one category at a time. Search looks through all of them.'
      + (landing && !query.trim() ? ' The linked setting is shown even when it is outside your browsing mode.' : '')
  }

  /* WHERE YOU ARE, WRITTEN BY WHOEVER PAINTED THE COLUMN UNDER IT.
   *
   * This marker was built into the page's template once, at construction, and
   * never written again -- so it went on naming one group and counting the
   * categories in it while a search underneath it was drawing rows out of all
   * twelve, directly above a footer that says in words that search looks
   * through all of them. A marker allowed to hold an answer the column below it
   * has moved on from is the same defect the rail was rebuilt to end: two parts
   * of one screen with two ideas of what the screen is showing.
   *
   * So it is not markup any more, it is a render: renderCategory() and
   * renderSearch() are the only two things that decide what the main column is,
   * and each of them says so here in the same breath.
   *
   * THE NAME IS ON THE `nav`, NOT ON THE WRAPPER. `aria-label` is discarded on
   * an element whose role is generic -- a `div` with no role cannot be named --
   * so the label the wrapper used to carry reached nothing at all. A `nav` can
   * hold one, and the step naming the page you are on carries aria-current so
   * the trail also says which of its parts is the here. */
  function contextMarkup() {
    const trail = query.trim()
      ? [{ label: 'Search', here: true }]
      : [
        ...(activeGroup ? [{ label: activeGroup.label, here: false }] : []),
        { label: activeSection, here: true },
      ]
    const steps = [{ label: 'Settings', here: false }, ...trail].map(step => (
      `<span${step.here ? ' aria-current="page"' : ''}>${escapeHtml(step.label)}</span>`
    )).join('<span class="settings-breadcrumb-separator" aria-hidden="true">›</span>')
    const copy = query.trim()
      ? `across all ${categoryCount} categories`
      : `${activeGroupCount} categor${activeGroupCount === 1 ? 'y' : 'ies'} in this group`
    return `<nav class="settings-breadcrumb" aria-label="Where you are in Settings">${steps}</nav>
      <p class="settings-main-context-copy">${query.trim() ? copy : escapeHtml(CATEGORY_DETAILS[activeSection] || '')}</p>`
  }

  function syncContext() {
    contextNode.innerHTML = contextMarkup()
  }

  /* THE QUICK STRIP BELONGS TO THE LANDING PAGE, NOT TO EVERY CATEGORY.
   *
   * Owner, 2026-09-15: the sliders should be "easily accessible on the
   * settings landing page". The landing page is the section Settings opens on
   * -- DEFAULT_CATEGORY, "This computer" -- and that is the whole of the ask.
   *
   * MEASURED, which is why this is a rule and not a preference. Drawn above
   * every category, the strip stacks to about 1300px at a 600px content width
   * (one column, six cells), and tools/test/settings-readability-layout.test.mjs
   * recorded the first row of the chosen category moving from y=816 to y=2139
   * on a 1000px-tall window. A person who has navigated INTO a category has
   * gone there to edit one of its rows, and would scroll past the entire strip
   * to reach the first one. So the strip is drawn where a person lands and is
   * absent once they have chosen a category to work in; the rows each slider
   * sets keep their own controls in their own categories either way.
   *
   * Search is its own mode: results span every category, so the strip stands
   * down there too and the matches start at the top.
   *
   * HIDDEN, NOT UNBOUND. The controller keeps its subscription and its staged
   * values, so a slider moved on the landing page stays staged, stays in the
   * save bar, and is applied by Save settings from wherever the person is. */
  function syncQuickStrip() {
    if (!quickNode) return
    const landingPage = !query.trim() && activeSection === DEFAULT_CATEGORY
    quickNode.hidden = !landingPage
    /* NOT `settingsQuick`: that is the section's own marker, and writing the
       same name on the page root made `[data-settings-quick]` match the root
       first -- a state flag quietly shadowing the element it described. */
    root.dataset.quickStrip = landingPage ? 'landing' : 'away'
  }

  function syncRail() {
    root.querySelector('[data-settings-category-picker]').value = activeSection
    let activeGroup = groupOfSection(activeSection)
    for (const head of rail.querySelectorAll('button[data-rail-group]')) {
      head.classList.toggle('is-active', activeGroup?.id === head.dataset.railGroup)
    }
    for (const button of rail.querySelectorAll('button[data-category]')) {
      const on = button.dataset.category === activeSection
      button.classList.toggle('is-active', on)
      if (on) button.setAttribute('aria-current', 'location')
      else button.removeAttribute('aria-current')
    }
    if (railRevealFrame !== null) cancelAnimationFrame(railRevealFrame)
    railRevealFrame = requestAnimationFrame(() => {
      railRevealFrame = null
      const selected = rail.querySelector('[aria-current="location"]')
      // Only move the horizontal category strip; keep the page and its search
      // field where the person left them when a category route is rebuilt.
      revealHorizontalSelection(rail, selected)
    })
  }

  function sectionNodeMarkup(section) {
    if (section === ENTERPRISE_SECTION) return settingsModePanel(researchController.markup({ section }), ENTERPRISE_SECTION, 'enterprise')
    if (section === 'Accessibility') return `<section class="settings-section" data-settings-section="Accessibility">
      <h2 class="settings-section-title">Accessibility</h2>
      <p class="settings-desc">Choose an agent for hands-free control. Changes here take effect immediately; each request asks for your confirmation.</p>
      <div data-accessibility-settings><p>Open the ToolsEnabled desktop app to use accessibility controls.</p></div>
    </section>`
    if (section === CHATBOX_SECTION) return chatboxController.markup()
    if ([TOOL_SECTION, AGENT_SECTION, RESEARCH_SECTION, LOCAL_MODELS_SECTION].includes(section)) return researchController.markup({ section })
  /* The same controller, asked for its other heading. One controller because
     there is one writer and one list of rows behind both; two headings because
     a person looking for the model that answers them would not look under
     research. */

    /* System is two controllers: the fleet profile, then the update-check
       row under it. Both carry data-settings-section="System", and the
       lookups in this file take the first, which is the profile. */
    if (section === 'System') return settingsModePanel(profileController.markup() + updateController.markup() + researchController.markup({ section: 'System', embedded: true }), 'System configuration')
    if (section === 'Resources') return settingsModePanel(resourceController.markup(), 'Resources')
    if (section === RULES_SECTION) return researchController.markup({ section }) + sectionMarkup(section, levels.get(section))
    if (section === 'Setup') return setupController.markup()
    if (section === CONNECT_SECTION) return connectController.markup() + remoteComputerController.markup()
    if (section === 'Data & Privacy') return sectionMarkup(section, levels.get(section)) + settingsModePanel(transcriptController.markup(), 'Transcript archive') + savedMaintenanceController.markup() + researchController.markup({ section, embedded: true }) + settingsModePanel(diagnosticController.markup(), 'Diagnostic files') + settingsModePanel(auditController.markup(), 'Audit signing identity', 'expert')
    if (section === 'App permissions') return screenController.markup() + sectionMarkup(section, levels.get(section)) + settingsModePanel(permissionController.markup(), 'Agent permission profiles', 'expert')
    if (section === 'Appearance') return sectionMarkup(section, levels.get(section)) + treeContextController.markup() + settingsModePanel(roleColorController.markup(), 'Agent role colors')
    if (section === 'Motion & Effects') return sectionMarkup(section, levels.get(section)) + settingsModePanel(handController.markup(), 'Hand controls')
    return sectionMarkup(section, levels.get(section))
  }

  /* THE COUNTING CAME OUT WITH THE LONG DOCUMENT. `countShown()` added up every
     section in an open group, which was an answer to "how much of this page can
     you see" -- a question a page showing one category does not have. Nothing
     read the number: the footer stopped printing it when the arithmetic was
     found to be wrong (see updateFooter above), and it had been kept up to date
     ever since for no reader at all. */

  /* The groups nest the rail and nothing else now. Opening one is a menu
     opening, so it moves no section on or off the screen -- that is what the
     address does. */
  function syncRailGroups() {
    for (const wrap of rail.querySelectorAll('[data-rail-group-wrap]')) {
      const open = openGroups.has(wrap.dataset.railGroupWrap)
      wrap.classList.toggle('is-open', open)
      const head = wrap.querySelector('[data-rail-group]')
      head?.setAttribute('aria-expanded', open ? 'true' : 'false')
      const glyph = head?.querySelector('.settings-reveal-glyph')
      if (glyph) glyph.textContent = open ? '⌃' : '⌄'
      const list = wrap.querySelector('.settings-rail-sections')
      if (list) list.hidden = !open
    }
  }

  function setGroupOpen(id, open, { remember = true } = {}) {
    if (open) { openGroups.add(id); filedGroups.add(id) }
    else { openGroups.delete(id); filedGroups.delete(id) }
    if (remember) writeOpenGroups(filedGroups, globalThis.localStorage)
    syncRailGroups()
  }

  /* ONE CATEGORY, AND NO PART OF ANY OTHER.
     The section markup is the same markup it always was; what changed is that
     the page asks for one of them instead of all twelve. The tier reveals
     inside it, the landing mark and every controller still run over exactly
     what is on the screen. */
  function renderCategory() {
    root.dataset.settingsSearch = 'false'
    root.dataset.settingsLanding = landing ? 'true' : 'false'
    sectionsNode.innerHTML = sectionNodeMarkup(activeSection)
    // `inert` is the primary guard; the explicit tabindex pass keeps closed
    // tiers unreachable in older engines while preserving the CSS reveal.
    syncSectionDepth(activeSection)
    wireControls()
    for (const setting of SETTINGS) syncSetting(setting.id)
    syncContext()
    syncQuickStrip()
    updateFooter()
    syncRail()
    markLanding()
  }

  function renderSearch() {
    root.dataset.settingsSearch = 'true'
    syncQuickStrip()
    const normalized = query.trim().toLowerCase()
    /* The capabilities and risks are searched too. A person who types "risk" is
       asking the one question this lane exists to answer, and a search that
       matched only the row's own name would send them away empty from a page
       that has the answer on every row. */
    const matches = SETTINGS.filter(setting => matchesSettingQuery(normalized, searchHaystack(setting)))
    const transcriptMatches = transcriptController.matches(normalized)
    const savedMaintenanceMatches = savedMaintenanceController.matches(normalized)
    const diagnosticMatches = diagnosticController.matches(normalized)
    const permissionMatches = permissionController.matches(normalized)
    const profileMatches = profileController.matches(normalized)
    const setupMatches = setupController.matches(normalized)
    const chatboxMatches = chatboxController.matches(normalized)
    const researchMatches = researchController.matches(normalized)
    /* FIRST IN THE RESULTS, for the same reason it is first in its group: the
       person most likely to type "connect", "code" or "account" into this box is
       the one who has just signed up and cannot find this. */
    const connectMatches = connectController.matches(normalized)
    const updateMatches = updateController.matches(normalized)
    const roleColorMatches = roleColorController.matches(normalized)
    const handMatches = handController.matches(normalized)
    const screenMatches = screenController.matches(normalized)
    const resourceMatches = resourceController.matches(normalized)
    const auditMatches = auditController.matches(normalized)
    const treeContextMatches = treeContextController.matches(normalized)
    const businessMatches = enterpriseMatches(normalized)
    const accessibilityMatches = matchesSettingQuery(normalized, 'accessibility hands-free voice control agent desktop confirmation')
    sectionsNode.innerHTML = `<section class="settings-results">
      <h2 class="settings-section-title">Results</h2>
      ${businessMatches ? enterpriseSearchMarkup() : ''}
      ${connectMatches ? connectController.markup({ searchResult: true }) + remoteComputerController.markup() : ''}
      ${chatboxMatches ? chatboxController.markup({ searchResult: true }) : ''}
      ${PRODUCT_SECTIONS.filter(section => researchController.matches(normalized, section)).map(section => researchController.markup({ searchResult: true, section, query: normalized })).join('')}
      ${profileMatches ? profileController.markup({ searchResult: true }) : ''}
      ${updateMatches ? updateController.markup({ searchResult: true }) : ''}
      ${resourceMatches ? resourceController.markup({ searchResult: true }) : ''}
      ${auditMatches ? settingsModePanel(auditController.markup(), 'Audit signing identity', 'expert') : ''}
      ${treeContextMatches ? treeContextController.markup() : ''}
      ${setupMatches ? setupController.markup({ searchResult: true }) : ''}
      ${roleColorMatches ? roleColorController.markup() : ''}
      ${handMatches ? handController.markup() : ''}
      ${screenMatches ? screenController.markup() : ''}
      ${accessibilityMatches ? sectionNodeMarkup('Accessibility') : ''}
      ${transcriptMatches ? transcriptController.markup() : ''}
      ${savedMaintenanceMatches ? savedMaintenanceController.markup() : ''}
      ${diagnosticMatches ? settingsModePanel(diagnosticController.markup(), 'Diagnostic files') : ''}
      ${permissionMatches ? settingsModePanel(permissionController.markup(), 'Agent permission profiles', 'expert') : ''}
      ${matches.map(setting => rowMarkup(setting, true)).join('')}
      ${businessMatches || transcriptMatches || savedMaintenanceMatches || diagnosticMatches || permissionMatches || connectMatches || profileMatches || updateMatches || resourceMatches || auditMatches || treeContextMatches || setupMatches || chatboxMatches || researchMatches || roleColorMatches || handMatches || screenMatches || accessibilityMatches || matches.length ? '' : '<p class="settings-empty">No settings match this search.</p>'}
    </section>`
    wireControls()
    for (const setting of SETTINGS) syncSetting(setting.id)
    syncContext()
    updateFooter()
  }

  function renderCurrent() {
    if (query.trim()) renderSearch()
    else renderCategory()
  }

  function rowDraftKey(id, theme = currentTheme()) {
    return byId.get(id)?.type === 'color' ? `row:${id}:${theme}` : `row:${id}`
  }

  function syncSetting(id, value = draft.value(rowDraftKey(id), readValue(byId.get(id)))) {
    const setting = byId.get(id)
    if (!setting) return
    for (const row of root.querySelectorAll(`[data-setting-id="${id}"]`)) {
      const pending = draft.has(rowDraftKey(id)) || numericEdits.has(id)
      row.dataset.settingPending = String(pending)
      const mark = row.querySelector('[data-local-pending]')
      if (mark) mark.hidden = !pending
      for (const button of row.querySelectorAll('button[data-setting-value]')) {
        const on = sameValue(button.dataset.settingValue, value)
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', on ? 'true' : 'false')
      }
      const checkbox = row.querySelector('.settings-toggle input')
      if (checkbox) checkbox.checked = Boolean(value)
      const color = row.querySelector('[data-setting-color]')
      if (color && setting.type === 'color') color.value = resolvedHomeStatusColor(setting.status, currentTheme(), value)
      const colorTheme = setting.type === 'color' && row.querySelector('[data-color-theme]')
      if (colorTheme) colorTheme.textContent = `${currentTheme()} theme`
      /* The state sentence moves with the switch, in the same frame, so the
         two can never be read disagreeing. */
      const stateNode = row.querySelector('[data-setting-state]')
      if (stateNode && setting.type === 'toggle') {
        stateNode.textContent = readerSentence(toggleStateSentence({
          value: Boolean(value),
          def: setting.def,
          acts: writeSettingActions.has(setting.id),
        }))
      }
      const range = row.querySelector('input[type="range"]')
      if (range) {
        range.value = value
        syncNumericRange(range, setting.unit)
      }
      const exact = row.querySelector('[data-setting-number]')
      if (exact) {
        const edit = numericEdits.get(id)
        const display = String(edit?.text ?? value)
        if (exact.value !== display) exact.value = display
        for (const input of [exact, range].filter(Boolean)) input.setAttribute('aria-invalid', String(Boolean(edit?.error)))
        exact.setCustomValidity(edit?.error || '')
        row.dataset.settingInvalid = String(Boolean(edit?.error))
        const error = row.querySelector('[data-setting-number-error]')
        error.textContent = edit?.error || ''; error.hidden = !edit?.error
        row.querySelector('[data-setting-number-context]').textContent = `${pending ? 'Unsaved · ' : ''}Saved: ${formatValue(setting, readValue(setting))} · Default: ${formatValue(setting, setting.def)}`
      }
      const output = row.querySelector('[data-setting-output]')
      if (output) output.textContent = formatValue(setting, value)
    }
  }

  function applyValue(setting, value) {
    if (!setting) return
    numericEdits.delete(setting.id)
    const theme = currentTheme(), key = rowDraftKey(setting.id, theme)
    if (sameValue(value, readValue(setting))) draft.unstage(key)
    else draft.stage(key, value, next => commitValue(setting, next, theme))
    syncSetting(setting.id, value)
  }

  function commitValue(setting, value, colorTheme = currentTheme()) {
    if (setting.id === 'example_mode') {
      /* setExampleMode owns the storage and announces the change itself
         (DATA_SOURCE_EVENT), which is what makes every open screen re-resolve
         its source; this page only repaints its own row below. */
      value = setExampleMode(Boolean(value))
    } else if (writeSettingActions.has(setting.id)) {
      value = setWriteEnabled(writeSettingActions.get(setting.id), Boolean(value))
    } else if (setting.id === 'theme') {
      localStorage.setItem('mc.theme', String(value))
      document.documentElement.dataset.theme = String(value)
      setDrawerSegment('#theme-seg', 'theme', value)
    } else if (setting.id === 'ui_font') {
      value = normalizeFontId(String(value))
      localStorage.setItem(FONT_STORAGE_KEY, value)
      applyFontChoice(value)
      setDrawerSegment('#font-seg', 'font', value)
    } else if (setting.id === 'home_circle_style') {
      value = setHomeCircleStyle(value)
    } else if (setting.id === 'home_circle_motion') {
      value = setHomeCircleMotion(value)
    } else if (setting.type === 'color') {
      value = setHomeStatusColor(setting.status, value, { theme: colorTheme })
    } else if (setting.id === 'text_size') {
      /* THE ZOOM AND THE --zoom PROPERTY THE LAYOUT DIVIDES BY ARE ONE WRITE.
         src/text-size.js applies both or refuses the value, and a size this
         product does not offer is kept out of storage as well. That matters
         beyond tidiness: --zoom is a number the sheets DIVIDE BY, and a
         non-number substituted into one of those calc()s does not fall back
         to the `var(--zoom, 1)` default — it makes the whole declaration
         invalid at computed-value time, so the max-height that was keeping a
         dialog inside the window becomes `none`. */
      const normalized = normalizeTextSize(value)
      if (normalized === null) throw new Error('Choose one of the available text sizes.')
      value = String(normalized)
      localStorage.setItem(TEXT_SIZE_KEY, value)
      applyTextSize(normalized)
      setDrawerSegment('#text-seg', 'text', value)
    } else if (setting.id === 'glow') {
      const number = clampNumber(setting, value)
      /* WRITTEN DOWN, NOT ONLY APPLIED. Without this the slider moved, the page
         changed, and the choice was gone at the next launch. */
      rememberAppearance(GLOW_SETTING_ID, number)
      document.documentElement.style.setProperty('--glow', String(number / 100))
      const drawerRange = document.getElementById('set-glow')
      if (drawerRange) {
        drawerRange.value = number
        const percent = ((number - Number(drawerRange.min)) / (Number(drawerRange.max) - Number(drawerRange.min))) * 100
        drawerRange.style.setProperty('--fill', `${percent}%`)
      }
      value = number
    } else if (setting.id === 'reduce_motion') {
      value = Boolean(value)
      rememberAppearance(REDUCE_MOTION_SETTING_ID, value)
      document.body.classList.toggle('reduce-motion', value)
      const drawerToggle = document.getElementById('set-motion')
      if (drawerToggle) drawerToggle.checked = value
    } else {
      writeStored(setting, value)
    }
    syncSetting(setting.id, value)
  }

  function syncSectionDepth(section) {
    const sectionNode = [...sectionsNode.querySelectorAll('.settings-section')]
      .find(node => node.dataset.settingsSection === section)
    if (!sectionNode) return
    const level = levels.get(section)
    for (let depth = 2; depth <= 4; depth += 1) {
      const tier = sectionNode.querySelector(`[data-tier-depth="${depth}"]`)
      if (!tier) continue
      const open = level >= depth
      tier.classList.toggle('is-open', open)
      tier.setAttribute('aria-hidden', open ? 'false' : 'true')
      setTierFocusable(tier, open)

      const button = sectionNode.querySelector(`button[data-reveal-depth="${depth}"]`)
      if (!button) continue
      const count = button.dataset.revealCount
      const prefix = button.dataset.revealPrefix
      button.setAttribute('aria-expanded', open ? 'true' : 'false')
      button.innerHTML = revealInner(prefix, count, open)
    }
  }

  function cycleValue(setting, current, delta) {
    if (setting.type === 'select') {
      const options = optionRecords(setting)
      const index = Math.max(0, options.findIndex(option => sameValue(option.value, current)))
      return options[(index + delta + options.length) % options.length].value
    }
    const next = Number(current) + delta * setting.step
    return clampNumber(setting, Number(next.toFixed(4)))
  }

  sectionsNode.addEventListener('click', event => {
    /* The one one-press section control. It goes through applyValue, the
       same door every individual switch uses, so the write, the store and the
       row repaint are exactly what a row-by-row walk would have done. (Data &
       Sim's bulk pair is gone: its one switch reaches every screen already --
       see BULK_ROWS.) */
    if (event.target.closest('button[data-bulk-write-off]')) {
      for (const flag of WRITE_ACTION_FLAGS) applyValue(byId.get(`write_${flag.id}`), false)
      return
    }

    const mirrorButton = event.target.closest('button[data-setting-action="cloud-mirror-setup"]')
    if (mirrorButton) {
      openCloudMirrorSetup()
      return
    }

    const compareButton = event.target.closest('button[data-setting-action="compare-files"]')
    if (compareButton) {
      compareFiles.open()
      return
    }

    /* The composer is revealed by the press rather than drawn open, so the
       section stays four short rows and a person who came here to install Codex
       is not scrolling past a text box. The row itself is already absent unless
       the backend answered, so this press can never open a composer that has
       nowhere to send. */
    const feedbackButton = event.target.closest('button[data-setting-action="this-computer-feedback"]')
    if (feedbackButton) {
      thisComputerFeedbackOpen = !thisComputerFeedbackOpen
      const composer = sectionsNode.querySelector('[data-settings-mount="this-computer-feedback"]')
      if (composer) composer.hidden = !thisComputerFeedbackOpen
      feedbackButton.setAttribute('aria-expanded', thisComputerFeedbackOpen ? 'true' : 'false')
      if (thisComputerFeedbackOpen) composer?.querySelector('[data-feedback-text]')?.focus?.()
      return
    }

    const archiveButton = event.target.closest('button[data-setting-action="ledger-archive"]')
    if (archiveButton) {
      archiveController.click()
      return
    }

    const reveal = event.target.closest('button[data-reveal-section]')
    if (reveal) {
      const section = reveal.dataset.revealSection
      const depth = Number(reveal.dataset.revealDepth)
      levels.set(section, levels.get(section) >= depth ? depth - 1 : depth)
      syncSectionDepth(section)
      return
    }

    const valueButton = event.target.closest('button[data-setting-value]')
    if (valueButton) {
      const row = valueButton.closest('[data-setting-id]')
      applyValue(byId.get(row.dataset.settingId), valueButton.dataset.settingValue)
      return
    }

    const stepButton = event.target.closest('button[data-step-delta]')
    if (stepButton) {
      const row = stepButton.closest('[data-setting-id]')
      const setting = byId.get(row.dataset.settingId)
      const next = cycleValue(setting, draft.value(`row:${setting.id}`, readValue(setting)), Number(stepButton.dataset.stepDelta))
      applyValue(setting, next)
    }
  })

  sectionsNode.addEventListener('input', event => {
    const color = event.target.closest('[data-setting-color]')
    if (color) {
      const setting = byId.get(color.closest('[data-setting-id]')?.dataset.settingId)
      if (setting?.type === 'color') applyValue(setting, color.value)
      return
    }
    const input = event.target.closest('input[type="range"], [data-setting-number]')
    if (!input) return
    const row = input.closest('[data-setting-id]')
    const setting = row ? byId.get(row.dataset.settingId) : null
    if (!setting) return
    const value = Number(input.value)
    input.setCustomValidity('')
    if (input.hasAttribute('data-setting-number') && (!input.value.trim() || !Number.isFinite(value) || value < setting.min || value > setting.max || !input.validity.valid)) {
      const error = `Enter a whole number from ${setting.min} to ${setting.max}${setting.unit || ''}.`
      numericEdits.set(setting.id, { text: input.value, error })
      draft.setError(`row:${setting.id}`, error)
      syncSetting(setting.id)
      return
    }
    applyValue(setting, value)
  })

  sectionsNode.addEventListener('change', event => {
    const input = event.target.closest('.settings-toggle input')
    if (!input) return
    /* A TOGGLE THAT IS NOT A REGISTRY ROW. The research and chatbox sections
       draw `.settings-toggle` switches of their own (research-settings.js,
       chatbox-settings.js) inside this same node, with no [data-setting-id]
       row around them; without this guard their change event reached
       applyValue(undefined) and threw on `setting.id`. The same guard
       syncSetting() already applies (`if (!setting) return`). */
    const row = input.closest('[data-setting-id]')
    const setting = row ? byId.get(row.dataset.settingId) : null
    if (!setting) return
    applyValue(setting, input.checked)
  })

  searchInput.addEventListener('input', () => {
    query = searchInput.value
    renderCurrent()
  })

  rail.addEventListener('click', event => {
    /* A group head opens and closes its own list of categories, and does no
       more than that. It used to jump the long document to the group's first
       section as well; with one category on screen there is nothing under a
       group head to jump to, and a menu that navigated as it opened would be
       two controls wearing one button. */
    const head = event.target.closest('button[data-rail-group]')
    if (head) {
      const id = head.dataset.railGroup
      setGroupOpen(id, !openGroups.has(id))
      return
    }
    const button = event.target.closest('button[data-category]')
    if (!button) return
    /* THE PRESS IS A NAVIGATION. The address decides what this page shows, so
       the press writes the address and the page is built again from it --
       exactly what happens when somebody arrives on the link, presses back, or
       reloads. Nothing here reaches into the document to swap a section: two
       ways to change what is on screen is how the two come to disagree. */
    selectCategory(button.dataset.category)
  })

  root.querySelector('[data-settings-category-picker]').addEventListener('change', event => {
    const section = event.target.value
    // Navigation may be cancelled to preserve an unsaved draft. The current
    // route keeps owning the label until a new page is actually mounted.
    event.target.value = activeSection
    selectCategory(section)
  })

  function selectCategory(section) {
    if (!SECTIONS.includes(section)) return
    const href = categoryHref(section)
    if (location.hash === href) {
      /* Already at this address. The only thing left that can be stale is a
         search covering the category, so pressing the category you are on puts
         the category back. */
      if (query.trim()) {
        query = ''
        searchInput.value = ''
        renderCategory()
      }
      return
    }
    navigate(href)
  }

  /* The row a link named, marked so the eye finds it. Re-applied on every
     render rather than only on the first, because the capability probes answer
     a second or two after this page paints and re-render it -- without this the
     mark a person was following vanished under them. */
  function markLanding() {
    if (!landing) return
    const row = sectionsNode.querySelector(`[data-setting-id="${landing.id}"]`)
    if (row) row.classList.add('is-landed')
  }

  /* INSTANT, NOT SMOOTH, and that is a decision rather than an oversight. The
     row this lands on measured 10170px down the page; a smooth scroll over that
     distance is a long animated journey past two hundred controls, which reads
     as the page running away from the person who followed the link. Arriving is
     what was asked for. */
  let landingFrame = null
  let stopLandingFocus = () => {}
  function scrollToLanding() {
    if (!landing || !landingNeedsFocus) return
    const id = landing.id
    if (landingFrame !== null) cancelAnimationFrame(landingFrame)
    landingFrame = requestAnimationFrame(() => {
      landingFrame = null
      if (destroyed || !landing || landing.id !== id) return
      /* src/settings-landing.js: a row taller than the page is shown from its
         start (T1411), and focus goes only to a control that is on screen,
         waiting briefly for rows whose controls arrive late (T1594). Focus is
         given with preventScroll, because the scroll decides where the page
         sits. */
      stopLandingFocus()
      const landed = landOnRow({
        findRow: () => (!destroyed && landing?.id === id ? sectionsNode.querySelector(`[data-setting-id="${id}"]`) : null),
        visibleBox: () => visibleBoxOf(root),
        doc: document,
        ownsFocus: node => node === root || node?.id === 'stage',
      })
      if (landed === false) return
      stopLandingFocus = landed
      landingNeedsFocus = false
    })
  }

  /* THE SCROLL-SPY IS GONE, AND IT IS THE THING THAT PROVED THE RAIL WAS NOT A
     RAIL. It watched the page scroll and reassigned the highlighted category to
     whichever section had reached the top of the window -- which only makes
     sense over one document holding all twelve, and would now fight the address
     for the answer to "which category is this". The address is the answer. */

  /* The drawer's controls used to be static nodes this view could bind to by
     id; since R1520 the drawer is rebuilt per page at every open, so a node
     bound here would be a dead reference after the next open. The drawer
     announces every applied value instead (src/quick-settings.js), and this
     page re-syncs its copy of that control. */
  const onQuickSetting = (event) => {
    const id = event?.detail?.settingId
    /* THE NEWER CHOICE WINS (T1483). The drawer applies and stores its value at
       once. An older pending page choice for the same row would otherwise be
       written back by the next Save, silently undoing the drawer. */
    if (id && byId.has(id) && !draft.saving) {
      numericEdits.delete(id)
      draft.unstage(rowDraftKey(id))
    }
    if (id && byId.has(id)) syncSetting(id)
    if (id === 'theme') for (const setting of HOME_STATUS_COLOR_SETTINGS) syncSetting(setting.id)
  }
  window.addEventListener(QUICK_SETTING_EVENT, onQuickSetting)

  /* The guided steps say whether the outside thing a setting depends on was
     actually found. Asking costs a round trip, so the page paints first with
     the honest "this copy could not check" and repaints once when the answer
     arrives. Painting a cheerful default while waiting would be the same defect
     in a different coat: a claim about a computer nobody has looked at yet. */
  const onCapabilityProbes = () => { renderCurrent() }
  window.addEventListener(CAPABILITY_PROBE_EVENT, onCapabilityProbes)

  /* THE EXAMPLE ROW'S OWN "cannot succeed" DEPENDS ON previewWithoutHost(),
     which can flip while this page stays open (a computer connects, sign-in
     completes, the toggle changes from the quick-settings drawer). main.js
     deliberately excludes route 'settings' from its own whole-page rebuild on
     this event -- "the settings page keeps its inline controls in place and
     updates them locally" -- so this is that local update; without it the
     example row's disabled state and reason would go stale the moment a host
     the page did not have when it drew becomes one it does. */
  const onDataSourceChanged = () => {
    /* This event invalidates the old public-host answer. Re-ask locally so
       the current category, pending edits and save/retry state survive. The
       desktop/example branches settle synchronously; a public lookup may
       repaint once more when its actual answer arrives. */
    const resolution = resolveDataSource({ reask: true })
    const immediateSource = currentDataSource()
    renderCurrent()
    workingProfileController.sync()
    quickSlidersController.sync()
    void resolution.then(settled => {
      if (!destroyed && settled !== immediateSource) { renderCurrent(); workingProfileController.sync(); quickSlidersController.sync() }
    }).catch(() => {})
  }
  window.addEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)

  transcriptController.bind(root)
  savedMaintenanceController.bind(root)
  diagnosticController.bind(root)
  permissionController.bind(root)
  profileController.bind(root)
  workingProfileController.bind(root)
  quickSlidersController.bind(root)
  /* MEASURED, NOT ASSUMED: neither of these two was bound. `createSetupProfileSettings`
     builds its own click handler and only `bind` attaches it, so every control
     in Settings -> Setup -- the permission level, the working folder, the four
     recorded intents -- rendered, looked live, and did nothing when clicked.
     The seg indicator moved because attachSeg() runs over every `.settings-seg`
     on the page, which is exactly what made it look like it had worked. */
  setupController.bind(root)
  chatboxController.bind(root)
  researchController.bind(root)
  connectController.bind(root)
  remoteComputerController.bind(root)
  updateController.bind(root)
  roleColorController.bind(root)
  handController.bind(root)
  resourceController.bind(root)
  auditController.bind(root)
  treeContextController.bind(root)

  /* LANDING ON THE SWITCH A LINK NAMED, and the reason this is more than a
     scroll.
     MEASURED on the packaged build, following "Turn on agent sessions in
     Settings" from the home screen with a real mouse press: the row it means
     (write_agent-session, "Run an agent session") sat at y=10170 in a 946px
     viewport AND inside a collapsed depth-2 tier carrying `inert`. So it was
     not merely below the fold -- no amount of scrolling reached it, because the
     tier it lives in renders closed and `inert` removes it from hit testing and
     from the tab order. A person who followed that link had to know to open the
     "Write" section's reveal first, which is the one thing the link did not
     say.
     So the section is opened to the depth the row lives at BEFORE the first
     render, which is what makes the row exist un-inert at all, and the scroll
     happens after. Both halves are required; either alone leaves the link
     landing somewhere the control is not.
     THE DEPTH IS STILL REQUIRED; THE DISTANCE IS NOT WHAT IT WAS. The same link
     re-measured on the packaged build 2026-08-27, now that the address carries
     the category as well: the row lands at y=454, because the page holding it
     is the only page drawn. The tier is still closed and still `inert` on
     arrival, so the line below still does the half that matters. */
  if (landing) {
    levels.set(landing.section, Math.max(levels.get(landing.section) || 1, landing.depth))
  }
  renderCategory()
  updateDraftStatus()
  if (landing) scrollToLanding()
  void refreshCapabilityProbes()

  return {
    el: root,
    beforeLeave(nextRoute) {
      if (rebuildRequested) return true
      if (draft.saving || maintenanceBusy || workingProfileBusy) return false
      if (nextRoute?.name === 'settings') {
        landing = requestedSetting(nextRoute.query)
        landingNeedsFocus = Boolean(landing)
        activeSection = requestedCategory(nextRoute.query, landing)
        activeGroup = groupOfSection(activeSection)
        activeGroupCount = activeGroup?.sections.length ?? 0
        if (activeGroup) { openGroups.add(activeGroup.id); syncRailGroups() }
        if (landing) levels.set(landing.section, Math.max(levels.get(landing.section) || 1, landing.depth))
        query = ''
        searchInput.value = ''
        renderCategory()
        if (landing) scrollToLanding()
        else root.scrollTop = 0
        return 'updated'
      }
      if (draft.dirty && !window.confirm('Leave Settings and discard unsaved changes?')) return false
      if (draft.reloadRequired) {
        draft.discard()
        window.location.reload()
        // The document reload owns the selected hash. Keep this view until it
        // lands rather than mounting a successor with the old fleet snapshot.
        return 'updated'
      }
      return true
    },
    destroy() {
      destroyed = true
      stopLandingFocus()
      confirmation.destroy()
      auditController.destroy()
      treeContextController.destroy()
      if (railRevealFrame !== null) cancelAnimationFrame(railRevealFrame)
      window.removeEventListener('beforeunload', onBeforeUnload)
      draft.discard()
      if (landingFrame !== null) cancelAnimationFrame(landingFrame)
      landingFrame = null
      /* THE DIALOG GOES WITH THE PAGE THAT OPENED IT. It is mounted on
         document.body, not inside this view, so nothing else takes it down:
         leaving Settings with it open left a modal over whatever came next.
         That was always true of the arrows; it matters more now that choosing a
         category is a navigation too. close() removes the host through the same
         onClose this view passed in. */
      mirrorSetup?.close()
      /* AND THE COMPARE WINDOW WITH IT, for exactly the reason above. It is the
         same shape and the worse consequence: it is mounted on document.body,
         it listens on document keydown, and it is the only place a person's
         hand edits exist. Left behind it sat over the next page holding them,
         and this view's closure was gone, so the row on the next visit opened a
         second one on top of the first. */
      compareFiles.close()
      cleanupControls()
      modeController.destroy()
      saveBarObserver?.disconnect()
      archiveController.destroy()
      transcriptController.destroy()
      savedMaintenanceController.destroy()
      diagnosticController.destroy()
      permissionController.destroy()
      profileController.destroy()
      workingProfileController.destroy()
      quickSlidersController.destroy()
      setupController.destroy()
      chatboxController.destroy()
      researchController.destroy()
      connectController.destroy()
      remoteComputerController.destroy()
      thisComputer?.destroy()
      vaultCredentials?.destroy()
      updateController.destroy()
      roleColorController.destroy()
      handController.destroy()
      screenController.destroy()
      accessibilityControls?.release(root)
      resourceController.destroy()
      window.removeEventListener(QUICK_SETTING_EVENT, onQuickSetting)
      window.removeEventListener(CAPABILITY_PROBE_EVENT, onCapabilityProbes)
      window.removeEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)
    },
  }
}

/* SIMULATION PACE IS GONE, AND THIS EXPORT IS ITS HEADSTONE, NOT ITS GHOST.
   The `scenario_tick_rate` row this applied at launch drove the retired
   simulation engine's clock (src/sim.js); the demo pace died with that engine
   -- the example the product shows now is data fed through the ordinary
   screens, with no clock of its own to pace. src/main.js still calls this at
   boot, and main.js belongs to the core lane's cutover, so the export stays a
   deliberate no-op until that call is removed -- at which point this function
   is deleted with it, not kept. */
export function applyStoredSimPace() {}

/* Restore durable appearance at launch. Each control persists its own choice
 * before applying it; quick-setting events only synchronize visible controls. */
export function applyStoredAppearance() {
  return applyAppearance()
}
