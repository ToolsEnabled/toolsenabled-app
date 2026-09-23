/* LET A TEST IMPORT A RENDERER MODULE THAT IMPORTS A STYLESHEET.
 *
 * WHY THIS EXISTS. A 2026-08-24 sweep of the test suite found a whole class of
 * assertion that checks how the product is WRITTEN rather than what it DOES --
 * byte-exact `String.includes` of a markup line, a pinned regex that is one
 * valid spelling of a rule, a required `typeof x.verb === 'function'` chain. Each
 * one fails against a BETTER implementation, and the quickest way back to green
 * is to put the defect back. Three real instances landed in a single evening:
 * a test requiring the object-only optional chain it was named after guarding
 * against, a test requiring the one unescaped attribute in src/, and a test
 * pinning a marker list that had been correctly narrowed.
 *
 * Four independent verifiers all explained those assertions the same way: the
 * module cannot be loaded under node, so a source-text check is forced. THAT
 * PREMISE IS FALSE, and this file is the four lines that disprove it. Eighteen
 * test files already install a document/window stand-in, and `src/components.js`
 * and `src/agent-session.js` import under bare node today. The views/ modules
 * fail for exactly one shared reason:
 *
 *     Unknown file extension ".css" for .../src/guide.css
 *
 * A renderer module imports its stylesheet for the bundler's benefit. Node has
 * no opinion about CSS, so the import throws before a single line of the module
 * runs. Resolving it to an empty module is enough: nothing in a test asserts on
 * stylesheet TEXT -- the CSS is measured by the harnesses that drive a real
 * window, which is where it belongs.
 *
 * WHAT THIS DOES NOT DO, said plainly because a half-understood tool is worse
 * than none. Making a module IMPORTABLE is necessary, not sufficient. These are
 * view factories over a live DOM, and the helpers those tests actually want to
 * pin -- sessionBridgeControl, onPopKeys, switchComputer, treeHasStarted,
 * applyValue, runPaletteAction -- are closure-private. Importing the module does
 * not reach them. To assert behaviour you must still either mount the surface
 * against a document stand-in (eighteen files show how) or lift the helper to a
 * sibling module and call it with values. `src/machine-tabs.js` is the worked
 * example of the second route.
 *
 * So: this removes the excuse, not the work.
 */
export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default ""' }
  }
  return next(url, context)
}
