function wireSingleInstance({
  requestLock,
  quit,
  whenReady,
  onSecondInstance,
  handleSecondInstance,
  onSecondInstanceFailure,
  getWindow,
  start,
  onStartFailure,
}) {
  const gotLock = requestLock()
  if (!gotLock) {
    quit()
    return false
  }

  void whenReady().then(start).catch(onStartFailure)
  onSecondInstance((...args) => {
    /* A bounded command handoff is not a request to steal focus. The handler
       runs even while the primary window is still being built; returning
       `{ focus: false }` means the second process did its one job and exits
       without moving or restoring the person's window. Ordinary launches keep
       the original restore-and-focus behavior below. */
    let handled = null
    try {
      handled = typeof handleSecondInstance === 'function'
        ? handleSecondInstance(...args)
        : null
    } catch (error) {
      /* THE FIRST INSTANCE MUST OUTLIVE A SECOND LAUNCH IT COULD NOT
         INTERPRET. onSecondInstance wires this straight to a plain
         EventEmitter listener (in production, app.on('second-instance', ...)
         -- see shell/main.cjs), with no caller-side try/catch of its own
         waiting for it. A synchronous throw here does not fail the second
         launch; it becomes an uncaught exception in the ALREADY-RUNNING
         primary instance, which is the one process a command handoff must
         never be able to reach, let alone crash. start/whenReady have
         onStartFailure as their own safety net for exactly this shape of
         failure; handleSecondInstance had none. Reported through
         onSecondInstanceFailure when the caller supplies one, so it can route
         through its own error channel (shell/main.cjs's [tree-node-command]
         console lines, for instance) -- console.error otherwise, the same
         fallback this file's sibling gates already fall back to when nothing
         else is listening. Either way, treated like a handled,
         focus-suppressing command afterward: an interpretation that failed is
         not evidence a restore was wanted. */
      if (typeof onSecondInstanceFailure === 'function') onSecondInstanceFailure(error)
      else console.error('[single-instance] second-instance handler threw:', error)
      return
    }
    if (handled && handled.focus === false) return
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  return true
}

module.exports = { wireSingleInstance }
