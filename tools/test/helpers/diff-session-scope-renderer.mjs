import { buildChat, createChatDiffOpenHandler } from '../../../src/components.js'
import { createCompareFilesDoor } from '../../../src/diff-editor.js'
import { sessionActivityEvent } from '../../../src/agent-session-events.js'
import { createConfirmedFileChangeBuffer } from '../../../src/session-change-patches.js'
import '../../../src/styles.css'
import '../../../src/diff-editor.css'

let currentDoor, currentChat
window.prepareDiffHandCase = async id => {
  currentDoor?.close(); currentChat?.remove()
  const sample = (await window.auditInputs.read()).find(row=>row.id===id)
  currentDoor=createCompareFilesDoor({storage:()=>null})
  const open=createChatDiffOpenHandler(currentDoor)
  currentChat=buildChat({title:'File review',onOpenDiff:selection=>open({...selection,sessionId:sample.id})})
  document.body.appendChild(currentChat)
  const pending=createConfirmedFileChangeBuffer()
  for(const packet of sample.packets) {
    const change=pending.add(packet,sessionActivityEvent(packet,packet.sessionId))
    if(change)currentChat.addDiff({source:'session-file-change',id:sample.id,files:change.fileChanges,patches:change.filePatches,activeIndex:0})
  }
}
window.closeDiffHandCase=()=>{currentDoor?.close();currentChat?.remove()}

window.runDiffHostAudit = async () => {
  const cases = await window.auditInputs.read()
  const observed = []
  for (const sample of cases) {
    const door = createCompareFilesDoor({ storage: () => null })
    const open = createChatDiffOpenHandler(door)
    const chat = buildChat({ title: 'Synthetic file review', onOpenDiff: selection => open({ ...selection, sessionId: sample.id }) })
    document.body.appendChild(chat)
    const pending = createConfirmedFileChangeBuffer()
    for (const packet of sample.packets) {
      const change = pending.add(packet, sessionActivityEvent(packet, packet.sessionId))
      if (change) chat.addDiff({ source: 'session-file-change', id: sample.id,
        files: change.fileChanges, patches: change.filePatches, activeIndex: 0 })
    }
    const openButton = chat.querySelector('[data-chat-open-diff]')
    if (!openButton) throw Error('Real chat did not render its Open diff button')
    openButton.click()
    const editor = door.open()
    const deadline = performance.now() + 5000
    while (editor.state.busy) {
      if (performance.now() > deadline) throw Error('Native read did not settle')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    observed.push({ id: sample.id, buttonFound: true, modalCount: document.querySelectorAll('.diff-dialog').length,
      requestedFile: editor.state.change?.path.replaceAll('\\', '/').split('/').pop(),
      refusalCode: editor.state.refusal?.code || null,
      original: document.querySelector('[data-diff-pane="original"]')?.value,
      proposed: document.querySelector('[data-diff-pane="proposed"]')?.value,
      originalBound: Boolean(editor.state.sides.original.path), proposedBound: Boolean(editor.state.sides.proposed.path),
      readOnly: document.querySelector('[data-diff-pane="proposed"]')?.readOnly, note: editor.state.changeNote })
    door.close(); chat.remove()
  }
  return observed
}
