// Explicit build provisioning. Runtime never fetches a CDN or a model host.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import profileGuard from '../shell/install-profile-guard.cjs'
export const HAND_ASSETS = [
  ['LICENSE.txt', 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE', 12331, '8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8'],
  ['vision_bundle.js', 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.js', 155465, '98db72469ffb176f5e9f2687be0f70783893aca681f7789c34b872b0a764371a'],
  ['vision_wasm_internal.js', 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_internal.js', 323377, 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73'],
  ['vision_wasm_internal.wasm', 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/vision_wasm_internal.wasm', 11756954, '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886'],
  ['hand_landmarker.task', 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', 7819105, 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'],
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function prepareHandControls(root, { verify = false } = {}) {
  const destination = path.resolve(root, 'public/hand-controls/vendor')
  if (process.platform === 'win32' && !profileGuard.insideWindowsPath(destination, os.userInfo().homedir)) throw new Error('Hand asset destination leaves the current Windows profile')
  // Reject links in each existing ancestor before any write or read.
  let cursor = destination
  while (cursor !== path.dirname(cursor)) {
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Hand asset path contains a link') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    cursor = path.dirname(cursor)
  }
  if (!verify) await fs.mkdir(destination, { recursive: true })
  for (const [name, url, size, hash] of HAND_ASSETS) {
    const file = path.join(destination, name)
    try {
      if (!(await fs.lstat(file)).isFile()) throw new Error('Hand asset is not a regular file: ' + name)
      const bytes = await fs.readFile(file)
      if (bytes.length !== size || digest(bytes) !== hash) throw new Error('Hand asset differs from its pinned source: ' + name)
      continue
    } catch (error) { if (error.code !== 'ENOENT') throw error; if (verify) throw new Error('Missing hand asset: ' + name + '. Run node tools/prepare-hand-controls.mjs') }
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error('Hand asset download failed: ' + name)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== size || digest(bytes) !== hash) throw new Error('Hand asset verification failed: ' + name)
    await fs.writeFile(file, bytes, { flag: 'wx' })
  }
  return { files: HAND_ASSETS.length, bytes: HAND_ASSETS.reduce((sum, entry) => sum + entry[2], 0) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareHandControls(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), { verify: process.argv.includes('--verify') })))
}
