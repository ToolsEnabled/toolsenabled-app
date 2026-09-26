import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function run(script, source) {
  return spawnSync(process.execPath, [script, '--source', source], {
    encoding: 'utf8',
    env: { ...process.env, TOOLSENABLED_SOURCE: '' }
  })
}

test('check-subscription-claims runs for the same file through a redundant path spelling', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'check-subscription-claims-'))
  try {
    const tools = path.join(fixture, 'tools')
    const engine = path.join(fixture, 'engine')
    mkdirSync(path.join(tools, 'test'), { recursive: true })
    mkdirSync(path.join(engine, 'src', 'lib'), { recursive: true })
    for (const name of ['check-subscription-claims.mjs', 'gen-subscription-catalog.mjs']) {
      writeFileSync(path.join(tools, name), readFileSync(path.join(REPO_ROOT, 'tools', name)))
    }

    const catalog = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'subscription-catalog.json')))
    writeJson(path.join(fixture, 'config', 'subscription-catalog.json'), catalog)
    writeJson(path.join(fixture, 'config', 'subscription-promises.json'), { promises: [] })
    for (const relative of ['src/views/subscribe.js', 'src/subscription-signup.js']) {
      mkdirSync(path.dirname(path.join(fixture, relative)), { recursive: true })
      writeFileSync(path.join(fixture, relative), 'export const render = catalog => catalog\n')
    }

    const entitlement = {
      PAID_PRODUCT: catalog.paidProduct,
      UNLICENSED_INSTALL: catalog.unlicensedInstall,
      UNLICENSED_INSTALL_STATEMENT: catalog.unlicensedInstallStatement,
      NEVER_GATED: catalog.neverGated,
      GATED_CAPABILITIES: catalog.capabilities,
      TIERS: Object.fromEntries(catalog.plans.map(plan => [plan.id, plan]))
    }
    writeFileSync(
      path.join(engine, 'src', 'lib', 'entitlement.js'),
      `module.exports = ${JSON.stringify(entitlement, null, 2)}\n`
    )

    const direct = path.join(tools, 'check-subscription-claims.mjs')
    const respelledGate = `${path.dirname(direct).replaceAll(path.sep, '/')}/./${path.basename(direct)}`
    const nodeArgs = ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(respelledGate)}`)}`, direct]

    const healthy = run(direct, engine)
    assert.equal(healthy.status, 0, healthy.stderr)
    assert.match(healthy.stdout, /Every claim is backed\./)

    rmSync(path.join(engine, 'src', 'lib', 'entitlement.js'))
    const blindCondition = spawnSync(process.execPath, [...nodeArgs, '--source', engine], {
      encoding: 'utf8',
      env: { ...process.env, TOOLSENABLED_SOURCE: '' }
    })
    assert.match(
      blindCondition.stderr,
      /Subscription claims guard error: no src\/lib\/entitlement\.js under the configured capability source:/,
      'the same gate respelled with a redundant /./ segment must execute main() and report the missing entitlement',
    )
    assert.equal(
      blindCondition.status,
      2,
      `stdout:\n${blindCondition.stdout}\nstderr:\n${blindCondition.stderr}`,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
