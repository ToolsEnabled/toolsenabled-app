import { buildMainRuntime } from './tools/build-main-runtime.mjs'

export default {
  plugins: [{
    name: 'saved-tree-main-runtime',
    async generateBundle() {
      const { outputFiles } = await buildMainRuntime({ write: false })
      this.emitFile({ type: 'asset', fileName: 'main/fleet-trees.cjs', source: outputFiles[0].contents })
    },
  }],
}
