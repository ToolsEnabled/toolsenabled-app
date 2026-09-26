'use strict';

// FIXTURE: the host's view of the ENGINE's src/lib/r-ledger-agent-gate.js.
// The PARAGRAPH texts below are a verbatim copy of the engine module's
// (refresh them when it changes; tools/test/request-contract.test.mjs also
// pins the real payload's `off` text against the host constant whenever a
// payload is staged). The DECISION is owned by the test through
// MC_TEST_AGENT_FILING ('off' | 'auto' | 'propose') and, for the nested
// "ask me when unsure" sub-setting, MC_TEST_ASK_WHEN_UNSURE ('on'); the real
// module's reading of the settings file, its provenance rule and its refusals
// are proved by the engine suite tests/r-ledger-agent-gate.test.js. What THIS
// fixture proves is the host's wiring on both sides of the switch.
//
// The second nested sub-setting, rules.agent_filed_needs_approval (default
// OFF, the same three-rule reading as ask_when_unsure: only a user/installer
// `true` turns it on), is owned here by MC_TEST_AGENT_FILED_NEEDS_APPROVAL
// ('on'); the fixture store asks agentFiledNeedsApprovalOf() exactly as the
// engine's src/lib/owner-request-store.js asks the real gate.

const AGENT_FILING_SETTING_ID = 'rules.capture_spoken';
const ASK_WHEN_UNSURE_SETTING_ID = 'rules.ask_when_unsure';
const NEEDS_APPROVAL_SETTING_ID = 'rules.agent_filed_needs_approval';
const MODES = Object.freeze({ OFF: 'off', PROPOSE: 'propose', AUTO: 'auto' });
const OPTIONS = Object.freeze({ OFF: false, AUTO: true });

const calls = [];

/* The store's reader: does an agent's filing wait for the person's approval?
   The real module reads the settings document; the fixture reads the test's
   environment. Anything but an explicit 'on' is off -- the default. */
function agentFiledNeedsApprovalOf() {
  return process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL === 'on';
}

function loadAgentFilingMode(options = {}) {
  calls.push(options);
  const asked = process.env.MC_TEST_AGENT_FILING;
  if (asked === 'throw') throw new Error('fixture gate asked to throw');
  const mode = asked === MODES.AUTO || asked === MODES.PROPOSE ? asked : MODES.OFF;
  return Object.freeze({
    settingId: AGENT_FILING_SETTING_ID,
    mode,
    state: mode === MODES.OFF ? 'withheld' : 'enabled',
    value: mode === MODES.OFF ? false : true,
    provenance: { source: mode === MODES.OFF ? 'default' : 'user', atMs: 0, directive: null },
    askWhenUnsure: process.env.MC_TEST_ASK_WHEN_UNSURE === 'on',
    needsApproval: agentFiledNeedsApprovalOf(),
    why: mode === MODES.OFF ? `"${AGENT_FILING_SETTING_ID}" is off.` : null
  });
}

const PARAGRAPH_NO_ASKING = 'Agents do not file, propose or ask about standing rules on this computer: when something the person says sounds like a rule, do not offer to record it and do not end your reply with a question about it — carry on with the work and leave the ledger to them.';
const PARAGRAPH_OFF = 'If the person types /Request, /RequestSession, /RequestTree, or /RequestThread here, ToolsEnabled itself files their words as a standing rule — you need no tool for that and should not act on the command yourself; the chat shows the person the confirmation, and the rules above are read again at each session start. ' + PARAGRAPH_NO_ASKING;
const PARAGRAPH_OFF_PAGE_ONLY = 'The person adds standing rules by hand on the Ledger page; the typed rule commands are turned off in their Settings, so do not suggest typing one. ' + PARAGRAPH_NO_ASKING;

const PARAGRAPH_OPENING = 'If the person types /Request, /RequestSession, /RequestTree, or /RequestThread here, ToolsEnabled itself files their words — do not act on the command yourself.';

const PARAGRAPH_JUDGEMENT = 'Never propose or file the task at hand, an "ok", your own inference, a paraphrase, or anything that looks like a secret, password, key or token (say you did not file it). '
  + 'A fact with evidence goes to research.finding_save; a piece of work for later goes in your reply as "I would queue that".';

const PARAGRAPH_PROPOSE = `${PARAGRAPH_OPENING} `
  + 'You may also SUGGEST a rule: when the person says, in their own words, something meant to hold beyond this reply — a preference, a limit, a way they want things done — '
  + 'call r_ledger.propose with their exact words, the scope and key named in the block above (global; session <id>; tree <anchor>; thread <id>), and one line saying why. '
  + 'The person sees the suggestion and accepts or declines it; nothing is filed until they do. '
  + `${PARAGRAPH_JUDGEMENT} If unsure, ask in one sentence.`;

const PARAGRAPH_AUTO_LEAD = `${PARAGRAPH_OPENING} `
  + 'You file the person\'s standing rules for them: when the person says, in their own words, something meant to hold beyond this reply — a preference, a limit, a way they want things done — '
  + 'call r_ledger.file with their exact words, the scope and key named in the block above, and one line saying why; the chat shows them what you filed and where, and every later session reads it. '
  + 'Scope: meant for all agents → global; "this session" or "today" → session; "you and your helpers" → tree; "in this conversation" → thread; ';

const PARAGRAPH_AUTO = `${PARAGRAPH_AUTO_LEAD}`
  + 'unclear → the narrowest, and say so. '
  + `${PARAGRAPH_JUDGEMENT} If unsure, call r_ledger.propose instead.`;

// The same paragraph with the person's "ask me when unsure" sub-setting on
// (rules.ask_when_unsure): doubt files nothing and ends the reply with one
// question; the person's yes files their original sentence, never a rewrite.
const PARAGRAPH_AUTO_ASK = `${PARAGRAPH_AUTO_LEAD}`
  + 'unclear or unsure → file nothing; end your reply with ONE short question; when the person answers yes, file their ORIGINAL sentence. '
  + `${PARAGRAPH_JUDGEMENT}`;

const PARAGRAPH_WITHHELD = 'The person has asked agents to watch for standing rules, but this permission level withholds the filing tool. '
  + 'When something they say is meant to hold from now on, say so plainly and suggest they type /Request, /RequestSession, /RequestTree or /RequestThread — ToolsEnabled files it. Do not look for another route.';

// Appended to the auto paragraphs when rules.agent_filed_needs_approval is
// on: the agent is told its filing waits for the person. Verbatim from the
// engine module; refresh with it.
const PARAGRAPH_NEEDS_APPROVAL = 'A rule you file waits for the person\'s approval on the Ledger page before it counts.';

/**
 * @param {string} mode   'off' | 'propose' | 'auto' (anything else reads as off)
 * @param {{canFile?: boolean, askWhenUnsure?: boolean, needsApproval?: boolean}} options
 *        whether this session actually carries the r_ledger tools (servers
 *        running, profile not read-only), whether the person's "ask me when
 *        unsure" sub-setting is on (loadAgentFilingMode().askWhenUnsure), and
 *        whether an agent's filing waits for approval
 *        (loadAgentFilingMode().needsApproval)
 */
function requestContractParagraph(mode, { canFile = false, askWhenUnsure = false, needsApproval = false, chatFiling = true } = {}) {
  if (mode !== MODES.PROPOSE && mode !== MODES.AUTO) return chatFiling === false ? PARAGRAPH_OFF_PAGE_ONLY : PARAGRAPH_OFF;
  if (!canFile) return PARAGRAPH_WITHHELD;
  if (mode !== MODES.AUTO) return PARAGRAPH_PROPOSE;
  const paragraph = askWhenUnsure === true ? PARAGRAPH_AUTO_ASK : PARAGRAPH_AUTO;
  return needsApproval === true ? `${paragraph} ${PARAGRAPH_NEEDS_APPROVAL}` : paragraph;
}

module.exports = Object.freeze({
  AGENT_FILING_SETTING_ID,
  ASK_WHEN_UNSURE_SETTING_ID,
  NEEDS_APPROVAL_SETTING_ID,
  MODES,
  OPTIONS,
  PARAGRAPH_OFF,
  PARAGRAPH_NEEDS_APPROVAL,
  calls,
  agentFiledNeedsApprovalOf,
  loadAgentFilingMode,
  requestContractParagraph
});
