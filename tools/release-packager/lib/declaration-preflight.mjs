import path from 'node:path'
import { toDeclarableFacts } from './portable-paths.mjs'
import { downloadManifestFromFacts } from './download-manifest.mjs'
import { renderDeclaration } from '../generate-declaration.mjs'
import { assertNoOwnerData } from '../../check-declaration-privacy.mjs'
import { assertReleaseReadiness } from '../../lib/release-readiness.mjs'

// Validate every public document before irreversible candidate bookkeeping.
// This is also the writer's single rendering path, so preflight cannot drift.
// Metadata preparation itself does not qualify a release. Authoritative writer
// and tag seams separately require the fixed registry's full-readiness proof.
export function prepareDeclarationArtifacts(stagingDir, measuredFacts, { test = false } = {}) {
  const declarableFacts = toDeclarableFacts(measuredFacts)
  const downloadManifest = downloadManifestFromFacts(declarableFacts)
  const declarationPath = path.join(stagingDir, test ? 'TEST-DECLARATION.md' : 'DECLARATION.md')
  const factsPath = path.join(stagingDir, 'declaration-facts.json')
  const manifestPath = path.join(stagingDir, test ? 'TEST-download.json' : 'download.json')
  const factsJson = `${JSON.stringify(declarableFacts, null, 2)}\n`
  const manifestJson = `${JSON.stringify(downloadManifest, null, 2)}\n`
  const declarationMarkdown = renderDeclaration(declarableFacts)
  assertNoOwnerData(factsPath, factsJson)
  assertNoOwnerData(manifestPath, manifestJson)
  assertNoOwnerData(declarationPath, declarationMarkdown)
  return { declarableFacts, downloadManifest, declarationPath, factsPath, manifestPath, factsJson, manifestJson, declarationMarkdown }
}

export async function tagDeclaredCandidate(stagingDir, measuredFacts, createTag, options = {}) {
  prepareDeclarationArtifacts(stagingDir, measuredFacts, options)
  await assertReleaseReadiness(measuredFacts.readiness, {
    product: 'toolsenabled', artifact: { sha256: measuredFacts.candidate?.sha256, bytes: measuredFacts.candidate?.bytes },
    sourceRefs: { app: measuredFacts.buildRef, engine: measuredFacts.engineSourceRef },
  })
  return createTag()
}
