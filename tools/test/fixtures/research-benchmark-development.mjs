// These fixtures exercise unfinished apparatus (transport, graders, recovery,
// accounting and estimators). Their outputs are explicitly development evidence,
// never an admitted scientific experiment or a qualified arbitrary answer key.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'

export function developmentDraft(source) {
  const spec = newExperimentDraft(source, { purpose: 'apparatus-development' })
  spec.analysisPlan.cohort = 'qualification'
  spec.runtimeSources = Object.fromEntries(RUNTIME_FILES.map(file => [file,
    createHash('sha256').update(readFileSync(new URL('../../../src/benchmark/' + file, import.meta.url))).digest('hex')]))
  return spec
}

export function developmentStarter() { return developmentDraft(genericStarter()) }

// Retained template library for generic composition/lifecycle compatibility.
// The wording is synthetic and written for these fixtures; retained snippets
// are never executed. The current product ships only four-part atom snippets;
// this retained import is fixture data, never current default content or
// approval.
const historicalSnippetImport = {
  "format": "benchmark-snippet-library",
  "version": 1,
  "catalog": [
    {
      "id": "ex-fixed-setup",
      "version": "1",
      "kind": "atom",
      "role": "setup",
      "title": "Fixed setup requirements",
      "labels": [
        "Fixed setup requirements",
        "Example task"
      ],
      "text": "Fixed setup requirements:\n- Backtest period: one year of daily bars.\n- Starting cash: $100,000.\n- Subscribe to SPY and QQQ at daily resolution.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-semantics-contract",
      "version": "1",
      "kind": "atom",
      "role": "contract",
      "title": "Semantics contract",
      "labels": [
        "Semantics contract",
        "Example task"
      ],
      "text": "SEMANTICS CONTRACT (these definitions are exact; follow them):\n- Evaluate every rule once per daily bar, after the close.\n- \"X crosses above Y\" means X was at or below Y on the previous bar and is above Y on this bar; \"crosses below\" is the mirror image.\n- Do not trade until every indicator a rule uses has enough history.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-a-reason-to-buy",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_buy",
      "title": "Strategy A - Reason to buy",
      "labels": [
        "Reason to buy",
        "Strategy A",
        "Strategy system"
      ],
      "text": "SPY's close crosses above its 50-day simple moving average.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-a-buy-details",
      "version": "1",
      "kind": "atom",
      "role": "buy_details",
      "title": "Strategy A - Buy details",
      "labels": [
        "Buy details",
        "Strategy A",
        "Strategy system"
      ],
      "text": "invest 25% of total portfolio value in SPY.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-a-reason-to-sell",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_sell",
      "title": "Strategy A - Reason to sell",
      "labels": [
        "Reason to sell",
        "Strategy A",
        "Strategy system"
      ],
      "text": "SPY's close crosses below its 50-day simple moving average.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-a-sell-details",
      "version": "1",
      "kind": "atom",
      "role": "sell_details",
      "title": "Strategy A - Sell details",
      "labels": [
        "Sell details",
        "Strategy A",
        "Strategy system"
      ],
      "text": "liquidate Strategy A's entire lot.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-b-reason-to-buy",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_buy",
      "title": "Strategy B - Reason to buy",
      "labels": [
        "Reason to buy",
        "Strategy B",
        "Strategy system"
      ],
      "text": "QQQ has closed lower for 2 consecutive days.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-b-buy-details",
      "version": "1",
      "kind": "atom",
      "role": "buy_details",
      "title": "Strategy B - Buy details",
      "labels": [
        "Buy details",
        "Strategy B",
        "Strategy system"
      ],
      "text": "buy $10,000 of QQQ if at least $10,000 cash is available, otherwise do nothing.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-b-reason-to-sell",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_sell",
      "title": "Strategy B - Reason to sell",
      "labels": [
        "Reason to sell",
        "Strategy B",
        "Strategy system"
      ],
      "text": "QQQ's 14-day RSI closes above 70.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-b-sell-details",
      "version": "1",
      "kind": "atom",
      "role": "sell_details",
      "title": "Strategy B - Sell details",
      "labels": [
        "Sell details",
        "Strategy B",
        "Strategy system"
      ],
      "text": "liquidate Strategy B's entire lot.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-strategy-slot",
      "version": "1",
      "kind": "template",
      "role": "strategy",
      "title": "Slot - Strategy (trades ticker)",
      "labels": [
        "Strategy system",
        "Templates"
      ],
      "text": "- Slot {{slot_number}} - Strategy {{strategy_name}} (trades {{ticker}}):\n  - Reason to buy: {{slot:reason_to_buy}}\n  - Buy details: {{slot:buy_details}}\n  - Reason to sell: {{slot:reason_to_sell}}\n  - Sell details: {{slot:sell_details}}",
      "slots": {
        "reason_to_buy": "reason_to_buy",
        "buy_details": "buy_details",
        "reason_to_sell": "reason_to_sell",
        "sell_details": "sell_details"
      },
      "slotOrder": [
        "reason_to_buy",
        "buy_details",
        "reason_to_sell",
        "sell_details"
      ],
      "parameters": {
        "slot_number": 1,
        "strategy_name": "A",
        "ticker": "SPY"
      },
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-parallel-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "Parallel template, no gate",
      "labels": [
        "Templates",
        "Strategy system"
      ],
      "text": "PARALLEL template: both slots run independently at the same time.\n\n{{slot:slot_1}}\n{{slot:slot_2}}",
      "slots": {
        "slot_1": [
          "strategy",
          "node"
        ],
        "slot_2": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "slot_1",
        "slot_2"
      ],
      "parameters": {},
      "semantics": {
        "kind": "prompt",
        "policy": {
          "mayAct": [
            {
              "term": "always"
            }
          ],
          "done": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ]
        }
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-state-gated-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "STATE-GATED template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- STATE-GATED template: what is inside may act only while the gate condition holds. On the bar it stops holding, close every position inside the template, nested templates included, and reset its state. Indicator values keep updating while the gate is shut.\n\n{{slot:inside}}",
      "slots": {
        "inside": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "inside"
      ],
      "parameters": {
        "gate_open": "true"
      },
      "semantics": {
        "kind": "prompt",
        "policy": {
          "mayAct": [
            {
              "term": "field",
              "field": "gate",
              "test": "is",
              "value": "{{gate_open}}"
            }
          ],
          "done": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ],
          "reset": [
            {
              "term": "field",
              "field": "gate",
              "test": "is-not",
              "value": "{{gate_open}}"
            }
          ]
        }
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-event-gated-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "EVENT-GATED template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- EVENT-GATED template: when the event condition becomes true (true today, false yesterday), the template is armed for the next m trading days, starting tomorrow. While armed, what is inside may act. When the window ends, close every position inside the template and reset its state. A new event while armed restarts the window.\n\n{{slot:inside}}",
      "slots": {
        "inside": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "inside"
      ],
      "parameters": {
        "event_fires": "true",
        "window": "3",
        "window_over": "4"
      },
      "semantics": {
        "kind": "prompt",
        "policy": {
          "mayAct": [
            {
              "term": "ago",
              "of": [
                {
                  "term": "field",
                  "field": "event",
                  "test": "is",
                  "value": "{{event_fires}}"
                }
              ],
              "test": "at-least",
              "value": "1"
            },
            {
              "term": "ago",
              "of": [
                {
                  "term": "field",
                  "field": "event",
                  "test": "is",
                  "value": "{{event_fires}}"
                }
              ],
              "test": "at-most",
              "value": "{{window}}"
            }
          ],
          "done": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ],
          "reset": [
            {
              "term": "ago",
              "of": [
                {
                  "term": "field",
                  "field": "event",
                  "test": "is",
                  "value": "{{event_fires}}"
                }
              ],
              "test": "at-least",
              "value": "{{window_over}}"
            }
          ]
        }
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-race-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "RACE template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- RACE template: while no slot owns the template, check each slot's reason to buy on every bar in slot order; the first slot whose reason holds takes sole ownership and carries out its buy details. The other slots may not act while it owns the template. Ownership ends when that slot's position is closed, and the race re-opens on the next bar.\n\n{{slot:inside}}",
      "slots": {
        "inside": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "inside"
      ],
      "parameters": {},
      "semantics": {
        "kind": "prompt",
        "policy": {
          "mayAct": [
            {
              "term": "reason",
              "holds": true
            },
            {
              "term": "siblings",
              "scope": "all",
              "quantifier": "none",
              "is": "active"
            }
          ],
          "done": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ],
          "reset": [
            {
              "term": "children",
              "quantifier": "any",
              "is": "done"
            }
          ]
        }
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-sequence-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "SEQUENCE template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- SEQUENCE template: one slot is eligible at a time, starting with slot 1. A slot passes eligibility to the next slot after it opens and then closes a position. After the last slot, eligibility returns to slot 1.\n\n{{slot:inside}}",
      "slots": {
        "inside": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "inside"
      ],
      "parameters": {},
      "semantics": {
        "kind": "prompt",
        "policy": {
          "mayAct": [
            {
              "term": "state",
              "test": "is-not",
              "is": "done"
            },
            {
              "term": "siblings",
              "scope": "earlier",
              "quantifier": "every",
              "is": "done"
            }
          ],
          "done": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ],
          "reset": [
            {
              "term": "children",
              "quantifier": "every",
              "is": "done"
            }
          ]
        }
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-task",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "Example task",
      "labels": [
        "Example task",
        "Strategy system"
      ],
      "text": "Write a complete trading algorithm as one program.\n\n{{slot:fixed_setup}}\n\nImplement exactly the following strategy system. Do not add, remove or reinterpret any rule.\n\n{{slot:semantics_contract}}\n\nSTRATEGY SYSTEM:\n{{slot:strategy_system}}\n\nReturn only the complete program.",
      "slots": {
        "fixed_setup": "setup",
        "semantics_contract": "contract",
        "strategy_system": [
          "strategy",
          "node"
        ]
      },
      "slotOrder": [
        "fixed_setup",
        "semantics_contract",
        "strategy_system"
      ],
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-review-prompt-v2",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "Review prompt v2",
      "labels": [
        "Review prompts"
      ],
      "text": "Write an independent implementation of a trading-strategy specification, for a review that compares execution traces. Implement exactly what the specification states: no simplifications, substitutions or additions. Save the program and a list of your assumptions as one committed file; the file is the deliverable.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    },
    {
      "id": "ex-review-prompt-v1",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "Review prompt v1",
      "labels": [
        "Review prompts"
      ],
      "text": "Write an independent implementation of a trading-strategy specification, for a review that compares execution traces. Implement exactly what the specification states: no simplifications, substitutions or additions. Reply with the program and a list of your assumptions.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "examples/synthetic.txt"
    }
  ]
}
export function historicalSnippetLibrary() { return structuredClone(historicalSnippetImport) }
