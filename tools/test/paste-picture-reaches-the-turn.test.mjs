/* A PICTURE PASTED IN A REAL WINDOW REACHES THE MESSAGE THE PROVIDER IS SENT.
 *
 * T18, the owner: "images paste into chat but DONT get sent to the agent and
 * cause an error." Six suites already covered pasting and all six were green
 * while the feature was broken, because every one of them stops at the app
 * boundary. This one does not: it drives the real Computers view in a real
 * hidden Electron window with its own user-data-dir, dispatches a real
 * ClipboardEvent carrying a real File, presses a real Enter, and then takes
 * the path the app actually sent and feeds it to the REAL provider adapter to
 * see what gets written to the provider.
 *
 * TWO SURFACES, because the owner uses both: the full tree conversation and
 * the right-rail chat.
 *
 * THE FIXTURE BYTES ARE GENERATED ONCE and shared by both halves, so "the
 * picture that arrived is the picture that was pasted" is a comparison and not
 * a coincidence.
 *
 * RED/GREEN: the adapter half is RED at engine 16462165 (the blanket
 * CLAUDE_CLI_IMAGES_UNSUPPORTED refusal) and GREEN with the delivery fix. Point
 * MC_T18_ENGINE_ROOT at either tree to see it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { pastePictureInRealWindow } from './helpers/paste-picture-native.mjs'

const require = createRequire(import.meta.url)

/* THE ENGINE ROOT IS RESOLVED INSIDE THE TEST, NOT AT IMPORT, and the reason is
   what happens to the RUN when it is not set rather than anything about this
   suite. Both of the lines below used to sit at module scope: the assertion,
   and a require() built from its result, which throws on its own when the
   variable is absent. Either one throwing before node:test registers a test
   makes the runner report the FILE as a result, numbered in the file counter
   and spliced into the middle of the top-level test counter.
   Measured 2026-09-17 on a full `npm test`: that emitted
   `not ok 703 - tools\test\paste-picture-reaches-the-turn.test.mjs` where 7365
   was expected, and test-ratchet.mjs then refused a verdict for the WHOLE
   suite -- "TAP result ordinal is missing, duplicated, or out of order",
   exit 2, baseline untouched. 13,965 passing tests reported nothing, because
   one file could not read one variable.
   Resolved here instead, an unset engine root is an ordinary named failure of
   this one case and every other result still counts. The sentence is
   unchanged. */
function engineUnderTest() {
  const engineRoot = process.env.MC_T18_ENGINE_ROOT || process.env.MC_CANONICAL_ROOT
  assert.ok(engineRoot, 'MC_T18_ENGINE_ROOT (or MC_CANONICAL_ROOT) must name the engine checkout under test')
  return require(engineRoot + '/src/lib/agent-engine/claude-cli-adapter')
}

test('a real paste in the full conversation and in the rail puts the pasted picture in the provider message', async t => {
  const { ClaudeCliAdapter } = engineUnderTest()
  const { png, observations, evidence } = await pastePictureInRealWindow()
  t.diagnostic('evidence: ' + evidence)

  assert.equal(observations.failure, undefined, 'the window run failed: ' + JSON.stringify(observations.failure))
  assert.deepEqual(observations.pageErrors, [], 'the real window logged renderer errors')
  assert.equal(observations.surfaces.length, 2, 'both surfaces must be exercised')

  const expectedBase64 = png.toString('base64')

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'

    /* 1. the gesture landed */
    assert.equal(surface.pasted.pastedCalls, 1, `the paste never reached the attachment seam in ${where}`)
    assert.equal(surface.pasted.defaultPrevented, true,
      `the composer must claim an image paste in ${where}, or the browser also drops the bytes into the box`)

    /* 2. the bytes that arrived are the bytes that were pasted */
    const saved = surface.result.pasted[0]
    assert.ok(saved, `nothing was saved from the paste in ${where}`)
    assert.equal(saved.mime, 'image/png')
    assert.equal(saved.data, expectedBase64,
      `the base64 handed across the seam in ${where} is not the fixture that was pasted`)

    /* 3. THE DEFECT: the send must carry the picture, not only the words */
    assert.equal(surface.result.sent.length, 1, `exactly one turn must be sent from ${where}`)
    const turn = surface.result.sent[0]
    assert.equal(turn.text, 'what is in this picture?', `the person's words must survive the send from ${where}`)
    assert.deepEqual(turn.images, [{ path: saved.path }],
      `the pasted picture did not ride the turn sent from ${where}`)

    /* 4. AND THE PROVIDER ACTUALLY RECEIVES IT. This is the layer the six
       green paste suites never reached, and the layer that refused. */
    const written = []
    const adapter = new ClaudeCliAdapter({
      transport: { send: message => written.push(message), onData() {}, close() {}, kill() {} },
      /* The file the app saved does not exist on this disk -- the window's main
         process was a stand-in -- so the loader hands the adapter the same
         fixture bytes under that same path. Everything after this point is the
         real adapter deciding what to write. */
      imageLoader: imagePath => {
        assert.equal(imagePath, saved.path, 'the adapter must read exactly the path the app sent')
        return { bytes: png, mimeType: 'image/png' }
      },
    })
    adapter.threadId = '7cf7c88e-6912-4388-a181-78aef262c494'
    const turnPromise = adapter.sendTurn({ threadId: '7cf7c88e-6912-4388-a181-78aef262c494', text: turn.text, images: turn.images })
    turnPromise.catch(() => { /* the turn never completes here; the written message is what is under test */ })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(written.length, 1, `the provider was sent nothing for the turn from ${where}`)
    const content = written[0].message.content
    assert.equal(content.filter(block => block.type === 'text').length, 1)
    const images = content.filter(block => block.type === 'image')
    assert.equal(images.length, 1, `the provider message from ${where} carries no picture`)
    assert.equal(images[0].source.media_type, 'image/png')
    assert.equal(images[0].source.data, expectedBase64,
      `the provider was sent something other than the picture the person pasted from ${where}`)
  }
})
