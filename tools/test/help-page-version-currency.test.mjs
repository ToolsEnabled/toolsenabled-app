import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HELP_PAGE = path.join(REPO_ROOT, 'public', 'help', 'getting-started.html')

/* THE HELP PAGE SHIPS INSIDE THE APPLICATION AND OUTLIVES THE RELEASE IT WAS
 * WRITTEN IN. It says so itself: "This page ships inside the application and is
 * served from your own computer."
 *
 * It already knows the right way to name the installer, in its own words two
 * paragraphs above the command block: "The file is named ToolsEnabled Setup
 * <version>.exe". A concrete version number written anywhere else on the page is
 * a fact that stops being true at the next release and that nobody is reminded
 * to update -- and this page is read by somebody who has just been handed an
 * installer and is trying to check they got the right file. Telling them to
 * checksum a filename from a release they do not have is the one moment the page
 * cannot afford to be stale.
 *
 * Measured at app 6909208e: the command block named 1.0.6 while package.json
 * said 1.0.42 -- thirty-six releases apart, and five months of drift that no
 * check would have caught.
 *
 * This rule is about the PAGE'S OWN copy, not about the product's version. It
 * does not read package.json on purpose: a test that compared the two would go
 * green by pinning today's number into the page, which is the defect. */
test('the shipped help page names no concrete product version in its copy', () => {
  const html = readFileSync(HELP_PAGE, 'utf8')
  const found = []
  html.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\b(?:ToolsEnabled[ -]Setup[ -]\d+\.\d+\.\d+\.exe|toolsenabled_\d+\.\d+\.\d+_amd64\.deb)/g)) {
      found.push(`line ${index + 1}: ${match[0]}`)
    }
  })
  assert.deepEqual(
    found,
    [],
    'use the version placeholder in Windows and Linux installer filenames, the way this page already does ' +
    'where it introduces the file. A pinned number here goes stale at the next release and ' +
    `nothing else checks it. Found:\n  ${found.join('\n  ')}`
  )
})

/* The placeholder form has to actually be there, or the rule above passes on a
 * page that stopped telling the reader what the file is called at all. */
test('the help page still tells the reader the installer filename shape', () => {
  const html = readFileSync(HELP_PAGE, 'utf8')
  assert.match(
    html,
    /ToolsEnabled-Setup-<em>&lt;version&gt;<\/em>\.exe/,
    'the page introduces the installer by name using the <version> placeholder'
  )
  assert.ok(
    html.includes('Get-FileHash') && html.includes('Get-Item'),
    'the two verification commands are still on the page'
  )
  assert.match(html, /toolsenabled_&lt;version&gt;_amd64\.deb/)
  assert.ok(html.includes('sha256sum') && html.includes('wc -c'), 'Linux file verification remains available')
})
