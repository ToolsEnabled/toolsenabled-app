// Presentation helpers only. The Ledger host owns grading policy and review counts.
export const TASK_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard'])

const names = Object.freeze({ easy: 'Easy', medium: 'Medium', hard: 'Hard' })
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]))

export function taskDifficultyLabel(value) {
  return TASK_DIFFICULTIES.includes(value) ? names[value] : 'Not graded'
}

/* The whole phrase a screen reader hears for a task's count of reviews that
   did not pass (the rail shows it tersely as "N fails"). No phrase for a
   count the Ledger did not report. */
export function taskFailedReviewsLabel(value) {
  if (!Number.isSafeInteger(value) || value < 0) return ''
  return `Did not pass review ${value} time${value === 1 ? '' : 's'}`
}

export function taskDifficultyFieldMarkup({ enabled = false, value = '', escape = escapeText } = {}) {
  if (enabled !== true) return ''
  const selected = TASK_DIFFICULTIES.includes(value) ? value : ''
  return `<label data-task-difficulty-row>Difficulty
    <select name="difficulty" data-task-difficulty required aria-describedby="task-difficulty-hint">
      <option value=""${selected ? '' : ' selected'}>Choose difficulty</option>
      ${TASK_DIFFICULTIES.map(grade => `<option value="${grade}"${grade === selected ? ' selected' : ''}>${escape(names[grade])}</option>`).join('')}
    </select>
    <span id="task-difficulty-hint">Choose Easy, Medium or Hard for this new task.</span>
  </label>`
}

/* A task row's grade and failed reviews ride the register's two quiet rails
   (the agent and age rails an R row uses for "gates N" / "unmet N"), in the
   same terse style, short enough for the 62px age rail ("2 fails"). A task
   filed before grading has no grade and says nothing; a count shows only once
   a review has failed. Screen readers hear the whole phrase. The row draws
   these BEFORE its reach chip: the meta grid places items in source order, so
   a rail-2 item after the rail-4 chip would drop to a second grid row. */
export function taskDifficultyMetadataMarkup({ difficulty, failedReviewCount, escape = escapeText } = {}) {
  const graded = TASK_DIFFICULTIES.includes(difficulty)
  const failed = Number.isSafeInteger(failedReviewCount) && failedReviewCount > 0
  return (graded
    ? `<span class="ledger-agent" data-task-difficulty-value title="${escape(`Difficulty: ${names[difficulty]}`)}"><span class="ledger-sr-only">Difficulty: </span>${escape(difficulty)}</span>`
    : '')
    + (failed
      ? `<span class="ledger-age" data-task-failed-reviews title="${escape(taskFailedReviewsLabel(failedReviewCount))}"><span aria-hidden="true">${escape(failedReviewCount)} fail${failedReviewCount === 1 ? '' : 's'}</span><span class="ledger-sr-only">${escape(taskFailedReviewsLabel(failedReviewCount))}</span></span>`
      : '')
}
