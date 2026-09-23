#!/usr/bin/env node

/*
 * Focused NSIS boundary check for R76.
 *
 * electron-builder first compiles installer.nsi with BUILD_UNINSTALLER and runs
 * that temporary stub to make the uninstaller. The product's custom preInit
 * guard belongs in the ordinary shipped-installer pass, not in that build-only
 * stub. This helper compiles two minimal scripts that include the real
 * build/installer.nsh and compares their real makensis preprocessor output and
 * executable outputs. It never launches either executable and does not run
 * electron-builder, package a payload, or perform an install.
 *
 * The NSIS toolchain is intentionally supplied by the caller. On a Linux
 * control host, set MAKENSIS_BIN to a local makensis and NSISDIR to its matching
 * extracted share/nsis directory. APP_BUILDER_NSIS_INCLUDE_DIR may point at
 * app-builder-lib/templates/nsis/include when the checkout has no node_modules
 * link. All three resolved inputs are required; a makensis found through PATH
 * still needs an explicit NSISDIR. The default Linux control uses LogicLib with UAC_IsAdmin defined as a
 * constant expression: it compiles the real guard body without trying to load
 * a Windows-only UAC plugin. A Windows run may set NSIS_USE_UAC_PLUGIN=1 and
 * NSIS_PLUGIN_DIR to use the real plugin. Evidence is retained in a temporary
 * directory whose name starts with BUILDER5-W3-nsis-preinit-. Supply an existing
 * absolute NSIS_QA_EVIDENCE_ROOT to retain evidence in a caller-owned directory;
 * Windows requires this explicitly and never uses inherited TEMP/TMP.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER_NSH = path.join(REPO_ROOT, 'build', 'installer.nsh')
const PREFIX = 'BUILDER5-W3-nsis-preinit-'

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function resolveMakensis() {
  return process.env.MAKENSIS_BIN || 'makensis'
}

function resolveNsisDir(makensis) {
  if (process.env.NSISDIR) return process.env.NSISDIR
  if (path.isAbsolute(makensis)) return path.resolve(path.dirname(makensis), '..', 'share', 'nsis')
  return null
}

function resolveAppBuilderIncludeDir() {
  const configured = process.env.APP_BUILDER_NSIS_INCLUDE_DIR
  if (configured) return configured
  const candidate = path.join(REPO_ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include')
  return existsSync(candidate) ? candidate : null
}

function harness({ buildUninstaller, executablePath, appBuilderIncludeDir, pluginDir, useUacPlugin }) {
  const define = buildUninstaller ? '!define BUILD_UNINSTALLER\n' : ''
  const uacPrelude = useUacPlugin
    ? [
        `!addplugindir "${posixPath(pluginDir)}"`,
        '!include "UAC.nsh"',
      ]
    : [
        '!include "LogicLib.nsh"',
        '!define UAC_IsAdmin `"" UAC_IsAdmin ""`',
        '!macro _UAC_IsAdmin _a _b _t _f',
        '  StrCmp 0 0 `${_t}` `${_f}`',
        '!macroend',
      ]
  return [
    'Unicode true',
    `!addincludedir "${posixPath(appBuilderIncludeDir)}"`,
    ...uacPrelude,
    '!define PRODUCT_NAME "ToolsEnabled"',
    '!define PRODUCT_FILENAME "toolsenabled"',
    '!define VERSION "1.0.42"',
    define.trimEnd(),
    `!include "${posixPath(INSTALLER_NSH)}"`,
    'Name "ToolsEnabled"',
    'OutFile "' + posixPath(executablePath) + '"',
    'RequestExecutionLevel user',
    'Function .onInit',
    '  !ifmacrodef preInit',
    '    !insertmacro preInit',
    '  !endif',
    'FunctionEnd',
    'Section "boundary"',
    'SectionEnd',
    '',
  ].filter(line => line !== '').join('\n') + '\n'
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function runCompiler(makensis, script, output, ppo, ppoStderr, stdoutLog, stderrLog, environment) {
  // -PPO writes the preprocessed script to stdout. Keeping compiler diagnostics
  // separate makes the guard comparison real rather than a regex over the
  // source file itself. Capture both child streams ourselves: the compiler's
  // file-log option is not used because the pinned Linux compiler aborts there.
  const preprocess = spawnSync(makensis, ['-V0', '-WX', '-PPO', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: environment,
  })
  writeFileSync(ppo, preprocess.stdout ?? '', 'utf8')
  writeFileSync(ppoStderr, preprocess.stderr ?? '', 'utf8')
  const compile = spawnSync(makensis, ['-V4', '-WX', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: environment,
  })
  writeFileSync(stdoutLog, compile.stdout ?? '', 'utf8')
  writeFileSync(stderrLog, compile.stderr ?? '', 'utf8')
  return { preprocess, compile, output, ppo, ppoStderr, stdoutLog, stderrLog }
}

function statusOf(result) {
  return result.error || result.status === null ? null : result.status
}

function checkCase(name, result, expectedGuard) {
  const ppo = readFileSync(result.ppo, 'utf8')
  const has740 = /SetErrorLevel\s+740/.test(ppo)
  const hasMessage = /ToolsEnabled setup belongs to the Windows account/.test(ppo)
  if (statusOf(result.preprocess) !== 0) {
    throw new Error(`${name} preprocessing failed (exit ${statusOf(result.preprocess)}): ${result.preprocess.error?.message || result.preprocess.stderr || result.preprocess.stdout}`)
  }
  if (statusOf(result.compile) !== 0) {
    throw new Error(`${name} compilation failed (exit ${statusOf(result.compile)}): ${result.compile.error?.message || result.compile.stderr || result.compile.stdout}`)
  }
  if (!existsSync(result.output)) throw new Error(`${name} compilation reported success but produced no executable`)
  if (has740 !== expectedGuard || hasMessage !== expectedGuard) {
    throw new Error(`${name} preprocessed guard mismatch: SetErrorLevel740=${has740}, refusalMessage=${hasMessage}, expected=${expectedGuard}`)
  }
  return {
    name,
    preprocessExit: statusOf(result.preprocess),
    compileExit: statusOf(result.compile),
    ppoSha256: sha256(result.ppo),
    exeSha256: sha256(result.output),
    exeBytes: statSync(result.output).size,
    preprocessStdoutPath: result.ppo,
    preprocessStderrPath: result.ppoStderr,
    compileStdoutPath: result.stdoutLog,
    compileStderrPath: result.stderrLog,
    guardPresent: has740 && hasMessage,
  }
}

export function runNsisPreinitBoundary({
  makensis = resolveMakensis(),
  nsisDir = resolveNsisDir(makensis),
  appBuilderIncludeDir = resolveAppBuilderIncludeDir(),
  pluginDir = process.env.NSIS_PLUGIN_DIR || null,
  useUacPlugin = process.env.NSIS_USE_UAC_PLUGIN === '1',
  evidenceRoot = process.env.NSIS_QA_EVIDENCE_ROOT || null,
} = {}) {
  const missingInputs = Object.entries({
    MAKENSIS_BIN: makensis,
    NSISDIR: nsisDir,
    APP_BUILDER_NSIS_INCLUDE_DIR: appBuilderIncludeDir,
  }).filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([name]) => name)
  if (missingInputs.length) {
    return { ok: false, exitCode: 3, reason: `incomplete NSIS toolchain: ${missingInputs.join(', ')}`, missingInputs }
  }
  if (!existsSync(INSTALLER_NSH)) return { ok: false, exitCode: 2, reason: `missing ${INSTALLER_NSH}` }
  if (!appBuilderIncludeDir || !existsSync(path.join(appBuilderIncludeDir, 'UAC.nsh'))) {
    return { ok: false, exitCode: 3, reason: 'app-builder-lib NSIS include/UAC.nsh is unavailable' }
  }
  if (useUacPlugin && (!pluginDir || !existsSync(path.join(pluginDir, 'UAC.dll')))) {
    return { ok: false, exitCode: 3, reason: 'NSIS_USE_UAC_PLUGIN=1 requires NSIS_PLUGIN_DIR/UAC.dll' }
  }

  const outputRoot = evidenceRoot || (process.platform === 'win32' ? null : tmpdir())
  if (!outputRoot || !path.isAbsolute(outputRoot)) {
    return { ok: false, exitCode: 3, reason: 'an absolute NSIS_QA_EVIDENCE_ROOT is required (Windows never uses inherited TEMP/TMP)' }
  }
  // This Windows diagnostic is restricted to the current Dev account fence.
  // Reject a foreign profile before inspecting any path component.
  const normalizedRoot = path.resolve(outputRoot)
  if (process.platform === 'win32') {
    const devTemp = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp'
    if (normalizedRoot.toLowerCase() !== devTemp.toLowerCase() &&
        !normalizedRoot.toLowerCase().startsWith(`${devTemp.toLowerCase()}\\`)) {
      return { ok: false, exitCode: 3, reason: 'NSIS_QA_EVIDENCE_ROOT must stay inside the literal ToolsEnabled-Dev Temp tree' }
    }
    let component = path.parse(normalizedRoot).root
    try {
      for (const segment of normalizedRoot.slice(component.length).split(path.sep)) {
        component = path.join(component, segment)
        if (lstatSync(component).isSymbolicLink()) {
          return { ok: false, exitCode: 3, reason: 'NSIS_QA_EVIDENCE_ROOT must not traverse a symlink or junction' }
        }
      }
    } catch {
      return { ok: false, exitCode: 3, reason: 'NSIS_QA_EVIDENCE_ROOT must name an existing directory' }
    }
  }
  let canonicalRoot
  try {
    canonicalRoot = realpathSync(normalizedRoot)
    if (process.platform === 'win32' && canonicalRoot.toLowerCase() !== normalizedRoot.toLowerCase()) {
      return { ok: false, exitCode: 3, reason: 'NSIS_QA_EVIDENCE_ROOT must not resolve through a reparse target' }
    }
    if (!statSync(canonicalRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    return { ok: false, exitCode: 3, reason: 'NSIS_QA_EVIDENCE_ROOT must name an existing directory' }
  }

  const environment = { ...process.env }
  if (nsisDir) environment.NSISDIR = nsisDir
  const versionProbe = spawnSync(makensis, ['-VERSION'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: environment,
  })
  if (statusOf(versionProbe) !== 0) {
    return {
      ok: false,
      exitCode: 3,
      reason: `makensis is unavailable (exit ${statusOf(versionProbe)}): ${versionProbe.error?.message || versionProbe.stderr || versionProbe.stdout}`,
    }
  }

  const evidenceDir = mkdtempSync(path.join(canonicalRoot, PREFIX))
  const cases = [
    { name: 'generation-stub', buildUninstaller: true },
    { name: 'shipped-installer', buildUninstaller: false },
  ]
  const measurements = []
  for (const current of cases) {
    const script = path.join(evidenceDir, `${current.name}.nsi`)
    const ppo = path.join(evidenceDir, `${current.name}.ppo`)
    const ppoStderr = path.join(evidenceDir, `${current.name}.ppo.stderr`)
    const output = path.join(evidenceDir, `${current.name}.exe`)
    const stdoutLog = path.join(evidenceDir, `${current.name}.makensis.stdout.log`)
    const stderrLog = path.join(evidenceDir, `${current.name}.makensis.stderr.log`)
    writeFileSync(script, harness({ ...current, executablePath: output, appBuilderIncludeDir, pluginDir, useUacPlugin }), 'utf8')
    const result = runCompiler(makensis, script, output, ppo, ppoStderr, stdoutLog, stderrLog, environment)
    measurements.push(checkCase(current.name, result, !current.buildUninstaller))
  }

  if (measurements[0].ppoSha256 === measurements[1].ppoSha256 || measurements[0].exeSha256 === measurements[1].exeSha256) {
    throw new Error('generation and shipped outputs unexpectedly have identical hashes')
  }
  return {
    ok: true,
    exitCode: 0,
    evidenceDir,
    compilerVersion: `${versionProbe.stdout || versionProbe.stderr}`.trim(),
    uacPredicate: useUacPlugin ? 'UAC.dll' : 'LogicLib compile shim (UAC_IsAdmin expression shape)',
    measurements,
  }
}

function report(result) {
  if (!result.ok) {
    console.error(`NSIS preInit boundary: ${result.reason}`)
    return result.exitCode || 1
  }
  console.log(`NSIS preInit boundary: PASS (compiler ${result.compilerVersion}; UAC ${result.uacPredicate}; evidence ${result.evidenceDir})`)
  for (const measurement of result.measurements) {
    console.log(`${measurement.name}: preprocess=${measurement.preprocessExit} compile=${measurement.compileExit} guard=${measurement.guardPresent} ppo=${measurement.ppoSha256} exe=${measurement.exeSha256} bytes=${measurement.exeBytes}`)
  }
  return 0
}

function isDirectRun() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
}

if (isDirectRun()) process.exitCode = report(runNsisPreinitBoundary())
