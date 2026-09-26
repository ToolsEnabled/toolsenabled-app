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
 * THE SOURCE REPOSITORIES ARE STILL PRIVATE, so the README half of this file is
 * unchanged and still meaningful. Publishing a download page and publishing the
 * source are two different events; this file used to treat them as one, which
 * is why the guide could go half-stale without anything noticing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HELP_PAGE = path.join(REPO_ROOT, 'public', 'help', 'getting-started.html')
const README = path.join(REPO_ROOT, 'README.md')

/* The page is hand-wrapped prose, so a claim can straddle a newline. Compare on
   collapsed whitespace or the assertions become tests of the line width. */
const flatten = (text) => text.replace(/\s+/g, ' ')

test('the guide still describes the product as unpublished, matching README', () => {
  const readme = flatten(readFileSync(README, 'utf8'))

  assert.ok(
    readme.includes('This repository is not yet public'),
    'README no longer says the repository is private. If the product has published, the getting-started page must be updated in the same change: it currently tells a stranger there is nothing to find.',
  )
  assert.ok(
    readme.includes('holds only the organization'),
    'README no longer says the GitHub organization holds only its profile page. Re-check what public/help/getting-started.html promises a reader who goes looking.',
  )
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

  assert.ok(
    !help.includes('the source code is published'),
    'the page claims the source code is published; README says the GitHub organization holds only its profile page',
  )

  /* A reader who reaches Getting help has already been told there is no support
     address. Whatever it sends them to next must be real. The source is still
     private, so the page must still say so rather than sending them to read it. */
  const gettingHelp = help.slice(help.indexOf('11. Getting help'))
  assert.ok(gettingHelp.length > 0, 'the Getting help section is missing')
  assert.ok(
    gettingHelp.includes('source repositories are private'),
    'Getting help must say the source is private rather than sending the reader to look for it',
  )
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
