/* THE WORDS FOR A COMPUTER'S CONVERSATIONS, READ FROM A SIGNED-IN BROWSER.
 *
 * A browser driving a computer can list the conversations that computer's own
 * window started, open one, and send to it (src/desktop-sessions.js). The
 * computer decides every one of those steps and answers a refusal with a code.
 * This module turns each code into a sentence a person can act on; the code
 * itself stays on a data attribute and never reaches the screen.
 *
 * The first two sentences are the interface's own wording for a conversation
 * that is listed but cannot be opened from a browser. They are kept verbatim so
 * the computer and the browser describe the same rule the same way. */

export const DESKTOP_SESSION_COPY = Object.freeze({
  othersTitle: 'Other conversations on your computer',
  othersHelp: 'Agents running on your computer that are not drawn in the tree here. Open one to read it and send it a message.',
  unnamed: 'Conversation on your computer',
  open: 'Open',
  railTitle: 'Conversation on your computer',
  backAria: 'Back to the fleet overview',
  opening: 'Opening this conversation from your computer.',
  replying: 'Replying now',
  waiting: 'Waiting for a message',
  notOpenable: 'Open it at the computer',
  truncated: 'Your computer is running more conversations than this list can show. Close some at the computer to see the rest.',
  noSavedConversation: 'Your computer keeps no saved messages for this conversation. New messages still show here.',
  readOnly: 'Your computer lets this browser read this conversation but not send to it. To send, turn on Let a signed-in browser drive this computer in its Settings, then open this conversation again.',
  earlier: 'Show earlier messages',
  earlierLoading: 'Loading earlier messages.',
  sendUnconfirmed: 'This message is not confirmed yet. Checking your computer for it now.',
  sendConfirmed: 'Your computer has this message, so there is no need to send it again.',
  sendNotShownYet: 'Your computer does not show this message yet. Open the conversation again in a moment to check before you send it again.',
  sendUncheckable: 'Your computer could not be checked for this message. Open the conversation again to see whether it arrived before you send it again.',
  ended: 'This conversation has ended on your computer. Go back to the tree to open another one.',
  turnFailed: 'This reply did not finish on your computer. Open the conversation at the computer to see what stopped it.',
  closedByChange: 'The connection to your computer changed, so this conversation was closed. Open it again from here, in the tree.',
  clipped: 'This message is shortened here. Read the full text on your computer.',
  contextLabel: 'Added by ToolsEnabled',
  contextSummary: Object.freeze({
    tree: 'Where this agent sits in its tree',
    requests: 'Your standing requests',
    role: 'The role it was given',
    tools: 'The tools it can use',
    capabilities: 'What it is allowed to do',
  }),
})

const SENTENCES = Object.freeze({
  MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION: 'This conversation started before this computer’s connection to your account last changed, so it can only be continued at the computer.',
  MC_AGENT_REMOTE_SESSION_BOUNDED_WORK: 'This agent is doing a bounded job that was started at the computer. Follow it there.',
  AGENT_FACADE_ABSENT: 'The ToolsEnabled app on your computer needs an update before this browser can open its conversations. Update the app on your computer, then try again.',
  MC_AGENT_PRINCIPAL_READ_ONLY: 'Your computer does not let a signed-in browser send messages, so this one was not sent. Turn on Let a signed-in browser drive this computer in its Settings. Your text is still in the box.',
  AGENT_TURN_ACTIVE: 'The agent is still replying, so this message was not sent. Your text is still in the box. Send it again when the reply finishes.',
  MC_AGENT_REMOTE_SESSION_REFUSED: 'Your computer did not open this conversation for this browser. Go back to the tree to see the conversations you can open.',
  MC_AGENT_SESSION_ENDED: 'This conversation has ended on your computer. Go back to the tree to open another one.',
  MC_AGENT_CONNECTION_CLOSED: 'The connection to your computer closed. Check that your computer is on and connected, then open the conversation again.',
  MC_AGENT_PRINCIPAL_INVALID: 'Your computer did not open this conversation for this browser. Go back to the tree to see the conversations you can open.',
  BRIDGE_UNREACHABLE: 'Your computer cannot be reached right now. Check that it is on and connected, then open the conversation again.',
  BRIDGE_TIMEOUT: 'Your computer took too long to answer. Wait a moment, then open the conversation again.',
  MC_AGENT_TRANSCRIPT_UNAVAILABLE: 'Your computer could not read the saved messages for this conversation. New messages still show here. Open this conversation again from here later to see the earlier ones.',
  MC_AGENT_TRANSCRIPT_CURSOR_INVALID: 'Earlier messages could not be loaded. Open the conversation again to load them.',
  MC_AGENT_INVALID_PAYLOAD: 'Your computer did not take this message. Send plain text of up to 200,000 characters.',
})

const GENERIC = 'Your computer did not complete this request. Wait a moment, then try again.'


/** The sentence for a refusal while listing or opening a conversation. */
export function desktopSessionSentence(code) {
  return (typeof code === 'string' && Object.hasOwn(SENTENCES, code)) ? SENTENCES[code] : GENERIC
}

/* A SEND WHOSE ANSWER NEVER CAME BACK MAY STILL HAVE ARRIVED. Neither "sent"
   nor "not sent" is true yet, so the message stays on screen as unconfirmed
   and the transcript is read to settle it (src/desktop-sessions.js). */
export function sendAnswerWasLost(code) {
  return code === 'BRIDGE_UNREACHABLE' || code === 'BRIDGE_TIMEOUT'
    // The native forwarding leg can finish without an answer after dispatch.
    // These responses explicitly leave the outcome unknown; they never prove
    // that the computer refused the message. Reconcile without another send.
    || code === 'AGENT_FACADE_TIMEOUT' || code === 'AGENT_FACADE_ABORTED'
    || code === 'AGENT_FACADE_UNREACHABLE' || code === 'AGENT_FACADE_RESPONSE_TOO_LARGE'
}

/** The sentence for a send the computer refused. Nothing was sent on any of these. */
export function desktopSendSentence(code) {
  return desktopSessionSentence(code)
}

export const DESKTOP_SESSION_SENTENCES = Object.freeze({ ...SENTENCES, GENERIC })
