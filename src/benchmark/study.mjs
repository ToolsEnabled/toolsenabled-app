import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { STUDY_VERSION, SUPPORTED_SCHEMA_VERSIONS, modernSchema, LEGACY_RUNTIME_FILES, RUNTIME_FILES, runtimeFilesForVersion } from './study-schema.mjs'
// The composition root, imported for its registration side effect only. This
// is the one place the shipped benchmarks are loaded; study.mjs is the compiler
// every consumer enters through, so the registry is populated before any study
// is compiled, graded or audited. No symbol is taken from a vertical here.
import './plugins.mjs'
import { benchmarkById, benchmarkFor, benchmarkForDomain, benchmarkSuppliesSemantics, gradingKind, isRegisteredDomain, registeredDomains } from './registry.mjs'
import { resolveAnalysisPopulation, validateAnalysisPlan, validateDesignPlan } from './analysis.mjs'
import { generateCorpus, validateCorpusPlan } from './corpus.mjs'
import { compileTask, deriveTaskExpected, semanticTaskId, taskGradingContract } from './tasks.mjs'
import { decodeInformationResponse, gradeInterpretations, informationDisposition } from './information.mjs'
import { auditReviewPacket, auditReviewStatus, gradeJudge, materializeAudit, validateAuditPlan } from './audit.mjs'
import { validateObservationPlan, validatePriceTable } from './observations.mjs'
import { compileRequirementPlan, validateRequirementPlan, compileNativePreparationPlan, validateNativePreparationPlan } from './requirements.mjs'
import { compileWorkflows, validateWorkflowPlan } from './workflow.mjs'
import { validateExperimentTemplate, compileExperimentTemplate } from './templates.mjs'
import { validateExecutionPlan, deriveReadinessContract } from './readiness.mjs'
export { analyze, summaryCsv } from './analysis.mjs'

// The schema version and its runtime inventory live in study-schema.mjs, a leaf
// module, because analysis/readiness/tasks need them and study.mjs imports those.
export { STUDY_VERSION, SUPPORTED_SCHEMA_VERSIONS, modernSchema, LEGACY_RUNTIME_FILES, V2_RUNTIME_FILES, RUNTIME_FILES, runtimeFilesForVersion } from './study-schema.mjs'
// ---- The generator of record ----
// A paper citing a study must be able to name the application release that froze
// it, rather than infer it from the machine that rendered the report. The release
// is a constant here, not a read of package.json, because this runtime is copied
// verbatim into every export and runs with no application beside it;
// tools/test/research-benchmark-generator-identity.test.mjs holds the constant
// equal to the shipped version so the two cannot drift apart.
export const GENERATOR = Object.freeze({ name: 'ToolsEnabled', version: '1.0.45' })
// Historical manifests retain their actual source inventory. Adding a new
// compiler module must not add a missing file to an already frozen project.
export function runtimeFilesFor(value) {
  const spec = value?.spec || value
  // Returning the current RUNTIME_FILES for every modern spec meant that adding
  // a compiler module silently added files to projects frozen before that module
  // existed: their identity moved, and reading an older archive looked for files
  // it does not contain. The inventory belongs to the schema version.
  if (modernSchema(spec)) return runtimeFilesForVersion(spec.schemaVersion)
  return spec?.runtimeSources ? [...new Set(['cli.mjs', 'prompts.mjs', 'study.mjs', 'runner.mjs', ...Object.keys(spec.runtimeSources)])] : LEGACY_RUNTIME_FILES
}
// ---- The template as a citable artifact ----
// A paper cites the generic template that produced a study, not the application
// that hosted it. The identity has two parts: the human-readable template
// version, and the SHA-256 of the exact pinned runtime that froze the project,
// so two studies frozen with different runtime bytes never share an identity.
// Both derive from the frozen project alone, which is what keeps the page's
// exported report and the standalone CLI byte-identical.
// The template's own citation: its author, its licence and how to cite it. These belong to the
// TEMPLATE, which is the citable artifact. A study's own spec.citation is a separate layer:
// naming this author as the author of every generated study would misattribute work that is
// not his, so the two layers stay apart in the citation files and in the report.
const TEMPLATE_TITLE = 'ToolsEnabled Research Benchmark Template'
const TEMPLATE_VERSION = '2.0.0'
const TEMPLATE_GENERATOR = Object.freeze({ name: 'ToolsEnabled', version: '1.0.45' })
// docs/ATTRIBUTION.md, "## The academic form", verbatim: the blockquote markers are stripped
// and the wrapped lines joined, and nothing else is changed.
const TEMPLATE_AI_STATEMENT = 'Joshua Pinckard conceived the project, defined its objectives and requirements, directed the autonomous agent workflows, selected and evaluated outputs, and assumes responsibility for the research methodology and conclusions. AI agents generated substantial portions of the implementation and written drafts.'
// The licence the export ships. It is a constant rather than a file read, because an export
// is generated in the browser and must carry its own licence text.
const TEMPLATE_LICENSE_TEXT = [
  'MIT License', '',
  'Copyright (c) 2026 Joshua Pinckard', '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:', '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.', '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.', '',
].join('\n')
export const TEMPLATE = Object.freeze({
  id: 'research-benchmark-template',
  title: TEMPLATE_TITLE,
  version: TEMPLATE_VERSION,
  schemaVersion: STUDY_VERSION,
  publisher: 'ToolsEnabled, Inc. in formation',
  url: 'https://toolsenabled.ai',
  specification: 'docs/research-benchmark-template-spec.md',
  // The application release that ships this runtime. Kept equal to package.json
  // by tools/test/research-benchmark-template-citation.test.mjs, so a release
  // bump that forgets it fails that test instead of misnaming the generator.
  generator: TEMPLATE_GENERATOR,
  author: 'Joshua Pinckard',
  aiStatement: TEMPLATE_AI_STATEMENT,
  license: 'MIT',
  licenseCovers: 'the template specification and every project generated from it',
  licenseText: TEMPLATE_LICENSE_TEXT,
  // No DOI is registered for the template. Cite the version and the generator instead; a
  // placeholder DOI would be worse than none, because it looks like a resolvable identifier.
  doi: null,
  citeAs: TEMPLATE_TITLE + ' ' + TEMPLATE_VERSION + ', generated by ' + TEMPLATE_GENERATOR.name + ' ' + TEMPLATE_GENERATOR.version,
  // The pinned runtime files this template version changed, printed in every
  // report: a project frozen before it pins different digests for exactly these
  // files and keeps its own runtime.
  changes: { pinnedFiles: ['analysis.mjs', 'cli.mjs', 'lean-codegen.mjs', 'report.mjs', 'study.mjs', 'templates.mjs'],
    summary: 'Template citation record and runtime identity; generated statistical methods, pre-registration, contamination, replicate dispersion, interval notes, limitations, checklist and references sections; primary-population headline and rounded abstract; Bonferroni family for design-arm contrasts; provenance registry citations corrected; optional citation field.' },
})
export async function templateIdentity(project) {
  const spec = project?.spec || project
  const files = runtimeFilesFor(spec)
  if (!object(spec?.runtimeSources) || !files.every(file => typeof spec.runtimeSources[file] === 'string')) return null
  return sha256(canonical({ format: 'research-benchmark-template-identity', version: 1, template: { id: TEMPLATE.id, version: TEMPLATE.version },
    schemaVersion: spec.schemaVersion, runtimeFiles: files, runtimeSources: Object.fromEntries(files.map(file => [file, spec.runtimeSources[file]])) }))
}
// The bibliography the template's own methods rest on. Every citation the
// report or the citation files print comes from this list; nothing is composed
// at render time. `verification` says whether the DOI or URL was re-resolved
// online when the entry was recorded; it never claims more than that.
const author = (family, given) => ({ family, given })
export const METHOD_REFERENCES = Object.freeze([
  { id: 'wilson-1927', type: 'article', authors: [author('Wilson', 'Edwin B.')], year: 1927, title: 'Probable inference, the law of succession, and statistical inference',
    container: 'Journal of the American Statistical Association', volume: '22', issue: '158', pages: '209-212', doi: '10.1080/01621459.1927.10502953', url: null,
    verification: 'Crossref API record confirmed by the citation verification log of 2026-09-10 (research-44/sub/stats/logs/citations-verified.md, row 1): title, author, year, journal, volume 22, issue 158, pages 209-212 and the DOI.',
    note: 'The score interval printed beside every proportion in this report.' },
  { id: 'brown-cai-dasgupta-2001', type: 'article', authors: [author('Brown', 'Lawrence D.'), author('Cai', 'T. Tony'), author('DasGupta', 'Anirban')], year: 2001, title: 'Interval estimation for a binomial proportion',
    container: 'Statistical Science', volume: '16', issue: '2', pages: '101-133', doi: '10.1214/ss/1009213286', url: null,
    verification: 'Crossref API record confirmed by the citation verification log of 2026-09-10 (research-44/sub/stats/logs/citations-verified.md, row 2): title, three authors, year, journal, volume 16, issue 2, pages 101-133 and the DOI; that log records the page range separately confirmed against the Project Euclid article page.',
    note: 'Recommends the Wilson score interval over the Wald interval; the reason no Wald interval is printed here.' },
  { id: 'efron-1979', type: 'article', authors: [author('Efron', 'Bradley')], year: 1979, title: 'Bootstrap methods: another look at the jackknife',
    container: 'The Annals of Statistics', volume: '7', issue: '1', pages: '1-26', doi: '10.1214/aos/1176344552', url: null,
    verification: 'Crossref record and the doi.org resolution to Project Euclid verified by the citation audit of 2026-09-11 (research-44/sub/cite/references.bib).',
    note: 'Origin of the bootstrap. The interval procedure here is this method applied to whole clusters.' },
  { id: 'efron-tibshirani-1993', type: 'book', authors: [author('Efron', 'Bradley'), author('Tibshirani', 'Robert J.')], year: 1993, title: 'An Introduction to the Bootstrap',
    container: 'Chapman and Hall', volume: null, issue: null, pages: null, doi: null, isbn: '0412042312', url: null,
    verification: 'Library of Congress MARC record (through Open Library) verified by the citation audit of 2026-09-11: New York, Chapman and Hall, 1993, Monographs on Statistics and Applied Probability 57, ISBN 0412042312.',
    note: 'Percentile interval construction (chapter 13); the interpolated quantile rule is Hyndman and Fan definition 7.' },
  { id: 'diciccio-efron-1996', type: 'article', authors: [author('DiCiccio', 'Thomas J.'), author('Efron', 'Bradley')], year: 1996, title: 'Bootstrap confidence intervals',
    container: 'Statistical Science', volume: '11', issue: '3', pages: '189-228', doi: '10.1214/ss/1032280214', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 through the research fetch layer (redirect to projecteuclid.org observed).',
    note: 'Coverage properties and limitations of percentile intervals; cited for the limitations section.' },
  { id: 'field-welsh-2007', type: 'article', authors: [author('Field', 'Christopher A.'), author('Welsh', 'Alan H.')], year: 2007, title: 'Bootstrapping clustered data',
    container: 'Journal of the Royal Statistical Society: Series B (Statistical Methodology)', volume: '69', issue: '3', pages: '369-390', doi: '10.1111/j.1467-9868.2007.00593.x', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11; the publisher refused an automated fetch from this lane on 2026-09-11.',
    note: 'Resampling whole clusters with replacement, the cluster bootstrap, as implemented for task families and declared factors.' },
  { id: 'davison-hinkley-1997', type: 'book', authors: [author('Davison', 'Anthony C.'), author('Hinkley', 'David V.')], year: 1997, title: 'Bootstrap Methods and their Application',
    container: 'Cambridge University Press', volume: null, issue: null, pages: null, doi: '10.1017/CBO9780511802843', isbn: '9780521574716', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 through the research fetch layer to the Cambridge Core book page (content sha256 db11bd8a66827833ef78562e05deb04ea6501e5b44de6e4b6b46e759087b3466); Crossref record also verified by the citation audit of 2026-09-11.',
    note: 'Resampling for hierarchical (clustered) data (section 3.8) and the percentile interval.' },
  { id: 'cameron-2008', type: 'article', authors: [author('Cameron', 'A. Colin'), author('Gelbach', 'Jonah B.'), author('Miller', 'Douglas L.')], year: 2008, title: 'Bootstrap-based improvements for inference with clustered errors',
    container: 'The Review of Economics and Statistics', volume: '90', issue: '3', pages: '414-427', doi: '10.1162/rest.90.3.414', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11 (references.bib); a doi.org resolution attempt from this lane on 2026-09-11 returned a non-success status.',
    note: 'Under-coverage of cluster bootstrap inference with few clusters; cited for the limitations section.' },
  { id: 'dunn-1961', type: 'article', authors: [author('Dunn', 'Olive Jean')], year: 1961, title: 'Multiple comparisons among means',
    container: 'Journal of the American Statistical Association', volume: '56', issue: '293', pages: '52-64', doi: '10.1080/01621459.1961.10482090', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11; the publisher answered this lane over plain HTTP on 2026-09-11, which the fetch layer refuses.',
    note: 'Bonferroni-corrected simultaneous intervals, applied when multiplicity is bonferroni. Bonferroni (1936) itself could not be verified on a primary or library record and is therefore not cited.' },
  { id: 'hyndman-fan-1996', type: 'article', authors: [author('Hyndman', 'Rob J.'), author('Fan', 'Yanan')], year: 1996, title: 'Sample quantiles in statistical packages',
    container: 'The American Statistician', volume: '50', issue: '4', pages: '361-365', doi: '10.1080/00031305.1996.10473566', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11; definition 7 confirmed against the R quantile documentation, not the scan of the paper.',
    note: 'Definition 7, linear interpolation at position (n-1)p, is the sample quantile used for the percentile endpoints.' },
  { id: 'durstenfeld-1964', type: 'article', authors: [author('Durstenfeld', 'Richard')], year: 1964, title: 'Algorithm 235: Random permutation',
    container: 'Communications of the ACM', volume: '7', issue: '7', pages: '420', doi: '10.1145/364520.364540', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11.',
    note: 'The in-place shuffle that orders the frozen schedule from the protocol seed.' },
  { id: 'mulberry32', type: 'software', authors: [author('Ettinger', 'Tommy')], year: 2017, title: 'mulberry32 (mulberry32.c), a 32-bit seeded pseudorandom generator',
    container: 'GitHub Gist, CC0 1.0', volume: null, issue: null, pages: null, doi: null, url: 'https://gist.github.com/tommyettinger/46a874533244883189143505d203312c',
    verification: 'Gist fetched online from this lane on 2026-09-11 through the research fetch layer (content sha256 185bf23d7fca09847a5b1ff054155843ea9b514964944131f8f32ca78cb957a1); the citation audit of 2026-09-11 read it: CC0 1.0 dedication, constant 0x6D2B79F5. Not peer reviewed; the notes published with it record statistical limitations.',
    note: 'The seeded generator behind the schedule shuffle and the bootstrap draws. Cited so the generator is named and the seed reproducible, not as a statistical-quality claim.' },
  { id: 'nosek-2018', type: 'article', authors: [author('Nosek', 'Brian A.'), author('Ebersole', 'Charles R.'), author('DeHaven', 'Alexander C.'), author('Mellor', 'David T.')], year: 2018, title: 'The preregistration revolution',
    container: 'Proceedings of the National Academy of Sciences', volume: '115', issue: '11', pages: '2600-2606', doi: '10.1073/pnas.1708274114', url: null,
    verification: 'Crossref record verified by the citation audit of 2026-09-11; the publisher refused an automated fetch from this lane.',
    note: 'What pre-registration fixes and why; the freeze plays that role here, self-attested.' },
  { id: 'dodge-2019', type: 'conference-paper', authors: [author('Dodge', 'Jesse'), author('Gururangan', 'Suchin'), author('Card', 'Dallas'), author('Schwartz', 'Roy'), author('Smith', 'Noah A.')], year: 2019, title: 'Show your work: Improved reporting of experimental results',
    container: 'Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing and the 9th International Joint Conference on Natural Language Processing (EMNLP-IJCNLP)', volume: null, issue: null, pages: '2185-2194', doi: '10.18653/v1/D19-1224', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 to the ACL Anthology page D19-1224 (content sha256 3a69cfaa5ac2a6196fb494c42b56ecbb0837bf8c7476366f619a48d54663428b).',
    note: 'Reporting results as distributions over repeated runs rather than a single best number.' },
  { id: 'reimers-gurevych-2017', type: 'conference-paper', authors: [author('Reimers', 'Nils'), author('Gurevych', 'Iryna')], year: 2017, title: 'Reporting score distributions makes a difference: Performance study of LSTM-networks for sequence tagging',
    container: 'Proceedings of the 2017 Conference on Empirical Methods in Natural Language Processing (EMNLP)', volume: null, issue: null, pages: '338-348', doi: '10.18653/v1/D17-1035', url: null,
    verification: 'ACL Anthology page D17-1035 fetched online from this lane on 2026-09-11 (content sha256 12eb7c6565fab6ae5cd81f9e412eb056d02427c0830f9e94fd33f566e5a7cc9c); the doi.org redirect answered over plain HTTP, which the fetch layer refuses.',
    note: 'Why dispersion across repeated runs belongs in the report.' },
  { id: 'bouthillier-2021', type: 'conference-paper', authors: [author('Bouthillier', 'Xavier'), author('Delaunay', 'Pierre'), author('Bronzi', 'Mirko'), author('Trofimov', 'Assya'), author('Nichyporuk', 'Brennan'), author('Szeto', 'Justin'), author('Sepah', 'Nazanin'), author('Raff', 'Edward'), author('Madan', 'Kanika'), author('Voleti', 'Vikram'), author('Kahou', 'Samira Ebrahimi'), author('Michalski', 'Vincent'), author('Arbel', 'Tal'), author('Pal', 'Christopher'), author('Varoquaux', 'Gaël'), author('Vincent', 'Pascal')], year: 2021, title: 'Accounting for variance in machine learning benchmarks',
    container: 'Proceedings of Machine Learning and Systems 3 (MLSys 2021)', volume: null, issue: null, pages: null, doi: null, url: 'https://arxiv.org/abs/2103.03098',
    verification: 'arXiv abstract page fetched online from this lane on 2026-09-11 through the research fetch layer (content sha256 6e3e82e7d03b2c24a740dab88566f583f3c84297b4d5cb6f7a0114dcacc50567).',
    note: 'Sources of variance in benchmark results and the case for repeated measurements.' },
  { id: 'miller-2024', type: 'article', authors: [author('Miller', 'Evan')], year: 2024, title: 'Adding error bars to evals: A statistical approach to language model evaluations',
    container: 'arXiv', volume: null, issue: null, pages: null, doi: null, url: 'https://arxiv.org/abs/2411.00640',
    verification: 'URL fetched online on 2026-09-11 through the research fetch layer (content sha256 951cac93eacd8adf7e184896a3ca3fb203e337e5d010dc18a915e1f72e2ac3d2); the citation audit of 2026-09-11 read section 2.2 (clustered questions).',
    note: 'Clustered standard errors by question and paired comparisons for language-model evaluations; the whole-cluster resampling here addresses the same dependence.' },
  { id: 'sainz-2023', type: 'conference-paper', authors: [author('Sainz', 'Oscar'), author('Campos', 'Jon Ander'), author('García-Ferrero', 'Iker'), author('Etxaniz', 'Julen'), author('de Lacalle', 'Oier Lopez'), author('Agirre', 'Eneko')], year: 2023, title: 'NLP evaluation in trouble: On the need to measure LLM data contamination for each benchmark',
    container: 'Findings of the Association for Computational Linguistics: EMNLP 2023', volume: null, issue: null, pages: null, doi: '10.18653/v1/2023.findings-emnlp.722', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 to the ACL Anthology page 2023.findings-emnlp.722 (content sha256 4983fc693e6034abaf2cb1b558a70c345ee701c672843e6b65d1fcf6ffc7ea0c).',
    note: 'Why contamination must be measured per benchmark; the template records what such a measurement needs and does not perform it.' },
  { id: 'jacovi-2023', type: 'conference-paper', authors: [author('Jacovi', 'Alon'), author('Caciularu', 'Avi'), author('Goldman', 'Omer'), author('Goldberg', 'Yoav')], year: 2023, title: 'Stop uploading test data in plain text: Practical strategies for mitigating data contamination by evaluation benchmarks',
    container: 'Proceedings of the 2023 Conference on Empirical Methods in Natural Language Processing (EMNLP)', volume: null, issue: null, pages: null, doi: '10.18653/v1/2023.emnlp-main.308', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 to the ACL Anthology page 2023.emnlp-main.308 (content sha256 43ea5e223909c106f7ecf317aa9eaff8704d470703c3571ee354ad52c1b3376c).',
    note: 'Practical contamination-mitigation strategies; held-out splits and withheld information are the ones this template can record.' },
  { id: 'pineau-2021', type: 'article', authors: [author('Pineau', 'Joelle'), author('Vincent-Lamarre', 'Philippe'), author('Sinha', 'Koustuv'), author('Larivière', 'Vincent'), author('Beygelzimer', 'Alina'), author("d'Alché-Buc", 'Florence'), author('Fox', 'Emily'), author('Larochelle', 'Hugo')], year: 2021, title: 'Improving reproducibility in machine learning research (a report from the NeurIPS 2019 reproducibility program)',
    container: 'Journal of Machine Learning Research', volume: '22', issue: '164', pages: '1-20', doi: null, url: 'https://jmlr.org/papers/v22/20-303.html',
    verification: 'JMLR page and its BibTeX record verified by the citation audit of 2026-09-11.',
    note: 'Source of the reproducibility checklist practice the report follows.' },
  { id: 'dehghani-2021', type: 'article', authors: [author('Dehghani', 'Mostafa'), author('Tay', 'Yi'), author('Gritsenko', 'Alexey A.'), author('Zhao', 'Zhe'), author('Houlsby', 'Neil'), author('Diaz', 'Fernando'), author('Metzler', 'Donald'), author('Vinyals', 'Oriol')], year: 2021, title: 'The benchmark lottery',
    container: 'arXiv', volume: null, issue: null, pages: null, doi: null, url: 'https://arxiv.org/abs/2107.07002',
    verification: 'arXiv abstract page fetched online from this lane on 2026-09-11 through the research fetch layer (content sha256 be40eb4115d5a6de8dfdc6ad1cd0c48832f67e01a25385711543cc3cf5ee0908).',
    note: 'Rankings depend on which tasks a benchmark happens to contain; cited for the task-selection limitation.' },
  { id: 'smith-2016', type: 'article', authors: [author('Smith', 'Arfon M.'), author('Katz', 'Daniel S.'), author('Niemeyer', 'Kyle E.')], year: 2016, title: 'Software citation principles',
    container: 'PeerJ Computer Science', volume: '2', issue: null, pages: 'e86', doi: '10.7717/peerj-cs.86', url: null,
    verification: 'DOI resolved online from this lane on 2026-09-11 through the research fetch layer (redirect to peerj.com observed); Crossref record also verified by the citation audit of 2026-09-11.',
    note: 'Why the template carries a version and a unique identity that every export and report repeats.' },
  { id: 'druskat-2021', type: 'software', authors: [author('Druskat', 'Stephan'), author('Spaaks', 'Jurriaan H.'), author('Chue Hong', 'Neil'), author('Haines', 'Robert'), author('Baker', 'James'), author('Bliven', 'Spencer'), author('Willighagen', 'Egon'), author('Pérez-Suárez', 'David'), author('Konovalov', 'Alexander')], year: 2021, title: 'Citation File Format (version 1.2.0)',
    container: 'Zenodo', volume: null, issue: null, pages: null, doi: '10.5281/zenodo.5171937', url: 'https://citation-file-format.github.io/',
    verification: 'Zenodo record and DataCite DOI record verified by the citation audit of 2026-09-11.',
    note: 'The machine-readable citation format written as CITATION.cff.' },
])
export function methodReference(id) {
  const entry = METHOD_REFERENCES.find(row => row.id === id)
  invariant(entry, 'No method reference: ' + id + '. Every citation printed into a report or citation file must come from the registry.')
  return entry
}
// One plain-text citation line per registry entry, the same in every artifact.
export function referenceText(entry) {
  const names = entry.authors.map(person => person.family + ', ' + person.given.split(/\s+/).map(part => part[0] + '.').join(' ')).join(', ')
  const where = entry.type === 'book' ? entry.container : entry.type === 'software' ? entry.container : entry.container
  const locator = [entry.volume ? entry.volume + (entry.issue ? '(' + entry.issue + ')' : '') : '', entry.pages ? entry.pages : ''].filter(Boolean).join(', ')
  const tail = [entry.doi ? 'doi:' + entry.doi : '', entry.isbn ? 'ISBN ' + entry.isbn : '', entry.url && !entry.doi ? entry.url : ''].filter(Boolean).join(' ')
  return names + ' (' + entry.year + '). ' + entry.title + '. ' + where + (locator ? ', ' + locator : '') + '.' + (tail ? ' ' + tail : '')
}
const yaml = value => JSON.stringify(String(value))
const bib = value => String(value).replace(/[\\{}%&$#_^~]/g, char => char === '\\' ? '\\textbackslash{}' : char === '^' ? '\\textasciicircum{}' : char === '~' ? '\\textasciitilde{}' : '\\' + char)
const bibKey = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
function referenceCff(entry, indent) {
  const pad = ' '.repeat(indent), lines = [pad + '- type: ' + ({ article: 'article', book: 'book', 'conference-paper': 'conference-paper', software: 'software' })[entry.type],
    pad + '  title: ' + yaml(entry.title), pad + '  authors:']
  for (const person of entry.authors) lines.push(pad + '    - family-names: ' + yaml(person.family), pad + '      given-names: ' + yaml(person.given))
  lines.push(pad + '  year: ' + entry.year)
  if (entry.type === 'article') lines.push(pad + '  journal: ' + yaml(entry.container))
  else if (entry.type === 'conference-paper') lines.push(pad + '  collection-title: ' + yaml(entry.container))
  else if (entry.type === 'book') lines.push(pad + '  publisher:', pad + '    name: ' + yaml(entry.container))
  else lines.push(pad + '  notes: ' + yaml('Published at ' + entry.container))
  if (entry.volume) lines.push(pad + '  volume: ' + yaml(entry.volume))
  if (entry.issue) lines.push(pad + '  issue: ' + yaml(entry.issue))
  if (entry.pages && /^\d+-\d+$/.test(entry.pages)) { const [start, end] = entry.pages.split('-'); lines.push(pad + '  start: ' + start, pad + '  end: ' + end) }
  if (entry.doi) lines.push(pad + '  doi: ' + yaml(entry.doi))
  if (entry.isbn) lines.push(pad + '  isbn: ' + yaml(entry.isbn))
  if (entry.url) lines.push(pad + '  url: ' + yaml(entry.url))
  return lines
}
function referenceBibtex(entry) {
  const kind = { article: 'article', book: 'book', 'conference-paper': 'inproceedings', software: 'misc' }[entry.type]
  const fields = [['author', entry.authors.map(person => person.family + ', ' + person.given).join(' and ')], ['title', entry.title], ['year', String(entry.year)]]
  if (entry.type === 'article') fields.push(['journal', entry.container])
  else if (entry.type === 'conference-paper') fields.push(['booktitle', entry.container])
  else if (entry.type === 'book') fields.push(['publisher', entry.container])
  else fields.push(['howpublished', entry.container])
  if (entry.volume) fields.push(['volume', entry.volume])
  if (entry.issue) fields.push(['number', entry.issue])
  if (entry.pages) fields.push(['pages', entry.pages.replace('-', '--')])
  if (entry.doi) fields.push(['doi', entry.doi])
  if (entry.isbn) fields.push(['isbn', entry.isbn])
  if (entry.url) fields.push(['url', entry.url])
  return '@' + kind + '{' + bibKey(entry.id) + ',\n' + fields.map(([key, value]) => '  ' + key + ' = {' + bib(value) + '}').join(',\n') + '\n}\n'
}
// The method references a frozen project's analysis actually rests on. The
// schedule shuffle and its generator apply to every project; the rest follow
// the frozen plan, so a descriptive study cites no interval paper.
export function methodReferencesFor(project) {
  const plan = project.spec.analysisPlan || null, ids = ['durstenfeld-1964', 'mulberry32']
  if (plan?.uncertainty) ids.push('efron-1979', 'efron-tibshirani-1993', 'field-welsh-2007', 'davison-hinkley-1997', 'hyndman-fan-1996', 'wilson-1927', 'brown-cai-dasgupta-2001')
  if (plan?.multiplicity === 'bonferroni') ids.push('dunn-1961')
  return ids.map(methodReference)
}
export async function templateCitation(project) {
  invariant(project?.format === 'research-benchmark' && object(project.spec) && typeof project.sha256 === 'string', 'A citation needs a frozen benchmark project.')
  const spec = project.spec, declared = spec.citation || null, identity = await templateIdentity(project), methods = methodReferencesFor(project)
  const authors = declared ? declared.authors : [{ name: 'Not declared (this frozen project has no citation.authors field)' }]
  const title = declared?.title || spec.name
  const replicates = spec.protocol?.replicates ?? 1
  const abstract = spec.name + ' is a ' + (spec.domain || 'generic') + ' benchmark of ' + spec.tasks.length + ' task' + (spec.tasks.length === 1 ? '' : 's') + ' under ' + spec.conditions.length + ' condition' + (spec.conditions.length === 1 ? '' : 's')
    + ' with ' + replicates + ' replicate' + (replicates === 1 ? '' : 's') + ' per cell, frozen and executed with the ' + TEMPLATE.title + ' ' + TEMPLATE.version + '.'
  const templateNotes = 'Generic benchmark template: frozen specification, pinned portable runtime, deterministic analysis and report. Specification: ' + TEMPLATE.specification + ' in the generator repository. Generated by ' + TEMPLATE.generator.name + ' ' + TEMPLATE.generator.version + '.'
    + (identity ? ' Template runtime identity sha256:' + identity + '.' : ' This project pins no runtime sources, so no runtime identity is claimed.')
  // A26: the template's own author, licence and citation form. Built once so CITATION.cff,
  // CITATION.bib and the report cannot drift from each other.
  const templateCredit = 'Template author: ' + TEMPLATE.author + '. ' + TEMPLATE.aiStatement
    + ' Licence: ' + TEMPLATE.license + ', covering ' + TEMPLATE.licenseCovers + '.'
    + ' No DOI is registered for the template; cite ' + TEMPLATE.citeAs + '.'
  const cff = ['cff-version: 1.2.0', 'message: ' + yaml('Cite this frozen study by its project digest, and cite the template it was generated from (listed under references).'),
    'type: software', 'title: ' + yaml(title), 'authors:']
  for (const person of authors) {
    cff.push('  - name: ' + yaml(person.name))
    if (person.affiliation !== undefined) cff.push('    affiliation: ' + yaml(person.affiliation))
    if (person.orcid !== undefined) cff.push('    orcid: ' + yaml('https://orcid.org/' + person.orcid))
  }
  cff.push('identifiers:', '  - type: other', '    value: ' + yaml('sha256:' + project.sha256), '    description: ' + yaml('Frozen research benchmark project: SHA-256 over its canonical JSON (project.json)'))
  if (identity) cff.push('  - type: other', '    value: ' + yaml('sha256:' + identity), '    description: ' + yaml('Template runtime identity: ' + TEMPLATE.id + ' ' + TEMPLATE.version + ' over the pinned runtime sources'))
  if (declared?.doi) cff.push('doi: ' + yaml(declared.doi))
  if (declared?.url) cff.push('url: ' + yaml(declared.url))
  cff.push('abstract: ' + yaml(abstract + (declared?.note ? ' ' + declared.note : '')))
  cff.push('references:', '  - type: software', '    title: ' + yaml(TEMPLATE.title), '    version: ' + yaml(TEMPLATE.version), '    authors:',
    '      - name: ' + yaml(TEMPLATE.author), '      - name: ' + yaml(TEMPLATE.publisher),
    '    license: ' + TEMPLATE.license,
    '    url: ' + yaml(TEMPLATE.url), '    notes: ' + yaml(templateNotes + ' ' + templateCredit))
  for (const entry of methods) cff.push(...referenceCff(entry, 2))
  const studyKey = bibKey(spec.id) + '-' + project.sha256.slice(0, 12)
  const bibtex = ['@software{' + bibKey(TEMPLATE.id) + '-' + bibKey(TEMPLATE.version) + ',',
    '  title = {' + bib(TEMPLATE.title) + '},', '  author = {' + bib(TEMPLATE.author) + '},',
    '  publisher = {{' + bib(TEMPLATE.publisher) + '}},', '  version = {' + bib(TEMPLATE.version) + '},',
    '  license = {' + bib(TEMPLATE.license) + '},', '  url = {' + bib(TEMPLATE.url) + '},',
    '  note = {' + bib(templateNotes + ' ' + templateCredit) + '}', '}', '',
    '@misc{' + studyKey + ',', '  title = {' + bib(title) + '},', '  author = {' + authors.map(person => '{' + bib(person.name) + '}').join(' and ') + '},',
    ...(declared?.year ? ['  year = {' + declared.year + '},'] : []), ...(declared?.doi ? ['  doi = {' + bib(declared.doi) + '},'] : []), ...(declared?.url ? ['  url = {' + bib(declared.url) + '},'] : []),
    '  howpublished = {' + bib('Frozen research benchmark project sha256:' + project.sha256) + '},',
    '  note = {' + bib('Generated with the ' + TEMPLATE.title + ' ' + TEMPLATE.version + (identity ? '; template runtime identity sha256:' + identity : '') + '. ' + abstract + (declared?.note ? ' ' + declared.note : '')) + '}', '}', '',
    ...methods.map(referenceBibtex)]
  return { identity, credit: templateCredit, template: { ...TEMPLATE, generator: { ...TEMPLATE.generator } }, generator: { ...TEMPLATE.generator }, authors, title, methods: methods.map(entry => entry.id), cff: cff.join('\n') + '\n', bibtex: bibtex.join('\n') }
}
export async function templateCitationFiles(project) {
  const citation = await templateCitation(project)
  return { 'CITATION.cff': citation.cff, 'CITATION.bib': citation.bibtex }
}
export async function bindRuntimeSources(spec, sources) {
  const copy = structuredClone(spec)
  // Bind the inventory this spec's schema version ships, not whatever this build
  // ships. Binding the current list onto an older spec produced a project whose
  // pinned sources and whose compiled runtimeFiles disagreed, which readiness
  // then refused as an incomplete pin.
  const inventory = modernSchema(copy) ? runtimeFilesForVersion(copy.schemaVersion) : RUNTIME_FILES
  copy.runtimeSources = Object.fromEntries(await Promise.all(inventory.map(async file => {
    invariant(typeof sources[file] === 'string', `The portable runtime is missing ${file}.`)
    return [file, await sha256(sources[file])]
  })))
  return copy
}
const ID = /^[a-z][a-z0-9_-]{0,63}$/
// Study identity is two separate fields, and a refusal has to say which one it
// is about. The identifier is the slug that names the export, the npm package
// and every file path; the study version is the investigator's own release
// number for the study, and that is the part a citation must carry, because a
// citation has to resolve to one exact release (Smith, Katz, Niemeyer and the
// FORCE11 Software Citation Working Group, "Software Citation Principles",
// PeerJ Computer Science 2:e86, 2016, doi:10.7717/peerj-cs.86 - its Unique
// Identification and Specificity principles). A dot cannot go in the
// slug, so the two cannot be one string, and saying exactly that is the whole
// content of the refusal below.
export function identifierProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Give the benchmark a lowercase identifier, for example lean-bench-1-0-44.'
  if (ID.test(value)) return null
  const candidate = value.trim().toLowerCase().replace(/[.\s]+/g, '-').replace(/^[^a-z]+/, '')
  const instead = ID.test(candidate) ? ` Write ${candidate} instead.` : ''
  if (value.includes('.')) return `An identifier cannot contain a dot, so ${value} is refused.${instead} A dotted number belongs in Study version, which is where 1.0.44 goes.`
  if (/\s/.test(value)) return `An identifier cannot contain a space, so ${value} is refused.${instead}`
  if (/[A-Z]/.test(value)) return `An identifier is lowercase, so ${value} is refused.${instead}`
  if (value.length > 64) return `An identifier is at most 64 characters, and ${value.length} were given.`
  if (!/^[a-z]/.test(value)) return `An identifier starts with a lowercase letter a-z, so ${value} is refused.${instead}`
  const rejected = [...new Set([...value].filter(character => !/[a-z0-9_-]/.test(character)))]
  return `An identifier uses lowercase letters, digits, hyphens and underscores. Remove ${rejected.join(' ')} from ${value}.${instead}`
}
// Semantic Versioning 2.0.0 (Preston-Werner, https://semver.org/spec/v2.0.0.html),
// and this grammar rather than a looser one because the exported package.json
// "version" is read by npm, which accepts exactly this. The expression is the
// one that specification's own FAQ publishes.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
// The page shows these sentences beside the field. They are the rules
// normalizeStudyVersion applies, in the order it applies them, so what the
// investigator reads and what the compiler does cannot drift apart.
export const STUDY_VERSION_RULES = [
  'Spaces around the version are removed.',
  'One leading v or V is removed, so v1.0.44 becomes 1.0.44.',
  'A leading dot is read as a zero, the way .44 means 0.44, so .44 becomes 0.44.0. Type 1.0.44 in full for the 1.0 series.',
  'One or two numbers are completed with zeros on the right, so 44 becomes 44.0.0 and 1.0 becomes 1.0.0.',
  'The completed version must read MAJOR.MINOR.PATCH, each number without a leading zero, with an optional -prerelease and +build (Semantic Versioning 2.0.0).',
]
export function normalizeStudyVersion(value) {
  if (value === undefined || value === null) return undefined
  invariant(typeof value === 'string', 'The study version must be text.')
  let text = value.trim()
  if (text[0] === 'v' || text[0] === 'V') text = text.slice(1)
  if (text[0] === '.') text = '0' + text
  if (!text) return undefined
  const parts = text.split('.')
  if (parts.length <= 3 && parts.every(part => /^\d+$/.test(part))) {
    while (parts.length < 3) parts.push('0')
    return parts.join('.')
  }
  return text
}
export function studyVersionProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Give the study a version, for example 1.0.44, or leave the field empty to declare none.'
  const text = value.trim()
  if (SEMVER.test(text)) return null
  if (/\s/.test(text)) return `A study version cannot contain a space, so ${text} is refused. Words go after a hyphen, as 1.0.44-beta.`
  const parts = text.split(/[-+]/)[0].split('.')
  if (parts.length > 3) return `A study version has three numbers, MAJOR.MINOR.PATCH, and ${text} gives ${parts.length}. Put the rest after a hyphen, as 1.0.44-2.`
  if (parts.some(part => /^0\d/.test(part))) return `A study version number cannot start with a zero, so ${text} is refused. Write ${parts.map(part => part.replace(/^0+(?=\d)/, '')).join('.')} instead.`
  return `A study version reads MAJOR.MINOR.PATCH, for example 1.0.44, with an optional -prerelease and +build. ${text} does not.`
}
export const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
function declaredFields(value, allowed, label) {
  invariant(object(value), label + ' must be an object.')
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  invariant(!unknown.length, label + ' contains unsupported fields: ' + unknown.join(', ') + '.')
}
function validateCorpusGeneration(value) {
  declaredFields(value, ['recipeSha256', 'choices', 'constructionSha256'], 'Corpus generation provenance')
  invariant(['recipeSha256', 'constructionSha256'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key])), 'Corpus generation provenance needs recipe and construction SHA-256 bindings.')
  invariant(object(value.choices) && Object.entries(value.choices).every(([axis, choice]) => ID.test(axis) && typeof choice === 'string' && ID.test(choice)), 'Corpus generation choices must map lowercase axis identifiers to lowercase choice identifiers.')
}
// Schema 2 and later; the name is kept because these are the fields schema 2
// introduced.
function validateVersionTwoWorkflowResponses(spec) {
  if (!modernSchema(spec)) return
  for (const condition of spec.conditions) {
    const adapter = condition.adapter
    if (adapter.workflowResponses === undefined) continue
    const workflow = spec.workflowPlan?.workflows?.find(row => row.id === condition.workflowId)
    invariant(adapter.kind === 'replay' && adapter.mode === 'envelope' && workflow, 'Recorded workflow responses require this condition to select a frozen workflow in replay envelope mode.')
    invariant(object(adapter.workflowResponses), 'Recorded workflow responses must map task IDs to stage envelopes.')
    // Like ordinary replay responses, a saved pool may contain tasks outside
    // the selected schedule. Only the frozen task/stage dispatch is consumed.
    for (const [taskId, stages] of Object.entries(adapter.workflowResponses)) {
      invariant(ID.test(taskId) && object(stages), 'Recorded workflow responses must use lowercase task IDs and contain stage envelope maps.')
      for (const [stageId, envelope] of Object.entries(stages)) {
        invariant(workflow.stages.some(stage => stage.id === stageId) && object(envelope), 'Recorded workflow responses must name stages in the selected workflow and contain JSON envelopes.')
        canonical(envelope)
      }
    }
  }
}
function validateVersionTwoFields(spec) {
  if (!modernSchema(spec)) return
  declaredFields(spec, ['schemaVersion', 'executionPlan', 'id', 'name', 'version', 'domain', 'leanProfile', 'requireReview', 'catalog', 'tasks', 'conditions', 'protocol', 'inputs', 'environment', 'analysisPlan', 'observationPlan', 'requirementPlan', 'nativePreparationPlan', 'workflowPlan', 'corpusPlan', 'corpusHistory', 'auditPlan', 'experimentTemplate', 'designPlan', 'decisions', 'reviews', 'taskReviews', 'auditReviews', 'runtimeSources', 'generator', 'citation', 'pricing'], `Version ${spec.schemaVersion} study`)
  if (spec.generator !== undefined) {
    declaredFields(spec.generator, ['name', 'version'], 'Recorded generator')
    invariant(['name', 'version'].every(key => typeof spec.generator[key] === 'string' && spec.generator[key].trim()),
      'The recorded generator needs a name and a version.')
  }
  if (spec.corpusHistory !== undefined) {
    invariant(Array.isArray(spec.corpusHistory), 'Corpus history must be an array of detached recipe provenance.')
    for (const history of spec.corpusHistory) {
      declaredFields(history, ['kind', 'recipe'], 'Corpus history')
      invariant(history.kind === 'detached-recipe', 'Corpus history records detached-recipe provenance only.')
      validateCorpusPlan(history.recipe)
    }
  }
  declaredFields(spec.protocol, ['seed', 'replicates', 'maxAttemptsPerTrial', 'maxTotalAttempts', 'timeoutMs', 'maxDurationMs', 'grading', 'selection', 'stopping', 'analysis'], 'Protocol')
  // Historical prose remains readable in schema 1. In schema 2 these optional
  // descriptions can only name the existing mechanics; a narrative or object
  // must not promise an unimplemented stopping rule, selection or estimator.
  // The typed analysisPlan separately governs the primary endpoint and any
  // uncertainty calculation; the descriptive completed-score table remains.
  const descriptions = {
    selection: 'All frozen tasks; first completed attempt. Transport failures alone may retry.',
    stopping: 'Stop at the fixed attempt or elapsed-time budget.',
    analysis: 'Per-condition scores over completed trials; report scheduled, failed, interrupted, and pending counts separately.',
  }
  for (const [key, description] of Object.entries(descriptions)) if (Object.hasOwn(spec.protocol, key))
    invariant(spec.protocol[key] === description, 'Protocol ' + key + ' contains an unsupported policy. Omit this legacy description or retain the exact generated text; use the supported typed design and analysis fields for executable choices.')
  const grading = spec.protocol.grading
  // WHICH FIELDS A GRADING CONTRACT CARRIES IS A REGISTRATION TOO. 'file'
  // belongs to the core's own `module` contract; 'executionTimeoutMs' was a
  // vertical's, spelled here as a literal, so a third-party contract could
  // declare no configuration of its own without being refused as an
  // unsupported field. Core fields stay here; a benchmark's come from whoever
  // registered it.
  declaredFields(grading, ['kind', ...(grading?.kind === 'module' ? ['file'] : gradingKind(grading?.kind)?.fields || [])], 'Grading contract')
  for (const condition of spec.conditions || []) {
    declaredFields(condition, ['id', 'label', 'model', 'adapter', 'collection', 'workflowId'], 'Condition')
    if (condition.model !== undefined) declaredFields(condition.model, ['provider', 'id', 'version', 'surface', 'fingerprint', 'settings'], 'Requested model')
    const adapter = condition.adapter, fields = { replay: ['mode', 'responses', 'workflowResponses'], http: ['url', 'credentialEnv'], command: ['command', 'args', 'env', 'credentialEnv'], module: ['file', 'env', 'credentialEnv'] }
    declaredFields(adapter, ['kind', ...(fields[adapter?.kind] || [])], 'Adapter')
    if (condition.collection !== undefined) {
      declaredFields(condition.collection, ['comparisonUnit', 'instructions', 'tools', 'contextConstruction', 'sessionIsolation'], 'Collection controls')
      declaredFields(condition.collection.instructions, ['system', 'developer'], 'Requested instructions')
    }
  }
  const references = []
  for (const task of [...(spec.tasks || []), ...(spec.corpusPlan?.pool?.tasks || [])]) {
    declaredFields(task, ['id', 'root', 'input', 'expected', 'split', 'familyId', 'factors', 'cohort', 'variables', 'information', 'audit', 'resource', 'generation', 'origin', 'provenance', 'variance', 'promptOmissions'], 'Task')
    if (task.variance !== undefined) {
      const variance = task.variance
      declaredFields(variance, ['version', 'study', 'studyId', 'source', 'sourceSha256', 'arm', 'sections'], 'Prompt variance provenance')
      invariant(variance.version === 1 && ID.test(variance.studyId) && typeof variance.study === 'string' && variance.study.trim() && variance.study.length <= 80
        && typeof variance.arm === 'string' && variance.arm.trim() && variance.arm.length <= 200 && /^[a-f0-9]{64}$/.test(variance.sourceSha256), 'Prompt variance provenance needs its named study, arm and original prompt fingerprint.')
      declaredFields(variance.source, ['kind', 'id'], 'Variance source')
      invariant(['snippet', 'composition', 'task'].includes(variance.source.kind) && typeof variance.source.id === 'string' && variance.source.id.trim(), 'Name the source of this prompt variance.')
      invariant(Array.isArray(variance.sections) && variance.sections.length <= 128, 'Prompt variance provenance supports up to 128 selected sections.')
      for (const section of variance.sections) {
        declaredFields(section, ['id', 'label', 'scope', 'target'], 'Variance section provenance')
        invariant(ID.test(section.id) && typeof section.label === 'string' && section.label.trim() && section.label.length <= 120
          && ['occurrence', 'matching'].includes(section.scope) && typeof section.target === 'string' && section.target.trim(), 'Variance sections need their label, scope and selected occurrence.')
      }
    }
    if (task.provenance !== undefined) {
      declaredFields(task.provenance, ['originalPromptPath'], 'Task provenance')
      invariant(safePath(task.provenance.originalPromptPath) && spec.inputs?.some(input => input.path === task.provenance.originalPromptPath), 'Original task wording needs a safe path in the pinned input manifest.')
    }
    if (task.generation !== undefined) {
      invariant(spec.corpusPlan !== undefined, 'Generated task metadata requires its attached task recipe; detach it into provenance before authoring tasks.')
      validateCorpusGeneration(task.generation)
    }
    if (task.origin !== undefined) {
      declaredFields(task.origin, ['kind', 'generation'], 'Task origin')
      invariant(task.origin.kind === 'detached-corpus', 'Task origin records detached-corpus provenance only.')
      validateCorpusGeneration(task.origin.generation)
    }
    references.push(task.root)
    for (const reading of task.information?.readings || task.information?.readingPool || []) references.push(reading.root)
  }
  for (const root of references) {
    const pending = [{ ref: root, depth: 0 }]
    while (pending.length) {
      const { ref, depth } = pending.pop()
      invariant(depth <= 128, 'A task reference exceeds the supported nesting depth.')
      declaredFields(ref, ['use', 'params', 'slots', 'variables', 'promptOmissions'], 'Task reference')
      for (const child of Object.values(ref.slots || {})) pending.push({ ref: child, depth: depth + 1 })
    }
  }
}
// Optional authorship for the study's own citation record. Absent fields print
// "Not declared" in CITATION.cff and the report; nothing is guessed.
const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/
function validateCitation(spec) {
  if (spec.citation === undefined) return
  invariant(modernSchema(spec), `Citation fields require specification version 2 or later.`)
  declaredFields(spec.citation, ['authors', 'title', 'year', 'doi', 'url', 'note'], 'Citation')
  const citation = spec.citation, text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
  invariant(Array.isArray(citation.authors) && citation.authors.length >= 1 && citation.authors.length <= 64, 'Citation authors must list 1-64 people or organisations.')
  for (const person of citation.authors) {
    declaredFields(person, ['name', 'affiliation', 'orcid'], 'Citation author')
    invariant(text(person.name, 200), 'Each citation author needs a name of at most 200 characters.')
    invariant(person.affiliation === undefined || text(person.affiliation, 300), 'A citation affiliation is text of at most 300 characters.')
    invariant(person.orcid === undefined || (typeof person.orcid === 'string' && ORCID.test(person.orcid)), 'An ORCID iD is written as 0000-0000-0000-000X.')
  }
  invariant(citation.title === undefined || text(citation.title, 500), 'A citation title is text of at most 500 characters.')
  invariant(citation.year === undefined || integer(citation.year, 1900, 2100), 'A citation year is a four-digit year between 1900 and 2100.')
  invariant(citation.doi === undefined || (typeof citation.doi === 'string' && /^10\.\d{4,9}\/\S+$/.test(citation.doi)), 'A DOI starts with 10. and a registrant code, without a URL prefix.')
  invariant(citation.url === undefined || (typeof citation.url === 'string' && citation.url.startsWith('https://')), 'A citation URL uses https.')
  invariant(citation.note === undefined || text(citation.note, 1000), 'A citation note is text of at most 1000 characters.')
}
export function validateStudy(spec) {
  invariant(object(spec) && SUPPORTED_SCHEMA_VERSIONS.includes(spec.schemaVersion), `This builder reads benchmark specification versions ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`)
  validateExecutionPlan(spec)
  validateVersionTwoFields(spec)
  validateCitation(spec)
  invariant(typeof spec.name === 'string' && spec.name.trim(), 'Give the benchmark a name.')
  const identifier = identifierProblem(spec.id)
  invariant(!identifier, identifier)
  if (spec.version !== undefined) {
    invariant(modernSchema(spec), `A study version belongs to a version 2 study or later, and this one declares version ${spec.schemaVersion}.`)
    invariant(typeof spec.version === 'string', 'The study version must be text.')
    const normalized = normalizeStudyVersion(spec.version)
    invariant(spec.version === normalized, `Store the normalized study version ${JSON.stringify(normalized ?? '')} rather than ${JSON.stringify(spec.version)}.`)
    const problem = studyVersionProblem(spec.version)
    invariant(!problem, problem)
  }
  // 'generic' is the core's own domain; every other domain belongs to whichever
  // benchmark registered it. A literal allowlist here refused a third party's
  // study before any of its code ran, whatever else the core had been opened up.
  invariant(spec.domain === 'generic' || isRegisteredDomain(spec.domain),
    `Choose the generic domain or a registered benchmark domain${registeredDomains().length ? ' (' + registeredDomains().join(', ') + ')' : ''}.`)
  // Which profiles a study may declare belongs to the benchmark that owns the
  // domain, not to a literal list here. A generic study owns none and may set no
  // profile, exactly as before.
  invariant(spec.leanProfile === undefined || (benchmarkForDomain(spec.domain)?.profiles || []).includes(spec.leanProfile), 'Choose an explicit supported Lean profile; existing studies keep their synchronous constitution.')
  if (spec.domain === 'lean-bench') invariant(spec.requireReview === true, 'Lean Bench requires current personal bundle reviews before freezing. Draft previews remain available without approval.')
  if (spec.corpusPlan !== undefined) validateCorpusPlan(spec.corpusPlan)
  if (spec.requirementPlan !== undefined) validateRequirementPlan(spec.requirementPlan)
  validateNativePreparationPlan(spec)
  if (spec.auditPlan !== undefined) {
    validateAuditPlan(spec.auditPlan)
    invariant(spec.domain === 'generic' && !spec.corpusPlan && spec.protocol?.grading?.kind === 'judge-audit', 'A judge audit has its own case recipe and judge grading; source trading semantics remain in the reference bundle.')
    if (spec.auditPlan.provenance.kind === 'external-benchmark') invariant(spec.requireReview === true, 'External benchmark audits require current personal review of their reconstructed criteria and case packets.')
    invariant(spec.analysisPlan?.primaryPopulation === 'reference-eligible', 'Declare the judge audit analysis population as reference-eligible before freezing.')
  }
  invariant(Array.isArray(spec.tasks) && spec.tasks.length && spec.tasks.length <= 512, 'Declare 1–512 tasks before freezing.')
  invariant(Array.isArray(spec.conditions) && spec.conditions.length && spec.conditions.length <= 32, 'Declare 1–32 conditions.')
  for (const [label, rows] of [['task', spec.tasks], ['condition', spec.conditions]]) {
    const seen = new Set()
    for (const row of rows) {
      invariant(ID.test(row.id) && !seen.has(row.id), `Every ${label} needs a distinct lowercase identifier.`)
      seen.add(row.id)
    }
  }
  const protocol = spec.protocol
  invariant(object(protocol) && integer(protocol.seed, 0, 0xffffffff), 'Set a nonnegative 32-bit schedule seed.')
  invariant(integer(protocol.replicates, 1, 100), 'Set 1–100 replicates.')
  invariant(integer(protocol.maxAttemptsPerTrial, 1, 10), 'Set 1–10 attempts per trial.')
  invariant(integer(protocol.maxTotalAttempts, 1, 100000), 'Set a total attempt budget between 1 and 100,000.')
  invariant(integer(protocol.timeoutMs, 1, 3600000), 'Set a per-attempt timeout between 1 ms and one hour.')
  invariant(integer(protocol.maxDurationMs, 1, 86400000), 'Set a study time budget between 1 ms and one day.')
  // WHICH GRADING CONTRACTS EXIST IS A REGISTRATION, NOT A LIST HERE.
  // This was a literal six-name allowlist with a vertical's own contract inside
  // it ('lean-python'), which refused a third party's declared contract at
  // freeze before any of its code ran -- data, not an import, so no import
  // inventory could see it. Core contracts come from CORE_GRADING_KINDS; a
  // benchmark's come from whoever registered it.
  const gradingContract = gradingKind(protocol.grading?.kind)
  invariant(gradingContract, 'Choose a supported built-in or custom grading contract.')
  invariant(protocol.grading.kind !== 'resource-action-plan' || !!spec.experimentTemplate, 'Resource execution requires its generated experiment template.')
  invariant(protocol.grading.kind !== 'judge-audit' || !!spec.auditPlan, 'Judge grading requires a frozen audit plan and reference bundle.')
  invariant(spec.tasks.every(task => !task.audit || spec.auditPlan), 'Audit task metadata requires its frozen audit plan.')
  // A benchmark's own grading contract belongs to that benchmark's own studies,
  // and its preconditions belong to whoever implemented it. The core used to
  // bind 'lean-python' to the 'lean-bench' domain with a literal and carry the
  // Docker-digest and timeout rules itself.
  if (gradingContract.benchmarkId) {
    const owner = benchmarkById(gradingContract.benchmarkId)
    invariant(benchmarkForDomain(spec.domain)?.id === gradingContract.benchmarkId,
      `${gradingContract.title} grading requires a ${owner?.label || gradingContract.benchmarkId} specification.`)
    gradingContract.assertReady?.(spec)
  }
  if (protocol.grading.kind === 'module') invariant(relativeFile(protocol.grading.file), 'The grader must be a relative .mjs project file.')
  invariant(spec.tasks.length * spec.conditions.length * protocol.replicates <= 10000, 'The frozen schedule is limited to 10,000 trials.')
  invariant(Array.isArray(spec.inputs), 'Declare the input manifest, even when it is empty.')
  for (const input of spec.inputs) {
    invariant(object(input) && safePath(input.path) && /^[a-f0-9]{64}$/.test(input.sha256), 'Each input needs a relative project path and SHA-256 digest.')
  }
  invariant(new Set(spec.inputs.map(input => input.path)).size === spec.inputs.length, 'Input paths must be unique.')
  if (spec.runtimeSources) invariant(object(spec.runtimeSources) && Object.entries(spec.runtimeSources).every(([file, digest]) => safePath(file) && /^[a-f0-9]{64}$/.test(digest)), 'Runtime source pins must be relative paths and SHA-256 digests.')
  const pinnedModule = file => invariant(spec.inputs.some(input => input.path === file), `Pin ${file} in the input manifest before freezing.`)
  if (spec.requirementPlan?.interpreters) {
    // `spec.domain === 'generic'` here meant "this study has no
    // benchmark-supplied oracle for a module pair to replace". As a spelling it
    // refused every third-party domain too -- while readiness records
    // `third-party-declared-apparatus`, which asks that very benchmark to
    // qualify its own interpreter. The rule is about the benchmark, not the name.
    invariant(!benchmarkSuppliesSemantics(spec.domain),
      `Qualification interpreter modules cannot replace the built-in counterpart ${benchmarkForDomain(spec.domain)?.label || spec.domain} supplies for this domain.`)
    const modules = spec.requirementPlan.interpreters
    for (const kind of ['reference', 'independent']) {
      invariant(relativeFile(modules[kind]), 'Qualification interpreters must be relative .mjs project files.'); pinnedModule(modules[kind])
    }
    invariant(spec.inputs.find(input => input.path === modules.reference).sha256 !== spec.inputs.find(input => input.path === modules.independent).sha256,
      'Identical interpreter source bytes cannot establish an independent counterpart.')
  }
  if (protocol.grading.kind === 'module') pinnedModule(protocol.grading.file)
  for (const condition of spec.conditions) {
    const adapter = condition.adapter
    invariant(object(adapter) && ['replay', 'command', 'http', 'module'].includes(adapter.kind), `${condition.id}: choose a supported adapter.`)
    if (adapter.kind === 'replay') {
      invariant(object(adapter.responses), `${condition.id}: supply responses keyed by task identifier.`)
      invariant(adapter.mode === undefined || ['output', 'envelope'].includes(adapter.mode), 'Replay mode must be output or envelope.')
      invariant(adapter.mode !== 'envelope' || !!spec.observationPlan, 'Recorded envelopes require a frozen observation plan that declares their metadata mappings.')
    }
    if (adapter.kind === 'command') {
      invariant(typeof adapter.command === 'string' && adapter.command.trim(), `${condition.id}: name the command.`)
      invariant(Array.isArray(adapter.args) && adapter.args.every(arg => typeof arg === 'string'), `${condition.id}: command arguments must be an array of strings.`)
    }
    if (adapter.kind === 'http') {
      let url; try { url = new URL(adapter.url) } catch {}
      invariant(url?.protocol === 'https:' && !url.username && !url.password, `${condition.id}: use an HTTPS address without credentials.`)
    }
    if (adapter.kind === 'module') { invariant(relativeFile(adapter.file), `${condition.id}: the adapter must be a relative .mjs project file.`); pinnedModule(adapter.file) }
    invariant(!adapter.credentialEnv || /^[A-Z][A-Z0-9_]{0,99}$/.test(adapter.credentialEnv), 'Credentials are referenced by environment variable name.')
    invariant(!adapter.env || (Array.isArray(adapter.env) && adapter.env.every(name => /^[A-Z][A-Z0-9_]{0,99}$/.test(name))), 'The command environment allowlist contains variable names only.')
  }
  validateObservationPlan(spec)
  // A frozen price table is validated like every other frozen declaration, so a study
  // cannot carry rates without their provider, page, quoted line and retrieval date.
  if (spec.pricing !== undefined) validatePriceTable(spec.pricing)
  validateWorkflowPlan(spec)
  validateVersionTwoWorkflowResponses(spec)
  validateAnalysisPlan(spec)
  validateExperimentTemplate(spec)
  validateDesignPlan(spec)
  return spec
}
export function safePath(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 240 && !/[\\\x00-\x1f\x7f:<>"|?*]/.test(file)
    && file.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) && !file.startsWith('/')
}
function relativeFile(file) { return safePath(file) && file.endsWith('.mjs') }

function shuffle(rows, seed) {
  let state = seed >>> 0
  const random = () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]] }
  return rows
}
// Annotate the crossed schedule with the design plan: arm, draw unit, member
// index and phase. Trials outside a phase's factor levels are not scheduled;
// their identities are retained. Draws are shuffled as whole units with the
// protocol seed so the members of a draw stay adjacent.
function compileDesign(spec, tasks, schedule) {
  const plan = spec.designPlan, byId = new Map(tasks.map(task => [task.id, task]))
  const arms = plan.arms ? plan.arms.map(arm => ({ id: arm.id, conditionIds: [...arm.conditionIds], ...(arm.label !== undefined ? { label: arm.label } : {}) })) : spec.conditions.map(condition => ({ id: condition.id, conditionIds: [condition.id] }))
  const armOf = new Map(arms.flatMap(arm => arm.conditionIds.map(id => [id, arm.id])))
  const factor = plan.unit ? plan.unit.groupBy.slice(7) : null
  const phaseOf = replicate => { if (!plan.phases) return null; let upto = 0; for (const phase of plan.phases) { upto += phase.draws; if (replicate <= upto) return phase } return null }
  const memberIndex = new Map()
  if (factor !== null) { const seen = new Map(); for (const task of tasks) { const group = canonical(task.factors[factor]); seen.set(group, (seen.get(group) || 0) + 1); memberIndex.set(task.id, seen.get(group)) } }
  const excludedTrials = [], rows = []
  for (const row of schedule) {
    const task = byId.get(row.taskId), phase = phaseOf(row.replicate)
    if (phase?.factorLevels && !Object.entries(phase.factorLevels).every(([name, levels]) => levels.some(level => canonical(level) === canonical(task.factors?.[name])))) { excludedTrials.push(row.id); continue }
    const group = factor === null ? row.taskId : canonical(task.factors[factor])
    rows.push({ ...row, armId: armOf.get(row.conditionId), unitId: `${row.conditionId}/${group}/${row.replicate}`, unitGroup: group, memberIndex: factor === null ? 1 : memberIndex.get(row.taskId), ...(phase ? { phase: phase.id } : {}) })
  }
  const units = new Map()
  for (const row of rows) { if (!units.has(row.unitId)) units.set(row.unitId, []); units.get(row.unitId).push(row) }
  const ordered = shuffle([...units.values()], spec.protocol.seed).flatMap(members => members.sort((a, b) => a.memberIndex - b.memberIndex))
  return { schedule: ordered, design: { version: plan.version, arms, ...(plan.unit ? { unit: { ...plan.unit } } : {}), ...(plan.phases ? { phases: plan.phases.map(phase => ({ ...phase })) } : {}),
    ...(plan.contrasts ? { contrasts: plan.contrasts.map(contrast => ({ ...contrast })) } : {}), units: units.size, scheduled: ordered.length, excludedTrials } }
}
export async function materializeCorpus(spec, { enumerateOnly = false } = {}) {
  invariant(spec.corpusPlan, 'Supply a task recipe first.')
  if (spec.corpusPlan.fieldAuthoring) invariant(Array.isArray(spec.corpusPlan.fieldAuthoring.families)
    && spec.corpusPlan.fieldAuthoring.families.every(row => row?.expectedPolicy?.kind === (spec.domain === 'lean-bench' ? 'derive-lean' : 'reuse-base')),
    'Family field expected-answer provenance differs from this domain compiler.')
  return generateCorpus(spec.corpusPlan, spec.catalog, {
    enumerateOnly,
    ...(spec.domain === 'lean-bench' ? {
      resolveExpected: task => deriveTaskExpected(spec, task),
      // The benchmark names its own oracle; the core does not know which module
      // interprets a study. The fallback benchmark answers for studies that
      // declare none, which is what this line did literally before.
      oracle: { ...(benchmarkFor(spec)?.oracle?.(spec) || { kind: 'builtin-interpretation', source: null }), independentQualificationRequired: true },
    } : {}),
    prepareCandidate: async task => {
      const compiled = await compileTask(spec, task, { requireReview: false, requireTaskReview: false, validateExpected: !spec.corpusPlan.pool })
      return { task, semanticId: await semanticTaskId(spec.domain, compiled), composition: compiled.compiled.composition, promptSha256: compiled.compiled.promptSha256 }
    },
  })
}
async function compileStudy(spec, { checkReviews = true, stampGenerator = false } = {}) {
  validateStudy(spec)
  const snapshot = structuredClone(spec)
  // Recorded once, when a project is first frozen, and never rewritten after.
  // verifyProject rebuilds from project.spec and demands canonical equality, so a
  // project frozen by one release has to keep naming that release under every
  // later one, and a project frozen before this field existed has to keep
  // verifying without it.
  if (stampGenerator && modernSchema(snapshot) && snapshot.generator === undefined) {
    snapshot.generator = { name: GENERATOR.name, version: GENERATOR.version }
  }
  // R1220. A study that declares no cost convention of its own is frozen with the
  // committed, dated, cited price table, so its report can estimate at list prices
  // from the frozen bytes alone and the exported engine reaches the same numbers
  // without the application beside it. Attached on the same terms as the generator
  // above: only a real freeze attaches, a rebuild never does, and a study that
  // already carries a table or declares its own estimate is left exactly as it is.
  // The table is imported here rather than pinned as a runtime file because only a
  // freeze reads it; the export carries it as data inside the project.
  if (stampGenerator && modernSchema(snapshot) && snapshot.pricing === undefined
    && snapshot.observationPlan && !snapshot.observationPlan.costEstimate
    && !Object.values(snapshot.observationPlan?.overrides || {}).some(override => override?.costEstimate)) {
    const { default: prices } = await import('./model-prices.json', { with: { type: 'json' } })
    snapshot.pricing = structuredClone(prices)
    validatePriceTable(snapshot.pricing)
  }
  const experimentTemplate = await compileExperimentTemplate(snapshot)
  snapshot.protocol.grading = taskGradingContract(snapshot)
  for (const bundle of snapshot.catalog) if (bundle.kind === 'template') bundle.slotOrder ||= Object.keys(bundle.slots || {})
  let corpus, audit
  if (snapshot.corpusPlan) {
    const generated = await materializeCorpus(snapshot)
    invariant(generated.manifest.status === 'ready', `The generated corpus is ${generated.manifest.status}. Inspect its coverage and exclusion ledger before freezing.`)
    invariant(canonical(generated.tasks) === canonical(snapshot.tasks), 'The tasks differ from their task recipe. Regenerate them, or explicitly detach the recipe for a new authored task list.')
    corpus = { manifest: generated.manifest, sha256: generated.manifestSha256 }
  }
  if (snapshot.auditPlan) {
    const generated = await materializeAudit(snapshot.auditPlan)
    invariant(canonical(generated.tasks) === canonical(snapshot.tasks), 'The audit tasks differ from the source recipe. Regenerate audit cases before freezing.')
    audit = { manifest: generated.manifest, sha256: generated.sha256 }
  }
  const tasks = [], semanticIds = new Set()
  for (const task of snapshot.tasks) {
    invariant(['development', 'held-out'].includes(task.split), `${task.id}: declare development or held-out.`)
    const compiledTask = await compileTask(snapshot, task, { requireReview: checkReviews && snapshot.requireReview === true, requireTaskReview: checkReviews && snapshot.requireReview === true })
    const semanticId = await semanticTaskId(snapshot.domain, compiledTask)
    invariant(!semanticIds.has(semanticId), `${task.id}: duplicate semantic task. Use replicates for repeated measurements.`)
    semanticIds.add(semanticId)
    if (audit) {
      compiledTask.auditPacket = await auditReviewPacket({ spec: snapshot, audit }, compiledTask)
      invariant(!checkReviews || !snapshot.requireReview || auditReviewStatus(compiledTask, snapshot.auditReviews || []).approved, `${task.id}: review the complete current judge-audit packet before freezing.`)
    }
    tasks.push({ ...compiledTask, semanticId })
  }
  const requirements = await compileRequirementPlan(snapshot, tasks, { requireReview: checkReviews && snapshot.requireReview === true })
  const nativePreparation = await compileNativePreparationPlan(snapshot, requirements)
  const workflows = await compileWorkflows(snapshot)
  let schedule = []
  for (const task of tasks) for (const condition of snapshot.conditions) for (let replicate = 1; replicate <= snapshot.protocol.replicates; replicate++) {
    schedule.push({ id: `${task.id}.${condition.id}.${replicate}`, taskId: task.id, conditionId: condition.id, replicate })
  }
  let design = null
  if (snapshot.designPlan) ({ schedule, design } = compileDesign(snapshot, tasks, schedule))
  else shuffle(schedule, snapshot.protocol.seed)
  const primaryPopulation = modernSchema(snapshot) || object(snapshot.analysisPlan?.primaryPopulation) ? resolveAnalysisPopulation(snapshot) : null
  const project = { format: 'research-benchmark', version: snapshot.schemaVersion, spec: snapshot, tasks, schedule, ...(corpus ? { corpus } : {}), ...(audit ? { audit } : {}), ...(requirements ? { requirements } : {}), ...(workflows ? { workflows } : {}), ...(design ? { design } : {}), ...(primaryPopulation ? { primaryPopulation } : {}), ...(experimentTemplate ? { experimentTemplate } : {}) }
  if (nativePreparation) project.nativePreparation = nativePreparation
  if (modernSchema(snapshot)) {
    // The inventory this project actually bound, not whatever the running build
    // ships. Stamping RUNTIME_FILES here meant a project recompiled after a new
    // compiler module was added claimed a file its own runtimeSources does not
    // carry, and its identity moved for a runtime it never saw.
    project.runtimeFiles = [...runtimeFilesFor(snapshot)]
    project.readiness = await deriveReadinessContract(project)
  }
  return { ...project, sha256: await sha256(canonical(project)) }
}
export async function freezeStudy(spec) { return compileStudy(spec, { stampGenerator: true }) }
export async function prepareStudyReview(spec) {
  const { spec: snapshot, tasks, audit, requirements, nativePreparation, workflows, experimentTemplate, readiness } = await compileStudy(spec, { checkReviews: false })
  return { spec: snapshot, tasks, ...(audit ? { audit } : {}), ...(requirements ? { requirements } : {}), ...(nativePreparation ? { nativePreparation } : {}), ...(workflows ? { workflows } : {}), ...(experimentTemplate ? { experimentTemplate } : {}), ...(readiness ? { readiness } : {}) }
}
export async function verifyProject(project) {
  invariant(project?.format === 'research-benchmark' && SUPPORTED_SCHEMA_VERSIONS.includes(project?.version) && project.version === project.spec?.schemaVersion, 'This is not a frozen benchmark project.')
  invariant(project.version !== 2 || !project.tasks?.some(task => task.informationPacket?.version === 1), 'This historical version-2 project has task-only information packets. Retain its archived pinned runtime to verify the original artifact. To use this runtime, prepare and review the collection context in a new draft, then freeze a new project; old reviews are not collection-context approval.')
  const rebuilt = await compileStudy(project.spec)
  invariant(canonical(rebuilt) === canonical(project), 'The frozen project changed. Rebuild and freeze a new project before running it.')
  return project
}

export function gradeResponse(project, task, output) {
  if (project.spec.protocol.grading.kind === 'judge-audit') return gradeJudge(task, output)
  if (task.information && ['exact', 'json'].includes(project.spec.protocol.grading.kind)) {
    const decoded = decodeInformationResponse(task, output)
    return decoded.behavior === 'answer' ? gradeInterpretations(task, decoded.answer, project.spec.protocol.grading.kind) : informationDisposition(decoded)
  }
  if (project.spec.protocol.grading.kind === 'exact') return { passed: typeof output === 'string' && output === task.expected, score: typeof output === 'string' && output === task.expected ? 1 : 0 }
  if (project.spec.protocol.grading.kind === 'json') {
    let decoded
    try { decoded = typeof output === 'string' ? JSON.parse(output) : output } catch { return { passed: false, score: 0, reason: 'Response is not valid JSON.' } }
    const passed = canonical(decoded) === canonical(task.expected)
    return { passed, score: passed ? 1 : 0 }
  }
  throw new Error('This execution grader must be loaded by the project runner.')
}
