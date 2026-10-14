'use strict'

const path = require('node:path')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

/* Load from the same paired engine as the session host. Model metadata is
 * advisory; the engine owns identifier and selected-effort validation. */
function loadNativeModelSelection(engineRoot = resolveCapabilityRoot()) {
  let selection
  try {
    selection = require(path.join(engineRoot, 'src/lib/model-dispatch-tiers.js'))
    if (['validateNativeModelId', 'resolveNativeModelSelection', 'nativeModelForDescriptor',
      'validateNativeModelEffort'].some(name => typeof selection?.[name] !== 'function')) {
      throw new Error('Unpaired model selection contract')
    }
  } catch {
    throw Object.assign(new Error('The paired engine cannot validate native model selections, so this model choice was refused.'),
      { code: 'AGENT_MODEL_RESOLVER_UNAVAILABLE' })
  }
  return selection
}

module.exports = { loadNativeModelSelection }
