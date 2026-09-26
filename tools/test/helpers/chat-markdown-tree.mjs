import { renderChatMarkdown } from '../../../src/chat-markdown.js'
import { createDocument } from '../lib/dom-stand-in.mjs'
export function markdownTree(text) {
  const host = createDocument().createElement('div')
  host.innerHTML = renderChatMarkdown(text)
  return host
}
export const directLists = node => node.children.filter(child => ['OL','UL'].includes(child.tagName))
export const items = list => list.children.filter(child => child.tagName === 'LI')
export const startAt = list => list.getAttribute('start') === null ? 1 : Number(list.getAttribute('start'))
