/* CAN THIS COPY ACTUALLY SHOW A NOTIFICATION, AND WHAT DO WE SAY WHEN IT CANNOT.
 *
 * The two notification rows on the settings page are switches over something
 * OUTSIDE this window: the operating system's own notification service, asked
 * through the installed application. Two states exist in which turning one on
 * would change nothing at all -- this page running in a browser, where there is
 * no installed application to raise anything, and a computer whose Electron
 * answers `Notification.isSupported()` false.
 *
 * A SWITCH THAT CANNOT SUCCEED IS DISABLED WITH THE REASON BESIDE IT. Not
 * hidden -- the section is not absent, only what these switches can do on this
 * computer this minute, and a person hunting for the notification setting has
 * to find it and be told, rather than conclude the product has none. Not left
 * live either: a switch that moves, saves, and never produces a notification is
 * the drawn-control defect this page has already shipped once.
 *
 * IT IS A MODULE RATHER THAN A BRANCH IN THE VIEW so the sentences sit in the
 * one place the plain-language gate scans and a test can drive each of its states
 * without a window. Nothing here decides anything: it reports what the bridge
 * said. The bridge is `mc-notify:delivery` in shell/main.cjs, answered from the
 * same seam that does the notifying (shell/agent-notifications.cjs), so the
 * page and the notifier cannot hold different opinions about what is possible.
 *
 * WHAT THESE TWO STATES DO NOT COVER, WRITTEN DOWN SO NOBODY READS MORE INTO
 * THEM THAN IS THERE.
 *
 * `Notification.isSupported()` is a question about whether this build can raise
 * a notification AT ALL. It is effectively always yes on Windows and on macOS;
 * it is meaningfully no only on a Linux machine with nothing running to draw
 * one. So on the platform this product ships to, the second sentence below is a
 * path a person will almost never reach, and the switches will almost always be
 * live.
 *
 * THE FAILURES A WINDOWS USER ACTUALLY HITS ARE INVISIBLE FROM HERE. Focus
 * Assist or Do Not Disturb, notifications switched off for this program in the
 * system settings, an application id that does not match the installed
 * shortcut: in every one of those the program is told the notification was
 * shown and nobody sees anything. Electron exposes no way to ask about any of
 * them, so this page cannot say so and does not pretend to. It is also why
 * shell/main.cjs sets the application id explicitly -- that is the one of the
 * three this side can do something about.
 */

/* Read at call time, never captured: the settings page is drawn on every visit
   and the answer belongs to the visit, not to the module's first evaluation. */
function bridgeOf(bridge) {
  if (bridge !== undefined) return bridge
  return typeof window === 'undefined' ? null : window.mcNotify
}

export const NO_INSTALLED_APPLICATION = 'Notifications come from the installed application, and this page is not running inside it. Install ToolsEnabled to turn these on.'

export const COMPUTER_SHOWS_NONE = 'This computer does not show notifications from a program, so these switches would change nothing. Turn notifications on for this computer, then open this page again.'

/**
 * What this copy can do about notifications right now.
 *
 * @param bridge  the exposed `window.mcNotify`, or null. Passed in by the test
 *                suite; omitted everywhere else so there is one reader of the
 *                global rather than one per call site.
 * @returns {{ supported: boolean, why: string|null }}  `why` is the sentence to
 *          put beside the disabled switch, and it is null exactly when the
 *          switches work. A caller that renders `why` without checking
 *          `supported` prints nothing, which is the safe way round.
 */
export function notificationDelivery(bridge) {
  const found = bridgeOf(bridge)
  if (!found || typeof found !== 'object') {
    return Object.freeze({ supported: false, why: NO_INSTALLED_APPLICATION })
  }
  /* THE BRIDGE'S ANSWER IS BELIEVED ONLY WHEN IT IS THE WORD TRUE. A bridge
     that is present but could not reach the main process reports something
     else -- undefined, null, a refusal record -- and every one of those means
     "we could not establish that this works", which is not the same as "it
     works" and must never be rendered as an enabled switch. */
  if (found.supported !== true) {
    return Object.freeze({ supported: false, why: COMPUTER_SHOWS_NONE })
  }
  return Object.freeze({ supported: true, why: null })
}
