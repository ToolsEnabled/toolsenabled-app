import { createCompareFilesDoor } from '../../../src/diff-editor.js'
import { createChatDiffOpenHandler } from '../../../src/components.js'
import { mountChatSessionChanges } from '../../../src/chat-session-changes.js'

const settle = () => new Promise(resolve => requestAnimationFrame(resolve))
async function until(predicate) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > deadline) throw Error('Synthetic file selection did not load')
    await settle()
  }
}

window.diffSelectionFixture = async () => {
  const { first, selected } = await window.selectionInputs.read()
  const change = file => ({ path: file, status: 'M', added: 1, removed: 1 })
  const door = createCompareFilesDoor({ storage: () => null })
  const open = createChatDiffOpenHandler(door)
  const root = document.createElement('div'); document.body.appendChild(root)
  const drawer = mountChatSessionChanges(root, { onOpenDiff: open })
  drawer.add({ files: [change(first), change(selected)],
    patches: [{ path: selected, diff: '@@ -1 +1 @@\n-before\n+after\n' }] })
  root.querySelector('[data-changes-toggle]').click()
  root.querySelectorAll('.session-change-file')[1].click()
  await until(() => document.querySelector('[data-diff-pane="proposed"]')?.value === 'after\n')
  const fresh = {
    original: document.querySelector('[data-diff-pane="original"]').value,
    proposed: document.querySelector('[data-diff-pane="proposed"]').value,
    title: document.querySelector('#diff-title').textContent,
  }
  door.close()
  const editor = door.open()
  open({ ...change(selected), patches: [] })
  await until(() => editor.state.sides.proposed.path === selected)
  const reused = document.querySelector('[data-diff-pane="proposed"]').value
  open({ ...change(first), patches: [] })
  await until(() => editor.state.sides.proposed.path === first)
  const retargeted = document.querySelector('[data-diff-pane="proposed"]').value
  door.open()
  const unchanged = editor.state.sides.proposed.path === first
  const oneModal = document.querySelectorAll('.diff-dialog').length === 1
  door.close(); drawer.dispose(); root.remove()
  return { fresh, reused, retargeted, unchanged, oneModal, removed: !document.querySelector('.diff-dialog') }
}
