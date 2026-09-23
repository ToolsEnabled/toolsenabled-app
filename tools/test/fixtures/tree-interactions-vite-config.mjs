import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { normalizePath, transformWithEsbuild } from 'vite'

export function treeInteractionViteConfig({ root, out, retainBrowser = false }) {
  const config = {
    root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
    // Retain fixture state without starting Vite's deleting dependency optimizer.
    optimizeDeps: retainBrowser ? { noDiscovery: true, include: [] } : undefined,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null,
      fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } },
  }
  if (retainBrowser) {
    const require = createRequire(path.join(root, 'package.json'))
    const core = normalizePath(realpathSync(require.resolve('highlight.js/lib/core')))
    config.plugins = [{
      name: 'tree-interactions-highlight-core',
      apply: 'serve',
      enforce: 'pre',
      transform(code, id) {
        if (normalizePath(id.split('?')[0]) !== core) return null
        // The installed ESM entry imports this CommonJS core. Convert that same
        // module in memory; keep package resolution and optimizer settings intact.
        return transformWithEsbuild(code, id, { loader: 'js', format: 'esm' })
      },
    }]
  }
  return config
}
