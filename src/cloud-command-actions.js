import { CLOUD_WORKER_LIMITS, cloudCommandPrefix, composeCloudCommand } from '../shell/cloud-command.mjs'
import { PALETTE_PANEL } from './fleet-tree-copy.js'

// These choices only edit the originating composer. Sending /cloud directly
// already has usable defaults and never opens this optional picker.
export function cloudCommandAction({ enabled, disabledHint } = {}) {
  const choices = [null, ...CLOUD_WORKER_LIMITS]
  return {
    id: 'cloud', group: PALETTE_PANEL.groupCommon, label: PALETTE_PANEL.cloud,
    hint: PALETTE_PANEL.cloudHint, enabled: Boolean(enabled), disabledHint,
    run: ctx => ctx.show(choices.map(workers => ({
      id: workers === null ? 'cloud-auto' : `cloud-workers-${workers}`,
      label: workers === null ? PALETTE_PANEL.cloudAuto : `Up to ${workers} cloud worker${workers === 1 ? '' : 's'}`,
      hint: PALETTE_PANEL.cloudChoiceHint, enabled: true,
      run: picked => picked.compose(cloudCommandPrefix(workers), PALETTE_PANEL.cloudComposeHint, {
        rewrite: draft => composeCloudCommand(draft, workers),
        queueEditHint: PALETTE_PANEL.cloudQueueEdit,
      }),
    })), { title: PALETTE_PANEL.cloud }),
  }
}
