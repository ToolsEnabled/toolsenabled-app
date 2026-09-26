import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// MAIN and the renderer must validate saved trees with the same parser. The
// installed application ships dist and shell, so bundle this native dependency
// from its canonical source rather than importing a development-only src path.
export async function buildMainRuntime({ root = fileURLToPath(new URL('../', import.meta.url)), outdir = path.join(root, 'dist', 'main'), write = true } = {}) {
  return build({
    stdin: { contents: "export { parseFleetTrees, fleetTreesStorageKey } from './src/fleet-trees.js'", resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true,
    legalComments: 'none', sourcemap: false, outfile: path.join(outdir, 'fleet-trees.cjs'), write,
  })
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await buildMainRuntime()
  console.log('MAIN runtime: bundled canonical saved-tree parser')
}
