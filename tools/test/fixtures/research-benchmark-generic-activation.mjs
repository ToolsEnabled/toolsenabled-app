// Synthetic portable counterparts: direct addition and repeated unit steps.
// Neither counterpart receives expected answers or wrong-reading identities.
import { developmentStarter } from './research-benchmark-development.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'

export async function genericActivationFixture() {
  const spec = developmentStarter()
  spec.id = 'generic-selected-input'; spec.name = 'Synthetic selected-input qualification'
  spec.tasks = [{ id: 'addition-a', root: { use: 'task', params: { a: 2, b: 3 } }, input: { offset: 1 }, expected: '6', split: 'development' }]
  spec.conditions[0].adapter.responses = { 'addition-a': '6' }
  const contract = `if ('expected' in task || 'text' in task.compiled || target && Object.keys(target).some(key => key !== 'requirement')) throw new Error('Answer-key leakage');
    const { a, b } = task.compiled.semantic; if (![a,b,task.input.offset].every(Number.isSafeInteger)) throw new Error('Integer inputs required');
    if ([a,b,task.input.offset].some(value => Math.abs(value) > 100)) throw new Error('Synthetic domain bound');`
  const attachments = {
    'interpreters/direct.mjs': `export function interpret(task, target) { ${contract}
      return { observation: String(a + b + task.input.offset), activation: { counters: { evaluated: 1 }, transitions: {} } }; }\n`,
    'interpreters/steps.mjs': `export function interpret(task, target) { ${contract}
      let sum = 0; for (const term of [a,b,task.input.offset]) { for (let count = 0; count < Math.abs(term); count++) sum += Math.sign(term); }
      return { observation: String(sum), activation: { counters: { evaluated: 1 }, transitions: {} } }; }\n`,
  }
  spec.inputs = await Promise.all(Object.entries(attachments).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  spec.requirementPlan = { version: 1, selectedInput: { policy: 'require-composition', rationale: 'Synthetic one-node apparatus must activate on its actual offset input.', timeoutMs: 30000 },
    interpreters: { reference: 'interpreters/direct.mjs', independent: 'interpreters/steps.mjs', rationale: 'Direct arithmetic versus bounded repeated signed unit steps; distinct algorithms for a hand-checked synthetic domain.' },
    targets: [{ id: 'add-operands', taskId: 'addition-a', requirementId: 'root#task', rationale: 'The sum must use the declared first operand.',
      activation: [{ kind: 'counter', name: 'evaluated', minimum: 1 }],
      probes: [{ id: 'offset-control', input: { offset: 2 }, assertions: [{ path: [], equals: '7' }] }],
      wrongReadings: [{ id: 'wrong-first-operand', root: { use: 'task', params: { a: 1, b: 3 } }, rationale: 'Changing only the first operand subtracts one from the required sum.' }] }] }
  return { spec, attachments }
}
