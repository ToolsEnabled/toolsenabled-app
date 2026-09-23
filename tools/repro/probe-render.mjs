import { renderChatMarkdown, chatPreviewText, isSafeChatUrl, isChatCitationTarget } from '../../src/chat-markdown.js'
const DRIVE = String.fromCharCode(67, 58, 92)
const cases = {
  'codex absolute file citation (226 of 261 codex links)': `See [src/chat-markdown.js](${DRIVE}a${String.fromCharCode(92)}src.js) for the rule.`,
  'codex repo-relative citation (12 of 261)': 'See [tools/test/x.test.mjs](tools/test/x.test.mjs).',
  'an https link (admitted, must still be clickable)': 'See [the page](https://example.invalid/a).',
  'a javascript: target (must never become a link)': 'See [press me](javascript:alert(1)).',
  'a data: target (must never become a link)': 'See [press me](data:text/html,hi).',
  'a vbscript: target (must never become a link)': 'See [press me](vbscript:x).',
  'a fragment citation': 'See [the section](#a-heading).',
}
for (const [name, source] of Object.entries(cases)) {
  console.log(`\n## ${name}\n   html   : ${renderChatMarkdown(source)}\n   preview: ${JSON.stringify(chatPreviewText(source))}`)
}
console.log('\n## the envelope, called with values')
for (const target of ['https://example.invalid/a', 'http://example.invalid/a', 'javascript:alert(1)', 'data:text/html,x',
  'vbscript:x', 'file:///etc/passwd', `${DRIVE}a${String.fromCharCode(92)}b.js`, 'tools/test/x.mjs', '#anchor', '', '   ']) {
  console.log(`   ${JSON.stringify(target).padEnd(30)} safeUrl=${isSafeChatUrl(target)}  citation=${isChatCitationTarget(target)}`)
}
