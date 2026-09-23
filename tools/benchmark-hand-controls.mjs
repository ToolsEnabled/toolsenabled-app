import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { sterileLaunchEnvironment, prepareSterileProfile, sterileProfileDirectories } = require('./lib/sterile-launch.cjs')
const data = await fs.mkdtemp('C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp\\hand-controls-benchmark-')
const response = await fetch('https://storage.googleapis.com/mediapipe-assets/thumb_up.jpg', { signal: AbortSignal.timeout(30000) })
if (!response.ok) throw Error('Could not obtain the official hand fixture')
const bytes = Buffer.from(await response.arrayBuffer())
if (bytes.length !== 80388 || createHash('sha256').update(bytes).digest('hex') !== '5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291') throw Error('Official hand fixture changed')
await fs.writeFile(path.join(data, 'thumb_up.jpg'), bytes, { flag: 'wx' })
const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(data)))
const { stdout } = await promisify(execFile)(require('electron'), [path.join(root, 'tools/hand-controls-practice.cjs'), data, '--benchmark',
  ...(process.argv.includes('--sustained') ? ['--sustained'] : [])], {
  cwd: root, env, windowsHide: true, timeout: 75000, maxBuffer: 1024 * 1024,
})
console.log(stdout)
