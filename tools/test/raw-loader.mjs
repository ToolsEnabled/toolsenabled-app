/* LET A TEST IMPORT A MODULE THAT USES A BUNDLER `?raw` IMPORT.
 *
 * src/research-benchmark-sources.js is the Research page's copy of the portable
 * runtime inventory: one `import x from './benchmark/<file>?raw'` per file. Vite
 * turns each into the file's text. Node would load the .mjs as a module instead,
 * so without this a test can only read that file as TEXT -- the source-spelling
 * assertion css-loader.mjs explains why this suite avoids. Resolving `?raw` to
 * the file's exact bytes as a string makes the real map importable, so a test can
 * call the page's own runtime binding with it.
 */
import { readFile } from 'node:fs/promises'

export async function load(url, context, next) {
  const marker = url.indexOf('?raw')
  if (marker !== -1) {
    const text = await readFile(new URL(url.slice(0, marker)), 'utf8')
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(text) }
  }
  return next(url, context)
}
