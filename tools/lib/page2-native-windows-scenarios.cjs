'use strict'

const path = require('node:path')

// This inventory is a coverage specification, not a list of implied passes.
// Shared scenarios belong to page2-native-audit.cjs. run() below supplies the
// Windows picker/clipboard supplements; only an executed step earns a receipt.
const metadata = [
  ['setup-guided', 'shared', ['Choose Guided', 'Continue', 'Pick workspace in the native folder dialog', 'Skip local account sign-in', 'Choose start-on-request', 'Finish setup'], 'The selected workspace and Guided level persist; installed/provider status comes from the real account.'],
  ['root-start', 'shared-provider', ['Computers', 'Empty spot', 'Choose Controller or Manager, GPT-6-Astra and max', 'Enter a bounded brief', 'Start this agent'], 'A real provider returns the unique response token; a launch receipt alone is insufficient.'],
  ['staged-child', 'shared-provider', ['Empty spot below the root', 'Choose Manager and max', 'Set this agent', 'Start tree'], 'The draft has no session until Start tree; its real response belongs to the child.'],
  ['conversation-followup', 'shared-provider', ['Open the created conversation', 'Type a unique follow-up', 'Send'], 'The provider answers the new token in the same live conversation.'],
  ['conversation-search', 'shared', ['Search this conversation', 'Search messages', 'Enter an earlier unique token'], 'The matching earlier message is shown and unrelated messages are filtered.'],
  ['effort-draft', 'shared', ['Type an unsent sentinel in the rail', 'Actions', 'How hard it thinks'], 'The sentinel stays; max is marked as currently running.'],
  ['queue-focus-draft', 'shared', ['Type an unsent sentinel', 'Actions', 'Queue a message'], 'The message box retains the sentinel and receives focus.'],
  ['reports-to-draft', 'shared', ['Type an unsent sentinel', 'Actions', 'Change who it reports to', 'Return to Chat'], 'The draft survives the Details transition.'],
  ['model-menu', 'shared', ['Actions', 'Switch model'], 'The current provider/model is marked and unavailable choices remain gated.'],
  ['windows-picker-cancel', 'windows', ['Type an unsent sentinel', 'Actions', 'Attach an image', 'Cancel the real Windows picker'], 'No attachment appears and the draft is unchanged.'],
  ['windows-palette-mention', 'windows', ['Type an unsent sentinel', 'Actions', 'Mention a file', 'Pick the owned probe file'], 'The same draft gains the exact selected path.'],
  ['windows-toolbar-mention-cancel', 'windows', ['Mention a file on the toolbar', 'Cancel the real Windows picker'], 'Cancellation preserves the draft.'],
  ['windows-image-remove', 'windows', ['Attach an image on the toolbar', 'Pick the owned image', 'Remove its chip'], 'The chip appears and disappears without sending or clearing the draft.'],
  ['mixed-images-send', 'shared-provider', ['Actions → Attach an image → native image A', 'Toolbar Attach an image → native image B', 'Send an image-description prompt'], 'Both removable chips accumulate; the real provider separately describes both actual images.'],
  ['windows-copy-request', 'windows', ['Actions', 'Copy what you asked for', 'Paste into the unsent QA composer'], 'The clipboard matches the original brief exactly.'],
  ['windows-copy-reply', 'windows', ['Actions', 'Copy what it said', 'Paste into the unsent QA composer'], 'The clipboard matches the last verified provider reply exactly.'],
  ['guided-file-read', 'shared-provider', ['Mention the owned text probe', 'Ask the provider to read only it'], 'Record the exact contents if read; record the actual policy refusal or absent tool otherwise. Never upgrade that refusal to a pass.'],
  ['folder-default-label', 'shared', ['Open the selected agent Details', 'Read Works in'], 'The default names the setup folder and its path, not the product checkout.'],
  ['confinement-label', 'shared', ['Read the start permission sentence', 'Open Details → Start more work → Sandbox'], 'Both match the actual mcAgent.confinement tier/sandbox response; an unread response remains unknown.'],
  ['rule-file-refresh', 'shared', ['Leave Details open', 'Send /RequestTree plus an owned rule from the conversation'], 'The new numbered rule appears in Details immediately.'],
  ['rule-edit', 'shared', ['Edit the newly created rule', 'Change its words', 'Save'], 'The new words appear with the same request ID.'],
  ['rule-delete', 'shared', ['Delete the created rule', 'Press Delete again within the confirmation window'], 'Only that rule leaves active instructions; the ledger retains its deleted record.'],
  ['dispatch-gates', 'shared-gate', ['Details', 'Start more work', 'Inspect Launch, Team, Loop and Cloud'], 'Disabled routes show their actual gate; inspection is not dispatch or provider proof.'],
  ['queue-admission', 'shared-provider', ['Start a bounded long response', 'Send FIRST while busy', 'Send SECOND while busy'], 'Two waiting rows appear without overlapping provider turns.'],
  ['queue-priority', 'shared', ['Press Send next on SECOND'], 'The waiting order becomes SECOND, FIRST.'],
  ['queue-unqueue', 'shared', ['Press Unqueue on FIRST'], 'Only FIRST leaves the waiting list.'],
  ['interrupt-holds-queue', 'shared-provider', ['While the long response is active, press Stop this reply'], 'The session remains open, shows stopped-by-you/Interrupted, retains SECOND, and does not synthesize an empty-turn failure.'],
  ['queue-send-now', 'shared-provider', ['Press Send now on the retained SECOND row'], 'The real provider answers SECOND; its waiting row disappears.'],
  ['session-stop', 'shared-provider', ['Actions', 'Stop this agent', 'Confirm if requested'], 'The exact session ends and pending messages are dropped; unrelated nodes remain. Idle live sessions must still expose Stop.'],
  ['session-resume', 'shared-provider', ['Open an ended conversation', 'Send a unique token, or choose Resume with a fresh agent'], 'Recovery mode is reported honestly; the trigger message is answered and subtitle, queue, picker and Actions bind to the new session.'],
  ['session-rewind', 'shared-provider', ['Actions', 'Rewind to one of your messages', 'Choose a kept message', 'Confirm'], 'The new thread keeps the selected history boundary and later messages no longer drive its answer.'],
  ['session-start-over', 'shared-provider', ['Actions', 'Start this conversation over', 'Confirm'], 'The conversation resets while the node role, brief and parent remain.'],
  ['profile-create-refresh', 'shared', ['Fleet overview', 'Name a profile', 'Pick its owned folder', 'Immediately open Start another tree'], 'The new profile is selectable without navigating away and back.'],
  ['staged-root-profile', 'shared', ['Start another tree', 'Choose Observer and the named profile', 'Set this agent'], 'A second staged root uses the selected profile and has no provider process.'],
  ['cross-tree-reparent', 'shared', ['Staged Observer → Details → Reports to Manager → Save'], 'Observer moves under Manager, the tree count drops by one, and destination tree folder semantics apply.'],
  ['staged-remove-cancel', 'shared', ['Staged Observer → Actions → Remove this agent → Back'], 'The staged node and its saved brief remain.'],
  ['staged-remove-confirm', 'shared', ['Staged Observer → Actions → Remove this agent → Remove'], 'Only Observer disappears; a status confirms signed run records are retained.'],
  ['canvas-edit-zoom', 'shared', ['Edit', 'Done', 'Zoom out', 'Zoom in', 'Fit/reset overview'], 'Edit affordances and zoom change visibly without changing the agent topology.'],
  ['conversation-shelf', 'shared', ['Open a second agent conversation', 'Hide chats', 'Show Chats', 'Expand a conversation', 'Collapse it'], 'Both conversations remain available and keep their independent drafts.'],
  ['saved-history', 'shared', ['Rail Chat', 'Browse saved conversation', 'Earlier/Newer where enabled', 'Close the saved history'], 'Saved history is readable in a bounded area and does not overlap the live header/composer.'],
  ['qa-relaunch', 'shared-provider', ['Gracefully close only the QA window', 'Relaunch the same QA user-data folder', 'Reopen Computers'], 'Trees/transcripts persist; old sessions are ended honestly and the owner application is untouched.'],
].map(([id, owner, replay, expected]) => Object.freeze({ id, owner, replay: Object.freeze(replay), expected }))

const executableIds = Object.freeze(metadata.filter(item => item.owner === 'windows').map(item => item.id))

async function settle(page, predicate, message) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await page.waitForTimeout(100)
  }
  throw new Error(message)
}

async function run({ page, picker, check, step, paths, provider }) {
  if (!page || typeof picker !== 'function' || typeof check !== 'function' || typeof step !== 'function') throw new TypeError('Windows scenarios require page, picker, check and step')
  if (!provider?.agentName || !paths?.qaRoot || !paths?.mentionFile || !paths?.imageA) throw new TypeError('Windows scenarios require the created agent name and owned fixture paths')
  for (const value of [paths.mentionFile, paths.imageA]) {
    const relative = path.win32.relative(paths.qaRoot, value)
    if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) throw new Error('Windows scenario fixture must be inside the QA root')
  }
  const conversation = page.getByRole('region', { name: `${provider.agentName} conversation`, exact: true })
  const input = conversation.getByRole('textbox', { name: `Message ${provider.agentName}`, exact: true })
  const actions = conversation.getByRole('button', { name: 'Actions', exact: true })
  const originalDraft = await input.inputValue()
  const sentinel = `WINDOWS_NATIVE_DRAFT_${Date.now()}`
  const attachmentCount = () => conversation.locator('.chat-attachment-chip').count()
  async function closePalette() { if (await actions.getAttribute('aria-expanded') === 'true') await actions.click() }
  async function palette(name) {
    await closePalette()
    await actions.click()
    await conversation.getByRole('option', { name, exact: true }).click()
  }
  async function native(request) {
    const receipt = await picker(request)
    check(receipt?.ok === true, `Native picker ${request.operation} failed: ${receipt?.code || receipt?.error || 'no receipt'}`)
    return receipt
  }
  const receipts = []
  async function audit(id, action) {
    const receipt = await step(id, async () => {
      const details = await action()
      return { status: 'passed', id, ...details }
    })
    receipts.push(receipt)
  }
  try {
    await input.fill(sentinel)
    await audit('windows-picker-cancel', async () => {
      const before = await attachmentCount()
      await palette('Attach an image Opens a file picker. The picked image rides with your next message.')
      const nativeReceipt = await native({ operation: 'cancel' })
      await closePalette()
      check(await input.inputValue() === sentinel, 'Cancelling the native image picker changed the draft')
      check(await attachmentCount() === before, 'Cancelling the picker changed attachments')
      return { native: nativeReceipt, draftRetained: true }
    })
    await audit('windows-palette-mention', async () => {
      await palette('Mention a file Opens a file picker and writes the path into your message. The agent reads it itself, under its own permissions.')
      const nativeReceipt = await native({ operation: 'select-path', selectedPath: paths.mentionFile })
      await closePalette()
      await settle(page, async () => (await input.inputValue()).includes(paths.mentionFile), 'Native file mention did not reach the draft')
      check((await input.inputValue()).includes(sentinel), 'Mentioning the file discarded the existing draft')
      await input.fill(sentinel)
      return { native: nativeReceipt, draftRetained: true }
    })
    await audit('windows-toolbar-mention-cancel', async () => {
      await conversation.getByRole('button', { name: 'Mention a file', exact: true }).click()
      const nativeReceipt = await native({ operation: 'cancel' })
      check(await input.inputValue() === sentinel, 'Cancelling Mention a file changed the draft')
      return { native: nativeReceipt, draftRetained: true }
    })
    await audit('windows-image-remove', async () => {
      const before = await attachmentCount()
      check(before === 0, 'Run the image removal supplement with an empty attachment strip')
      await conversation.getByRole('button', { name: 'Attach an image', exact: true }).click()
      const nativeReceipt = await native({ operation: 'select-path', selectedPath: paths.imageA })
      await settle(page, async () => await attachmentCount() === 1, 'Native image selection did not create a visible attachment')
      await conversation.locator('.chat-attachment-chip').getByRole('button', { name: /Remove/ }).click()
      check(await attachmentCount() === 0, 'Remove left the image attached')
      check(await input.inputValue() === sentinel, 'Removing the image changed the draft')
      return { native: nativeReceipt, removed: true }
    })
    for (const [id, option, expected] of [
      ['windows-copy-request', 'Copy what you asked for', provider.originalBrief],
      ['windows-copy-reply', 'Copy what it said', provider.latestReply],
    ]) {
      await audit(id, async () => {
        check(typeof expected === 'string' && expected.length > 0, `${id} needs the previously verified text from the shared runner`)
        await input.fill('')
        await palette(option)
        await closePalette()
        await input.press('Control+V')
        await settle(page, async () => await input.inputValue() === expected, `${option} did not copy the expected text`)
        return { matchedExpectedText: true }
      })
    }
  } finally {
    await closePalette()
    await input.fill(originalDraft)
  }
  return receipts
}

module.exports = { metadata: Object.freeze(metadata), executableIds, run }
