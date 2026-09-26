#!/usr/bin/env node
'use strict'

// A distinct companion inventory. The established authenticated inventory and
// whole-cut contract do not silently acquire mutually exclusive required rows.
const { scenarios: firstUseScenarios } = require('./lib/page2-native-first-use-scenarios.cjs')
const { scenarios: guidedScenarios } = require('./lib/page2-native-guided-first-use-scenarios.cjs')
const scenarios = [...firstUseScenarios, ...guidedScenarios]
const { selectScenarios } = require('./lib/page2-native-report.cjs')
const selected = selectScenarios(scenarios, [])
const { main } = require('./page2-native-audit.cjs')

if (require.main === module) main(process.argv.slice(2), { cohort: 'sterile-first-use', scenarios: selected })
  .then(code => { process.exitCode = code }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 2 })
