import test from 'node:test'
import assert from 'node:assert/strict'
import { taskDifficultyFieldMarkup, taskDifficultyMetadataMarkup,
  taskDifficultyLabel, taskFailedReviewsLabel } from '../../src/task-difficulty.js'
import { createDocument } from './lib/dom-stand-in.mjs'

const selectedOption = body => [...body.querySelectorAll('option')].find(option => option.hasAttribute('selected')) || null

function render(markup) {
  const document = createDocument()
  const body = document.createElement('div')
  document.body.appendChild(body)
  body.innerHTML = markup
  return body
}

test('grading off or unknown does not require a new-task choice', () => {
  for (const enabled of [false, null, undefined, 'true']) {
    assert.equal(taskDifficultyFieldMarkup({ enabled, value: 'hard' }), '')
  }
})

test('grading on requires a deliberate choice and offers the three grades', () => {
  const body = render(taskDifficultyFieldMarkup({ enabled: true }))
  const select = body.querySelector('[data-task-difficulty]')
  assert.ok(select)
  assert.equal(select.hasAttribute('required'), true)
  const options = [...select.querySelectorAll('option')]
  assert.deepEqual(options.map(option => option.value), ['', 'easy', 'medium', 'hard'])
  assert.equal(options.find(option => option.hasAttribute('selected')).value, '')
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const saved = render(taskDifficultyFieldMarkup({ enabled: true, value: difficulty }))
    assert.equal(selectedOption(saved).value, difficulty)
  }
})

test('invalid difficulty never becomes an implicit choice or injected markup', () => {
  for (const value of ['HARD', 'unexpected', '<script>bad</script>', null]) {
    const body = render(taskDifficultyFieldMarkup({ enabled: true, value }))
    assert.equal(selectedOption(body).value, '')
    assert.equal(body.querySelector('script'), null)
    assert.equal(taskDifficultyLabel(value), 'Not graded')
  }
})

test('grade and review metadata distinguish confirmed counts from unavailable values', () => {
  assert.equal(taskDifficultyLabel('medium'), 'Medium')
  assert.equal(taskFailedReviewsLabel(0), 'Did not pass review 0 times')
  assert.equal(taskFailedReviewsLabel(1), 'Did not pass review 1 time')
  assert.equal(taskFailedReviewsLabel(2), 'Did not pass review 2 times')
  for (const count of [undefined, null, -1, 1.5, '2']) {
    assert.equal(taskFailedReviewsLabel(count), '', 'no phrase for a count the Ledger did not report')
  }
  const body = render(taskDifficultyMetadataMarkup({ difficulty: 'hard', failedReviewCount: 2 }))
  assert.match(body.querySelector('[data-task-difficulty-value]').textContent, /^Difficulty:\s*hard$/)
  assert.equal(body.querySelector('[data-task-difficulty-value] .ledger-sr-only').textContent.trim(), 'Difficulty:')
  assert.equal(body.querySelector('[data-task-failed-reviews] [aria-hidden]').textContent, '2 fails',
    'the rail shows "2 fails"')
  assert.equal(body.querySelector('[data-task-failed-reviews] .ledger-sr-only').textContent, 'Did not pass review 2 times',
    'and a screen reader hears the whole phrase')
})

test('an ungraded task and a task with no failed review add nothing to the row', () => {
  assert.equal(taskDifficultyMetadataMarkup({}), '')
  assert.equal(taskDifficultyMetadataMarkup({ difficulty: 'Hard', failedReviewCount: -1 }), '')
  assert.equal(taskDifficultyMetadataMarkup({ difficulty: '<b>x</b>', failedReviewCount: '2' }), '')
  const graded = render(taskDifficultyMetadataMarkup({ difficulty: 'easy', failedReviewCount: 0 }))
  assert.match(graded.querySelector('[data-task-difficulty-value]').textContent, /^Difficulty:\s*easy$/)
  assert.equal(graded.querySelector('[data-task-failed-reviews]'), null)
  const legacyFailed = render(taskDifficultyMetadataMarkup({ failedReviewCount: 1 }))
  assert.equal(legacyFailed.querySelector('[data-task-difficulty-value]'), null)
  assert.equal(legacyFailed.querySelector('[data-task-failed-reviews] .ledger-sr-only').textContent, 'Did not pass review 1 time')
})
