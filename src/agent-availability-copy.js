/* What the agent page says when a start is refused, one sentence per code.
 *
 * WHY THIS IS ITS OWN MODULE. The shell answers availability with {ok, code}
 * and nothing else: the main-process message names the missing module AND the
 * manifest that should have staged it -- which is exactly the right diagnosis
 * -- but it also names an absolute engine root, and rendering a filesystem path
 * into the DOM is the defect (BLOCKER 2) that removed the message from this
 * path in the first place. So the CODE carries the message's surviving
 * specificity, and this table is where that specificity is spent. A generic
 * "not set up to run agents" beside a disabled control would give a person
 * nothing to do, which is only marginally better than the enabled control it
 * replaced.
 *
 * It is separated from src/agent-session.js so the suite can assert the
 * SENTENCE a code produces rather than that a source file contains a string: a
 * copy test written against source text passes when the table is right and the
 * lookup is wrong, which is the same shape of defect as an availability check
 * nothing reads. src/agent-session.js reaches the DOM through components.js,
 * whose module graph starts the demonstration simulator's timers on import and
 * never lets a plain-node test process exit -- so importing it from a test is
 * not available, and asserting on its text is what a test would fall back to.
 *
 * shell/agent-host.cjs exports AVAILABILITY_CODES; the suite walks that list
 * against this table, so a precondition added to the probe cannot land here as
 * silence.
 */

/* One direction only: this reads the shared remedy table, and that module
   imports nothing. See the note at the head of src/refusal-copy.js for why the
   dependency is not mutual. */
import { readerRemedy, refusalRemedy } from './refusal-copy.js'
import { terminalName } from './terminal-name.js'
import { EDITOR_ATTACHMENT_REFUSALS } from './editor-attachment-copy.js'
/* The section and the control the web-drive refusal walks a person to, read
   from the module that owns them rather than spelled here: a sentence that
   names a switch is only correct while the switch is called that, and the
   drift lock in tools/test/web-drive-refusal.test.mjs holds the two together.
   device-claim-flow.js imports only refusal-copy.js, so there is no cycle. */
import { CONNECT_SECTION, WEB_DRIVE_CONTROL_LABEL } from './device-claim-flow.js'

/* Install from the provider’s current stable channel. The adapter negotiates
   compatible protocol features with the installed CLI, without a version pin. */
export const CODEX_SETUP_COMMANDS = Object.freeze({
  install: 'winget install OpenAI.Codex',
  installWithNode: 'npm install -g @openai/codex',
  signIn: 'codex login',
  /* Codex's own updater. It knows how this copy was installed (its own
     installer, npm, Homebrew) and updates it in place, so it never adds a
     second copy next to the first the way a fresh install command can. */
  update: 'codex update',
})

// Read the platform from the setup bridge, which belongs to the configured
// computer. A browser's user agent describes the viewer, not a remote host.
export function codexSetupInstructions({ platform = globalThis.mcSetup?.platform, viaRelay = false } = {}) {
  const where = viaRelay ? 'On that computer, open' : 'Open'
  const terminal = terminalName(platform)
  const signIn = `${where} ${terminal} and run: ${CODEX_SETUP_COMMANDS.signIn}`
  const install = platform === 'win32'
    ? [
      readerRemedy(`Open Windows Terminal and run: ${CODEX_SETUP_COMMANDS.install}`, { viaRelay }),
      `If Node.js and npm are already installed, you can also run: ${CODEX_SETUP_COMMANDS.installWithNode}`,
    ]
    : platform === 'linux' || platform === 'darwin'
      ? [
        `${where} a terminal. With Node.js and npm installed, run: ${CODEX_SETUP_COMMANDS.installWithNode}`,
        'If Node.js or npm is missing, install Node.js with npm first, then run that command. This installs the current stable Codex CLI.',
      ]
      : [
        readerRemedy(`On Windows, open Windows Terminal and run: ${CODEX_SETUP_COMMANDS.install}`, { viaRelay }),
        readerRemedy(`On Linux or macOS, open a terminal. With Node.js and npm installed, run: ${CODEX_SETUP_COMMANDS.installWithNode}`, { viaRelay }),
        viaRelay ? 'Use the instructions for the computer you are driving, even if your browser is on a different operating system.' : 'Use the instructions for the computer where ToolsEnabled is installed.',
      ]
  return Object.freeze({ terminal, signIn, install: Object.freeze(install) })
}

/* WHICH PART OF THE BUILD IS MISSING, KEPT AS DATA RATHER THAN IN THE SENTENCE.
 *
 * Two entries in the table below used to name a module in brackets, mid-sentence,
 * to a customer: "(agent-session-confinement)" and "(subscription-launch-env)".
 * tools/test/agent-session-surface.test.mjs required them to be there, and its
 * reason was right -- the main-process message that names the missing module ALSO
 * names an absolute engine root, so it can never cross the bridge, and if the
 * name is nowhere then a support conversation about an incomplete build has
 * nothing to go on.
 *
 * The reason was right and the place was wrong. That is the same fact
 * src/refusal-copy.js established for codes: the identifier is a MACHINE FIELD,
 * carried on `data-refusal-code` where a support conversation and a driver can
 * read it, and never in the prose. This is the same rule applied to the module
 * name, and the suite now asserts both halves -- that the name is here, and that
 * it is NOT in the sentence.
 *
 * A person who cannot start an agent because their download was incomplete needs
 * to reinstall. That is the whole of what the sentence has to carry. */
export const MISSING_MODULE = Object.freeze({
  AGENT_CONFINEMENT_UNAVAILABLE: 'agent-session-confinement',
  AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE: 'subscription-launch-env',
})

// Account selection is shared by every provider and by the tree, chat and
// home screen. Keep its remedies together so an IPC refusal stays actionable.
export const ACCOUNT_SELECTION_REFUSALS = Object.freeze({
  ACCOUNT_NONE_USABLE: 'None of this assistant’s listed accounts is ready to run. Open Accounts to check their sign-in and remaining allowance, then start again',
  ACCOUNT_EXHAUSTED_MANUAL: 'The selected account has reached its allowance limit and automatic switching is off. Choose an available account in Accounts, or wait for the allowance to reset',
  ACCOUNTS_REGISTRY_UNREADABLE: 'The saved account list could not be read. Open Accounts to check the list before starting another agent',
  ACCOUNT_STATE_UNREADABLE: 'The saved account selection could not be read. Open Accounts and choose an account before starting again',
  ACCOUNT_RECOVERY_INVALID: 'The requested account recovery could not be verified. Review this agent in Computers and try Continue on another account again',
  ACCOUNT_RECOVERY_NO_ALTERNATE: 'No other eligible account is available for this assistant. Open Accounts to add or sign in to another account, or wait for an existing account to become available',
  ACCOUNT_CLIENT_INVALID: 'The selected account does not match this assistant client. Choose a compatible account or model in Accounts',
  AGENT_ACCOUNT_UNAVAILABLE: 'The selected assistant account could not be checked. Open Accounts to check its sign-in and try again',
})

export const UNAVAILABLE_TEXT = Object.freeze({
  RULES_POLICY_UNAVAILABLE: refusalRemedy('RULES_POLICY_UNAVAILABLE'),
  RULES_CONTEXT_UNAVAILABLE: refusalRemedy('RULES_CONTEXT_UNAVAILABLE'),
  RULES_POLICY_CHANGED: refusalRemedy('RULES_POLICY_CHANGED'),
  ...ACCOUNT_SELECTION_REFUSALS,
  AGENT_START_WORKSPACE_UNCONFIRMED: 'No working folder has been confirmed. On the computer running ToolsEnabled, open Settings → Setup → Working folders, choose a folder and save settings. Then retry this agent',
  AGENT_CLOUD_COMMAND_INVALID: 'The cloud request could not be read. Enter /cloud followed by the work you want done, and check any worker limit you included',
  ...EDITOR_ATTACHMENT_REFUSALS,
  AGENT_TREE_PARENT_UNAVAILABLE: 'This delegated agent’s parent is no longer available. Select a running parent in its tree before starting it again.',
  TREE_DELEGATION_REFUSED: 'The inherited boundary for this delegated agent is unavailable. Start it again from its parent tree after the boundary is restored.',
  AGENT_TOOL_MODE_ROLE_CONFLICT: 'This role needs ToolsEnabled functions, but the chosen tool mode has disabled them. Enable a ToolsEnabled tool mode in Settings, then start a new agent.',
  TOOL_API_DISABLED: 'This session uses native provider tools only. ToolsEnabled API calls are disabled for it. Choose a ToolsEnabled tool mode in Settings and start a new session.',
  AGENT_ENGINE_UNAVAILABLE: 'no agent engine is configured on this installation',
  /* THE ONE A BROWSER DRIVING A COMPUTER ACTUALLY HITS, and it had no entry, so
     "is my agent available?" answered with a shrug -- "this copy could not work
     out why, which is itself a fault worth reporting" -- followed by the desk
     remedy telling them to close an app they are not sitting at. The copy DOES
     know why: the connection that carries this went down. These three are what
     host-bridge.js throws when the relay leg is gone, and they are a state, not
     a fault, so the sentence spends its length on what to do. */
  BRIDGE_UNREACHABLE: 'the connection to that computer is down, so nothing could be asked of it',
  BRIDGE_TIMEOUT: 'that computer did not answer in time, so this could not be read',
  BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN: 'this page is not allowed to reach a computer on this address',
  /* THE BLOCKER A STRANGER ACTUALLY HITS, and for one release the product did
     not even detect it -- it reported ready, enabled Start, and refused every
     press with a bare identifier. Like the sign-out below this is not a fault
     in the install, so the sentence spends its length on the command rather
     than on an apology. */
  /* "Then run codex login" used to end here with no window named, and the
     window a person naturally uses is the one the install just ran in -- which
     cannot see the new program, and answers that codex is not recognized. That
     is the exact dead end the first external user hit from the guide's copy of
     this instruction; src/first-run-needs.js carries the full account. */
  /* Built from CODEX_SETUP_COMMANDS rather than spelled out again. These two
     entries used to carry the commands as literal text, which is the exact
     drift the constants above were introduced to prevent -- and it bit: the
     constants gained a version pin on the npm line while these sentences went
     on telling people to run the unversioned form. */
  AGENT_CODEX_CLI_NOT_INSTALLED: `Codex is not installed on this computer, and Codex is the program that actually runs an agent. Open Windows Terminal and run "${CODEX_SETUP_COMMANDS.install}". If you already have Node, "${CODEX_SETUP_COMMANDS.installWithNode}" does the same job. Then open a new terminal window and run "${CODEX_SETUP_COMMANDS.signIn}"`,
  /* THE MODULE NAME CAME OUT OF THE SENTENCE. It read "(agent-session-confinement)"
     -- an internal file name, in brackets, in the middle of a sentence to a
     customer. It is a support detail, and the person holding the repository has
     the code; the person reading this has a reinstall to do. */
  AGENT_CONFINEMENT_UNAVAILABLE: 'this copy of ToolsEnabled was built without the part that holds a session to your permission level. It will not start one at a level it cannot hold. Reinstall ToolsEnabled from a complete build',
  AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE: 'ToolsEnabled could not establish which Windows account owns this installation, so it refused to load an agent. Close ToolsEnabled and open the copy installed for this Windows account',
  AGENT_CONFINEMENT_WRONG_PRINCIPAL: 'ToolsEnabled is running under a Windows account that does not own this installation, so it refused to load an agent. Close ToolsEnabled and open it from the Windows account that owns it',
  AGENT_CONFINEMENT_FOREIGN_PROFILE: 'This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account',
  AGENT_CONFINEMENT_FOREIGN_PROFILE_ENVIRONMENT: 'This agent start points into a different Windows account, so ToolsEnabled refused it before opening anything there. Open the copy installed for this Windows account and choose a folder owned by this account',
  AGENT_CONFINEMENT_PROFILE_PATH_UNREADABLE: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_PATH_INVALID: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE: 'ToolsEnabled could not safely check an agent path inside this Windows account, so it refused the start. Close ToolsEnabled, check that the account folder is available, and try again',
  AGENT_CONFINEMENT_PROFILE_REPARSE_REFUSED: 'An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account',
  AGENT_CONFINEMENT_PROFILE_REPARSE_POINT: 'An agent path crosses a linked folder inside this Windows account, so ToolsEnabled refused it rather than follow the link. Choose an ordinary folder owned directly by this account',
  AGENT_CONFINEMENT_PROFILE_ENVIRONMENT_INVALID: 'ToolsEnabled could not construct a safe launch environment for this Windows account, so nothing was started. Close ToolsEnabled and open the copy installed for the account that owns it',
  /* NOT A PACKAGING FAULT, and the copy must not read like one. The install is
     complete; the assistant is signed out, and a confined level builds its
     session from that sign-in. This is the one refusal on this list the person
     in front of the screen can actually clear themselves, so it is the one that
     most needs to say what to do. It reaches this table by BOTH routes -- the
     probe returns it, and a start that gets past the probe raises the same code
     through plan.code -- which is why the press used to show the bare
     identifier here too. */
  /* IT NO LONGER SAYS "CODEX IS INSTALLED", because nothing that raises this
     code has checked. DRIVEN on a sealed foreign build 2026-08-19 (cross-machine
     lane): a Claude-only machine with no Codex anywhere pressed Start, the
     no-tier plan raised this code, and the screen asserted an installation that
     did not exist -- then told the person to run a command their shell calls
     not recognized, which is the first external user's exact dead end. What IS
     measured at raise time is the missing sign-in file, so that is the one fact
     the sentence states; both ways out are said conditionally because either
     may be the reader's machine. */
  AGENT_CONFINEMENT_SIGNED_OUT: 'This session needs a Codex sign-in, and this computer does not hold one. The permission level recorded here builds each session from that sign-in. If Codex is installed, open a new terminal window and run "codex login". If it is not, run "winget install OpenAI.Codex" first. Then come back to this screen',
  /* Same repair as the entry above: "(subscription-launch-env)" was a module
     name printed to a customer. The fact that matters to them is the money. */
  AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE: 'this copy of ToolsEnabled was built without the part that keeps a session off your billed account. It will not start one and risk charging you. Reinstall ToolsEnabled from a complete build',
  AGENT_HOST_INVALID_CWD: 'ToolsEnabled cannot use its own workspace folder, so an agent session has nowhere to run',
  AGENT_ACP_REQUIRES_APP_TOOLS: 'Gemini and Grok Research sessions need ToolsEnabled tools only. Choose that tool setting, then start the agent again',
  AGENT_ACP_AMBIENT_TOOLS: 'Grok has extra startup extensions or tools outside Research. Add a separate Grok sign-in without those extensions in Settings, then try again',
  ACCOUNT_CLIENT_UNAVAILABLE: 'Choose an account registered for this assistant client in Accounts',
  PROVIDER_LOGIN_NOT_INSTALLED: 'The program this model needs is not installed on this computer, so the agent was not started. Install it in Settings, under This computer, then start the agent again',
  ACCOUNT_CLIENT_SHARED_SIGN_IN: 'Antigravity uses the current OS sign-in. A second folder does not provide another subscription',
  AGY_CLI_SHARED_AUTH: 'Antigravity cannot provide a separate sign-in inside this isolated session',
  AGY_CLI_AUTH_REQUIRED: 'Open the registered Antigravity sign-in window and finish its normal sign-in, then try again',
  AGY_CLI_BOUNDARY_UNAVAILABLE: 'The Antigravity profile has a conflicting tool registration or extension. Use a dedicated configuration profile for ToolsEnabled',
  AGY_CLI_BOUNDARY_UNCONFIRMED: 'Antigravity did not confirm the selected model or tool configuration, so the session was stopped',
  AGY_CLI_RESUME_MISMATCH: 'Antigravity opened a different conversation, so no work was sent',
  AGY_CLI_EXITED: 'Antigravity closed before completing this conversation. Resume the saved conversation to continue',
  ACP_AUTH_REQUIRED: 'This assistant needs its official sign-in. Open Settings, sign in to that program, then start the agent again',
  ACP_CLIENT_UNSUPPORTED: 'Google no longer supports this Gemini client for your account. Use a supported Google client or choose another assistant here',
  ACP_MODEL_UNAVAILABLE: 'The selected model is not offered by this assistant’s official client for this account. Choose an available model',
  ACP_MODEL_SELECTION_UNCONFIRMED: 'The assistant did not confirm the selected model, so the session was stopped. Choose an available model and try again',
  ACP_EFFORT_UNAVAILABLE: 'The selected reasoning effort is not offered by this model. Choose an effort supported by the official client',
  ACP_EFFORT_SELECTION_UNCONFIRMED: 'The assistant did not confirm the selected reasoning effort, so the session was stopped. Choose a supported effort and try again',
  ACP_PROJECT_REQUIRED: 'This Gemini account requires a Google Cloud project. Finish that setup in the official Gemini terminal, then try Research again',
  ACP_RATE_LIMITED: 'This assistant account has reached its provider usage limit. Wait for the allowance to reset, then try again',
  ACP_PROCESS_EXITED: 'The assistant program closed before it could finish. Check its sign-in in Settings, then try again',
  AGENT_HOST_INVALID_ARGUMENT: 'ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again',
  AGENT_HOST_CLOSED: 'ToolsEnabled is shutting down, so nothing new will be started. Open it again when you want to start an agent',
  MC_AGENT_INVALID_PAYLOAD: 'ToolsEnabled could not work out whether an agent can run here, because the question itself was refused. Close ToolsEnabled and open it again, and if it keeps refusing, reinstall from a complete build',
  /* Raised by the shell when a send, interrupt or close names a session this
     RUN of the app does not hold. The common way to reach it is honest and
     ordinary: a tree node saved from an earlier run still shows on the canvas,
     but the session behind it ended when ToolsEnabled closed. "Try once more"
     was the old fallback here, and retrying is the one thing that can never
     work -- the truthful move is a fresh agent. */
  MC_AGENT_UNKNOWN_SESSION: 'the session this was meant for is not open in this copy. Sessions end when ToolsEnabled closes, so nothing was delivered. Start a new agent and ask there',
  MC_AGENT_SESSION_ENDED: 'the session ended before this action reached it, so nothing was changed. Start a new session, then try there',
  MC_AGENT_DESKTOP_STOP_STALE_TARGET: 'the agent changed before it could be stopped. Reopen its current conversation, then choose Stop again',

  /* THE OTHER TEN WAYS A START IS REFUSED BEFORE IT EVER REACHES THE ENGINE,
   * and until now not one of them had a sentence anywhere.
   *
   * WHAT WAS MEASURED, 2026-08-17. Ten codes were raised by shell/main.cjs on
   * the mc-agent:start channel itself -- the trusted-sender check, the payload
   * parse, the session-profile resolve, the session limit, and the spawn
   * recorder -- and every one of them arrived at src/fleet-tree-copy.js
   * startRefusalSentence() with no entry in this table and no entry in its own,
   * so all ten fell through to START_REFUSAL.noReasonGiven: "Nothing was
   * started, and this copy was not told why. Try once more." The copy WAS told
   * why. It was told by name, over a channel built for exactly that
   * (rendererSafeAgentError makes the message the code so it survives the IPC
   * boundary), and then threw the answer away at the last step because nobody
   * had written the sentence.
   *
   * "TRY ONCE MORE" IS THE PART THAT MAKES IT WORSE THAN SILENCE. Not one of
   * these clears by pressing Start again: the sender is still untrusted, the
   * folder is still gone, the record still cannot be written. That sentence
   * sends a person round a loop with no exit, which is the dead end the whole
   * start-refusal vocabulary exists to remove.
   *
   * ONE OF THE TEN IS GONE, 2026-09-02: shell/agent-command-surface.cjs
   * removed the session-limit ceiling itself ("There is no ceiling on how
   * many agents may be running at once"), so MC_AGENT_SESSION_LIMIT is no
   * longer raised anywhere on this path -- tools/test/started-sessions-are-
   * released.test.mjs asserts it stays gone from shell/agent-command-
   * surface.cjs, and this file's own test pins that this comment does not
   * quietly start claiming it is still reached again. The sentence below is
   * left in the table rather than deleted: it costs nothing to keep, and
   * dropping it would recreate exactly the silent "not told why" this whole
   * table exists to remove on any path this note did not audit.
   *
   * Each sentence below names the ACTION. They are lower-case first and carry
   * no full stop of their own because startRefusalSentence() composes them
   * behind "Nothing was started." and unavailableReason() renders them after
   * "unavailable · " -- the same shape every other entry in this table has. */

  /* The person is not doing anything wrong and there is nothing to repair: this
     is a queue, and it is worded as one. */
  /* THE ONE REFUSAL A PERSON CANNOT CLEAR FROM WHERE THEY ARE STANDING, and
     that is the point of it rather than a flaw in it.
     A machine only accepts changes from a browser if it has been told it may
     be driven from one. The switch lives ON that computer, its ruled default
     is OFF, and nothing reachable over the relay can turn it on -- otherwise a
     stolen session would be able to grant itself the very permission the
     switch exists to withhold.
     MEASURED on the live site on 2026-08-22, the first time a browser tried to
     start an agent on a real machine: the code arrived intact, no sentence
     existed for it, and the person was told "this copy was not told why. Try
     once more. If it refuses again, close ToolsEnabled, open it" -- a loop with
     no exit, and closing the app is the one thing that guarantees failure,
     because a closed app cannot be reached at all.
     So this sentence does not offer a remedy here. It says where the remedy
     is, and why it is there.
     AND NOW IT NAMES THE CONTROL. "turn on being driven from the web" was
     written before any control existed -- Findings 2026-08-22: zero writers of
     the switch anywhere in src/, so the sentence pointed at a place nobody
     could find. The switch lives in the connect section of Settings; the
     section title and the control's label are read from the module that owns
     them so this sentence cannot drift from the screen it describes. */
  MC_AGENT_PRINCIPAL_READ_ONLY: `the computer you are driving has not been told it may be driven from a browser, so it will show you anything and change nothing. That permission is given on the computer itself, on purpose: it is what stops someone who has your password from driving your machine. On that computer, open ToolsEnabled, go to Settings, open “${CONNECT_SECTION}” under Start here, and turn on “${WEB_DRIVE_CONTROL_LABEL}”`,
  MC_AGENT_SESSION_LIMIT: 'this copy is already running as many agents at once as it allows, so it did not start another. Wait for one to finish, or stop one in the tree, and then start this again',
  MC_AGENT_SESSION_EXISTS: 'an agent is already open under that name in this copy, so nothing new was started. Open the one that is already running, or start a fresh agent from another spot in the tree',
  /* A start that cannot be written down does not happen -- the same rule the
     SPAWN_RECORD_ codes above state, reached through the channel rather than
     through the probe. */
  MC_AGENT_RECORD_UNAVAILABLE: 'ToolsEnabled writes down every agent it starts before starting it, and this one could not be written down, so nothing was started. Close ToolsEnabled and open it again; if it still refuses, reinstall from a complete build',
  /* The three session-profile refusals a start can hit. A profile is a folder
     the person picked in the OS dialog, so every remedy is "pick it again" --
     said in the words of what went wrong, because a person whose folder was
     renamed and a person whose folder is now a file need different things
     checked before they re-pick. */
  MC_AGENT_PROFILE_UNKNOWN: 'the session profile this tree works in is not on the computer you are driving any more, so nothing was started. Open the fleet overview and choose a folder for this tree again',
  MC_AGENT_PROFILE_FOLDER_MISSING: 'the folder this tree works in is not there any more, so nothing was started. Open the fleet overview and pick the folder again',
  MC_AGENT_PROFILE_FOLDER_INVALID: 'the folder this tree works in cannot be used as a working folder, so nothing was started. Open the fleet overview and pick a different folder',
  MC_AGENT_PROFILE_FOLDER_NOT_DIRECTORY: 'the session profile for this tree points at a file rather than a folder, so nothing was started. Open the fleet overview and pick a folder instead',
  /* The working folder was named by the renderer and is not one this session
     may use. A person reaches it through a profile, so the remedy is the
     profile's. */
  MC_AGENT_CWD_NOT_YOURS: 'the folder this agent would have worked in is not one you picked for this tree, so nothing was started. Open the fleet overview and choose the folder for this tree again',
  /* Research input validation happens in the start channel before the owner
     host sees a session. Keep the refusal specific so the person can correct
     the request instead of receiving the generic session failure. */
  MC_AGENT_RESEARCH_INVALID: 'the research request could not be verified, so this agent was not started. Check the research settings and try again with a complete request',
  /* Restricted research needs a one-use owner-host boundary that readiness
     cannot establish: the probe has no research permit to inspect. It remains
     a start refusal, with a repair action for the person if the host is stale. */
  AGENT_RESEARCH_SCOPE_UNAVAILABLE: 'the owner host could not establish the restricted research boundary, so this agent was not started. Reopen ToolsEnabled and try again; if it keeps refusing, update ToolsEnabled',
  AGENT_RESEARCH_TOOL_RESTRICTION_UNAVAILABLE: 'the provider could not enforce the restricted research tool boundary, so this agent was not started. Update ToolsEnabled and try again',
  /* Reachable only if the depth menu and the engine disagree about the list --
     renderer and shell drift, not something the person chose wrongly. The
     remedy is still theirs and still works: pick another depth. */
  MC_AGENT_EFFORT_UNKNOWN: 'the thinking depth this copy asked for is not one the engine accepts, so nothing was started. Choose a different depth on this panel and start again',
  /* The request did not come from the application's own window. Nothing the
     person did, and nothing they can repair from inside the page. */
  MC_AGENT_SENDER_REFUSED: 'this request did not come from the ToolsEnabled window itself, so it was refused and nothing was started. Close ToolsEnabled, open it again, and start from the panel in its own window',
  /* THE ONE ON THIS LIST THAT IS NOT A START. It is raised when a message names
     an attachment that was not picked in that session, and it reaches a person
     through the SEND composer rather than the start one -- so it is worded for
     a message that did not go, and the walk in
     tools/test/agent-session-surface.test.mjs names it as send-only rather than
     letting it be composed behind "Nothing was started." It is here because
     without an entry refusalCode() cannot even recover it from the boundary,
     and the send surface showed a bare identifier instead of a sentence. */
  MC_AGENT_ATTACHMENT_UNKNOWN: 'one of the files attached to this message was not picked in this session, so the message was not sent. Attach the file again with the picker in this conversation, then send it',
  /* Electron preserves the sanitized refusal in the error message, not its
     code property. These entries also let refusalCode recover paste failures. */
  MC_AGENT_PASTE_REQUIRES_WINDOW: 'Pasting an image is available only in the ToolsEnabled desktop window. Open that window on the computer you are driving and paste there',
  MC_AGENT_PASTE_UNAVAILABLE: 'This copy cannot attach pasted images. Use the attach button to choose a file instead',
  MC_AGENT_PASTE_IMAGE_TOO_LARGE: 'The pasted image is empty or larger than the size this copy accepts. Copy a smaller image, or use the attach button to choose a file',
  /* The two refusals the tool checkboxes can raise at a start. Both refuse
     rather than widen: a session that cannot read the limits the person
     recorded must not run without them. */
  AGENT_TOOL_LIMITS_UNREADABLE: 'the tool limits saved for this account could not be read, so no session was started at a wider surface than you chose. Open the research page settings and set the tool checkboxes again',
  AGENT_TOOLS_ALL_DISABLED: 'every tool is switched off for this account, and an agent with no tools cannot do anything. Switch at least one tool on in the research page settings, then start again',
  /* WHICH ENGINE IS ABSENT IS DECIDED PER BUILD, SO THIS SENTENCE NAMES NONE.
   *
   * WHAT SHIPPED, AND WAS FALSE ON THE BUILD IT SHIPPED IN. This entry read
   * "this copy of ToolsEnabled does not carry the part that runs Claude or local
   * agents from a tree. Your Claude sign-in is fine ... Pick Luna, Terra or Sol
   * to start one here." Every clause of that was true when it was written and
   * the first clause was false by the time it was installed. The Claude engine
   * now ships in the payload as capability/src/lib/agent-engine/
   * claude-cli-process.js and claude-cli-adapter.js -- confirmed present in the
   * installed 1.0.20 under resources/capability -- and resolveStartTier() in
   * shell/agent-host.cjs opens the three Claude tiers on a real require() of
   * exactly that module. So on the build a person is holding, this code is
   * raised by the `local` tier and by nothing else, while the sentence beside it
   * went on naming Claude as the thing that could not start. The owner's hardest
   * rule is that the product never tells him something untrue, and this was the
   * product telling him something untrue about its own contents.
   *
   * THE GATE IS THE ONLY PARTY THAT KNOWS WHICH ENGINE IS MISSING, and it
   * decides that per tier, per build, at the moment of the press. A frozen
   * string cannot hold that answer: the same code covers a provider this build
   * carries no launcher for today and a different one after the next payload
   * moves. So this sentence states only what is true of EVERY build that raises
   * it -- the type that was picked has no launcher here -- and leaves naming the
   * provider to the surface that has the tier in hand. src/fleet-tree-copy.js
   * tierNoLauncherSentence() is that surface: it names the picked tier's
   * provider, only that one, and only when that tier is the one that was
   * refused. tools/test/refusal-engine-honesty.test.mjs fails if any refusal
   * sentence claims this build lacks an engine the payload actually carries.
   *
   * THE TWO REMOVED CLAUSES, AND WHY NEITHER IS REPLACED. "Your Claude sign-in
   * is fine" existed so this refusal would not contradict the sign-in readout on
   * the setup screen; with no provider named there is nothing left to
   * contradict, and volunteering that a sign-in is fine for a provider the
   * sentence is not about is noise a person has to read past. "Pick Luna, Terra
   * or Sol" named the three Codex tiers as the whole startable set, which is
   * exactly the claim the Claude engine falsified -- so it points at the menu,
   * whose rows tierChoicesFor() labels from what mc-agent:startable-tiers really
   * answered, instead of at a list frozen in this file.
   *
   * IT STILL MUST NOT HINT AT A REPAIR. Nothing a person can press, restart or
   * switch on adds a launcher to a build that does not carry one, and
   * tools/test/first-run-needs.test.mjs holds this string to that. */
  AGENT_TIER_NO_LAUNCHER: 'this copy of ToolsEnabled carries no launcher for the agent type that was picked, so nothing was started. Nothing on the computer you are driving is broken. The model menu marks every type this copy cannot start; pick one it does not mark',
  /* THE SIBLING FAULT, AND WHY IT IS NOT THE SAME CODE. The line above means
     this build carries no program for the chosen type. This one means the build
     carries the program and this installation will not seat it, which is how
     every Grok tree start failed on 2026-09-11. One sentence for both would
     have to be vague about which is true.
     The tree names the exact type, because the press carried it -- see
     tierSessionActorSentence() in src/fleet-tree-copy.js. This table has no
     tier in hand, so it names none. */
  AGENT_TIER_SESSION_ACTOR_UNSUPPORTED: 'this installation cannot start the agent type that was picked. Update ToolsEnabled or choose another model',
  /* THE THIRD OF THE SAME FAMILY, AND THE ONE A NEW PERSON HITS FIRST. The two
     above are faults in the build or the installation. This one is not a fault
     at all: everything works and nobody has signed in yet, so the sentence says
     what to do rather than what is broken.
     It names no provider because this table has no tier in hand, the same
     reason the line above names none.
     DELIBERATELY NOT ABOUT RUNNING OUT. An account with nothing left this hour
     is still signed in and is still offered -- the product moves to another
     account by itself. This sentence would be wrong for that, and telling a
     person to sign in when they already are is the kind of advice no action
     satisfies. */
  AGENT_TIER_NO_SIGNED_IN_ACCOUNT: 'no account is signed in for the kind of agent that was picked, so nothing was started. Nothing is broken. Sign in to an account for it in Accounts, or pick a model for a kind you are already signed in to',

  /* THE COMPUTER IS FULL, WHICH IS A FACT ABOUT THE MACHINE AND NOT A FAULT.
   *
   * MEASURED 2026-09-03 (REPORT-crash-20260903/evidence/C): one assistant is a
   * CLI process at 540-623 MB plus its two MCP servers at 60-65 MB each --
   * 665-748 MB of private bytes. This computer resumed nine assistants in
   * eleven minutes that evening and died.
   *
   * IT SAYS WHAT WOULD FIX IT, because unlike a missing launcher this one the
   * person really can act on: close something, or start it anyway. The exact
   * numbers travel on the refusal itself (memoryAdmission() in
   * shell/agent-host.cjs writes them into the message); this sentence is what
   * the control renders when it has only the code. */
  AGENT_MEMORY_LOW: 'this computer is nearly out of memory, so another assistant was not started. Nothing is broken. Closing an assistant you have finished with, or another program, makes room; you can also start it anyway',
  AGENT_RESOURCE_UNKNOWN: 'resource readings are missing or stale. Waiting for fresh measurements before starting more agents',
  AGENT_RESOURCE_PRESSURE: 'this computer is under heavy load. Waiting for CPU and app responsiveness to recover before starting more agents',
  AGENT_RESOURCE_WARMING: 'a stable resource window is being measured before starting more agents',
  AGENT_RESOURCE_STARTS_BUSY: 'other agents are still starting. The remaining set agents will wait',
  AGENT_RESOURCE_PACING: 'the current launch needs time to settle before another starts',
  AGENT_RESOURCE_PROVIDER_UNKNOWN: 'this program has no resource estimate. Choose a supported program before starting it',
  AGENT_RESOURCE_CONTROLLER_UNKNOWN: 'current resource advice is needed from the declared controller. Start that controller first, or choose Mechanical only in System settings',
  AGENT_RESOURCE_CONTROLLER_HOLD: 'the controller has paused additional starts. Check its resource advice or change the policy in System settings',

  /* THE OTHER HALF OF THE ANSWER. mc-agent:availability composes the recorder's
     verdict with the engine's, and a start that cannot be RECORDED does not
     happen -- so these codes reach this control exactly as often as the engine
     ones do. Until now this table had a sentence for none of them and the page
     showed the bare identifier beside a disabled button, which is the same
     unactionable refusal the engine half was just repaired for.
     shell/spawn-record.cjs exports RECORD_AVAILABILITY_CODES; the suite walks
     it against this table. */
  SPAWN_RECORD_NO_KEYSTORE: 'this copy cannot reach the operating system’s secure key storage. It cannot protect its activity record, so it will not start an agent',
  SPAWN_RECORD_NO_DIRECTORY: 'ToolsEnabled has nowhere to keep its record of what runs here, and a start that cannot be recorded does not happen',
  SPAWN_RECORD_KEYSTORE_UNAVAILABLE: 'the operating system’s secure key storage is unavailable to ToolsEnabled. It cannot protect its activity record, so it will not start an agent',
  SPAWN_RECORD_KEY_UNREADABLE: 'the key that signs the record of what runs here cannot be opened, so ToolsEnabled will not add to it',
  SPAWN_RECORD_LEDGER_CORRUPT: 'the record of what has run here does not read back as a record, so ToolsEnabled will not append to it until that is resolved',
  SPAWN_RECORD_UNAVAILABLE: 'the record of what runs here cannot be opened, and a start that cannot be recorded does not happen',

  /* THE THIRD HALF OF THE ANSWER, and the one that reached a customer as a bare
     `AGENT_SESSION_FAILED`.

     These are raised by confinedSessionPlan() at START time, not by the
     availability probe, because building a confined session's home is not a read
     -- it mkdirs the isolated assistant home, links the Codex credential into it
     and writes config.toml -- and availability must start nothing. So a level
     that confines (guided, standard) can pass every readiness check and still
     refuse on the press, and until now this table had a sentence for none of it.

     MEASURED, isolated to one variable: with no Codex sign-in under USERPROFILE,
     availability answered {ok:true, AGENT_ENGINE_READY}, Start rendered ENABLED,
     and the press refused with a message that never mentioned signing in. That is
     the refusal in the owner's screenshot. Each sentence below therefore names
     the ACTION, not the fault: "sign in" and "choose a folder" are things a
     person can go and do, where "confinement could not be prepared" is not.

     AGENT_CONFINEMENT_SIGNED_OUT IS DELIBERATELY NOT REPEATED HERE. It is the
     one code on this list the availability probe now answers directly
     (engineAvailability -> confinedSessionIsSignedOut), so it has a sentence
     above, beside the other codes that disable the control rather than explain a
     press. A second entry here would not be a second opinion -- a duplicate key
     in an object literal silently wins on source order, so the later one would
     have replaced the earlier one and whichever lane edited last would own the
     copy without either noticing. */
  AGENT_CONFINEMENT_RECORD_ABSENT: 'the computer you are driving has not been set up yet, so a session would run at the most restrictive level. Open Settings and choose a permission level',
  AGENT_CONFINEMENT_RECORD_UNREADABLE: 'the permission level recorded on the computer you are driving cannot be read. ToolsEnabled will not start a session at a level it cannot confirm. Choose the level again in Settings',
  AGENT_CONFINEMENT_TIER_REFUSED: 'the permission level recorded on the computer you are driving is not one this copy recognises. No session can be started under it. Choose the level again in Settings',
  AGENT_CONFINEMENT_TIER_UNMAPPED: 'the permission level recorded on the computer you are driving has no session rules in this copy, so it will not start one. Re-choose the level in Settings',
  AGENT_CONFINEMENT_HOME_UNAVAILABLE: 'the protected home your permission level runs an assistant in could not be prepared, so no session was started',
  AGENT_CONFINEMENT_HOME_UNWRITABLE: 'a folder name on the computer you are driving contains a character ToolsEnabled will not write into an assistant configuration. It will not start a session it cannot hold to your permission level. Choose a different folder in Settings',
  AGENT_CONFINEMENT_NOT_ISOLATED: 'this session was prepared for a permission level that does not match the one recorded here, so it was not started',
  AGENT_CONFINEMENT_BROWSER_TOOLS_INVALID: 'ToolsEnabled could not correctly signal whether this assistant needs browser tools, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_ACCOUNT_RECOVERY_UNAVAILABLE: 'ToolsEnabled could not confirm that this account recovery still belongs to the original agent. Review the agent and its role in Computers before starting it again',
  AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE: 'No other eligible signed-in account is available for this assistant. Add or sign in to another account in Settings, or wait for the current account to have allowance again',
  AGENT_ACCOUNT_RECOVERY_IDENTITY_MISMATCH: 'The earlier agent this recovery would replace is now in a different place in the tree, so no replacement was started. Review the agent and its role in Computers before starting it again',
  AGENT_ACCOUNT_RECOVERY_STOPPED: 'You stopped the earlier agent, so account recovery did not start a replacement. Review the agent in Computers and start it again when you want it to run',
  AGENT_PREDECESSOR_CLEANUP_FAILED: 'The earlier agent did not finish closing, so account recovery did not start a replacement. Use Stop on that agent in Computers, then start it again',
  AGENT_CONFINEMENT_PROVIDER_INVALID: 'ToolsEnabled could not prepare a protected session for the selected assistant program. Choose a supported model; if it still refuses, update ToolsEnabled and try again',
  AGENT_CONFINEMENT_ACCOUNT_COLLISION: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_INVALID: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_PROVIDER_ISOLATION_UNAVAILABLE: 'This DEV session needs matching app and engine support for private provider accounts. Create a new DEV session from the updated source',
  AGENT_PROVIDER_ISOLATION_ACCOUNT_REQUIRED: 'Add a named provider account in this DEV session and sign in to it before starting an agent',
  AGENT_PROVIDER_ISOLATION_INVALID: 'This DEV session’s private profile could not be established. Create a new DEV session before starting an agent',
  AGENT_PROVIDER_ISOLATION_PATH: 'A provider account or program leaves this DEV session’s private profile. Add the account and install the program inside this session',
  AGENT_PROVIDER_ISOLATION_ENVIRONMENT: 'The provider could not keep its settings and cache inside this DEV session. Create a new DEV session before starting an agent',
  AGENT_PROVIDER_ISOLATION_CREDENTIAL_STORE: 'This provider’s sign-in store is shared outside the DEV session. Sign in to a new private account using its Sign in button',
  AGENT_PROVIDER_ISOLATION_EXECUTABLE_REQUIRED: 'Install this provider inside the DEV session using its Install button, then start the agent again',
  AGENT_CONFINEMENT_AGENT_ID_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_ACCOUNT_MARKER_UNREADABLE: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_UNRESOLVED: 'ToolsEnabled could not safely resolve the selected assistant account to one signed-in folder, so nothing was started. Remove and add that assistant account again in Settings, then start a new agent',
  AGENT_CONFINEMENT_CREDENTIAL_BUSY: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_CREDENTIAL_UNLINKABLE: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_SIGN_IN_UNAVAILABLE: 'ToolsEnabled could not safely attach the selected assistant sign-in to the protected session, so nothing was started. Close other agent sessions, sign in to that assistant again if needed, then start a new agent',
  AGENT_CONFINEMENT_ACCOUNT_FENCE_UNAVAILABLE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_HOME_SCRUB_INCOMPLETE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_RUNTIME_NOT_NODE: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SERVER_COMMAND_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SERVER_ENTRY_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  AGENT_CONFINEMENT_SESSION_CREDENTIAL_INVALID: 'ToolsEnabled could not safely build the protected assistant home and tool configuration, so nothing was started. Close ToolsEnabled and open it again; if it keeps refusing, reset its local agent data or reinstall from a complete build',
  SETUP_MACHINE_RECORD_INVALID: 'the setup recorded on the computer you are driving is incomplete, so the tools your level allows cannot be worked out; run through Settings again',
  SETUP_NODE_NOT_FOUND: 'the program ToolsEnabled recorded for running its tools is no longer on the computer you are driving; run through Settings again',
  SETUP_TIER_PROFILE_EMPTY: 'the set of tools allowed at your permission level worked out to nothing at all, which would be read as no limit. No session was started. Choose the level again in Settings',
  SETUP_TIER_PROFILE_UNAVAILABLE: 'the set of tools allowed at your permission level could not be worked out on the computer you are driving. ToolsEnabled will not start a session that only claims to be limited. Choose the level again in Settings',
  SETUP_READ_ONLY_PROFILE_EMPTY: 'the read-only assistant profile worked out to nothing at all, which would be read as no limit, so no session was started',

  /* THE FOURTH HALF, raised by the ENGINE rather than by this shell, and the
     residual the availability probe deliberately does not cover.

     codexCommandIsMissing() answers PRESENCE without spawning anything, because
     a probe that runs on every home mount must not start a child process. So a
     `codex` that resolves on PATH but cannot execute -- a broken install, a
     shim pointing at a Node that was uninstalled, a half-extracted portable zip
     -- passes readiness and fails on the press. These are the codes that press
     raises, from detectCodexVersion() in the payload's codex-process.js, and
     they are the reason that residual is a worse SENTENCE rather than a bare
     identifier.

     CODEX_CLI_NOT_FOUND is here as well as its probe-time twin above because
     the engine can still reach it: the session spawns with a scrubbed
     environment, so a PATH this shell can read is not proof of a PATH the child
     gets. Same fault, two vantage points, one instruction. */
  CODEX_CLI_NOT_FOUND: `the Codex program could not be found when the session tried to start it. Open Windows Terminal and run "${CODEX_SETUP_COMMANDS.install}". If you already have Node, "${CODEX_SETUP_COMMANDS.installWithNode}" does the same job. Then run "${CODEX_SETUP_COMMANDS.signIn}"`,
  CODEX_VERSION_DETECTION_FAILED: 'Codex is installed on this computer but did not answer when asked its version, so ToolsEnabled will not build a session on it. Run "codex --version" in Windows Terminal to see what it reports. If that does not explain it, run "codex doctor"',
  CODEX_VERSION_DETECTION_TIMEOUT: 'Codex took too long to report its version, so the session did not start. Try starting it again when the computer is less busy',
  CODEX_PROTOCOL_INVALID: 'the agent connection stopped responding correctly. Check the conversation before retrying or resuming the agent',
  CODEX_START_TIMEOUT: 'Codex took too long to open the session. Try starting it again when the computer is less busy',
  CODEX_START_CLEANUP_UNPROVEN: 'ToolsEnabled could not confirm that Codex stopped after an incomplete start. Try Stop again before starting another session',
  CODEX_VERSION_CLEANUP_UNPROVEN: 'ToolsEnabled could not confirm that the Codex version check stopped. Try Stop again before starting another session',

  /* REACHABLE, AND UNTIL NOW UNSPEAKABLE. The engine's adapter is generated
     against one Codex line and refuses every other one, so this code comes back
     from a real press on a computer whose Codex is simply newer than this
     build. It appeared NOWHERE in this app -- not in this table, not in
     local-activity.js, not in START_REFUSAL_CODES -- so it fell through to the
     bare-identifier residual: a person with a working, signed-in Codex was told
     "AGENT_SESSION_FAILED" or "not set up to run agents yet", neither of which
     is true and neither of which names a thing to do.
     Measured 2026-08-23 on the owner's machine, reached by following this
     product's own second install line. */
  /* A REAL INCOMPATIBILITY, AND ONLY THAT. No Codex version is pinned: the
     engine refuses a start only when the installed Codex, while the session
     opens, lacks a request the session needs or answers one in a form it
     cannot read (CODEX_CLI_INCOMPATIBLE, engine codex-process.js). That used
     to arrive as "the agent connection stopped responding correctly", which
     blamed the connection and named nothing to do. */
  CODEX_CLI_INCOMPATIBLE: `the Codex on this computer cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. Open Windows Terminal and run "${CODEX_SETUP_COMMANDS.update}", then start again. If Codex is already up to date, update ToolsEnabled`,
  CODEX_PROTOCOL_VERSION_MISMATCH: `the Codex on this computer did not identify itself as a usable CLI. Open Windows Terminal and run "${CODEX_SETUP_COMMANDS.installWithNode}" to repair the Codex installation. "${CODEX_SETUP_COMMANDS.install}" installs Codex without Node`,

  /* THE LAST RESORT, WHICH IS NOT MEANT TO BE REACHED and until now was reached
     by EVERY refusal. src/agent-session.js falls back to this identifier when a
     rejected start carries no code it recognises; the boundary that dropped the
     code has been repaired (rendererSafeAgentError in shell/main.cjs), so this
     should now mean what it says rather than standing in for all of the above.
     It gets a sentence anyway, because the one thing this table must never do
     again is put a bare constant in front of a person. */
  AGENT_SESSION_FAILED: 'the session did not start and this copy could not work out why, which is itself a fault worth reporting. Try once more. If it happens again, reinstall ToolsEnabled from a complete build',

  /* THE FIFTH HALF: THE THREE STEERING CONTROLS, which refuse in their own
     vocabulary and had a sentence for none of it.
     [B6]
     Every code below is raised by control.pause / control.respawn /
     control.terminate in src/agent-session.js, and src/views/agent.js renders
     that refusal as `${id} did not happen · ${result?.code}` -- the bare
     identifier, on the same page and beside the same session the Start control
     was repaired for. Two of them (AGENT_TURN_NONE, AGENT_SESSION_UNKNOWN) are
     not faults at all: they mean the button was pressed for something that had
     already stopped, so those sentences say that rather than apologising.
     The rest are raised by shell/agent-host.cjs and are classified start-only
     in tools/test/agent-session-surface.test.mjs -- start-only means the
     readiness probe cannot resolve them, NOT that nobody reads them.

     They are here rather than in src/refusal-copy.js because refusalCode()
     below recovers a code from a rejected IPC message by testing membership of
     THIS table: a session code with its sentence in another module would be
     rejected as unrecognised and fall back to AGENT_SESSION_FAILED, which is
     the exact bug the note above this table describes. */
  AGENT_STOP_PENDING: 'the agent has not finished stopping. Retry Halt before sending more work, or close the session',
  AGENT_IMAGE_UNSUPPORTED: 'this provider cannot receive images. Choose a provider with image support or remove the images before sending',
  AGENT_MODE_UNAVAILABLE: 'this session no longer offers that provider mode. Refresh provider modes and choose an available mode',
  AGENT_MODE_SELECTION_UNCONFIRMED: 'the provider mode change could not be confirmed. Refresh provider modes to check the current setting before another change',
  AGENT_SWITCH_STALE: 'this conversation changed while the model switch was being prepared. Check the active session before choosing another model',
  AGENT_SWITCH_ACCOUNT_UNAVAILABLE: 'the selected account is no longer available for this model. Check Accounts and choose an available account for that provider',
  AGENT_SWITCH_NOT_STANDALONE: 'this session needs its tree’s model controls. Open it in Computers to change the model',
  AGENT_SWITCH_ACCOUNT_INVALID: 'the selected account choice does not match this model. Choose an account for that provider or automatic selection; local models do not use subscription accounts',
  AGENT_SWITCH_HISTORY_UNAVAILABLE: 'ToolsEnabled could not link this conversation to the replacement session. Keep the conversation open and check its history before trying again',
  AGENT_SWITCH_CLEANUP_REQUIRED: 'ToolsEnabled could not confirm that the model switch finished safely. Keep this conversation open and check its status before trying another switch',
  AGENT_TURN_NONE: 'there was nothing running to stop -- the session is open and idle, so a prompt is what it is waiting for',
  LOCAL_NODE_GPU_REQUIRED: 'the selected local model did not fit entirely on the GPU. Choose a smaller model or context in Settings → Local models, or explicitly allow CPU fallback there',
  LOCAL_NODE_GPU_UNVERIFIED: 'the local runtime could not verify GPU residency, so no prompt was sent. Check Ollama and try again; CPU fallback remains disabled',
  LOCAL_NODE_SETTINGS_INVALID: 'a local-model setting is invalid. Open Settings → Local models and check the model, GPU policy, context size and response mode',
  LOCAL_NODE_MODEL_NOT_INSTALLED: 'the chosen local model is not installed at the configured runtime. Choose an installed model in Settings → Local models',
  LOCAL_NODE_RUNTIME_UNAVAILABLE: 'the chosen local runtime is unavailable. Start it and check its address in Settings → Local models',
  LOCAL_NODE_REASONING_BUDGET_EXHAUSTED: 'the local model used its answer budget on reasoning. Select Fast response mode in Settings → Local models or use a different model',
  LOCAL_NODE_THREAD_UNKNOWN: 'the saved local conversation is unavailable. Start a new session; the visible conversation excerpt is still separate from model recovery',
  AGENT_TURN_ACTIVE: 'this session is already working on a turn; stop that one first, or wait for it to finish',
  AGENT_SESSION_UNKNOWN: 'there is no open session on this screen to act on, so nothing was changed; start one first',
  AGENT_SESSION_EXISTS: 'a session for this agent is already open, so a second was not started; use the one that is running or stop it first',
  AGENT_SWITCH_PENDING: 'this agent is changing sessions. Wait for the change to finish, then try this control again.',
  AGENT_SESSION_NOT_READY: 'this screen is not in a state where that can be done. Either a session is already open, or this copy is not ready to start one. Reload the page and read what it says before pressing it again',
  AGENT_SESSION_NO_PROMPT: 'nothing was sent because there was nothing to send; type what you want the agent to do and start it again',
  AGENT_SESSION_NO_ID: 'this copy could not generate the secure identifier a session is tracked by, so none was started; close ToolsEnabled and open it again',
  AGENT_SESSION_VIEW_CLOSED: 'this screen was closed while that was in flight, so it was not completed; nothing is running from it',
  AGENT_SESSION_STOPPED_WHILE_STARTING: 'you stopped this while it was still starting, so the turn never ran; nothing is running from it',
  AGENT_SESSION_START_CANCELLED: 'the start was called off before the session opened, so nothing is running; start it again when you are ready',
  /* THE REMEDY THIS NAMED WAS THE MOST EXPENSIVE ONE IN THE PRODUCT, AND IT
     WAS NOT THE ONE THAT WORKS. It read "Close ToolsEnabled to end every
     session, then open it again" -- so a person with one wedged agent was told
     to end every OTHER agent on the tree too, losing every running turn on the
     computer, to clear one circle.
     MEASURED 2026-09-19: a close-failed circle (node-24-d7961725) was cleared
     by "Remove this agent" alone, ok:true, with the application still running
     and every other agent untouched. That control is already on this circle's
     own menu and is already enabled for it. Naming the cheap remedy that works
     instead of the expensive one that also works is the whole fix.
     The first half of the sentence is unchanged and still true: the screen
     cannot call the session stopped, because it was never confirmed closed. */
  AGENT_SESSION_CLEANUP_FAILED: 'the session did not finish closing, so this screen cannot honestly call it stopped. Use "Remove this agent" on it — that clears the circle without closing ToolsEnabled, and every other agent keeps running',
  /* Provider conversations are stored inside the account home that created
     them. Continuing under a different registered account is not a fallback:
     it is a different home with no such thread. */
  AGENT_RESUME_ACCOUNT_UNAVAILABLE: 'the account that owns this saved conversation is unavailable. Open Accounts to check it, or choose Continue on another account to keep this agent and continue from its saved handoff',
  AGENT_RESUME_SOURCE_UNAVAILABLE: 'the saved native conversation could not be verified for this agent. Close any session still using it and retry Resume',
  CODEX_RESUME_SOURCE_INVALID: 'the saved native conversation could not be bound to a new session. Update the paired app and engine before retrying Resume',
  CODEX_RESUME_IDENTITY_MISMATCH: 'the saved file belongs to a different native conversation. The agent was not resumed',
  CLAUDE_RESUME_IDENTITY_MISMATCH: 'the saved file belongs to a different native conversation. The agent was not resumed',
  /* SAY WHICH LIMIT REFUSED. This read "its configured start limit or provider
     allowance" because the code did not know which, and that one word of
     vagueness is the defect: a person told "or" cannot tell whether to wait for
     a reset or move a slider they set themselves. Only the provider can refuse a
     resume now -- the configured cutoff governs automatic selection and no
     longer turns a saved conversation away -- so this sentence names the
     provider and stops offering to adjust a limit that is not what stopped them. */
  AGENT_RESUME_ACCOUNT_LIMIT: 'the provider has refused the account that owns this saved conversation: its allowance is spent. Wait for it to reset, or choose Continue on another account',
  AGENT_RESUME_ACCOUNT_SIGNED_OUT: 'the account that owns this saved conversation is signed out. Sign it in through Accounts, or choose Continue on another account to continue from the saved handoff',
  AGENT_ROLE_BINDING_INVALID: 'the saved role directions could not be used, so the agent was not started. Reopen the Role library, save that role again, then retry the start',
  AGENT_ROLE_TOOL_RESTRICTION_UNAVAILABLE: 'the app and engine cannot apply the same role limits. No agent was started. Install a matching app and engine update, then retry',
  AGENT_ROLE_TOOL_RESTRICTION_INVALID: 'the saved role has invalid function settings. No agent was started. Open the Role library, save that role again, then retry',
  AGENT_ROLE_TOOL_SERVER_UNSUPPORTED: 'this engine cannot provide the functions selected for the role. No agent was started. Install a matching app and engine update, then retry',
  AGENT_OPTIMIZED_TOOLS_UNSUPPORTED: 'Optimized works with Claude only, so this assistant was not started. Your saved tool setting is unchanged. Start it with a Claude account, or choose Only, Enabled or Disabled for Agent API in quick settings, then retry',
  AGENT_CONFINEMENT_STATE_PATH_TOO_LONG: 'the app data folder path is too long to start this assistant. Use a shorter supported app data location in the owning account, then retry',
  AGENT_SESSION_IDENTITY_TRANSPORT_UNAVAILABLE: 'the app-owned identity channel was not ready, so the named agent was not started. Close ToolsEnabled, open it again, then retry from this screen',
  AGENT_SESSION_ROOT_GUARD_UNAVAILABLE: 'this app and engine do not support the same final launch guard, so no agent program was started. Install a matching app and engine update, then retry',
  MC_TREE_BOUNDED_WORK_REFUSED: 'the selected parent, saved tree, profile, or time cap changed before this work could start. Check the selected running agent and retry',
  MC_TREE_BOUNDED_WORK_CAP_REACHED: 'the time cap ended while this work was starting. Choose a longer cap and retry',
  TREE_DELEGATION_REFUSED: 'the parent’s current tree authority no longer matches this start. Retry from the current running parent',
  OWNER_HOST_NOT_READY: 'the app-owned session authority is no longer available, so the agent was not started. Reopen ToolsEnabled, then retry',
  /* See the note on this code in src/local-activity.js. Both tables are asked
     in turn by local-metrics.js refusalSentenceFor(), so a code absent from
     BOTH is the only way a recorded reason reads as unrecorded. */
  OWNER_HOST_PERMISSION_UNAVAILABLE: 'the working folder allowed for this session could not be confirmed, so the agent was not started. Check the folder under Settings → Setup → Working folders, then retry',
  /* See the note on this code in src/local-activity.js: a Resume whose saved
     conversation is not held by the selected sign-in ends here, and until
     2026-09-18 the Metrics page called that "The record does not say why". */
  CLAUDE_CLI_CLOSED: 'the Claude program closed before the session was ready, so the agent was not started. If this was a Resume, the saved conversation may not exist in the selected sign-in; choose that sign-in or Start over, then retry',
  /* THE ADVICE THAT COULD NOT BE FOLLOWED, AND THEN THE ADVICE THAT WAS STILL
     TOO LONG. This ended "Reload this screen, then retry" until 2026-09-11,
     when a person read it on a tree they had just made, reloaded, pressed Start
     and got the identical refusal: the chosen provider was not one this
     installation seats, and no reload can change that. The rewrite named both
     causes honestly and still opened by sending them to reload, which the owner
     read and rejected -- reload must not be the headline remedy at all.
     So: what happened, one retry, and what to do if it comes back. The typed
     code is on the same element as `data-refusal-code` for anyone diagnosing
     it, which is where the mechanism belongs. */
  OWNER_HOST_SESSION_BINDING_INVALID: 'this agent was not started. Try once more. If it happens again, update ToolsEnabled or choose another model',
  OWNER_HOST_SESSION_REFUSED: 'this session identity or its saved role is no longer current, so the agent was not started. Reload this screen and check its role before retrying',
  OWNER_HOST_SESSION_UNKNOWN: 'the current organisation or role could not be read, so the agent was not started. Wait for that storage to be available, then retry',
  /* THE FOUR THAT WERE IN NEITHER TABLE, plus the close one below them. See the
     note on this family in src/local-activity.js: measured on a candidate
     2026-09-19, a refused run carrying OWNER_HOST_MODULE_INVALID read on Metrics
     as "The record does not say why" while the record held the code, and a
     census of every OWNER_HOST_* code shell/capability-layer.cjs can record
     found five of ten with no sentence anywhere.

     Retrying clears none of them, so none of them says retry. */
  OWNER_HOST_PAYLOAD_ABSENT: 'the part of ToolsEnabled that starts agents is not present in this copy, so the agent was not started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_ENTRYPOINT_ABSENT: 'the part of ToolsEnabled that starts agents is installed but its main file is missing, so the agent was not started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_MODULE_INVALID: 'the part of ToolsEnabled that starts agents is installed but could not be loaded, so the agent was not started. Install ToolsEnabled again from the same place you got it, then retry',
  OWNER_HOST_START_FAILED: 'the part of ToolsEnabled that starts agents would not start itself, so the agent was not started. Reopen ToolsEnabled; if it happens again, install it again from the same place you got it',
  /* NOT A START. Recorded when a session could not be confirmed CLOSED, so this
     fragment must not end up composed after "Nothing was started." as though it
     were a refusal to start. */
  OWNER_HOST_CLOSE_UNCONFIRMED: 'ToolsEnabled could not confirm that this session was fully closed. Reopen ToolsEnabled, and check Computers for anything still running before starting more',
  AGENT_RESOURCE_GRANT_USED: 'this launch reservation was already used, so another agent program was not started. Start again to request a fresh reservation',
  AGENT_RESOURCE_POLICY_CHANGED: 'resource settings changed while the agent was preparing, so it was not started under the previous settings. Retry with the current policy',
  MC_AGENT_ROLE_BINDING_INVALID: 'the saved role did not carry a complete organisation snapshot, so the agent was not started. Reload the page, then try again',
  /* org:ensure-seat -- the seat a tree node needs so its agent carries an
     identity. Raised before the organisation store is touched. */
  MC_AGENT_SEAT_ID_INVALID: 'this circle cannot be seated in the organisation under its current name, so the agent was not started. Rename the circle, then try again',
  MC_AGENT_SEAT_ROLE_INVALID: 'this circle has no role, so no organisation seat was declared and the agent was not started. Pick a role for it, then try again',
  MC_AGENT_SEAT_PROVIDER_INVALID: 'this circle runs on a program the organisation cannot seat, so the agent was not started. Pick a Codex or Claude tier, then try again',
  /* The fourth check in the same handler, and it arrived after the three above.
     nodeId is the tree node the seat is bound to -- optional, and bounded to the
     same shape a declared agent id has, so this is reached only when the node
     the circle sits on carries a name the organisation cannot bind to. */
  MC_AGENT_SEAT_NODE_ID_INVALID: 'this circle sits on a tree node whose name the organisation cannot bind a seat to, so the agent was not started. Rename that node, then try again',
  MC_AGENT_ROLE_CAPABILITIES_INVALID: 'the saved role abilities could not be read as one complete set, so nothing was changed or started. Reopen the Role library, save that role again, then retry',
  MC_AGENT_ROLE_AGENT_UNKNOWN: 'that agent is no longer in the organisation, so it was not started. Reload the agent page, then try again',
  MC_AGENT_ROLE_AGENT_DISABLED: 'that agent is disabled in the current organisation, so it was not started. Enable it or choose another agent, then try again',
  MC_AGENT_ROLE_UNKNOWN: 'that role is no longer in the Role library, so the agent was not started. Pick a current role, then try again',
  MC_AGENT_ROLE_STALE: 'the organisation or role directions changed after this page was opened, so the agent was not started with stale directions. Reload the page, then try again',
  MC_AGENT_ROLE_UNAVAILABLE: 'this agent\'s saved role and directions could not be read, so it was not started. Reload the page, then try again',
  AGENT_ENGINE_INVALID_SESSION: 'the session this screen was acting on is no longer one the agent engine knows about, so nothing was changed. Reload the page and start again',
  AGENT_ENGINE_INVALID_TURN: 'the piece of work this was acting on is no longer one the agent engine knows about, so nothing was changed. Reload the page and look at what the session is doing',
})

/* Most entries above are already written for the computer a relay reader is
   driving. The exceptions stay in their desk voice there so local callers keep
   their exact, established wording, and declare a remote twin here. Keeping
   this as a table (rather than replacing words in arbitrary copy) makes the
   correspondence exact and prevents correctly local phrases from changing. */
export const AVAILABILITY_SUBJECT_HERE = 'this computer'
export const AVAILABILITY_SUBJECT_REMOTE = 'the computer you are driving'

const REMOTE_UNAVAILABLE_TEXT = Object.freeze({
  AGENT_CONFINEMENT_SIGNED_OUT: 'This session needs a Codex sign-in, and the computer you are driving does not hold one. The permission level recorded there builds each session from that sign-in. If Codex is installed, on that computer open a new terminal window and run "codex login". If it is not, run "winget install OpenAI.Codex" there first. Then come back to this screen',
})

/* The install steps said one after another inside a longer sentence group.
   Each step is a line of its own in the setup review, so a step can end in a
   bare command ("run: npm install -g @openai/codex"); joined as they were, the
   command ran straight into the next sentence (T1503). Here a step that ends in
   a bare command gets it quoted and a full stop. */
const commandSentence = step => /[.!?]["”]?$/.test(step) ? step : `${step.replace(/run: ([^"]+)$/, 'run "$1"')}.`
function installSentences(steps) {
  return steps.map(commandSentence).join(' ')
}
// The same steps read after "If it is missing," or "Otherwise,".
const midSentence = text => text.charAt(0).toLowerCase() + text.slice(1)

/* THE ONE DOOR THIS MODULE LEFT OPEN, AND B6 CLOSED IT.
 *
 * This used to end `|| String(code || 'unavailable')`: an unknown code was
 * shown VERBATIM, defended on the grounds that codes are short identifiers and
 * never paths. Both halves of that are true and neither is the point. The
 * reason a bare code must not be shown is not that it might be a path, it is
 * that it tells the person nothing and gives them nothing to do -- so a table
 * that answers "the code you have no sentence for" by printing the code is
 * exactly the defect it exists to prevent, kept alive at the one place it is
 * hardest to notice.
 *
 * It is reachable in the shipped product. src/agent-session.js builds
 * `{ ok: false, code: error?.code }` from a rejected availability call, and a
 * platform rejection can carry a `code` of its own (ERR_IPC_CHANNEL_CLOSED and
 * friends) that is in no table here.
 *
 * The code still goes UNSHOWN rather than unused -- callers keep it on the
 * state object -- and an unrecognised one now leaves with the same kind of
 * sentence a recognised one does. It is a copy gap either way, and still not a
 * reason to enable anything: the caller branches on `ok`, never on whether this
 * returned a sentence. */
export function unavailableReason(code, { subject = AVAILABILITY_SUBJECT_HERE, platform = globalThis.mcSetup?.platform } = {}) {
  if (platform === 'linux' || platform === 'darwin') {
    const where = subject === AVAILABILITY_SUBJECT_REMOTE ? 'the computer you are driving' : 'this computer'
    const setup = codexSetupInstructions({ platform, viaRelay: subject === AVAILABILITY_SUBJECT_REMOTE })
    const install = installSentences(setup.install)
    if (code === 'AGENT_CODEX_CLI_NOT_INSTALLED') return `Codex is not installed on ${where}. ${install} Then open a new terminal window and run "${CODEX_SETUP_COMMANDS.signIn}"`
    if (code === 'AGENT_CONFINEMENT_SIGNED_OUT') return `This session needs a Codex sign-in on ${where}. If Codex is installed, ${midSentence(commandSentence(setup.signIn))} If it is missing, ${midSentence(install)}`
    if (code === 'CODEX_CLI_NOT_FOUND') return `The Codex program could not be found on ${where}. If you installed it recently, restart ToolsEnabled on ${where} and try again. Otherwise, ${midSentence(install)}`
    if (code === 'CODEX_VERSION_DETECTION_FAILED') return `Codex did not report its version on ${where}. In a terminal on ${where}, run "codex --version", then try again`
    if (code === 'CODEX_PROTOCOL_VERSION_MISMATCH') return `Codex on ${where} did not identify itself as a usable CLI. Repair the installation: ${midSentence(install)}`
    if (code === 'CODEX_CLI_INCOMPATIBLE') return `The Codex on ${where} cannot run a ToolsEnabled session. It lacks something a session needs, or it gave an answer this copy cannot read. In a terminal on ${where}, run "${CODEX_SETUP_COMMANDS.update}", then start again. If Codex is already up to date, update ToolsEnabled`
  }
  if (subject === AVAILABILITY_SUBJECT_REMOTE && Object.prototype.hasOwnProperty.call(REMOTE_UNAVAILABLE_TEXT, code)) {
    return REMOTE_UNAVAILABLE_TEXT[code]
  }
  if (Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, code)) return UNAVAILABLE_TEXT[code]
  return `this copy could not work out why, which is itself a fault worth reporting. ${refusalRemedy(code)}`
}

/**
 * What a `mcProviders.presence()` reply proves about anybody being SIGNED IN.
 *
 * WHY THIS IS A SECOND READING AND NOT A REUSE OF codexReadiness().
 * src/setup-review-readiness.js answers a Codex-shaped question, correctly and
 * on purpose -- its tone goes to warn whenever Codex is not confirmed, which is
 * the right advice on the recommended path. It is the WRONG verdict for a
 * surface asking "can an agent start here at all", because a computer with
 * Claude installed and signed in and no Codex can genuinely start one. Driven,
 * packaged, three arms: codex signed out with Claude installed answered
 * `ok:true` from engineAvailability(), and it is right to.
 *
 * THE QUESTION THIS ANSWERS IS THE POSITIVE ONE, which is why it could not be
 * borrowed from the negative reading either: is ANY provider both installed and
 * PROVABLY signed in.
 *
 * NOTHING IS ROUNDED IN EITHER DIRECTION, and both directions have a cost worth
 * naming. Rounding an 'unknown' UP prints a green tick over a computer that
 * cannot start anything -- the defect this was written for. Rounding it DOWN
 * tells the Claude user their working machine is broken, which is the same
 * failure wearing the other sign and is exactly what engineAvailability()'s
 * `claudeCouldStart` branch exists to prevent. So an unknown stays unknown and
 * the caller is given enough to say so.
 *
 * @returns `{known, anySignedIn, codexSignedOut}` -- `known:false` when the
 *          reply taught nothing, in which case a caller must say only what it
 *          already said before it asked.
 */
export function providerSignInReading(reply) {
  const unknown = Object.freeze({ known: false, anySignedIn: false, codexSignedOut: false })
  if (!reply || typeof reply !== 'object' || reply.ok !== true || !Array.isArray(reply.providers)) return unknown
  const rows = reply.providers.filter(row => row && typeof row.id === 'string')
  if (rows.length === 0) return unknown
  const codex = rows.find(row => row.id === 'codex')
  return Object.freeze({
    known: true,
    /* Installed AND signed in. A sign-in without the program is not a machine
       that can run anything, and this is the reading a green tick rests on. */
    anySignedIn: rows.some(row => row.installed === 'yes' && row.signedIn === 'yes'),
    /* The one proven negative this product has. shell/provider-cli-presence.cjs:
       only Codex treats a missing sign-in file as proof, "because this shell
       already refuses a start on exactly that basis". */
    codexSignedOut: Boolean(codex && codex.installed === 'yes' && codex.signedIn === 'no'),
  })
}

/* Recover the code from a rejected IPC call, because the property does not
 * survive the trip.
 *
 * THE BUG THIS EXISTS FOR IS NOT A COPY BUG. Electron rebuilds a rejected
 * invoke() in the renderer from the error's name, message and stack; own
 * properties are not carried, so `error.code` is undefined for every refusal
 * that crosses the boundary. The caller's `typeof error?.code === 'string'`
 * test therefore never passed and every single refusal rendered as
 * AGENT_SESSION_FAILED -- which is why the sentences above appeared to be
 * missing when in fact they were unreachable. shell/main.cjs now replaces the
 * error with one whose MESSAGE is the code (and drops the original text, which
 * is the part that could name a path), and this reads it back.
 *
 * IT RETURNS A KEY OF THIS TABLE OR NOTHING, and that is what makes reading a
 * message safe. A candidate has to look like a code -- upper case, digits and
 * underscores only, which no Windows path can be -- AND be a key that already
 * exists here. So the worst a hostile or malformed message can achieve is to
 * name one of our own sentences; it can never get its own text on screen.
 * `error.code` is still preferred when present, so in-process callers and the
 * tests keep working unchanged. */
const CODE_SHAPED = /[A-Z][A-Z0-9_]{2,63}/g

/* WHICH LIMIT REFUSED, WHEN THE HOST COULD TELL, AND null WHENEVER IT COULD NOT.
 *
 * READ BESIDE refusalCode, AND NEVER INSTEAD OF IT. The code says what happened;
 * this says which limit owns it. Both branches of AGENT_RESUME_ACCOUNT_LIMIT
 * carry that code, because the distinction is a property of the refusal rather
 * than a different refusal -- so a caller that must choose whether to continue
 * automatically asks here.
 *
 * null IS THE ANSWER FOR "NOBODY SAID", and every caller must treat it as
 * "leave this alone": an older host, a probe that predates the field, or a
 * refusal this does not describe. The sentence shown to the person is NOT a
 * fallback source for it -- prose drifts, and this whole path exists because a
 * classifier read prose and the copy moved out from under it. */
const REFUSAL_ATTRIBUTION_BY_TOKEN = Object.freeze({
  ATTRIBUTED_TO_PROVIDER: 'provider',
  ATTRIBUTED_TO_CONFIGURED_LIMIT: 'configured',
})
export function refusalAttribution(error) {
  const named = error?.exhaustedBy
  if (named === 'provider' || named === 'configured') return named
  const message = typeof error?.message === 'string' ? error.message : ''
  for (const candidate of message.match(CODE_SHAPED) || []) {
    if (Object.prototype.hasOwnProperty.call(REFUSAL_ATTRIBUTION_BY_TOKEN, candidate)) {
      return REFUSAL_ATTRIBUTION_BY_TOKEN[candidate]
    }
  }
  return null
}

export function refusalCode(error) {
  if (typeof error?.code === 'string' && error.code.length > 0) return error.code
  const message = typeof error?.message === 'string' ? error.message : ''
  for (const candidate of message.match(CODE_SHAPED) || []) {
    if (Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, candidate)) return candidate
  }
  return 'AGENT_SESSION_FAILED'
}
