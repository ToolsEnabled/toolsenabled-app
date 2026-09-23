import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import {
  ATTACHMENT_REMOVE_TEXT,
  attachmentFilenameText,
  attachmentRemoveLabel,
  attachmentSizeText,
} from '../../src/chat-copy.js'

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function mounted(picks) {
  const sent = []
  const root = buildChat({
    title: 'Picker test',
    onAttach: async () => picks.shift(),
    onSend: (text, context) => { sent.push({ text, context }) },
  })
  dom.document.body.appendChild(root)
  return { root, sent, attach: root.querySelector('[data-chat-attach]'), input: root.querySelector('.chat-input input') }
}

test('eligible picker results render canonical filename, honest size, and remove copy', async () => {
  const first = { ok: true, path: '/tmp/photo one.png', size: 1536 }
  const second = { ok: true, path: '/tmp/two.jpg', size: 9 }
  const { root, attach } = mounted([first, second])
  attach.click(); await tick(); attach.click(); await tick()
  const chips = root.querySelectorAll('.chat-attachment-chip')
  assert.equal(chips.length, 2, 'one chip instead of two would hide an eligible picked file')
  assert.equal(chips[0].querySelector('.chat-attachment-name').textContent, attachmentFilenameText(first.path), 'a full path would fail the canonical filename presentation')
  assert.equal(chips[0].querySelector('.chat-attachment-size').textContent, attachmentSizeText(first.size), '1536 B rather than the canonical human size would fail')
  const remove = chips[0].querySelector('.chat-attachment-remove')
  assert.equal(remove.textContent, ATTACHMENT_REMOVE_TEXT, 'an invented cross glyph would fail the canonical remove text')
  assert.equal(remove.getAttribute('aria-label'), attachmentRemoveLabel(attachmentFilenameText(first.path)), 'an unlabeled filename-specific control would fail')
})

test('refusals attach nothing and odd stats never fabricate zero', async () => {
  const { root, attach } = mounted([
    { ok: false, path: '/tmp/refused.png', size: 20 },
    { path: '/tmp/no-verdict.png', size: 20 },
    { ok: true, path: '/tmp/failed.png' },
    { ok: true, path: '/tmp/directory.png', size: -1 },
    { ok: true, path: '/tmp/fraction.png', size: 1.5 },
  ])
  attach.click(); await tick(); attach.click(); await tick()
  assert.equal(root.querySelectorAll('.chat-attachment-chip').length, 0, 'a path without ok === true would create a dishonest chip')
  for (let index = 0; index < 3; index += 1) { attach.click(); await tick() }
  const chips = root.querySelectorAll('.chat-attachment-chip')
  assert.equal(chips.length, 3, 'failed metadata must not discard otherwise eligible picks')
  assert.ok(chips.every(chip => chip.querySelector('.chat-attachment-size') === null), 'a fabricated 0 B size would fail honest absence')
})

test('normalized replacement, removal, and send clearing govern the actual send set', async () => {
  const { root, attach, input, sent } = mounted([
    { ok: true, path: 'C:\\Pictures\\ONE.PNG', size: 10 },
    { ok: true, path: 'c:/pictures/one.png', size: 20 },
    { ok: true, path: '/tmp/remove.png', size: 30 },
  ])
  attach.click(); await tick(); attach.click(); await tick()
  let chips = root.querySelectorAll('.chat-attachment-chip')
  assert.equal(chips.length, 1, 'Windows case and separator variants duplicated instead of replacing')
  assert.equal(chips[0].querySelector('.chat-attachment-size').textContent, attachmentSizeText(20), 'replacement retained stale metadata from the first pick')
  attach.click(); await tick()
  chips = root.querySelectorAll('.chat-attachment-chip')
  chips[1].querySelector('.chat-attachment-remove').click()
  input.value = 'first'; root.querySelector('.chat-send').click(); await tick()
  assert.deepEqual(sent[0].context.attachments.map(item => item.path), ['c:/pictures/one.png'], 'removed.png survived in the actual first send set')
  input.value = 'second'; root.querySelector('.chat-send').click(); await tick()
  assert.equal(Object.hasOwn(sent[1].context, 'attachments'), false, 'the second send silently inherited the first attachment set')
})

test.after(() => dom.restore())


for (const via of ['send', 'send-now']) {
  test('image-only ' + via + ' keeps empty text and picker order', async () => {
    const sent = [], picks = [
      { ok: true, path: 'ordered-one.png', size: 68 },
      { ok: true, path: 'ordered-two.png', size: 68 },
    ]
    const root = buildChat({ seed: 0, chips: {}, onAttach: async () => picks.shift(),
      onSend: (text, details) => sent.push({ text, images: details.attachments }),
    })
    try {
      const attach = root.querySelector('[data-chat-attach]')
      attach.click(); await tick(); attach.click(); await tick()
      const button = root.querySelector(via === 'send' ? '.chat-send' : '.chat-chip-sendnow')
      assert.equal(button.disabled, false)
      button.click(); await tick()
      assert.equal(sent.length, 1)
      assert.equal(sent[0].text, '')
      assert.deepEqual(sent[0].images.map(image => image.path), ['ordered-one.png', 'ordered-two.png'])
    } finally { root.dispose() }
  })
}
test('busy image-only is retained with refusal, while genuinely empty Send still stops', async () => {
  let stops = 0, sends = 0, queued = 0
  const root = buildChat({ seed: 0, onSend: () => { sends++ }, onStop: async () => { stops++ },
    status: { busy: () => true }, queue: { list: () => [], subscribe: () => () => {}, add: () => { queued++ } },
  })
  try {
    root.importDraft({ text: '', attachments: [{ path: 'own-image.png' }] })
    root.querySelector('.chat-send').click(); await tick()
    assert.equal(stops, 0); assert.equal(sends, 0); assert.equal(queued, 0)
    assert.equal(root.exportDraft().attachments.length, 1)
    root.importDraft({ text: '', attachments: [] })
    root.querySelector('.chat-send').click(); await tick()
    assert.equal(stops, 1)
  } finally { root.dispose() }
})
test('image send refusal restores exact draft and images without claiming acceptance', async () => {
  let callbacks, sent
  const root = buildChat({ seed: 0, onSend: (text, details) => { sent = text; callbacks = details } })
  const draft = { text: '  indented\ntext  ', attachments: [{ path: 'first.png' }, { path: 'second.png' }] }
  try {
    root.importDraft(draft); root.querySelector('.chat-send').click(); await tick()
    assert.equal(sent, draft.text)
    callbacks.fail('Attachment authority refused', { retract: true, restoreDraft: true, unconfirmed: false })
    assert.equal(root.exportDraft().text, draft.text)
    assert.deepEqual(root.exportDraft().attachments, draft.attachments)
  } finally { root.dispose() }
})

// T1482: two pasted screenshots showed as '0566bb63-afe7-...png' and
// 'b5a39972-4c4b-...png', the host's random file names, so they could not be
// told apart and Remove named a random id.
test('pasted pictures read Pasted image 1 and 2, and Remove names that label', async () => {
  const dir = '/home/redacted-profile/.config/ToolsEnabled/paste-attachments/'
  const first = { ok: true, path: dir + '0566bb63-afe7-4abc-87f4-72476ba09189.png', size: 1843 }
  const second = { ok: true, path: 'C:\\Users\\redacted-profile\\AppData\\Roaming\\ToolsEnabled\\paste-attachments\\b5a39972-4c4b-4c52-a263-89664f6c723c.png', size: 1946 }
  const picked = { ok: true, path: '/tmp/0566bb63-afe7-4abc-87f4-72476ba09189.png', size: 10 }
  const { root, attach } = mounted([first, second, picked])
  attach.click(); await tick()
  let chips = root.querySelectorAll('.chat-attachment-chip')
  assert.equal(chips[0].querySelector('.chat-attachment-name').textContent, 'Pasted image', 'one pasted picture needs no number')
  attach.click(); await tick(); attach.click(); await tick()
  chips = root.querySelectorAll('.chat-attachment-chip')
  assert.deepEqual(chips.map(chip => chip.querySelector('.chat-attachment-name').textContent),
    ['Pasted image 1', 'Pasted image 2', attachmentFilenameText(picked.path)], 'a picked file keeps its own name, even one that looks random')
  assert.deepEqual(chips.slice(0, 2).map(chip => chip.querySelector('.chat-attachment-remove').getAttribute('aria-label')),
    [attachmentRemoveLabel('Pasted image 1'), attachmentRemoveLabel('Pasted image 2')])
  for (const chip of chips.slice(0, 2)) assert.doesNotMatch(chip.textContent, /[0-9a-f]{8}-[0-9a-f]{4}/, 'no random id in a pasted chip')
  chips[0].querySelector('.chat-attachment-remove').click()
  assert.equal(root.querySelectorAll('.chat-attachment-chip')[0].querySelector('.chat-attachment-name').textContent, 'Pasted image',
    'the one left is simply the pasted image')
})
