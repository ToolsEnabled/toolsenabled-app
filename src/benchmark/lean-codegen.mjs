import { canonical, invariant, object, sha256 } from './prompts.mjs'
import { interpretLean } from './lean.mjs'
import { RUNTIME_FILES } from './study.mjs'
import { leanContractId, operationalStudy, operationalProjectFiles } from './trading-study.mjs'

export async function bindLeanReview(spec, sources) {
  const copy = structuredClone(spec)
  const constitution = copy.catalog.find(bundle => bundle.id === leanContractId(spec))
  invariant(constitution, 'Lean Bench needs its semantic constitution bundle.')
  constitution.hooks = { ...constitution.hooks, sourceHashes: Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => {
    invariant(typeof sources[file] === 'string', `The review packet is missing ${file}.`)
    return [file, await sha256(sources[file])]
  }))) }
  return copy
}

export function leanProjectFiles(project, referenceSource, executionSource, sources) {
  if (project.spec.domain !== 'lean-bench') return {}
  if (operationalStudy(project.spec)) return operationalProjectFiles(project, sources)
  const files = { 'LEAN-REVIEW.md': '# Lean Bench review packet\n\nReview the constitution and every used catalog bundle in specification.json. The constitution binds the included compiler, runner, JavaScript interpreter and Python runtime by SHA-256. Review wording, parameters, operational rules, state, dependencies, hooks, tests and the exact source files. Editing any bound source requires another review and freeze.\n\nFor every task, compare expected-trace.json with the independently executed Python interpreter and the actual LEAN OrderEvent trace. The interpretation files included here are generated expectations, not an engine qualification receipt.\n\nA real LEAN run requires your pinned engine image and data. Generated main.py uses bar-close market orders, validates full fills at the declared close, and refuses unsupported partial fills. It records actual fills using OrderEvent; private ownership is carried in the order tag. This target is a controlled equity backtest, not a live trading system.\n' }
  function emit(task, prefix) {
    const interpreted = interpretLean(task.compiled.semantic, task.input)
    files[`${prefix}/semantic.json`] = JSON.stringify(task.compiled.semantic, null, 2) + '\n'
    files[`${prefix}/bars.json`] = JSON.stringify(task.input, null, 2) + '\n'
    files[`${prefix}/expected-trace.json`] = JSON.stringify(interpreted, null, 2) + '\n'
    files[`${prefix}/main.py`] = generateLeanProgram(task)
    if (referenceSource !== undefined) {
      invariant(typeof referenceSource === 'string', 'Generated LEAN programs need the pinned Python reference source.')
      files[`${prefix}/lean_reference.py`] = referenceSource
      invariant(typeof executionSource === 'string', 'Generated LEAN programs need their pinned execution ledger.')
      files[`${prefix}/execution_reference.py`] = executionSource
    }
  }
  for (const task of project.tasks) {
    const prefix = `lean/${task.id}`
    emit(task, prefix)
    for (const reading of task.interpretations || []) {
      emit({ ...task, compiled: reading.compiled, expected: reading.expected }, `${prefix}/readings/${reading.id}`)
    }
  }
  return files
}

export function generateLeanProgram(task) {
  // JSON string literals are decoded as data. Symbols, wording and values are
  // never interpolated as executable Python expressions.
  const jsonLiteral = JSON.stringify(canonical({ semantic: task.compiled.semantic, input: task.input }))
  // A comment block only: it states where this file came from without being
  // able to change what the program does or what the engine observes.
  return `${attributionHeader(['quantconnect-lean-python-api', 'semantic-reference-runtime'])}# Generated from the frozen semantic tree. Include lean_reference.py and execution_reference.py beside this file.
from AlgorithmImports import *
import json
from datetime import datetime, timezone
from decimal import Decimal
from lean_reference import Reference

TASK = json.loads(${jsonLiteral})

def as_cents(value):
    cents = Decimal(str(value)) * 100
    if cents != cents.to_integral_value():
        raise RuntimeError("LEAN price or cash is not an exact integer number of cents")
    return int(cents)

class FrozenBenchmark(QCAlgorithm):
    def initialize(self):
        bars = TASK["input"]["bars"]
        first = datetime.fromisoformat(bars[0]["time"].replace("Z", "+00:00")).astimezone(timezone.utc)
        last = datetime.fromisoformat(bars[-1]["time"].replace("Z", "+00:00")).astimezone(timezone.utc)
        self.set_start_date(first.year, first.month, first.day)
        self.set_end_date(last.year, last.month, last.day)
        self.set_time_zone(TimeZones.UTC)
        self.set_cash(TASK["input"]["cashCents"] / 100)
        if as_cents(self.portfolio.cash) != TASK["input"]["cashCents"]:
            raise RuntimeError("LEAN starting cash disagrees with the pinned input")
        self.reference = Reference(TASK["semantic"], TASK["input"]["cashCents"], dispatch=self.dispatch_intent)
        self.symbols = {}
        for ticker in sorted({ticker for bar in bars for ticker in bar["prices"]}):
            security = self.add_equity(ticker, Resolution.MINUTE, data_normalization_mode=DataNormalizationMode.RAW)
            security.set_fee_model(ConstantFeeModel(0))
            security.set_slippage_model(ConstantSlippageModel(0))
            self.symbols[ticker] = security.symbol
        self.bar_index = 0
        self.current = None
        self.actual = []

    def on_data(self, data):
        bars = TASK["input"]["bars"]
        if self.bar_index >= len(bars):
            return
        declared = bars[self.bar_index]
        when = datetime.fromisoformat(declared["time"].replace("Z", "+00:00")).astimezone(timezone.utc)
        now = self.utc_time.replace(tzinfo=timezone.utc)
        if now < when:
            return
        if now != when:
            raise RuntimeError("Pinned input bar was not delivered at its declared time")
        observed = {}
        for ticker, price in declared["prices"].items():
            if price is None:
                continue
            symbol = self.symbols[ticker]
            if symbol not in data.bars:
                raise RuntimeError("Pinned input price is missing: " + ticker)
            cents = as_cents(data.bars[symbol].close)
            if cents != price:
                raise RuntimeError("LEAN data disagrees with the pinned input: " + ticker)
            observed[ticker] = cents
        self.reference.step(observed, time=int(now.timestamp()))
        self.bar_index += 1

    def dispatch_intent(self, intent):
        self.current = intent
        quantity = intent["quantity"] * (1 if intent["side"] == "buy" else -1)
        ticket = self.market_order(self.symbols[intent["asset"]], quantity, tag=intent["owner"] + "|" + intent["reason"])
        if ticket.status != OrderStatus.FILLED or int(ticket.quantity_filled) != quantity:
            raise RuntimeError("This constitution requires synchronous full fills")
        self.current = None

    def on_order_event(self, event):
        if event.status == OrderStatus.PARTIALLY_FILLED:
            raise RuntimeError("Partial fills are outside this constitution")
        kind = {OrderStatus.SUBMITTED: "accepted", OrderStatus.FILLED: "fill", OrderStatus.CANCELED: "cancelled", OrderStatus.INVALID: "rejected"}.get(event.status)
        if kind is None:
            return
        intent = self.current
        if intent is None or event.symbol != self.symbols[intent["asset"]]:
            raise RuntimeError("Native receipt has no currently dispatched private intent")
        receipt = dict(id=str(event.order_id) + ":" + str(event.id), intentId=intent["id"],
                       brokerOrderId=str(event.order_id), kind=kind, time=int(event.utc_time.replace(tzinfo=timezone.utc).timestamp()))
        if kind == "fill":
            quantity = intent["quantity"] * (1 if intent["side"] == "buy" else -1)
            if event.fill_quantity != quantity or as_cents(event.fill_price) != self.reference.prices[intent["asset"]] or event.order_fee.value.amount != 0:
                raise RuntimeError("Actual LEAN fill differs from the declared quantity, close or zero fee")
            receipt.update(quantity=abs(quantity), priceCents=as_cents(event.fill_price), feeCents=0)
        self.reference.reconcile(receipt)
        if kind == "fill":
            fill = self.reference.tape[-1]
            self.actual.append(fill)
            self.log("BENCHMARK_FILL " + json.dumps(fill, sort_keys=True))

    def on_end_of_algorithm(self):
        if self.bar_index != len(TASK["input"]["bars"]):
            raise RuntimeError("LEAN did not consume every pinned input bar")
        if as_cents(self.portfolio.cash) != self.reference.cash:
            raise RuntimeError("Actual LEAN cash disagrees with the frozen decisions")
        for position in self.reference.ledger.snapshot()["positions"]:
            if self.portfolio[self.symbols[position["asset"]]].quantity != position["quantity"]:
                raise RuntimeError("Actual LEAN holdings disagree with reconciled private lots")
        self.log("BENCHMARK_TRACE " + json.dumps(self.actual, sort_keys=True))
`
}

export function inlineLeanProgram(program, sources) {
  invariant(typeof program === 'string' && typeof sources['lean-reference.py'] === 'string' && typeof sources['execution_reference.py'] === 'string', 'Inlining a LEAN program requires both pinned Python sources.')
  const reference = sources['lean-reference.py'].replace('from execution_reference import ExecutionLedger, require', () => sources['execution_reference.py'])
  return program.replace('from lean_reference import Reference', () => reference)
}

// ---- Provenance of the code this engine generates for its users ----
//
// This registry lives here, inside a runtime file every project already pins,
// and not in a module of its own. A new runtime module changes the schema-2
// runtime inventory, and study.mjs then refuses to verify every version-2
// project frozen before it -- measured on 2026-09-10 against the run of
// record. An export still regenerates its attributions from its own pinned
// bytes, because this file is one of them.
//
// The owner's rule: prefer established reference implementations, make
// adaptations clear, identify authors and link the real source for substantial
// reuse, retain notices, record a useful revision -- and never claim generated
// code came from a paper or repository when it did not.
//
// The honest finding for this codebase is that it reuses no third-party source.
// Every generated artifact is written from the frozen semantic tree against a
// published API or specification. So this registry separates two things that
// are easy to blur, and the schema refuses to let them blur:
//
//   codeProvenance -- where BYTES came from. kind 'reused' or 'adapted' requires
//     an upstream revision, the sha256 of the exact upstream bytes and a fetch
//     date. kind 'generated' is our own code and must carry no upstream hash,
//     because a hash there would assert a reuse that did not happen.
//   references -- bibliography. A specification or paper that defines what our
//     own code implements, or a reviewed source whose ordinary structure the
//     generated code follows. These carry no hash and are explicitly marked as
//     contributing no code, so a reader cannot mistake one for reuse.
//
// Nothing is entered here from memory. Every value is either measured on this
// machine (image labels, engine output) or read out of the source in this tree.

export const PROVENANCE_VERSION = 1

const HASH = /^[a-f0-9]{64}$/
const KINDS = ['reused', 'adapted', 'generated']
const BASES = ['api', 'specification', 'method', 'original']

// Measured 2026-09-10 on this machine with `docker image inspect` on the pinned
// digest, and from the engine's own retained stdout in both LEAN trials of the
// flat-canary run. The label and the running interpreter disagree; both are
// recorded rather than reconciled, and the digest is the only proven revision.
export const LEAN_IMAGE_DIGEST = 'sha256:cc27d5608d209fc9276c8419af3dd8e598ba49075c6f5c44ca38bf637eaef216'
export const LEAN_IMAGE_FACTS = Object.freeze({
  digest: LEAN_IMAGE_DIGEST,
  labels: Object.freeze({ lean_version: '18057', python_version: '3.11', strict_python_version: '3.11.11', target_framework: 'net10.0' }),
  imageCreated: '2026-09-04T20:20:04.529961705Z',
  measuredEngine: 'LEAN ALGORITHMIC TRADING ENGINE v2.5.0.0',
  measuredPython: '3.11.14',
  measurementNote: 'The engine reported Python 3.11.14 in both retained trial logs while the image label says strict_python_version 3.11.11. The label is not a reliable interpreter revision; cite the digest.',
  measuredOn: '2026-09-10',
})

export const PROVENANCE = Object.freeze([
  {
    id: 'quantconnect-lean-python-api',
    title: 'Generated FrozenBenchmark algorithm, written against the QuantConnect LEAN Python API',
    appliesTo: ['lean/<task>/main.py', 'inlined candidate main.py'],
    codeProvenance: {
      kind: 'generated',
      basis: 'api',
      // The generated program's only LEAN touchpoint is the star import of the
      // engine's own namespace. Verified by reading the emitted file: its
      // imports are AlgorithmImports, json, datetime, decimal, lean_reference.
      statement: 'Written against the QuantConnect LEAN Python API, lean_version 18057; no LEAN source is copied.',
      upstreamSha256: null,
    },
    upstream: {
      project: 'QuantConnect LEAN',
      authors: 'QuantConnect Corporation and the LEAN contributors',
      repositoryUrl: 'https://github.com/QuantConnect/Lean',
      license: 'Apache-2.0',
      // Recorded because the API is Apache-2.0 even though no bytes are copied;
      // this states the relationship without asserting reuse.
      licenseNote: 'QuantConnect LEAN is distributed under the Apache License 2.0. This project copies no LEAN source, so no LEAN notice is redistributed; the reference is informational.',
      revision: { kind: 'image-digest', value: LEAN_IMAGE_DIGEST, labels: LEAN_IMAGE_FACTS.labels, measuredPython: LEAN_IMAGE_FACTS.measuredPython, note: LEAN_IMAGE_FACTS.measurementNote },
    },
    references: [
      // Reviewed at upstream master on 2026-09-10 (root's reference review).
      // refs/heads/master was measured with `git ls-remote` at 22:35:16Z that
      // day, after the review, so the commit dates the branch; it is not proof
      // of the exact bytes that were read.
      { kind: 'reviewed-source',
        citation: 'QuantConnect LEAN, Algorithm.Python/BasicTemplateAlgorithm.py, with the repository LICENSE (Apache License 2.0)',
        url: 'https://github.com/QuantConnect/Lean/blob/master/Algorithm.Python/BasicTemplateAlgorithm.py',
        revision: 'master, retrieved 2026-09-10; refs/heads/master was 8ee075a39918f2df6fe9e0a5944e366fb60d10dc when measured that day',
        retrievedAt: '2026-09-10',
        follows: 'its ordinary QCAlgorithm skeleton: an initialization method and a data callback (initialize and on_data here)',
        note: 'The canonical LEAN Python template, reviewed at upstream master and not claimed to match the pinned image revision. It supplies the ordinary skeleton only; the frozen-input reconciliation, integer-cent arithmetic and order-tagging contract are generated here, and no code is copied from it. Licence: https://github.com/QuantConnect/Lean/blob/master/LICENSE' },
    ],
  },
  {
    id: 'semantic-reference-runtime',
    title: 'Independent Python semantic reference and broker-event ledger',
    appliesTo: ['lean-reference.py', 'execution_reference.py'],
    codeProvenance: {
      kind: 'generated',
      basis: 'original',
      statement: 'Original implementation in this repository. It deliberately does not translate or invoke the JavaScript interpreter; the two are independent readings of the same frozen semantic tree, which is what makes their agreement evidence.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [],
  },
  {
    id: 'zip-writer',
    title: 'Deterministic uncompressed ZIP writer and CRC-32',
    appliesTo: ['export.mjs zipFiles', 'export.mjs crc32'],
    codeProvenance: {
      kind: 'generated',
      basis: 'specification',
      statement: 'Original implementation of a published container format. Stored (uncompressed) entries only, fixed timestamps and sorted names so an export is byte-reproducible.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'specification', citation: 'PKWARE Inc. (2022). .ZIP File Format Specification (APPNOTE.TXT), version 6.3.10, revised 2022-11-01.', url: 'https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT',
        note: 'Defines the local file header (0x04034b50), central directory (0x02014b50) and end-of-central-directory (0x06054b50) records this writer emits (section 4.3) and the CRC-32 it requires (section 4.4.7). No PKWARE code is included. Verified at this URL on 2026-09-11 (citation audit; content sha256 0b993022a7d320a0bf704e6980bea36fafd17a6066ab994db0a0c16278a50cd6); the former support.pkware.com URL now redirects to a product page.' },
      { kind: 'specification', citation: 'Deutsch, P. (1996). GZIP file format specification version 4.3. RFC 1952, section 2.3.1.', url: 'https://www.rfc-editor.org/rfc/rfc1952',
        note: 'Names the CRC-32 of ISO 3309 and ITU-T V.42 and gives the reflected polynomial 0xEDB88320 this bitwise loop uses; ZIP itself specifies its CRC-32 in APPNOTE section 4.4.7. No third-party code is included. Verified at this URL on 2026-09-11 (citation audit).' },
    ],
  },
  {
    id: 'canonical-json',
    title: 'Canonical JSON serialization used for every digest and comparison',
    appliesTo: ['prompts.mjs canonical'],
    codeProvenance: {
      kind: 'generated',
      basis: 'original',
      // Deliberately NOT cited as RFC 8785. It sorts keys and defers number and
      // string formatting to JSON.stringify; conformance to JCS has not been
      // proven here, and an unproven citation is exactly what the owner forbade.
      statement: 'Own definition: object keys sorted, arrays in order, scalars via JSON.stringify, non-finite numbers and undefined refused. This is NOT claimed to conform to RFC 8785 (JSON Canonicalization Scheme); no conformance test exists in this tree, so no such citation is made.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [],
  },
  {
    id: 'sha256-digest',
    title: 'SHA-256 digests over frozen bytes',
    appliesTo: ['prompts.mjs sha256'],
    codeProvenance: {
      kind: 'generated',
      basis: 'api',
      statement: 'No hash implementation is included. The runtime Web Crypto implementation is called: globalThis.crypto.subtle.digest("SHA-256", bytes).',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'specification', citation: 'NIST FIPS 180-4, Secure Hash Standard', url: 'https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf',
        note: 'Defines SHA-256. The algorithm is provided by the host runtime, not by this project.' },
      { kind: 'specification', citation: 'Watson, M. (ed.) (2017). Web Cryptography API. W3C Recommendation, 26 January 2017; SubtleCrypto.digest.', url: 'https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/',
        note: 'The interface actually called. The undated URL https://www.w3.org/TR/WebCryptoAPI/ now serves the Web Cryptography Level 2 draft, so the dated Recommendation is cited (citation audit, 2026-09-11).' },
    ],
  },
  {
    id: 'cluster-percentile-bootstrap',
    title: 'Percentile bootstrap interval over whole clusters',
    appliesTo: ['analysis.mjs clusterInterval'],
    codeProvenance: {
      kind: 'generated',
      basis: 'method',
      statement: 'Original implementation of a published method: each draw resamples whole clusters (task families, or a declared factor) with replacement, recomputes the statistic, and takes percentile endpoints from the sorted draws. Seeded and frozen so an interval is reproducible.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'paper', citation: 'Efron, B. (1979). Bootstrap methods: another look at the jackknife. Annals of Statistics 7(1), 1-26.', url: 'https://doi.org/10.1214/aos/1176344552',
        note: 'Origin of the method. No code from this paper exists; none is published with it.' },
      { kind: 'paper', citation: 'Efron, B. and Tibshirani, R. J. (1993). An Introduction to the Bootstrap. Monographs on Statistics and Applied Probability 57. New York: Chapman and Hall. ISBN 0412042312.', url: null,
        note: 'Percentile interval construction; the interpolated quantile rule is Hyndman and Fan definition 7 (its own registry entry).' },
    ],
  },
  {
    id: 'seeded-generator-mulberry32',
    title: 'Seeded 32-bit generator (mulberry32) behind the schedule shuffle and the bootstrap draws',
    appliesTo: ['analysis.mjs rng', 'study.mjs shuffle'],
    codeProvenance: {
      kind: 'generated',
      basis: 'method',
      statement: 'The generator is the mulberry32 algorithm (Tommy Ettinger, 2017): state += 0x6D2B79F5, then the imul/xor/shift output hash with the constants (t | 1) and (t | 61) and shifts 15, 7 and 14, divided by 2^32. It is written here in the same one-line JavaScript form that circulates publicly, with variables renamed; whether those lines were typed from that public snippet cannot be established from this tree, so this entry records the algorithm and its published form and does not claim the bytes are original.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'specification', citation: 'Ettinger, T. (2017). mulberry32 (mulberry32.c), a 32-bit seeded pseudorandom generator. GitHub Gist, CC0 1.0.', url: 'https://gist.github.com/tommyettinger/46a874533244883189143505d203312c',
        note: 'Published by the author: the state update and output hash this generator implements (constant 0x6D2B79F5). Fetched on 2026-09-11 through the research fetch layer (content sha256 185bf23d7fca09847a5b1ff054155843ea9b514964944131f8f32ca78cb957a1); not peer reviewed, and the notes published with it record statistical limitations. The JavaScript form also circulates in bryc, jshash/PRNGs.md (fetched the same day, content sha256 8f0460239ede7a26aab428dbd4d8ad0f3f967d938d1ad1562b3fa7164471fd34). No upstream byte hash is claimed for the lines here.' },
    ],
  },
  {
    id: 'fisher-yates-shuffle',
    title: 'In-place seeded shuffle of the frozen schedule',
    appliesTo: ['study.mjs shuffle'],
    codeProvenance: {
      kind: 'generated',
      basis: 'method',
      statement: 'Original implementation of the Fisher-Yates shuffle in Durstenfeld\u2019s in-place form: for i from n-1 down to 1, swap element i with a uniformly drawn element at or below it. The draws come from the seeded generator above.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'paper', citation: 'Durstenfeld, R. (1964). Algorithm 235: Random permutation. Communications of the ACM 7(7), 420.', url: 'https://doi.org/10.1145/364520.364540',
        note: 'The in-place algorithm. No code from this paper is included.' },
    ],
  },
  {
    id: 'bonferroni-simultaneous-intervals',
    title: 'Bonferroni-corrected simultaneous interval levels',
    appliesTo: ['analysis.mjs clusterInterval', 'analysis.mjs contrastsFor'],
    codeProvenance: {
      kind: 'generated',
      basis: 'method',
      statement: 'Original implementation of a published method: when the frozen plan declares multiplicity bonferroni, the interval level alpha is divided by the number of planned intervals in its family before the percentile endpoints are read.',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'paper', citation: 'Dunn, O. J. (1961). Multiple comparisons among means. Journal of the American Statistical Association 56(293), 52-64.', url: 'https://doi.org/10.1080/01621459.1961.10482090',
        note: 'Simultaneous intervals by the Bonferroni correction, as applied here. No code from this paper is included. Bonferroni (1936) itself could not be verified on a primary or library record and is not cited.' },
    ],
  },
  {
    id: 'sample-quantile-type-7',
    title: 'Sample quantile by linear interpolation for percentile endpoints',
    appliesTo: ['analysis.mjs quantile'],
    codeProvenance: {
      kind: 'generated',
      basis: 'method',
      statement: 'Original implementation of a published definition: the quantile at probability p of n sorted values is read at position (n-1)p with linear interpolation between the neighbouring order statistics (Hyndman and Fan definition 7).',
      upstreamSha256: null,
    },
    upstream: null,
    references: [
      { kind: 'paper', citation: 'Hyndman, R. J. and Fan, Y. (1996). Sample quantiles in statistical packages. The American Statistician 50(4), 361-365.', url: 'https://doi.org/10.1080/00031305.1996.10473566',
        note: 'Definition 7 is the one implemented. No code from this paper is included.' },
    ],
  },
])

// 'original' is not something one "follows"; say what each basis actually means.
const BASIS_PHRASE = {
  api: 'written against a published API',
  specification: 'implements a published specification',
  method: 'implements a published method',
  original: 'original to this repository',
}
function basisPhrase(basis) { return BASIS_PHRASE[basis] || basis }

function validateReference(reference, where) {
  invariant(object(reference), where + ': a reference must be an object.')
  invariant(['specification', 'paper', 'reviewed-source'].includes(reference.kind), where + ': a reference is a specification, a paper or a reviewed source.')
  invariant(typeof reference.citation === 'string' && reference.citation.trim(), where + ': a reference needs its citation text.')
  invariant(reference.url === null || (typeof reference.url === 'string' && reference.url.startsWith('https://')), where + ': a reference URL is https or null.')
  invariant(typeof reference.note === 'string' && reference.note.trim(), where + ': say what the reference contributes, so it cannot be mistaken for reuse.')
  // A reviewed source is code someone read, not code anyone copied. It names the
  // revision read and when, so "reviewed" cannot quietly become "reused".
  if (reference.kind === 'reviewed-source') {
    invariant(typeof reference.revision === 'string' && reference.revision.trim(), where + ': a reviewed source names the revision that was read.')
    invariant(typeof reference.retrievedAt === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(reference.retrievedAt), where + ': a reviewed source records the date it was retrieved.')
  }
  invariant(reference.follows === undefined || (typeof reference.follows === 'string' && reference.follows.trim()), where + ': say which structure the generated code follows, or omit it.')
}

// The schema is the guard. It refuses an entry that claims reuse without an
// upstream revision and hash, and equally refuses one that attaches a hash to
// code we wrote ourselves. An invented provenance is the failure this registry
// exists to prevent, and it can fail in both directions.
export function validateProvenance(entries = PROVENANCE) {
  invariant(Array.isArray(entries) && entries.length, 'The provenance registry needs at least one entry.')
  const seen = new Set()
  for (const entry of entries) {
    invariant(object(entry), 'Every provenance entry is an object.')
    const where = 'provenance ' + (entry.id || '(unnamed)')
    invariant(typeof entry.id === 'string' && /^[a-z][a-z0-9-]*$/.test(entry.id) && !seen.has(entry.id), where + ': needs a distinct lowercase identifier.')
    seen.add(entry.id)
    invariant(typeof entry.title === 'string' && entry.title.trim(), where + ': needs a title.')
    invariant(Array.isArray(entry.appliesTo) && entry.appliesTo.length && entry.appliesTo.every(file => typeof file === 'string' && file.trim()), where + ': name the artifacts it applies to.')
    const code = entry.codeProvenance
    invariant(object(code) && KINDS.includes(code.kind), where + ': codeProvenance.kind must be reused, adapted or generated.')
    invariant(typeof code.statement === 'string' && code.statement.trim(), where + ': state plainly what was reused, adapted or generated.')
    if (code.kind === 'generated') {
      invariant(BASES.includes(code.basis), where + ': generated code declares whether it follows an api, a specification, a method, or is original.')
      invariant(code.upstreamSha256 === null, where + ': generated code carries no upstream hash; a hash here would assert reuse that did not happen.')
      invariant(entry.upstream === null || !entry.upstream.filePath, where + ': generated code cannot name an upstream file it copied.')
    } else {
      const upstream = entry.upstream
      invariant(object(upstream), where + ': reused or adapted code needs its upstream project.')
      invariant(typeof upstream.project === 'string' && upstream.project.trim(), where + ': name the upstream project.')
      invariant(typeof upstream.authors === 'string' && upstream.authors.trim(), where + ': name the original authors.')
      invariant(typeof upstream.repositoryUrl === 'string' && upstream.repositoryUrl.startsWith('https://'), where + ': link the actual source repository.')
      invariant(typeof upstream.filePath === 'string' && upstream.filePath.trim(), where + ': name the exact upstream file.')
      invariant(typeof upstream.license === 'string' && upstream.license.trim(), where + ': record the upstream licence.')
      invariant(typeof upstream.licenseNote === 'string' && upstream.licenseNote.trim(), where + ': retain the notice text the licence requires.')
      invariant(object(upstream.revision) && typeof upstream.revision.value === 'string' && upstream.revision.value.trim(), where + ': record the exact revision the bytes came from.')
      invariant(HASH.test(code.upstreamSha256 || ''), where + ': record the sha256 of the upstream bytes at that revision. No citation without a hash.')
      invariant(typeof code.fetchedAt === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(code.fetchedAt), where + ': record the date the upstream bytes were fetched.')
      if (code.kind === 'adapted') invariant(Array.isArray(code.adaptations) && code.adaptations.length
        && code.adaptations.every(line => typeof line === 'string' && line.trim()), where + ': adapted code lists every adaptation in one line each.')
    }
    invariant(Array.isArray(entry.references), where + ': references must be a list, even when empty.')
    for (const reference of entry.references) validateReference(reference, where)
  }
  return entries
}

export function provenanceEntry(id, entries = PROVENANCE) {
  const entry = entries.find(row => row.id === id)
  invariant(entry, 'No provenance entry: ' + id + '. Every attribution printed into a generated artifact must come from the registry.')
  return entry
}

// The header a generated program carries. It is a comment block, so it can
// never change what the program does or what the engine observes.
export function attributionHeader(ids, { comment = '# ', entries: registry = PROVENANCE } = {}) {
  const entries = ids.map(id => provenanceEntry(id, registry))
  const lines = ['Provenance of this generated file. See ATTRIBUTIONS.md and provenance.json in this project.']
  for (const entry of entries) {
    const code = entry.codeProvenance
    lines.push('', '[' + code.kind + '] ' + entry.title, '  ' + code.statement)
    if (entry.upstream) {
      lines.push('  upstream: ' + entry.upstream.project + ' - ' + entry.upstream.authors)
      lines.push('  source:   ' + entry.upstream.repositoryUrl + (entry.upstream.filePath ? ' - ' + entry.upstream.filePath : ''))
      lines.push('  licence:  ' + entry.upstream.license)
      if (code.kind !== 'generated') lines.push('  notice:   ' + entry.upstream.licenseNote)
      lines.push('  revision: ' + entry.upstream.revision.kind + ' ' + entry.upstream.revision.value)
      if (code.upstreamSha256) lines.push('  sha256:   ' + code.upstreamSha256 + ' (fetched ' + code.fetchedAt + ')')
      if (entry.upstream.revision.measuredPython) lines.push('  measured: interpreter ' + entry.upstream.revision.measuredPython)
    }
    for (const adaptation of code.adaptations || []) lines.push('  adapted:  ' + adaptation)
    for (const reference of entry.references) {
      lines.push('  reference (' + (reference.kind === 'reviewed-source' ? 'reviewed source, ' : '') + 'contributes no code): ' + reference.citation)
      if (reference.kind === 'reviewed-source') lines.push('    revision: ' + reference.revision)
      if (reference.follows) lines.push('    this program follows ' + reference.follows)
    }
  }
  // The no-copy sentence is derived, never asserted: it is printed only when no
  // entry listed for this file is reused or adapted.
  const copied = entries.filter(entry => entry.codeProvenance.kind !== 'generated')
  lines.push('', 'Everything not listed above as reused or adapted is generated from the frozen semantic',
    'tree by the compiler in this repository.' + (copied.length ? '' : ' No third-party source is copied into this file.'))
  if (copied.length) lines.push('This file contains third-party source from: ' + copied.map(entry => entry.title).join('; ') + '.',
    'Its authors, source, revision, licence notices and adaptations are listed above.')
  return lines.map(line => (line ? comment + line : comment.trimEnd())).join('\n') + '\n'
}

export function provenanceDocument(entries = PROVENANCE) {
  validateProvenance(entries)
  return {
    format: 'research-benchmark-provenance', version: PROVENANCE_VERSION,
    scope: 'Provenance of the code and templates this project generates for its users. codeProvenance records where bytes came from; references record the specifications and papers our own implementations follow and contribute no code.',
    entries: entries.map(entry => JSON.parse(JSON.stringify(entry))),
  }
}

export function attributionsMarkdown(entries = PROVENANCE) {
  validateProvenance(entries)
  const reused = entries.filter(entry => entry.codeProvenance.kind !== 'generated')
  const out = ['# Attribution and reused code', '',
    'This project generates research artifacts. This file records, for every generated artifact, which parts are',
    'reused from another project, which are adapted, and which are newly generated here.', '',
    reused.length
      ? reused.length + ' entr' + (reused.length === 1 ? 'y reuses or adapts' : 'ies reuse or adapt')
        + ' third-party source; each records its upstream revision and the SHA-256 of the exact bytes.'
      : '**No third-party source code is copied into this project or into anything it generates.** Every generated'
        + ' artifact is written from the frozen semantic tree by the compiler in this repository. The entries below record'
        + ' the APIs, specifications, published methods and reviewed sources those implementations follow, and each says explicitly that'
        + ' it contributes no code.',
    '']
  for (const entry of entries) {
    const code = entry.codeProvenance
    out.push('## ' + entry.title, '',
      '- **Classification:** ' + code.kind + (code.basis ? ' (' + basisPhrase(code.basis) + ')' : ''),
      '- **Applies to:** ' + entry.appliesTo.join(', '),
      '- **Statement:** ' + code.statement)
    if (entry.upstream) {
      out.push('- **Upstream project:** ' + entry.upstream.project,
        '- **Original authors:** ' + entry.upstream.authors,
        '- **Source:** ' + entry.upstream.repositoryUrl + (entry.upstream.filePath ? ' (' + entry.upstream.filePath + ')' : ''),
        '- **Licence:** ' + entry.upstream.license + ' - ' + entry.upstream.licenseNote,
        '- **Revision:** ' + entry.upstream.revision.kind + ' `' + entry.upstream.revision.value + '`')
      if (entry.upstream.revision.labels) out.push('- **Recorded labels:** '
        + Object.entries(entry.upstream.revision.labels).map(([key, value]) => key + '=' + value).join(', '))
      if (entry.upstream.revision.measuredPython) out.push('- **Measured interpreter:** ' + entry.upstream.revision.measuredPython)
      if (entry.upstream.revision.note) out.push('- **Revision note:** ' + entry.upstream.revision.note)
      if (code.upstreamSha256) out.push('- **SHA-256 of upstream bytes:** `' + code.upstreamSha256 + '` (fetched ' + code.fetchedAt + ')')
    }
    for (const adaptation of code.adaptations || []) out.push('- **Adaptation:** ' + adaptation)
    for (const reference of entry.references) {
      out.push('- **Reference (' + reference.kind + ', contributes no code):** '
        + reference.citation + (reference.url ? ' <' + reference.url + '>' : '') + ' ' + reference.note)
      if (reference.kind === 'reviewed-source') out.push('  - **Revision read:** ' + reference.revision + ' (retrieved ' + reference.retrievedAt + ')')
      if (reference.follows) out.push('  - **Generated code follows:** ' + reference.follows)
    }
    out.push('')
  }
  return out.join('\n')
}
