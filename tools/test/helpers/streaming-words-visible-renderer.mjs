/* The live reply, in a real conversation, read the way a person reads it.
 *
 * A DOM stand-in cannot answer the question this fixture exists for. The
 * presentation sheet HIDES a live bubble that has no words yet
 * (chat-presentation.css: `.msg.them[aria-busy="true"]:not([data-chat-stream="pending"])
 * :has(.chat-msg-text:empty) { display: none }`), so "the text is empty" and
 * "there is nothing on the glass" are the same event to a reader and two
 * different events to a node assertion. Everything below is read through
 * checkVisibility() and getBoundingClientRect() in a real window.
 */
import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/morphs.css'
import '../../../src/chat-content.css'
import '../../../src/chat-session-changes.css'
import '../../../src/chat-presentation.css'
import '../../../src/chat-response.css'
import '../../../src/chat-activity.css'
import '../../../src/readability.css'
import '../../../src/tree-graph.css'
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import { buildChat } from '../../../src/components.js'

const settle = async () => {
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

let chat = null
function openConversation() {
  chat?.dispose()
  chat?.remove()
  document.body.style.cssText = 'margin:0;display:block'
  chat = buildChat({ title: 'Fixture agent', seed: 0, onSend() {} })
  /* as-chat-full is the full conversation dress, not the rail. */
  chat.classList.add('as-chat-full')
  chat.style.cssText = `width:100%;height:${innerHeight}px;max-height:none;box-sizing:border-box;`
  document.body.append(chat)
  return chat
}

const lastReply = () => [...chat.querySelectorAll('.msg.them')].at(-1)
function readReply() {
  const row = lastReply()
  const body = row?.querySelector('.chat-msg-text') ?? null
  const rect = body?.getBoundingClientRect() ?? { width: 0, height: 0 }
  return {
    text: body?.textContent ?? null,
    /* The row, the body, and real painted area: all three, because the sheet
       can hide any one of them and leave the others intact. */
    rowVisible: row?.checkVisibility({ checkVisibilityCSS: true }) ?? false,
    bodyVisible: body?.checkVisibility({ checkVisibilityCSS: true }) ?? false,
    paintedArea: Math.round(rect.width) * Math.round(rect.height) > 0,
    busy: row?.hasAttribute('aria-busy') ?? false,
    codeBlocks: body?.querySelectorAll('.md-pre').length ?? 0,
    listItems: body?.querySelectorAll('.md-list li').length ?? 0,
    literalFence: (body?.textContent ?? '').includes('```'),
  }
}

window.streamingWords = {
  /* THE SCENARIO THE ASSIGNMENT NAMES: the exact shape the desktop session
     relays -- one partial word, then the rest -- in a full conversation. */
  async liveWords() {
    openConversation()
    const stream = chat.openStream({ at: Date.now() })
    stream.push('Streaming ')
    await settle()
    const afterFirstDelta = readReply()
    stream.push('Streaming words')
    await settle()
    const afterSecondDelta = readReply()
    stream.close('Streaming words, saved in full.')
    await settle()
    const afterClose = readReply()
    return { afterFirstDelta, afterSecondDelta, afterClose }
  },

  /* A whole short answer whose only stop ends the text. This is the case the
     old spacing rule could never release while the turn was live. */
  async wholeShortAnswer() {
    openConversation()
    const stream = chat.openStream({ at: Date.now() })
    stream.push('The first response.')
    await settle()
    const live = readReply()
    const emptyNoteGone = chat.querySelector('.chat-log-empty') === null
    stream.close('The first response.')
    await settle()
    return { live, emptyNoteGone, settled: readReply() }
  },

  /* THE BEHAVIOUR THE FIX KEEPS. An unclosed fence must not reach the glass as
     literal punctuation and then change shape when it closes. */
  async unfinishedFence() {
    openConversation()
    const stream = chat.openStream({ at: Date.now() })
    stream.push('An introduction')
    await settle()
    const intro = readReply()
    stream.push('An introduction\n```text\nA partial block')
    await settle()
    const partial = readReply()
    stream.push('An introduction\n```text\nA partial block\n```\n')
    await settle()
    const closed = readReply()
    stream.close('An introduction\n```text\nA partial block\n```\n')
    await settle()
    return { intro, partial, closed }
  },

  /* Live thinking beside a live answer: the choreography the readable hold
     used to drive. Measured rather than assumed, because unholding prose
     changes when speech becomes visible. */
  async thinkingBesideSpeech() {
    openConversation()
    const reply = chat.openStream({ at: Date.now() })
    chat.addAction({ id: 'think-1', kind: 'thinking', tool: 'Thinking', stateKey: 'working', body: 'A supplied ongoing summary. Pending fragment' })
    chat.addAction({ id: 'read-1', kind: 'call', tool: 'Read', stateKey: 'working', body: 'Synthetic pending read' })
    await settle()
    const thought = chat.querySelectorAll('.chat-thinking-body')[0]
    const run = thought?.closest('.chat-action-run') ?? null
    reply.push('An unfinished reply')
    await settle()
    const whileSpeaking = {
      replyText: readReply().text,
      replyVisible: readReply().bodyVisible,
      thoughtVisible: thought?.checkVisibility({ checkVisibilityCSS: true }) ?? false,
      thoughtReachable: (thought?.clientHeight ?? 0) >= (thought?.scrollHeight ?? 1) - 1,
      runOpen: run?.open ?? false,
    }
    reply.push('An unfinished reply is now a complete sentence. Next fragment')
    await settle()
    const afterCompleteSentence = { runOpen: run?.open ?? false }
    run?.querySelector('summary')?.click()
    reply.push('An unfinished reply is now a complete sentence. Next fragment grows')
    await settle()
    const userOpenedRetained = run?.open ?? false
    reply.close('An unfinished reply is now a complete sentence. Next fragment grows.')
    await settle()
    return {
      whileSpeaking,
      afterCompleteSentence,
      userOpenedRetained,
      groups: chat.querySelectorAll('.chat-action-run').length,
    }
  },

  dispose() { chat?.dispose(); chat?.remove(); chat = null; return true },
}
