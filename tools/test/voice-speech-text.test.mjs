import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechText } from '../../src/voice-speech-text.js'

const normalize = value => value.replace(/\s+/g, ' ').trim()
const render = pieces => {
  const speech = createSpeechText()
  return normalize(pieces.map(piece => speech.write(piece)).join('') + speech.write('', true))
}

test('speech strips Markdown and decorative emoji but preserves meaningful words and numbers', () => {
  assert.equal(render(['**Hello** 😊']), 'Hello')
  assert.equal(render(['# Ready\n- **Do not** delete it.\n1. Open _Settings_.\n- [x] Keep 3.14 and -2.']),
    'Ready. Do not delete it. Open Settings. Keep 3.14 and -2.')
  assert.equal(render(['Use `app.context` and [Settings](https://example.test/settings).']), 'Use app.context and Settings.')
  assert.equal(render(['![A diagram](image.png)\n---\n> Check this.']), 'A diagram. Check this.')
  assert.equal(render(['2*3 = 6. **2** plus **3**.']), '2 times 3 = 6. 2 plus 3.')
  assert.equal(render(['A 👩🏽‍💻 B 🇺🇸 C 1️⃣ D ☺️ E']), 'A B C D E')
  assert.equal(render(['😊 ** **']), '')
})

test('all stream boundaries preserve complete link, emphasis, emoji and fence handling', () => {
  const fixtures = [
    '**Hello there.** 😊\nNext answer.',
    '# Ready\n1. **Open** [Settings](https://example.test/a(b)).\nDone.',
    'Use `app.context` to read.\n```js\nconst noisy = "*** 😀";\n```\nFinished.',
    '~~~python\nprint("hello")\n~~~\n**Done**.',
    'A 👩🏽‍💻 B 🇺🇸 C 1️⃣ D ☺️ E',
  ]
  for (const input of fixtures) {
    const expected = render([input])
    for (let split = 0; split <= input.length; split++) {
      assert.equal(render([input.slice(0, split), input.slice(split)]), expected, 'split ' + split)
    }
    assert.equal(render([...input]), expected)
  }
  assert.equal(render([fixtures[2]]), 'Use app.context to read. Code block is in the written reply. Finished.')
})

test('plain sentences start before turn completion; incomplete formatting stays buffered', () => {
  const speech = createSpeechText()
  assert.equal(speech.write('Hello there. '), 'Hello there. ')
  assert.equal(speech.write('**Second sentence. '), '')
  assert.equal(speech.write('Still bold**\n'), 'Second sentence. Still bold. ')
  assert.equal(speech.write('', true), '')
})

test('oversize formatting is bounded and recovers at the next line', () => {
  const speech = createSpeechText()
  let output = ''
  for (let count = 0; count < 100; count++) output += speech.write('['.repeat(1000))
  output += speech.write('\n**Recovered**.', true)
  assert.equal(normalize(output), 'Long section is in the written reply. Recovered.')
})

test('long plain clauses keep streaming instead of becoming omitted formatted sections', () => {
  const speech = createSpeechText()
  const clause = 'Plain words without punctuation '.repeat(10)
  assert.equal(speech.write(clause), clause)
  assert.equal(speech.write('and the final words', true), 'and the final words')
})
