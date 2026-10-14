/*
 * THE GUIDE MAY NOT OFFER A DOOR THAT IS NOT THERE.
 *
 * public/help/getting-started.html is the only document written for a stranger,
 * and it sets itself a rule in its own header comment: it may not promise a
 * remedy that does not exist, and where there is no answer today it says so in
 * those words rather than implying a step the reader will go looking for and
 * not find.
 *
 * It broke that rule in the worst place. Section 1 said plainly that there is
 * no download page, and then section 10 -- the Getting help section, which a
 * reader only reaches after being told there is no support address at all --
 * sent them to a published GitHub repository and to a download URL. Neither
 * existed. A person who was already stuck was given two more places to fail.
 *
 * Nothing caught it, because the two sentences are eight screens apart and no
 * gate compares them. That is what this file is for. It checks the page against
 * itself and against README.md, so the honest answer and the offered remedy
 * cannot drift apart again while the product is still unpublished.
 *
 * WHEN THE PRODUCT DOES PUBLISH, THIS TEST IS SUPPOSED TO FAIL. That is the
 * point: it fails on the day the honest answer changes, and whoever changes it
 * is then told to update the guide in the same commit rather than leaving it
 * stale in the other direction.
 *
 * THAT DAY CAME FOR THE DOWNLOAD PAGE, and the mechanism worked. A commit
 * rewrote the closing section of the guide to give the official download
 * address while leaving section 1 saying "There is no download page yet", and
 * this file went red on the URL assertion rather than letting the two halves of
 * one page disagree in front of a reader. The download assertions below are now
 * pointed at the published truth and at the drift that is possible from here:
 * section 1 must name the address, and must not still deny it.
 *
 * Publishing a download page and publishing the source are two different
 * events; this file used to treat them as one, which is why the guide could go
 * half-stale without anything noticing.
 *
 * AND IT CAME FOR THE SOURCE AND FOR SUPPORT, and here the mechanism held the
 * stale words in place instead of failing. The app and engine repositories went
 * public on 2026-10-13, support@toolsenabled.ai and toolsenabled.ai/support
 * exist, and the 1.0.50 candidate still told every reader of Getting help
 * "There is no support address" and "The source repositories are private",
 * while the README on the public repository said "This repository is not yet
 * public" (1.0.50 release review, release-ops F1). The assertions that pinned
 * those sentences now point at the published truth, and the owner's rule is
 * asserted directly: the guide and the README must never say the source is
 * private or that there is no support address.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DELETE_BUTTON, resetTitle } from '../../src/account-reset-copy.js'
import { UPDATE_CONTROL_LABEL, UPDATE_SECTION } from '../../src/update-settings.js'
import updateCheck from '../../shell/update-check.cjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HELP_PAGE = path.join(REPO_ROOT, 'public', 'help', 'getting-started.html')
const README = path.join(REPO_ROOT, 'README.md')
const INSTALLER_SCRIPT = path.join(REPO_ROOT, 'build', 'installer.nsh')
const SETTINGS_VIEW = path.join(REPO_ROOT, 'src', 'views', 'settings.js')

/* The page is hand-wrapped prose, so a claim can straddle a newline. Compare on
   collapsed whitespace or the assertions become tests of the line width. */
const flatten = (text) => text.replace(/\s+/g, ' ')

/* The owner's rule, as the shapes the stale sentences actually took. Each is
   matched within one sentence, so "private" elsewhere on the page (there is
   none today) cannot be mistaken for a claim about the source. */
const SAYS_SOURCE_IS_CLOSED = [
  /\bnot yet public\b/i,
  /\b(?:source|repositor(?:y|ies))\b[^.]*\b(?:is|are)\s+(?:still\s+)?(?:private|closed)\b/i,
  /\bholds only the organization/i,
  /\bno product repository\b/i,
]
const SAYS_NO_SUPPORT = [/\bno support address\b/i, /\bthere is no support\b/i]

const SOURCE_ADDRESSES = [
  'github.com/ToolsEnabled/toolsenabled-app',
  'github.com/ToolsEnabled/toolsenabled-engine',
]

test('README says the source is public and where help is, and never that it is private', () => {
  const readme = flatten(readFileSync(README, 'utf8'))

  for (const address of [...SOURCE_ADDRESSES, 'support@toolsenabled.ai', 'toolsenabled.ai/security']) {
    assert.ok(readme.includes(address),
      `README does not name ${address}. The repository is public; a reader of it must be told where the source and help are.`)
  }
  for (const stale of [...SAYS_SOURCE_IS_CLOSED, ...SAYS_NO_SUPPORT]) {
    assert.doesNotMatch(readme, stale,
      'README says the source is private or that there is no support. The owner\'s rule: it must never say either.')
  }
})

test('the getting-started page points at the download page it has, and does not still deny it', () => {
  const help = flatten(readFileSync(HELP_PAGE, 'utf8'))

  /* Section 1 is the honest answer, and the honest answer changed. A reader who
     has no installer has to be told where it is. */
  assert.ok(
    /toolsenabled\.ai\/download/i.test(help),
    'section 1 must send the reader to the official download address',
  )

  /* The same drift, in the direction that is now possible. Leaving the old
     denial in section 1 while the closing section gives the address puts two
     statements that cannot both be true in front of one reader -- which is the
     defect this file exists to catch. */
  assert.ok(
    !help.includes('There is no download page'),
    'section 1 still denies the download page the rest of the guide links to',
  )
  assert.ok(
    !help.includes('has not been published for public download'),
    'the guide still tells the reader the product cannot be downloaded publicly',
  )

  /* Getting help is where a stuck reader goes. Everything it names must be
     real, and everything real must be named: the support address, the support
     and security pages, and the two public repositories. */
  const start = help.indexOf('11. Getting help')
  assert.notEqual(start, -1, 'the Getting help section is missing')
  const gettingHelp = help.slice(start)
  for (const address of ['support@toolsenabled.ai', 'toolsenabled.ai/support', 'toolsenabled.ai/security', ...SOURCE_ADDRESSES]) {
    assert.ok(gettingHelp.includes(address), `Getting help does not name ${address}`)
  }

  /* The whole page, comments included: the stale sentence once lived in the
     header comment as the example of a missing answer. */
  for (const stale of [...SAYS_SOURCE_IS_CLOSED, ...SAYS_NO_SUPPORT]) {
    assert.doesNotMatch(help, stale,
      'the guide says the source is private or that there is no support address. The owner\'s rule: it must never say either.')
  }
})

test('the starting-over heading promises only what its own paragraph delivers', () => {
  const help = flatten(readFileSync(HELP_PAGE, 'utf8'))

  /* The paragraph says setup cannot be re-run and each answer is changed in
     Settings. A heading offering to restart the questions contradicts it one
     line later, which is exactly how a reader loses trust in a guide. */
  assert.ok(
    help.includes('a reinstall does not clear your answers'),
    'the starting-over paragraph changed; re-check that its heading still matches it',
  )
  assert.ok(
    !help.includes('<h3>Start the questions again</h3>'),
    'the heading promises restarting the questions, which the paragraph beneath it then refuses',
  )
})

/* UNINSTALLING ON WINDOWS ASKS, AND THE GUIDE SAID IT NEVER DELETES.
 *
 * The note under Uninstall said "Uninstalling does not delete your data ...
 * reinstalling picks up where you left off" and told the reader to delete two
 * folders by hand. build/installer.nsh does something else on Windows: with no
 * recorded choice it asks "Remove your saved ToolsEnabled data from this
 * computer?", and a recorded "Remove everything" deletes those same two
 * folders without asking (1.0.50 release review, release-ops F3). A reader who
 * trusted the guide could lose the vault and the signed record. So the section
 * is held to the installer's own question and to the Settings row's own
 * labels, and "by hand" survives only for Linux, where removing the package
 * really does leave everything. */
test('the Uninstall section describes the Windows question and the Settings choice, and keeps "by hand" for Linux', () => {
  const help = flatten(readFileSync(HELP_PAGE, 'utf8'))
  const start = help.indexOf('<h3>Uninstall</h3>')
  assert.notEqual(start, -1, 'the Uninstall section is missing')
  const section = help.slice(start, help.indexOf('<h2', start))

  const installer = flatten(readFileSync(INSTALLER_SCRIPT, 'utf8'))
  const question = 'Remove your saved ToolsEnabled data from this computer?'
  assert.ok(installer.includes(`"${question}`), 'build/installer.nsh no longer asks this question; re-read it and update the guide')
  assert.ok(section.includes(question), 'the guide does not quote the question the Windows uninstaller asks')

  const settings = flatten(readFileSync(SETTINGS_VIEW, 'utf8'))
  const row = settings.slice(settings.indexOf("id: 'uninstall_data'"), settings.indexOf("def: 'ask'", settings.indexOf("id: 'uninstall_data'")))
  assert.match(row, /name: 'When I uninstall ToolsEnabled'/)
  assert.match(row, /section: 'Data & Privacy'/)
  assert.ok(section.includes('Data &amp; Privacy') && section.includes('When I uninstall ToolsEnabled'),
    'the guide does not name the Settings row that decides what the uninstaller does')
  for (const label of ['Ask me then', 'Keep my data', 'Remove everything']) {
    assert.ok(row.includes(`'${label}'`), `the Settings row no longer offers "${label}"`)
    assert.ok(section.includes(label), `the guide does not explain the "${label}" answer`)
  }

  assert.doesNotMatch(section, /Uninstalling does not delete your data/,
    'on Windows uninstalling can delete the data; the guide may not say it never does')
  const linux = section.slice(section.indexOf('On Linux, removing the package never deletes it.'))
  assert.ok(linux.length < section.length, 'the Linux paragraph about deleting data is missing')
  assert.match(linux, /by hand/, 'Linux, where removal keeps everything, lost its by-hand advice')
  assert.doesNotMatch(section.slice(0, section.indexOf('On Linux, removing the package never deletes it.')), /by hand/,
    'by-hand deletion is offered for Windows, whose uninstaller can delete the data itself')

  /* The Linux route names real controls on the Account page. */
  assert.ok(section.includes(resetTitle().split(' from ')[0]), 'the guide does not name the data-removal card by its title')
  assert.ok(section.includes(DELETE_BUTTON), 'the guide does not name the button that lists the folders')
})

/* THE GUIDE NEVER SAID HOW TO UPDATE (1.0.50 release review, release-ops F13).
 *
 * The in-app updater is Windows-only (shell/update-check.cjs refuses every other
 * platform) and Linux Settings says "This copy cannot install updates from
 * inside the app", so a Linux reader was never told to fetch a new .deb, and a
 * Windows reader was never told what the launch question is or where its
 * remembered answer lives. The Updating section is held to the updater's own
 * dialog words and the Settings row's own label, so renaming either fails here. */
test('the guide says how to update on each platform, in the words the product uses', () => {
  const help = flatten(readFileSync(HELP_PAGE, 'utf8'))
  const start = help.indexOf('<h3>Updating</h3>')
  assert.notEqual(start, -1, 'the Updating section is missing')
  const section = help.slice(start, help.indexOf('<h', start + 1))

  assert.ok(section.includes(updateCheck.CHECK_MESSAGE), 'the guide does not quote the launch question')
  assert.ok(section.includes(updateCheck.REMEMBER_LABEL), 'the guide does not name the box that keeps the answer')
  for (const button of updateCheck.CHECK_BUTTONS) {
    assert.ok(section.includes(button), `the guide does not explain the "${button}" answer`)
  }
  assert.match(section, /at most once a day/, 'the remembered "check" answer is throttled to once a day; say so')
  assert.ok(section.includes(UPDATE_SECTION) && section.includes(UPDATE_CONTROL_LABEL),
    'the guide does not name the Settings row where the answer can be changed')

  const linux = section.slice(section.indexOf('On Linux'))
  assert.ok(linux.length < section.length, 'the Linux paragraph is missing')
  assert.match(linux, /does not update itself/)
  assert.ok(linux.includes('toolsenabled.ai/download') && linux.includes('.deb'),
    'a Linux reader is not told to fetch the new .deb from the download page')
})
