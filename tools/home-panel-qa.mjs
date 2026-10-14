/* The activity panel's EDGES, checked in a browser because nothing else can
 * see them. These three faults are all cascade faults -- a bar re-enabled by a
 * later rule, an edge treatment switched off by a reset, a region wider than
 * its column -- and the DOM stand-in the unit suites run on has no cascade at
 * all, so it reports every one of them as healthy. That is the same blind spot
 * that let the hotload banner ship showing on healthy pages, and the same
 * answer: look at the running page.
 *
 * Checked at a wide width and a narrow one, because the panel changes column
 * and loses lines between them, and an edge that holds at 1440 is not evidence
 * about an edge at 1000.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright'

const temp = process.env.HOME_QA_TEMP || os.tmpdir()
const resolved = await realpath(temp), home = await realpath(os.homedir())
const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
// The check only ever writes under the running account's own directories.
if (!within(resolved, home) && !within(resolved, await realpath(os.tmpdir()))) throw new Error(`Panel QA temp boundary refused: ${resolved} is outside ${home}.`)
const output = await mkdtemp(path.join(resolved, 'home-panel-qa-'))
const origin = process.env.HOME_QA_URL || 'http://127.0.0.1:4623'

/* The widths are the two the owner asked to be judged at. The panel is hidden
   below 900px by the page's own rule, so a narrower check would be measuring
   its absence. */
const WIDTHS = [1440, 1000]

const checks = []
const record = note => { checks.push(note); console.log('· ' + note) }

let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.HOME_QA_CHROMIUM || undefined })
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.goto(origin + '/#/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await page.locator('.home-run').first().waitFor({ timeout: 30000 })
    await page.waitForTimeout(1200)

    const seen = await page.evaluate(() => {
      const log = document.querySelector('.home-feed-wrap .session-log')
      const view = log && log.closest('.session-view')
      const style = log && getComputedStyle(log)
      const edge = which => {
        const s = getComputedStyle(view, which)
        return { drawn: s.content !== 'none', height: parseFloat(s.height) || 0, paints: /gradient/.test(s.backgroundImage) }
      }
      const box = log && log.getBoundingClientRect()
      const rows = [...document.querySelectorAll('.home-run:not([hidden])')]
      return {
        found: Boolean(log),
        scrolls: log ? log.scrollHeight > log.clientHeight + 1 : false,
        barHidden: style ? style.scrollbarWidth === 'none' : false,
        sideways: log ? log.scrollWidth - log.clientWidth : 0,
        overhang: box ? Math.round(box.right - log.parentElement.getBoundingClientRect().right) : 0,
        top: view ? edge('::before') : null,
        bottom: view ? edge('::after') : null,
        collapsedHeight: (() => {
          const shut = rows.find(r => !r.querySelector('.run-fold[open]'))
          return shut ? Math.round(shut.getBoundingClientRect().height) : 0
        })(),
        /* THE PANEL HAS TO USE ITS WIDTH. Everything here was short text left
           aligned in a column twice as wide, so the right half sat empty while
           the list ran out of vertical room. These read the arrangement, not a
           pixel count: the state belongs on the line it describes, and a label
           belongs beside the thing it labels. */
        wide: (() => {
          const row = rows.find(r => !r.querySelector('.run-fold[open]'))
          if (!row) return null
          const top = el => (el && getComputedStyle(el).display !== 'none' ? Math.round(el.getBoundingClientRect().top) : null)
          const identity = row.querySelector('.run-identity'), state = row.querySelector('.run-state')
          const head = row.querySelector('.run-head')
          return {
            grid: getComputedStyle(head).gridTemplateColumns,
            laidOut: getComputedStyle(head).display,
            columns: getComputedStyle(head).gridTemplateColumns.split(' ').length,
            stateOnIdentityLine: top(state) !== null && Math.abs(top(state) - top(identity)) < 8,
            stateRight: state ? Math.round(state.getBoundingClientRect().right) : 0,
            headRight: Math.round(head.getBoundingClientRect().right),
            height: Math.round(row.getBoundingClientRect().height),
          }
        })(),
        answerLabelBesideAnswer: (() => {
          const said = [...document.querySelectorAll('.home-run .run-said')]
            .find(el => getComputedStyle(el).display !== 'none' && el.textContent.trim())
          if (!said) return null
          const label = said.closest('.run-body')?.querySelector('.run-answer-label')
          if (!label || getComputedStyle(label).display === 'none') return null
          return Math.abs(label.getBoundingClientRect().top - said.getBoundingClientRect().top) < 8
        })(),
        /* WHAT THE HIGHLIGHTS ARE DOING. The owner's complaint was that they did
           not like how the panel highlights things, and the measurable shape of
           that was one accent doing four unrelated jobs and two hover surfaces
           firing at once. These read the arrangement, not a colour name. */
        highlight: (() => {
          const wrap = document.querySelector('.home-feed-wrap')
          const accent = getComputedStyle(wrap).getPropertyValue('--home-context-accent').trim()
          const probe = document.createElement('span')
          probe.style.color = accent
          wrap.appendChild(probe)
          const accentRgb = getComputedStyle(probe).color.replace(/\s+/g, '')
          probe.remove()
          const norm = v => (v || '').replace(/\s+/g, '')
          const visible = el => {
            const st = getComputedStyle(el)
            if (st.display === 'none' || st.visibility === 'hidden' || el.hidden) return false
            const b = el.getBoundingClientRect()
            return b.width > 0 && b.height > 0
          }
          const spends = []
          for (const el of wrap.querySelectorAll('*')) {
            if (!visible(el)) continue
            const st = getComputedStyle(el)
            const hit = norm(st.color) === accentRgb && (el.textContent || '').trim() && !el.children.length
              ? 'text'
              : (parseFloat(st.borderBottomWidth) > 0 && norm(st.borderBottomColor) === accentRgb ? 'border'
                : (st.boxShadow !== 'none' && norm(st.boxShadow).includes(accentRgb.slice(4, -1)) ? 'shadow' : null))
            if (hit) spends.push((typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName) + ':' + hit)
          }
          return [...new Set(spends)]
        })(),
        /* THE TIMES HAVE TO READ AS A COLUMN. A track sized to its contents is
           zero wide on a row without a badge and wide on a row with one, which
           drags the timestamp beside it and breaks the column. Distinct right
           edges is exactly that fault, counted. */
        columns: (() => {
          const shut = rows.filter(r => !r.querySelector('.run-fold[open]'))
          const edge = (r, sel) => {
            const el = r.querySelector(sel)
            return el && getComputedStyle(el).display !== 'none' ? Math.round(el.getBoundingClientRect().right) : null
          }
          return {
            when: [...new Set(shut.map(r => edge(r, '.run-when')).filter(Boolean))],
            state: [...new Set(shut.map(r => edge(r, '.run-state')).filter(Boolean))],
          }
        })(),
        /* AND A BADGE MUST NOT COST A LINE. "New update" is two words; it took a
           whole second row once, so the rows a person most wants to find were
           the tallest in the list. Reached the way the view reaches it. */
        badgeCost: (() => {
          const shut = rows.filter(r => !r.querySelector('.run-fold[open]'))
          const before = [...new Set(shut.map(r => Math.round(r.getBoundingClientRect().height)))]
          const touched = []
          for (const r of shut.slice(0, 3)) {
            const u = r.querySelector('.run-updated')
            if (u && u.hidden) { u.hidden = false; touched.push(u) }
          }
          const after = [...new Set(shut.map(r => Math.round(r.getBoundingClientRect().height)))]
          const edges = [...new Set(shut.map(r => {
            const el = r.querySelector('.run-when')
            return el && getComputedStyle(el).display !== 'none' ? Math.round(el.getBoundingClientRect().right) : null
          }).filter(Boolean))]
          for (const u of touched) u.hidden = true
          return { before: before.sort(), after: after.sort(), whenEdgesWithBadge: edges, shown: touched.length }
        })(),
        // A live run must not carry a line repeating the state printed above it.
        repeats: rows.filter(r => {
          const state = r.querySelector('.run-state')?.textContent || ''
          const gap = r.querySelector('.run-gap')
          if (!gap || gap.hidden || !gap.textContent.trim()) return false
          return /Running|Starting|Working/.test(state)
        }).length,
      }
    })

    assert.equal(seen.found, true, `the activity panel is on the page at ${width}px`)

    /* THE SECOND BAR. home.css hides this one deliberately and records the
       owner's words for why: the bar goes, the scrolling stays. A later rule
       putting it back is what produced the pair of bars 43px apart. */
    assert.equal(seen.scrolls, true, `the panel's region still scrolls at ${width}px`)
    assert.equal(seen.barHidden, true, `and shows no bar of its own at ${width}px`)
    record(`${width}px: the panel scrolls with no bar of its own`)

    /* THE SHEARED ROW. Either edge of a scroll region can hold half a row, and
       with both treatments switched off the row was simply cut through its
       text with nothing to say it had been. */
    for (const [which, seenEdge] of [['top', seen.top], ['bottom', seen.bottom]]) {
      assert.equal(seenEdge.drawn, true, `the ${which} edge is treated at ${width}px`)
      assert.ok(seenEdge.height > 0, `the ${which} edge treatment has height at ${width}px: ${seenEdge.height}`)
      assert.equal(seenEdge.paints, true, `the ${which} edge actually paints at ${width}px`)
    }
    record(`${width}px: both edges are treated, so neither shears a row`)

    // The panel is not wider than the column it is given.
    assert.equal(seen.sideways, 0, `nothing overflows the panel sideways at ${width}px: ${seen.sideways}px`)
    assert.ok(seen.overhang <= 0, `the region stays inside its column at ${width}px: ${seen.overhang}px over`)
    record(`${width}px: no sideways overflow, no overhang past the column`)

    assert.equal(seen.repeats, 0, `no live run repeats its own state as an absence at ${width}px`)
    record(`${width}px: a collapsed run is ${seen.collapsedHeight}px and no live run says its state twice`)

    /* The arrangement, where there is width for it. Below the panel's own
       threshold the stacked layout is correct and is not asserted against. */
    if (seen.wide && seen.wide.headRight - seen.wide.stateRight < 40) {
      /* NOT A TRACK COUNT. This asserted the head had exactly four grid tracks,
         which is a spelling and not a behaviour: the panel grew a fifth track
         for the time, the arrangement got BETTER, and the check went red. The
         quickest way green from a pin like that is to put the defect back.
         What the row actually owes is below -- the head is laid out in columns
         at all, the state sits on the line it describes, and it reaches the
         edge the row was leaving empty. Any track count that does those is
         correct. */
      /* The DISPLAY, not the track list. gridTemplateColumns still reports the
         value a stylesheet asked for even when the box is display:block and no
         track is in force, so reading it proves nothing about the layout; a
         stacked head measured 8 "columns" under exactly that mutation. */
      assert.match(seen.wide.laidOut, /grid/,
        `the run head is laid out in columns at ${width}px, not stacked: ${seen.wide.laidOut}`)
      assert.equal(seen.wide.stateOnIdentityLine, true,
        `the state sits on the line it describes rather than one of its own at ${width}px`)
      const slack = seen.wide.headRight - seen.wide.stateRight
      assert.ok(slack < 40, `and it reaches the edge the row was leaving empty at ${width}px: ${slack}px short`)
      record(`${width}px: the state is on the identity line, ${slack}px from the right edge`)
    }
    /* ONE ACCENT, ONE JOB. The accent means "this changed while you were not
       looking" and nothing else, so at rest it is spent on nothing at all (no
       run in the sample fleet is updated) and never on a filter, a selection or
       a row's edge bar. Measured before this work: ['BUTTON:border', 'run-fold:shadow'] */
    assert.deepEqual(seen.highlight, [],
      `the accent is reserved for what is new, and is spent on nothing else at ${width}px: ${JSON.stringify(seen.highlight)}`)
    record(`${width}px: the accent is spent on nothing but what is new`)

    assert.equal(seen.columns.when.length, 1,
      `every time reads in one column at ${width}px, not ${seen.columns.when.length} (${seen.columns.when})`)
    assert.equal(seen.columns.state.length, 1,
      `every verdict reads in one column at ${width}px, not ${seen.columns.state.length} (${seen.columns.state})`)
    record(`${width}px: the times and the verdicts each read as one column`)

    if (seen.badgeCost.shown > 0) {
      assert.deepEqual(seen.badgeCost.after, seen.badgeCost.before,
        `showing what is new costs a row no height at ${width}px: ${seen.badgeCost.before} became ${seen.badgeCost.after}`)
      assert.equal(seen.badgeCost.whenEdgesWithBadge.length, 1,
        `and does not push the times out of their column at ${width}px: ${seen.badgeCost.whenEdgesWithBadge}`)
      record(`${width}px: a "new update" badge costs no height and no column`)
    }

    if (seen.answerLabelBesideAnswer !== null) {
      assert.equal(seen.answerLabelBesideAnswer, true,
        `an answer's label sits beside its text rather than on a line above it at ${width}px`)
      record(`${width}px: the answer label is beside its answer, not above it`)
    }

    await page.screenshot({ path: path.join(output, `panel-${width}.png`) })
    await page.close()
  }

  const report = { ok: true, origin, output, widths: WIDTHS, checks }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser?.close() }
