// Operational study integration. The generic study runner and review system
// retain ownership of scheduling, evidence, information treatments and reports.
import { canonical, invariant } from './prompts.mjs'
import { lowerTradingIR } from './trading-ir.mjs'
import { simulateTradingMarket, validateTradingMarket } from './trading-market.mjs'
import { tradingObservationContract } from './trading-observations.mjs'
import { generateOperationalLeanProgram, inlineOperationalLeanProgram } from './trading-lean.mjs'

export const OPERATIONAL_PROFILE = 'operational-v1'
export const operationalStudy = spec => spec.domain === 'lean-bench' && spec.leanProfile === OPERATIONAL_PROFILE
export const leanContractId = spec => operationalStudy(spec) ? 'operational-contract-v1' : 'constitution-v1'
// Public market chronology shared by the native and semantic-answer prompts.
export const operationalBrokerChronology = 'A new order becomes fill-eligible after delayBars completed input bars; each eligible order fills at most maxFillQuantity whole shares at that completed bar close, once per timestamp, with zero fees and slippage. Existing fills arrive before on_data. Cancellation-pending notices occur with the request. A later market-order submission processes queued cancellation acknowledgments before its own Submitted event; otherwise those acknowledgments arrive after on_data.'

export async function operationalInterpretation(compiled, input) {
  const ir = await lowerTradingIR(compiled.composition, input?.execution)
  return { ir, ...simulateTradingMarket(ir, input) }
}

export function operationalPromptContract(spec, ir, input, outputInstruction) {
  const bundle = spec.catalog.find(bundle => bundle.id === leanContractId(spec))
  invariant(bundle?.kind === 'atom' && bundle.role === 'contract' && typeof bundle.text === 'string' && !bundle.text.includes('{{'), 'Operational studies need the explicit literal operational-contract-v1 review bundle.')
  return '\n\nOperational execution appendix (part of this exact prompt):\n' + bundle.text + '\n' + outputInstruction
    + '\nImplement class FrozenBenchmark(QCAlgorithm). Configure UTC, the declared dates and cash, and RAW minute equity subscriptions with fill_forward=False. The evaluator installs the declared fill model after initialize. Use asynchronous native market orders. ' + operationalBrokerChronology + '\n'
    + 'Tag each native order with a JSON array ["LB-OP-1", strategyPath, privateLotLabel, reason, uniqueOrderLabel]. An entry opens a fresh privateLotLabel for that strategy; every exit names the same lot. Labels are opaque nonempty strings of at most 240 characters; uniqueOrderLabel cannot repeat. Reasons are entry for buys, and exit, reset, gate-close or race-release for sells. Actual native orders, every event, partial fills, fees, cancellations, pending quantities, private fill inventory and starting/ending equity are graded. Internal labels are normalized; their spelling does not affect correctness. Printed traces and controller snapshots are not grading inputs. Do not liquidate at end of data.\n'
    + 'Execution and lifecycle policy: ' + canonical(input.execution) + '\nPublic native observation and market contract: ' + canonical(tradingObservationContract(ir, input))
}

export function operationalCandidateFiles(task, code, sources) {
  const ir = task.compiled.operational
  validateTradingMarket(ir, task.input)
  invariant(typeof sources['trading_broker.py'] === 'string', 'Pin the public native broker harness.')
  const contract = JSON.stringify(canonical(tradingObservationContract(ir, task.input)))
  return {
    'candidate.py': code + '\n', 'trading_broker.py': sources['trading_broker.py'],
    'main.py': '# Public execution harness. Private strategy rules and expected observations are absent.\n'
      + 'import json\nfrom candidate import FrozenBenchmark as SubmittedBenchmark\nfrom trading_broker import OperationalEnvironment\n'
      + 'CONTRACT = json.loads(' + contract + ')\n\nclass FrozenBenchmark(SubmittedBenchmark):\n'
      + '    def initialize(self):\n        super().initialize()\n        self._lb_environment = OperationalEnvironment(self, CONTRACT)\n'
      + '    def on_data(self, data):\n        self._lb_environment.on_data(data)\n        super().on_data(data)\n'
      + '    def on_end_of_algorithm(self):\n        super().on_end_of_algorithm()\n        self._lb_environment.finish()\n',
  }
}

export function operationalReferenceProgram(task, sources) {
  return inlineOperationalLeanProgram(generateOperationalLeanProgram(task.compiled.operational, task.input.bars, sources, { observationTags: true }), sources)
}

export function operationalProjectFiles(project, sources) {
  const files = { 'LEAN-REVIEW.md': '# Operational Lean Bench review packet\n\nThis explicit draft profile uses recursive 2–4-child templates and four-role strategies. Review operational-contract-v1, every used bundle, its transitive source pins and the task input. No starter bundle has personal approval.\n\nEach lean/<task>/ directory contains the composition-bound operational IR, public bars and market contract, independently reproducible expected observation and controller diagnostics, a public candidate harness, and a trusted Python reference. Only the public candidate environment and submitted code are mounted during grading. Candidate logs and controller snapshots never establish a grade.\n\nRun node cli.mjs qualify for JavaScript/Python interpreter agreement. This is not native qualification: separately run at least three fresh references and compare the retained native orders/events, hand-authored truth and registered wrong readings. The profile models delayed capped whole-share USD equity fills with zero fees. Options, full study qualification, personal approvals and counted collection remain separate requirements.\n' }
  const emit = (task, prefix) => {
    const interpreted = simulateTradingMarket(task.compiled.operational, task.input)
    for (const [name, value] of Object.entries({ 'operational-ir.json': task.compiled.operational, 'bars.json': task.input,
      'expected-observation.json': interpreted.observation, 'reference-interpretation.json': interpreted })) files[prefix + '/' + name] = JSON.stringify(value, null, 2) + '\n'
    const reference = operationalReferenceProgram(task, sources)
    for (const [name, source] of Object.entries(operationalCandidateFiles(task, reference, sources))) files[prefix + '/reference/' + name] = source
    for (const [name, source] of Object.entries(operationalCandidateFiles(task, '# Supply the candidate FrozenBenchmark class here.', sources))) files[prefix + '/candidate-environment/' + name] = source
  }
  for (const task of project.tasks) {
    emit(task, 'lean/' + task.id)
    for (const reading of task.interpretations || []) emit({ ...task, compiled: reading.compiled, expected: reading.expected }, 'lean/' + task.id + '/readings/' + reading.id)
  }
  return files
}
