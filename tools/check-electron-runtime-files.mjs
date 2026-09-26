/* Fail the build if the packaged output is missing an Electron runtime file.
 *
 * WHAT WENT WRONG, MEASURED. release/win-unpacked held ToolsEnabled.exe and
 * resources/app.asar and five DLLs -- and no icudtl.dat, no resources.pak, no
 * v8_context_snapshot.bin, no snapshot_blob.bin, no ffmpeg.dll and no locales/.
 * It died in 310ms with "Invalid file descriptor to ICU data received". The
 * NSIS installer built from it -- ToolsEnabled Setup 1.0.6.exe, 265 files,
 * 79 MB against the 336 files and 102 MB a whole one weighs -- carried the same
 * hole, so every person who installed it got an application that cannot start.
 *
 * NOTHING IN THE SHIP CHAIN NOTICED, and that is the part worth fixing. The
 * artifact seal recorded the short tree as the truth. check-asar-manifest,
 * check-renderer-payload, check-no-owner-data and check-payload-boundary all
 * passed, because every one of them inspects resources/app.asar or the
 * capability payload -- the two things that WERE correct. smoke-packaged would
 * have caught it, and it is the last step in `npm run dist`, so the artifact and
 * its installer both already existed by the time anything went red. Four other
 * QA drivers stage from this directory and were measuring a dead tree.
 *
 * So this runs IMMEDIATELY after electron-builder, before the seal, before the
 * installer is treated as real, and it asks the one question none of the others
 * ask: is the Electron runtime actually here.
 *
 * TWO CHECKS, ON PURPOSE.
 *
 * 1. AN EXPLICIT NAMED FLOOR (REQUIRED below). Every file is spelled out, with
 *    the reason it has to be there. A derived-only check would have silently
 *    shrunk to nothing the day the source distribution was itself incomplete --
 *    which is exactly the class of defect being guarded against.
 *
 * 2. PARITY WITH THE PINNED DISTRIBUTION. Every file in node_modules/electron/
 *    dist must reach the output, so a future Electron that adds a runtime file
 *    is covered without anyone remembering to edit the list above.
 *
 * Sizes are compared too. A truncated or half-copied file is not a present file,
 * and "it exists" is the assertion that let a 0-byte icudtl.dat through in every
 * other tool that ever checked for one.
 */
import { realpathSync } from 'node:fs'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { getCurrentFuseWire, FuseV1Options, FuseVersion } = require('@electron/fuses')
const {
  prepareSterileProfile,
  sterileLaunchEnvironment,
  sterileProfileDirectories,
} = require('./lib/sterile-launch.cjs')

/* electron-builder renames these on the way out (ElectronFramework.js,
 * cleanupAfterUnpack + the productName rename). Left side is the name in
 * node_modules/electron/dist, right side is the name in the output. */
const RENAMED = new Map([
  ['electron.exe', 'ToolsEnabled.exe'],
  ['LICENSE', 'LICENSE.electron.txt'],
])

/* Deliberately removed by electron-builder when it owns the unpack, so their
 * absence is not evidence of a broken copy either way. */
const MAY_BE_ABSENT = new Set(['version', 'resources/default_app.asar'])

/* THE FLOOR. Each entry is a file whose absence is a defect, and the sentence
 * after it is what breaks when it is gone. */
const REQUIRED = [
  ['ToolsEnabled.exe', 'the application itself'],
  ['resources/app.asar', 'every line of application code'],
  ['icudtl.dat', 'ICU locale data -- without it Electron aborts at startup with "Invalid file descriptor to ICU data received". THIS IS THE ONE THAT BROKE 1.0.6.'],
  ['resources.pak', "Chromium's own UI resources; the browser layer cannot initialise without it"],
  ['chrome_100_percent.pak', 'UI images at 1x scale'],
  ['chrome_200_percent.pak', 'UI images at 2x scale, which is every high-DPI laptop'],
  ['v8_context_snapshot.bin', "V8's startup snapshot; the renderer has no JavaScript context without it"],
  ['snapshot_blob.bin', "V8's isolate snapshot"],
  ['locales/en-US.pak', 'localised strings; an empty locales/ directory means no text anywhere'],
  ['ffmpeg.dll', 'audio and video decoding'],
  ['libEGL.dll', 'ANGLE, which is how Chromium reaches the GPU on Windows'],
  ['libGLESv2.dll', 'ANGLE GLES translation'],
  ['d3dcompiler_47.dll', 'HLSL shader compilation for ANGLE'],
  ['vk_swiftshader.dll', 'the software renderer used when no usable GPU is present'],
  ['vk_swiftshader_icd.json', 'the loader manifest without which SwiftShader is never found'],
  ['vulkan-1.dll', 'the Vulkan loader SwiftShader is reached through'],
  ['dxcompiler.dll', 'DXIL shader compilation'],
  ['dxil.dll', 'DXIL signing, required before a compiled shader will run'],
]
const LINUX_REQUIRED = [
  ...REQUIRED.filter(([name]) => !name.endsWith('.exe') && !name.endsWith('.dll')),
  ['toolsenabled', 'the native Linux ELF application'],
  ['chrome-sandbox', 'Chromium sandbox helper'],
  ['chrome_crashpad_handler', 'Chromium crash handler'],
  ['libffmpeg.so', 'audio and video decoding'],
  ['libEGL.so', 'ANGLE EGL support'],
  ['libGLESv2.so', 'ANGLE GLES translation'],
  ['libvk_swiftshader.so', 'software rendering'],
  ['libvulkan.so.1', 'Vulkan loader'],
]

const MINIMUM_LOCALE_FILES = 40
const FUSE_ENABLED = '1'.charCodeAt(0)
const FUSE_DISABLED = '0'.charCodeAt(0)
const REQUIRED_FUSES = Object.freeze([
  [FuseV1Options.RunAsNode, FUSE_ENABLED, 'RunAsNode must remain enabled for the shipped capability child'],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED, 'NODE_OPTIONS must not execute code before the startup identity guard'],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED, 'the normal Electron-main path must reject Node inspector arguments; RunAsNode child grammar is enforced separately'],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED, 'the packaged executable must not fall back to an adjacent source app directory'],
])

async function statOrNull(file) {
  try { return await stat(file) } catch { return null }
}

async function walk(root, base = root) {
  const out = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

export async function probeHardenedExecutablePolicy(executable, outputDirectory) {
  if (!['win32', 'linux'].includes(process.platform)) return { ok: false, reason: 'unsupported native executable policy platform' }
  const scratch = await mkdtemp(path.join(path.dirname(outputDirectory), '.toolsenabled-runtime-policy-'))
  const marker = path.join(scratch, 'node-options-marker.txt')
  const answer = path.join(scratch, 'runner-answer.json')
  const loader = path.join(scratch, 'ambient-loader.cjs')
  const runner = path.join(scratch, 'runner.cjs')
  try {
    await writeFile(loader, `'use strict'\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'LOADER_RAN', 'utf8')\n`, 'utf8')
    await writeFile(runner, `'use strict'\nrequire('node:fs').writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS || null }), 'utf8')\n`, 'utf8')
    /* The executable is deliberately re-entered in Node mode for this fuse
       probe, but it is still the shipped application binary. Give it the same
       sterile per-run homes as every GUI harness before adding the two exact
       variables this probe is designed to exercise. Inheriting LOCALAPPDATA
       here would let even a pre-main policy check read the builder's machine
       record and rewrite that account's chosen workspace. */
    const env = sterileLaunchEnvironment(
      prepareSterileProfile(sterileProfileDirectories(path.join(scratch, 'profile'))),
      process.env,
    )
    env.ELECTRON_RUN_AS_NODE = '1'
    env.NODE_OPTIONS = `--require=${JSON.stringify(loader)}`
    const result = spawnSync(executable, [runner], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    if (result.error) return { ok: false, reason: `the hardened executable probe could not run: ${result.error.message}` }
    if (result.status !== 0) {
      return { ok: false, reason: `the hardened executable probe exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}` }
    }
    if (await statOrNull(marker)) return { ok: false, reason: 'NODE_OPTIONS executed a loader before the selected RunAsNode script' }
    let record
    try { record = JSON.parse(await readFile(answer, 'utf8')) } catch (error) {
      return { ok: false, reason: `the selected RunAsNode script produced no readable answer: ${error.message}` }
    }
    if (record?.nodeOptions !== null) return { ok: false, reason: 'the hardened runtime retained NODE_OPTIONS in the selected script environment' }
    return { ok: true, reason: 'NODE_OPTIONS loader blocked before RunAsNode script' }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function checkElectronRuntimeFiles(outputDirectory, electronDist, {
  platform = process.platform,
  readFuseWire = getCurrentFuseWire,
  probeExecutablePolicy = probeHardenedExecutablePolicy,
} = {}) {
  const output = path.resolve(outputDirectory)
  const dist = path.resolve(electronDist)
  const failures = []
  const checked = []
  if (!['win32', 'linux'].includes(platform)) return { ok: false, checked, failures: ['unsupported target runtime platform'] }
  const executableName = platform === 'linux' ? 'toolsenabled' : 'ToolsEnabled.exe'
  const renamed = platform === 'linux' ? new Map([['electron', executableName], ['LICENSE', 'LICENSE.electron.txt']]) : RENAMED

  if (!(await statOrNull(output))?.isDirectory()) {
    return { ok: false, checked, failures: [`the packaged output directory does not exist: ${output}`] }
  }

  // 1. THE NAMED FLOOR.
  for (const [relative, why] of platform === 'linux' ? LINUX_REQUIRED : REQUIRED) {
    const info = await statOrNull(path.join(output, relative.split('/').join(path.sep)))
    if (!info) failures.push(`MISSING ${relative} -- ${why}`)
    else if (!info.isFile()) failures.push(`NOT A FILE ${relative} -- ${why}`)
    else if (!info.size) failures.push(`EMPTY ${relative} (0 bytes) -- ${why}`)
    else checked.push(relative)
  }

  // A single named locale proves the directory exists; a count proves the copy
  // of it was not cut short partway through.
  const locales = await readdir(path.join(output, 'locales')).catch(() => null)
  if (locales === null) failures.push('MISSING locales/ -- the directory itself is absent')
  else if (locales.filter((name) => name.endsWith('.pak')).length < MINIMUM_LOCALE_FILES) {
    failures.push(
      `locales/ holds only ${locales.filter((n) => n.endsWith('.pak')).length} .pak files, expected at least ` +
      `${MINIMUM_LOCALE_FILES} -- a partial copy, not a localisation choice`,
    )
  }

  /* This executable is the first product-owned boundary in the process. A
     JavaScript-only check is too late for NODE_OPTIONS: Electron evaluates its
     --require before shell/main.cjs can inspect the token or userData path.
     Read the bytes that are about to ship, independently of the afterPack hook
     that was supposed to flip them. */
  const executable = path.join(output, executableName)
  if (platform === 'linux') {
    let fd
    try {
      fd = await open(executable, 'r')
      const info = await fd.stat(), magic = Buffer.alloc(4)
      const { bytesRead } = await fd.read(magic, 0, 4, 0)
      if (!info.isFile() || !(info.mode & 0o111) || bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        failures.push('NATIVE FORMAT toolsenabled -- an executable Linux ELF file is required')
      } else checked.push('toolsenabled:linux-elf')
    } catch { failures.push('NATIVE FORMAT toolsenabled -- executable could not be inspected') }
    finally { await fd?.close() }
  }
  try {
    const wire = await readFuseWire(executable)
    if (!wire || String(wire.version) !== String(FuseVersion.V1)) {
      failures.push(`FUSE POLICY ${executableName} -- unsupported or unreadable fuse version ${String(wire?.version)}`)
    } else {
      const fuseFailures = REQUIRED_FUSES
        .filter(([option, expected]) => wire[option] !== expected)
        .map(([option, expected, why]) => `FUSE POLICY ${executableName} -- option ${option} is ${wire[option]}, expected ${expected}: ${why}`)
      failures.push(...fuseFailures)
      if (fuseFailures.length === 0) checked.push(`${executableName}:fuse-policy`)
    }
  } catch (error) {
    failures.push(`FUSE POLICY ${executableName} -- could not read executable fuses: ${error.message}`)
  }

  try {
    const behavior = await probeExecutablePolicy(executable, output)
    if (behavior?.ok === true) checked.push(`${executableName}:pre-main-behavior`)
    else failures.push(`EXECUTABLE POLICY ${executableName} -- ${behavior?.reason || 'behavioral probe failed without a reason'}`)
  } catch (error) {
    failures.push(`EXECUTABLE POLICY ${executableName} -- behavioral probe threw: ${error.message}`)
  }

  // 2. PARITY WITH THE PINNED DISTRIBUTION, including byte sizes.
  if (!(await statOrNull(dist))?.isDirectory()) {
    failures.push(`cannot verify parity: the pinned Electron distribution is absent (${dist})`)
    return { ok: failures.length === 0, checked, failures }
  }

  const distributionFiles = await walk(dist)
  if (distributionFiles.length === 0) {
    failures.push(`cannot verify parity: the pinned Electron distribution contains no files (${dist})`)
    return { ok: false, checked, failures }
  }

  for (const relative of distributionFiles) {
    const expected = renamed.get(relative) ?? relative
    if (MAY_BE_ABSENT.has(relative) || MAY_BE_ABSENT.has(expected)) continue
    const source = await statOrNull(path.join(dist, relative.split('/').join(path.sep)))
    const packed = await statOrNull(path.join(output, expected.split('/').join(path.sep)))
    if (!packed) {
      failures.push(`MISSING ${expected} -- present in the pinned Electron ${path.basename(dist)} but not in the output`)
    } else if (packed.size !== source.size && !(platform === 'win32' && RENAMED.has(relative))) {
      // The renamed .exe legitimately differs: electron-builder rewrites its
      // icon and version resources with rcedit.
      failures.push(`TRUNCATED ${expected} -- ${packed.size} bytes in the output, ${source.size} in the distribution`)
    }
  }

  return { ok: failures.length === 0, checked, failures }
}

/* --prepare: DELETE THE HOLE INSTEAD OF REPORTING IT.
 *
 * The check below is a safety net, and a net that catches the artifact AFTER
 * electron-builder has already written the installer is a late one -- the same
 * invocation produces win-unpacked and the .exe, so by the time anything can
 * look, a broken installer exists on disk.
 *
 * This runs BEFORE electron-builder and removes the output directory outright.
 * electron-builder calls emptyDir() on it too, but emptyDir is not allowed to
 * fail the build, and a running ToolsEnabled.exe makes it a partial no-op: the
 * loaded DLLs and the running .exe image cannot be unlinked while mapped, and
 * that is precisely the state 1.0.6 was built in -- its output still carried a
 * debug.log written six hours before the build started.
 *
 * The difference that matters is that this REFUSES. If the directory cannot be
 * removed, the build stops before producing anything, instead of producing an
 * application that cannot start.
 */
async function prepareOutputDirectory(outputDirectory) {
  const output = path.resolve(outputDirectory)
  if (!(await statOrNull(output))) {
    console.log(`check-electron-runtime-files --prepare: ${output} does not exist; nothing to clear`)
    return true
  }
  try {
    await rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.error(
      `check-electron-runtime-files --prepare FAILED: could not clear ${output}\n  ${error.message}\n\n` +
      'Something is holding the previous build. Almost always that is a ToolsEnabled.exe still running\n' +
      'from this directory -- a QA driver, a smoke run, or a window left open. electron-builder would\n' +
      'NOT have failed here: it empties this directory on a best-effort basis and carries on, which is\n' +
      'how a build produced an installer with no icudtl.dat in it and no step noticed.\n' +
      'Close every instance and build again.',
    )
    return false
  }
  const leftover = await statOrNull(output)
  if (leftover) {
    console.error(`check-electron-runtime-files --prepare FAILED: ${output} still exists after removal.`)
    return false
  }
  console.log(`check-electron-runtime-files --prepare: cleared ${output}`)
  return true
}

/* Compare filesystem identities, not spellings. Release builds also run through
 * junction lanes on case-insensitive NTFS; argv[1] can therefore name this
 * exact file without having the same URL text. A false main-module result is a
 * green gate that ran no checks at all. */
const invoked = process.argv[1] &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
if (invoked && process.argv.includes('--prepare')) {
  const target = process.argv.filter((a) => a !== '--prepare')[2] || (process.platform === 'linux' ? 'release/linux-unpacked' : 'release/win-unpacked')
  if (!(await prepareOutputDirectory(target))) process.exitCode = 1
} else if (invoked) {
  const output = process.argv[2] || (process.platform === 'linux' ? 'release/linux-unpacked' : 'release/win-unpacked')
  const dist = process.argv[3] || 'node_modules/electron/dist'
  const { ok, checked, failures } = await checkElectronRuntimeFiles(output, dist)
  if (ok) {
    console.log(`check-electron-runtime-files: OK -- ${checked.length} runtime and executable-policy checks passed in ${output}, with required-file parity against ${dist}`)
  } else {
    console.error(`check-electron-runtime-files FAILED for ${path.resolve(output)}:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      '\nRuntime qualification failed. Inspect the exact file, fuse or execution-policy failures above.\n' +
      'This result does not certify any installer built from the output.',
    )
    process.exitCode = 1
  }
}
