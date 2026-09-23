/* THE ONE SENTENCE THE READ-ONLY EXAMPLE CHAT SHOWS WHEN NEITHER THE PLAN NOR
 * THE CHANNEL NAMED A REASON.
 *
 * src/node-chatbox.js's planNodeChatbox() usually says why a box cannot send
 * -- plan.composerReason for "there is no channel", plan.contextHiddenReason
 * for "your own chat settings hid it". This is the floor under both, for the
 * one shape that names neither. It lives in its own module, not inlined in
 * src/views/computers.js, because every other sentence this box can show
 * already lives in a copy module of its own (CHAT_NOT_RUNNING in
 * src/fleet-tree-copy.js is the sibling case), and tools/check-plain-
 * language.mjs scans string literals wherever they sit -- a copy module is
 * simply where this codebase keeps them so a rewrite is one line, not a grep. */
export const RAIL_CHAT_COPY = Object.freeze({
  noChannel: 'No channel to this agent.',
})
