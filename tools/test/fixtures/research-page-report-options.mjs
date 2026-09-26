// The Research page's export-report call (src/research-benchmark.js) passes, for a
// project the page froze, the live provenance registry and ATTRIBUTIONS.md when this
// runtime carries them and the manifest of the export it would write for the same
// project, runtime and inputs; this fixture mirrors that case. For a project opened
// from an exported archive the page passes the archive's own manifest.json,
// provenance.json and ATTRIBUTIONS.md instead, exactly as the exported CLI reads them
// beside the project (see research-benchmark-open-exported-run.test.mjs). A
// browser-side stand-in compared with the exported CLI does the same; the CLI reads the
// export's own copies, so the two halves of that parity keep separate sources.
import * as leanCodegen from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'

export async function pageReportOptions({ project = null, sources = null, attachments = {} } = {}) {
  const registry = typeof leanCodegen.provenanceDocument === 'function'
    ? { provenance: leanCodegen.provenanceDocument(), attributions: leanCodegen.attributionsMarkdown() } : {}
  if (!project || !sources) return registry
  // The page hashes the runtime it is running, the same sources it would export, so the
  // report's runtime-integrity line is computed on both sides of the parity from its own source.
  const runtimeIntegrity = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([file, text]) => [file, await sha256(text)])))
  return { ...registry, manifest: (await projectFiles(project, sources, attachments))['manifest.json'], runtimeIntegrity }
}
