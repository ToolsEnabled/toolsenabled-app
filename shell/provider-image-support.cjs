'use strict';

/* CAN THIS AGENT'S PROVIDER ACTUALLY RECEIVE A PICTURE?
 *
 * The owner's report, 2026-09-15: "images paste into chat but DONT get sent to
 * the agent and cause an error." The measured cause was not in this app -- it
 * saved the file, allowlisted it and forwarded it, and the provider adapter
 * refused the whole turn. Before that fix, exactly ONE of five providers could
 * carry a pasted picture.
 *
 * Two things follow, and this file is the second one.
 *
 * FIRST, the provider that can carry a picture should carry it -- that is the
 * engine change (claude-cli-adapter, proven against the real CLI: an image
 * content block on --input-format stream-json came back described, so the model
 * received it).
 *
 * SECOND, and this is the part a person feels: a provider that CANNOT carry a
 * picture must say so IN PLAIN WORDS, BEFORE the send, not fail the turn with a
 * code afterwards. "This agent cannot look at pictures" is something a person
 * can act on -- they can start a different agent, or describe the thing in
 * words. `MC_AGENT_...` in a red box at the end of a send they already
 * committed to is not.
 *
 * WHY A TABLE HERE RATHER THAN ASKING THE ENGINE. The app must answer this
 * before it sends anything, and there is no capability query on the adapter
 * seam -- the ACP adapter learns its agent's image capability only from a
 * handshake it has already completed, and the others answer by throwing at
 * send time. A table the app owns is the only thing that can speak BEFORE the
 * turn. It is therefore a claim this file makes and has to keep true:
 * tools/test/provider-image-support.test.mjs is where it is held to it, and
 * every entry below names the engine code that decides the real answer, so the
 * two can be compared by a reader rather than trusted.
 */

/* Measured at engine 16462165 plus the T18 delivery fix, by reading each
   adapter's sendTurn: see src/lib/agent-engine/{claude-cli,codex,acp,
   local-node,antigravity-cli}-adapter.js. */
const PROVIDER_IMAGE_SUPPORT = Object.freeze({
  claude: Object.freeze({
    delivers: true,
    /* claude-cli-adapter.sendTurn builds an image content block per picture.
       Proven against claude (Claude Code) 2.1.259 on 2026-09-15: the model
       named the colour of a picture it was sent. */
    because: 'claude-cli-adapter sends an image content block on stream-json input',
    /* THE BYTES HAVE TO CROSS THE WIRE, so this delivery path reads the whole
       file and carries it inside the turn -- and refuses a picture bigger than
       the engine's own MAX_IMAGE_BYTES. See readsTheFile below for why that
       one fact is what this flag records. */
    readsTheFile: true
  }),
  codex: Object.freeze({
    delivers: true,
    /* codex-adapter.sendTurn pushes { type: 'localImage', path } and the Codex
       CLI opens the file itself. */
    because: 'codex-adapter sends the picture as a localImage input item',
    /* THE PATH TRAVELS, NOT THE BYTES, so no byte ceiling of this product's
       applies: refusing a large picture here would refuse one this provider
       delivers today. */
    readsTheFile: false
  }),
  gemini: Object.freeze({
    delivers: false,
    /* acp-adapter refuses ACP_IMAGE_UNSUPPORTED when the agent never advertised
       the image capability, and ACP_IMAGE_INVALID for a local path when no
       imageLoader is injected -- and nothing in either repository injects one.
       The antigravity client refuses earlier still: AGY_CLI_IMAGES_UNSUPPORTED,
       "Antigravity stream input supports text only". */
    because: 'the ACP and Antigravity transports carry text only in this build'
  }),
  grok: Object.freeze({
    delivers: false,
    because: 'the ACP transport carries text only in this build'
  }),
  local: Object.freeze({
    delivers: false,
    /* local-node-adapter: LOCAL_NODE_IMAGES_UNSUPPORTED, "This local model
       session cannot take images yet". */
    because: 'a local model session in this build takes words only'
  })
});

/* An UNKNOWN provider is treated as unable to take pictures, deliberately.
   Guessing "yes" for a provider nobody has checked puts the person back in the
   defect this file exists to end: a picture that silently does not arrive. A
   wrong "no" costs a picture and says so; a wrong "yes" costs the answer. */
const UNKNOWN = Object.freeze({
  delivers: false,
  because: 'this build has not measured whether that provider can take pictures'
});

function supportFor(provider) {
  if (typeof provider !== 'string' || provider === '') return UNKNOWN;
  return PROVIDER_IMAGE_SUPPORT[provider] || UNKNOWN;
}

/* THE PICTURE THIS APP ACCEPTED AND THE PICTURE THE ENGINE WILL CARRY WERE TWO
 * DIFFERENT SIZES, AND NOBODY WAS TOLD.
 *
 * MEASURED, 2026-09-16, real files and the real adapter: shell/main.cjs
 * MAX_PASTE_IMAGE_BYTES accepts a pasted picture up to 8 MiB, writes it to
 * disk and puts a chip in the composer; the engine's own
 * src/lib/agent-engine/turn-image-bytes.js MAX_IMAGE_BYTES is 3 000 000, so a
 * 4 321 918-byte PNG -- an ordinary screenshot of a busy screen -- came back
 * from ClaudeCliAdapter.sendTurn as CLAUDE_CLI_IMAGE_TOO_LARGE, "A picture may
 * be at most 3000000 bytes. Nothing was sent.", with zero transport writes.
 * The person lost the picture AND their words, and what the window said was
 * "The message was not sent. Check that this agent is still available, then
 * try again." (src/fleet-tree-copy.js sendRefusalSentence) -- which names
 * neither the picture nor a size, and which no amount of trying again fixes.
 *
 * THE NUMBER IS READ FROM THE ENGINE, NEVER COPIED HERE. A second literal is
 * how the two caps came to disagree in the first place. A payload that does not
 * export one answers null, and null means "this build cannot know" -- no
 * refusal is invented from a guess.
 */
function deliverableImageBytes({ requireModule, engineRoot, join } = {}) {
  if (typeof requireModule !== 'function' || typeof engineRoot !== 'string' || !engineRoot) return null;
  const joinPath = typeof join === 'function' ? join : ((...parts) => parts.join('/'));
  let module_;
  try { module_ = requireModule(joinPath(engineRoot, 'src', 'lib', 'agent-engine', 'turn-image-bytes.js')); }
  catch { return null; }
  const bytes = module_ && module_.MAX_IMAGE_BYTES;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/* WHICH PROVIDERS THAT BYTE CEILING ACTUALLY BINDS. Only a delivery path that
   reads the file into the turn is bound by it; Codex hands over the path and
   the CLI opens the file itself, so applying a ceiling there would refuse a
   picture this product delivers today. A provider that cannot take a picture at
   all is not answered with a size -- pictureNotSentSentence already tells that
   person the true reason. */
function deliveryByteLimitFor(provider, engineLimit) {
  if (!Number.isSafeInteger(engineLimit) || engineLimit <= 0) return null;
  const support = supportFor(provider);
  return support.delivers && support.readsTheFile === true ? engineLimit : null;
}

/* Decimal MB, because the engine's ceiling is a decimal number (3 000 000) and
   quoting it as 2.9 MiB would leave a person comparing a figure the product
   never applies. One decimal place: enough to act on, no false precision. */
function megabytes(bytes) {
  return (bytes / 1_000_000).toFixed(1) + ' MB';
}

/* The sentence a person reads INSTEAD of losing the send. Same three things in
   the same order as pictureNotSentSentence: what did not happen, why, and what
   is still true -- here, what they can do about it. */
function pictureTooLargeSentence(fileName, bytes, limit) {
  const named = typeof fileName === 'string' && fileName ? `The picture ${fileName} is` : 'That picture is';
  return `${named} ${megabytes(bytes)}, and this agent can read a picture of at most ${megabytes(limit)}, so it was not attached. Send a smaller copy, or describe what is in it.`;
}

/* The sentence a person reads. It says three things, in this order, because
   that is the order the questions arrive in: what did not happen, why, and
   what is still true (their words did go). No code, no file path -- the file
   NAME, because that is what they recognise on their own screen. */
function pictureNotSentSentence(provider, fileNames) {
  const support = supportFor(provider);
  const names = (Array.isArray(fileNames) ? fileNames : []).filter(name => typeof name === 'string' && name);
  const what = names.length === 0
    ? 'The picture was not sent'
    : names.length === 1
      ? `The picture ${names[0]} was not sent`
      : `The ${names.length} pictures were not sent (${names.join(', ')})`;
  return `${what}: this agent cannot look at pictures, because ${support.because}. Your message was sent without it.`;
}

module.exports = {
  supportFor, pictureNotSentSentence, PROVIDER_IMAGE_SUPPORT,
  deliverableImageBytes, deliveryByteLimitFor, pictureTooLargeSentence,
};
