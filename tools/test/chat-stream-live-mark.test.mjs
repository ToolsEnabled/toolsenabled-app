/* A TURN STILL ARRIVING LOOKED EXACTLY LIKE A TURN THAT HAD FINISHED.
 *
 * The only live signal openStream put on the message itself was the identity
 * dot's breath (.msg.them[aria-busy="true"]::before, chat-core-breathe) --
 * and that dot is the SPEAKER's mark, drawn whether or not any words are
 * coming. So a person watching a slow reply could not tell "still writing"
 * from "stopped, and that is all it said" except by waiting to see whether
 * anything more appeared. Three independent searches over this sheet found
 * no streaming animation at all among chat-tool-spin, chat-writing-wave,
 * chat-work-reveal, chat-message-arrive, chat-composer-sheen,
 * chat-orbit-turn and chat-core-breathe.
 *
 * This pins the live mark and the three properties that make it honest:
 * it is on ::after so it cannot overwrite the identity dot; it is qualified
 * by [aria-busy="true"] so it leaves when close() settles the answer; and
 * under a reduced-motion preference it STOPS MOVING WITHOUT DISAPPEARING,
 * because a motion preference must not be answered by withholding a fact.
 *
 * It also pins what this build must NOT have done: src/tree-graph.css clamps
 * every animation inside a graph node (`.static-tree-graph .node *` ->
 * `animation: none !important`) and re-admits a named few above it. A live
 * mark that ran inside a node would have needed a hole in that clamp.
 *
 * THE SANCTIONED SET IS TWO, NOT ONE. The clamp's own comment names laneSweep
 * and it is easy to read that as the only exception; `.node-drift-light` runs
 * driftLightIn under the same `!important` and has done since before this
 * build. Measured identical at 2ff5e1e0 and here. This test therefore pins
 * the set as the sheet actually has it and asserts that this build added
 * nothing to it -- an assertion written from the shorthand would have failed
 * on correct pre-existing code, which is a test reporting its own premise
 * as a defect.
 *
 * CSS has no callable surface in this runtime (there is no DOM here -- see
 * chat-action-stream.test.mjs, which reads components.js as text for the
 * same reason), so these are structural assertions. Comments are stripped
 * before every scan: an earlier scan in this pair of files matched its own
 * explanatory prose and stayed green through a mutation that removed the
 * thing it claimed to check.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src')
const uncommented = (path) => readFileSync(join(SRC, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
const presentation = uncommented('chat-presentation.css')
const treeGraph = uncommented('tree-graph.css')

/** Every `selector { body }` pair in a comment-free sheet. */
function rules(css) {
  const found = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(css))) found.push({ selector: match[1].trim(), body: match[2] })
  return found
}

const liveMark = rules(presentation).filter(r => /\banimation:|background:/.test(r.body) && r.selector.includes('[aria-busy="true"]::after'))

test('a live turn carries a mark of its own while the words are arriving', () => {
  const moving = liveMark.filter(r => /animation:\s*chat-stream-flow/.test(r.body))
  assert.equal(moving.length, 1, 'exactly one rule should animate the live mark')
  assert.match(presentation, /@keyframes chat-stream-flow\s*\{/, 'chat-stream-flow is used but never defined')
  assert.match(moving[0].body, /var\(--chat-stream-blue\)/, 'the live mark does not use the streaming colour')
})

test('the mark is blue on paper and still blue on the dark themes', () => {
  const declarations = presentation.match(/--chat-stream-blue:\s*([^;]+);/g) || []
  assert.ok(declarations.length >= 2,
    `--chat-stream-blue has ${declarations.length} value(s); a single value cannot hold contrast on both light and dark themes`)
  const values = new Set(declarations.map(d => d.split(':')[1].trim()))
  assert.ok(values.size >= 2, 'the dark-theme override repeats the light value, so it is not an override')
  const dark = rules(presentation).find(r => /--chat-stream-blue:/.test(r.body) && r.selector.includes('data-theme'))
  assert.ok(dark, 'no theme-scoped value for --chat-stream-blue')
})

test('the mark never overwrites the speaker identity dot', () => {
  /* ::before is the role dot, coloured from --chat-role. A live mark drawn
     there would replace who is speaking with whether they are still typing. */
  for (const rule of rules(presentation)) {
    if (/animation:\s*chat-stream-flow/.test(rule.body)) {
      assert.ok(!rule.selector.includes('::before'),
        `"${rule.selector}" draws the live mark on the identity dot`)
    }
  }
})

test('the mark leaves when the answer settles', () => {
  for (const rule of liveMark) {
    assert.ok(rule.selector.includes('[aria-busy="true"]'),
      `"${rule.selector}" marks a message as live without requiring it to BE live, so a finished answer keeps a running progress bar for ever`)
  }
})

test('a reduced-motion preference stops the mark without hiding it', () => {
  const stills = rules(presentation).filter(r =>
    r.selector.includes('[aria-busy="true"]::after') && /animation:\s*none/.test(r.body))
  // Both mechanisms this sheet uses: the class the app sets, and the OS query.
  assert.ok(stills.some(r => r.selector.includes('body.reduce-motion')),
    'the live mark keeps animating for someone who set the in-app reduce-motion preference')
  /* EVERY such block, not only the first. The sheet may answer the OS query in
     more than one place -- a focused block beside the feature it governs is the
     better shape, not a fault -- and matching once made a newer block hide the
     rule that was still present and still applying. The rule must exist inside
     a reduced-motion block; which block is not this test's business. */
  const media = [...presentation.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g)]
  assert.ok(media.some(m => /\[aria-busy="true"\]::after/.test(m[1])),
    'the live mark keeps animating under the operating system reduced-motion setting')
  for (const rule of stills) {
    assert.ok(!/display:\s*none|content:\s*none|visibility:\s*hidden/.test(rule.body),
      `"${rule.selector}" answers a motion preference by removing the mark, which withholds the fact that the answer is unfinished`)
  }
})

/** Every animation name a graph node is allowed to run, as the sheet has it:
 *  the clamp itself, plus the marks re-admitted above it. */
const SANCTIONED_NODE_ANIMATIONS = new Set(['none', 'laneSweep', 'driftLightIn'])

test('no hole was punched in the graph node animation clamp', () => {
  const inNode = rules(treeGraph).filter(r => /\.static-tree-graph\s+\.node\b/.test(r.selector) && /animation:/.test(r.body))
  assert.ok(inNode.length > 0, 'the node animation clamp is gone from src/tree-graph.css')
  const running = new Set()
  for (const rule of inNode) {
    for (const declaration of rule.body.match(/animation:\s*[^;]+;/g) || []) {
      running.add(declaration.replace(/animation:\s*/, '').trim().split(/\s+/)[0])
    }
  }
  const unsanctioned = [...running].filter(name => !SANCTIONED_NODE_ANIMATIONS.has(name))
  assert.deepEqual(unsanctioned, [],
    `graph nodes now run ${unsanctioned.join(', ')}; the clamp admits only ${[...SANCTIONED_NODE_ANIMATIONS].join(', ')}`)
  assert.ok(!/chat-stream-flow/.test(treeGraph), 'the live mark reaches into the graph nodes')
})
