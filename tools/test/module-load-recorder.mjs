/* RECORD WHICH MODULES NODE ACTUALLY LOADS.
 *
 * A test that wants to know "does importing X pull in Y" has two bad options
 * and one good one. Reading X's source for an `import` line pins a spelling and
 * says nothing about what is reached two hops away. Checking a flag the lazy
 * seam sets only proves the seam was not used, not that the module stayed out
 * of the graph. This hook answers the real question: it is told about every
 * module the loader instantiates, in order, and posts the URL back.
 *
 * Register it with a port to hear about them:
 *
 *   const { port1, port2 } = new MessageChannel()
 *   register('./module-load-recorder.mjs', import.meta.url,
 *     { data: { port: port2 }, transferList: [port2] })
 *
 * It also resolves .css to an empty module, the same way css-loader.mjs does,
 * because the renderer modules worth asking this question about import their
 * stylesheet and node has no opinion about CSS. Registering both would work;
 * doing it here keeps a test to one hook.
 */
let port = null

export async function initialize(data) { port = data?.port ?? null }

export async function load(url, context, next) {
  port?.postMessage(url)
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default ""' }
  return next(url, context)
}
