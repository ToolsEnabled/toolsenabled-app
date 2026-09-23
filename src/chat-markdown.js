import MarkdownIt from 'markdown-it'
import { highlightChatCode, chatCodeLanguage } from './chat-code-highlight.js'

// CommonMark, tables, strikethrough, tasks, and explicit line breaks are shared
// by every model and transcript. Raw HTML stays text, images never fetch on
// their own, and links only admit HTTP(S). Responses cannot install app actions.
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false, maxNesting: 64 })
const escape = md.utils.escapeHtml
const sourceText = text => String(text ?? '').replace(/\u0000/g, '')

export function isSafeChatUrl(value) {
  if (!/^https?:\/\//i.test(value) || /[\s<>"'`\\\u0000-\u001f\u007f]/.test(value)) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

/* ITEM 5, CODEX: A FILE CITATION IS NOT A URL, AND IT WAS BEING SHOWN AS
 * PUNCTUATION.
 *
 * MEASURED over the owner's LIVE node-transcripts, 2026-09-19 (counts only; no
 * path was copied out): codex writes a markdown link in 44% of its replies,
 * 261 links in all -- and 238 of them do not name a web page. 226 target a
 * local file by absolute path and 12 by repo-relative path. claude, by
 * contrast, writes 2 links in 3677 replies. Refusing to make a local path
 * clickable is right and is unchanged. What was wrong is what the reader then
 * saw: markdown-it drops the link token entirely when validateLink refuses, so
 * the paragraph rendered the SOURCE -- "See [src/chat-markdown.js](C:\...)" --
 * brackets, parens and a full absolute path, for the great majority of codex's
 * citations. The image rule below already answers exactly this question the
 * right way for an unsafe image: keep the label, drop the target. This is that
 * same answer for links.
 *
 * THE SAFETY ENVELOPE IS NARROWER, NOT WIDER. A citation is a target carrying
 * NO scheme of two or more characters. `javascript:`, `data:` and `vbscript:`
 * all have one and are refused here exactly as before, and so is an http(s)
 * URL that isSafeChatUrl itself rejected -- those keep their old literal
 * rendering rather than being quietly promoted. A single letter before a colon
 * is a Windows drive, not a scheme, which is the 226-link case. What this
 * admits is admitted ONLY so that link_open can render it WITHOUT an href;
 * nothing reachable from here can produce a clickable local target. */
export function isChatCitationTarget(value) {
  const target = String(value ?? '')
  if (!target.trim() || isSafeChatUrl(target)) return false
  return !/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(target)
}
md.validateLink = value => isSafeChatUrl(value) || isChatCitationTarget(value)
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
// Linkify text after code spans have been parsed. The eager inline linkifier
// otherwise consumes a backtick span glued onto an endpoint URL.
md.inline.ruler.disable('linkify')

// Models sometimes continue a nested procedure at 4. without a blank line.
// Extend only that nested-list boundary; top-level prose and fenced/indented
// code retain the standard rules. The pinned parser owns all list parsing.
const listRule = md.block.ruler.__rules__.find(rule => rule.name === 'list')
const parseList = listRule.fn
md.block.ruler.at('list', (state, start, end, silent) => {
  const parent = state.parentType
  if (silent && parent === 'paragraph' && state.listIndent >= 0 && state.sCount[start] >= state.blkIndent) state.parentType = 'list'
  try { return parseList(state, start, end, silent) } finally { state.parentType = parent }
}, { alt: listRule.alt })

const classes = {
  paragraph_open: 'md-p', bullet_list_open: 'md-list', ordered_list_open: 'md-list',
  blockquote_open: 'md-quote', hr: 'md-rule', code_inline: 'md-code',
  table_open: 'md-table', link_open: 'md-link',
}
for (const [type, name] of Object.entries(classes)) {
  const original = md.renderer.rules[type]
  md.renderer.rules[type] = (tokens, index, options, env, self) => {
    tokens[index].attrJoin('class', name)
    return original ? original(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
  }
}
md.renderer.rules.code_inline = (tokens, index) => `<code class="md-code">${escape(tokens[index].content)}</code>`
for (const type of ['heading_open', 'heading_close']) {
  md.renderer.rules[type] = (tokens, index, options, env, self) => {
    const token = tokens[index], level = Number(token.tag.slice(1))
    if (type === 'heading_open') token.attrJoin('class', `md-h md-h${level}`)
    // Response headings live below the page and conversation headings.
    token.tag = `h${Math.min(level + 2, 6)}`
    return self.renderToken(tokens, index, options)
  }
}
/* THE ONE PLACE A LINK BECOMES CLICKABLE, AND THE ONE PLACE IT DOES NOT.
   A citation target (isChatCitationTarget above) reaches here only so that it
   can be rendered WITHOUT an href: the label survives as readable words and the
   local path is not put on the page at all. The `<a>` branch is entered only
   for a target isSafeChatUrl accepts, which is http(s) and nothing else, so no
   change here can make a local path or a scheme URL clickable. The matching
   link_close reads the same token pair, so the two can never disagree. */
const isCitationToken = token => !isSafeChatUrl(token?.attrGet?.('href') || '')
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (isCitationToken(token)) return '<span class="md-citation">'
  token.attrs = [['class', 'md-link'], ...token.attrs.filter(([key]) => key !== 'class')]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noreferrer noopener')
  return self.renderToken(tokens, index, options)
}
md.renderer.rules.link_close = (tokens, index, options, env, self) => {
  // markdown-it guarantees the matching open token for a close token, so the
  // opening decision is re-read rather than remembered in module state.
  let depth = 0
  for (let at = index - 1; at >= 0; at -= 1) {
    if (tokens[at].type === 'link_close') depth += 1
    else if (tokens[at].type === 'link_open') {
      if (depth === 0) return isCitationToken(tokens[at]) ? '</span>' : self.renderToken(tokens, index, options)
      depth -= 1
    }
  }
  return self.renderToken(tokens, index, options)
}
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const alt = self.renderInlineAsText(token.children || [], options, env) || 'Image'
  const url = token.attrGet('src') || ''
  const label = escape(`Image: ${alt}`)
  return isSafeChatUrl(url)
    ? `<a class="md-link md-image-link" href="${escape(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    : `<span class="md-image-label">${label}</span>`
}

function renderCode(tokens, index) {
  const token = tokens[index], language = chatCodeLanguage(token.info)
  const html = highlightChatCode(token.content, language.id)
  return `<figure class="md-code-block"><figcaption class="md-code-head"><span class="md-code-language">${escape(language.label)}</span><span class="md-code-tools"><button type="button" class="md-tool" data-chat-code-wrap aria-pressed="false" aria-label="Wrap code lines">Wrap</button><button type="button" class="md-tool" data-chat-code-copy aria-label="Copy code">Copy</button></span></figcaption><pre class="md-pre" data-lang="${escape(language.id)}" tabindex="0" aria-label="${escape(language.label)} code"><code>${html}</code></pre></figure>\n`
}
md.renderer.rules.fence = renderCode
md.renderer.rules.code_block = renderCode
md.renderer.rules.table_open = () => '<div class="md-table-wrap" tabindex="0" role="region" aria-label="Table"><table class="md-table">\n'
md.renderer.rules.table_close = () => '</table></div>\n'
for (const type of ['th_open', 'td_open']) {
  md.renderer.rules[type] = (tokens, index, options, env, self) => {
    const token = tokens[index]
    const alignment = token.attrGet('style')?.match(/^text-align:(left|right|center)$/)?.[1]
    token.attrs = (token.attrs || []).filter(([key]) => key !== 'style')
    if (alignment) token.attrJoin('class', `md-align-${alignment}`)
    if (type === 'th_open') token.attrSet('scope', 'col')
    return self.renderToken(tokens, index, options)
  }
}

const CALLOUTS = Object.freeze({ NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' })
md.core.ruler.after('inline', 'chat_structure', state => {
  const lists = []
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index]
    if (['bullet_list_open', 'ordered_list_open'].includes(token.type)) lists.push(token)
    if (['bullet_list_close', 'ordered_list_close'].includes(token.type)) lists.pop()
    if (token.type === 'list_item_open') {
      const inline = state.tokens[index + 2]
      const first = inline?.type === 'inline' ? inline.children?.[0] : null
      const task = first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content)
      if (task) {
        const done = task[1].toLowerCase() === 'x'
        token.attrJoin('class', `md-task${done ? ' is-complete' : ''}`)
        const list = lists.at(-1)
        if (list && !list.attrGet('class')?.includes('md-task-list')) list.attrJoin('class', 'md-task-list')
        first.content = first.content.slice(task[0].length)
        const status = new state.Token('html_inline', '', 0)
        status.content = `<span class="md-task-status" role="img" aria-label="${done ? 'Completed task' : 'Incomplete task'}">${done ? '✓' : ''}</span>`
        inline.children.unshift(status)
      }
    }
    if (token.type === 'blockquote_open') {
      const inline = state.tokens[index + 2]
      const first = inline?.type === 'inline' ? inline.children?.[0] : null
      const callout = first?.type === 'text' && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(first.content)
      if (callout) {
        token.attrJoin('class', 'md-callout')
        token.attrSet('data-tone', callout[1].toLowerCase())
        token.meta = { callout: CALLOUTS[callout[1]] }
        inline.children.shift()
        if (inline.children[0]?.type === 'softbreak') inline.children.shift()
      }
    }
  }
})
const quoteOpen = md.renderer.rules.blockquote_open
md.renderer.rules.blockquote_open = (tokens, index, options, env, self) =>
  quoteOpen(tokens, index, options, env, self) + (tokens[index].meta?.callout
    ? `<p class="md-callout-title">${tokens[index].meta.callout}</p>` : '')

export function renderChatMarkdown(text) {
  const source = sourceText(text)
  return source.trim() ? md.render(source).trim() : ''
}

// User punctuation and tool/product output stay literal. Links use the same
// URL policy and balanced-punctuation parser as assistant responses.
export function renderChatPlain(text) {
  const source = sourceText(text), links = md.linkify.match(source) || []
  const parts = []
  let from = 0
  for (const link of links) {
    if (!isSafeChatUrl(link.url)) continue
    parts.push(escape(source.slice(from, link.index)), `<a class="md-link" href="${escape(link.url)}" target="_blank" rel="noreferrer noopener">${escape(link.text)}</a>`)
    from = link.lastIndex
  }
  parts.push(escape(source.slice(from)))
  return parts.join('')
}
export function isPlainVoice(voiceClass) {
  return String(voiceClass ?? '').split(/\s+/).some(token => ['is-owner', 'is-act'].includes(token))
}
export function renderChatVoice(voiceClass, text) {
  return isPlainVoice(voiceClass) ? renderChatPlain(text) : renderChatMarkdown(text)
}

/* THE SAME MARKDOWN THE CONVERSATION READS, SAID AS ONE LINE OF WORDS.
 *
 * T293, found on screen by Worker 85: a tree CARD showed the agent's reply as
 * its source -- "two colours: **red** and **yellow**" -- while the conversation
 * beside it rendered the same words properly. A card preview is one clamped
 * line under a fitter, with the full text as its tooltip, so rendering real
 * markup there is not the answer; taking the markup OFF is.
 *
 * IT READS THE TOKENS THIS MODULE ALREADY PRODUCES rather than stripping
 * asterisks with a regular expression. A second opinion about what markdown is
 * would disagree with renderChatMarkdown the first time either moved, and the
 * disagreement would show up as punctuation on somebody's screen. One parser,
 * two presentations.
 *
 * Structure becomes a single space: a preview is a sentence, not a document.
 * Code keeps its own text (a reply that is mostly a command should preview as
 * that command), link text survives and its URL does not, and the inline HTML
 * this module injects for task checkboxes is dropped rather than shown.
 */
export function chatPreviewText(text) {
  const source = sourceText(text)
  if (!source.trim()) return ''
  const parts = []
  const walk = tokens => {
    for (const token of tokens) {
      if (token.children?.length) { walk(token.children); continue }
      if (token.type === 'text' || token.type === 'code_inline'
        || token.type === 'fence' || token.type === 'code_block') { parts.push(token.content); continue }
      if (token.type === 'html_inline' || token.type === 'html_block') continue
      if (token.type === 'image') { parts.push(token.content || ''); continue }
      parts.push(' ')
    }
  }
  let tokens
  /* A source markdown-it cannot parse is still somebody's message. Falling back
     to the raw words shows the asterisks again for that one message, which is
     the old behaviour and strictly better than showing nothing. */
  try { tokens = md.parse(source, {}) } catch { return source.replace(/\s+/g, ' ').trim() }
  walk(tokens)
  return parts.join('').replace(/\s+/g, ' ').trim()
}
