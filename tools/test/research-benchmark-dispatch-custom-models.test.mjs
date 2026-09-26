// The run board refuses a project whose attached harness draws a custom-named
// model with a key from a named variable: credentials are never forwarded, so
// that study runs from the exported CLI. Pure: no engine, no files on disk.
import assert from 'node:assert/strict'
import test from 'node:test'
import { exportedBenchmarkExperiment } from '../../src/research-benchmark-dispatch.js'

const files = harness => ({ 'manifest.json': '{}', 'project.json': '{}', 'cli.mjs': '', 'prompts.mjs': '', 'study.mjs': '', 'runner.mjs': '', 'module-host.mjs': '', 'harness/surfaces.json': JSON.stringify(harness) })
const project = () => ({ sha256: 'f'.repeat(64), spec: { name: 'Study', protocol: { maxDurationMs: 60000 }, conditions: [{ id: 'http-lab-medium', adapter: { kind: 'command', command: 'node', args: ['harness/draw.mjs', '--surface', 'http', '--model', 'lab', '--effort', 'medium'], env: ['HOME'] } }] } })
const submit = harness => exportedBenchmarkExperiment({ project: project(), directory: '/srv/study', command: 'node', files: files(harness), projectId: 'p1' })

test('a harness with a credential-named custom model on an http condition is refused; the same harness without one is accepted', async () => {
  await assert.rejects(submit({ models: [{ id: 'lab', credential: 'LAB_KEY' }], conditions: [{ id: 'http-lab-medium', surface: 'http', model: 'lab' }] }), /does not forward credentials.*exported CLI/)
  const accepted = await submit({ models: [], conditions: [{ id: 'claude-x-low', surface: 'claude-cli', model: 'x' }] })
  assert.equal(accepted.runner.kind, 'process'); assert.deepEqual(accepted.runner.envKeys, ['HOME'])
  const unrelated = await submit({ models: [{ id: 'lab', credential: 'LAB_KEY' }], conditions: [{ id: 'claude-x-low', surface: 'claude-cli', model: 'x' }] })
  assert.ok(unrelated.runner, 'a registered model that no condition uses does not block the run board')
})
