import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build, stop } from 'esbuild'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../..', import.meta.url))
const environment = '0123456789abcdef0123456789abcdef'
const warning = 'The environment ID was entered by the person. The provider has not confirmed its repository binding.'
let context
let scratch
let bundle

before(async () => {
  scratch = await mkdtemp(join(root, '.cloud-ui-test-'))
  const result = await build({
    entryPoints: [join(root, 'src/cloud-tasks.js')],
    bundle: true, write: false, format: 'iife', globalName: 'cloudUI',
    loader: { '.css': 'empty' }, logLevel: 'silent',
  })
  bundle = result.outputFiles[0].text
  context = await chromium.launchPersistentContext(join(scratch, 'browser'), { headless: true })
  await context.route('**/*', route => route.fulfill({
    contentType: 'text/html', body: '<main id="root"><div class="agent-strip"></div></main>',
  }))
})

after(async () => {
  await context?.close()
  stop()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function mount(surface, uncertain = false) {
  const page = await context.newPage()
  await page.goto('https://cloud-ui.invalid')
  await page.evaluate(({ environment, warning, uncertain }) => {
    localStorage.clear()
    localStorage.setItem('mc.write.cloud-launch', 'enabled')
    localStorage.setItem('mc.cloud.last', JSON.stringify({ environment, repository: 'Owner/remembered-repository', branch: 'remembered-topic' }))
    window.mcShell = { getBridgeProof() {} }
    window.calls = []
    window.postAction = async (action, body) => {
      window.calls.push({ action, body })
      if (action === 'cloud-accounts') return { ok: true, receipt: {
        accounts: [{ name: 'chosen', canServe: true }],
        defaultAccount: 'chosen', environments: [], environmentsComplete: false,
      } }
      if (action === 'cloud-launch') return { ok: true, receipt: {
        launched: !uncertain, taskId: uncertain ? null : 'task-ui', state: uncertain ? 'UNKNOWN' : 'SUBMITTED',
        environment: body.environment, repository: body.repository, branch: body.branch, account: { name: body.account },
        repositoryBinding: { source: 'person-entered', confirmation: 'unconfirmed', providerConfirmed: false, message: warning },
      } }
      return { ok: true, receipt: { tasks: [], account: { name: body.account } } }
    }
  }, { environment, warning, uncertain })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(surface => {
    const root = document.querySelector('#root')
    if (surface === 'agent') window.unmount = cloudUI.mountCloudTaskSurface(root, { live: true, postAction })
    else {
      window.box = cloudUI.cloudControlsBox({ postAction })
      root.append(window.box)
    }
  }, surface)
  const env = page.getByRole('textbox', { name: 'Codex Cloud environment ID' })
  const branch = surface === 'agent' ? page.getByLabel('Branch', { exact: true }) : page.getByRole('textbox', { name: 'Branch the cloud task runs against' })
  const account = surface === 'agent' ? page.getByRole('combobox', { name: 'Codex account to run this task under' }) : page.getByRole('combobox', { name: 'Codex account', exact: true })
  const repository = page.getByRole('textbox', { name: 'Repository the cloud task runs against' })
  const prompt = surface === 'agent' ? page.getByLabel('Prompt', { exact: true }) : page.getByRole('textbox', { name: 'Cloud task prompt' })
  await account.locator('option[value="chosen"]').waitFor({ state: 'attached' })
  return { page, env, repository, branch, account, prompt }
}

for (const surface of ['agent', 'fleet']) {
  test(`${surface}: typed ID, remembered branch, manual account choice and binding receipt`, async () => {
    const { page, env, repository, branch, account, prompt } = await mount(surface)
    try {
      assert.equal(await env.inputValue(), environment)
      assert.equal(await branch.inputValue(), 'remembered-topic')
      assert.equal(await repository.inputValue(), 'Owner/remembered-repository')
      assert.equal(await account.inputValue(), '', 'the engine default must not pick an account for the person')
      assert.equal((await account.locator('option').allTextContents()).some(text => /Automatic/i.test(text)), false)
      await page.getByRole('button', { name: 'Choose a Codex account', exact: true }).click()
      assert.match(await page.locator(surface === 'agent' ? '[data-cloud-launch-output]' : '[data-cloud="out"]').textContent(), /Choose a Codex account/)
      assert.equal(await page.evaluate(() => calls.filter(call => call.action === 'cloud-launch').length), 0)

      await env.fill('f'.repeat(32))
      assert.equal(await branch.inputValue(), 'remembered-topic', 'typing an ID must not erase or invent a branch')
      await account.selectOption('chosen')
      await repository.fill('Owner/declared-repository')
      await prompt.fill('read the readme')
      await page.getByRole('button', { name: 'Launch on Codex Cloud', exact: true }).click()
      const output = page.locator(surface === 'agent' ? '[data-cloud-launch-output]' : '[data-cloud="out"]')
      assert.match(await output.textContent(), /provider has not confirmed its repository binding/)
      assert.match(await output.textContent(), /ToolsEnabled cannot confirm that this environment points at Owner\/declared-repository/)
      await page.getByRole('button', { name: 'Confirm launch', exact: true }).click()
      const receipt = page.locator(surface === 'agent' ? '[data-cloud-receipt]' : '[data-cloud="receipt"]')
      await receipt.waitFor({ state: 'visible' })
      assert.match(await receipt.textContent(), /The environment ID was entered by the person/)
      assert.match(await receipt.textContent(), /provider has not confirmed its repository binding/)
      assert.deepEqual(await page.evaluate(() => calls.find(call => call.action === 'cloud-launch').body), {
        environment: 'f'.repeat(32), environmentSource: 'person-entered', repository: 'Owner/declared-repository', branch: 'remembered-topic',
        prompt: 'read the readme', account: 'chosen', confirmed: true,
      })
      assert.equal(await env.inputValue(), 'f'.repeat(32), 'a reply must not reset the typed value')
      assert.equal(await repository.inputValue(), 'Owner/declared-repository')
      assert.match(await receipt.textContent(), /Owner\/declared-repository/)
    } finally { await page.close() }
  })

  test(`${surface}: an uncertain launch shows the binding warning and discourages a second launch`, async () => {
    const { page, repository, account, prompt } = await mount(surface, true)
    try {
      await account.selectOption('chosen')
      await prompt.fill('read the readme')
      await page.getByRole('button', { name: 'Launch on Codex Cloud', exact: true }).click()
      await page.getByRole('button', { name: 'Confirm launch', exact: true }).click()
      const output = page.locator(surface === 'agent' ? '[data-cloud-launch-output]' : '[data-cloud="out"]')
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('may or may not have been created'), surface === 'agent' ? '[data-cloud-launch-output]' : '[data-cloud="out"]')
      assert.match(await output.textContent(), /provider has not confirmed its repository binding/)
      assert.match(await output.textContent(), /refresh the list before trying again/)
      assert.equal(await page.evaluate(() => calls.filter(call => call.action === 'cloud-launch').length), 1)
    } finally { await page.close() }
  })
}
