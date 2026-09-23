'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

module.exports = async function beforePackVoice(context) {
  if (context.electronPlatformName !== 'win32') return
  // The build performs large sequential reads and later launches compression.
  // Keep both the hook and its builder children below interactive app work.
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
  const { prepareVoiceBundle, verifyVoiceBundle } = await import('./prepare-voice-runtime.mjs')
  const appRoot = context.packager.projectDir
  const sourceRoot = path.join(appRoot, 'voice-runtime')
  const output = path.join(sourceRoot, 'bundle')
  if (fs.existsSync(output)) { await verifyVoiceBundle(output, sourceRoot); return }
  const config = path.join(appRoot, 'private/voice-runtime-source.owner.json')
  if (!fs.existsSync(config)) {
    // LOCAL SPEECH IS A SEPARATE PACK, NOT PART OF THE INSTALLER. Owner decision
    // OD7, and B23c: "the person approved a SEPARATE hash-manifested speech pack
    // as an opt-in download, a second public unit beside the installer, and
    // 1.0.42 may ship without the pack if unmeasured."
    //
    // This branch used to throw "Local speech must be included in the Windows
    // installer", which was correct under the previous design and became a hard
    // block on every cut once the bundle stopped being staged in-tree: with no
    // bundle and no owner config there was no way to build an installer at all,
    // and the only ways past it were to fabricate a bundle or to weaken a check.
    //
    // Building WITHOUT the bundle is now the approved default, and it is stated
    // rather than silent: a build that quietly omits a feature is indistinguishable
    // from one that lost it. Nothing below relaxes -- if a bundle IS present the
    // branch above verifies it in full, including the pinned notices and the GPL
    // corresponding source.
    console.log('Speech: building WITHOUT the local speech runtime. It ships as the separate opt-in pack behind the Settings door "Install local speech" (owner decision OD7 / B23c), not inside this installer.')
    return
  }
  await prepareVoiceBundle({ ...JSON.parse(fs.readFileSync(config, 'utf8')), appRoot, output })
}
