#!/usr/bin/env node

/* THE GATE FOR DEFECTS THAT ARE NOT IN ANY ONE STRING.
 *
 * The owner, on two screens: the Codex Cloud panel is "almost impossible for a
 * human to make any meaning of", and the R-ledger panel "is a mess (not human
 * friendly)". tools/check-plain-language.mjs exits 0 on both, and it is not
 * broken: it measures string literals, one at a time, per file, and neither
 * defect is a property of a string.
 *
 *   The cloud panel showed ONE refusal TWICE, in two adjacent boxes, because one
 *   condition was published into two independent state slots.
 *   The ledger showed an EMPTY-state paragraph and a FAILURE-state accessible
 *   name and counter for the same read, because a repair was applied to one line
 *   and not to the chrome around it.
 *   And both of its fields asked for "its number, as shown in the list" on a
 *   page whose list, in that state, was empty.
 *
 * Each sentence was fine. The composition was not. So this builds the WHOLE
 * panel for a state -- every string that state puts on screen at once, plus how
 * many rows its register has -- and measures that. The rules are in
 * tools/lib/composed-output-rules.mjs and the panels in
 * tools/lib/composed-panels.mjs, built from the product's own modules.
 *
 * WHY THERE IS NO BASELINE. tools/check-plain-language.mjs has one because it
 * arrived on top of three thousand strings nobody had measured. This arrives on
 * top of two panels, both of which are being repaired in the same change, so
 * there is nothing to grandfather -- and a ratchet with nothing to ratchet is a
 * place for the next finding to be parked. Every finding blocks.
 *
 * EXIT CODES follow the other gates on the ship path:
 *   0  every panel tells one story per state
 *   1  a finding
 *   2  a setup problem -- and an empty matrix is a setup problem, never a pass
 *
 * RUN IT:
 *   node tools/check-composed-output.mjs
 *   node tools/check-composed-output.mjs --show   every panel, every string
 */

import { composedPanels } from './lib/composed-panels.mjs'
import { COMPOSED_RULES, findingsInPanel } from './lib/composed-output-rules.mjs'

/* A matrix this small is not a sampling problem, it is a floor: below it the
   gate is measuring one screen and calling it coverage. */
const MIN_PANEL_STATES = 6

async function main() {
  const argv = new Set(process.argv.slice(2))
  const panels = await composedPanels()
  if (!Array.isArray(panels) || panels.length < MIN_PANEL_STATES) {
    process.stdout.write(`SETUP: only ${panels?.length ?? 0} panel state(s) were built, and ${MIN_PANEL_STATES} is the floor. An empty matrix is not a clean run.\n`)
    process.exit(2)
  }
  const withoutSlots = panels.filter(panel => (panel.slots || []).every(slot => !String(slot?.text || '').trim()))
  if (withoutSlots.length > 0) {
    process.stdout.write(`SETUP: ${withoutSlots.map(panel => `${panel.panel}/${panel.state}`).join(', ')} produced no visible text at all. The builder has gone blind.\n`)
    process.exit(2)
  }

  if (argv.has('--show')) {
    for (const panel of panels) {
      process.stdout.write(`\n${panel.panel} · ${panel.state} — ${panel.why}\n`)
      process.stdout.write(`  register: ${panel.list ? `${panel.list.name}, ${panel.list.itemCount} row(s)` : 'none'}\n`)
      for (const slot of panel.slots) {
        if (!String(slot.text || '').trim()) continue
        process.stdout.write(`  [${slot.tone}] ${slot.name}: ${slot.text}\n`)
      }
    }
    process.stdout.write('\n')
  }

  const findings = []
  for (const panel of panels) {
    for (const finding of findingsInPanel(panel)) {
      findings.push({ panel: panel.panel, state: panel.state, ...finding })
    }
  }

  const byRule = new Map(COMPOSED_RULES.map(rule => [rule, 0]))
  for (const finding of findings) byRule.set(finding.rule, (byRule.get(finding.rule) || 0) + 1)
  const tally = [...byRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(' ')
  const slots = panels.reduce((total, panel) => total + panel.slots.filter(slot => String(slot.text || '').trim()).length, 0)
  process.stdout.write(`Composed output: ${panels.length} panel state(s), ${slots} visible string(s) on screen together; ${findings.length} finding(s) [${tally}].\n`)

  if (findings.length > 0) {
    process.stdout.write('\nA panel is telling more than one story at once:\n')
    for (const finding of findings) {
      process.stdout.write(`  - ${finding.panel} · ${finding.state}: [${finding.rule}] ${finding.detail}\n      ${JSON.stringify(finding.excerpt.slice(0, 220))}\n`)
    }
    process.stdout.write('\nFix the composition, not the sentence. There is no baseline here on purpose.\n')
    process.exit(1)
  }

  process.stdout.write('Every panel tells one story in every state it can be in.\n')
  process.exit(0)
}

main().catch(error => {
  process.stdout.write(`${String(error?.message || error).startsWith('SETUP:') ? error.message : `SETUP: composed-output gate error: ${error?.stack || error}`}\n`)
  process.exit(2)
})
