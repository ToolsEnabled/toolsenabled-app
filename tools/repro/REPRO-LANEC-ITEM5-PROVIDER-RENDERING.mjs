/* ITEM 5 -- per-provider output rendering, measured against what the providers
 * actually write.
 *
 * The defect: codex cites files as markdown links, and 238 of its 261 links in
 * the owner's LIVE transcripts target a local path rather than a web page.
 * markdown-it drops the link token entirely when validateLink refuses, so the
 * paragraph rendered the SOURCE -- brackets, parens and a full absolute path --
 * instead of the words. Refusing to make a local path clickable is right and is
 * not changed here; what changes is that the reader gets a sentence.
 *
 * RED at 9413ef30, GREEN at the tip. The safety half of the script is the
 * important half: it must be GREEN at BOTH commits, because a fix that made a
 * scheme target clickable would be far worse than the defect it cured.
 *
 * Usage: node tools/repro/REPRO-LANEC-ITEM5-PROVIDER-RENDERING.mjs
 * Exit 0 = GREEN, exit 1 = RED.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const md = await import(pathToFileURL(path.resolve('src/chat-markdown.js')).href)
const { renderChatMarkdown, chatPreviewText } = md

const failures = []
const check = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
  if (!ok) failures.push(name)
}
const visible = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const BACKSLASH = String.fromCharCode(92)
const DRIVE_PATH = ['C:', 'a', 'worktree', 'src', 'chat-markdown.js'].join(BACKSLASH)

console.log('# 1. codex file citations (238 of its 261 measured links)')
for (const [label, target] of [
  ['an absolute path (226 links)', DRIVE_PATH],
  ['a repo-relative path (12 links)', 'tools/test/chat-markdown.test.mjs'],
]) {
  const html = renderChatMarkdown(`See [src/chat-markdown.js](${target}) for the rule.`)
  check(`${label}: the words are on the page`, visible(html).includes('src/chat-markdown.js'), true)
  check(`${label}: no markdown punctuation is on the page`, visible(html).includes(']('), false)
  check(`${label}: the target is not put on the page`, html.includes(target), false)
  check(`${label}: it is not something to press`, /<a\b/i.test(html), false)
}

console.log('\n# 2. the card preview of the same reply')
const preview = chatPreviewText(`Edited [src/x.js](${DRIVE_PATH}) and moved on.`)
check('the preview shows the words', preview.includes('src/x.js'), true)
check('the preview shows no markdown punctuation', preview.includes(']('), false)
check('the preview does not carry the local path', preview.includes(DRIVE_PATH), false)

console.log('\n# 3. A WEB LINK IS STILL A WEB LINK')
const mixed = renderChatMarkdown('Both [the page](https://example.invalid/a) and [src/x.js](tools/x.js).')
check('the http(s) link is still reachable', /href="https:\/\/example\.invalid\/a"/.test(mixed), true)
check('and it is the only anchor in the paragraph', (mixed.match(/<a\b/gi) || []).length, 1)

console.log('\n# 4. THE SAFETY ENVELOPE -- GREEN AT BOTH COMMITS OR THE FIX IS WORSE THAN THE BUG')
for (const target of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)',
  'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', 'about:blank']) {
  const html = renderChatMarkdown(`See [press me](${target}).`)
  check(`${target} never becomes an anchor`, /<a\b/i.test(html), false)
  check(`${target} never produces an href`, / href=/i.test(html), false)
  /* AND IT IS NOT QUIETLY RECLASSIFIED AS A CITATION EITHER. The claim this
     change makes is that the set of admitted targets got NARROWER, not wider:
     a target naming a scheme keeps exactly the literal rendering it had at
     9413ef30. Without this, a classifier that admitted everything would still
     look safe here, because the anchor guard in link_open would catch it --
     defence in depth is good, but it is not the property being claimed. */
  check(`${target} keeps its old literal rendering`, visible(html).includes(']('), true)
}
if (typeof md.isChatCitationTarget !== 'function') {
  console.log('#   SKIPPED: the classifier isChatCitationTarget is not exported at this commit,')
  console.log('#   which is the expected answer at 9413ef30 and not a failure of this run.')
} else {
  console.log('#   and a citation target is admitted only where it is meant to be')
  check('a local path is classified as a citation', md.isChatCitationTarget(DRIVE_PATH), true)
  for (const target of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd',
    'about:blank', 'https://example.invalid/a', '', '   ']) {
    check(`${JSON.stringify(target)} is not a citation target`, md.isChatCitationTarget(target), false)
  }
}

console.log('\n# 5. claude shapes (3677 replies: strong 69%, inline code 58%, bullets 29%, fences 4%)')
const bareFence = renderChatMarkdown(['```', 'const answer = 1', '```'].join('\n'))
check('an unlabelled fence is still a code block', /<pre\b/.test(bareFence), true)
check('and keeps its code', bareFence.includes('const answer = 1'), true)
const claudeShapes = renderChatMarkdown([
  '## A heading', '', 'Some **strong** text and `an inline span`.', '',
  '- a bullet', '', '| Left | Right |', '| --- | --- |', '| a | b |',
].join('\n'))
check('the table it wrote is a table', /<table\b/.test(claudeShapes), true)
check('no emphasis punctuation is left on screen', visible(claudeShapes).includes('**'), false)
check('no table punctuation is left on screen', visible(claudeShapes).includes('| ---'), false)

console.log('\n# 6. local shapes (underscores inside identifiers in 73% of its replies)')
const identifiers = renderChatMarkdown('Call memory_set and then agent_comms_send_local.')
check('an identifier is not italicised into a different name', /<em\b/i.test(identifiers), false)
check('and reads exactly as written', visible(identifiers).includes('agent_comms_send_local'), true)

console.log('\n# 7. gemini: REFUSED, and this names itself')
console.log('#   The owner\'s LIVE node-transcripts hold 0 gemini nodes and 0 gemini replies')
console.log('#   (383 node directories: 341 claude, 40 codex, 2 local). A gemini fixture')
console.log('#   cannot be built from a real transcript because no real gemini transcript')
console.log('#   exists on this machine. No gemini fixture was invented.')

console.log(`\n${failures.length ? `RED  ${failures.length} check(s) failed: ${failures.join('; ')}` : 'GREEN  all checks passed'}`)
process.exit(failures.length ? 1 : 0)
