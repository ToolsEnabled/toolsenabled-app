import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeHTML } from 'entities'
import { chatPreviewText, isPlainVoice, isSafeChatUrl, renderChatMarkdown, renderChatPlain, renderChatVoice } from '../../src/chat-markdown.js'
import { createDocument } from './lib/dom-stand-in.mjs'

const tree = text => { const host = createDocument().createElement('div'); host.innerHTML = renderChatMarkdown(text); return host }
const codeText = html => decodeHTML((/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] || '').replace(/<[^>]*>/g, ''))

test('untrusted text cannot introduce executable tags, arbitrary attributes, or non-web links', () => {
  const attacks = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '**<script>bold</script>**', '`<script>code</script>`', '# <img src=x onerror=alert(1)>', '- <iframe src="javascript:alert(1)">', '> <object data="x">', '|<script>a</script>|b|\n|---|---|\n|c|d|', '[click](javascript:alert(1))', '[click](javascript&#x3a;alert(1))', '[click](data:text/html,anything)', '[click](file:///C:/secret)', '[click](//example.test)', '<a href="javascript:alert(1)">x</a>', '</div><script>alert(1)</script><div>', 'https://evil.test/`<script>x</script>`', '![tracking](https://example.test/pixel)', '```html\n<img onerror="alert(1)">\n```', '```js\" onmouseover=alert(1)\nhello\n```']
  const tags = new Set(['p','br','strong','em','del','s','code','pre','ul','ol','li','blockquote','hr','div','table','thead','tbody','tr','th','td','a','h3','h4','h5','h6','figure','figcaption','span','button'])
  const attrs = new Set(['class','href','target','rel','title','start','data-lang','tabindex','role','aria-label','scope','type','aria-pressed','data-chat-code-wrap','data-chat-code-copy'])
  for (const attack of attacks) {
    const html = renderChatMarkdown(attack)
    for (const [,name] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(tags.has(name.toLowerCase()), `${attack} created ${name}`)
    for (const [tag] of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
      for (const [,name] of tag.matchAll(/\s([a-zA-Z-]+)=/g)) assert.ok(attrs.has(name), `${attack} introduced ${name}`)
      for (const [,href] of tag.matchAll(/href="([^"]*)"/g)) assert.ok(isSafeChatUrl(decodeHTML(href)), href)
    }
    assert.doesNotMatch(html, /<(?:script|img|iframe|object|input)\b/i)
  }
})

test('links support labels, references, balanced punctuation, entities, and inline emphasis', () => {
  const html = renderChatMarkdown('[Read **this**](https://example.test/a_(b)?x=1&y=2)\n\n[reference][ref]\n\n[ref]: https://example.test/docs "Documentation"')
  assert.match(html, /href="https:\/\/example.test\/a_\(b\)\?x=1&amp;y=2"/)
  assert.match(html, /Read <strong>this<\/strong>/)
  assert.match(html, /title="Documentation"/)
  assert.equal((html.match(/rel="noreferrer noopener"/g)||[]).length, 2)
  assert.match(renderChatMarkdown('Read https://example.test/page.'), /href="https:\/\/example.test\/page"[^>]*>.*<\/a>\./)
})

test('URLs adjacent to code never consume the code or leak markup into an attribute', () => {
  for (const text of ['GET https://api.example.test/users/`{id}` returns it', 'https://example.test/path`code`', 'https://example.test/path `code`']) {
    const html = renderChatMarkdown(text)
    assert.match(html, /<code class="md-code">/)
    assert.doesNotMatch(html, /<a [^>]*<code/)
    for (const [,href] of html.matchAll(/href="([^"]*)"/g)) assert.doesNotMatch(href, /[<>]/)
  }
})

test('inline code preserves identifiers, operators, literal backticks, and HTML', () => {
  const html = renderChatMarkdown('Use ``a ` b`` and `**kwargs`, `_private`, `<div>`; snake_case remains literal. 3 * 4 = 12.')
  assert.match(html, /<code class="md-code">a ` b<\/code>/)
  assert.match(html, /<code class="md-code">\*\*kwargs<\/code>/)
  assert.match(html, /<code class="md-code">&lt;div&gt;<\/code>/)
  assert.doesNotMatch(html, /<(?:strong|em)>/)
})

test('headings are semantic, and nested block quotes retain their own paragraphs and lists', () => {
  const host = tree('## Findings\n\n> First paragraph.\n>\n> - A point\n> - **Another**\n>\n> > Nested quote')
  assert.equal(host.querySelector('.md-h2').tagName, 'H4')
  assert.equal(host.querySelectorAll('blockquote').length, 2)
  assert.equal(host.querySelectorAll('li').length, 2)
  assert.equal(host.querySelectorAll('strong').length, 1)
})

test('tasks preserve accessible completion state without changing ordinary bullets', () => {
  const host = tree('- [ ] verify\n- [x] record\n- plain item')
  assert.equal(host.querySelectorAll('ul').length, 1)
  assert.equal(host.querySelectorAll('li').length, 3)
  assert.equal(host.querySelectorAll('.md-task').length, 2)
  assert.equal(host.querySelectorAll('.is-complete').length, 1)
  assert.equal(host.querySelector('.md-task-status').getAttribute('aria-label'), 'Incomplete task')
})

test('fences preserve exact code, allow longer enclosing fences, and remain usable while incomplete', () => {
  const source = 'const a = 1\nconst b = 2\n'
  const html = renderChatMarkdown('before\n\n```js\n'+source+'```\n\nafter')
  assert.equal(codeText(html), source)
  assert.match(html, /data-lang="js"/)
  assert.match(html, /hljs-keyword/)
  assert.match(html, /data-chat-code-copy/)
  assert.match(html, /data-chat-code-wrap/)
  assert.equal(codeText(renderChatMarkdown('````markdown\n```js\nhello\n```\n````')), '```js\nhello\n```\n')
  assert.equal(codeText(renderChatMarkdown('```\nstill code\nand more')), 'still code\nand more')
  assert.equal(codeText(renderChatMarkdown('~~~text\n```\n~~~')), '```\n')
})

test('large or unknown-language code stays complete without expensive guessed highlighting', () => {
  const code = 'complete_value '.repeat(2200)
  assert.equal(codeText(renderChatMarkdown('```unknown\n'+code+'\n```')), code+'\n')
  assert.equal(codeText(renderChatMarkdown('```js\n'+code+'\n```')), code+'\n')
})

test('tables accept optional outer pipes, escaped pipes, rich cells, and numeric alignment', () => {
  const host = tree('Results:\nName | Value\n:--- | ---:\n**one** | `a\\|b`\ntwo | 24')
  assert.equal(host.querySelectorAll('table').length, 1)
  assert.equal(host.querySelectorAll('th').length, 2)
  assert.equal(host.querySelector('th').getAttribute('scope'), 'col')
  assert.equal(host.querySelectorAll('.md-align-right').length, 3)
  assert.equal(host.querySelector('.md-code').textContent, 'a|b')
  assert.equal(host.querySelector('.md-table-wrap').getAttribute('tabindex'), '0')
  assert.doesNotMatch(renderChatMarkdown('run a | b | c in the shell'), /<table/)
})

test('paragraphs and explicitly supplied line breaks survive', () => {
  assert.match(renderChatMarkdown('one\ntwo\n\nthree'), /<p class="md-p">one<br>\ntwo<\/p>\n<p class="md-p">three<\/p>/)
  assert.match(renderChatMarkdown('Title\n=====\n\nBody'), /class="md-h md-h1"/)
})

test('callouts use a fixed label and retain the full formatted body', () => {
  const host = tree('> [!NOTE]\n> Keep **all** of this.\n>\n> A second paragraph.')
  assert.equal(host.querySelector('.md-callout-title').textContent, 'Note')
  assert.equal(host.querySelector('.md-callout').getAttribute('data-tone'), 'note')
  assert.equal(host.querySelectorAll('.md-p').length, 2)
  assert.match(host.textContent, /A second paragraph/)
})

test('empty content stays empty and NUL cannot create a renderer token', () => {
  for(const text of ['', '   ', '\n\n', null, undefined]) assert.equal(renderChatMarkdown(text), '')
  assert.match(renderChatMarkdown('a\u0000123\u0000b and `real`'), /a123b/)
})

test('user and activity lines keep their literal text, with safe links', () => {
  for(const cls of ['is-owner','is-act','other is-owner class']) {
    assert.equal(renderChatVoice(cls, 'use **stars** and _underscores_'), 'use **stars** and _underscores_')
    assert.equal(isPlainVoice(cls), true)
  }
  assert.equal(renderChatPlain('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.match(renderChatPlain('https://example.test/x'), /<a class="md-link"/)
  assert.match(renderChatVoice('is-agent is-coord','**yes**'), /<strong>yes<\/strong>/)
  for(const cls of ['',null,undefined,'is-agent']) assert.equal(isPlainVoice(cls), false)
})

/* T293. A tree CARD showed the agent's reply as its source -- Worker 85 saw
   "two colours: **red** and **yellow**" on a card while the conversation
   beside it rendered the same words properly. A card preview is one clamped
   line with the full text as its tooltip, so the answer is to take the markup
   off rather than to render it there. These call it with values. */
test('a card preview says the words without the markup around them', () => {
  const cases = [
    ['two colours: **red** and **yellow**', 'two colours: red and yellow'],
    ['plain words with no markup', 'plain words with no markup'],
    ['_italic_ and ~~struck~~ and **bold**', 'italic and struck and bold'],
    ['# A heading\n\nand a paragraph', 'A heading and a paragraph'],
    ['- one\n- two\n- three', 'one two three'],
    ['1. first\n2. second', 'first second'],
    ['> a quoted line', 'a quoted line'],
    ['run `npm test` first', 'run npm test first'],
    ['```\nnpm run dist\n```', 'npm run dist'],
    ['- [x] done\n- [ ] not done', 'done not done'],
    ['| a | b |\n|---|---|\n| c | d |', 'a b c d'],
    ['', ''],
    ['   \n  ', ''],
  ]
  for (const [source, expected] of cases) {
    assert.equal(chatPreviewText(source), expected, 'preview of ' + JSON.stringify(source))
  }
})

/* A LINK IS ITS WORDS HERE, NOT ITS ADDRESS. There is nothing to click on a
   card, and the parenthesised URL is exactly the stray token T293 is about. A
   bare address the agent simply typed is a different thing -- that IS the
   message, and it survives; see the next test. */
test('a card preview shows a link by its words and leaves the address behind', () => {
  assert.equal(chatPreviewText('see [the docs](https://example.test/secret-path) please'), 'see the docs please')
  assert.equal(chatPreviewText('![tracking](https://example.test/pixel)'), 'tracking')
  for (const source of ['[click](https://example.test/secret-path)', '![p](https://example.test/pixel)']) {
    assert.ok(!chatPreviewText(source).includes('example.test'), 'a link address reached the card from ' + JSON.stringify(source))
  }
  /* The checkbox glyph this module injects as inline HTML for a task item is
     furniture, not something anybody wrote. */
  assert.ok(!chatPreviewText('- [x] a finished task').includes('\u2713'))
})

/* WHAT SOMEBODY ACTUALLY TYPED SURVIVES AS TYPED. Angle brackets are ordinary
   characters in a reply about code, and a preview that swallowed them would be
   reporting a different message. They are safe here because both previews put
   this through textContent or escapeMarkup -- it is text on a card, never
   markup -- so the honest thing is to show it. */
test('a card preview leaves ordinary punctuation and bare addresses as the agent wrote them', () => {
  assert.equal(chatPreviewText('use the <div> element'), 'use the <div> element')
  assert.equal(chatPreviewText('<script>alert(1)</script>'), '<script>alert(1)</script>')
  assert.equal(chatPreviewText('a bare https://example.test/x link'), 'a bare https://example.test/x link')
})

/* One line, always: the fitter clamps a single row and the tooltip carries the
   rest, so a reply with structure in it must not arrive as several lines. */
test('a card preview is always one line', () => {
  for (const source of ['a\n\nb', '- one\n- two', '# h\n\nbody\n\n> quote', 'line\nbreak']) {
    assert.ok(!/[\n\r]/.test(chatPreviewText(source)), 'a newline survived from ' + JSON.stringify(source))
  }
})

/* The card and the conversation must not come to hold different opinions about
   what the markup was: the preview reads the same parser, so every word the
   rendered conversation shows is a word the preview shows. */
test('a card preview keeps every word the rendered conversation shows', () => {
  for (const source of ['two colours: **red** and **yellow**', '# Heading\n\nbody words', '- alpha\n- beta']) {
    const preview = chatPreviewText(source)
    const rendered = renderChatMarkdown(source).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    for (const word of rendered.split(' ').filter(Boolean)) {
      assert.ok(preview.includes(word),
        'the conversation shows ' + JSON.stringify(word) + ' and the card preview dropped it: ' + JSON.stringify(preview))
    }
  }
})

/* ITEM 5 -- PER-PROVIDER OUTPUT RENDERING, AGAINST WHAT THE PROVIDERS ACTUALLY
 * WRITE.
 *
 * The shapes below were chosen by censusing the owner's LIVE node-transcripts
 * on 2026-09-19 (read only; counts were taken, no owner text, path or account
 * value was copied into this file). Per provider, by share of agent replies:
 *
 *   claude  3677 replies  strong 69%, inline code 58%, bullets 29%, headings
 *                         7%, tables 5%, fences 4% -- and of 770 fence
 *                         openings only 25 carry a language. 2 links in total.
 *   codex    498 replies  inline code 53%, LINKS 44%, bullets 36%, strong 23%.
 *                         Of its 261 links, 226 target a local absolute path
 *                         and 12 a repo-relative path: 238 are file citations,
 *                         not web pages.
 *   local     11 replies  strong 73%, inline code 73%, ordered lists 36%.
 *   gemini      0 replies -- see the refusal recorded below.
 *
 * These call the renderer with values and assert what a reader gets. None of
 * them pins a class name or an attribute order beyond the one thing that is a
 * safety property: whether an href exists at all.
 */
const BACKSLASH = String.fromCharCode(92)
const drivePath = ['C:', 'a', 'worktree', 'src', 'chat-markdown.js'].join(BACKSLASH)
const linkless = html => !/<a\b/i.test(html)
/* THE VISIBLE TEXT, AND WHY IT IS NOT COMPARED WHOLE. Stripping tags inserts a
   space wherever an element ended, and the DOM stand-in's textContent drops the
   whitespace between elements; the two disagree about spacing around a span and
   neither is what a person's eye reports. So these cases assert the thing that
   is actually at stake -- which words are on the page and which markdown
   punctuation is not -- rather than an exact spacing that would pin a
   presentation detail neither helper measures reliably. */
const words = html => decodeHTML(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const shows = (html, ...expected) => {
  for (const wanted of expected) assert.ok(words(html).includes(wanted), `${JSON.stringify(wanted)} is not on the page: ${JSON.stringify(words(html))}`)
}
const hides = (html, ...unwanted) => {
  for (const banned of unwanted) assert.ok(!words(html).includes(banned), `${JSON.stringify(banned)} is still on the page: ${JSON.stringify(words(html))}`)
}

test('codex: a file citation reads as its own words, not as brackets and a path', () => {
  const html = renderChatMarkdown(`See [src/chat-markdown.js](${drivePath}) for the rule.`)
  assert.equal(words(html), 'See src/chat-markdown.js for the rule.',
    'the reader gets a sentence, not markdown source')
  assert.ok(!html.includes(drivePath), 'the local path is not put on the page')
  assert.ok(linkless(html), 'and a local path never becomes something to press')
})

test('codex: a repo-relative citation reads the same way', () => {
  const html = renderChatMarkdown('Changed [tools/test/chat-markdown.test.mjs](tools/test/chat-markdown.test.mjs).')
  shows(html, 'Changed', 'tools/test/chat-markdown.test.mjs')
  hides(html, '](', '[tools/')
  assert.ok(linkless(html))
})

test('codex: a web link in the same reply is still a link', () => {
  const html = renderChatMarkdown('Both [the page](https://example.invalid/a) and [src/x.js](tools/x.js).')
  shows(html, 'the page', 'src/x.js')
  hides(html, '](')
  assert.match(html, /href="https:\/\/example\.invalid\/a"/, 'the web page stays reachable')
  assert.equal((html.match(/<a\b/gi) || []).length, 1, 'and only the web page is a link')
})

test('a target that names a scheme is never turned into a link by any of this', () => {
  for (const target of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd',
    'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)']) {
    const html = renderChatMarkdown(`See [press me](${target}).`)
    assert.ok(linkless(html), `${target} produced a link: ${html}`)
    assert.ok(!/ href=/i.test(html), `${target} produced an href: ${html}`)
  }
})

test('claude: an unlabelled fence is still a code block, and says its language is unknown', () => {
  // 745 of claude's 770 fence openings carry no language, so this is the
  // ordinary case for that provider, not the exception.
  const bare = renderChatMarkdown(['```', 'const answer = 1', '```'].join('\n'))
  assert.equal(codeText(bare).trim(), 'const answer = 1', 'the code survives whole')
  assert.match(bare, /<pre[^>]*>/, 'and is a code block, not a paragraph')
  const labelled = renderChatMarkdown(['```js', 'const answer = 1', '```'].join('\n'))
  assert.equal(codeText(labelled).trim(), 'const answer = 1')
  assert.notEqual(words(bare), words(labelled), 'a named language is distinguishable from an unnamed one')
})

test('claude: the shapes it actually writes survive the renderer', () => {
  const html = renderChatMarkdown([
    '## A heading it wrote',
    '',
    'Some **strong** text with `an inline code span` and a path like src/lib/thing.js.',
    '',
    '- a bullet',
    '- another bullet',
    '',
    '| Left | Right |',
    '| --- | --- |',
    '| a | b |',
    '',
    '> a quoted line',
  ].join('\n'))
  for (const wanted of ['A heading it wrote', 'strong', 'an inline code span', 'a bullet', 'another bullet', 'a quoted line']) {
    assert.ok(words(html).includes(wanted), `${JSON.stringify(wanted)} is missing from ${words(html)}`)
  }
  assert.match(html, /<table\b/, 'the table it wrote is a table')
  assert.match(html, /<blockquote\b/, 'the quote it wrote is a quote')
  assert.ok(!words(html).includes('**'), 'no emphasis punctuation is left on screen')
  assert.ok(!words(html).includes('| ---'), 'no table punctuation is left on screen')
})

test('local: an underscore inside an identifier is not emphasis', () => {
  // 73% of the local model's replies contain an underscore inside a word.
  const html = renderChatMarkdown('Call memory_set and then agent_comms_send_local.')
  assert.equal(words(html), 'Call memory_set and then agent_comms_send_local.')
  assert.ok(!/<em\b/i.test(html), 'the identifier is not italicised into a different name')
})

test('local and claude: a lone asterisk in prose is not emphasis', () => {
  // 40% of claude replies and 36% of local replies contain a lone-asterisk span.
  const html = renderChatMarkdown('The glob src/*.js and the product 3 * 4 are not emphasis.')
  assert.equal(words(html), 'The glob src/*.js and the product 3 * 4 are not emphasis.')
})

test('a card preview of a codex citation shows the words, not the markup', () => {
  assert.equal(chatPreviewText(`Edited [src/x.js](${drivePath}) and moved on.`).replace(/\s+/g, ' '),
    'Edited src/x.js and moved on.')
})
