/* How long an agent has been running, said so it cannot be read as a clock time.
 *
 * THE DEFECT. The agent page rendered `19:29:53` under the word RUNTIME, and
 * `16:27:58` inside each bubble. Both are elapsed durations -- sim.js fmtRuntime()
 * and uptimeParts() both compute `now - epoch` -- but colon-separated `hh:mm:ss`
 * is the same shape a wall clock uses, and half past seven in the evening is a
 * perfectly reasonable reading of `19:29:53`. The word RUNTIME does not settle
 * it: a runtime can as easily be read as "the time on the machine it runs on".
 *
 * IT WAS WORSE THAN AMBIGUOUS ON THIS PAGE, and the reason is a stylesheet.
 * components.js uptimeRing() renders per-segment unit captions (Days / Hours /
 * Minutes / Seconds), which would have disambiguated it outright -- and
 * styles.css `.uring.compact .uring-digits .u { display: none }` hides them at
 * any ring under 240px. The agent page's ring is 180px, or 132px on a short
 * viewport. So this page took the one readout that carried its own units and
 * stripped them, on every window size it ships at.
 *
 * THE FIX IS THE UNIT, NOT A LABEL NEXT TO IT. `16h 27m 58s` cannot be a time of
 * day. That is the whole design rule here: put the unit in the value, so no
 * caption, tooltip or column header has to be read for the number to mean what it
 * means -- and so it survives being screenshotted, cropped, or read aloud.
 *
 * PURE, so `node --test` drives it directly. Anything that reaches the DOM on
 * this page reaches it through components.js, whose module graph starts the
 * demonstration simulator's timers on import and never lets a plain node process
 * exit -- so a suite importing the view could only assert on source text, which
 * passes just as well when the table is right and the caller is wrong.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * `16h 27m 58s`, `3d 4h 09m`, `58s`.
 *
 * LEADING UNITS ARE DROPPED, TRAILING ONES ARE NOT. A session 58 seconds old
 * reads `58s`, not `0h 00m 58s`: the leading zeros are noise that make a young
 * session look like an old one at a glance, which is the exact opposite of what
 * this page is for. Once a larger unit is in play the smaller ones are padded, so
 * the figures stay column-aligned in the roster (the digits are tabular in CSS)
 * and a number never appears to jump a place as it ticks.
 *
 * PAST A DAY THE SECONDS GO. `3d 4h 09m 12s` is four moving figures nobody reads;
 * at that age the second is not information. Seconds survive below a day, because
 * that is where the reader is actually watching something happen.
 */
export function durationLabel(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const total = Math.floor(elapsedMs)
  const d = Math.floor(total / DAY)
  const h = Math.floor((total % DAY) / HOUR)
  const m = Math.floor((total % HOUR) / MINUTE)
  const s = Math.floor((total % MINUTE) / SECOND)
  const pad = value => String(value).padStart(2, '0')
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`
  if (m > 0) return `${m}m ${pad(s)}s`
  return `${s}s`
}

/** The same duration spelled out, for a screen reader and for the title
 *  attribute. `16h` is unambiguous to the eye and is read aloud as the letter
 *  "h" by some screen readers, so the accessible name spends the extra words. */
export function durationSpoken(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const total = Math.floor(elapsedMs)
  const parts = []
  const push = (value, one, many) => { if (value > 0) parts.push(`${value} ${value === 1 ? one : many}`) }
  push(Math.floor(total / DAY), 'day', 'days')
  push(Math.floor((total % DAY) / HOUR), 'hour', 'hours')
  push(Math.floor((total % HOUR) / MINUTE), 'minute', 'minutes')
  if (total < DAY) push(Math.floor((total % MINUTE) / SECOND), 'second', 'seconds')
  return parts.length ? parts.join(' ') : '0 seconds'
}

/**
 * The whole phrase, tense included.
 *
 * `running for 16h 27m 58s` against `ran for 16h 27m 58s` is the difference
 * between a number that is still moving and one that stopped, and it is carried
 * by the verb rather than by a colour or a dot -- so it survives a greyscale
 * screenshot and a colour-blind reader. A running agent is the only one whose
 * figure updates, so a stopped one showing a frozen number is no longer
 * indistinguishable from a stalled clock.
 */
export function runtimePhrase({ elapsedMs, running } = {}) {
  const label = durationLabel(elapsedMs)
  if (label === null) return null
  return `${running ? 'running for' : 'ran for'} ${label}`
}

/** What the roster shows when there is no runtime to show. Never `0s`, and
 *  never an em dash on its own: an agent whose epoch this page was not given is
 *  a different fact from one that started a moment ago, and saying so costs
 *  three words. */
export const NO_RUNTIME = 'no runtime reported'
