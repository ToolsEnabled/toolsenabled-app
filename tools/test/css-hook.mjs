/* Register the CSS loader for a test run: `node --import ./tools/test/css-hook.mjs ...`
 *
 * Split from css-loader.mjs because a module-customisation hook runs on its own
 * thread and must be registered from the main one. See css-loader.mjs for why
 * this exists at all, and -- more importantly -- for what it does NOT buy you.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register(new URL('./css-loader.mjs', pathToFileURL(import.meta.filename)).href)
