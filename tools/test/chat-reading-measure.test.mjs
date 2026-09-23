// Bound prose to a readable line length while code and tables use the panel.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { renderChatMarkdown } from '../../src/chat-markdown.js'

const standInModule = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(standInModule)
const { document, restore } = installDomStandIn(globalThis)
const components = new Map()

after(() => {
  for (const [root, dispose] of components) { dispose(); root.remove() }
  restore()
})

const { buildChat } = await import('../../src/components.js')
const styles = readFileSync(new URL('../../src/chat-content.css', import.meta.url), 'utf8')

/* The FIRST top-level `selector { ... }` rule body for an exact selector
   string -- matching tools/test/chat-msg-text-newlines.test.mjs's own
   helper of the same name. */
function ruleBody(css, selector) {
  const needle = `${selector} {`
  const start = css.indexOf(needle)
  if (start === -1) return null
  const openBrace = start + needle.length - 1
  const close = css.indexOf('}', openBrace)
  if (close === -1) return null
  return css.slice(openBrace + 1, close)
}

function chat(options) {
  const root = buildChat(options)
  components.set(root, root.dispose)
  document.documentElement.appendChild(root)
  return root
}
function disposeChat(root) {
  const dispose = components.get(root)
  dispose()
  components.delete(root)
  root.remove()
}

const SAMPLE = '## Findings\n\nThis paragraph is the part a reader actually has to read.\n\n- one item\n- two item\n\n> a quoted line'

test('renderChatMarkdown really emits the four prose classes this suite pins -- grounded, not assumed', () => {
  const out = renderChatMarkdown(SAMPLE)
  for (const cls of ['md-h', 'md-p', 'md-list', 'md-quote']) {
    assert.match(out, new RegExp(`class="[^"]*\\b${cls}\\b`), `renderChatMarkdown no longer emits .${cls} -- this suite would be pinning a rule nothing ever wears`)
  }
})

for (const [label, css, prefix] of [
  ['shared chat typography', styles, '.chat-message-body'],
]) {
  test(`${label}: every prose block is held to a bounded reading measure`, () => {
    for (const cls of ['.md-p', '.md-h', '.md-list', '.md-quote']) {
      const body = ruleBody(css, `${prefix} ${cls}`)
      assert.ok(body !== null, `no "${prefix} ${cls} {" rule in ${label}`)
      assert.match(body, /max-width\s*:\s*(?:6\d|7[0-5])ch\s*;/, `${prefix} ${cls} has no 70ch reading measure -- a long answer can run edge to edge again`)
    }
  })

  test(`${label}: code and tables keep the full panel, not the 70ch prose measure`, () => {
    for (const cls of ['.md-pre', '.md-table-wrap']) {
      const body = ruleBody(css, `${prefix} ${cls}`)
      assert.ok(body !== null, `no "${prefix} ${cls} {" rule in ${label}`)
      assert.match(body, /max-width\s*:\s*100%\s*;/, `${prefix} ${cls} must keep the panel's full width -- narrowing it to 70ch would make wide code/tables scroll more, not read better`)
      assert.ok(!/max-width\s*:\s*70ch/.test(body), `${prefix} ${cls} picked up the prose 70ch cap; it must keep its own 100% instead`)
    }
  })
}

test('a real agent turn built through buildChat() carries the classes the styles.css rules above are keyed on', () => {
  const root = chat({ title: 'agent-x', seed: 0, history: [{ who: 'agent', text: SAMPLE }] })
  const row = root.querySelector('.chat-log').children
    .find(node => node.classList.contains('msg') && node.classList.contains('them'))
  assert.ok(row, 'no .msg.them row was built from history')
  const body = row.querySelector('.chat-msg-text')
  assert.ok(body, '.chat-msg-text is gone from makeMsg')
  assert.ok(body.querySelector('.md-p'), 'a real render lost its paragraph class')
  assert.ok(body.querySelector('.md-h'), 'a real render lost its heading class')
  assert.ok(body.querySelector('.md-list'), 'a real render lost its list class')
  assert.ok(body.querySelector('.md-quote'), 'a real render lost its quote class')
  disposeChat(root)
})
