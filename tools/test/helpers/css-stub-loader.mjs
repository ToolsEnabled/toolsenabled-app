/* A LOADER HOOK THAT MAKES `import '../foo.css'` LOADABLE UNDER NODE.
 *
 * WHY THIS EXISTS. Every module under src/views/ imports its stylesheet, and
 * node refuses with `Unknown file extension ".css"`. That single fact is why a
 * sweep of this repository found tests asserting the SOURCE TEXT of view
 * modules rather than calling them -- and four separate verifiers independently
 * concluded, wrongly, that the repo has no way to load these modules at all.
 * A test that pins an implementation's spelling fails against a BETTER
 * implementation and passes against a reinstated defect, so the cost of this
 * gap is paid every time somebody improves one of these files.
 *
 * WHAT IT DOES AND DOES NOT DO. It resolves a .css specifier to an empty ES
 * module. The bundler is what actually turns those imports into styles; nothing
 * in a unit test reads them, and stubbing them changes no behaviour under test.
 *
 * IMPORTABLE IS NOT THE SAME AS MOUNTED. These modules are view factories over
 * a live DOM, and most of what they export still needs a document stand-in --
 * eighteen files in this directory already show how. This hook removes one
 * obstacle; it does not remove that one.
 */

const CSS = /\.css(\?.*)?$/

export function resolve(specifier, context, nextResolve) {
  if (CSS.test(specifier)) {
    return { url: new URL('data:text/javascript,export default {}').href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
