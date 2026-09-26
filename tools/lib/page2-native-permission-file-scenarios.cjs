'use strict'

// These cases press real controls and observe the installed host. The fixture
// files belong to this run's selected QA workspace and are never executed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { navigate } = require('./page2-native-scenarios.cjs')
const { detail } = require('./page2-native-functions-scenarios.cjs')

function readPermissionFlags(storage = globalThis.localStorage) {
  // The maintained durable Storage facade exposes key()/length, not named
  // properties. Object.keys would enumerate its methods and silently lose
  // every actual saved permission.
  const keys = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (typeof key === 'string' && key.startsWith('mc.write.')) keys.push(key)
  }
  return Object.fromEntries(keys.sort().map(key => [key, storage.getItem(key)]))
}
async function permissionFlags(context) {
  return context.page.evaluate(readPermissionFlags)
}
async function settings(context) {
  await navigate(context, 'settings')
  await context.page.locator('.settings-page').waitFor()
}
async function agentPermission(context) {
  await context.type(context.page.getByRole('searchbox', { name: 'Search all settings', exact: true }), 'Run an agent session')
  const input = context.page.locator('[data-setting-id="write_agent-session"] input[type="checkbox"]')
  await context.page.locator('[data-setting-id="write_agent-session"] .settings-toggle').waitFor()
  return input
}
const expertTrigger = context => context.page.locator('[data-settings-mode-choice="expert"]')
const expertDialog = context => context.page.getByRole('dialog', { name: 'Open Expert settings', exact: true })

async function files(context) {
  await detail(context)
  const panel = context.page.locator('[data-files-panel="agent"]')
  await panel.waitFor()
  const folders = await context.page.evaluate(() => window.mcFiles.folders())
  assert.equal(folders?.ok, true, 'The actual host must enumerate the selected QA folder')
  const chosen = folders.folders.filter(folder => folder.kind === 'chosen')
  assert.equal(chosen.length, 1)
  await context.select(panel.locator('[data-files-folder="chooser"]'), chosen[0].id)
  return panel
}
async function fileRow(context, panel, name, content) {
  fs.writeFileSync(path.join(context.paths.workspace, name), content, { flag: 'wx', mode: 0o600 })
  await panel.locator('[data-files-action="refresh"]').click()
  const row = panel.locator(`[data-files-row="${name}"]`)
  await row.waitFor()
  return row
}

const scenarios = [
  { id: 'settings-agent-permission-draft-discard', title: 'Stage and discard the agent-session permission while retaining the actual saved flags', controls: ['settings.permission.draft', 'settings.permission.discard'], requires: ['setup'], async run(context) {
    await settings(context)
    const before = await permissionFlags(context)
    const checkbox = await agentPermission(context)
    const checked = await checkbox.isChecked()
    assert.equal(checked, before['mc.write.agent-session'] === 'enabled')
    try {
      await context.page.locator('[data-setting-id="write_agent-session"] .settings-toggle').click()
      assert.equal(await checkbox.isChecked(), !checked)
      assert.equal(await context.page.locator('[data-settings-save]').isEnabled(), true)
      assert.equal(await context.page.locator('[data-settings-discard]').isEnabled(), true)
      assert.match(await context.page.locator('[data-settings-draft-status]').innerText(), /^Unsaved changes/)
      assert.deepEqual(await permissionFlags(context), before, 'A displayed permission draft must not change any saved write flag')
      await context.capture('native-permission-unsaved-draft')
    } finally {
      const discard = context.page.locator('[data-settings-discard]')
      if (await discard.isEnabled()) await discard.click()
    }
    const restored = await agentPermission(context)
    assert.equal(await restored.isChecked(), checked)
    assert.equal(await context.page.locator('[data-settings-save]').isEnabled(), false)
    assert.equal(await context.page.locator('[data-settings-discard]').isEnabled(), false)
    assert.deepEqual(await permissionFlags(context), before, 'Discard must leave the actual saved permissions unchanged')
  } },
  { id: 'settings-expert-cancel', title: 'Cancel Expert entry and restore its trigger focus without changing saved permissions', controls: ['settings.expert.cancel'], requires: ['settings-agent-permission-draft-discard'], async run(context) {
    await settings(context)
    const before = await permissionFlags(context)
    const mode = await context.page.locator('.settings-page').getAttribute('data-settings-mode')
    await expertTrigger(context).click()
    const dialog = expertDialog(context)
    await dialog.waitFor()
    await dialog.locator('[data-expert-cancel]').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await expertTrigger(context).evaluate(element => element === document.activeElement), true)
    assert.equal(await context.page.locator('.settings-page').getAttribute('data-settings-mode'), mode)
    assert.deepEqual(await permissionFlags(context), before)
  } },
  { id: 'settings-expert-code-refusal', title: 'Reject the wrong Expert code and Escape the local confirmation with permissions unchanged', controls: ['settings.expert.code-refusal', 'settings.expert.escape'], requires: ['settings-expert-cancel'], async run(context) {
    await settings(context)
    const before = await permissionFlags(context)
    const mode = await context.page.locator('.settings-page').getAttribute('data-settings-mode')
    await expertTrigger(context).click()
    const dialog = expertDialog(context)
    await dialog.waitFor()
    const shown = await dialog.locator('label strong').innerText()
    assert.match(shown, /^\d{4}$/)
    await context.type(dialog.locator('#settings-expert-code'), shown === '0000' ? '0001' : '0000')
    await dialog.getByRole('button', { name: 'Open Expert', exact: true }).click()
    assert.equal(await dialog.locator('[data-expert-error]').innerText(), 'Enter the four digits shown above.')
    assert.equal(await context.page.locator('.settings-page').getAttribute('data-settings-mode'), mode)
    assert.equal(await dialog.locator('#settings-expert-code').evaluate(element => element === document.activeElement), true)
    await context.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await expertTrigger(context).evaluate(element => element === document.activeElement), true)
    assert.deepEqual(await permissionFlags(context), before)
  } },
  { id: 'settings-expert-visit', title: 'Open Expert with its displayed local code and require fresh entry on returning to Settings', controls: ['settings.expert.open', 'settings.expert.visit-only'], requires: ['settings-expert-code-refusal'], async run(context) {
    await settings(context)
    const before = await permissionFlags(context)
    const savedMode = await context.page.evaluate(() => localStorage.getItem('mc.settings.mode'))
    await expertTrigger(context).click()
    const dialog = expertDialog(context)
    await dialog.waitFor()
    const shown = await dialog.locator('label strong').innerText()
    assert.match(shown, /^\d{4}$/)
    await context.type(dialog.locator('#settings-expert-code'), shown)
    await dialog.getByRole('button', { name: 'Open Expert', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await context.page.locator('.settings-page').getAttribute('data-settings-mode'), 'expert')
    assert.equal(await expertTrigger(context).getAttribute('aria-pressed'), 'true')
    assert.equal(await expertTrigger(context).evaluate(element => element === document.activeElement), true)
    assert.equal(await context.page.evaluate(() => localStorage.getItem('mc.settings.mode')), savedMode)
    assert.deepEqual(await permissionFlags(context), before)
    await navigate(context, 'metrics')
    await settings(context)
    assert.equal(await context.page.locator('.settings-page').getAttribute('data-settings-mode'), savedMode === 'simple' ? 'simple' : 'advanced')
    assert.equal(await expertTrigger(context).getAttribute('aria-pressed'), 'false')
    assert.deepEqual(await permissionFlags(context), before)
  } },
  { id: 'agent-file-script-refusal-read', title: 'Refuse OS Open for an actual script while reading its exact bytes in the app', controls: ['agent.files.executable-refusal', 'agent.files.script-read'], requires: ['agent-detail-route'], async run(context) {
    const panel = await files(context)
    const name = 'qa-functions-script.sh'
    const content = `# Owned QA text only: ${context.paths.checkWord}\n`
    const row = await fileRow(context, panel, name, content)
    assert.equal(await row.locator('[data-files-action="open"]').isEnabled(), false)
    assert.match(await row.locator('[data-files-why-action="open"]').innerText(), /can start a program.*will not open it/)
    const read = row.locator('[data-files-action="read"]')
    assert.equal(await read.isEnabled(), true)
    await read.click()
    const dialog = context.page.getByRole('dialog', { name, exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.locator('[data-files-report]').textContent(), content)
    await dialog.locator('[data-files-action="close"]').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await read.evaluate(element => element === document.activeElement), true)
  } },
  { id: 'agent-file-binary-refusals', title: 'Keep actual unknown-binary Open and Read controls disabled with their visible reasons', controls: ['agent.files.binary-open-refusal', 'agent.files.binary-read-refusal'], requires: ['agent-detail-route'], async run(context) {
    const panel = await files(context)
    const row = await fileRow(context, panel, 'qa-functions-unknown.bin', Buffer.from([0, 255, 17, 0, 127]))
    assert.equal(await row.locator('[data-files-action="open"]').isEnabled(), false)
    assert.equal(await row.locator('[data-files-action="read"]').isEnabled(), false)
    assert.match(await row.locator('[data-files-why-action="open"]').innerText(), /can start a program.*will not open it/)
    assert.equal(await row.locator('[data-files-why-action="read"]').innerText(), 'Use Show in folder to open this one.')
    assert.equal(await row.locator('[data-files-action="reveal"]').isEnabled(), true)
    assert.equal(await context.page.locator('[data-files-report]').count(), 0)
  } },
  { id: 'agent-file-disappeared-read', title: 'Explain an actual file disappearance on Read and recover the list with Refresh', controls: ['agent.files.missing-read-refusal', 'agent.files.refresh-after-missing'], requires: ['agent-detail-route'], async run(context) {
    const panel = await files(context)
    const name = 'qa-functions-disappearing.txt'
    const row = await fileRow(context, panel, name, 'Owned transient QA fixture.\n')
    fs.unlinkSync(path.join(context.paths.workspace, name))
    await row.locator('[data-files-action="read"]').click()
    const status = panel.locator('[data-files-status="panel"][data-refusal-code="FILES_NOT_THERE"]')
    await status.waitFor()
    assert.match(await status.innerText(), /not in the folder any more.*Refresh/)
    assert.equal(await context.page.locator('[data-files-report]').count(), 0)
    assert.equal(await panel.getAttribute('inert'), null)
    await panel.locator('[data-files-action="refresh"]').click()
    await row.waitFor({ state: 'detached' })
    assert.equal(await panel.locator('[data-files-status="panel"]').getAttribute('data-refusal-code'), null)
  } },
]

module.exports = { scenarios, readPermissionFlags }
