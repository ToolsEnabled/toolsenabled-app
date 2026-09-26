/* TWO PRESSES FOR ANYTHING THAT TAKES A ROW AWAY.
 *
 * The pattern is lifted from the experiment cards on the research page
 * (src/views/research.js, the `removeId` branch): the stage-tidy drive of
 * 2026-08-15 measured a remove control firing on a single press, and a list
 * control that removes on one press is a control that removes by accident --
 * the × sits at the row's edge where a pointer lands on the way to the scroll
 * bar. So the first press ARMS the control and says what the second will do,
 * and a lone press disarms itself after a moment so the label never lies about
 * what the next press does.
 *
 * The research page keeps its own inline copy of this (a test slices that
 * handler by its literal text); this module exists so the ledger's two × kinds
 * and the research queue's × share one mechanism instead of three hand-rolled
 * timers.
 *
 * `dataset.armed` is the state the stylesheet keys on ([data-armed="true"]);
 * `aria-pressed` tells a screen reader the control is in its armed state. The
 * timer is cleared on the second press so a disarm cannot land after the row
 * is already gone.
 */

/* EIGHT SECONDS, NOT FOUR. The research page's inline copy disarms after four,
   and that was enough for its own card -- the hint there is one short line.
   The ledger's hint is a full sentence ("Hide R3? Press × again. It is hidden
   on this screen only; nothing else changes."): a person reads it, decides,
   and moves the pointer back to the ×. Person-tested on the live site on
   2026-08-22, the second press landed after the four-second window and only
   re-armed the row, which reads as the control ignoring them. Eight seconds
   covers reading the sentence at a careful pace; a lone press still disarms
   itself well before anyone could forget the row was armed. */
const DEFAULT_MS = 8000

/**
 * @returns {boolean} false on the first press (now armed), true on the second
 *   (now disarmed, the caller may act).
 */
export function armOnce(button, { ms = DEFAULT_MS, onDisarm = null } = {}) {
  if (!button || typeof button !== 'object' || !button.dataset) return false
  if (button.dataset.armed === 'true') {
    disarm(button)
    return true
  }
  button.dataset.armed = 'true'
  if (typeof button.setAttribute === 'function') button.setAttribute('aria-pressed', 'true')
  const timer = setTimeout(() => {
    /* Only a control that is still on the page and still armed is disarmed:
       a re-render may have replaced it, and a second press may have already
       used the arm. */
    if (button.isConnected === false) return
    if (button.dataset.armed !== 'true') return
    disarm(button)
    if (typeof onDisarm === 'function') onDisarm(button)
  }, ms)
  button._armTimer = timer
  return false
}

function disarm(button) {
  delete button.dataset.armed
  if (typeof button.setAttribute === 'function') button.setAttribute('aria-pressed', 'false')
  if (button._armTimer) {
    clearTimeout(button._armTimer)
    delete button._armTimer
  }
}
