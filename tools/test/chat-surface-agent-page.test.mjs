// PER-SURFACE CHAT PIN: agent page, direct line.
//
// This pin is intentionally local to the mount point. buildChat's component
// tests cannot detect a caller that copies yesterday's option list, which is
// how the tree card missed an entire generation of composer controls. Once
// this surface has a named config handoff, every option must cross it via a
// spread and the config must choose exactly one honest conversation mode.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const agent = readFileSync(join(SRC, 'views', 'agent.js'), 'utf8')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')

const stripNotes = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

function directLineMount(source) {
  const start = source.indexOf('// chat panel')
  assert.notEqual(start, -1, 'the agent direct-line mount moved; re-anchor this per-surface pin')
  const end = source.indexOf('const chatProvenance', start)
  assert.ok(end > start, 'the direct-line mount no longer ends at its provenance wiring')
  return stripNotes(source.slice(start, end))
}

function assertWholeConfigMount(source) {
  const mount = directLineMount(source)
  assert.match(mount, /const\s+\w*[Cc]hat[Cc]onfig\s*=\s*\{[\s\S]*?\}/,
    'the direct line has no named config to pass as one contract')
  assert.match(mount, /buildChat\(\{\s*\.\.\.\w*[Cc]hat[Cc]onfig\s*\}\)/,
    'the direct line hand-picks buildChat fields instead of spreading its config whole')

  const config = mount.match(/const\s+\w*[Cc]hat[Cc]onfig\s*=\s*\{([\s\S]*?)\}\s*(?:\n|;)/)?.[1] ?? ''
  const modes = [
    /\bonSend\s*:/.test(config),
    /\bsampleConversation\s*:\s*true\b/.test(config),
    /\bcomposerReason\s*:/.test(config),
  ]
  assert.equal(modes.filter(Boolean).length, 1,
    'the direct-line config must carry exactly one of onSend, sampleConversation:true, or composerReason')
}

const panelized = /const\s+\w*[Cc]hat[Cc]onfig\s*=/.test(directLineMount(agent))

test('SKIP until agent direct-line panelization lands: mounts data-chat-panel and spreads one-mode config whole',
  { skip: !panelized && 'the direct-line buildChat call is still an inline, two-mode object' }, () => {
    assert.match(components, /data-chat-panel\b/,
      'buildChat lost the identity used to count and drift-check chat panels')
    assertWholeConfigMount(agent)
    const afterMount = stripNotes(agent.slice(agent.indexOf('// chat panel'), agent.indexOf('// dispose', agent.indexOf('// chat panel'))))
    assert.match(afterMount, /querySelector\(['"]\.chat-panel['"]\)[\s\S]*?appendChild\(chat\)/,
      'the agent page no longer mounts the identity-marked buildChat panel in its direct-line host')
  })

test('the agent-page pin rejects a hand-picked scratch field list', () => {
  const compliantScratch = `
    // chat panel
    const directLineChatConfig = { title, subtitle, roleKey, seed, tall, onSend: send }
    const chat = buildChat({ ...directLineChatConfig })
    const chatProvenance = chat.querySelector('.s')
  `
  assert.doesNotThrow(() => assertWholeConfigMount(compliantScratch),
    'the control scratch must represent the whole-config handoff')

  const handPickedScratch = compliantScratch.replace('...directLineChatConfig',
    'title: directLineChatConfig.title, subtitle: directLineChatConfig.subtitle, roleKey: directLineChatConfig.roleKey, seed: directLineChatConfig.seed, tall: directLineChatConfig.tall, onSend: directLineChatConfig.onSend')
  assert.throws(() => assertWholeConfigMount(handPickedScratch), /spreading its config whole/,
    'a six-field scratch mutation survived; this pin would repeat the tree-card starvation defect')
})
