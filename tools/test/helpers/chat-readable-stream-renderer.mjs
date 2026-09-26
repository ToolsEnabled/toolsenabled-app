import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/chat-content.css'
import '../../../src/chat-session-changes.css'
import '../../../src/chat-presentation.css'
import '../../../src/chat-response.css'
import '../../../src/chat-activity.css'
import '../../../src/readability.css'
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import { buildChat } from '../../../src/components.js'

const settle = async () => {
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}
const text = 'FIRST PARAGRAPH\n\n' + Array.from({ length: 48 }, (_, i) => `Paragraph ${i + 1}. Readable text remains in the conversation while later words arrive.`).join('\n\n') + '\n\nLAST PARAGRAPH\n\n'
let chat
window.chatReadability = {
  async measure(zoom) {
    chat?.dispose()
    chat?.remove()
    document.body.style.cssText = `margin:0;display:block;zoom:${zoom}`
    chat = buildChat({ title: 'Fixture agent', seed: 0, onSend() {} })
    chat.style.cssText = `width:100%;height:${Math.floor(innerHeight / zoom)}px;max-height:none;box-sizing:border-box;`
    document.body.append(chat)
    const stream = chat.openStream()
    const chunkStages = []
    for (const part of ['A sentence', 'A sentence arrives.', 'A sentence arrives. Next fragment']) {
      stream.push(part)
      await settle()
      chunkStages.push(chat.querySelector('.msg.them .chat-msg-text').textContent)
    }
    stream.push(text)
    await settle()
    const log = chat.querySelector('.chat-log')
    const body = chat.querySelector('.msg.them .chat-msg-text')
    const metrics = element => ({ bodyHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      innerScrollTop: element.scrollTop, first: element.textContent.includes('FIRST PARAGRAPH'),
      last: element.textContent.includes('LAST PARAGRAPH'), busy: element.closest('.msg')?.hasAttribute('aria-busy') || false,
      logScrollHeight: log.scrollHeight, logHeight: log.clientHeight })
    const live = metrics(body)
    log.scrollTop = 0
    await settle()
    const firstRect = body.querySelector('p').getBoundingClientRect(), logRect = log.getBoundingClientRect()
    const firstReachable = firstRect.top >= logRect.top - 1 && firstRect.bottom <= logRect.bottom + 1
    log.scrollTop = 140
    await settle()
    const readingBefore = log.scrollTop
    stream.push(text + '\n\nAdditional arriving words.')
    await settle()
    const readingAfter = log.scrollTop
    stream.close(text)
    await settle()
    const finished = metrics(body)
    const thinking = chat.addThinking(text)
    thinking.querySelector('summary').click()
    await settle()
    const thought = metrics(thinking.querySelector('.chat-msg-text'))
    chat.addAction({ id: 'read-one', kind: 'call', tool: 'Read', stateKey: 'done', body: 'Synthetic read result.' })
    const summary = { id: 'summary-one', kind: 'thinking', tool: 'Thinking', stateKey: 'working' }
    const thinkingStages = []
    for (const part of ['A thought', 'A thought arrives.', 'A thought arrives. Next fragment']) {
      chat.addAction({ ...summary, body: part })
      await settle()
      thinkingStages.push(chat.querySelector('.chat-thinking-body').textContent)
    }
    chat.addAction({ ...summary, body: text })
    chat.addAction({ id: 'read-two', kind: 'call', tool: 'Read', stateKey: 'done', body: 'Second synthetic result.' })
    await settle()
    const thoughtBody = chat.querySelector('.chat-thinking-body')
    const run = thoughtBody.closest('.chat-action-run')
    const liveThought = metrics(thoughtBody)
    const openWhileThinking = run.open && thoughtBody.closest('.chat-action').open
    const toolLine = run.querySelector('.chat-action-detail').textContent
    chat.addAction({ ...summary, stateKey: 'done', body: text })
    await settle()
    const folded = !run.open
    run.querySelector('summary').click()
    thoughtBody.closest('.chat-action').querySelector('summary').click()
    await settle()
    const finishedThought = metrics(thoughtBody)
    run.scrollIntoView({ block: 'start' })
    await settle()
    const thinkingGroups = chat.querySelectorAll('.chat-action-run').length
    const pendingReply = chat.openStream()
    chat.addAction({ id: 'ongoing-thinking', kind: 'thinking', tool: 'Thinking', stateKey: 'working', body: 'A supplied ongoing summary. Pending fragment' })
    chat.addAction({ id: 'ongoing-tool', kind: 'call', tool: 'Read', stateKey: 'working', body: 'Synthetic pending read' })
    await settle()
    const ongoingThought = chat.querySelectorAll('.chat-thinking-body')[1]
    const ongoingRun = ongoingThought.closest('.chat-action-run')
    pendingReply.push('An unfinished reply')
    await settle()
    const pendingVisible = { runOpen: ongoingRun.open, thoughtVisible: ongoingThought.checkVisibility({ checkVisibilityCSS: true }), replyText: [...chat.querySelectorAll('.msg.them .chat-msg-text')].at(-1).textContent }
    pendingReply.push('An unfinished reply is now a complete sentence. Next fragment')
    await settle()
    const completeSentenceFolded = !ongoingRun.open
    ongoingRun.querySelector('summary').click()
    pendingReply.push('An unfinished reply is now a complete sentence. Next fragment grows')
    await settle()
    const userOpenedRetained = ongoingRun.open
    pendingReply.close()

    /* T404: A REPLY THAT STOPS MID-ANSWER, MEASURED ON THE GLASS.
       The stream is pushed a table row that never finishes and is then left
       alone -- exactly what a stalled session or a truncated reply leaves
       behind. Before, the row went on claiming to be working while the text
       that had arrived sat invisible and nothing said why. This reads the real
       computed style, so it measures the CSS delay as well as the DOM: the
       note must be silent through an ordinary sub-frame hold and must be
       READABLE once the hold outlasts one. */
    const stalled = chat.openStream()
    const stalledText = ['Here is the comparison you asked for.', '', '| ' + 'a measured cell of the answer '.repeat(20)].join('\n')
    stalled.push(stalledText)
    await settle()
    const stalledRow = [...chat.querySelectorAll('.msg.them')].at(-1)
    const heldNote = stalledRow.querySelector('.chat-stream-held')
    const readable = element => element && Number(getComputedStyle(element).opacity) > 0.5
      && element.checkVisibility({ checkVisibilityCSS: true })
    const stallHold = {
      marked: stalledRow.hasAttribute('data-chat-held'),
      heldChars: Number(stalledRow.dataset.chatHeld || 0),
      arrived: stalledText.length,
      painted: stalledRow.querySelector('.chat-msg-text').textContent.length,
      notePresent: Boolean(heldNote),
      noteText: heldNote?.textContent || '',
      readableImmediately: readable(heldNote),
      busy: stalledRow.hasAttribute('aria-busy'),
    }
    await new Promise(resolve => setTimeout(resolve, 2800))
    await settle()
    stallHold.readableAfterWait = readable(heldNote)
    stallHold.noteHeight = heldNote ? heldNote.getBoundingClientRect().height : 0
    // The turn finally completes: everything arrived is painted and the row
    // stops saying anything is held.
    stalled.close([stalledText + '|', '| --- |', ''].join('\n'))
    await settle()
    stallHold.markedAfterClose = stalledRow.hasAttribute('data-chat-held')
    stallHold.noteAfterClose = Boolean(stalledRow.querySelector('.chat-stream-held'))
    stallHold.paintedAfterClose = stalledRow.querySelector('.chat-msg-text').textContent.length

    /* ITEM 5: A CODEX FILE CITATION, MEASURED ON THE GLASS.
       codex writes a markdown link in 44% of its replies and 238 of its 261
       measured links target a local file, not a web page. The unit suite can
       only see the HTML; whether the result READS as a reference and not as a
       dead link is a question about the cascade, so it is asked here. The
       reply below carries one citation and one real web link in the same
       sentence, which is the shape that has to stay distinguishable. */
    const citationChat = chat.openStream()
    const DRIVE = ['C:', 'a', 'worktree', 'src', 'chat-markdown.js'].join(String.fromCharCode(92))
    citationChat.close(`Edited [src/chat-markdown.js](${DRIVE}) after reading [the guide](https://example.invalid/g).`)
    await settle()
    const citationRow = [...chat.querySelectorAll('.msg.them')].at(-1)
    const citationNode = citationRow.querySelector('.md-citation')
    const linkNode = citationRow.querySelector('.md-link')
    const box = element => element?.getBoundingClientRect() || { width: 0, height: 0 }
    const citation = {
      present: Boolean(citationNode),
      text: citationNode?.textContent || '',
      tag: citationNode?.tagName?.toLowerCase() || '',
      readable: Boolean(citationNode) && Number(getComputedStyle(citationNode).opacity) > 0.5
        && citationNode.checkVisibility({ checkVisibilityCSS: true }),
      width: box(citationNode).width,
      height: box(citationNode).height,
      colour: citationNode ? getComputedStyle(citationNode).color : '',
      cursor: citationNode ? getComputedStyle(citationNode).cursor : '',
      decorationStyle: citationNode ? getComputedStyle(citationNode).textDecorationStyle : '',
      linkPresent: Boolean(linkNode),
      linkTag: linkNode?.tagName?.toLowerCase() || '',
      linkCursor: linkNode ? getComputedStyle(linkNode).cursor : '',
      linkDecorationStyle: linkNode ? getComputedStyle(linkNode).textDecorationStyle : '',
      // The whole point: no markdown punctuation and no local path on screen.
      rowText: citationRow.querySelector('.chat-msg-text')?.textContent || '',
      anchors: citationRow.querySelectorAll('a').length,
    }

    return { zoom, live, finished, thought, chunkStages, readingBefore, readingAfter, firstReachable, stallHold, citation,
      pendingThinking: { pendingVisible, completeSentenceFolded, userOpenedRetained },
      thinkingStream: { stages: thinkingStages, live: liveThought, finished: finishedThought, openWhileThinking, folded, toolLine, groups: thinkingGroups },
      horizontalOverflow: Math.max(log.scrollWidth - log.clientWidth, body.scrollWidth - body.clientWidth) }
  },
}
