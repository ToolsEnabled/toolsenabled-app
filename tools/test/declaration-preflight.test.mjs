import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const files = [
  'tools/release-packager/lib/declaration-preflight.mjs',
  'tools/release-packager/lib/portable-paths.mjs',
  'tools/release-packager/lib/download-manifest.mjs',
  'tools/release-packager/generate-declaration.mjs',
  'tools/check-declaration-privacy.mjs',
  'tools/check-no-owner-data.mjs',
  'shell/installer-pe-identity.cjs',
  'tools/release-packager/lib/readiness-handoff.mjs',
]

// Real renderer, privacy scanner and Git in a disposable repo. The profile is
// synthetic and no shared private/ file or process-wide HOME is changed.
async function runFixture(mode) {
  const tempRoot = ownedFixtureTempRoot()
  const root = await mkdtemp(path.join(tempRoot, 'declaration-preflight-'))
  try {
    for (const relative of files) {
      const target = path.join(root, relative)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(REPO, relative), target)
    }
    // This copied repository measures metadata/privacy/tag ordering only. Its
    // dependency is deliberately synthetic and never exists in a production
    // checkout; separate real-module qualification tests require real adapters.
    await mkdir(path.join(root, 'tools/lib'), { recursive: true })
    await writeFile(path.join(root, 'tools/lib/release-readiness.mjs'),
      'export { readinessDigest } from ' + JSON.stringify(pathToFileURL(path.join(REPO, 'tools/lib/release-readiness.mjs')).href) + ';\n' +
      "export function assertReleaseReadiness(receipt) { if (receipt?.fixture !== true) throw new Error('synthetic fixture receipt required'); return receipt }\n" +
      "export function assertReadinessAdaptersAvailable() { throw new Error('no production adapters in metadata fixture') }\n" +
      "export function assertReceiptNamesRegisteredAdapters() { throw new Error('no production adapters in metadata fixture') }\n" +
      "export async function readReleaseReadiness() { throw new Error('metadata fixture cannot qualify a release') }\n")
    await mkdir(path.join(root, 'private'))
    await writeFile(path.join(root, 'private/owner-data-patterns.owner.json'),
      JSON.stringify({ patterns: [{ value: 'fixture-cutter-account' }, { value: 'fixture-private-text' }] }))
    await writeFile(path.join(root, 'empty-git-config'), '')
    const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot,
      MC_IDENTITY_PROFILE_ACCOUNT: 'fixture-cutter-account',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-git-config') }
    for (const key of Object.keys(env)) {
      if (/^GIT_/i.test(key) && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete env[key]
    }
    delete env.NODE_TEST_CONTEXT
    const accountPath = String.raw`C:\Users\independent-path-account\fixture`
    const notes = {
      'profile-path': accountPath,
      'escaped-profile-path': JSON.stringify(accountPath),
      'twice-escaped-profile-path': JSON.stringify(JSON.stringify(accountPath)),
      'bare-profile-root': String.raw`C:\Users`,
      'escaped-profile-root': JSON.stringify(String.raw`C:\Users` + '\\'),
    }
    const input = [
      "import assert from 'node:assert/strict';",
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync, readFileSync, existsSync } from 'node:fs';",
      "import path from 'node:path';",
      'const { prepareDeclarationArtifacts, tagDeclaredCandidate } = await import(' +
        JSON.stringify(pathToFileURL(path.join(root, files[0])).href) + ');',
      'const { writeDeclaration } = await import(' +
        JSON.stringify(pathToFileURL(path.join(root, files[3])).href) + ');',
      'const mode = ' + JSON.stringify(mode) + ';',
      'const privacyNote = ' + JSON.stringify(notes[mode] ?? null) + ';',
      "function git(...args) { const r=spawnSync('git', args, {encoding:'utf8',windowsHide:true,timeout:10000}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }",
      "git('init','--quiet','--template=');",
      "writeFileSync('source.txt','original source'); git('add','source.txt');",
      "git('-c','user.name=Fixture Cutter','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture');",
      "const head=git('rev-parse','HEAD');",
      "const facts={test:false,date:'2026-09-05',version:'1.0.2',previousVersion:'1.0.1',branch:'release-fixture',",
      "readiness:{fixture:true},",
      "sourceRef:head,engineSourceRef:'c'.repeat(40),buildRef:head,branchAdvanced:false,",
      "candidate:{filename:'ToolsEnabled Setup 1.0.2.exe',bytes:42,sha256:'a'.repeat(64)},publisher:'ToolsEnabled, Inc.',",
      "treeState:{worktreeRemoved:false,buildInfoConfirmedClean:true},",
      "versionInfo:{companyName:'ToolsEnabled, Inc.',productName:'ToolsEnabled',fileVersion:'1.0.2',productVersion:'1.0.2',legalCopyright:'Copyright 2026 ToolsEnabled'},",
      "appId:{configured:'com.toolsenabled.desktop'},unsigned:{signExecutable:false},pipeline:{distExitCode:0,packagedQaExitCode:0},",
      "excludedWip:{measuredAt:'2026-09-05T00:00:00Z',dirtyFiles:[]},otherCandidates:[],stagingDir:'<candidate-staging>',privateInputsCopied:[]};",
      "if(mode==='private-text') facts.knownFixes=[{title:'fixture-private-text',detail:'never publish this fixture label'}];",
      "if(mode==='invalid-manifest') facts.candidate.sha256='not-a-digest';",
      "if(mode==='missing-publisher') delete facts.publisher;",
      "if(privacyNote!==null) facts.pipeline.smokePackagedLine=privacyNote;",
      "let calls=0; const createTag=()=>{calls++;git('tag','build/1.0.2',head);writeFileSync('source.txt','bookkeeping reached');return 'created';};",
      // The existing scanner forbids even a bare profile root. Escaping it
      // cannot create an exception, and preflight must keep the tag untouched.
      "if(mode==='valid') {",
      "const prepared=prepareDeclarationArtifacts('.',facts);",
      "assert.match(prepared.declarationMarkdown,/ToolsEnabled Setup 1\\.0\\.2\\.exe/);",
      "assert.equal(JSON.parse(prepared.factsJson).buildRef,head);",
      "assert.equal(JSON.parse(prepared.manifestJson).sha256,'a'.repeat(64));",
      "await writeDeclaration('DECLARATION.md',facts); assert.ok(existsSync('DECLARATION.md'));",
      "if(privacyNote!==null) assert.ok(readFileSync('DECLARATION.md','utf8').includes(privacyNote));",
      "assert.equal(await tagDeclaredCandidate('.',facts,createTag),'created');assert.equal(calls,1);assert.equal(git('rev-parse','build/1.0.2'),head);",
      "} else {",
      "await assert.rejects(()=>tagDeclaredCandidate('.',facts,createTag),/owner-identifying|candidate.sha256|publisher/);",
      "assert.equal(calls,0);assert.equal(git('tag','--list'),'');",
      "assert.equal(readFileSync('source.txt','utf8'),'original source');assert.equal(git('rev-parse','HEAD'),head);",
      "if(privacyNote!==null) { await assert.rejects(()=>writeDeclaration('DECLARATION.md',facts),/owner-identifying.*NOT written/); assert.equal(existsSync('DECLARATION.md'),false); }",
      "}",
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input, cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.error, undefined, String(result.error))
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    assert.equal(path.dirname(root), path.resolve(tempRoot))
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

for (const mode of ['valid', 'private-text', 'invalid-manifest', 'missing-publisher',
  'profile-path', 'escaped-profile-path', 'twice-escaped-profile-path', 'bare-profile-root', 'escaped-profile-root']) {
  test('declaration preflight before Git bookkeeping: ' + mode, () => runFixture(mode))
}
