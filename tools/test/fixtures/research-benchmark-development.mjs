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

// Historical imported library for generic composition/lifecycle compatibility.
// Catalog from 2f3c5d57f6749970618b23336d21c7828d736ac8:src/research-examples.mjs.
// Two machine account segments are redacted; retained snippets are never executed.
// Original source SHA-256 367d93ff6f504fbe177c3001eb48cd0b2ee3ea207aaffc72f048ac419836d5cd.
// The current product deliberately ships only four-part atom snippets; this
// retained import is fixture data, never current default content or approval.
const historicalSnippetImport = {
  "format": "benchmark-snippet-library",
  "version": 1,
  "catalog": [
    {
      "id": "lb-fixed-setup",
      "version": "1",
      "kind": "atom",
      "role": "setup",
      "title": "Fixed setup requirements",
      "labels": [
        "Fixed setup requirements",
        "T1v0"
      ],
      "text": "Fixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-semantics-contract",
      "version": "1",
      "kind": "atom",
      "role": "contract",
      "title": "Semantics contract",
      "labels": [
        "Semantics contract",
        "T1v0"
      ],
      "text": "SEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-a-reason-to-buy",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_buy",
      "title": "Strategy A - Reason to buy",
      "labels": [
        "Reason to buy",
        "Strategy A",
        "Strategy system"
      ],
      "text": "SPY's close crosses above its 100-day simple moving average.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-a-buy-details",
      "version": "1",
      "kind": "atom",
      "role": "buy_details",
      "title": "Strategy A - Buy details",
      "labels": [
        "Buy details",
        "Strategy A",
        "Strategy system"
      ],
      "text": "invest 40% of total portfolio value in SPY.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-a-reason-to-sell",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_sell",
      "title": "Strategy A - Reason to sell",
      "labels": [
        "Reason to sell",
        "Strategy A",
        "Strategy system"
      ],
      "text": "SPY's close crosses below its 100-day simple moving average.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-a-sell-details",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-b-reason-to-buy",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_buy",
      "title": "Strategy B - Reason to buy",
      "labels": [
        "Reason to buy",
        "Strategy B",
        "Strategy system"
      ],
      "text": "AAPL has been red for 3 consecutive days.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-b-buy-details",
      "version": "1",
      "kind": "atom",
      "role": "buy_details",
      "title": "Strategy B - Buy details",
      "labels": [
        "Buy details",
        "Strategy B",
        "Strategy system"
      ],
      "text": "buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-b-reason-to-sell",
      "version": "1",
      "kind": "atom",
      "role": "reason_to_sell",
      "title": "Strategy B - Reason to sell",
      "labels": [
        "Reason to sell",
        "Strategy B",
        "Strategy system"
      ],
      "text": "AAPL's 14-day RSI closes above 60.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-b-sell-details",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-strategy-slot",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-parallel-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "Parallel template, no gate",
      "labels": [
        "Templates",
        "Strategy system"
      ],
      "text": "One template with 2 slots, no gate. Both slots run independently in parallel.\n\n{{slot:slot_1}}\n{{slot:slot_2}}",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-state-gated-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "STATE-GATED template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n\n{{slot:inside}}",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-event-gated-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "EVENT-GATED template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n\n{{slot:inside}}",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-race-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "RACE template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n\n{{slot:inside}}",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-sequence-template",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "SEQUENCE template",
      "labels": [
        "Templates",
        "Semantics contract"
      ],
      "text": "- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n\n{{slot:inside}}",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-t1v0-task",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "T1v0 donor task",
      "labels": [
        "T1v0",
        "Strategy system"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\n{{slot:fixed_setup}}\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\n{{slot:semantics_contract}}\n\nSTRATEGY SYSTEM:\n{{slot:strategy_system}}\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
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
      "source": "historical/LEAN-Bench/prompts/T1v0.txt"
    },
    {
      "id": "lb-ref-impl-prompt-v2",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "Reference implementation prompt v2",
      "labels": [
        "Audit prompts"
      ],
      "text": "You are writing a REFERENCE implementation of a trading-strategy specification, for an audit that compares execution traces. FIDELITY IS THE ONLY GOAL: implement exactly what the specification states — no simplifications, no substitutions, no additions.\n\nEXECUTION ENVIRONMENT (fixed by the harness; not your choice):\n- Python backtrader. Your code is executed with a single data feed `self.data` (bt.feeds.PandasData) of {SYMBOL} {TIMEFRAME} bars, {RANGE}; columns Open/High/Low/Close/Volume.\n- Starting cash $10,000; commission 0.001. Cerebro setup is added by the harness.\n- Output ONE module-level class inheriting from bt.Strategy. No other top-level code that executes anything (no __main__ block, no data downloads, no prints).\n- You may use any bt.indicators or compute values manually in next(). Imports allowed: backtrader, math, collections, statistics.\n\nCANONICAL DEFAULTS — apply these ONLY where the specification is silent (they are the bench's own conventions; never deviate from the spec to apply them):\n1. Position sizing unstated -> plain self.buy() / self.sell() (default sizer, no size argument).\n2. \"Exit\"/\"close the position\" -> self.close().\n3. Hold at most one position at a time; no pyramiding or re-entry while a position is open, unless the spec says otherwise.\n4. Long-only unless the spec explicitly calls for shorting.\n5. Guard pending orders with an order-tracking attribute reset in notify_order on Completed/Canceled/Margin/Rejected.\n6. Indicator warm-up: rely on backtrader's automatic minperiod; no manual bar-skipping unless the spec states warm-up handling.\n\nSPECIFICATION (implement exactly):\n{task}\n\nRULES:\n- Every stated rule, indicator, parameter, threshold, and condition must appear exactly as written. If the spec names an indicator with parameters, use exactly those parameters.\n- If the spec is silent on something NOT covered by the canonical defaults, make a reasonable choice and DECLARE it in the assumptions block. Do not invent extra filters, stops, or indicators the spec does not state.\n- If a stated rule cannot be implemented in this environment as written (e.g., it requires other assets, external data, order-book/session information not in OHLCV, or a different timeframe than the feed), implement the closest literal reading possible and declare the gap in assumptions with topic \"infeasible\".\n\nOUTPUT exactly two fenced blocks and nothing else:\n```python\n# complete strategy class\n```\n```json\n{\"assumptions\": [{\"topic\": \"...\", \"choice\": \"...\", \"reason\": \"...\"}]}\n```\n\nDELIVERY (v2, 2026-08-25): WRITE your complete answer to a NEW FILE named\nref_impl.md in the repository root and COMMIT it. The file must contain the\npython block and the json block exactly as specified above. Do not print them\nin the chat instead - the committed file is the deliverable. (v1 tasks answered\nin chat, which the CLI cannot retrieve; this changes only the delivery channel,\nnever the task.)\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/prompts/ref_impl_prompt_v2.txt"
    },
    {
      "id": "lb-ref-impl-prompt-v1",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "Reference implementation prompt v1",
      "labels": [
        "Audit prompts"
      ],
      "text": "You are writing a REFERENCE implementation of a trading-strategy specification, for an audit that compares execution traces. FIDELITY IS THE ONLY GOAL: implement exactly what the specification states — no simplifications, no substitutions, no additions.\n\nEXECUTION ENVIRONMENT (fixed by the harness; not your choice):\n- Python backtrader. Your code is executed with a single data feed `self.data` (bt.feeds.PandasData) of {SYMBOL} {TIMEFRAME} bars, {RANGE}; columns Open/High/Low/Close/Volume.\n- Starting cash $10,000; commission 0.001. Cerebro setup is added by the harness.\n- Output ONE module-level class inheriting from bt.Strategy. No other top-level code that executes anything (no __main__ block, no data downloads, no prints).\n- You may use any bt.indicators or compute values manually in next(). Imports allowed: backtrader, math, collections, statistics.\n\nCANONICAL DEFAULTS — apply these ONLY where the specification is silent (they are the bench's own conventions; never deviate from the spec to apply them):\n1. Position sizing unstated -> plain self.buy() / self.sell() (default sizer, no size argument).\n2. \"Exit\"/\"close the position\" -> self.close().\n3. Hold at most one position at a time; no pyramiding or re-entry while a position is open, unless the spec says otherwise.\n4. Long-only unless the spec explicitly calls for shorting.\n5. Guard pending orders with an order-tracking attribute reset in notify_order on Completed/Canceled/Margin/Rejected.\n6. Indicator warm-up: rely on backtrader's automatic minperiod; no manual bar-skipping unless the spec states warm-up handling.\n\nSPECIFICATION (implement exactly):\n{task}\n\nRULES:\n- Every stated rule, indicator, parameter, threshold, and condition must appear exactly as written. If the spec names an indicator with parameters, use exactly those parameters.\n- If the spec is silent on something NOT covered by the canonical defaults, make a reasonable choice and DECLARE it in the assumptions block. Do not invent extra filters, stops, or indicators the spec does not state.\n- If a stated rule cannot be implemented in this environment as written (e.g., it requires other assets, external data, order-book/session information not in OHLCV, or a different timeframe than the feed), implement the closest literal reading possible and declare the gap in assumptions with topic \"infeasible\".\n\nOUTPUT exactly two fenced blocks and nothing else:\n```python\n# complete strategy class\n```\n```json\n{\"assumptions\": [{\"topic\": \"...\", \"choice\": \"...\", \"reason\": \"...\"}]}\n```\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/prompts/ref_impl_prompt.txt"
    },
    {
      "id": "qcb-system-prompt",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "QuantCode-Bench system prompt",
      "labels": [
        "QuantCode-Bench",
        "Audit prompts"
      ],
      "text": "You are an expert in creating trading strategies for Backtrader library (Python).\n\nCRITICAL RULES - VIOLATION WILL CAUSE FAILURE:\n1. Import ONLY: \"import backtrader as bt\" - NO pandas, numpy, scipy, yfinance, etc.\n2. Use ONLY these indicators (DO NOT invent new ones):\n   - bt.indicators.SMA / bt.indicators.SimpleMovingAverage\n   - bt.indicators.EMA / bt.indicators.ExponentialMovingAverage\n   - bt.indicators.RSI\n   - bt.indicators.MACD\n   - bt.indicators.BollingerBands\n   - bt.indicators.Stochastic\n   - bt.indicators.ATR\n   - bt.indicators.CrossOver\n3. Class name MUST be: TradingStrategy(bt.Strategy)\n4. Must have: __init__(), next(), notify_order()\n5. Use self.order to track orders\n6. Check \"if not self.position:\" before opening positions\n7. Use ONLY self.data (NOT self.data0, self.data1, etc.)\n8. Available data fields: self.data.close, self.data.open, self.data.high, self.data.low, self.data.volume\n9. DO NOT use: self.data.columns, self.data.index, dates, timestamps\n10. Create SIMPLE strategies that WILL generate signals\n11. Output ONLY executable Python code, NO text/explanations/markdown\n\nCOMMON ERRORS TO AVOID:\n- bt.indicators.Sector - DOES NOT EXIST\n- bt.indicators.Momentum - DOES NOT EXIST, use RSI instead\n- bt.indicators.SMA(self.data) - WRONG, need: bt.indicators.SMA(self.data.close)\n- bt.indicators.SMA([data1, data2]) - WRONG, indicators take ONE series\n- self.data.columns - WRONG, no pandas attributes\n- self.data.index - WRONG, no pandas attributes\n- bt.Date(2023, 1, 1) - WRONG, no date filtering\n- self.crossover = bt.indicators.CrossOver(self.sma, self.sma) - WRONG, same inputs\n- if len(self) < 100: return - WRONG syntax\n- Complex statistical functions - KEEP IT SIMPLE!\n\nCORRECT INDICATOR USAGE:\nself.sma = bt.indicators.SMA(self.data.close, period=20)\nself.rsi = bt.indicators.RSI(self.data.close, period=14)\nself.macd = bt.indicators.MACD(self.data.close)\nself.bb = bt.indicators.BollingerBands(self.data.close, period=20, devfactor=2.0)\nself.crossover = bt.indicators.CrossOver(self.fast_sma, self.slow_sma)\n\nEXAMPLE - SMA Crossover:\n\nimport backtrader as bt\n\nclass TradingStrategy(bt.Strategy):\n    params = (\n        ('fast_period', 10),\n        ('slow_period', 30),\n    )\n    \n    def __init__(self):\n        self.fast_sma = bt.indicators.SMA(self.data.close, period=self.params.fast_period)\n        self.slow_sma = bt.indicators.SMA(self.data.close, period=self.params.slow_period)\n        self.crossover = bt.indicators.CrossOver(self.fast_sma, self.slow_sma)\n        self.order = None\n        \n    def next(self):\n        if self.order:\n            return\n        if not self.position:\n            if self.crossover > 0:\n                self.order = self.buy()\n        else:\n            if self.crossover < 0:\n                self.order = self.sell()\n                \n    def notify_order(self, order):\n        if order.status in [order.Completed, order.Canceled, order.Margin, order.Rejected]:\n            self.order = None\n\nOUTPUT FORMAT:\n- ONLY Python code, nothing else\n- NO markdown (no ```python or ```)\n- NO explanations before/after code\n- NO comments outside the code\n- If task is complex, SIMPLIFY it to use only available indicators",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/prompts/system_prompt_full.txt"
    },
    {
      "id": "qcb-user-prompt-single",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "QuantCode-Bench single-shot user prompt",
      "labels": [
        "QuantCode-Bench",
        "Audit prompts"
      ],
      "text": "\nUSER REQUEST:\n{prompt}\n\nYOUR TASK:\nGenerate Python code for a Backtrader strategy based on the description above.\nOutput ONLY Python code, no explanations, no markdown.\nYou have ONLY ONE attempt - make it count!",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/prompts/user_prompt_single.txt"
    },
    {
      "id": "qcb-judge-prompt-template",
      "version": "1",
      "kind": "atom",
      "role": "node",
      "title": "QuantCode-Bench judge prompt",
      "labels": [
        "QuantCode-Bench",
        "Audit prompts"
      ],
      "text": "You are an expert in evaluating trading strategies. Your task is to determine whether the generated strategy code meets the requirements of the assignment.\n\n**STRATEGY ASSIGNMENT:**\n{task_description}\n\n**GENERATED CODE:**\n```python\n{generated_code}\n```\n\n**EVALUATION CRITERIA:**\n\n1. **Indicator compliance**: Does the code use the indicators or equivalent logic from the assignment? IMPORTANT: Accept reasonable simplifications if the assignment requires complex statistical methods (e.g. Johansen test) that are impossible in Backtrader. Simplifying to SMA/StdDev for Z-score is ACCEPTABLE.\n\n2. **Problem solving**: Does the code implement the MAIN IDEA of the task? If the task is about mean reversion and the code uses Z-score and trades on deviations — this is COMPLIANT, even if details are simplified.\n\n3. **Relevance**: Is the code related to the task description? The code must explicitly ignore ALL conditions of the assignment to receive 0.\n\n**INSTRUCTIONS:**\n\nAnalyze the code on each criterion (1-2 sentences per criterion).\n\nThen provide a final rating in the format \"Rating: [[X]]\", where:\n- X = 1 if the code implements the MAIN LOGIC of the assignment (even with simplifications)\n- X = 0 if the code COMPLETELY DOES NOT COMPLY (ignores the main idea)\n\nIMPORTANT: Be LENIENT with simplifications. Penalize ONLY if the code clearly ignores the main task or uses completely different indicators/logic WITHOUT reason. If the assignment is technically impossible to implement exactly in Backtrader — accept reasonable simplifications.\n\nYou MUST end your response with the line \"Rating: [[X]]\".",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/prompts/judge_prompt_template.txt"
    },
    {
      "id": "qcb-single-shot-request",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "QuantCode-Bench single-shot request",
      "labels": [
        "QuantCode-Bench",
        "Templates"
      ],
      "text": "{{slot:system_prompt}}{{slot:user_prompt}}",
      "slots": {
        "system_prompt": "node",
        "user_prompt": "node"
      },
      "slotOrder": [
        "system_prompt",
        "user_prompt"
      ],
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/audit/extract_prompts.py"
    },
    {
      "id": "o1-deliverable",
      "version": "1",
      "kind": "atom",
      "role": "deliverable",
      "title": "Deliverable",
      "labels": [
        "Deliverable",
        "O1v0",
        "Options arm"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-backtest-setup",
      "version": "1",
      "kind": "atom",
      "role": "setup",
      "title": "Backtest setup",
      "labels": [
        "Backtest setup",
        "O1v0",
        "Options arm"
      ],
      "text": "Backtest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-entry-signal",
      "version": "1",
      "kind": "atom",
      "role": "entry_signal",
      "title": "Entry signal",
      "labels": [
        "Entry signal",
        "O1v0",
        "Options arm"
      ],
      "text": "Trade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-entry-window",
      "version": "1",
      "kind": "atom",
      "role": "entry_window",
      "title": "Entry window",
      "labels": [
        "Entry window",
        "O1v0",
        "Options arm"
      ],
      "text": "Only open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-contract-selection",
      "version": "1",
      "kind": "atom",
      "role": "contract_selection",
      "title": "Contract selection",
      "labels": [
        "Contract selection",
        "O1v0",
        "Options arm"
      ],
      "text": "At entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-order-placement",
      "version": "1",
      "kind": "atom",
      "role": "order_placement",
      "title": "Order placement",
      "labels": [
        "Order placement",
        "O1v0",
        "Options arm"
      ],
      "text": "Buy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-exit-rules",
      "version": "1",
      "kind": "atom",
      "role": "exit_rules",
      "title": "Exit rules",
      "labels": [
        "Exit rules",
        "O1v0",
        "Options arm"
      ],
      "text": "After the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-expiration-handling",
      "version": "1",
      "kind": "atom",
      "role": "expiration_handling",
      "title": "Expiration handling",
      "labels": [
        "Expiration handling",
        "O1v0",
        "Options arm"
      ],
      "text": "Never intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-skip-conditions",
      "version": "1",
      "kind": "atom",
      "role": "skip_conditions",
      "title": "Skip conditions",
      "labels": [
        "Skip conditions",
        "O1v0",
        "Options arm"
      ],
      "text": "If the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-warmup-and-logging",
      "version": "1",
      "kind": "atom",
      "role": "warmup_and_logging",
      "title": "Warm-up and logging",
      "labels": [
        "Warm-up and logging",
        "O1v0",
        "Options arm"
      ],
      "text": "Warm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "o1-o1v0-task",
      "version": "1",
      "kind": "template",
      "role": "node",
      "title": "O1v0 options task",
      "labels": [
        "O1v0",
        "Options arm",
        "Donor prompt"
      ],
      "text": "{{slot:deliverable}}\n\n{{slot:setup}}\n\n{{slot:entry_signal}}\n\n{{slot:entry_window}}\n\n{{slot:contract_selection}}\n\n{{slot:order_placement}}\n\n{{slot:exit_rules}}\n\n{{slot:expiration_handling}}\n\n{{slot:skip_conditions}}\n\n{{slot:warmup_and_logging}}",
      "parameters": {},
      "slots": {
        "deliverable": "deliverable",
        "setup": "setup",
        "entry_signal": "entry_signal",
        "entry_window": "entry_window",
        "contract_selection": "contract_selection",
        "order_placement": "order_placement",
        "exit_rules": "exit_rules",
        "expiration_handling": "expiration_handling",
        "skip_conditions": "skip_conditions",
        "warmup_and_logging": "warmup_and_logging"
      },
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/O1v0.txt"
    },
    {
      "id": "lb-ref-template-t1",
      "version": "1",
      "kind": "atom",
      "role": "reference_implementation",
      "title": "T1 reference implementation template",
      "labels": [
        "Reference implementation",
        "Python",
        "T1v0",
        "Matching code"
      ],
      "text": "# T1 parameterized reference implementation v2 — PIN-v5 SS4.2 oracle bank.\r\n# ONE audited code path; every oracle = this template + the PARAMS literal.\r\n# v2 (2026-08-16, vetting-council round 1): fill-event lot sync for BOTH\r\n# signs with pending-order tracking; LEAN-exact EMA seed (first value);\r\n# readiness levels {strict, ready_check, ready_per_rule}; RSI exit\r\n# {level, cross}; cross timing {both_days, today_ma}; level-relation cross\r\n# resolutions; ER-01 lookback exact; missing-bar state update; OM-B\r\n# eval-order resolution; split sync for raw private lots.\r\n#\r\n# PARAMS keys (defaults = the pinned donor at the reference DOF point):\r\n#   a_ma_type: SMA|EMA|WMA            a_ma_period: int (100)\r\n#   a_buy_dir/a_sell_dir: up|down|any|level_above|level_below\r\n#   a_size_pct: float (40)            a_sell_frac: all|half_down_lastsell|half_down_hold|half_up\r\n#   er01_sell: none|R1..R6            (buy = close x SMA200 up)\r\n#   b_red_def: prev_close|open_close|prev_close_le   b_red_days: int (3)\r\n#   b_cash_rule: skip|partial|nocheck b_cash_amt: float (20000)\r\n#   b_rsi_period: int (14)            b_rsi_thresh: float (60)\r\n#   missing_bar: skip_all|no_guard|try_except|per_ticker\r\n#   lots: private|invested_gate|netting     eval_order: sells_first|buys_first\r\n#   slot_mode: parallel|race|sequence\r\n#   dof_rsi_smoothing: wilder|simple  dof_rsi_exit: level|cross\r\n#   dof_warmup: strict|ready_check|ready_per_rule\r\n#   dof_warmup_bars: int|null (strict: SetWarmUp length; null = minimal complete)\r\n#   dof_a_exec: calc_shares|set_holdings|pct_cash\r\n#   dof_same_bar_reentry: allowed|wait_bar\r\n#   dof_input_field: adjusted|raw\r\n#   dof_cross_timing: both_days|today_ma\r\n#\r\n# {{PARAMS}} is replaced by the bank runner with a JSON dict literal.\r\n\r\nfrom AlgorithmImports import *\r\nimport json\r\nimport math\r\n\r\nPARAMS = json.loads(r'''{{PARAMS}}''')\r\n\r\n\r\nclass T1Reference(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n        self.p = PARAMS\r\n        # in-container witness of the executed source (bank_runner verifies it in log.txt)\r\n        self.Log(\"RUN-NONCE \" + str(self.p.get(\"_nonce\", \"none\")))\r\n        self.tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.syms = {}\r\n        for t in self.tickers:\r\n            sec = self.AddEquity(t, Resolution.Daily)\r\n            if self.p[\"dof_input_field\"] == \"raw\":\r\n                sec.SetDataNormalizationMode(DataNormalizationMode.Raw)\r\n            self.syms[t] = sec.Symbol\r\n\r\n        self.closes = {t: [] for t in self.tickers}\r\n        self.opens = {t: [] for t in self.tickers}\r\n        # EMA state per (period): [prev_value, cur_value] — LEAN semantics\r\n        self.ema = {}\r\n\r\n        # Lot state — from FILL EVENTS only (daily market orders fill at the\r\n        # next open). shares = filled quantity owned; pending = submitted,\r\n        # not yet filled quantity (signed); lot_open gates the contract's\r\n        # \"buy reason evaluated only while its lot is empty\".\r\n        self.a_shares = 0; self.a_pending = 0; self.a_lot_open = False\r\n        self.b_shares = 0; self.b_pending = 0; self.b_lot_open = False\r\n        self.a_last_action_bar = -10\r\n        self.b_last_action_bar = -10\r\n        self.bar_index = -1\r\n\r\n        # RSI state\r\n        self.rsi_avg_gain = None\r\n        self.rsi_avg_loss = None\r\n        self.rsi_seed = []\r\n        self.rsi_value = None\r\n        self.rsi_prev = None\r\n\r\n        self.race_owner = None\r\n        self.seq_eligible = 1\r\n        self.seq_was_nonempty = False\r\n\r\n        if self.p[\"dof_warmup\"] == \"strict\":\r\n            n = self.p.get(\"dof_warmup_bars\") or self._lookback_all()\r\n            self.SetWarmUp(int(n), Resolution.Daily)\r\n\r\n    # ---------- exact readiness (contract: \"fully formed\") ----------\r\n\r\n    def _lookback_a(self):\r\n        # cross of X vs MA(n): MA yesterday AND today -> n+1 closes\r\n        n = self.p[\"a_ma_period\"] + 1\r\n        if self.p[\"er01_sell\"] != \"none\":\r\n            n = max(n, 200 + 1, 50 + 1)\r\n        return n\r\n\r\n    def _lookback_b(self):\r\n        # RSI(n) Wilder seed needs n changes -> n+1 closes; streak k -> k+1 closes\r\n        return max(self.p[\"b_rsi_period\"] + 1, self.p[\"b_red_days\"] + 1)\r\n\r\n    def _lookback_all(self):\r\n        return max(self._lookback_a(), self._lookback_b())\r\n\r\n    def _ready_a(self):\r\n        return len(self.closes[\"SPY\"]) >= self._lookback_a()\r\n\r\n    def _ready_b(self):\r\n        return len(self.closes[\"AAPL\"]) >= self._lookback_b() and self.rsi_value is not None\r\n\r\n    # ---------- indicators (manual, contract-exact) ----------\r\n\r\n    def _ma_window(self, closes, n, kind):\r\n        if len(closes) < \x6e:\r\n            return None\r\n        w = closes[-n:]\r\n        if kind == \"SMA\":\r\n            return sum(w) / n\r\n        if kind == \"WMA\":\r\n            den = n * (n + 1) / 2.0\r\n            return sum((i + 1) * c for i, c in enumerate(w)) / den\r\n        raise ValueError(kind)\r\n\r\n    def _update_ema(self, closes, n):\r\n        # LEAN ExponentialMovingAverage: first sample seeds; then\r\n        # ema = ema + k * (x - ema); IsReady after n samples\r\n        k = 2.0 / (n + 1)\r\n        st = self.ema.get(n)\r\n        x = closes[-1]\r\n        if st is None:\r\n            self.ema[n] = [None, x, 1]\r\n            return\r\n        prev, cur, cnt = st\r\n        self.ema[n] = [cur, cur + k * (x - cur), cnt + 1]\r\n\r\n    def _ma_pair(self, closes, n, kind):\r\n        \"\"\"(MA yesterday, MA today) for the A-side pair test.\"\"\"\r\n        if kind == \"EMA\":\r\n            st = self.ema.get(n)\r\n            if st is None or st[2] < n + 1:\r\n                return None, None\r\n            return st[0], st[1]\r\n        today = self._ma_window(closes, n, kind)\r\n        yest = self._ma_window(closes[:-1], n, kind) if len(closes) >= n + 1 else None\r\n        return yest, today\r\n\r\n    def _crossed(self, x_y, x_t, y_y, y_t, direction):\r\n        if None in (x_y, x_t, y_y, y_t):\r\n            return False\r\n        up = (x_y <= y_y) and (x_t > y_t)\r\n        dn = (x_y >= y_y) and (x_t < y_t)\r\n        if direction == \"up\":\r\n            return up\r\n        if direction == \"down\":\r\n            return dn\r\n        if direction == \"any\":\r\n            return up or dn\r\n        if direction == \"level_above\":\r\n            return x_t > y_t\r\n        if direction == \"level_below\":\r\n            return x_t < y_t\r\n        raise ValueError(direction)\r\n\r\n    def _update_rsi(self, closes):\r\n        n = self.p[\"b_rsi_period\"]\r\n        self.rsi_prev = self.rsi_value\r\n        if len(closes) < 2:\r\n            return\r\n        ch = closes[-1] - closes[-2]\r\n        g, l = max(ch, 0.0), max(-ch, 0.0)\r\n        if self.p[\"dof_rsi_smoothing\"] == \"simple\":\r\n            if len(closes) < n + 1:\r\n                self.rsi_value = None\r\n                return\r\n            chs = [closes[i] - closes[i - 1] for i in range(len(closes) - n, len(closes))]\r\n            ag = sum(max(c, 0.0) for c in chs) / n\r\n            al = sum(max(-c, 0.0) for c in chs) / n\r\n        else:\r\n            if self.rsi_avg_gain is None:\r\n                self.rsi_seed.append((g, l))\r\n                if len(self.rsi_seed) < \x6e:\r\n                    self.rsi_value = None\r\n                    return\r\n                self.rsi_avg_gain = sum(x[0] for x in self.rsi_seed) / n\r\n                self.rsi_avg_loss = sum(x[1] for x in self.rsi_seed) / n\r\n            else:\r\n                self.rsi_avg_gain = (self.rsi_avg_gain * (n - 1) + g) / n\r\n                self.rsi_avg_loss = (self.rsi_avg_loss * (n - 1) + l) / n\r\n            ag, al = self.rsi_avg_gain, self.rsi_avg_loss\r\n        if al == 0:\r\n            self.rsi_value = 100.0\r\n        else:\r\n            self.rsi_value = 100.0 - 100.0 / (1.0 + ag / al)\r\n\r\n    def _red_streak(self, t):\r\n        closes, opens = self.closes[t], self.opens[t]\r\n        k = 0\r\n        i = len(closes) - 1\r\n        while i >= 1:\r\n            if self.p[\"b_red_def\"] == \"open_close\":\r\n                red = closes[i] < opens[i]\r\n            elif self.p[\"b_red_def\"] == \"prev_close_le\":\r\n                red = closes[i] <= closes[i - 1]\r\n            else:\r\n                red = closes[i] < closes[i - 1]\r\n            if red:\r\n                k += 1\r\n                i -= 1\r\n            else:\r\n                break\r\n        return k\r\n\r\n    # ---------- data plumbing ----------\r\n\r\n    def OnData(self, data):\r\n        # LOT RECONCILIATION (replaces the v2 split sync, which was applied\r\n        # unconditionally and in an unverified direction: it multiplied the\r\n        # private counter by 7 at the 2014 AAPL split even in adjusted mode,\r\n        # where LEAN does NOT rescale holdings — 694 of 4,086 oracle runs then\r\n        # sold 7x their lot and held an impossible short. Caught by opus-2 R2.\r\n        # In T1 exactly one strategy trades each ticker, so the PORTFOLIO\r\n        # POSITION *is* that strategy's owned lot: take reality as truth every\r\n        # bar, in every normalization mode, with no split arithmetic at all.\r\n        # lot_open / pending stay flag-based: they encode the strategy's own\r\n        # bookkeeping (the same-bar re-entry convention), not ownership.)\r\n        # round, never truncate: after a 7:1 split LEAN can report 237.9999,\r\n        # and int() would leave one share behind and never close the lot\r\n        self.a_shares = max(int(round(float(self.Portfolio[self.syms[\"SPY\"]].Quantity))), 0)\r\n        self.b_shares = max(int(round(float(self.Portfolio[self.syms[\"AAPL\"]].Quantity))), 0)\r\n\r\n        mb = self.p[\"missing_bar\"]\r\n        have = [t for t in self.tickers if data.Bars.ContainsKey(self.syms[t])]\r\n        if not have:\r\n            return  # auxiliary slice (no bars): nothing to update or evaluate\r\n        all_present = len(have) == len(self.tickers)\r\n\r\n        # state update: present tickers ALWAYS update history (the contract\r\n        # skips RULE EVALUATION on a missing-bar day, not market-state\r\n        # computation); no_guard reads blindly and crashes; try_except is\r\n        # atomic (compute, then commit)\r\n        if mb == \"no_guard\":\r\n            for t in self.tickers:\r\n                bar = data.Bars[self.syms[t]]  # KeyError on a missing ticker\r\n                self.closes[t].append(float(bar.Close)); self.opens[t].append(float(bar.Open))\r\n        elif mb == \"try_except\":\r\n            try:\r\n                upd = [(t, float(data.Bars[self.syms[t]].Close), float(data.Bars[self.syms[t]].Open))\r\n                       for t in self.tickers]\r\n            except KeyError:\r\n                return\r\n            for t, c, o in upd:\r\n                self.closes[t].append(c); self.opens[t].append(o)\r\n        else:  # skip_all / per_ticker\r\n            for t in have:\r\n                bar = data.Bars[self.syms[t]]\r\n                self.closes[t].append(float(bar.Close)); self.opens[t].append(float(bar.Open))\r\n\r\n        if \"SPY\" in have:\r\n            if self.p[\"a_ma_type\"] == \"EMA\":\r\n                self._update_ema(self.closes[\"SPY\"], self.p[\"a_ma_period\"])\r\n        if \"AAPL\" in have:\r\n            self._update_rsi(self.closes[\"AAPL\"])\r\n\r\n        self.bar_index += 1\r\n        if self.IsWarmingUp:\r\n            return\r\n        if mb == \"skip_all\" and not all_present:\r\n            return  # rule evaluation skipped for the day\r\n        wu = self.p[\"dof_warmup\"]\r\n        if wu == \"ready_check\" and not (self._ready_a() and self._ready_b()):\r\n            return\r\n        self._evaluate_rules(have)\r\n\r\n    # ---------- rule evaluation ----------\r\n\r\n    def _a_ok(self):\r\n        return self.p[\"dof_warmup\"] != \"ready_per_rule\" or self._ready_a()\r\n\r\n    def _b_ok(self):\r\n        return self.p[\"dof_warmup\"] != \"ready_per_rule\" or self._ready_b()\r\n\r\n    def _evaluate_rules(self, have):\r\n        sm = self.p[\"slot_mode\"]\r\n        if sm == \"sequence\":\r\n            self._evaluate_sequence(); return\r\n        buys_first = self.p.get(\"eval_order\", \"sells_first\") == \"buys_first\"\r\n        if sm == \"race\":\r\n            self._a_sell(); self._b_sell()\r\n            if self.race_owner is not None:\r\n                owner_open = self.a_lot_open if self.race_owner == \"A\" else self.b_lot_open\r\n                if not owner_open:\r\n                    self.race_owner = None\r\n                return\r\n            if self._a_ok() and self._a_buy_reason() and self._reentry_ok(\"A\"):\r\n                self._a_buy()\r\n                if self.a_lot_open: self.race_owner = \"A\"\r\n                return\r\n            if self._b_ok() and self._b_buy_reason() and self._reentry_ok(\"B\"):\r\n                self._b_buy()\r\n                if self.b_lot_open: self.race_owner = \"B\"\r\n            return\r\n        # parallel\r\n        if buys_first:\r\n            self._buys(); self._a_sell(); self._b_sell()\r\n        else:\r\n            self._a_sell(); self._b_sell(); self._buys()\r\n\r\n    def _buys(self):\r\n        if self._a_ok() and self._a_may_buy() and self._a_buy_reason() and self._reentry_ok(\"A\"):\r\n            self._a_buy()\r\n        if self._b_ok() and self._b_may_buy() and self._b_buy_reason() and self._reentry_ok(\"B\"):\r\n            self._b_buy()\r\n\r\n    def _evaluate_sequence(self):\r\n        # Registered SEQUENCE convention (sol-1 R1 #26, frozen jointly):\r\n        # round-trip COMPLETION = the lot back to empty (on the SELL FILL under\r\n        # wait_bar; at sell SUBMISSION under 'allowed'), and the handoff is\r\n        # IMMEDIATE — the newly eligible slot is evaluated in the SAME bar's\r\n        # evaluation (only RACE says \"re-opens the next bar\").\r\n        for _ in range(2):  # at most one handoff per bar\r\n            if self.seq_eligible == 1:\r\n                self._a_sell()\r\n                if self.seq_was_nonempty and not self.a_lot_open:\r\n                    self.seq_eligible, self.seq_was_nonempty = 2, False\r\n                    continue\r\n                if self._a_ok() and not self.a_lot_open and self._a_buy_reason() and self._reentry_ok(\"A\"):\r\n                    self._a_buy()\r\n                    if self.a_lot_open: self.seq_was_nonempty = True\r\n                return\r\n            else:\r\n                self._b_sell()\r\n                if self.seq_was_nonempty and not self.b_lot_open:\r\n                    self.seq_eligible, self.seq_was_nonempty = 1, False\r\n                    continue\r\n                if self._b_ok() and not self.b_lot_open and self._b_buy_reason() and self._reentry_ok(\"B\"):\r\n                    self._b_buy()\r\n                    if self.b_lot_open: self.seq_was_nonempty = True\r\n                return\r\n\r\n    def _reentry_ok(self, which):\r\n        # Behavioral: 'allowed' = the program's OWN bookkeeping marks the lot\r\n        # empty at sell SUBMISSION (a same-bar rebuy is possible); 'wait_bar'\r\n        # = the lot is considered held until the sell FILLS (Portfolio-state\r\n        # reading), so the earliest rebuy is the next bar. Implemented in\r\n        # _a_sell/_b_sell via lot_open; nothing further to gate here.\r\n        return True\r\n\r\n    def _a_may_buy(self):\r\n        mode = self.p[\"lots\"]\r\n        if mode == \"private\":\r\n            return not self.a_lot_open\r\n        if mode == \"invested_gate\":\r\n            return not self.Portfolio[self.syms[\"SPY\"]].Invested and self.a_pending == 0\r\n        if mode == \"shared_flag\":   # OM-C shared-state: ONE in-position flag for both slots\r\n            return not (self.a_lot_open or self.b_lot_open)\r\n        return True  # netting\r\n\r\n    def _b_may_buy(self):\r\n        mode = self.p[\"lots\"]\r\n        if mode == \"private\":\r\n            return not self.b_lot_open\r\n        if mode == \"invested_gate\":\r\n            return not self.Portfolio[self.syms[\"AAPL\"]].Invested and self.b_pending == 0\r\n        if mode == \"shared_flag\":\r\n            return not (self.a_lot_open or self.b_lot_open)\r\n        return True\r\n\r\n    # ---------- Strategy A ----------\r\n\r\n    def _a_cross(self, direction, period=None, kind=None):\r\n        closes = self.closes[\"SPY\"]\r\n        period = period or self.p[\"a_ma_period\"]\r\n        kind = kind or self.p[\"a_ma_type\"]\r\n        if len(closes) < 2:\r\n            return False\r\n        ma_y, ma_t = self._ma_pair(closes, period, kind)\r\n        if self.p[\"dof_cross_timing\"] == \"today_ma\":\r\n            ma_y = ma_t  # both closes tested against TODAY's MA\r\n        return self._crossed(closes[-2], closes[-1], ma_y, ma_t, direction)\r\n\r\n    def _ma_x_ma_cross(self, p_short, p_long, direction):\r\n        closes = self.closes[\"SPY\"]\r\n        s_y, s_t = self._ma_pair(closes, p_short, \"SMA\")\r\n        l_y, l_t = self._ma_pair(closes, p_long, \"SMA\")\r\n        return self._crossed(s_y, s_t, l_y, l_t, direction)\r\n\r\n    def _a_buy_reason(self):\r\n        if self.p[\"er01_sell\"] != \"none\":\r\n            return self._a_cross(\"up\", period=200, kind=\"SMA\")\r\n        return self._a_cross(self.p[\"a_buy_dir\"])\r\n\r\n    def _a_sell_reason(self):\r\n        er = self.p[\"er01_sell\"]\r\n        if er == \"none\":\r\n            return self._a_cross(self.p[\"a_sell_dir\"])\r\n        return {\r\n            \"R1\": lambda: self._a_cross(\"down\", period=50, kind=\"SMA\"),\r\n            \"R2\": lambda: self._a_cross(\"up\", period=50, kind=\"SMA\"),\r\n            \"R3\": lambda: self._ma_x_ma_cross(50, 200, \"down\"),\r\n            \"R4\": lambda: self._ma_x_ma_cross(50, 200, \"up\"),\r\n            \"R5\": lambda: self._a_cross(\"any\", period=50, kind=\"SMA\"),\r\n            \"R6\": lambda: self._ma_x_ma_cross(50, 200, \"any\"),\r\n        }[er]()\r\n\r\n    def _a_buy(self):\r\n        px = self.closes[\"SPY\"][-1]\r\n        tpv = float(self.Portfolio.TotalPortfolioValue)\r\n        pct = self.p[\"a_size_pct\"] / 100.0\r\n        if self.p[\"dof_a_exec\"] == \"set_holdings\":\r\n            before = int(self.Portfolio[self.syms[\"SPY\"]].Quantity)\r\n            self.SetHoldings(self.syms[\"SPY\"], pct)\r\n            # SetHoldings submits only if the target differs; detect via tickets\r\n            submitted = any(t.Symbol == self.syms[\"SPY\"] and t.Status not in (OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Invalid)\r\n                            for t in self.Transactions.GetOpenOrderTickets())\r\n            if not submitted:\r\n                return\r\n            self.a_pending = 1  # quantity unknown until fill; marker only\r\n        else:\r\n            base = float(self.Portfolio.Cash) if self.p[\"dof_a_exec\"] == \"pct_cash\" else tpv\r\n            shares = int(math.floor(base * pct / px))\r\n            if shares <= 0:\r\n                return\r\n            self.MarketOrder(self.syms[\"SPY\"], shares)\r\n            self.a_pending += shares\r\n        self.a_lot_open = True\r\n        self.a_last_action_bar = self.bar_index\r\n\r\n    def _a_holding(self):\r\n        if self.p[\"lots\"] == \"private\":\r\n            return self.a_shares\r\n        return max(int(self.Portfolio[self.syms[\"SPY\"]].Quantity), 0)\r\n\r\n    def _a_sell(self):\r\n        held = self._a_holding()\r\n        if held <= 0 or not self._a_ok() or not self._a_sell_reason():\r\n            return\r\n        frac = self.p[\"a_sell_frac\"]\r\n        if frac == \"all\":\r\n            qty = held\r\n        elif frac == \"half_down_lastsell\":\r\n            qty = 1 if held == 1 else held // 2\r\n        elif frac == \"half_down_hold\":\r\n            qty = held // 2\r\n        elif frac == \"half_up\":\r\n            qty = (held + 1) // 2\r\n        else:\r\n            raise ValueError(frac)\r\n        if qty > 0:\r\n            self.MarketOrder(self.syms[\"SPY\"], -qty)\r\n            self.a_pending -= qty\r\n            self.a_last_action_bar = self.bar_index\r\n            if qty >= held and self.p[\"dof_same_bar_reentry\"] == \"allowed\":\r\n                self.a_lot_open = False  # own bookkeeping: lot empty at submission\r\n\r\n    # ---------- Strategy B ----------\r\n\r\n    def _b_buy_reason(self):\r\n        return self._red_streak(\"AAPL\") >= self.p[\"b_red_days\"]\r\n\r\n    def _b_sell_reason(self):\r\n        if self.rsi_value is None:\r\n            return False\r\n        th = self.p[\"b_rsi_thresh\"]\r\n        if self.p[\"dof_rsi_exit\"] == \"cross\":\r\n            return self.rsi_prev is not None and self.rsi_prev <= th and self.rsi_value > th\r\n        return self.rsi_value > th\r\n\r\n    def _b_buy(self):\r\n        px = self.closes[\"AAPL\"][-1]\r\n        cash = float(self.Portfolio.Cash)\r\n        amt = self.p[\"b_cash_amt\"]\r\n        rule = self.p[\"b_cash_rule\"]\r\n        if rule == \"skip\":\r\n            if cash < amt:\r\n                return\r\n            shares = int(math.floor(amt / px))\r\n        elif rule == \"partial\":\r\n            shares = int(math.floor(min(cash, amt) / px))\r\n        else:\r\n            shares = int(math.floor(amt / px))\r\n        if shares > 0:\r\n            self.MarketOrder(self.syms[\"AAPL\"], shares)\r\n            self.b_pending += shares\r\n            self.b_lot_open = True\r\n            self.b_last_action_bar = self.bar_index\r\n\r\n    def _b_sell(self):\r\n        held = self.b_shares if self.p[\"lots\"] == \"private\" else max(int(self.Portfolio[self.syms[\"AAPL\"]].Quantity), 0)\r\n        if held <= 0 or not self._b_ok() or not self._b_sell_reason():\r\n            return\r\n        self.MarketOrder(self.syms[\"AAPL\"], -held)\r\n        self.b_pending -= held\r\n        self.b_last_action_bar = self.bar_index\r\n        if self.p[\"dof_same_bar_reentry\"] == \"allowed\":\r\n            self.b_lot_open = False  # own bookkeeping: lot empty at submission\r\n\r\n    # ---------- fill sync (both signs; partial fills accumulate) ----------\r\n\r\n    def OnOrderEvent(self, e):\r\n        sym = str(e.Symbol)\r\n        is_a = \"SPY\" in sym\r\n        is_b = \"AAPL\" in sym\r\n        if not (is_a or is_b):\r\n            return\r\n        if e.Status in (OrderStatus.Filled, OrderStatus.PartiallyFilled):\r\n            q = int(e.FillQuantity)\r\n            if is_\x61:\r\n                self.a_shares += q\r\n                if self.p[\"dof_a_exec\"] == \"set_holdings\" and q > 0:\r\n                    self.a_pending = 0\r\n                else:\r\n                    self.a_pending -= q\r\n                # lot closes on the SELL FILL only if no rebuy is pending\r\n                # (under 'allowed' a same-bar rebuy may already be in flight)\r\n                if e.Status == OrderStatus.Filled and self.a_shares <= 0 and self.a_pending <= 0:\r\n                    self.a_shares = 0; self.a_lot_open = False; self.a_pending = 0\r\n            else:\r\n                self.b_shares += q\r\n                self.b_pending -= q\r\n                if e.Status == OrderStatus.Filled and self.b_shares <= 0 and self.b_pending <= 0:\r\n                    self.b_shares = 0; self.b_lot_open = False; self.b_pending = 0\r\n        elif e.Status in (OrderStatus.Invalid, OrderStatus.Canceled):\r\n            if is_\x61:\r\n                self.a_pending = 0\r\n                if self.a_shares == 0:\r\n                    self.a_lot_open = False\r\n            else:\r\n                self.b_pending = 0\r\n                if self.b_shares == 0:\r\n                    self.b_lot_open = False\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/bank/t1_ref_template.py",
      "sha256": "182251ee85568b60acbc7a43c0b8a6c2153c4c8e44eac6c0c5e63d3c0323a9e2"
    },
    {
      "id": "lb-model-t1v0-gpt55-s0",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "T1v0 pinned model program (gpt55, seed 0)",
      "labels": [
        "Model program",
        "Python",
        "T1v0",
        "Matching code"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ExactStrategySystemAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.symbols = {}\r\n        for ticker in self.tickers:\r\n            self.symbols[ticker] = self.AddEquity(ticker, Resolution.Daily, Market.USA, False).Symbol\r\n\r\n        self.spy = self.symbols[\"SPY\"]\r\n        self.aapl = self.symbols[\"AAPL\"]\r\n\r\n        self.spy_sma = SimpleMovingAverage(100)\r\n        self.aapl_rsi = RelativeStrengthIndex(14, MovingAverageType.Wilders)\r\n\r\n        self.spy_lot = 0\r\n        self.aapl_lot = 0\r\n\r\n        self.spy_last_close = None\r\n        self.spy_last_sma = None\r\n        self.spy_prev_close_for_cross = None\r\n        self.spy_prev_sma_for_cross = None\r\n        self.spy_today_close = None\r\n        self.spy_today_sma = None\r\n\r\n        self.aapl_last_close = None\r\n        self.aapl_red_streak = 0\r\n        self.aapl_today_close = None\r\n\r\n    def OnData(self, data):\r\n        self.HandleSplits(data)\r\n        self.UpdateMarketState(data)\r\n\r\n        if not self.AllSubscribedBarsPresent(data):\r\n            return\r\n\r\n        if not self.AllRequiredHistoryReady():\r\n            return\r\n\r\n        spy_cross_above = (\r\n            self.spy_prev_close_for_cross <= self.spy_prev_sma_for_cross and\r\n            self.spy_today_close > self.spy_today_sma\r\n        )\r\n\r\n        spy_cross_below = (\r\n            self.spy_prev_close_for_cross >= self.spy_prev_sma_for_cross and\r\n            self.spy_today_close < self.spy_today_sma\r\n        )\r\n\r\n        aapl_red_for_3 = self.aapl_red_streak >= 3\r\n        aapl_rsi_above_60 = float(self.aapl_rsi.Current.Value) > 60.0\r\n\r\n        # Sells before buys.\r\n        if self.spy_lot > 0 and spy_cross_below:\r\n            self.MarketOrder(self.spy, -self.spy_lot, tag=\"Strategy A sell: SPY crossed below 100-day SMA\")\r\n            self.spy_lot = 0\r\n\r\n        if self.aapl_lot > 0 and aapl_rsi_above_60:\r\n            self.MarketOrder(self.aapl, -self.aapl_lot, tag=\"Strategy B sell: AAPL 14-day RSI above 60\")\r\n            self.aapl_lot = 0\r\n\r\n        # Buys after all sells, in slot order.\r\n        if self.spy_lot == 0 and spy_cross_above:\r\n            quantity = int((0.40 * float(self.Portfolio.TotalPortfolioValue)) / self.spy_today_close)\r\n            if quantity > 0:\r\n                self.MarketOrder(self.spy, quantity, tag=\"Strategy A buy: SPY crossed above 100-day SMA\")\r\n                self.spy_lot = quantity\r\n\r\n        if self.aapl_lot == 0 and aapl_red_for_3:\r\n            cash_to_invest = 20000.0\r\n            if float(self.Portfolio.Cash) >= cash_to_invest:\r\n                quantity = int(cash_to_invest / self.aapl_today_close)\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.aapl, quantity, tag=\"Strategy B buy: AAPL red for 3 consecutive days\")\r\n                    self.aapl_lot = quantity\r\n\r\n    def HandleSplits(self, data):\r\n        if data.Splits is None:\r\n            return\r\n\r\n        for symbol, split in data.Splits.items():\r\n            if split.Type != SplitType.SplitOccurred:\r\n                continue\r\n\r\n            factor = float(split.SplitFactor)\r\n            if factor == 0:\r\n                continue\r\n\r\n            if symbol == self.spy and self.spy_lot > 0:\r\n                self.spy_lot = int(round(self.spy_lot / factor))\r\n\r\n            if symbol == self.aapl and self.aapl_lot > 0:\r\n                self.aapl_lot = int(round(self.aapl_lot / factor))\r\n\r\n    def UpdateMarketState(self, data):\r\n        if data.Bars is None:\r\n            return\r\n\r\n        if self.spy in data.Bars:\r\n            bar = data.Bars[self.spy]\r\n\r\n            self.spy_prev_close_for_cross = self.spy_last_close\r\n            self.spy_prev_sma_for_cross = self.spy_last_sma if self.spy_sma.IsReady else None\r\n\r\n            self.spy_sma.Update(IndicatorDataPoint(bar.EndTime, bar.Close))\r\n\r\n            self.spy_last_close = float(bar.Close)\r\n            self.spy_last_sma = float(self.spy_sma.Current.Value) if self.spy_sma.IsReady else None\r\n\r\n            self.spy_today_close = float(bar.Close)\r\n            self.spy_today_sma = self.spy_last_sma\r\n\r\n        if self.aapl in data.Bars:\r\n            bar = data.Bars[self.aapl]\r\n            close = float(bar.Close)\r\n\r\n            if self.aapl_last_close is None:\r\n                self.aapl_red_streak = 0\r\n            elif close < self.aapl_last_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.aapl_rsi.Update(IndicatorDataPoint(bar.EndTime, bar.Close))\r\n\r\n            self.aapl_last_close = close\r\n            self.aapl_today_close = close\r\n\r\n    def AllSubscribedBarsPresent(self, data):\r\n        if data.Bars is None:\r\n            return False\r\n\r\n        for symbol in self.symbols.values():\r\n            if symbol not in data.Bars:\r\n                return False\r\n\r\n        return True\r\n\r\n    def AllRequiredHistoryReady(self):\r\n        return (\r\n            self.spy_sma.IsReady and\r\n            self.spy_prev_close_for_cross is not None and\r\n            self.spy_prev_sma_for_cross is not None and\r\n            self.spy_today_close is not None and\r\n            self.spy_today_sma is not None and\r\n            self.aapl_rsi.IsReady and\r\n            self.aapl_last_close is not None and\r\n            self.aapl_today_close is not None\r\n        )\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/codebook/fixtures/real/T1v0_gpt55_s0.py",
      "sha256": "918a843a0d0969a9c2ed1d7fa34a27f6719d460f6d3cc5e7f648a7338802ac18"
    },
    {
      "id": "lb-model-t1v0-gpt55-s1",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "T1v0 pinned model program (gpt55, seed 1)",
      "labels": [
        "Model program",
        "Python",
        "T1v0",
        "Matching code"
      ],
      "text": "from AlgorithmImports import *\r\nfrom decimal import Decimal\r\n\r\n\r\nclass ExactStrategySystemAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.symbol_by_ticker = {}\r\n\r\n        for ticker in self.tickers:\r\n            security = self.AddEquity(ticker, Resolution.Daily)\r\n            security.SetDataNormalizationMode(DataNormalizationMode.Adjusted)\r\n            self.symbol_by_ticker[ticker] = security.Symbol\r\n\r\n        self.symbols = [self.symbol_by_ticker[ticker] for ticker in self.tickers]\r\n\r\n        self.spy = self.symbol_by_ticker[\"SPY\"]\r\n        self.aapl = self.symbol_by_ticker[\"AAPL\"]\r\n\r\n        self.spy_sma = SimpleMovingAverage(100)\r\n        self.aapl_rsi = RelativeStrengthIndex(14, MovingAverageType.Wilders)\r\n\r\n        self.previous_close = {symbol: None for symbol in self.symbols}\r\n        self.aapl_red_streak = 0\r\n\r\n        self.strategy_a_quantity = 0\r\n        self.strategy_b_quantity = 0\r\n\r\n        self.SetWarmUp(101, Resolution.Daily)\r\n\r\n    def OnData(self, data):\r\n        bars = {}\r\n        all_subscribed_bars_present = True\r\n\r\n        for symbol in self.symbols:\r\n            if data.Bars.ContainsKey(symbol) and data.Bars[symbol] is not None:\r\n                bars[symbol] = data.Bars[symbol]\r\n            else:\r\n                all_subscribed_bars_present = False\r\n\r\n        spy_previous_close = self.previous_close[self.spy]\r\n        spy_previous_sma_ready = self.spy_sma.IsReady\r\n        spy_previous_sma = self.spy_sma.Current.Value if spy_previous_sma_ready else None\r\n\r\n        if self.spy in bars:\r\n            self.spy_sma.Update(bars[self.spy].EndTime, bars[self.spy].Close)\r\n\r\n        if self.aapl in bars:\r\n            aapl_bar = bars[self.aapl]\r\n            aapl_previous_close = self.previous_close[self.aapl]\r\n\r\n            if aapl_previous_close is not None:\r\n                if aapl_bar.Close < aapl_previous_close:\r\n                    self.aapl_red_streak += 1\r\n                else:\r\n                    self.aapl_red_streak = 0\r\n\r\n            self.aapl_rsi.Update(aapl_bar.EndTime, aapl_bar.Close)\r\n\r\n        for symbol, bar in bars.items():\r\n            self.previous_close[symbol] = bar.Close\r\n\r\n        if self.IsWarmingUp:\r\n            return\r\n\r\n        self.SyncPrivateLotsWithPortfolio()\r\n\r\n        if not all_subscribed_bars_present:\r\n            return\r\n\r\n        spy_close = bars[self.spy].Close\r\n        spy_current_sma_ready = self.spy_sma.IsReady\r\n        spy_current_sma = self.spy_sma.Current.Value if spy_current_sma_ready else None\r\n\r\n        aapl_close = bars[self.aapl].Close\r\n        aapl_rsi_ready = self.aapl_rsi.IsReady\r\n        aapl_rsi_value = self.aapl_rsi.Current.Value if aapl_rsi_ready else None\r\n\r\n        strategy_a_indicators_ready = (\r\n            spy_previous_close is not None\r\n            and spy_previous_sma_ready\r\n            and spy_current_sma_ready\r\n        )\r\n\r\n        strategy_b_indicators_ready = (\r\n            self.previous_close[self.aapl] is not None\r\n            and aapl_rsi_ready\r\n        )\r\n\r\n        # Sells before buys.\r\n\r\n        # Slot 1 - Strategy A sell\r\n        if self.strategy_a_quantity > 0 and strategy_a_indicators_ready:\r\n            spy_crosses_below_sma = (\r\n                spy_previous_close >= spy_previous_sma\r\n                and spy_close < spy_current_sma\r\n            )\r\n\r\n            if spy_crosses_below_sma:\r\n                self.MarketOrder(self.spy, -self.strategy_a_quantity, False, \"Strategy A Sell\")\r\n                self.strategy_a_quantity = 0\r\n\r\n        # Slot 2 - Strategy B sell\r\n        if self.strategy_b_quantity > 0 and strategy_b_indicators_ready:\r\n            if aapl_rsi_value > Decimal(\"60\"):\r\n                self.MarketOrder(self.aapl, -self.strategy_b_quantity, False, \"Strategy B Sell\")\r\n                self.strategy_b_quantity = 0\r\n\r\n        # Slot 1 - Strategy A buy\r\n        if self.strategy_a_quantity == 0 and strategy_a_indicators_ready:\r\n            spy_crosses_above_sma = (\r\n                spy_previous_close <= spy_previous_sma\r\n                and spy_close > spy_current_sma\r\n            )\r\n\r\n            if spy_crosses_above_sma:\r\n                target_value = self.Portfolio.TotalPortfolioValue * Decimal(\"0.40\")\r\n                quantity = int(target_value / spy_close)\r\n\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.spy, quantity, False, \"Strategy A Buy\")\r\n                    self.strategy_a_quantity = quantity\r\n\r\n        # Slot 2 - Strategy B buy\r\n        if self.strategy_b_quantity == 0 and strategy_b_indicators_ready:\r\n            if self.aapl_red_streak >= 3:\r\n                cash_to_invest = Decimal(\"20000\")\r\n\r\n                if self.Portfolio.Cash >= cash_to_invest:\r\n                    quantity = int(cash_to_invest / aapl_close)\r\n\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.aapl, quantity, False, \"Strategy B Buy\")\r\n                        self.strategy_b_quantity = quantity\r\n\r\n    def SyncPrivateLotsWithPortfolio(self):\r\n        if self.strategy_a_quantity > 0:\r\n            self.strategy_a_quantity = max(0, int(self.Portfolio[self.spy].Quantity))\r\n\r\n        if self.strategy_b_quantity > 0:\r\n            self.strategy_b_quantity = max(0, int(self.Portfolio[self.aapl].Quantity))\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/codebook/fixtures/real/T1v0_gpt55_s1.py",
      "sha256": "ebd57d723463893a21062ef25d830529a0aca07e529d90f2379d4da335f3d699"
    },
    {
      "id": "lb-model-t1v0-sonnet-s0",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "T1v0 pinned model program (sonnet, seed 0)",
      "labels": [
        "Model program",
        "Python",
        "T1v0",
        "Matching code"
      ],
      "text": "from AlgorithmImports import *\r\n\r\nclass ComplexityAxisAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self._tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self._symbols = {}\r\n        for ticker in self._tickers:\r\n            self._symbols[ticker] = self.AddEquity(ticker, Resolution.Daily).Symbol\r\n\r\n        spy_sym = self._symbols[\"SPY\"]\r\n        aapl_sym = self._symbols[\"AAPL\"]\r\n\r\n        self._spy_sma = self.SMA(spy_sym, 100, Resolution.Daily)\r\n        self._aapl_rsi = self.RSI(aapl_sym, 14, MovingAverageType.Wilders, Resolution.Daily)\r\n\r\n        # Previous-bar values for cross detection and red-streak tracking\r\n        self._prev_spy_close = None\r\n        self._prev_spy_sma = None\r\n        self._prev_aapl_close = None\r\n        self._aapl_red_streak = 0\r\n\r\n        # Each strategy tracks its own lot in shares\r\n        self._strategy_a_shares = 0\r\n        self._strategy_b_shares = 0\r\n\r\n        # 150 daily bars: covers SMA(100) + extra bar for prev-SMA + margin\r\n        self.SetWarmUp(150, Resolution.Daily)\r\n\r\n    def OnData(self, data):\r\n        # Skip if any subscribed ticker is missing a bar\r\n        for symbol in self._symbols.values():\r\n            if not data.Bars.ContainsKey(symbol):\r\n                return\r\n\r\n        spy_close = data.Bars[self._symbols[\"SPY\"]].Close\r\n        aapl_close = data.Bars[self._symbols[\"AAPL\"]].Close\r\n\r\n        # Update AAPL consecutive red-day count before overwriting prev close\r\n        if self._prev_aapl_close is not None:\r\n            if aapl_close < self._prev_aapl_close:\r\n                self._aapl_red_streak += 1\r\n            else:\r\n                self._aapl_red_streak = 0\r\n\r\n        spy_sma_today = self._spy_sma.Current.Value if self._spy_sma.IsReady else None\r\n        aapl_rsi_today = self._aapl_rsi.Current.Value if self._aapl_rsi.IsReady else None\r\n\r\n        # All indicators must be ready and prev values must exist before trading\r\n        if (not self.IsWarmingUp\r\n                and spy_sma_today is not None\r\n                and aapl_rsi_today is not None\r\n                and self._prev_spy_close is not None\r\n                and self._prev_spy_sma is not None):\r\n\r\n            # Cross: yesterday X <= Y and today X > Y  (above); mirror for below\r\n            spy_cross_above = (self._prev_spy_close <= self._prev_spy_sma) and (spy_close > spy_sma_today)\r\n            spy_cross_below = (self._prev_spy_close >= self._prev_spy_sma) and (spy_close < spy_sma_today)\r\n\r\n            aapl_red_3 = self._aapl_red_streak >= 3\r\n            aapl_rsi_above_60 = aapl_rsi_today > 60\r\n\r\n            # ----- SELLS before BUYS -----\r\n\r\n            # Strategy A sell: SPY crosses below 100-day SMA → liquidate entire lot\r\n            if self._strategy_a_shares > 0 and spy_cross_below:\r\n                self.MarketOrder(self._symbols[\"SPY\"], -self._strategy_a_shares)\r\n                self._strategy_a_shares = 0\r\n\r\n            # Strategy B sell: AAPL 14-day RSI > 60 → liquidate entire lot\r\n            if self._strategy_b_shares > 0 and aapl_rsi_above_60:\r\n                self.MarketOrder(self._symbols[\"AAPL\"], -self._strategy_b_shares)\r\n                self._strategy_b_shares = 0\r\n\r\n            # ----- BUYS -----\r\n\r\n            # Strategy A buy: SPY crosses above 100-day SMA → invest 40% of portfolio\r\n            if self._strategy_a_shares == 0 and spy_cross_above:\r\n                target = self.Portfolio.TotalPortfolioValue * 0.40\r\n                shares = int(target / spy_close)\r\n                if shares > 0:\r\n                    self.MarketOrder(self._symbols[\"SPY\"], shares)\r\n                    self._strategy_a_shares = shares\r\n\r\n            # Strategy B buy: AAPL red 3+ consecutive days → buy $20k if cash available\r\n            if self._strategy_b_shares == 0 and aapl_red_3:\r\n                if self.Portfolio.Cash >= 20_000:\r\n                    shares = int(20_000 / aapl_close)\r\n                    if shares > 0:\r\n                        self.MarketOrder(self._symbols[\"AAPL\"], shares)\r\n                        self._strategy_b_shares = shares\r\n\r\n        # Always update previous-bar values (including during warm-up)\r\n        self._prev_spy_close = spy_close\r\n        self._prev_aapl_close = aapl_close\r\n        if spy_sma_today is not None:\r\n            self._prev_spy_sma = spy_sma_today\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/codebook/fixtures/real/T1v0_sonnet_s0.py",
      "sha256": "72b243b8751284e343c36e1eef08024ed37a2d312369034788fa9f7f60e03ee9"
    },
    {
      "id": "lb-model-t1v0-sonnet-s1",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "T1v0 pinned model program (sonnet, seed 1)",
      "labels": [
        "Model program",
        "Python",
        "T1v0",
        "Matching code"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ComplexityAxisSpikeAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.symbols = {t: self.AddEquity(t, Resolution.Daily).Symbol for t in tickers}\r\n\r\n        self.spy_sma = self.SMA(\"SPY\", 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\"AAPL\", 14, MovingAverageType.Wilders, Resolution.Daily)\r\n\r\n        # Previous-bar state needed for cross detection\r\n        self.spy_prev_close = None\r\n        self.spy_prev_sma = None\r\n        self.aapl_prev_close = None\r\n\r\n        # Rolling count of consecutive red days for AAPL\r\n        self.aapl_red_streak = 0\r\n\r\n        # Private lot share counts; non-zero means the lot is open\r\n        self.strategy_a_shares = 0\r\n        self.strategy_b_shares = 0\r\n\r\n    def OnData(self, data):\r\n        # If any subscribed ticker is missing a bar, skip all rule evaluation\r\n        for sym in self.symbols.values():\r\n            if not data.Bars.ContainsKey(sym):\r\n                return\r\n\r\n        spy_close = data.Bars[self.symbols[\"SPY\"]].Close\r\n        aapl_close = data.Bars[self.symbols[\"AAPL\"]].Close\r\n\r\n        # Update AAPL consecutive red day streak before evaluating rules\r\n        if self.aapl_prev_close is not None:\r\n            if aapl_close < self.aapl_prev_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n        spy_sma_ready = self.spy_sma.IsReady\r\n        aapl_rsi_ready = self.aapl_rsi.IsReady\r\n        spy_sma_value = self.spy_sma.Current.Value if spy_sma_ready else None\r\n        aapl_rsi_value = self.aapl_rsi.Current.Value if aapl_rsi_ready else None\r\n\r\n        # ── SELLS (evaluated before buys) ────────────────────────────────────\r\n\r\n        # Strategy A sell: SPY close crosses below its 100-day SMA\r\n        # Cross below: yesterday close >= yesterday SMA  AND  today close < today SMA\r\n        if (self.strategy_a_shares > 0\r\n                and spy_sma_ready\r\n                and self.spy_prev_close is not None\r\n                and self.spy_prev_sma is not None):\r\n            if self.spy_prev_close >= self.spy_prev_sma and spy_close < spy_sma_value:\r\n                self.Liquidate(self.symbols[\"SPY\"])\r\n                self.strategy_a_shares = 0\r\n\r\n        # Strategy B sell: AAPL 14-day RSI closes above 60\r\n        if self.strategy_b_shares > 0 and aapl_rsi_ready:\r\n            if aapl_rsi_value > 60:\r\n                self.Liquidate(self.symbols[\"AAPL\"])\r\n                self.strategy_b_shares = 0\r\n\r\n        # ── BUYS ─────────────────────────────────────────────────────────────\r\n\r\n        # Strategy A buy: SPY close crosses above its 100-day SMA\r\n        # Cross above: yesterday close <= yesterday SMA  AND  today close > today SMA\r\n        if (self.strategy_a_shares == 0\r\n                and spy_sma_ready\r\n                and self.spy_prev_close is not None\r\n                and self.spy_prev_sma is not None):\r\n            if self.spy_prev_close <= self.spy_prev_sma and spy_close > spy_sma_value:\r\n                target_value = 0.40 * self.Portfolio.TotalPortfolioValue\r\n                shares = int(target_value / spy_close)\r\n                if shares > 0:\r\n                    self.MarketOrder(self.symbols[\"SPY\"], shares)\r\n                    self.strategy_a_shares = shares\r\n\r\n        # Strategy B buy: AAPL has been red for 3 or more consecutive days\r\n        # Wait for RSI(14) to be ready (RSI is used in Strategy B's sell rule)\r\n        if (self.strategy_b_shares == 0\r\n                and aapl_rsi_ready\r\n                and self.aapl_red_streak >= 3):\r\n            if self.Portfolio.Cash >= 20000:\r\n                shares = int(20000 / aapl_close)\r\n                if shares > 0:\r\n                    self.MarketOrder(self.symbols[\"AAPL\"], shares)\r\n                    self.strategy_b_shares = shares\r\n\r\n        # Persist end-of-bar state for cross detection on the next bar\r\n        self.spy_prev_close = spy_close\r\n        self.spy_prev_sma = spy_sma_value\r\n        self.aapl_prev_close = aapl_close\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/codebook/fixtures/real/T1v0_sonnet_s1.py",
      "sha256": "8eb7578a5fcb1d4d28370ea5bd209cda2318fcd7b413af3eabb542a32cc46931"
    },
    {
      "id": "lb-t1-variant-bl-00",
      "version": "1",
      "kind": "atom",
      "role": "placebo",
      "title": "T1v0 variant BL-00 — paraphrase placebo: strict reorder of the modifiers, no content word added (amended 2026-08-16)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "placebo"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its simple 100-day moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its simple 100-day moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "dc8329f99845ab9b867f03c62651a90066960b08c4829b81e868ba3e3faf12e7",
      "donor": {
        "record": "variants",
        "variantId": "BL-00",
        "base": "T1v0",
        "role": "placebo",
        "description": "paraphrase placebo: strict reorder of the modifiers, no content word added (amended 2026-08-16)",
        "charsDelta": 0,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-02a",
      "version": "1",
      "kind": "atom",
      "role": "control",
      "title": "T1v0 variant BL-02a — contract-semantics control: delete cross bullet only",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "control"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "6706a65f4746d80fc8c718e8f8f7c58b8633d0f76bdd42d40faab79652c1488a",
      "donor": {
        "record": "variants",
        "variantId": "BL-02a",
        "base": "T1v0",
        "role": "control",
        "description": "contract-semantics control: delete cross bullet only",
        "charsDelta": -220,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-01a",
      "version": "1",
      "kind": "atom",
      "role": "anchor",
      "title": "T1v0 variant BL-01a — type blanked (ANCHOR)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "anchor"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "27212fc94490e0ba32462f84fc9f9c1fd09a4447696395cd9d4509e98eceac0a",
      "donor": {
        "record": "variants",
        "variantId": "BL-01a",
        "base": "T1v0",
        "role": "anchor",
        "description": "type blanked (ANCHOR)",
        "charsDelta": -14,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw02-program",
          "lb-draw14-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-01b",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-01b — period blanked",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "21a703f12b8412d75aaeba0068d22702f0a1a669fe9dd950e839d99f23b8ad1f",
      "donor": {
        "record": "variants",
        "variantId": "BL-01b",
        "base": "T1v0",
        "role": "eligible",
        "description": "period blanked",
        "charsDelta": -16,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw03-program",
          "lb-draw06-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-01c",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-01c — type AND period blanked",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "91d2e38f80f700a495eed3db59a68991e6ff4f8cb3ec3de7f9767002976d044c",
      "donor": {
        "record": "variants",
        "variantId": "BL-01c",
        "base": "T1v0",
        "role": "eligible",
        "description": "type AND period blanked",
        "charsDelta": -30,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw04-program",
          "lb-draw07-program",
          "lb-draw20-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-02b-prime",
      "version": "1",
      "kind": "atom",
      "role": "placebo",
      "title": "T1v0 variant BL-02b' — FORM-CHANGE PLACEBO: full-information noun-event frame + cross bullet deleted",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "placebo"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: an upward cross of SPY's close through its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: a downward cross of SPY's close through its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "badbeade48a637406f3540924744a88e269bb4d3f3c6b7d894e0b66152f55388",
      "donor": {
        "record": "variants",
        "variantId": "BL-02b'",
        "base": "T1v0",
        "role": "placebo",
        "description": "FORM-CHANGE PLACEBO: full-information noun-event frame + cross bullet deleted",
        "charsDelta": -193,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-02b",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-02b — operands dropped, direction kept + cross bullet deleted",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: an upward 100-day simple-moving-average cross on SPY.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: a downward 100-day simple-moving-average cross on SPY.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "8423bf1cca81e4cb7c2edbaba41ab45afaa1560659544c828b3569d304bbb657",
      "donor": {
        "record": "variants",
        "variantId": "BL-02b",
        "base": "T1v0",
        "role": "eligible",
        "description": "operands dropped, direction kept + cross bullet deleted",
        "charsDelta": -233,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-02c",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-02c — directionless: both reason clauses identical + cross bullet deleted",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: a 100-day simple-moving-average cross on SPY.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: a 100-day simple-moving-average cross on SPY.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "c5c464bf38c624d45fa011731ff86976a8bbe92f9d0f4a03245d06ed3b393e4e",
      "donor": {
        "record": "variants",
        "variantId": "BL-02c",
        "base": "T1v0",
        "role": "eligible",
        "description": "directionless: both reason clauses identical + cross bullet deleted",
        "charsDelta": -250,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-03",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-03 — A size 40% -> unspecified percentage",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest a percentage of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "e1e751557fedc395b3ec47662124073c37f4708db1d7424763ba99473d9c57b2",
      "donor": {
        "record": "variants",
        "variantId": "BL-03",
        "base": "T1v0",
        "role": "eligible",
        "description": "A size 40% -> unspecified percentage",
        "charsDelta": 9,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw18-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-04",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-04 — red/green definition deleted (counting sentence stays)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "d2b208a355a9f62d2d04558327e74a9df5c2718ad4da0d0a13ba1d865fdadd01",
      "donor": {
        "record": "variants",
        "variantId": "BL-04",
        "base": "T1v0",
        "role": "eligible",
        "description": "red/green definition deleted (counting sentence stays)",
        "charsDelta": -121,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw11-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-05",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-05 — '3 consecutive days' -> 'a number of consecutive days'",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for a number of consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "8b854f54fc796653965de446cd80de68f3354f38a167e97fc7b52afc4a531995",
      "donor": {
        "record": "variants",
        "variantId": "BL-05",
        "base": "T1v0",
        "role": "eligible",
        "description": "'3 consecutive days' -> 'a number of consecutive days'",
        "charsDelta": 10,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw12-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-06",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-06 — shortfall outcome blanked (two-span coupled edit; '$C if available' key stays bound)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares.\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if available.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "24d1495f2885e8b8223f78b5f91cac9a8c524fec77b711315ea55a4d75a7c557",
      "donor": {
        "record": "variants",
        "variantId": "BL-06",
        "base": "T1v0",
        "role": "eligible",
        "description": "shortfall outcome blanked (two-span coupled edit; '$C if available' key stays bound)",
        "charsDelta": -146,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-07",
      "version": "1",
      "kind": "atom",
      "role": "anchor",
      "title": "T1v0 variant BL-07 — RSI period blanked (ANCHOR)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "anchor"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "8d83b691ecb29e238459239c43460bc9c856b664b08a636ae3537ec44c5cb2be",
      "donor": {
        "record": "variants",
        "variantId": "BL-07",
        "base": "T1v0",
        "role": "anchor",
        "description": "RSI period blanked (ANCHOR)",
        "charsDelta": -7,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw09-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-08",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-08 — RSI threshold blanked",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above a threshold.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "3b6ef7d61b80aa85855d3b4da4902ccd6fe0abe9fd3e5e08ad800ed482ce74e8",
      "donor": {
        "record": "variants",
        "variantId": "BL-08",
        "base": "T1v0",
        "role": "eligible",
        "description": "RSI threshold blanked",
        "charsDelta": 9,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw17-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-bl-09a",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-09a — A sell details -> 'sell.' (contract untouched)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: sell.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "d50bafb6d1018c9839705dac3a37fb0bfc92e7797a8a6fe12cfed3e1203a580e",
      "donor": {
        "record": "variants",
        "variantId": "BL-09a",
        "base": "T1v0",
        "role": "eligible",
        "description": "A sell details -> 'sell.' (contract untouched)",
        "charsDelta": -29,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-bl-09b",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "T1v0 variant BL-09b — same body change + 'sell half' sentence deleted ('closed' sentence stays)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: sell.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "f247c8c0b0715aad5334c06226ab63e03e2e67ddf927b32f95f6f5c3fabe594b",
      "donor": {
        "record": "variants",
        "variantId": "BL-09b",
        "base": "T1v0",
        "role": "eligible",
        "description": "same body change + 'sell half' sentence deleted ('closed' sentence stays)",
        "charsDelta": -155,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-om-a",
      "version": "1",
      "kind": "atom",
      "role": "secondary",
      "title": "T1v0 variant OM-A — missing-bar skip rule deleted (contract)",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "secondary"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close.\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "b89816f8761d5029ce4a5354d41c4deb98cd0e8a94ff85f0cf68dad91a6a84c2",
      "donor": {
        "record": "variants",
        "variantId": "OM-A",
        "base": "T1v0",
        "role": "secondary",
        "description": "missing-bar skip rule deleted (contract)",
        "charsDelta": -123,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-om-b",
      "version": "1",
      "kind": "atom",
      "role": "secondary",
      "title": "T1v0 variant OM-B — private-lots / sells-before-buys bullet deleted",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "secondary"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "d5eb00e080a7ab3d552a6218b4dd80a8f812740bd1fbef543e305e86c806d6ed",
      "donor": {
        "record": "variants",
        "variantId": "OM-B",
        "base": "T1v0",
        "role": "secondary",
        "description": "private-lots / sells-before-buys bullet deleted",
        "charsDelta": -257,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15",
        "programBundleIds": [
          "lb-draw10-program",
          "lb-draw15-program",
          "lb-draw19-program"
        ]
      }
    },
    {
      "id": "lb-t1-variant-om-c",
      "version": "1",
      "kind": "atom",
      "role": "secondary",
      "title": "T1v0 variant OM-C — slot-independence declaration removed",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "secondary"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 100-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 100-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "1aedfed8ac05cdccea9821c81a69852ddefc57416d5b616ad673803379327ab0",
      "donor": {
        "record": "variants",
        "variantId": "OM-C",
        "base": "T1v0",
        "role": "secondary",
        "description": "slot-independence declaration removed",
        "charsDelta": -42,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-er-01",
      "version": "1",
      "kind": "atom",
      "role": "eligible_second_donor",
      "title": "T1v0 variant ER-01 — referent-ambiguity probe: A buys on 200-day cross up, sells 'when the SMA(50) crosses'",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "eligible-second-donor"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 200-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: when the SMA(50) crosses.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "cd725ace5a82dffdcacd4e1edc1964469a010a5e430b321768c232974c82eca4",
      "donor": {
        "record": "variants",
        "variantId": "ER-01",
        "base": "T1v0",
        "role": "eligible-second-donor",
        "description": "referent-ambiguity probe: A buys on 200-day cross up, sells 'when the SMA(50) crosses'",
        "charsDelta": -35,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "lb-t1-variant-er-01c",
      "version": "1",
      "kind": "atom",
      "role": "control_second_donor",
      "title": "T1v0 variant ER-01c — ER-01 pinned control: sell rule pinned to R1 (close crosses below SMA(50))",
      "labels": [
        "T1v0 variant",
        "variants-v5",
        "control-second-donor"
      ],
      "text": "Write a complete QuantConnect LEAN algorithm in Python (one class inheriting from QCAlgorithm).\n\nFixed setup requirements:\n- Backtest period: 2006-01-03 through 2015-12-31 (inclusive).\n- Starting cash: $1,000,000.\n- Subscribe to these US equities at DAILY resolution: \"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\".\n\nImplement EXACTLY the following strategy system. Do not add, remove, or reinterpret any rule.\n\nSEMANTICS CONTRACT (these definitions are exact; follow them):\n- All rules are evaluated once per daily bar, after the close. If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\n- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day's values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\n- A \"red day\" for a ticker means its close is strictly below the PREVIOUS day's close. A \"green day\" means strictly above. \"Red for n consecutive days\" is satisfied on any day that completes n or more consecutive red days.\n- \"d% or more below its highest close of the previous N trading days\" compares today's close with the maximum CLOSE over the N days before today (not including today).\n- \"Gaps down by g% or more\" means today's OPEN is at least g% below YESTERDAY's close.\n- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\n- Buy detail \"invest p% of portfolio\" means set that lot to p% of total portfolio value. Buy detail \"buy $C if available\" means: if current available cash is at least $C, buy floor($C / close) shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\n- Sell detail \"sell half\" means sell half of the lot's current shares rounded down (sell the last share when only one remains). A lot is \"closed\" when it reaches zero shares.\n- STATE-GATED template: its strategies may act only while the gate condition is true. On the bar the gate turns false, immediately liquidate every lot held inside the template (including nested templates), clear any race ownership and reset any sequence progress inside it. Market-state quantities (streak counts, rolling highs, indicator values) are always computed from data continuously; gates never pause those computations.\n- EVENT-GATED template: when its event condition BECOMES true (true today, false yesterday), the template is ARMED for the next m trading days starting tomorrow. While armed, its strategies may act. When the arming window expires, liquidate every lot inside the template and reset its internal state. A new event edge while armed restarts the window.\n- RACE template (first-come-first-served): while no slot owns the template, check each slot's buy reason every bar in slot order; the first slot whose buy reason (including any attached qualifier, checked on that same bar) is satisfied claims sole ownership and executes its buy details. Other slots may not act while ownership lasts. Ownership ends when the owner's lot is closed; the race re-opens the next bar.\n- SEQUENCE template: only one slot is eligible at a time, starting with slot 1. A slot becomes ineligible and passes eligibility to the next slot after it completes a full round trip (its lot went from empty to non-empty and back to empty). After the last slot's round trip, eligibility returns to slot 1.\n- Do not trade until every indicator or rolling window used by a rule has enough history to be fully formed.\n\nSTRATEGY SYSTEM:\nOne template with 2 slots, no gate. Both slots run independently in parallel.\n\n- Slot 1 - Strategy A (trades SPY):\n  - Reason to buy: SPY's close crosses above its 200-day simple moving average.\n  - Buy details: invest 40% of total portfolio value in SPY.\n  - Reason to sell: SPY's close crosses below its 50-day simple moving average.\n  - Sell details: liquidate Strategy A's entire lot.\n- Slot 2 - Strategy B (trades AAPL):\n  - Reason to buy: AAPL has been red for 3 consecutive days.\n  - Buy details: buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\n  - Reason to sell: AAPL's 14-day RSI closes above 60.\n  - Sell details: liquidate Strategy B's entire lot.\n\nOutput ONLY the complete Python code in a single ```python code block. No explanation before or after.",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/prompts/variants-v5.json",
      "sha256": "ab9d7e0391d81213ab24e4dc727a615909b21cda7a4a163a6d575d9f68658bc6",
      "donor": {
        "record": "variants",
        "variantId": "ER-01c",
        "base": "ER-01",
        "role": "control-second-donor",
        "description": "ER-01 pinned control: sell rule pinned to R1 (close crosses below SMA(50))",
        "charsDelta": -1,
        "pin": "PIN-v5-2026-08-15",
        "generated": "2026-08-15"
      }
    },
    {
      "id": "o1-variant-o1p1",
      "version": "1",
      "kind": "atom",
      "role": "placebo",
      "title": "O1v0 variant O1p1 — Reorder two independent data-subscription specifications without changing content.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "placebo"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Use New York time and minute-resolution, raw-price SPY equity data. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1p1.txt",
      "sha256": "12cdacf945911057eec569c327cd2bd16e9a818780ce20f2810770eeaca4143c",
      "donor": {
        "record": "variants",
        "variantId": "O1p1",
        "base": "O1v0.txt",
        "role": "placebo",
        "description": "Reorder two independent data-subscription specifications without changing content.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1c1",
      "version": "1",
      "kind": "atom",
      "role": "control",
      "title": "O1v0 variant O1c1 — Delete the DTE definition, whose calendar-date meaning is recoverable from the adjacent expiry rule.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "control"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1c1.txt",
      "sha256": "fbffcf07f80384b578b617fff58313fe75a32e99326ede4970d3e006094483d9",
      "donor": {
        "record": "variants",
        "variantId": "O1c1",
        "base": "O1v0.txt",
        "role": "control",
        "description": "Delete the DTE definition, whose calendar-date meaning is recoverable from the adjacent expiry rule.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1a1",
      "version": "1",
      "kind": "atom",
      "role": "anchor",
      "title": "O1v0 variant O1a1 — Blank the repeatedly recoverable underlying symbol.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "anchor"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest ____ from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1a1.txt",
      "sha256": "e8f6de544348f9fc1446f37e5ab7b8e51cec42a83dc08d444358c667f1fec6d3",
      "donor": {
        "record": "variants",
        "variantId": "O1a1",
        "base": "O1v0.txt",
        "role": "anchor",
        "description": "Blank the repeatedly recoverable underlying symbol.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1a2",
      "version": "1",
      "kind": "atom",
      "role": "anchor",
      "title": "O1v0 variant O1a2 — Blank the implementation language, recoverable from the requested file suffix and framework register.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "anchor"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in ____ using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1a2.txt",
      "sha256": "04d3c98191911ab42ce0e3089cafa1a2b478d308c9130cf399de9310ffe0ff02",
      "donor": {
        "record": "variants",
        "variantId": "O1a2",
        "base": "O1v0.txt",
        "role": "anchor",
        "description": "Blank the implementation language, recoverable from the requested file suffix and framework register.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e1",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e1 — Delete the strike-selection convention.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts. \n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e1.txt",
      "sha256": "1518a980defe0f2bdfdc996a5332f43c49937921fbd0edaf06be3233c6e04e2c",
      "donor": {
        "record": "variants",
        "variantId": "O1e1",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the strike-selection convention.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e2",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e2 — Delete the expiry and minimum-DTE selection convention.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e2.txt",
      "sha256": "7a77773dcea2b9a56d6434b0402d2206447254159e3cc20bd96c57c08ac9d9dc",
      "donor": {
        "record": "variants",
        "variantId": "O1e2",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the expiry and minimum-DTE selection convention.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e3",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e3 — Delete the option-type convention and its redundant grammatical traces.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY option at a time. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected contract is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e3.txt",
      "sha256": "7416850f597058b003fee0d3b516a950a34c47abc358dc1eb9813ef4934b2d0e",
      "donor": {
        "record": "variants",
        "variantId": "O1e3",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the option-type convention and its redundant grammatical traces.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e4",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e4 — Delete the position-size convention.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nSubmit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e4.txt",
      "sha256": "c85e38f0af5ef5353490d3ca9e0a56e3d5ce1590ace5d8ca41dd68bef000c391",
      "donor": {
        "record": "variants",
        "variantId": "O1e4",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the position-size convention.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e5",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e5 — Delete the numerical profit-target threshold.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e5.txt",
      "sha256": "2c8942fbdbba5f816784a298939bee3eaecdc87f4d4ca6713974c349632d6502",
      "donor": {
        "record": "variants",
        "variantId": "O1e5",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the numerical profit-target threshold.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e6",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e6 — Delete the exercise-or-assignment equity-position handling convention.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. \n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e6.txt",
      "sha256": "c291a5ef51627cd43a92674cfa93b95d4d2378bb7fdd37b1163e6143dfbc37b3",
      "donor": {
        "record": "variants",
        "variantId": "O1e6",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the exercise-or-assignment equity-position handling convention.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e7",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e7 — Delete the no-match handling convention.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a 20-bar simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e7.txt",
      "sha256": "2308d644257ebe78ece1642517a65b12db3bc437d7507d0b31bd6126ac915a0a",
      "donor": {
        "record": "variants",
        "variantId": "O1e7",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the no-match handling convention.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "o1-variant-o1e8",
      "version": "1",
      "kind": "atom",
      "role": "eligible",
      "title": "O1v0 variant O1e8 — Delete the slow-average lookback parameter.",
      "labels": [
        "O1v0 variant",
        "variants-o1",
        "eligible"
      ],
      "text": "Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework. Return one self-contained .py file with the algorithm class and all required imports.\n\nBacktest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash. Use New York time and minute-resolution, raw-price SPY equity data. Subscribe to SPY options at minute resolution and keep the option universe broad enough to contain the contracts specified below. Do not use future data.\n\nTrade one long SPY call at a time. The option type is call, never put. Enter only after a bullish moving-average crossover observed on consolidated five-minute SPY TradeBars. Build each five-minute bar from minute data aligned to New York clock boundaries, so the first regular-session bar ends at 09:35. The fast average is a 5-bar simple moving average of five-minute closing prices. The slow average is a simple moving average of five-minute closing prices. A bullish crossover occurs when the fast average is less than or equal to the slow average on the preceding completed five-minute bar and is strictly greater than the slow average on the current completed five-minute bar. Both averages must be ready before testing the signal.\n\nOnly open a position when the crossover bar ends from 09:45 through 14:30 New York time, inclusive. Evaluate entry once, immediately after each eligible five-minute bar closes. If a SPY five-minute bar is missing, do not synthesize or forward-fill it; update neither average for that interval and wait for the next actual consolidated bar.\n\nAt entry, inspect the option chain delivered in the current Slice. Choose the nearest expiration whose calendar date is at least 7 calendar days after the current algorithm date. Days to expiration means the difference between the contract expiration date and the current algorithm date, measured in calendar dates rather than trading sessions or 24-hour periods. Within that expiration, consider only call contracts and select the lowest strike that is greater than or equal to 101% of the current SPY price. Thus the selected call is the first listed strike at least 1% out of the money; break an equal-strike tie by the ascending string value of the contract Symbol.\n\nBuy exactly 1 contract. Submit a market order for the selected contract immediately after selection. Do not submit a limit, stop, combo, or market-on-close order. Record the filled entry price from the entry order event; do not use the quote observed when the order was submitted. Do not submit another entry while an option holding exists or while an entry order is open.\n\nAfter the entry fill, evaluate exits on each minute Slice. Define the current option price as the midpoint of a strictly positive bid and ask for the held contract in the current Slice. A 50% profit target is reached when that midpoint is at least 1.50 times the filled entry price. When the profit target is reached, submit one market order to liquidate the entire option position and cancel any other open exit order. Independently, if the position remains open at 15:45 New York time on the trading day immediately preceding the contract's expiration date, submit one market order to liquidate the entire option position. If the held contract has no current quote or its bid or ask is missing or nonpositive, skip the profit-target test for that Slice; the scheduled time stop still applies.\n\nNever intentionally hold a contract into expiration. If an option position nevertheless remains when expiration processing begins, submit a market order to liquidate it and do not open a replacement that day. If exercise or assignment processing nevertheless creates a SPY equity position, liquidate the entire SPY equity position with a market order immediately and do not treat it as a strategy entry.\n\nIf the current Slice has no option chain, no expiration satisfies the rule, or no contract at the selected expiration satisfies the type and strike rules, skip that entry signal without throwing an exception or falling back to another contract. A skipped signal is not queued for later; wait for a new bullish crossover.\n\nWarm the moving averages only with SPY five-minute bars from the requested backtest period. Add concise Debug messages for entries, exits, skipped selections, and unexpected exercise or assignment handling.\n",
      "parameters": {},
      "semantics": {
        "kind": "prompt"
      },
      "source": "historical/LEAN-Bench/arm-options/variants-o1/O1e8.txt",
      "sha256": "6a86d0fa464131d80683009ddbaacb740ebfebae238ddba8e135c0a661ecea85",
      "donor": {
        "record": "variants",
        "variantId": "O1e8",
        "base": "O1v0.txt",
        "role": "eligible",
        "description": "Delete the slow-average lookback parameter.",
        "index": "historical/LEAN-Bench/arm-options/variants-o1.json"
      }
    },
    {
      "id": "lb-draw01-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 1 extracted program — T1v0 on gpt-5.6-luna_xhigh",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass TwoSlotStrategyAlgorithm(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.subscribed_symbols = [\r\n            self.spy,\r\n            self.aapl,\r\n            self.ibm,\r\n            self.bac,\r\n            self.aig,\r\n        ]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl,\r\n            14,\r\n            MovingAverageType.Wilders,\r\n            Resolution.Daily\r\n        )\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n        self.strategy_a_lot = 0\r\n        self.strategy_b_lot = 0\r\n\r\n    def OnData(self, data):\r\n        spy_bar = data.Bars[self.spy] if data.Bars.ContainsKey(self.spy) else None\r\n        aapl_bar = data.Bars[self.aapl] if data.Bars.ContainsKey(self.aapl) else None\r\n\r\n        spy_buy_signal = False\r\n        spy_sell_signal = False\r\n\r\n        if spy_bar is not None:\r\n            spy_close = float(spy_bar.Close)\r\n\r\n            if self.spy_sma.IsReady:\r\n                current_spy_sma = float(self.spy_sma.Current.Value)\r\n\r\n                if (\r\n                    self.previous_spy_close is not None\r\n                    and self.previous_spy_sma is not None\r\n                ):\r\n                    spy_buy_signal = (\r\n                        self.previous_spy_close <= self.previous_spy_sma\r\n                        and spy_close > current_spy_sma\r\n                    )\r\n                    spy_sell_signal = (\r\n                        self.previous_spy_close >= self.previous_spy_sma\r\n                        and spy_close < current_spy_sma\r\n                    )\r\n\r\n                self.previous_spy_sma = current_spy_sma\r\n\r\n            self.previous_spy_close = spy_close\r\n\r\n        aapl_buy_signal = False\r\n        aapl_sell_signal = False\r\n\r\n        if aapl_bar is not None:\r\n            aapl_close = float(aapl_bar.Close)\r\n\r\n            if self.previous_aapl_close is None:\r\n                self.aapl_red_streak = 0\r\n            elif aapl_close < self.previous_aapl_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.previous_aapl_close = aapl_close\r\n\r\n            if self.aapl_rsi.IsReady:\r\n                aapl_sell_signal = float(self.aapl_rsi.Current.Value) > 60\r\n\r\n            aapl_buy_signal = self.aapl_red_streak >= 3\r\n\r\n        if not all(\r\n            data.Bars.ContainsKey(symbol)\r\n            for symbol in self.subscribed_symbols\r\n        ):\r\n            return\r\n\r\n        spy_close = float(data.Bars[self.spy].Close)\r\n        aapl_close = float(data.Bars[self.aapl].Close)\r\n\r\n        # Evaluate sells before buys.\r\n        if self.strategy_a_lot > 0 and spy_sell_signal:\r\n            self.MarketOrder(self.spy, -self.strategy_a_lot)\r\n            self.strategy_a_lot = 0\r\n\r\n        if self.strategy_b_lot > 0 and aapl_sell_signal:\r\n            self.MarketOrder(self.aapl, -self.strategy_b_lot)\r\n            self.strategy_b_lot = 0\r\n\r\n        if self.strategy_a_lot == 0 and spy_buy_signal and self.spy_sma.IsReady:\r\n            target_value = 0.40 * float(self.Portfolio.TotalPortfolioValue)\r\n            quantity = int(target_value / spy_close)\r\n\r\n            if quantity > 0:\r\n                self.MarketOrder(self.spy, quantity)\r\n                self.strategy_a_lot = quantity\r\n\r\n        if (\r\n            self.strategy_b_lot == 0\r\n            and aapl_buy_signal\r\n            and float(self.Portfolio.Cash) >= 20000\r\n        ):\r\n            quantity = int(20000 / aapl_close)\r\n\r\n            if quantity > 0:\r\n                self.MarketOrder(self.aapl, quantity)\r\n                self.strategy_b_lot = quantity\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw01/3-EXTRACTED-PROGRAM.py",
      "sha256": "25a55db3709a379ca9de2d121f7a4bf82a3e64ca5376ade05b0a4f32e6cb46ed",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 1,
        "arm": "arm",
        "lane": "gpt-5.6-luna_xhigh",
        "promptId": "T1v0",
        "i": 2,
        "claimedStatus": "coded",
        "claimedCode": "SMA100"
      }
    },
    {
      "id": "lb-draw02-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 2 extracted program — BL-01a on gpt-5.6-luna_max",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\nimport math\r\n\r\n\r\nclass ExactStrategyAlgorithm(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.symbols = (\r\n            self.spy,\r\n            self.aapl,\r\n            self.ibm,\r\n            self.bac,\r\n            self.aig,\r\n        )\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl,\r\n            14,\r\n            MovingAverageType.Wilders,\r\n            Resolution.Daily\r\n        )\r\n\r\n        self.strategy_a_lot = 0\r\n        self.strategy_b_lot = 0\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n    def OnData(self, data):\r\n        bars = {}\r\n        all_bars_present = True\r\n\r\n        for symbol in self.symbols:\r\n            if data.Bars.ContainsKey(symbol):\r\n                bars[symbol] = data.Bars[symbol]\r\n            else:\r\n                bars[symbol] = None\r\n                all_bars_present = False\r\n\r\n        spy_close = None\r\n        current_spy_sma = None\r\n        prior_spy_close = self.previous_spy_close\r\n        prior_spy_sma = self.previous_spy_sma\r\n\r\n        if bars[self.spy] is not None:\r\n            spy_close = float(bars[self.spy].Close)\r\n\r\n            if self.spy_sma.IsReady:\r\n                current_spy_sma = float(self.spy_sma.Current.Value)\r\n                self.previous_spy_sma = current_spy_sma\r\n\r\n            self.previous_spy_close = spy_close\r\n\r\n        if bars[self.aapl] is not None:\r\n            aapl_close = float(bars[self.aapl].Close)\r\n\r\n            if self.previous_aapl_close is None:\r\n                self.aapl_red_streak = 0\r\n            elif aapl_close < self.previous_aapl_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.previous_aapl_close = aapl_close\r\n\r\n        if not all_bars_present:\r\n            return\r\n\r\n        spy_buy_reason = (\r\n            current_spy_sma is not None\r\n            and prior_spy_close is not None\r\n            and prior_spy_sma is not None\r\n            and prior_spy_close <= prior_spy_sma\r\n            and spy_close > current_spy_sma\r\n        )\r\n\r\n        spy_sell_reason = (\r\n            current_spy_sma is not None\r\n            and prior_spy_close is not None\r\n            and prior_spy_sma is not None\r\n            and prior_spy_close >= prior_spy_sma\r\n            and spy_close < current_spy_sma\r\n        )\r\n\r\n        aapl_buy_reason = self.aapl_red_streak >= 3\r\n        aapl_sell_reason = (\r\n            self.aapl_rsi.IsReady\r\n            and float(self.aapl_rsi.Current.Value) > 60.0\r\n        )\r\n\r\n        if self.strategy_a_lot > 0 and spy_sell_reason:\r\n            self.MarketOrder(self.spy, -self.strategy_a_lot)\r\n            self.strategy_a_lot = 0\r\n\r\n        if self.strategy_b_lot > 0 and aapl_sell_reason:\r\n            self.MarketOrder(self.aapl, -self.strategy_b_lot)\r\n            self.strategy_b_lot = 0\r\n\r\n        if self.strategy_a_lot == 0 and spy_buy_reason and spy_close > 0:\r\n            target_value = 0.40 * float(self.Portfolio.TotalPortfolioValue)\r\n            quantity = int(math.floor(target_value / spy_close))\r\n\r\n            if quantity > 0:\r\n                self.MarketOrder(self.spy, quantity)\r\n                self.strategy_a_lot = quantity\r\n\r\n        if self.strategy_b_lot == 0 and aapl_buy_reason:\r\n            aapl_close = float(bars[self.aapl].Close)\r\n\r\n            if aapl_close > 0 and float(self.Portfolio.Cash) >= 20000.0:\r\n                quantity = int(math.floor(20000.0 / aapl_close))\r\n\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.aapl, quantity)\r\n                    self.strategy_b_lot = quantity\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw02/3-EXTRACTED-PROGRAM.py",
      "sha256": "83d03c1df82219a1f0fd2cf598a0f8eb4811a34a3f95c1f473e1b9b7d66d30cc",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 2,
        "arm": "arm",
        "lane": "gpt-5.6-luna_max",
        "promptId": "BL-01a",
        "i": 3,
        "claimedStatus": "coded",
        "claimedCode": "SMA",
        "promptBundleId": "lb-t1-variant-bl-01a"
      }
    },
    {
      "id": "lb-draw03-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 3 extracted program — BL-01b on gpt-5.6-terra_medium",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "EMPTY-TAPE"
      ],
      "text": "from AlgorithmImports import *\r\nimport math\r\n\r\n\r\nclass ParallelSmaAndRsiStrategies(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.symbols = {}\r\n        for ticker in [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]:\r\n            self.symbols[ticker] = self.AddEquity(ticker, Resolution.Daily).Symbol\r\n\r\n        self.spy = self.symbols[\"SPY\"]\r\n        self.aapl = self.symbols[\"AAPL\"]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 50, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(self.aapl, 14, MovingAverageType.Wilders, Resolution.Daily)\r\n\r\n        self.spy_close_history = RollingWindow[float](2)\r\n        self.aapl_close_history = RollingWindow[float](2)\r\n\r\n        self.aapl_red_streak = 0\r\n\r\n        self.strategy_a_shares = 0\r\n        self.strategy_b_shares = 0\r\n\r\n    def OnData(self, data: Slice):\r\n        for symbol in self.symbols.values():\r\n            if not data.Bars.ContainsKey(symbol):\r\n                return\r\n\r\n        spy_close = data.Bars[self.spy].Close\r\n        aapl_close = data.Bars[self.aapl].Close\r\n\r\n        if self.aapl_close_history.Count > 0:\r\n            if aapl_close < self.aapl_close_history[0]:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n        history_ready = (\r\n            self.spy_sma.IsReady and\r\n            self.aapl_rsi.IsReady and\r\n            self.spy_close_history.Count == 2 and\r\n            self.aapl_close_history.Count == 1\r\n        )\r\n\r\n        if history_ready:\r\n            yesterday_spy_close = self.spy_close_history[0]\r\n            yesterday_spy_sma = self.spy_sma.Window[1].Value\r\n            today_spy_sma = self.spy_sma.Current.Value\r\n\r\n            spy_crosses_above_sma = (\r\n                yesterday_spy_close <= yesterday_spy_sma and\r\n                spy_close > today_spy_sma\r\n            )\r\n            spy_crosses_below_sma = (\r\n                yesterday_spy_close >= yesterday_spy_sma and\r\n                spy_close < today_spy_sma\r\n            )\r\n\r\n            if self.strategy_a_shares > 0 and spy_crosses_below_sma:\r\n                self.MarketOrder(self.spy, -self.strategy_a_shares)\r\n                self.strategy_a_shares = 0\r\n\r\n            if self.strategy_b_shares > 0 and self.aapl_rsi.Current.Value > 60:\r\n                self.MarketOrder(self.aapl, -self.strategy_b_shares)\r\n                self.strategy_b_shares = 0\r\n\r\n            if self.strategy_a_shares == 0 and spy_crosses_above_sma:\r\n                shares = int(math.floor(\r\n                    0.40 * self.Portfolio.TotalPortfolioValue / spy_close\r\n                ))\r\n                if shares > 0:\r\n                    self.MarketOrder(self.spy, shares)\r\n                    self.strategy_a_shares = shares\r\n\r\n            if (\r\n                self.strategy_b_shares == 0 and\r\n                self.aapl_red_streak >= 3 and\r\n                self.Portfolio.Cash >= 20_000\r\n            ):\r\n                shares = int(math.floor(20_000 / aapl_close))\r\n                if shares > 0:\r\n                    self.MarketOrder(self.aapl, shares)\r\n                    self.strategy_b_shares = shares\r\n\r\n        self.spy_close_history.Add(spy_close)\r\n        self.aapl_close_history.Add(aapl_close)\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw03/3-EXTRACTED-PROGRAM.py",
      "sha256": "5b8f70fa18c9c5e2b026a330c8d5d745495d3c4659c662aec7ef661db87caa7e",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 3,
        "arm": "arm",
        "lane": "gpt-5.6-terra_medium",
        "promptId": "BL-01b",
        "i": 4,
        "claimedStatus": "EMPTY-TAPE",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-01b"
      }
    },
    {
      "id": "lb-draw04-program",
      "version": "1",
      "kind": "atom",
      "role": "no_program_extracted",
      "title": "Draw 4 extracted program — BL-01c on gpt-5.6-luna_high",
      "labels": [
        "No program extracted",
        "Python",
        "Matching code",
        "Verification packet",
        "asks-clarifying"
      ],
      "text": "# (no program extracted)",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw04/3-EXTRACTED-PROGRAM.py",
      "sha256": "2989ca72b02fa12c1e3a4050cbef07de32aa1010cd86ac575acb29e4811cc472",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 4,
        "arm": "arm",
        "lane": "gpt-5.6-luna_high",
        "promptId": "BL-01c",
        "i": 5,
        "claimedStatus": "asks-clarifying",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-01c"
      }
    },
    {
      "id": "lb-draw05-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 5 extracted program — T1v0 on gpt-5.6-terra_high",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass IndependentSlotsAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n        self.symbols = [self.spy, self.aapl, self.ibm, self.bac, self.aig]\r\n\r\n        self.spy_closes = RollingWindow[float](101)\r\n        self.aapl_closes = RollingWindow[float](2)\r\n        self.aapl_red_streak = 0\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl, 14, MovingAverageType.Wilders, Resolution.Daily\r\n        )\r\n\r\n        self.strategy_a_shares = 0\r\n        self.strategy_b_shares = 0\r\n\r\n    def OnData(self, data: Slice):\r\n        # Market-state quantities continue updating whenever their own data exists.\r\n        if self.spy in data.Bars:\r\n            self.spy_closes.Add(float(data.Bars[self.spy].Close))\r\n\r\n        if self.aapl in data.Bars:\r\n            self.aapl_closes.Add(float(data.Bars[self.aapl].Close))\r\n            if self.aapl_closes.Count >= 2:\r\n                if self.aapl_closes[0] < self.aapl_closes[1]:\r\n                    self.aapl_red_streak += 1\r\n                else:\r\n                    self.aapl_red_streak = 0\r\n\r\n        # Skip all rule evaluation unless every subscribed ticker has today's bar.\r\n        if not all(symbol in data.Bars for symbol in self.symbols):\r\n            return\r\n\r\n        # Do not trade until all indicators and rolling windows used by rules are ready.\r\n        if self.spy_closes.Count < 101 or self.aapl_closes.Count < 2:\r\n            return\r\n        if not self.aapl_rsi.IsReady:\r\n            return\r\n\r\n        spy_close = float(data.Bars[self.spy].Close)\r\n        aapl_close = float(data.Bars[self.aapl].Close)\r\n\r\n        current_spy_sma = sum(self.spy_closes[i] for i in range(100)) / 100.0\r\n        previous_spy_sma = sum(self.spy_closes[i] for i in range(1, 101)) / 100.0\r\n        previous_spy_close = self.spy_closes[1]\r\n\r\n        spy_crosses_above_sma = (\r\n            previous_spy_close <= previous_spy_sma\r\n            and spy_close > current_spy_sma\r\n        )\r\n        spy_crosses_below_sma = (\r\n            previous_spy_close >= previous_spy_sma\r\n            and spy_close < current_spy_sma\r\n        )\r\n\r\n        # Evaluate sells before buys.\r\n        if self.strategy_a_shares > 0 and spy_crosses_below_sma:\r\n            self.MarketOrder(self.spy, -self.strategy_a_shares)\r\n            self.strategy_a_shares = 0\r\n\r\n        if self.strategy_b_shares > 0 and self.aapl_rsi.Current.Value > 60:\r\n            self.MarketOrder(self.aapl, -self.strategy_b_shares)\r\n            self.strategy_b_shares = 0\r\n\r\n        if self.strategy_a_shares == 0 and spy_crosses_above_sma:\r\n            quantity = int((self.Portfolio.TotalPortfolioValue * 0.40) / spy_close)\r\n            if quantity > 0:\r\n                self.MarketOrder(self.spy, quantity)\r\n                self.strategy_a_shares = quantity\r\n\r\n        if self.strategy_b_shares == 0 and self.aapl_red_streak >= 3:\r\n            if self.Portfolio.Cash >= 20_000:\r\n                quantity = int(20_000 / aapl_close)\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.aapl, quantity)\r\n                    self.strategy_b_shares = quantity\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw05/3-EXTRACTED-PROGRAM.py",
      "sha256": "c2f9ceb61770bf3dc3f070bba10be42d85c594f6ba7793db9d83356366de29b0",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 5,
        "arm": "arm",
        "lane": "gpt-5.6-terra_high",
        "promptId": "T1v0",
        "i": 4,
        "claimedStatus": "coded",
        "claimedCode": "SMA100"
      }
    },
    {
      "id": "lb-draw06-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 6 extracted program — BL-01b on claude-haiku-4-5_high",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "non-runnable"
      ],
      "text": "from AlgorithmImportLib import *\r\n\r\nclass QuantConnectLeanAlgorithm(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n        \r\n        tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.symbols = {}\r\n        for ticker in tickers:\r\n            self.symbols[ticker] = self.AddEquity(ticker, Resolution.Daily).Symbol\r\n        \r\n        self.spy_closes = []\r\n        self.aapl_closes = []\r\n        self.sma_period = 20\r\n        self.rsi_period = 14\r\n    \r\n    def OnData(self, data):\r\n        for symbol in self.symbols.values():\r\n            if not data.ContainsKey(symbol):\r\n                return\r\n        \r\n        spy_close = data[self.symbols[\"SPY\"]].Close\r\n        aapl_close = data[self.symbols[\"AAPL\"]].Close\r\n        \r\n        self.spy_closes.append(spy_close)\r\n        self.aapl_closes.append(aapl_close)\r\n        \r\n        if len(self.spy_closes) > self.sma_period + 1:\r\n            self.spy_closes.pop(0)\r\n        if len(self.aapl_closes) > self.rsi_period + 1:\r\n            self.aapl_closes.pop(0)\r\n        \r\n        if len(self.spy_closes) < self.sma_period + 1 or len(self.aapl_closes) < self.rsi_period + 1:\r\n            return\r\n        \r\n        self.evaluate_sells(spy_close, aapl_close)\r\n        self.evaluate_buys(spy_close, aapl_close)\r\n    \r\n    def evaluate_sells(self, spy_close, aapl_close):\r\n        spy_qty = self.Portfolio[self.symbols[\"SPY\"]].Quantity\r\n        if spy_qty > 0:\r\n            prev_close = self.spy_closes[-2]\r\n            prev_sma = sum(self.spy_closes[:-1]) / self.sma_period\r\n            curr_sma = sum(self.spy_closes[1:]) / self.sma_period\r\n            \r\n            if prev_close > prev_sma and spy_close <= curr_sma:\r\n                self.Liquidate(self.symbols[\"SPY\"])\r\n        \r\n        aapl_qty = self.Portfolio[self.symbols[\"AAPL\"]].Quantity\r\n        if aapl_qty > 0:\r\n            rsi = self.calculate_rsi(self.aapl_closes)\r\n            if rsi is not None and rsi > 60:\r\n                self.Liquidate(self.symbols[\"AAPL\"])\r\n    \r\n    def evaluate_buys(self, spy_close, aapl_close):\r\n        spy_qty = self.Portfolio[self.symbols[\"SPY\"]].Quantity\r\n        if spy_qty == 0:\r\n            prev_close = self.spy_closes[-2]\r\n            prev_sma = sum(self.spy_closes[:-1]) / self.sma_period\r\n            curr_sma = sum(self.spy_closes[1:]) / self.sma_period\r\n            \r\n            if prev_close <= prev_sma and spy_close > curr_sma:\r\n                portfolio_value = self.Portfolio.TotalPortfolioValue\r\n                invest_amount = portfolio_value * 0.4\r\n                qty = int(invest_amount / spy_close)\r\n                if qty > 0:\r\n                    self.Buy(self.symbols[\"SPY\"], qty)\r\n        \r\n        aapl_qty = self.Portfolio[self.symbols[\"AAPL\"]].Quantity\r\n        if aapl_qty == 0:\r\n            red_count = 0\r\n            for i in range(len(self.aapl_closes) - 1, len(self.aapl_closes) - 4, -1):\r\n                if i > 0 and self.aapl_closes[i] < self.aapl_closes[i-1]:\r\n                    red_count += 1\r\n                else:\r\n                    break\r\n            \r\n            if red_count >= 3:\r\n                if self.Portfolio.Cash >= 20000:\r\n                    qty = int(20000 / aapl_close)\r\n                    if qty > 0:\r\n                        self.Buy(self.symbols[\"AAPL\"], qty)\r\n    \r\n    def calculate_rsi(self, closes):\r\n        if len(closes) < self.rsi_period + 1:\r\n            return None\r\n        \r\n        relevant_closes = closes[-(self.rsi_period + 1):]\r\n        \r\n        gains = 0.0\r\n        losses = 0.0\r\n        \r\n        for i in range(1, len(relevant_closes)):\r\n            change = relevant_closes[i] - relevant_closes[i-1]\r\n            if change > 0:\r\n                gains += change\r\n            else:\r\n                losses -= change\r\n        \r\n        avg_gain = gains / self.rsi_period\r\n        avg_loss = losses / self.rsi_period\r\n        \r\n        if avg_loss == 0:\r\n            return 100.0 if avg_gain > 0 else 50.0\r\n        \r\n        rs = avg_gain / avg_loss\r\n        rsi = 100.0 - (100.0 / (1.0 + rs))\r\n        return rsi\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw06/3-EXTRACTED-PROGRAM.py",
      "sha256": "445318dfba936b8080be41da16be93f7c7175498a45a78f0ac1bc7f8b9005406",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 6,
        "arm": "arm",
        "lane": "claude-haiku-4-5_high",
        "promptId": "BL-01b",
        "i": 7,
        "claimedStatus": "non-runnable",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-01b"
      }
    },
    {
      "id": "lb-draw07-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 7 extracted program — BL-01c on claude-haiku-4-5_medium",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "non-runnable"
      ],
      "text": "from AlgorithmImportBaseClasses import *\r\nfrom AlgorithmImportIndicators import *\r\n\r\nclass QuantConnectAlgorithm(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n        \r\n        tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        self.symbols = {}\r\n        for ticker in tickers:\r\n            symbol = self.AddEquity(ticker, Resolution.Daily).Symbol\r\n            self.symbols[ticker] = symbol\r\n        \r\n        self.spy_sma = SimpleMovingAverage(20)\r\n        self.RegisterIndicator(self.symbols[\"SPY\"], self.spy_sma, Resolution.Daily)\r\n        \r\n        self.aapl_rsi = RelativeStrengthIndex(14)\r\n        self.RegisterIndicator(self.symbols[\"AAPL\"], self.aapl_rsi, Resolution.Daily)\r\n        \r\n        self.aapl_red_days = 0\r\n        self.prev_spy_close = None\r\n        self.prev_spy_sma = None\r\n        self.prev_aapl_close = None\r\n        self.trading_started = False\r\n        \r\n    def OnData(self, data):\r\n        required_tickers = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        for ticker in required_tickers:\r\n            if self.symbols[ticker] not in data:\r\n                return\r\n        \r\n        spy_close = self.Securities[self.symbols[\"SPY\"]].Close\r\n        aapl_close = self.Securities[self.symbols[\"AAPL\"]].Close\r\n        \r\n        if self.prev_aapl_close is not None and aapl_close < self.prev_aapl_close:\r\n            self.aapl_red_days += 1\r\n        else:\r\n            self.aapl_red_days = 0\r\n        \r\n        if not self.spy_sma.IsReady or not self.aapl_rsi.IsReady:\r\n            self.prev_spy_close = spy_close\r\n            self.prev_aapl_close = aapl_close\r\n            self.prev_spy_sma = self.spy_sma.Current.Value\r\n            return\r\n        \r\n        if not self.trading_started:\r\n            self.trading_started = True\r\n            self.prev_spy_close = spy_close\r\n            self.prev_aapl_close = aapl_close\r\n            self.prev_spy_sma = self.spy_sma.Current.Value\r\n            return\r\n        \r\n        spy_sma_value = self.spy_sma.Current.Value\r\n        aapl_rsi_value = self.aapl_rsi.Current.Value\r\n        \r\n        spy_quantity = self.Portfolio[self.symbols[\"SPY\"]].Quantity\r\n        aapl_quantity = self.Portfolio[self.symbols[\"AAPL\"]].Quantity\r\n        \r\n        if spy_quantity > 0:\r\n            if self.prev_spy_close > self.prev_spy_sma and spy_close <= spy_sma_value:\r\n                self.MarketOrder(self.symbols[\"SPY\"], -spy_quantity)\r\n        \r\n        if aapl_quantity > 0:\r\n            if aapl_rsi_value > 60:\r\n                self.MarketOrder(self.symbols[\"AAPL\"], -aapl_quantity)\r\n        \r\n        if spy_quantity == 0:\r\n            if self.prev_spy_close <= self.prev_spy_sma and spy_close > spy_sma_value:\r\n                portfolio_value = self.Portfolio.TotalPortfolioValue\r\n                target_value = portfolio_value * 0.4\r\n                shares_to_buy = int(target_value / spy_close)\r\n                if shares_to_buy > 0:\r\n                    self.MarketOrder(self.symbols[\"SPY\"], shares_to_buy)\r\n        \r\n        if aapl_quantity == 0:\r\n            if self.aapl_red_days >= 3:\r\n                available_cash = self.Portfolio.Cash\r\n                if available_cash >= 20000:\r\n                    shares_to_buy = int(20000 / aapl_close)\r\n                    if shares_to_buy > 0:\r\n                        self.MarketOrder(self.symbols[\"AAPL\"], shares_to_buy)\r\n        \r\n        self.prev_spy_close = spy_close\r\n        self.prev_aapl_close = aapl_close\r\n        self.prev_spy_sma = spy_sma_value\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw07/3-EXTRACTED-PROGRAM.py",
      "sha256": "7f43056d48353c1914daf6b91e6667c89502bb5a4de16febb453cb24ebfa8782",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 7,
        "arm": "arm",
        "lane": "claude-haiku-4-5_medium",
        "promptId": "BL-01c",
        "i": 1,
        "claimedStatus": "non-runnable",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-01c"
      }
    },
    {
      "id": "lb-draw08-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 8 extracted program — T1v0 on gpt-5.6-sol_max",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ExactStrategySystemAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.symbols = [\r\n            self.spy,\r\n            self.aapl,\r\n            self.ibm,\r\n            self.bac,\r\n            self.aig\r\n        ]\r\n\r\n        self.spy_sma = SimpleMovingAverage(100)\r\n        self.aapl_rsi = RelativeStrengthIndex(\r\n            14,\r\n            MovingAverageType.Wilders\r\n        )\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n        self.aapl_observation_count = 0\r\n\r\n        self.spy_lot_shares = 0\r\n        self.aapl_lot_shares = 0\r\n\r\n        # One prior fully formed SMA value is also required for crossing logic.\r\n        self.SetWarmUp(101, Resolution.Daily)\r\n\r\n    def OnData(self, data):\r\n        previous_spy_close = self.previous_spy_close\r\n        previous_spy_sma = self.previous_spy_sma\r\n\r\n        spy_bar = None\r\n        current_spy_sma = None\r\n\r\n        if data.Bars.ContainsKey(self.spy):\r\n            spy_bar = data.Bars[self.spy]\r\n            self.spy_sma.Update(spy_bar.EndTime, spy_bar.Close)\r\n\r\n            if self.spy_sma.IsReady:\r\n                current_spy_sma = self.spy_sma.Current.Value\r\n                self.previous_spy_close = spy_bar.Close\r\n                self.previous_spy_sma = current_spy_sma\r\n\r\n        aapl_bar = None\r\n\r\n        if data.Bars.ContainsKey(self.aapl):\r\n            aapl_bar = data.Bars[self.aapl]\r\n            self.aapl_rsi.Update(aapl_bar.EndTime, aapl_bar.Close)\r\n\r\n            if self.previous_aapl_close is not None:\r\n                if aapl_bar.Close < self.previous_aapl_close:\r\n                    self.aapl_red_streak += 1\r\n                else:\r\n                    self.aapl_red_streak = 0\r\n\r\n            self.previous_aapl_close = aapl_bar.Close\r\n            self.aapl_observation_count += 1\r\n\r\n        if self.IsWarmingUp:\r\n            return\r\n\r\n        if any(not data.Bars.ContainsKey(symbol) for symbol in self.symbols):\r\n            return\r\n\r\n        if (\r\n            previous_spy_close is None\r\n            or previous_spy_sma is None\r\n            or current_spy_sma is None\r\n            or not self.aapl_rsi.IsReady\r\n            or self.aapl_observation_count < 4\r\n        ):\r\n            return\r\n\r\n        spy_crossed_below = (\r\n            previous_spy_close >= previous_spy_sma\r\n            and spy_bar.Close < current_spy_sma\r\n        )\r\n        spy_crossed_above = (\r\n            previous_spy_close <= previous_spy_sma\r\n            and spy_bar.Close > current_spy_sma\r\n        )\r\n\r\n        # Evaluate all sells before any buys.\r\n        if self.spy_lot_shares > 0 and spy_crossed_below:\r\n            self.MarketOrder(\r\n                self.spy,\r\n                -self.spy_lot_shares,\r\n                False,\r\n                \"Strategy A: close crossed below 100-day SMA\"\r\n            )\r\n            self.spy_lot_shares = 0\r\n\r\n        if (\r\n            self.aapl_lot_shares > 0\r\n            and self.aapl_rsi.Current.Value > 60\r\n        ):\r\n            self.MarketOrder(\r\n                self.aapl,\r\n                -self.aapl_lot_shares,\r\n                False,\r\n                \"Strategy B: 14-day RSI above 60\"\r\n            )\r\n            self.aapl_lot_shares = 0\r\n\r\n        if self.spy_lot_shares == 0 and spy_crossed_above:\r\n            quantity = int(self.CalculateOrderQuantity(self.spy, 0.40))\r\n            if quantity > 0:\r\n                self.MarketOrder(\r\n                    self.spy,\r\n                    quantity,\r\n                    False,\r\n                    \"Strategy A: close crossed above 100-day SMA\"\r\n                )\r\n                self.spy_lot_shares = quantity\r\n\r\n        if self.aapl_lot_shares == 0 and self.aapl_red_streak >= 3:\r\n            if self.Portfolio.Cash >= 20_000:\r\n                quantity = int(20_000 // aapl_bar.Close)\r\n                if quantity > 0:\r\n                    self.MarketOrder(\r\n                        self.aapl,\r\n                        quantity,\r\n                        False,\r\n                        \"Strategy B: red for at least 3 consecutive days\"\r\n                    )\r\n                    self.aapl_lot_shares = quantity\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw08/3-EXTRACTED-PROGRAM.py",
      "sha256": "097dd7c29304fa31d59663ba07d392f76ec49ac94a6f371e7756cc8caa59a251",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 8,
        "arm": "arm",
        "lane": "gpt-5.6-sol_max",
        "promptId": "T1v0",
        "i": 0,
        "claimedStatus": "coded",
        "claimedCode": "SMA100"
      }
    },
    {
      "id": "lb-draw09-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 9 extracted program — BL-07 on codex_gpt-5.6-luna_xhigh_BL-07",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\nimport math\r\n\r\n\r\nclass DailyCrossAndRSIStrategy(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.symbols = [self.spy, self.aapl, self.ibm, self.bac, self.aig]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl,\r\n            14,\r\n            MovingAverageType.Wilders,\r\n            Resolution.Daily\r\n        )\r\n\r\n        self.spy_lot_shares = 0\r\n        self.aapl_lot_shares = 0\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n    def OnData(self, data):\r\n        for symbol in self.symbols:\r\n            if not data.Bars.ContainsKey(symbol):\r\n                return\r\n\r\n        spy_close = data.Bars[self.spy].Close\r\n        aapl_close = data.Bars[self.aapl].Close\r\n\r\n        spy_cross_above = False\r\n        spy_cross_below = False\r\n\r\n        if (\r\n            self.spy_sma.IsReady\r\n            and self.previous_spy_close is not None\r\n            and self.previous_spy_sma is not None\r\n        ):\r\n            current_spy_sma = self.spy_sma.Current.Value\r\n\r\n            spy_cross_above = (\r\n                self.previous_spy_close <= self.previous_spy_sma\r\n                and spy_close > current_spy_sma\r\n            )\r\n\r\n            spy_cross_below = (\r\n                self.previous_spy_close >= self.previous_spy_sma\r\n                and spy_close < current_spy_sma\r\n            )\r\n\r\n        if self.previous_aapl_close is not None:\r\n            if aapl_close < self.previous_aapl_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n        aapl_rsi_above_60 = (\r\n            self.aapl_rsi.IsReady\r\n            and self.aapl_rsi.Current.Value > 60\r\n        )\r\n\r\n        if self.spy_lot_shares > 0 and spy_cross_below:\r\n            self.MarketOrder(\r\n                self.spy,\r\n                -self.spy_lot_shares,\r\n                tag=\"Strategy A sell\"\r\n            )\r\n            self.spy_lot_shares = 0\r\n\r\n        if self.aapl_lot_shares > 0 and aapl_rsi_above_60:\r\n            self.MarketOrder(\r\n                self.aapl,\r\n                -self.aapl_lot_shares,\r\n                tag=\"Strategy B sell\"\r\n            )\r\n            self.aapl_lot_shares = 0\r\n\r\n        if self.spy_lot_shares == 0 and spy_cross_above:\r\n            target_value = 0.40 * float(self.Portfolio.TotalPortfolioValue)\r\n            shares = math.floor(target_value / float(spy_close))\r\n\r\n            if shares > 0:\r\n                self.MarketOrder(\r\n                    self.spy,\r\n                    shares,\r\n                    tag=\"Strategy A buy\"\r\n                )\r\n                self.spy_lot_shares = shares\r\n\r\n        if self.aapl_lot_shares == 0 and self.aapl_red_streak >= 3:\r\n            if float(self.Portfolio.Cash) >= 20000:\r\n                shares = math.floor(20000 / float(aapl_close))\r\n\r\n                if shares > 0:\r\n                    self.MarketOrder(\r\n                        self.aapl,\r\n                        shares,\r\n                        tag=\"Strategy B buy\"\r\n                    )\r\n                    self.aapl_lot_shares = shares\r\n\r\n        if self.spy_sma.IsReady:\r\n            self.previous_spy_sma = self.spy_sma.Current.Value\r\n\r\n        self.previous_spy_close = spy_close\r\n        self.previous_aapl_close = aapl_close\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw09/3-EXTRACTED-PROGRAM.py",
      "sha256": "282948b9264dff3877a8d9d60465089c54a241ef438f729718ccedd277aefa2d",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 9,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-luna_xhigh_BL-07",
        "promptId": "BL-07",
        "i": 3,
        "claimedStatus": "coded",
        "claimedCode": "p14",
        "promptBundleId": "lb-t1-variant-bl-07"
      }
    },
    {
      "id": "lb-draw10-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 10 extracted program — OM-B on codex_gpt-5.6-terra_medium_OM-B_noask",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass SpecifiedStrategySystem(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.symbols = {}\r\n        for ticker in [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]:\r\n            self.symbols[ticker] = self.AddEquity(ticker, Resolution.Daily).Symbol\r\n\r\n        self.spy = self.symbols[\"SPY\"]\r\n        self.aapl = self.symbols[\"AAPL\"]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(self.aapl, 14, MovingAverageType.Wilders, Resolution.Daily)\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n        self.strategy_a_shares = 0\r\n        self.strategy_b_shares = 0\r\n\r\n    def OnData(self, slice):\r\n        spy_bar = slice.Bars.get(self.spy)\r\n        aapl_bar = slice.Bars.get(self.aapl)\r\n\r\n        # Market-state quantities continue updating whenever their own data exists.\r\n        if aapl_bar is not None:\r\n            if self.previous_aapl_close is not None and aapl_bar.Close < self.previous_aapl_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n            self.previous_aapl_close = aapl_bar.Close\r\n\r\n        current_spy_sma = self.spy_sma.Current.Value if self.spy_sma.IsReady else None\r\n\r\n        # All subscribed tickers must have a bar before any rule evaluation.\r\n        if not all(symbol in slice.Bars for symbol in self.symbols.values()):\r\n            if spy_bar is not None and current_spy_sma is not None:\r\n                self.previous_spy_close = spy_bar.Close\r\n                self.previous_spy_sma = current_spy_sma\r\n            return\r\n\r\n        # No trading until every indicator or rolling window used by a rule is formed.\r\n        if not self.spy_sma.IsReady or not self.aapl_rsi.IsReady:\r\n            if current_spy_sma is not None:\r\n                self.previous_spy_close = spy_bar.Close\r\n                self.previous_spy_sma = current_spy_sma\r\n            return\r\n\r\n        spy_crosses_above = (\r\n            self.previous_spy_close is not None\r\n            and self.previous_spy_sma is not None\r\n            and self.previous_spy_close <= self.previous_spy_sma\r\n            and spy_bar.Close > current_spy_sma\r\n        )\r\n\r\n        spy_crosses_below = (\r\n            self.previous_spy_close is not None\r\n            and self.previous_spy_sma is not None\r\n            and self.previous_spy_close >= self.previous_spy_sma\r\n            and spy_bar.Close < current_spy_sma\r\n        )\r\n\r\n        # Slot 1: Strategy A\r\n        if self.strategy_a_shares > 0 and spy_crosses_below:\r\n            self.Liquidate(self.spy)\r\n            self.strategy_a_shares = 0\r\n        elif self.strategy_a_shares == 0 and spy_crosses_above:\r\n            self.SetHoldings(self.spy, 0.40)\r\n            self.strategy_a_shares = self.Portfolio[self.spy].Quantity\r\n\r\n        # Slot 2: Strategy B\r\n        if self.strategy_b_shares > 0 and self.aapl_rsi.Current.Value > 60:\r\n            self.Liquidate(self.aapl)\r\n            self.strategy_b_shares = 0\r\n        elif self.strategy_b_shares == 0 and self.aapl_red_streak >= 3:\r\n            if self.Portfolio.Cash >= 20_000:\r\n                quantity = int(20_000 // aapl_bar.Close)\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.aapl, quantity)\r\n                    self.strategy_b_shares = quantity\r\n\r\n        self.previous_spy_close = spy_bar.Close\r\n        self.previous_spy_sma = current_spy_sma\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw10/3-EXTRACTED-PROGRAM.py",
      "sha256": "07d82f7229907453811c1597270013885f0e0a068625e054e66314078ed78eb1",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 10,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_medium_OM-B_noask",
        "promptId": "OM-B",
        "i": 0,
        "claimedStatus": "coded",
        "claimedCode": "DRIFT",
        "promptBundleId": "lb-t1-variant-om-b"
      }
    },
    {
      "id": "lb-draw11-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 11 extracted program — BL-04 on codex_gpt-5.6-luna_high_BL-04",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\nfrom collections import deque\r\nimport math\r\n\r\n\r\nclass ExactStrategyAlgorithm(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.symbols = [self.spy, self.aapl, self.ibm, self.bac, self.aig]\r\n\r\n        self.spy_closes = deque(maxlen=101)\r\n        self.spy_last_close = None\r\n        self.spy_previous_close = None\r\n        self.spy_current_sma = None\r\n        self.spy_previous_sma = None\r\n\r\n        self.aapl_last_close = None\r\n        self.aapl_red_streak = 0\r\n        self.aapl_change_count = 0\r\n        self.aapl_gain_sum = 0.0\r\n        self.aapl_loss_sum = 0.0\r\n        self.aapl_average_gain = None\r\n        self.aapl_average_loss = None\r\n        self.aapl_rsi = None\r\n        self.aapl_rsi_ready = False\r\n\r\n        self.spy_lot_shares = 0\r\n        self.aapl_lot_shares = 0\r\n\r\n        self.pending_a = False\r\n        self.pending_b = False\r\n\r\n    def OnData(self, data):\r\n        self._update_spy_state(data)\r\n        self._update_aapl_state(data)\r\n\r\n        if not all(symbol in data.Bars for symbol in self.symbols):\r\n            return\r\n\r\n        if not self._history_ready():\r\n            return\r\n\r\n        spy_cross_above = (\r\n            self.spy_previous_close is not None\r\n            and self.spy_previous_sma is not None\r\n            and self.spy_current_sma is not None\r\n            and self.spy_previous_close <= self.spy_previous_sma\r\n            and self.spy_last_close > self.spy_current_sma\r\n        )\r\n\r\n        spy_cross_below = (\r\n            self.spy_previous_close is not None\r\n            and self.spy_previous_sma is not None\r\n            and self.spy_current_sma is not None\r\n            and self.spy_previous_close >= self.spy_previous_sma\r\n            and self.spy_last_close < self.spy_current_sma\r\n        )\r\n\r\n        aapl_sell_reason = (\r\n            self.aapl_rsi_ready\r\n            and self.aapl_rsi is not None\r\n            and self.aapl_rsi > 60\r\n        )\r\n\r\n        # Evaluate all sells before any buys.\r\n        if (\r\n            self.spy_lot_shares > 0\r\n            and not self.pending_a\r\n            and spy_cross_below\r\n        ):\r\n            self._submit_order(\r\n                self.spy,\r\n                -self.spy_lot_shares,\r\n                \"StrategyA|Sell\"\r\n            )\r\n\r\n        if (\r\n            self.aapl_lot_shares > 0\r\n            and not self.pending_b\r\n            and aapl_sell_reason\r\n        ):\r\n            self._submit_order(\r\n                self.aapl,\r\n                -self.aapl_lot_shares,\r\n                \"StrategyB|Sell\"\r\n            )\r\n\r\n        # Strategy A buy.\r\n        if (\r\n            self.spy_lot_shares == 0\r\n            and not self.pending_a\r\n            and spy_cross_above\r\n        ):\r\n            target_value = 0.40 * float(self.Portfolio.TotalPortfolioValue)\r\n            quantity = int(math.floor(target_value / self.spy_last_close))\r\n\r\n            if quantity > 0:\r\n                self._submit_order(\r\n                    self.spy,\r\n                    quantity,\r\n                    \"StrategyA|Buy\"\r\n                )\r\n\r\n        # Strategy B buy.\r\n        if (\r\n            self.aapl_lot_shares == 0\r\n            and not self.pending_b\r\n            and self.aapl_red_streak >= 3\r\n            and float(self.Portfolio.Cash) >= 20000\r\n        ):\r\n            quantity = int(math.floor(20000 / self.aapl_last_close))\r\n\r\n            if quantity > 0:\r\n                self._submit_order(\r\n                    self.aapl,\r\n                    quantity,\r\n                    \"StrategyB|Buy\"\r\n                )\r\n\r\n    def _update_spy_state(self, data):\r\n        if self.spy not in data.Bars:\r\n            return\r\n\r\n        close = float(data.Bars[self.spy].Close)\r\n\r\n        self.spy_previous_close = self.spy_last_close\r\n        self.spy_previous_sma = self.spy_current_sma\r\n\r\n        previous_closes = list(self.spy_closes)\r\n        if len(previous_closes) >= 100:\r\n            self.spy_current_sma = sum(previous_closes[-100:]) / 100.0\r\n        else:\r\n            self.spy_current_sma = None\r\n\r\n        self.spy_closes.append(close)\r\n\r\n        if len(self.spy_closes) >= 100:\r\n            self.spy_current_sma = sum(list(self.spy_closes)[-100:]) / 100.0\r\n        else:\r\n            self.spy_current_sma = None\r\n\r\n        self.spy_last_close = close\r\n\r\n    def _update_aapl_state(self, data):\r\n        if self.aapl not in data.Bars:\r\n            return\r\n\r\n        close = float(data.Bars[self.aapl].Close)\r\n\r\n        if self.aapl_last_close is not None:\r\n            change = close - self.aapl_last_close\r\n            gain = max(change, 0.0)\r\n            loss = max(-change, 0.0)\r\n\r\n            if change < 0:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.aapl_change_count += 1\r\n\r\n            if self.aapl_change_count <= 14:\r\n                self.aapl_gain_sum += gain\r\n                self.aapl_loss_sum += loss\r\n\r\n                if self.aapl_change_count == 14:\r\n                    self.aapl_average_gain = self.aapl_gain_sum / 14.0\r\n                    self.aapl_average_loss = self.aapl_loss_sum / 14.0\r\n                    self.aapl_rsi = self._calculate_rsi()\r\n                    self.aapl_rsi_ready = True\r\n            else:\r\n                self.aapl_average_gain = (\r\n                    (self.aapl_average_gain * 13.0) + gain\r\n                ) / 14.0\r\n\r\n                self.aapl_average_loss = (\r\n                    (self.aapl_average_loss * 13.0) + loss\r\n                ) / 14.0\r\n\r\n                self.aapl_rsi = self._calculate_rsi()\r\n\r\n        self.aapl_last_close = close\r\n\r\n    def _calculate_rsi(self):\r\n        if self.aapl_average_loss == 0:\r\n            if self.aapl_average_gain == 0:\r\n                return 50.0\r\n            return 100.0\r\n\r\n        relative_strength = (\r\n            self.aapl_average_gain / self.aapl_average_loss\r\n        )\r\n        return 100.0 - (100.0 / (1.0 + relative_strength))\r\n\r\n    def _history_ready(self):\r\n        return (\r\n            self.spy_previous_sma is not None\r\n            and self.spy_current_sma is not None\r\n            and self.aapl_change_count >= 14\r\n            and self.aapl_rsi_ready\r\n            and self.aapl_red_streak >= 3\r\n        )\r\n\r\n    def _submit_order(self, symbol, quantity, tag):\r\n        strategy = tag.split(\"|\")[0]\r\n\r\n        if strategy == \"StrategyA\":\r\n            self.pending_a = True\r\n        else:\r\n            self.pending_b = True\r\n\r\n        ticket = self.MarketOrder(symbol, quantity, tag=tag)\r\n\r\n        if ticket is None:\r\n            if strategy == \"StrategyA\":\r\n                self.pending_a = False\r\n            else:\r\n                self.pending_b = False\r\n        elif ticket.Status in [\r\n            OrderStatus.Filled,\r\n            OrderStatus.Canceled,\r\n            OrderStatus.Invalid\r\n        ]:\r\n            if strategy == \"StrategyA\":\r\n                self.pending_a = False\r\n            else:\r\n                self.pending_b = False\r\n\r\n    def OnOrderEvent(self, order_event):\r\n        order = self.Transactions.GetOrderById(order_event.OrderId)\r\n        if order is None:\r\n            return\r\n\r\n        tag = order.Tag\r\n        if \"|\" not in tag:\r\n            return\r\n\r\n        strategy, action = tag.split(\"|\", 1)\r\n        fill_quantity = int(order_event.FillQuantity)\r\n\r\n        if order_event.Status in [\r\n            OrderStatus.Filled,\r\n            OrderStatus.PartiallyFilled\r\n        ]:\r\n            if strategy == \"StrategyA\":\r\n                self.spy_lot_shares += fill_quantity\r\n            elif strategy == \"StrategyB\":\r\n                self.aapl_lot_shares += fill_quantity\r\n\r\n        if order_event.Status in [\r\n            OrderStatus.Filled,\r\n            OrderStatus.Canceled,\r\n            OrderStatus.Invalid\r\n        ]:\r\n            if strategy == \"StrategyA\":\r\n                self.pending_a = False\r\n            elif strategy == \"StrategyB\":\r\n                self.pending_b = False\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw11/3-EXTRACTED-PROGRAM.py",
      "sha256": "e23c1cf28efb553f1861c750480793730df413a96f16aee60954bf1245f4faa7",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 11,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-luna_high_BL-04",
        "promptId": "BL-04",
        "i": 3,
        "claimedStatus": "coded",
        "claimedCode": "DRIFT",
        "promptBundleId": "lb-t1-variant-bl-04"
      }
    },
    {
      "id": "lb-draw12-program",
      "version": "1",
      "kind": "atom",
      "role": "no_program_extracted",
      "title": "Draw 12 extracted program — BL-05 on codex_gpt-5.6-terra_high_BL-05",
      "labels": [
        "No program extracted",
        "Python",
        "Matching code",
        "Verification packet",
        "asks-clarifying"
      ],
      "text": "# (no program extracted)",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw12/3-EXTRACTED-PROGRAM.py",
      "sha256": "2989ca72b02fa12c1e3a4050cbef07de32aa1010cd86ac575acb29e4811cc472",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 12,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_high_BL-05",
        "promptId": "BL-05",
        "i": 7,
        "claimedStatus": "asks-clarifying",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-05"
      }
    },
    {
      "id": "lb-draw13-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 13 extracted program — T1v0 on claude-opus-5_xhigh",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "# region imports\r\nfrom AlgorithmImports import *\r\nimport math\r\n# endregion\r\n\r\n\r\nclass TwoSlotParallelTemplateAlgorithm(QCAlgorithm):\r\n    \"\"\"\r\n    One template, two slots, no gate. Both slots run independently in parallel.\r\n\r\n      Slot 1 - Strategy A (SPY):\r\n        BUY  : SPY close crosses above its 100-day SMA  -> invest 40% of total portfolio value\r\n        SELL : SPY close crosses below its 100-day SMA  -> liquidate Strategy A's lot\r\n\r\n      Slot 2 - Strategy B (AAPL):\r\n        BUY  : AAPL red 3 consecutive days -> buy $20,000 if >= $20,000 cash available, else do nothing\r\n        SELL : AAPL 14-day RSI above 60    -> liquidate Strategy B's lot\r\n\r\n    Each strategy owns a private lot: it only ever sells shares it bought, its buy reason is\r\n    evaluated only while its lot is empty, its sell reason only while its lot is non-empty,\r\n    and sells are evaluated before buys on every bar.\r\n    \"\"\"\r\n\r\n    TICKERS = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n\r\n    # ------------------------------------------------------------------ setup\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.symbols = {}\r\n        for ticker in self.TICKERS:\r\n            equity = self.AddEquity(ticker, Resolution.Daily)\r\n            equity.SetDataNormalizationMode(DataNormalizationMode.Adjusted)\r\n            self.symbols[ticker] = equity.Symbol\r\n\r\n        self.spy = self.symbols[\"SPY\"]\r\n        self.aapl = self.symbols[\"AAPL\"]\r\n\r\n        # Manually-updated indicators so that \"yesterday's value\" is unambiguous.\r\n        self.spy_sma = SimpleMovingAverage(100)\r\n        self.aapl_rsi = RelativeStrengthIndex(14, MovingAverageType.Wilders)\r\n\r\n        # Continuously-maintained market state (never paused).\r\n        self.prev_close = {}          # Symbol -> previous bar's close\r\n        self.aapl_red_streak = 0      # consecutive red days for AAPL\r\n\r\n        # Private lots (share counts), tracked at order-submission time.\r\n        self.lot_a = 0                # Strategy A lot in SPY\r\n        self.lot_b = 0                # Strategy B lot in AAPL\r\n\r\n    # ------------------------------------------------------------------- data\r\n    def OnData(self, data):\r\n        # ---- 1) snapshot yesterday's values BEFORE anything is updated today\r\n        prev_spy_close = self.prev_close.get(self.spy)\r\n        prev_spy_sma_ready = self.spy_sma.IsReady\r\n        prev_spy_sma = self.spy_sma.Current.Value if prev_spy_sma_ready else None\r\n        prev_aapl_close = self.prev_close.get(self.aapl)\r\n\r\n        # ---- 2) collect today's bars\r\n        present = {}\r\n        for ticker, symbol in self.symbols.items():\r\n            bar = None\r\n            if data.Bars.ContainsKey(symbol):\r\n                bar = data.Bars[symbol]\r\n            if bar is not None and bar.Close > 0:\r\n                present[ticker] = bar\r\n\r\n        # ---- 3) update market-state quantities from whatever data arrived\r\n        spy_bar = present.get(\"SPY\")\r\n        if spy_bar is not None:\r\n            self.spy_sma.Update(spy_bar.EndTime, spy_bar.Close)\r\n\r\n        aapl_bar = present.get(\"AAPL\")\r\n        if aapl_bar is not None:\r\n            self.aapl_rsi.Update(aapl_bar.EndTime, aapl_bar.Close)\r\n            if prev_aapl_close is not None:\r\n                if aapl_bar.Close < prev_aapl_close:\r\n                    self.aapl_red_streak += 1\r\n                else:\r\n                    self.aapl_red_streak = 0\r\n\r\n        for ticker, bar in present.items():\r\n            self.prev_close[self.symbols[ticker]] = bar.Close\r\n\r\n        # ---- 4) if today's bar is missing for ANY subscribed ticker, skip all rules\r\n        if len(present) != len(self.symbols):\r\n            return\r\n\r\n        if self.IsWarmingUp:\r\n            return\r\n\r\n        # ================================================================\r\n        # Slot 1 - Strategy A (SPY)\r\n        # ================================================================\r\n        spy_close = spy_bar.Close\r\n        spy_sma = self.spy_sma.Current.Value\r\n\r\n        strategy_a_ready = (\r\n            self.spy_sma.IsReady\r\n            and prev_spy_sma_ready\r\n            and prev_spy_close is not None\r\n        )\r\n\r\n        if strategy_a_ready:\r\n            crossed_above = (prev_spy_close <= prev_spy_sma) and (spy_close > spy_sma)\r\n            crossed_below = (prev_spy_close >= prev_spy_sma) and (spy_close < spy_sma)\r\n\r\n            # SELL first\r\n            if self.lot_a > 0 and crossed_below:\r\n                self.MarketOrder(self.spy, -self.lot_a)\r\n                self.Debug(f\"{self.Time.date()} A SELL SPY {self.lot_a} (cross below SMA100)\")\r\n                self.lot_a = 0\r\n\r\n            # THEN BUY (only while the lot is empty)\r\n            if self.lot_a == 0 and crossed_above:\r\n                target_value = 0.40 * self.Portfolio.TotalPortfolioValue\r\n                quantity = int(math.floor(target_value / spy_close))\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.spy, quantity)\r\n                    self.lot_a = quantity\r\n                    self.Debug(f\"{self.Time.date()} A BUY SPY {quantity} (cross above SMA100)\")\r\n\r\n        # ================================================================\r\n        # Slot 2 - Strategy B (AAPL)\r\n        # ================================================================\r\n        aapl_close = aapl_bar.Close\r\n        strategy_b_ready = self.aapl_rsi.IsReady\r\n\r\n        if strategy_b_ready:\r\n            rsi_value = self.aapl_rsi.Current.Value\r\n\r\n            # SELL first\r\n            if self.lot_b > 0 and rsi_value > 60:\r\n                self.MarketOrder(self.aapl, -self.lot_b)\r\n                self.Debug(f\"{self.Time.date()} B SELL AAPL {self.lot_b} (RSI {rsi_value:.2f} > 60)\")\r\n                self.lot_b = 0\r\n\r\n            # THEN BUY (only while the lot is empty)\r\n            if self.lot_b == 0 and self.aapl_red_streak >= 3:\r\n                budget = 20000.0\r\n                if self.Portfolio.Cash >= budget:\r\n                    quantity = int(math.floor(budget / aapl_close))\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.aapl, quantity)\r\n                        self.lot_b = quantity\r\n                        self.Debug(\r\n                            f\"{self.Time.date()} B BUY AAPL {quantity} \"\r\n                            f\"({self.aapl_red_streak} red days)\"\r\n                        )\r\n                # else: not enough cash -> do nothing this bar, stay flat\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw13/3-EXTRACTED-PROGRAM.py",
      "sha256": "c0230ac4b9790ed4a04f516e9cbedbf6c5223438b6aeb843e9867924cff472aa",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 13,
        "arm": "arm",
        "lane": "claude-opus-5_xhigh",
        "promptId": "T1v0",
        "i": 5,
        "claimedStatus": "coded",
        "claimedCode": "SMA100"
      }
    },
    {
      "id": "lb-draw14-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 14 extracted program — BL-01a on gemini-cli_default",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\nimport math\r\n\r\nclass DetailedStrategyAlgorithm(QCAlgorithm):\r\n    \"\"\"\r\n    QuantConnect LEAN algorithm implementing a specific system of two strategies.\r\n    - Strategy A: SPY momentum cross.\r\n    - Strategy B: AAPL dip buying.\r\n    \"\"\"\r\n\r\n    def Initialize(self):\r\n        \"\"\"Initial algorithm setup. Sets dates, cash, and prepares data and indicators.\"\"\"\r\n        # 1. Fixed setup requirements\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        # Subscribe to US equities at DAILY resolution\r\n        self.subscribed_symbols = [\"SPY\", \"AAPL\", \"IBM\", \"BAC\", \"AIG\"]\r\n        for ticker in self.subscribed_symbols:\r\n            self.AddEquity(ticker, Resolution.Daily)\r\n\r\n        # Store Symbol objects for easy access\r\n        self.spy = self.Symbol(\"SPY\")\r\n        self.aapl = self.Symbol(\"AAPL\")\r\n\r\n        # 2. Strategy A (SPY) state and indicators\r\n        self.spy_sma100 = self.SMA(self.spy, 100, Resolution.Daily)\r\n        # We need to store previous values to detect a cross\r\n        self.spy_close_history = RollingWindow[float](2)\r\n        self.spy_sma_history = RollingWindow[float](2)\r\n\r\n        # 3. Strategy B (AAPL) state and indicators\r\n        self.aapl_rsi14 = self.RSI(self.aapl, 14, MovingAverageType.Simple, Resolution.Daily)\r\n        self.aapl_red_day_counter = 0\r\n        self.aapl_prev_close = None\r\n\r\n        # 4. Set warm-up period for indicators\r\n        # Longest lookback is SMA(100), so 100 days should be sufficient.\r\n        self.SetWarmUp(100)\r\n\r\n    def OnData(self, data: Slice):\r\n        \"\"\"\r\n        Main event handler, called once per daily bar.\r\n        \"\"\"\r\n        # Do not trade until all indicators have enough data\r\n        if self.IsWarmingUp:\r\n            return\r\n\r\n        # SEMANTICS CONTRACT: If today's bar is missing for ANY subscribed ticker, skip ALL rules.\r\n        for ticker in self.subscribed_symbols:\r\n            symbol_obj = self.Symbol(ticker)\r\n            if not data.Bars.ContainsKey(symbol_obj) or data[symbol_obj] is None:\r\n                return\r\n\r\n        # --- Update State and History ---\r\n\r\n        # Strategy A (SPY): Update rolling windows for cross detection.\r\n        if self.spy_sma100.IsReady and data.Bars.ContainsKey(self.spy):\r\n            self.spy_close_history.Add(data[self.spy].Close)\r\n            self.spy_sma_history.Add(self.spy_sma100.Current.Value)\r\n\r\n        # Strategy B (AAPL): Update consecutive red day counter.\r\n        if data.Bars.ContainsKey(self.aapl):\r\n            aapl_bar = data[self.aapl]\r\n            if self.aapl_prev_close is not None:\r\n                # \"red day\" means close is strictly below the PREVIOUS day's close\r\n                if aapl_bar.Close < self.aapl_prev_close:\r\n                    self.aapl_red_day_counter += 1\r\n                else:\r\n                    self.aapl_red_day_counter = 0 # Reset on green or flat day\r\n            self.aapl_prev_close = aapl_bar.Close\r\n\r\n        # Wait for all history/indicators to be fully formed before trading\r\n        if not all([self.spy_sma100.IsReady, self.aapl_rsi14.IsReady,\r\n                    self.spy_close_history.IsReady, self.spy_sma_history.IsReady]):\r\n            return\r\n\r\n        # --- Execute Strategies (Sells are evaluated before Buys) ---\r\n\r\n        # Slot 1 - Strategy A (trades SPY)\r\n        self.ExecuteStrategyA(data)\r\n\r\n        # Slot 2 - Strategy B (trades AAPL)\r\n        self.ExecuteStrategyB(data)\r\n\r\n\r\n    def ExecuteStrategyA(self, data: Slice):\r\n        \"\"\"\r\n        Momentum strategy on SPY using a 100-day SMA cross.\r\n        - Buy on bullish cross (close > SMA).\r\n        - Sell on bearish cross (close < SMA).\r\n        \"\"\"\r\n        spy_holding = self.Portfolio[self.spy]\r\n        \r\n        # Access historical values: [0] is today, [1] is yesterday\r\n        today_close = self.spy_close_history[0]\r\n        yesterday_close = self.spy_close_history[1]\r\n        today_sma = self.spy_sma_history[0]\r\n        yesterday_sma = self.spy_sma_history[1]\r\n\r\n        # Evaluate sell reason only while lot is non-empty\r\n        if spy_holding.Invested:\r\n            # Reason to sell: SPY's close crosses below its 100-day moving average.\r\n            # \"crosses below\" means yesterday it was >=, today it is <.\r\n            if yesterday_close >= yesterday_sma and today_close < today_sma:\r\n                # Sell details: liquidate entire lot.\r\n                self.Liquidate(self.spy)\r\n        \r\n        # Evaluate buy reason only while lot is empty\r\n        else:\r\n            # Reason to buy: SPY's close crosses above its 100-day moving average.\r\n            # \"crosses above\" means yesterday it was <=, today it is >.\r\n            if yesterday_close <= yesterday_sma and today_close > today_sma:\r\n                # Buy details: invest 40% of total portfolio value in SPY.\r\n                self.SetHoldings(self.spy, 0.40)\r\n\r\n\r\n    def ExecuteStrategyB(self, data: Slice):\r\n        \"\"\"\r\n        Dip-buying strategy on AAPL.\r\n        - Buy after 3 consecutive red days.\r\n        - Sell when RSI is over 60.\r\n        \"\"\"\r\n        aapl_holding = self.Portfolio[self.aapl]\r\n\r\n        # Evaluate sell reason only while lot is non-empty\r\n        if aapl_holding.Invested:\r\n            # Reason to sell: AAPL's 14-day RSI closes above 60.\r\n            if self.aapl_rsi14.Current.Value > 60:\r\n                # Sell details: liquidate entire lot.\r\n                self.Liquidate(self.aapl)\r\n\r\n        # Evaluate buy reason only while lot is empty\r\n        else:\r\n            # Reason to buy: AAPL has been red for 3 consecutive days.\r\n            # (Satisfied on any day that completes 3 or MORE consecutive red days)\r\n            if self.aapl_red_day_counter >= 3:\r\n                # Buy details: buy $20,000 of AAPL if cash available.\r\n                if self.Portfolio.Cash >= 20000:\r\n                    # Use MarketOrder to execute the buy.\r\n                    aapl_price = data[self.aapl].Close\r\n                    # Ensure price is not zero to avoid division errors\r\n                    if aapl_price > 0:\r\n                        shares_to_buy = math.floor(20000 / aapl_price)\r\n                        self.MarketOrder(self.aapl, shares_to_buy)\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw14/3-EXTRACTED-PROGRAM.py",
      "sha256": "7c9eb47f5ca671010ca3d1274c84ec44e7d53d3469fe69bcd1519086846641e1",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 14,
        "arm": "arm",
        "lane": "gemini-cli_default",
        "promptId": "BL-01a",
        "i": 0,
        "claimedStatus": "coded",
        "claimedCode": "SMA",
        "promptBundleId": "lb-t1-variant-bl-01a"
      }
    },
    {
      "id": "lb-draw15-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 15 extracted program — OM-B on codex_gpt-5.6-terra_high_OM-B",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass IndependentDailyStrategies(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.symbols = [self.spy, self.aapl, self.ibm, self.bac, self.aig]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl, 14, MovingAverageType.Wilders, Resolution.Daily\r\n        )\r\n\r\n        self.SetWarmUp(101, Resolution.Daily)\r\n\r\n        self.previous_spy_close = None\r\n        self.previous_spy_sma = None\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n    def OnData(self, data: Slice):\r\n        has_spy_bar = data.Bars.ContainsKey(self.spy)\r\n        has_aapl_bar = data.Bars.ContainsKey(self.aapl)\r\n        has_all_bars = all(data.Bars.ContainsKey(symbol) for symbol in self.symbols)\r\n\r\n        current_spy_close = data.Bars[self.spy].Close if has_spy_bar else None\r\n        current_aapl_close = data.Bars[self.aapl].Close if has_aapl_bar else None\r\n\r\n        if (\r\n            has_all_bars\r\n            and not self.IsWarmingUp\r\n            and self.spy_sma.IsReady\r\n            and self.aapl_rsi.IsReady\r\n            and self.previous_spy_close is not None\r\n            and self.previous_spy_sma is not None\r\n        ):\r\n            spy_crosses_above = (\r\n                self.previous_spy_close <= self.previous_spy_sma\r\n                and current_spy_close > self.spy_sma.Current.Value\r\n            )\r\n            spy_crosses_below = (\r\n                self.previous_spy_close >= self.previous_spy_sma\r\n                and current_spy_close < self.spy_sma.Current.Value\r\n            )\r\n\r\n            if self.Portfolio[self.spy].Quantity != 0:\r\n                if spy_crosses_below:\r\n                    self.Liquidate(self.spy)\r\n            elif spy_crosses_above:\r\n                self.SetHoldings(self.spy, 0.40)\r\n\r\n            if self.Portfolio[self.aapl].Quantity != 0:\r\n                if self.aapl_rsi.Current.Value > 60:\r\n                    self.Liquidate(self.aapl)\r\n            elif self.aapl_red_streak >= 3:\r\n                if self.Portfolio.Cash >= 20_000:\r\n                    quantity = int(20_000 // current_aapl_close)\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.aapl, quantity)\r\n\r\n        if has_aapl_bar:\r\n            if (\r\n                self.previous_aapl_close is not None\r\n                and current_aapl_close < self.previous_aapl_close\r\n            ):\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.previous_aapl_close = current_aapl_close\r\n\r\n        if has_spy_bar:\r\n            self.previous_spy_close = current_spy_close\r\n            if self.spy_sma.IsReady:\r\n                self.previous_spy_sma = self.spy_sma.Current.Value\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw15/3-EXTRACTED-PROGRAM.py",
      "sha256": "0020161e1f1f9e8efb76edb53c2aad95142044b94bc3fcac8745c46a94cad6a0",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 15,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_high_OM-B",
        "promptId": "OM-B",
        "i": 2,
        "claimedStatus": "coded",
        "claimedCode": "DRIFT",
        "promptBundleId": "lb-t1-variant-om-b"
      }
    },
    {
      "id": "lb-draw16-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 16 extracted program — T1v0 on gpt-5.6-luna_xhigh",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ExactStrategyAlgorithm(QCAlgorithm):\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1000000)\r\n\r\n        self.spy = self.AddEquity(\"SPY\", Resolution.Daily).Symbol\r\n        self.aapl = self.AddEquity(\"AAPL\", Resolution.Daily).Symbol\r\n        self.ibm = self.AddEquity(\"IBM\", Resolution.Daily).Symbol\r\n        self.bac = self.AddEquity(\"BAC\", Resolution.Daily).Symbol\r\n        self.aig = self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n\r\n        self.subscribed_symbols = [\r\n            self.spy,\r\n            self.aapl,\r\n            self.ibm,\r\n            self.bac,\r\n            self.aig\r\n        ]\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(\r\n            self.aapl,\r\n            14,\r\n            MovingAverageType.Wilders,\r\n            Resolution.Daily\r\n        )\r\n\r\n        self.previous_spy_sma = None\r\n        self.previous_aapl_close = None\r\n        self.aapl_red_streak = 0\r\n        self.aapl_close_count = 0\r\n\r\n        self.strategy_a_lot = 0\r\n        self.strategy_b_lot = 0\r\n\r\n        self.SetWarmUp(100, Resolution.Daily)\r\n\r\n    def OnData(self, data):\r\n        spy_bar = data.Bars[self.spy] if self.spy in data.Bars else None\r\n        aapl_bar = data.Bars[self.aapl] if self.aapl in data.Bars else None\r\n\r\n        previous_spy_sma = self.previous_spy_sma\r\n        current_spy_sma = None\r\n\r\n        if spy_bar is not None and self.spy_sma.IsReady:\r\n            current_spy_sma = float(self.spy_sma.Current.Value)\r\n            self.previous_spy_sma = current_spy_sma\r\n\r\n        if aapl_bar is not None:\r\n            current_aapl_close = float(aapl_bar.Close)\r\n\r\n            if self.previous_aapl_close is None:\r\n                self.aapl_red_streak = 0\r\n            elif current_aapl_close < self.previous_aapl_close:\r\n                self.aapl_red_streak += 1\r\n            else:\r\n                self.aapl_red_streak = 0\r\n\r\n            self.previous_aapl_close = current_aapl_close\r\n            self.aapl_close_count += 1\r\n\r\n        if self.IsWarmingUp:\r\n            return\r\n\r\n        if not all(symbol in data.Bars for symbol in self.subscribed_symbols):\r\n            return\r\n\r\n        spy_ready = (\r\n            self.spy_sma.IsReady\r\n            and previous_spy_sma is not None\r\n            and current_spy_sma is not None\r\n        )\r\n\r\n        aapl_ready = (\r\n            self.aapl_rsi.IsReady\r\n            and self.aapl_close_count >= 4\r\n        )\r\n\r\n        if spy_ready and self.strategy_a_lot > 0:\r\n            crosses_below = (\r\n                previous_spy_sma >= previous_spy_sma\r\n                and float(spy_bar.Close) < current_spy_sma\r\n            )\r\n\r\n            if crosses_below:\r\n                self.MarketOrder(self.spy, -self.strategy_a_lot)\r\n                self.strategy_a_lot = 0\r\n\r\n        if aapl_ready and self.strategy_b_lot > 0:\r\n            if float(self.aapl_rsi.Current.Value) > 60:\r\n                self.MarketOrder(self.aapl, -self.strategy_b_lot)\r\n                self.strategy_b_lot = 0\r\n\r\n        if spy_ready and self.strategy_a_lot == 0:\r\n            spy_close = float(spy_bar.Close)\r\n            crosses_above = (\r\n                previous_spy_sma <= previous_spy_sma\r\n                and spy_close > current_spy_sma\r\n            )\r\n\r\n            if crosses_above:\r\n                quantity = int(\r\n                    (0.40 * float(self.Portfolio.TotalPortfolioValue))\r\n                    / spy_close\r\n                )\r\n\r\n                if quantity > 0:\r\n                    self.MarketOrder(self.spy, quantity)\r\n                    self.strategy_a_lot = quantity\r\n\r\n        if aapl_ready and self.strategy_b_lot == 0:\r\n            aapl_close = float(aapl_bar.Close)\r\n\r\n            if self.aapl_red_streak >= 3:\r\n                if float(self.Portfolio.Cash) >= 20000:\r\n                    quantity = int(20000 / aapl_close)\r\n\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.aapl, quantity)\r\n                        self.strategy_b_lot = quantity\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw16/3-EXTRACTED-PROGRAM.py",
      "sha256": "aadae1515ef8b724943e79a637395e8743c8527c825c40f1a5376ede0fb9f9c7",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 16,
        "arm": "arm",
        "lane": "gpt-5.6-luna_xhigh",
        "promptId": "T1v0",
        "i": 3,
        "claimedStatus": "coded",
        "claimedCode": "DRIFT"
      }
    },
    {
      "id": "lb-draw17-program",
      "version": "1",
      "kind": "atom",
      "role": "no_program_extracted",
      "title": "Draw 17 extracted program — BL-08 on codex_gpt-5.6-terra_low_BL-08_noask",
      "labels": [
        "No program extracted",
        "Python",
        "Matching code",
        "Verification packet",
        "asks-clarifying"
      ],
      "text": "# (no program extracted)",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw17/3-EXTRACTED-PROGRAM.py",
      "sha256": "2989ca72b02fa12c1e3a4050cbef07de32aa1010cd86ac575acb29e4811cc472",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 17,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_low_BL-08_noask",
        "promptId": "BL-08",
        "i": 2,
        "claimedStatus": "asks-clarifying",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-08"
      }
    },
    {
      "id": "lb-draw18-program",
      "version": "1",
      "kind": "atom",
      "role": "no_program_extracted",
      "title": "Draw 18 extracted program — BL-03 on codex_gpt-5.6-terra_medium_BL-03",
      "labels": [
        "No program extracted",
        "Python",
        "Matching code",
        "Verification packet",
        "asks-clarifying"
      ],
      "text": "# (no program extracted)",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw18/3-EXTRACTED-PROGRAM.py",
      "sha256": "2989ca72b02fa12c1e3a4050cbef07de32aa1010cd86ac575acb29e4811cc472",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 18,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_medium_BL-03",
        "promptId": "BL-03",
        "i": 9,
        "claimedStatus": "asks-clarifying",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-03"
      }
    },
    {
      "id": "lb-draw19-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 19 extracted program — OM-B on codex_gpt-5.6-terra_medium_OM-B_noask",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "coded"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ExactStrategySystem(QCAlgorithm):\r\n\r\n    def Initialize(self):\r\n        self.SetStartDate(2006, 1, 3)\r\n        self.SetEndDate(2015, 12, 31)\r\n        self.SetCash(1_000_000)\r\n\r\n        self.symbols = [\r\n            self.AddEquity(\"SPY\", Resolution.Daily).Symbol,\r\n            self.AddEquity(\"AAPL\", Resolution.Daily).Symbol,\r\n            self.AddEquity(\"IBM\", Resolution.Daily).Symbol,\r\n            self.AddEquity(\"BAC\", Resolution.Daily).Symbol,\r\n            self.AddEquity(\"AIG\", Resolution.Daily).Symbol\r\n        ]\r\n\r\n        self.spy = self.Symbol(\"SPY\")\r\n        self.aapl = self.Symbol(\"AAPL\")\r\n\r\n        self.spy_sma = self.SMA(self.spy, 100, Resolution.Daily)\r\n        self.aapl_rsi = self.RSI(self.aapl, 14, MovingAverageType.Wilders, Resolution.Daily)\r\n\r\n        self.previous_closes = {}\r\n        self.previous_spy_sma = None\r\n        self.previous_spy_close = None\r\n        self.aapl_red_streak = 0\r\n\r\n        self.strategy_a_shares = 0\r\n        self.strategy_b_shares = 0\r\n\r\n    def OnData(self, data: Slice):\r\n        # Keep lot state synchronized with filled holdings.\r\n        self.strategy_a_shares = int(self.Portfolio[self.spy].Quantity)\r\n        self.strategy_b_shares = int(self.Portfolio[self.aapl].Quantity)\r\n\r\n        # If any subscribed ticker is missing, skip all rule evaluation.\r\n        if any(symbol not in data.Bars for symbol in self.symbols):\r\n            return\r\n\r\n        spy_close = data.Bars[self.spy].Close\r\n        aapl_close = data.Bars[self.aapl].Close\r\n\r\n        prior_aapl_close = self.previous_closes.get(self.aapl)\r\n        if prior_aapl_close is None:\r\n            self.aapl_red_streak = 0\r\n        elif aapl_close < prior_aapl_close:\r\n            self.aapl_red_streak += 1\r\n        else:\r\n            self.aapl_red_streak = 0\r\n\r\n        all_rules_ready = (\r\n            self.spy_sma.IsReady\r\n            and self.aapl_rsi.IsReady\r\n            and self.previous_spy_sma is not None\r\n            and self.previous_spy_close is not None\r\n        )\r\n\r\n        if all_rules_ready:\r\n            spy_sma_value = self.spy_sma.Current.Value\r\n\r\n            spy_crosses_above = (\r\n                self.previous_spy_close <= self.previous_spy_sma\r\n                and spy_close > spy_sma_value\r\n            )\r\n            spy_crosses_below = (\r\n                self.previous_spy_close >= self.previous_spy_sma\r\n                and spy_close < spy_sma_value\r\n            )\r\n\r\n            # Slot 1: Strategy A\r\n            if self.strategy_a_shares > 0:\r\n                if spy_crosses_below:\r\n                    self.MarketOrder(self.spy, -self.strategy_a_shares)\r\n            else:\r\n                if spy_crosses_above:\r\n                    target_value = self.Portfolio.TotalPortfolioValue * 0.40\r\n                    quantity = int(target_value / spy_close)\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.spy, quantity)\r\n\r\n            # Slot 2: Strategy B\r\n            if self.strategy_b_shares > 0:\r\n                if self.aapl_rsi.Current.Value > 60:\r\n                    self.MarketOrder(self.aapl, -self.strategy_b_shares)\r\n            else:\r\n                if self.aapl_red_streak >= 3 and self.Portfolio.Cash >= 20_000:\r\n                    quantity = int(20_000 / aapl_close)\r\n                    if quantity > 0:\r\n                        self.MarketOrder(self.aapl, quantity)\r\n\r\n        self.previous_spy_close = spy_close\r\n        self.previous_spy_sma = self.spy_sma.Current.Value if self.spy_sma.IsReady else None\r\n\r\n        for symbol in self.symbols:\r\n            self.previous_closes[symbol] = data.Bars[symbol].Close\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw19/3-EXTRACTED-PROGRAM.py",
      "sha256": "7fc26fd8ea934b093b9f07bdf1985847e548e987ea30170c53a775070e8fbec9",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 19,
        "arm": "benchmark",
        "lane": "codex_gpt-5.6-terra_medium_OM-B_noask",
        "promptId": "OM-B",
        "i": 8,
        "claimedStatus": "coded",
        "claimedCode": "DRIFT",
        "promptBundleId": "lb-t1-variant-om-b"
      }
    },
    {
      "id": "lb-draw20-program",
      "version": "1",
      "kind": "atom",
      "role": "model_program",
      "title": "Draw 20 extracted program — BL-01c on gpt-5.6-sol_low",
      "labels": [
        "Model program",
        "Python",
        "Matching code",
        "Verification packet",
        "non-runnable"
      ],
      "text": "from AlgorithmImports import *\r\n\r\n\r\nclass ExactStrategySystem(QCAlgorithm):\r\n    def Initialize(self):\r\n        raise ValueError(\r\n            \"Strategy A's moving-average type and lookback period are unspecified, \"\r\n            \"so the strategy cannot be implemented exactly without adding or \"\r\n            \"reinterpreting a rule.\"\r\n        )\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/verification-packet/draw20/3-EXTRACTED-PROGRAM.py",
      "sha256": "8525d367e8610eba4e0deb56fe1a563ebabdd88c443e594f02b94156c9250869",
      "donor": {
        "record": "verification-packet",
        "index": "historical/LEAN-Bench/verification-packet/INDEX.json",
        "draw": 20,
        "arm": "arm",
        "lane": "gpt-5.6-sol_low",
        "promptId": "BL-01c",
        "i": 4,
        "claimedStatus": "non-runnable",
        "claimedCode": null,
        "promptBundleId": "lb-t1-variant-bl-01c"
      }
    },
    {
      "id": "lb-instrument-bank-spec",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "bank_spec.py — Oracle-bank specification v2 — PIN-v5 SS4 (vetting-council round 1).",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Oracle bank"
      ],
      "text": "\"\"\"Oracle-bank specification v2 — PIN-v5 SS4 (vetting-council round 1).\r\nSingle source of truth: DOF levels, per-projection CONDITIONING sets with\r\nthe structural invariance argument stated, resolution enumerations, the\r\npre-registered CLASS registry (tuple-invariant labels + absorption\r\npriority), probe banks, and the derived count table.\r\n\r\nGrid rule per bank: FULL FACTORIAL over the bank's conditioning set\r\n(interactions covered), plus for every EXCLUDED DOF an OAT run per\r\nresolution at reference (invariance evidence), plus one random\r\nall-off-reference interaction spot-check per resolution.\r\n\"\"\"\r\nimport itertools\r\n\r\nDONOR = {\r\n    \"a_ma_type\": \"SMA\", \"a_ma_period\": 100,\r\n    \"a_buy_dir\": \"up\", \"a_sell_dir\": \"down\",\r\n    \"a_size_pct\": 40.0, \"a_sell_frac\": \"all\",\r\n    \"er01_sell\": \"none\",\r\n    \"b_red_def\": \"prev_close\", \"b_red_days\": 3,\r\n    \"b_cash_rule\": \"skip\", \"b_cash_amt\": 20000.0,\r\n    \"b_rsi_period\": 14, \"b_rsi_thresh\": 60.0,\r\n    \"missing_bar\": \"skip_all\", \"lots\": \"private\", \"eval_order\": \"sells_first\",\r\n    \"slot_mode\": \"parallel\",\r\n    \"dof_rsi_smoothing\": \"wilder\", \"dof_rsi_exit\": \"level\",\r\n    \"dof_warmup\": \"strict\", \"dof_warmup_bars\": None,\r\n    \"dof_a_exec\": \"calc_shares\", \"dof_same_bar_reentry\": \"allowed\",\r\n    \"dof_input_field\": \"adjusted\", \"dof_cross_timing\": \"both_days\",\r\n}\r\n\r\n# Registered free DOFs and levels (reference level FIRST). These are the\r\n# implementation choices the donor prompt leaves open; every level is a\r\n# reading real programs exhibit (evidence: the 4 pinned-T1 programs +\r\n# council simulations).\r\nDOFS = {\r\n    \"dof_rsi_smoothing\": [\"wilder\", \"simple\"],\r\n    \"dof_rsi_exit\": [\"level\", \"cross\"],\r\n    \"dof_warmup\": [\"strict\", \"ready_check\", \"ready_per_rule\"],\r\n    \"dof_a_exec\": [\"calc_shares\", \"set_holdings\"],\r\n    \"dof_same_bar_reentry\": [\"allowed\", \"wait_bar\"],\r\n    \"dof_input_field\": [\"adjusted\", \"raw\"],\r\n    \"dof_cross_timing\": [\"both_days\", \"today_ma\"],\r\n}\r\n# strict-warmup EMA transient: SetWarmUp length matters for EMA only\r\n# (first-value seed); precomputed lengths, others on demand (SS4.1.4)\r\nEMA_WARMUP_BARS = [None, 150, 200, 252]\r\n\r\n# Conditioning sets by projection, with the structural argument (recorded\r\n# per SS4.1.3; the excluded DOFs are ALSO OAT-checked per resolution).\r\nA_DATES = [\"dof_warmup\", \"dof_input_field\", \"dof_cross_timing\"]\r\nA_DATES_WHY = (\"A's entry/exit DATES depend only on SPY closes, the MA and the \"\r\n               \"readiness/timing convention; RSI smoothing/exit, A sizing and \"\r\n               \"re-entry cannot move them (a bar cannot cross both ways under a \"\r\n               \"directional reading; A never fails a buy with $1M).\")\r\nB_DATES = [\"dof_rsi_smoothing\", \"dof_rsi_exit\", \"dof_warmup\",\r\n           \"dof_same_bar_reentry\", \"dof_input_field\"]\r\nB_DATES_WHY = (\"B's entry/exit dates depend on AAPL closes, the RSI convention \"\r\n               \"(smoothing, level-vs-cross), readiness, and same-bar re-entry; \"\r\n               \"A's sizing/timing cannot reach them (B's $20k gate never binds).\")\r\nALL_DATES = sorted(set(A_DATES) | set(B_DATES))\r\nALL_DATES_WHY = \"Both legs' dates: union of the two arguments above.\"\r\n\r\n# Projections (bank_runner.project). Every run stores ALL kinds.\r\nPROJECTIONS = [\"full\", \"dates_all\", \"A_entries_exits\", \"A_full\",\r\n               \"A_sell_ratio\", \"B_entries\", \"B_exits\", \"B_full\"]\r\n\r\nALL = list(DOFS.keys())\r\n\r\ndef _cross_res():\r\n    \"\"\"buy_dir x sell_dir over {up, down, any} (9 pairs; sol-1 R1 #3: BL-02c's\r\n    identical clauses admit every pairing) + the level relation, x re-entry.\"\"\"\r\n    r = {}\r\n    names = {(\"up\", \"down\"): \"conv\", (\"down\", \"up\"): \"inv\", (\"any\", \"any\"): \"sym\",\r\n             (\"up\", \"up\"): \"uu\", (\"down\", \"down\"): \"dd\", (\"up\", \"any\"): \"ua\",\r\n             (\"any\", \"up\"): \"au\", (\"down\", \"any\"): \"da\", (\"any\", \"down\"): \"ad\",\r\n             (\"level_above\", \"level_below\"): \"level\"}\r\n    for dirs, tag in names.items():\r\n        for re_, rtag in ((\"allowed\", \"reent\"), (\"wait_bar\", \"wait\")):\r\n            r[f\"{tag}_{rtag}\"] = {\"a_buy_dir\": dirs[0], \"a_sell_dir\": dirs[1],\r\n                                  \"dof_same_bar_reentry\": re_}\r\n    return r\r\n\r\nBLANKS = {\r\n    \"DONOR\": {\"projection\": \"full\", \"conditioning\": [], \"why\": \"reference + OAT record only (baseline/BL-00 are code-read, not tape-coded)\",\r\n              \"resolutions\": {\"pin\": {}}, \"coded_by\": \"none\"},\r\n    \"BL-01a\": {\"projection\": \"A_entries_exits\", \"conditioning\": A_DATES, \"why\": A_DATES_WHY, \"coded_by\": \"tape\",\r\n               \"resolutions\": {\"SMA\": {}, \"EMA\": {\"a_ma_type\": \"EMA\"}, \"WMA\": {\"a_ma_type\": \"WMA\"}}},\r\n    \"BL-01b\": {\"projection\": \"A_entries_exits\", \"conditioning\": A_DATES, \"why\": A_DATES_WHY, \"coded_by\": \"numeric\",\r\n               \"resolutions\": {f\"p{p}\": ({} if p == 100 else {\"a_ma_period\": p}) for p in (10, 20, 50, 100, 200)}},\r\n    \"BL-01c\": {\"projection\": \"A_entries_exits\", \"conditioning\": A_DATES, \"why\": A_DATES_WHY, \"coded_by\": \"tape\",\r\n               \"resolutions\": {f\"{t}{p}\": {\"a_ma_type\": t, \"a_ma_period\": p}\r\n                               for t in (\"SMA\", \"EMA\", \"WMA\") for p in (10, 20, 50, 100, 200)}},\r\n    \"CROSS\": {\"projection\": \"A_entries_exits\", \"conditioning\": [d for d in A_DATES],  # re-entry is resolution-bearing\r\n              \"why\": A_DATES_WHY + \" Same-bar re-entry is RESOLUTION-BEARING here (SS4.1.2 named case).\",\r\n              \"coded_by\": \"tape\", \"resolutions\": _cross_res()},\r\n    \"BL-03\": {\"projection\": \"A_full\", \"conditioning\": A_DATES + [\"dof_a_exec\"], \"coded_by\": \"numeric\",\r\n              \"why\": A_DATES_WHY + \" Quantities add the sizing mechanism; TPV path (B-side) affects share counts -> on-demand for other tuples (numeric blank: tape = drift FLAG only).\",\r\n              \"resolutions\": {f\"pct{int(v)}\": ({} if v == 40 else {\"a_size_pct\": float(v)}) for v in (10, 20, 25, 40, 50, 100)}},\r\n    \"BL-04\": {\"projection\": \"B_entries\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"tape\",\r\n              \"resolutions\": {\"prev_close\": {}, \"open_close\": {\"b_red_def\": \"open_close\"},\r\n                              \"prev_close_le\": {\"b_red_def\": \"prev_close_le\"}}},\r\n    \"BL-05\": {\"projection\": \"B_entries\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"numeric\",\r\n              \"resolutions\": {f\"d{k}\": ({} if k == 3 else {\"b_red_days\": k}) for k in (2, 3, 4, 5)}},\r\n    \"BL-07\": {\"projection\": \"B_exits\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"numeric\",\r\n              \"resolutions\": {f\"p{k}\": ({} if k == 14 else {\"b_rsi_period\": k}) for k in (7, 9, 14, 21)}},\r\n    \"BL-08\": {\"projection\": \"B_exits\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"numeric\",\r\n              \"resolutions\": {f\"t{int(v)}\": ({} if v == 60 else {\"b_rsi_thresh\": float(v)}) for v in (50, 60, 70, 80)}},\r\n    \"BL-09\": {\"projection\": \"A_sell_ratio\", \"conditioning\": ALL, \"coded_by\": \"tape\",\r\n              \"why\": \"Sold/held RATIO (2dp) removes magnitude but the HALF variants' rounding at small residual lots depends on lot size, hence on the whole TPV path (bank v2 OAT evidence) -> full 7-DOF conditioning.\",\r\n              \"resolutions\": {\"all\": {}, \"half_down_lastsell\": {\"a_sell_frac\": \"half_down_lastsell\"},\r\n                              \"half_down_hold\": {\"a_sell_frac\": \"half_down_hold\"}, \"half_up\": {\"a_sell_frac\": \"half_up\"}}},\r\n    \"ER-01\": {\"projection\": \"A_entries_exits\", \"conditioning\": A_DATES + [\"dof_same_bar_reentry\"], \"coded_by\": \"tape\",\r\n              \"why\": A_DATES_WHY + \" Same-bar re-entry ADDED (bank v2 OAT evidence): R2/R5 sell on the same cross direction as the buy, so a sell and rebuy can coincide.\",\r\n              \"resolutions\": {f\"R{i}\": {\"er01_sell\": f\"R{i}\"} for i in range(1, 7)}},\r\n    \"OM-B\": {\"projection\": \"dates_all\", \"conditioning\": ALL_DATES, \"why\": ALL_DATES_WHY, \"coded_by\": \"tape\",\r\n             \"resolutions\": {\"private\": {}, \"invested_gate\": {\"lots\": \"invested_gate\"},\r\n                             \"netting\": {\"lots\": \"netting\"}, \"buys_first\": {\"eval_order\": \"buys_first\"}}},\r\n    \"OM-C\": {\"projection\": \"dates_all\", \"conditioning\": ALL_DATES, \"why\": ALL_DATES_WHY, \"coded_by\": \"tape\",\r\n             \"resolutions\": {\"parallel\": {}, \"race\": {\"slot_mode\": \"race\"}, \"sequence\": {\"slot_mode\": \"sequence\"},\r\n                             \"shared_state\": {\"lots\": \"shared_flag\"}}},\r\n    # probes (SS8.2): separately hashed manifests; PX-02 shares CROSS runs\r\n    \"PX-01\": {\"projection\": \"B_full\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"numeric\",\r\n              \"resolutions\": {f\"c{int(v)}\": ({} if v == 20000 else {\"b_cash_amt\": float(v)}) for v in (5000, 10000, 20000, 50000)}},\r\n}\r\nBLANKS[\"PX-02\"] = dict(BLANKS[\"CROSS\"], alias_of=\"CROSS\")\r\n\r\n# BL-06 / OM-A: cut by the 2026-08-15 OAT gate; per sol-1 R1 #35 they are\r\n# re-gated on the FULL conditioning grid in v2 (the gate decides, not a\r\n# hard-coded set). CUT is applied only by the v2 gate report.\r\nCUT = set()\r\nBLANKS[\"BL-06\"] = {\"projection\": \"B_full\", \"conditioning\": B_DATES, \"why\": B_DATES_WHY, \"coded_by\": \"tape\",\r\n                   \"resolutions\": {\"skip\": {}, \"partial\": {\"b_cash_rule\": \"partial\"}, \"nocheck\": {\"b_cash_rule\": \"nocheck\"}}}\r\nBLANKS[\"OM-A\"] = {\"projection\": \"dates_all\", \"conditioning\": ALL_DATES, \"why\": ALL_DATES_WHY, \"coded_by\": \"tape\",\r\n                  \"resolutions\": {\"skip_all\": {}, \"try_except\": {\"missing_bar\": \"try_except\"}, \"per_ticker\": {\"missing_bar\": \"per_ticker\"}}}\r\n# (no_guard crashes on the auxiliary slice by construction; recorded as a\r\n#  crash class in the OM-A README, not enumerated as an oracle)\r\n\r\n# Which frozen variants each bank serves (coding-time mapping).\r\nVARIANT_BANKS = {\r\n    \"BL-00\": \"DONOR\", \"BL-02a\": \"CROSS\", \"BL-02b'\": \"CROSS\", \"BL-02b\": \"CROSS\", \"BL-02c\": \"CROSS\",\r\n    \"BL-01a\": \"BL-01a\", \"BL-01b\": \"BL-01b\", \"BL-01c\": \"BL-01c\",\r\n    \"BL-03\": \"BL-03\", \"BL-04\": \"BL-04\", \"BL-05\": \"BL-05\",\r\n    \"BL-07\": \"BL-07\", \"BL-08\": \"BL-08\", \"BL-09a\": \"BL-09\", \"BL-09b\": \"BL-09\",\r\n    \"ER-01\": \"ER-01\", \"ER-01c\": \"ER-01\", \"OM-B\": \"OM-B\", \"OM-C\": \"OM-C\",\r\n    \"PX-01\": \"PX-01\", \"PX-02\": \"PX-02\",\r\n    # baseline arm (pinned donor): tape-compared against the DONOR reference;\r\n    # its convention analysis is code-read from the per-draw DOF record (SS4.6.1)\r\n    \"T1v0\": \"DONOR\",\r\n}\r\nEXPECTED_CONTROL = {\"ER-01c\": \"R1\"}  # the pinned control's expected reading\r\n\r\n# CLASS REGISTRY (SS4.3.2/4.3.4, pre-registered, tuple-invariant labels).\r\n# core: resolution -> core label; priority: which core NAMES a merged class;\r\n# absorbed cores never name a class (recorded as annotation only).\r\nCLASSES = {\r\n    \"CROSS\": {\"core\": {**{f\"conv_{r}\": \"CONV\" for r in (\"reent\", \"wait\")},\r\n                       **{f\"inv_{r}\": \"INV\" for r in (\"reent\", \"wait\")},\r\n                       \"sym_reent\": \"SYM-CHURN\", \"sym_wait\": \"SYM-WAIT\",\r\n                       **{f\"level_{r}\": \"LEVEL\" for r in (\"reent\", \"wait\")},\r\n                       **{f\"{t}_{r}\": t.upper() for t in (\"uu\", \"dd\", \"ua\", \"au\", \"da\", \"ad\") for r in (\"reent\", \"wait\")}},\r\n              \"priority\": [\"CONV\", \"INV\", \"SYM-CHURN\", \"LEVEL\", \"UU\", \"DD\", \"UA\", \"AU\", \"DA\", \"AD\"], \"absorbed\": [\"SYM-WAIT\"]},\r\n    \"BL-04\": {\"core\": {\"prev_close\": \"PREV_CLOSE\", \"prev_close_le\": \"PREV_CLOSE_LE\", \"open_close\": \"OPEN_CLOSE\"},\r\n              \"priority\": [\"PREV_CLOSE\", \"OPEN_CLOSE\", \"PREV_CLOSE_LE\"], \"absorbed\": []},\r\n    \"OM-B\": {\"core\": {\"private\": \"PRIVATE\", \"invested_gate\": \"INVESTED_GATE\", \"netting\": \"NETTING\", \"buys_first\": \"BUYS_FIRST\"},\r\n             \"priority\": [\"PRIVATE\", \"BUYS_FIRST\", \"NETTING\", \"INVESTED_GATE\"], \"absorbed\": []},\r\n    \"OM-C\": {\"core\": {\"parallel\": \"PARALLEL\", \"race\": \"RACE\", \"sequence\": \"SEQUENCE\", \"shared_state\": \"SHARED_STATE\"},\r\n             \"priority\": [\"PARALLEL\", \"RACE\", \"SEQUENCE\", \"SHARED_STATE\"], \"absorbed\": []},\r\n    \"BL-09\": {\"core\": {\"all\": \"ALL\", \"half_down_lastsell\": \"HALF_DOWN_LASTSELL\", \"half_down_hold\": \"HALF_DOWN_HOLD\", \"half_up\": \"HALF_UP\"},\r\n              \"priority\": [\"ALL\", \"HALF_DOWN_LASTSELL\", \"HALF_DOWN_HOLD\", \"HALF_UP\"], \"absorbed\": []},\r\n}\r\nCLASSES[\"PX-02\"] = CLASSES[\"CROSS\"]\r\n\r\n\r\ndef class_name(bank, matched_resolutions):\r\n    \"\"\"Tuple-invariant class label for a matched-resolution set.\"\"\"\r\n    ms = sorted(matched_resolutions)\r\n    reg = CLASSES.get(bank)\r\n    if not reg:\r\n        return \"+\".join(ms) if len(ms) > 1 else (ms[0] if ms else \"\")\r\n    cores = {reg[\"core\"].get(r, r) for r in ms}\r\n    named = [c for c in reg[\"priority\"] if c in cores]\r\n    if not named:\r\n        return \"+\".join(sorted(cores))\r\n    non_abs = [c for c in named if c not in reg[\"absorbed\"]] or named\r\n    # TUPLE-INVARIANT LABEL: the highest-priority core present. The matched\r\n    # SET varies with the free DOFs (e.g. conv_reent matches only itself at\r\n    # today_ma tuples but collides with level/ua/ad at both_days tuples), so\r\n    # naming a class by the whole set split ONE convention across several\r\n    # categories and corrupted the modal sets (opus-3 R2 #1, opus-4 R2 #1).\r\n    # The full matched set is preserved per draw as an annotation, and the\r\n    # share of draws whose match was ambiguous is reported beside every\r\n    # modal-set figure.\r\n    return non_abs[0]\r\n\r\n\r\ndef grid_for(bank_id):\r\n    \"\"\"Yield (resolution, params, kind, tag) for the full precompute plan.\"\"\"\r\n    spec = BLANKS[bank_id]\r\n    if spec.get(\"alias_of\"):\r\n        return\r\n    cond = spec[\"conditioning\"]\r\n    excluded = [d for d in ALL if d not in cond]\r\n    for res, ov in spec[\"resolutions\"].items():\r\n        # DOFs the resolution itself pins are removed from the factorial\r\n        cond_eff = [d for d in cond if d not in ov]\r\n        levels = [DOFS[d] for d in cond_eff]\r\n        for combo in itertools.product(*levels) if cond_eff else [()]:\r\n            setting = dict(zip(cond_eff, combo))\r\n            p = dict(DONOR); p.update(ov); p.update(setting)\r\n            is_ref = all(v == DONOR[d] for d, v in setting.items())\r\n            # FULL level names in the tag: the old [:6] truncation collided\r\n            # ready_check/ready_per_rule and silently deduped every\r\n            # ready_per_rule grid cell (caught by the execution control)\r\n            tag = \"ref\" if is_ref else \"T_\" + \"_\".join(f\"{d.replace('dof_','')}={v}\" for d, v in sorted(setting.items()))\r\n            yield res, p, \"grid\", tag\r\n            # EMA transient lengths (strict warmup only)\r\n            if p[\"a_ma_type\"] == \"EMA\" and p[\"dof_warmup\"] == \"strict\":\r\n                for wb in EMA_WARMUP_BARS[1:]:\r\n                    q = dict(p); q[\"dof_warmup_bars\"] = wb\r\n                    yield res, q, \"grid\", tag + f\"_wb={wb}\"\r\n        # OAT invariance evidence for excluded DOFs (at reference otherwise)\r\n        for d in excluded:\r\n            if d in ov:\r\n                continue\r\n            for lvl in DOFS[d][1:]:\r\n                p = dict(DONOR); p.update(ov); p[d] = lvl\r\n                yield res, p, \"oat\", f\"OAT_{d.replace('dof_','')}={lvl}\"\r\n        # interaction spot-check: every excluded DOF off-reference at once\r\n        if excluded:\r\n            p = dict(DONOR); p.update(ov)\r\n            for d in excluded:\r\n                if d not in ov:\r\n                    p[d] = DOFS[d][1]\r\n            yield res, p, \"spot\", \"SPOT_all_excluded_off\"\r\n\r\n\r\ndef derived_table():\r\n    rows, total = [], 0\r\n    for bank in BLANKS:\r\n        n = sum(1 for _ in grid_for(bank))\r\n        rows.append((bank, len(BLANKS[bank][\"resolutions\"]), len(BLANKS[bank][\"conditioning\"]), n))\r\n        total += n\r\n    return rows, total\r\n\r\n\r\nif __name__ == \"__main__\":\r\n    rows, total = derived_table()\r\n    print(f\"{'bank':8s} res cond  runs\")\r\n    for b, r, c, n in rows:\r\n        print(f\"{b:8s} {r:3d} {c:4d} {n:5d}\")\r\n    print(\"TOTAL runs\", total)\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/bank/bank_spec.py",
      "sha256": "924e857efdac9bb8516535dee3b82816d63833951efa586310dbf5e959b940d1"
    },
    {
      "id": "lb-instrument-bank-runner",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "bank_runner.py — Oracle-bank runner v2 — PIN-v5 SS4.2/4.3 (vetting-council round 1).",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Oracle bank"
      ],
      "text": "\"\"\"Oracle-bank runner v2 — PIN-v5 SS4.2/4.3 (vetting-council round 1).\r\n- verifies the DATA FREEZE (aggregate sha over the exact file list) BEFORE\r\n  any engine run; records data hash, engine image digest, lean CLI version,\r\n  git rev, source sha, exit code, completion marker per run (MANIFEST)\r\n- N parallel workers, each in its OWN LEAN project dir (no shared main.py)\r\n- timeout -> kills the process tree AND stops the run's docker container\r\n- completion detected from the result JSON / log, so a zero-order run is a\r\n  tape [] (never 'not run', never 'ok' by mere file presence); stale or\r\n  partial outputs are refused (manifest must match the source sha)\r\n- stores the RAW fill list per run and ALL projection kinds (dates = ET\r\n  calendar dates), so re-projection never needs the engine\r\n- gate + tuple floors + class collapses derived IN CODE, fail-closed\r\n\r\nUsage:\r\n  python bank_runner.py --plan                # print job counts\r\n  python bank_runner.py --build --workers 4   # build everything (resumable)\r\n  python bank_runner.py --report              # gate/tuple/class report\r\n\"\"\"\r\nimport argparse\r\nimport datetime as dt\r\nimport hashlib\r\nimport json\r\nimport os\r\nimport shutil\r\nimport subprocess\r\nimport sys\r\nimport time\r\nfrom concurrent.futures import ProcessPoolExecutor, as_completed\r\nfrom pathlib import Path\r\n\r\nHERE = Path(__file__).resolve().parent\r\nsys.path.insert(0, str(HERE))\r\nfrom bank_spec import BLANKS, DONOR, DOFS, CUT, PROJECTIONS, grid_for, class_name  # noqa: E402\r\n\r\n# Physical path (the Desktop\\7.1 Research junction breaks the lean CLI)\r\nBASE = Path(r\"\x43:\\Users\\redacted-profile\\Desktop\\8.14\\school\\7.1 Research\\LLMDataAcquisition\")\r\nWS = BASE / \"complexity_axis_spike\" / \"lean_ws\"\r\nBT = WS / \"backtests\"\r\nDATA = WS / \"data\"\r\nTEMPLATE_PATH = HERE / \"t1_ref_template.py\"\r\nBANK_DIR = HERE / \"bank_v2\"\r\nBANK_DIR.mkdir(exist_ok=True)\r\nFREEZE_JSON = HERE / \"DATA-FREEZE.json\"\r\n\r\n# ---------------------------------------------------------------- freeze\r\n\r\nFREEZE_FILES = [\r\n    \"equity/usa/daily/aapl.zip\", \"equity/usa/daily/aig.zip\", \"equity/usa/daily/bac.zip\",\r\n    \"equity/usa/daily/ibm.zip\", \"equity/usa/daily/spy.zip\",\r\n    \"equity/usa/factor_files/aapl.csv\", \"equity/usa/factor_files/aig.csv\",\r\n    \"equity/usa/factor_files/bac.csv\", \"equity/usa/factor_files/ibm.csv\",\r\n    \"equity/usa/factor_files/spy.csv\",\r\n    \"equity/usa/map_files/aapl.csv\", \"equity/usa/map_files/aig.csv\",\r\n    \"equity/usa/map_files/bac.csv\", \"equity/usa/map_files/ibm.csv\", \"equity/usa/map_files/spy.csv\",\r\n    \"alternative/interest-rate/usa/interest-rate.csv\",   # E16 (Arm B) custom data\r\n]\r\nREGISTERED_T1_AGGREGATE = \"5ae1bdb0e71af54f6c24c28a42bba431976348d40ca2a87ae9b75ec676094680\"  # 15 T1 files, 2026-08-15\r\n\r\n\r\ndef sha_file(p):\r\n    return hashlib.sha256(Path(p).read_bytes()).hexdigest()\r\n\r\n\r\ndef compute_freeze():\r\n    \"\"\"Aggregate = sha256 over the concatenation of per-file sha256 hex\r\n    strings in FREEZE_FILES order (UTF-8); T1 aggregate = first 15 files.\"\"\"\r\n    per = {f: sha_file(DATA / f) for f in FREEZE_FILES}\r\n    h_all = hashlib.sha256(\"\".join(per[f] for f in FREEZE_FILES).encode()).hexdigest()\r\n    h_t1 = hashlib.sha256(\"\".join(per[f] for f in FREEZE_FILES[:15]).encode()).hexdigest()\r\n    return per, h_t1, h_all\r\n\r\n\r\ndef engine_identity():\r\n    cfg = json.loads((Path.home() / \".lean\" / \"config\").read_text(encoding=\"utf-8\"))\r\n    img = cfg.get(\"engine-image\", \"\")\r\n    try:\r\n        ver = subprocess.run([\"lean\", \"--version\"], capture_output=True, text=True, shell=True, timeout=60).stdout.strip()\r\n    except Exception:\r\n        ver = \"unknown\"\r\n    try:\r\n        rev = subprocess.run([\"git\", \"rev-parse\", \"HEAD\"], capture_output=True, text=True, cwd=str(HERE.parent)).stdout.strip()\r\n    except Exception:\r\n        rev = \"unknown\"\r\n    return {\"engine_image\": img, \"lean_cli\": ver, \"git_rev\": rev}\r\n\r\n\r\ndef verify_freeze(strict=True):\r\n    per, h_t1, h_all = compute_freeze()\r\n    ok = (h_t1 == REGISTERED_T1_AGGREGATE)\r\n    rec = {\"files\": per, \"t1_aggregate\": h_t1, \"all_aggregate\": h_all,\r\n           \"registered_t1_aggregate\": REGISTERED_T1_AGGREGATE, \"match\": ok,\r\n           \"engine\": engine_identity(), \"checked_at\": dt.datetime.now().isoformat()}\r\n    FREEZE_JSON.write_text(json.dumps(rec, indent=1), encoding=\"utf-8\")\r\n    if strict and not ok:\r\n        raise SystemExit(f\"DATA FREEZE MISMATCH: t1 aggregate {h_t1} != registered {REGISTERED_T1_AGGREGATE}\")\r\n    return rec\r\n\r\n# ---------------------------------------------------------------- engine\r\n\r\ndef build_source(params):\r\n    return TEMPLATE_PATH.read_text(encoding=\"utf-8\").replace(\"{{PARAMS}}\", json.dumps(params))\r\n\r\n\r\ndef sha(s):\r\n    return hashlib.sha256(s.encode(\"utf-8\")).hexdigest()\r\n\r\n\r\ndef run_name(bank, res, tag):\r\n    return f\"BANK2_{bank}_{res}__{tag}\".replace(\"'\", \"q\").replace(\"=\", \"-\")\r\n\r\n\r\ndef worker_project(w=None):\r\n    \"\"\"Own LEAN project dir per PROCESS (keyed by pid — a job-index key let\r\n    two pool processes share a main.py; council sol-1 #12, found live in\r\n    bank v2 as 20 mixed-source runs). `w` is accepted for compatibility.\"\"\"\r\n    w = os.getpid() % 100000\r\n    d = WS / f\"AxisTestP{w}\"\r\n    if not d.exists():\r\n        d.mkdir()\r\n        shutil.copyfile(WS / \"AxisTest\" / \"config.json\", d / \"config.json\")\r\n    return d\r\n\r\n\r\ndef stop_run_containers(outname):\r\n    \"\"\"Stop any lean_cli_ container whose mounts reference this run.\"\"\"\r\n    try:\r\n        ids = subprocess.run([\"docker\", \"ps\", \"-q\", \"--filter\", \"name=lean_cli_\"],\r\n                             capture_output=True, text=True, timeout=60).stdout.split()\r\n        for cid in ids:\r\n            info = subprocess.run([\"docker\", \"inspect\", cid], capture_output=True, text=True, timeout=60).stdout\r\n            if outname in info:\r\n                subprocess.run([\"docker\", \"stop\", cid], capture_output=True, timeout=120)\r\n    except Exception:\r\n        pass\r\n\r\n\r\ndef engine_exec(project_dir, src_text, outname, timeout=900):\r\n    (project_dir / \"main.py\").write_text(src_text, encoding=\"utf-8\")\r\n    logf = project_dir / \"engine_last.log\"\r\n    t0 = time.time()\r\n    with open(logf, \"w\", encoding=\"utf-8\", errors=\"replace\") as fh:\r\n        p = subprocess.Popen([\"lean\", \"backtest\", project_dir.name, \"--output\", f\"backtests\\\\{outname}\"],\r\n                             stdout=fh, stderr=subprocess.STDOUT, cwd=str(WS), shell=True)\r\n        try:\r\n            rc = p.wait(timeout=timeout)\r\n        except subprocess.TimeoutExpired:\r\n            subprocess.run([\"taskkill\", \"/F\", \"/T\", \"/PID\", str(p.pid)], capture_output=True)\r\n            stop_run_containers(outname)\r\n            return \"timeout\", None, time.time() - t0\r\n    return (\"ok\" if rc == 0 else f\"exit={rc}\"), rc, time.time() - t0\r\n\r\n\r\ndef executed_source_sha(outdir):\r\n    \"\"\"sha256 of the source LEAN actually executed (its own copy in code/).\"\"\"\r\n    cm = Path(outdir) / \"code\" / \"main.py\"\r\n    if not cm.exists():\r\n        return None\r\n    return sha(cm.read_text(encoding=\"utf-8\"))\r\n\r\n\r\ndef logged_nonce(outdir):\r\n    \"\"\"The RUN-NONCE the algorithm logged from INSIDE the container — the\r\n    definitive witness of which source the engine executed.\"\"\"\r\n    logp = Path(outdir) / \"log.txt\"\r\n    if not logp.exists():\r\n        return None\r\n    for line in logp.read_text(encoding=\"utf-8\", errors=\"replace\").splitlines():\r\n        if \"RUN-NONCE \" in line:\r\n            return line.split(\"RUN-NONCE \", 1)[1].strip()\r\n    return None\r\n\r\n\r\ndef completion(outdir):\r\n    \"\"\"(complete: bool, runtime_error: str|None). Complete = result JSON\r\n    exists AND the log records LEAN exiting.\"\"\"\r\n    if not outdir.exists():\r\n        return False, None\r\n    res = list(outdir.glob(\"*-summary.json\")) or [p for p in outdir.glob(\"*.json\") if p.name[:-5].isdigit()]\r\n    logp = outdir / \"log.txt\"\r\n    exited = False\r\n    err = None\r\n    if logp.exists():\r\n        txt = logp.read_text(encoding=\"utf-8\", errors=\"replace\")\r\n        exited = \"Exiting Lean\" in txt\r\n        for line in txt.splitlines():\r\n            # \"Runtime Error\" catches mid-run failures; \"exception has occurred\"\r\n            # catches initialization/loader failures, which LEAN logs WITHOUT the\r\n            # \"Runtime Error\" marker (X2: 8/8 init-failed probe manifests carried\r\n            # runtime_error=None while their logs held the exception)\r\n            if \"Runtime Error\" in line or \"exception has occurred\" in line:\r\n                err = line[-300:]\r\n                break\r\n    return (bool(res) and exited), err\r\n\r\n\r\ndef raw_tape(outdir):\r\n    \"\"\"Ordered fill list; None if the run did not complete; [] if it\r\n    completed with zero orders (LEAN writes no order-events file then).\"\"\"\r\n    done, _ = completion(outdir)\r\n    if not done:\r\n        return None\r\n    oes = sorted(Path(outdir).glob(\"*order-events.json\"))\r\n    if not oes:\r\n        return []\r\n    evs = json.loads(oes[-1].read_text())\r\n    out = []\r\n    for e in evs:\r\n        if e.get(\"status\") not in (\"filled\", \"partiallyFilled\"):\r\n            continue\r\n        # exact ticker identity: LEAN symbol strings are \"SPY R735QTJ8XC9X\"\r\n        # (ticker + security id); match the ticker token exactly (sol-1 R1 #30)\r\n        sym = str(e.get(\"symbol\", \"\")).split(\" \")[0]\r\n        out.append({\"time\": float(e[\"time\"]), \"symbol\": sym, \"qty\": int(e[\"quantity\"]),\r\n                    \"fill_qty\": int(e.get(\"fillQuantity\", e[\"quantity\"])),\r\n                    \"price\": str(e.get(\"fillPrice\", \"\")), \"order_id\": int(e.get(\"orderId\", 0)),\r\n                    \"status\": e.get(\"status\")})\r\n    out.sort(key=lambda x: (x[\"time\"], x[\"order_id\"]))\r\n    return out\r\n\r\n\r\ndef et_date(epoch):\r\n    # fills occur 09:30-16:00 ET; UTC-5 maps both DST cases to the ET date\r\n    return (dt.datetime.utcfromtimestamp(epoch) - dt.timedelta(hours=5)).date().isoformat()\r\n\r\n\r\ndef project(tape, kind):\r\n    \"\"\"Per-blank projection (SS4.1). Dates = ET calendar dates; quantities are\r\n    the FILLED quantity (a partially filled order must project what actually\r\n    traded, not what was requested — terra-2 R2; zero partial fills exist in\r\n    the v2 bank, so this is a latent-path fix that changes no bank tape).\"\"\"\r\n    if tape is None:\r\n        return None\r\n    d = lambda e: et_date(e[\"time\"])\r\n    q = lambda e: int(e.get(\"fill_qty\", e[\"qty\"]))\r\n    side = lambda e: \"B\" if q(e) > 0 else \"S\"\r\n    if kind == \"full\":\r\n        return \";\".join(f\"{d(e)}|{e['symbol']}|{side(e)}|{abs(q(e))}\" for e in tape)\r\n    if kind == \"dates_all\":\r\n        return \";\".join(f\"{d(e)}|{e['symbol']}|{side(e)}\" for e in tape)\r\n    if kind == \"A_entries_exits\":\r\n        return \";\".join(f\"{d(e)}|{side(e)}\" for e in tape if e[\"symbol\"] == \"SPY\")\r\n    if kind == \"A_full\":\r\n        return \";\".join(f\"{d(e)}|{side(e)}|{abs(q(e))}\" for e in tape if e[\"symbol\"] == \"SPY\")\r\n    if kind == \"A_sell_ratio\":\r\n        held = 0; out = []\r\n        for e in tape:\r\n            if e[\"symbol\"] != \"SPY\":\r\n                continue\r\n            if q(e) > 0:\r\n                held += q(e); out.append(f\"{d(e)}|B\")\r\n            else:\r\n                sold = -q(e); r = round(sold / held, 2) if held > 0 else 0.0\r\n                out.append(f\"{d(e)}|S|{r:.2f}\"); held = max(held - sold, 0)\r\n        return \";\".join(out)\r\n    if kind == \"B_entries\":\r\n        return \";\".join(d(e) for e in tape if e[\"symbol\"] == \"AAPL\" and q(e) > 0)\r\n    if kind == \"B_exits\":\r\n        return \";\".join(d(e) for e in tape if e[\"symbol\"] == \"AAPL\" and q(e) < 0)\r\n    if kind == \"B_full\":\r\n        return \";\".join(f\"{d(e)}|{side(e)}|{abs(q(e))}\" for e in tape if e[\"symbol\"] == \"AAPL\")\r\n    raise ValueError(kind)\r\n\r\n\r\ndef all_projections(tape):\r\n    return {k: project(tape, k) for k in PROJECTIONS}\r\n\r\n# ---------------------------------------------------------------- jobs\r\n\r\ndef job_list():\r\n    jobs = []\r\n    for bank in BLANKS:\r\n        if bank in CUT or BLANKS[bank].get(\"alias_of\"):\r\n            continue\r\n        for res, params, kind, tag in grid_for(bank):\r\n            jobs.append({\"bank\": bank, \"res\": res, \"params\": params, \"kind\": kind, \"tag\": tag,\r\n                         \"name\": run_name(bank, res, tag)})\r\n    # de-duplicate by NAME and by PARAMS: when a bank excludes exactly one\r\n    # DOF, its all-off \"SPOT\" cell is the same experiment as that DOF's OAT\r\n    # cell (identical params, identical tape) — two names for one run made\r\n    # the params-keyed migration cross them (caught by the sha witness).\r\n    seen_names, seen_params, out = set(), set(), []\r\n    for j in jobs:\r\n        pkey = (j[\"bank\"], j[\"res\"], json.dumps(j[\"params\"], sort_keys=True))\r\n        if j[\"name\"] in seen_names or pkey in seen_params:\r\n            continue\r\n        seen_names.add(j[\"name\"]); seen_params.add(pkey); out.append(j)\r\n    return out\r\n\r\n\r\ndef manifest_path(name):\r\n    return BANK_DIR / f\"{name}.json\"\r\n\r\n\r\ndef load_manifest(name):\r\n    p = manifest_path(name)\r\n    if p.exists():\r\n        try:\r\n            return json.loads(p.read_text(encoding=\"utf-8\"))\r\n        except Exception:\r\n            return None\r\n    return None\r\n\r\n\r\ndef run_job(job, worker, ident, data_hash):\r\n    \"\"\"Executed in a worker process. Resumable: a manifest whose source sha\r\n    matches and which is complete is reused; anything else is re-run.\"\"\"\r\n    params = dict(job[\"params\"]); params[\"_nonce\"] = job[\"name\"]\r\n    src = build_source(params)\r\n    ssha = sha(src)\r\n    core_sha = sha(build_source(job[\"params\"]))   # nonce-free: survives renames\r\n    m = load_manifest(job[\"name\"])\r\n    outdir = BT / job[\"name\"]\r\n    if m and m.get(\"complete\") and m.get(\"data_hash\") == data_hash             and (m.get(\"source_sha\") == ssha or m.get(\"core_sha\") == core_sha)             and m.get(\"source_verified\", executed_source_sha(outdir) == m.get(\"source_sha\")):\r\n        return job[\"name\"], \"cached\"\r\n    if outdir.exists():\r\n        shutil.rmtree(outdir, ignore_errors=True)\r\n    proj = worker_project(worker)\r\n    status, rc, secs = engine_exec(proj, src, job[\"name\"])\r\n    done, err = completion(outdir)\r\n    exec_sha = executed_source_sha(outdir)\r\n    nonce_ok = logged_nonce(outdir) == job[\"name\"]\r\n    src_ok = (exec_sha == ssha) and nonce_ok\r\n    if done and not src_ok:\r\n        done = False; status = \"source-mismatch\"   # never trust a tape from another job's source\r\n    tape = raw_tape(outdir) if done else None\r\n    rec = {\r\n        \"name\": job[\"name\"], \"bank\": job[\"bank\"], \"resolution\": job[\"res\"], \"kind\": job[\"kind\"], \"tag\": job[\"tag\"],\r\n        \"params\": params, \"source_sha\": ssha, \"core_sha\": core_sha, \"executed_source_sha\": exec_sha, \"logged_nonce\": logged_nonce(outdir), \"source_verified\": src_ok,\r\n        \"status\": status, \"exit_code\": rc, \"complete\": done,\r\n        \"runtime_error\": err, \"secs\": round(secs, 1), \"worker\": worker,\r\n        \"data_hash\": data_hash, \"engine\": ident, \"ran_at\": dt.datetime.now().isoformat(),\r\n        \"fills\": (len(tape) if tape is not None else None),\r\n        \"tape\": tape, \"projections\": all_projections(tape) if tape is not None else None,\r\n    }\r\n    manifest_path(job[\"name\"]).write_text(json.dumps(rec), encoding=\"utf-8\")\r\n    return job[\"name\"], f\"{status} fills={rec['fills']} ({rec['secs']}s)\"\r\n\r\n\r\ndef build(workers):\r\n    fr = verify_freeze(strict=True)\r\n    ident = fr[\"engine\"]\r\n    data_hash = fr[\"all_aggregate\"]\r\n    jobs = job_list()\r\n    print(f\"freeze OK t1={fr['t1_aggregate'][:12]} all={data_hash[:12]} engine={ident}\", flush=True)\r\n    print(f\"jobs={len(jobs)} workers={workers}\", flush=True)\r\n    done = 0\r\n    with ProcessPoolExecutor(max_workers=workers) as ex:\r\n        futs = {ex.submit(run_job, j, i % workers, ident, data_hash): j for i, j in enumerate(jobs)}\r\n        for f in as_completed(futs):\r\n            name, msg = f.result()\r\n            done += 1\r\n            print(f\"[{done}/{len(jobs)}] {name}: {msg}\", flush=True)\r\n    print(\"BUILD DONE\", flush=True)\r\n\r\n# ---------------------------------------------------------------- report\r\n\r\ndef load_bank(current_only=True):\r\n    \"\"\"Manifests for the CURRENT job list only. A spec change (e.g. widening\r\n    a bank's conditioning) orphans old manifests; letting them into the gate\r\n    would evaluate invariance against runs the spec no longer defines.\"\"\"\r\n    valid = {j[\"name\"] for j in job_list()} if current_only else None\r\n    recs = {}\r\n    for p in BANK_DIR.glob(\"BANK2_*.json\"):\r\n        try:\r\n            r = json.loads(p.read_text(encoding=\"utf-8\"))\r\n        except Exception:\r\n            continue\r\n        if valid is not None and r[\"name\"] not in valid:\r\n            continue\r\n        recs[r[\"name\"]] = r\r\n    return recs\r\n\r\n\r\ndef report():\r\n    recs = load_bank()\r\n    missing = [j[\"name\"] for j in job_list() if j[\"name\"] not in recs or not recs[j[\"name\"]][\"complete\"]]\r\n    if missing:\r\n        print(f\"GATE INCOMPLETE: {len(missing)} of {len(job_list())} registered runs missing/incomplete — e.g. {missing[:3]}\")\r\n    out = {\"generated\": dt.datetime.now().isoformat(), \"runs\": len(recs), \"banks\": {}}\r\n    for bank, spec in BLANKS.items():\r\n        if bank in CUT or spec.get(\"alias_of\"):\r\n            continue\r\n        cond = spec[\"conditioning\"]\r\n        pk = spec[\"projection\"]\r\n        rows = [r for r in recs.values() if r[\"bank\"] == bank]\r\n        grid = [r for r in rows if r[\"kind\"] == \"grid\"]\r\n        expected = sum(1 for j in job_list() if j[\"bank\"] == bank)   # deduped list, same source as the build\r\n        incomplete = [r[\"name\"] for r in rows if not r[\"complete\"]]\r\n        # per conditioning tuple: projection -> resolutions\r\n        by_tuple = {}\r\n        for r in grid:\r\n            if not r[\"complete\"]:\r\n                continue\r\n            key = tuple(sorted((d, r[\"params\"][d]) for d in cond)) + ((\"wb\", r[\"params\"].get(\"dof_warmup_bars\")),)\r\n            key = tuple(sorted((d, r[\"params\"][d]) for d in cond))\r\n            by_tuple.setdefault(key, {}).setdefault(r[\"projections\"][pk], set()).add(r[\"resolution\"])\r\n        floors, collapses, classes_seen = [], {}, set()\r\n        for key, m in by_tuple.items():\r\n            nondeg = {p: rs for p, rs in m.items() if p != \"\"}\r\n            floors.append(len(nondeg))\r\n            for p, rs in nondeg.items():\r\n                if len(rs) > 1:\r\n                    collapses.setdefault(\"+\".join(sorted(rs)), 0)\r\n                    collapses[\"+\".join(sorted(rs))] += 1\r\n                classes_seen.add(class_name(bank, rs))\r\n        # OAT invariance: excluded DOFs must not move the projection vs reference\r\n        oat_fail = []\r\n        ref = {r[\"resolution\"]: r[\"projections\"][pk] for r in grid if r[\"tag\"] == \"ref\" and r[\"complete\"]}\r\n        for r in rows:\r\n            if r[\"kind\"] in (\"oat\", \"spot\") and r[\"complete\"]:\r\n                if r[\"projections\"][pk] != ref.get(r[\"resolution\"]):\r\n                    oat_fail.append((r[\"resolution\"], r[\"tag\"]))\r\n        gate = \"PASS\" if (rows and not incomplete and floors and min(floors) >= 2\r\n                          and len(rows) == expected) else (\"INCOMPLETE\" if len(rows) != expected else \"FAIL\")\r\n        if len(spec[\"resolutions\"]) == 1:\r\n            gate = \"N/A\"\r\n        out[\"banks\"][bank] = {\r\n            \"resolutions\": len(spec[\"resolutions\"]), \"runs\": len(rows), \"expected_runs\": expected,\r\n            \"incomplete\": incomplete, \"tuples\": len(by_tuple), \"min_classes\": (min(floors) if floors else None),\r\n            \"non_discriminating_tuples\": sum(1 for f in floors if f < 2),\r\n            \"collapses\": collapses, \"class_labels\": sorted(classes_seen),\r\n            \"oat_invariance_failures\": oat_fail, \"gate\": gate,\r\n        }\r\n        print(f\"{bank}: runs {len(rows)}/{expected} incomplete={len(incomplete)} tuples={len(by_tuple)} \"\r\n              f\"min_classes={out['banks'][bank]['min_classes']} nondisc={out['banks'][bank]['non_discriminating_tuples']} \"\r\n              f\"oat_fail={len(oat_fail)} classes={sorted(classes_seen)} -> {gate}\")\r\n    (HERE / \"gate_report_v2.json\").write_text(json.dumps(out, indent=1), encoding=\"utf-8\")\r\n    return out\r\n\r\n\r\ndef main():\r\n    ap = argparse.ArgumentParser()\r\n    ap.add_argument(\"--plan\", action=\"store_true\")\r\n    ap.add_argument(\"--build\", action=\"store_true\")\r\n    ap.add_argument(\"--workers\", type=int, default=4)\r\n    ap.add_argument(\"--report\", action=\"store_true\")\r\n    ap.add_argument(\"--verify-freeze\", action=\"store_true\")\r\n    a = ap.parse_args()\r\n    if a.plan:\r\n        jobs = job_list(); print(\"jobs\", len(jobs))\r\n        from collections import Counter\r\n        print(Counter(j[\"bank\"] for j in jobs))\r\n        return\r\n    if a.verify_freeze:\r\n        print(json.dumps(verify_freeze(strict=False), indent=1)[:1200]); return\r\n    if a.build:\r\n        build(a.workers); return\r\n    if a.report:\r\n        report(); return\r\n    ap.print_help()\r\n\r\n\r\nif __name__ == \"__main__\":\r\n    main()\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/bank/bank_runner.py",
      "sha256": "3bf1120fd7166f8f49630093ddca8acbe6c82a92f112d2b82b012596a6b1ca89"
    },
    {
      "id": "lb-instrument-label-check",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "label_check.py — Ground-truth label check: does the real coder give each bank run the label",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Oracle bank"
      ],
      "text": "\"\"\"Ground-truth label check: does the real coder give each bank run the label\nof the reading it was BUILT from?\n\nEvery bank run's correct answer is known by construction, so this needs no\nmodels and no engine. Each run's own tape is pushed through the REAL coding\npath (grade.code_generation) with an empty program text — no program-side\nevidence, the conservative case — and the emitted code is compared against\nthe label of the run's own resolution.\n\nOutcomes: CORRECT (coded as built) · AMBIGUOUS (refused: the tape genuinely\nmatches several readings and nothing resolves it — an honest, counted loss)\n· WRONG (coded as a DIFFERENT reading — the outcome that corrupts results;\nthe pre-fix coder produced 241 of these, biased into the donor's readings).\n\nThe registered assertion is WRONG == 0. Exit 1 otherwise.\n\nUsage: python label_check.py\n\"\"\"\nimport json\nimport sys\nfrom collections import defaultdict\nfrom pathlib import Path\n\nR = Path(__file__).resolve().parent.parent\nsys.path.insert(0, str(R / \"bank\")); sys.path.insert(0, str(R / \"harness\")); sys.path.insert(0, str(R / \"codebook\"))\nfrom bank_runner import load_bank                       # noqa: E402\nfrom bank_spec import BLANKS, CLASSES, class_name        # noqa: E402\nimport grade as G                                        # noqa: E402\n\n\ndef main():\n    recs = load_bank(current_only=True)\n    store = G.Bank(recs)\n    per = defaultdict(lambda: {\"n\": 0, \"correct\": 0, \"ambiguous\": 0, \"wrong\": 0})\n    wrong_rows = []\n    for r in recs.values():\n        if not r[\"complete\"] or r[\"projections\"] is None or r[\"bank\"] not in CLASSES:\n            continue\n        rec = G.code_generation(store, r[\"bank\"], \"\", r[\"tape\"], \"ok\")\n        got = rec.get(\"code\")\n        want = class_name(r[\"bank\"], {r[\"resolution\"]})\n        s = per[r[\"bank\"]]; s[\"n\"] += 1\n        if isinstance(got, str) and got.startswith(\"AMBIGUOUS\"):\n            s[\"ambiguous\"] += 1\n        elif got == want:\n            s[\"correct\"] += 1\n        else:\n            s[\"wrong\"] += 1\n            wrong_rows.append({\"name\": r[\"name\"], \"built\": r[\"resolution\"], \"want\": want, \"got\": got})\n    tot = {k: sum(v[k] for v in per.values()) for k in (\"n\", \"correct\", \"ambiguous\", \"wrong\")}\n    print(f\"LABEL CHECK (real coder path): {tot['n']} class-coded runs — \"\n          f\"correct {tot['correct']} ({tot['correct']/tot['n']:.1%}), \"\n          f\"ambiguous {tot['ambiguous']} ({tot['ambiguous']/tot['n']:.1%}), \"\n          f\"WRONG {tot['wrong']}\")\n    for b in sorted(per):\n        v = per[b]\n        print(f\"  {b:8} correct {v['correct']:4}  ambiguous {v['ambiguous']:4}  wrong {v['wrong']:4}\")\n    if wrong_rows:\n        print(\"WRONG ROWS (first 10):\")\n        for w in wrong_rows[:10]:\n            print(f\"  {w['name']}: built={w['built']} want={w['want']} got={w['got']}\")\n    (Path(__file__).resolve().parent / \"label_check_report.json\").write_text(\n        json.dumps({\"totals\": tot, \"per_bank\": {k: dict(v) for k, v in per.items()},\n                    \"wrong_rows\": wrong_rows[:100]}, indent=1), encoding=\"utf-8\")\n    return 1 if tot[\"wrong\"] else 0\n\n\nif __name__ == \"__main__\":\n    sys.exit(main())\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/bank/label_check.py",
      "sha256": "56affb65b0143cc799206fc5655ec529fce3067a718a8dddae1e2ea92489477d"
    },
    {
      "id": "lb-instrument-verify-bank",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "verify_bank.py — Bank integrity verifier — the canonical, committed check (council R2:",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Oracle bank"
      ],
      "text": "\"\"\"Bank integrity verifier — the canonical, committed check (council R2:\nsonnet-1 #2 showed the earlier claim was stated in terms of run NAMES, which\nrenames break; the chain that actually matters is about SOURCE and PARAMS).\n\nFor every job in the current (deduped) job list, assert ALL of:\n  1. a manifest exists and is complete;\n  2. sha256(LEAN's own code/main.py copy of the executed program)\n     == manifest.source_sha            [the manifest describes the executed source]\n  3. the NONCE the algorithm logged from inside the container\n     == the _nonce embedded in that executed source\n                                        [the log came from that source]\n  4. manifest params (minus _nonce) == the job's params\n                                        [it is THIS experiment]\nNames are bookkeeping and may change across spec renames; 2+3+4 are what the\nscientific claim rests on. Exits non-zero on any failure.\n\"\"\"\nimport json\nimport re\nimport sys\nfrom pathlib import Path\n\nHERE = Path(__file__).resolve().parent\nsys.path.insert(0, str(HERE))\nfrom bank_runner import job_list, BT, sha, BANK_DIR  # noqa: E402\n\n\ndef verify(verbose=False):\n    jobs = {j[\"name\"]: j for j in job_list()}\n    ok = 0\n    fails = []\n    for name, j in jobs.items():\n        mp = BANK_DIR / f\"{name}.json\"\n        if not mp.exists():\n            fails.append((name, \"no-manifest\")); continue\n        r = json.loads(mp.read_text(encoding=\"utf-8\"))\n        if not r.get(\"complete\"):\n            fails.append((name, f\"incomplete:{r.get('status')}\")); continue\n        cm = BT / name / \"code\" / \"main.py\"\n        if not cm.exists():\n            fails.append((name, \"no-executed-source-copy\")); continue\n        src = cm.read_text(encoding=\"utf-8\")\n        if sha(src) != r[\"source_sha\"]:\n            fails.append((name, \"source-sha-mismatch\")); continue\n        m = re.search(r'\"_nonce\":\\s*\"([^\"]+)\"', src)\n        if not m or r.get(\"logged_nonce\") != m.group(1):\n            fails.append((name, \"nonce-mismatch\")); continue\n        params = {k: v for k, v in r[\"params\"].items() if k != \"_nonce\"}\n        if params != j[\"params\"]:\n            fails.append((name, \"params-mismatch\")); continue\n        ok += 1\n    print(f\"BANK INTEGRITY: {ok}/{len(jobs)} verified \"\n          f\"(source copy == manifest, in-container nonce == that source's nonce, params == job)\")\n    for f in fails[:20]:\n        print(\"  FAIL\", f)\n    return 0 if not fails else 1\n\n\nif __name__ == \"__main__\":\n    sys.exit(verify(\"-v\" in sys.argv))\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/bank/verify_bank.py",
      "sha256": "4d81da5ef937b4533acd271875bd18824375625f2ea688a47b9aeb4a282b496d"
    },
    {
      "id": "lb-instrument-gen-variants-v5",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "gen_variants_v5.py — Generate the frozen v5 variants per PIN-v5-2026-08-15 SS3.1/3.2.",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Variant generator"
      ],
      "text": "\"\"\"Generate the frozen v5 variants per PIN-v5-2026-08-15 SS3.1/3.2.\r\n16 T1v0-derived variants + ER-01 (second donor) + OM-A/B/C.\r\nByte-exact spans; asserts occurrence counts, no orphan list markers,\r\nno dangling punctuation, defined-term bindings; emits\r\nrung2/variants-v5.json with SHA-256 per variant.\r\n\"\"\"\r\nimport hashlib\r\nimport json\r\nimport sys\r\nfrom pathlib import Path\r\n\r\nOUT = Path(r\"\x43:\\Users\\redacted-profile\\Desktop\\LEAN-Bench-Research\\rung2\")\r\nDONOR_SHA = \"6cf7509fb7fc6fb8de608b447be313017a6e0a26c352db3c9636effbcb77f8d5\"\r\n# The COMMITTED donor (not the mutable prompt package behind a junction);\r\n# a moved or altered donor fails loudly instead of silently re-freezing.\r\nBASE = (OUT / \"T1v0.txt\").read_text(encoding=\"utf-8\")\r\nassert hashlib.sha256(BASE.encode(\"utf-8\")).hexdigest() == DONOR_SHA, \"donor T1v0.txt hash != registered\"\r\n\r\nSMA = \"its 100-day simple moving average\"\r\nCROSS_BULLET = '- \"X crosses above Y\" means: yesterday X was less than or equal to Y, and today X is greater than Y (both evaluated with that day\\'s values). \"Crosses below\" is the mirror image. A level being above/below is NOT a cross.\\n'\r\nBUY_LINE = \"Reason to buy: SPY's close crosses above its 100-day simple moving average.\"\r\nSELL_LINE = \"Reason to sell: SPY's close crosses below its 100-day simple moving average.\"\r\nRED_DEF = 'A \"red day\" for a ticker means its close is strictly below the PREVIOUS day\\'s close. A \"green day\" means strictly above. '\r\nB06_BODY_OLD = \"buy $20,000 of AAPL if at least $20,000 cash is available, otherwise do nothing.\"\r\nB06_BODY_NEW = \"buy $20,000 of AAPL if available.\"\r\nB06_CON_OLD = \"shares; otherwise do NOTHING this bar (the strategy stays flat; the reason may fire again on a later bar).\"\r\nB06_CON_NEW = \"shares.\"\r\nSELL_HALF = 'Sell detail \"sell half\" means sell half of the lot\\'s current shares rounded down (sell the last share when only one remains). '\r\nMISSING_BAR = \" If today's bar is missing for ANY subscribed ticker, skip ALL rule evaluation for that day (do not crash on missing data).\"\r\nLOTS_BULLET = \"- Each strategy manages its own private lot of shares in its trade ticker: it sells only shares it bought, and its buy reason is evaluated only while its lot is empty; its sell reason only while its lot is non-empty. On any bar, evaluate sells before buys.\\n\"\r\nSLOTS_DECL_OLD = \"One template with 2 slots, no gate. Both slots run independently in parallel.\"\r\nSLOTS_DECL_NEW = \"One template with 2 slots, no gate.\"\r\n\r\n# (id, role, description, [(old, new, expected_count)])\r\nVARIANTS = [\r\n    # AMENDMENT 2026-08-16 (council R1: terra-2 #25, sol-1 #33): \"over the past\r\n    # 100 days\" could be read as excluding today / calendar days, so it was not\r\n    # a PURE reorder; the placebo now uses the strict syntactic reorder.\r\n    (\"BL-00\", \"placebo\", \"paraphrase placebo: strict reorder of the modifiers, no content word added (amended 2026-08-16)\",\r\n     [(SMA, \"its simple 100-day moving average\", 2)]),\r\n    (\"BL-02a\", \"control\", \"contract-semantics control: delete cross bullet only\",\r\n     [(CROSS_BULLET, \"\", 1)]),\r\n    (\"BL-01a\", \"anchor\", \"type blanked (ANCHOR)\",\r\n     [(SMA, \"its 100-day moving average\", 2)]),\r\n    (\"BL-01b\", \"eligible\", \"period blanked\",\r\n     [(SMA, \"its simple moving average\", 2)]),\r\n    (\"BL-01c\", \"eligible\", \"type AND period blanked\",\r\n     [(SMA, \"its moving average\", 2)]),\r\n    (\"BL-02b'\", \"placebo\", \"FORM-CHANGE PLACEBO: full-information noun-event frame + cross bullet deleted\",\r\n     [(BUY_LINE, \"Reason to buy: an upward cross of SPY's close through its 100-day simple moving average.\", 1),\r\n      (SELL_LINE, \"Reason to sell: a downward cross of SPY's close through its 100-day simple moving average.\", 1),\r\n      (CROSS_BULLET, \"\", 1)]),\r\n    (\"BL-02b\", \"eligible\", \"operands dropped, direction kept + cross bullet deleted\",\r\n     [(BUY_LINE, \"Reason to buy: an upward 100-day simple-moving-average cross on SPY.\", 1),\r\n      (SELL_LINE, \"Reason to sell: a downward 100-day simple-moving-average cross on SPY.\", 1),\r\n      (CROSS_BULLET, \"\", 1)]),\r\n    (\"BL-02c\", \"eligible\", \"directionless: both reason clauses identical + cross bullet deleted\",\r\n     [(BUY_LINE, \"Reason to buy: a 100-day simple-moving-average cross on SPY.\", 1),\r\n      (SELL_LINE, \"Reason to sell: a 100-day simple-moving-average cross on SPY.\", 1),\r\n      (CROSS_BULLET, \"\", 1)]),\r\n    (\"BL-03\", \"eligible\", \"A size 40% -> unspecified percentage\",\r\n     [(\"invest 40% of total portfolio value in SPY\", \"invest a percentage of total portfolio value in SPY\", 1)]),\r\n    (\"BL-04\", \"eligible\", \"red/green definition deleted (counting sentence stays)\",\r\n     [(RED_DEF, \"\", 1)]),\r\n    (\"BL-05\", \"eligible\", \"'3 consecutive days' -> 'a number of consecutive days'\",\r\n     [(\"has been red for 3 consecutive days\", \"has been red for a number of consecutive days\", 1)]),\r\n    (\"BL-06\", \"eligible\", \"shortfall outcome blanked (two-span coupled edit; '$C if available' key stays bound)\",\r\n     [(B06_BODY_OLD, B06_BODY_NEW, 1),\r\n      (B06_CON_OLD, B06_CON_NEW, 1)]),\r\n    (\"BL-07\", \"anchor\", \"RSI period blanked (ANCHOR)\",\r\n     [(\"AAPL's 14-day RSI closes above 60\", \"AAPL's RSI closes above 60\", 1)]),\r\n    (\"BL-08\", \"eligible\", \"RSI threshold blanked\",\r\n     [(\"AAPL's 14-day RSI closes above 60\", \"AAPL's 14-day RSI closes above a threshold\", 1)]),\r\n    (\"BL-09a\", \"eligible\", \"A sell details -> 'sell.' (contract untouched)\",\r\n     [(\"Sell details: liquidate Strategy A's entire lot.\", \"Sell details: sell.\", 1)]),\r\n    (\"BL-09b\", \"eligible\", \"same body change + 'sell half' sentence deleted ('closed' sentence stays)\",\r\n     [(\"Sell details: liquidate Strategy A's entire lot.\", \"Sell details: sell.\", 1),\r\n      (SELL_HALF, \"\", 1)]),\r\n    (\"OM-A\", \"secondary\", \"missing-bar skip rule deleted (contract)\",\r\n     [(MISSING_BAR, \"\", 1)]),\r\n    (\"OM-B\", \"secondary\", \"private-lots / sells-before-buys bullet deleted\",\r\n     [(LOTS_BULLET, \"\", 1)]),\r\n    (\"OM-C\", \"secondary\", \"slot-independence declaration removed\",\r\n     [(SLOTS_DECL_OLD, SLOTS_DECL_NEW, 1)]),\r\n    (\"ER-01\", \"eligible-second-donor\", \"referent-ambiguity probe: A buys on 200-day cross up, sells 'when the SMA(50) crosses'\",\r\n     [(BUY_LINE, \"Reason to buy: SPY's close crosses above its 200-day simple moving average.\", 1),\r\n      (SELL_LINE, \"Reason to sell: when the SMA(50) crosses.\", 1)]),\r\n    # ER-01c: the owner-funded pinned control (2026-08-15) — a DERIVED edit\r\n    # whose base is ER-01's text (5th tuple field), sell rule pinned to R1\r\n    (\"ER-01c\", \"control-second-donor\", \"ER-01 pinned control: sell rule pinned to R1 (close crosses below SMA(50))\",\r\n     [(\"Reason to sell: when the SMA(50) crosses.\", \"Reason to sell: SPY's close crosses below its 50-day simple moving average.\", 1)],\r\n     \"ER-01\"),\r\n]\r\n\r\n\r\ndef sha(s):\r\n    return hashlib.sha256(s.encode(\"utf-8\")).hexdigest()\r\n\r\n\r\ndef structural_asserts(vid, text):\r\n    errs = []\r\n    for i, line in enumerate(text.split(\"\\n\"), 1):\r\n        if line.strip() in (\"-\", \"- \"):\r\n            errs.append(f\"line {i}: orphan list marker\")\r\n        if line.rstrip().endswith((\";\", \",\")):\r\n            errs.append(f\"line {i}: dangling punctuation: {line.strip()[-40:]!r}\")\r\n    # defined-term bindings that must survive every variant that keeps the term\r\n    if vid == \"BL-06\":\r\n        if '\"buy $C if available\"' not in text or \"if available.\" not in text:\r\n            errs.append(\"BL-06: '$C if available' key not bound body<->contract\")\r\n    if vid == \"BL-09b\":\r\n        if 'A lot is \"closed\" when it reaches zero shares.' not in text:\r\n            errs.append(\"BL-09b: 'closed' sentence must stay\")\r\n        if \"sell half\" in text:\r\n            errs.append(\"BL-09b: 'sell half' sentence not fully deleted\")\r\n    if vid == \"BL-04\":\r\n        if '\"Red for n consecutive days\" is satisfied' not in text:\r\n            errs.append(\"BL-04: counting sentence must stay\")\r\n    if vid == \"ER-01\":\r\n        if CROSS_BULLET not in text:\r\n            errs.append(\"ER-01: cross-definition clause must be KEPT\")\r\n    return errs\r\n\r\n\r\nOUT.mkdir(parents=True, exist_ok=True)\r\nrecords = []\r\ntexts = {}\r\nok = True\r\nfor item in VARIANTS:\r\n    vid, role, desc, edits = item[:4]\r\n    parent = item[4] if len(item) > 4 else None     # derived variants edit a PARENT's text\r\n    text = texts[parent] if parent else BASE\r\n    for old, new, expected in edits:\r\n        found = text.count(old)\r\n        if found != expected:\r\n            print(f\"FAIL {vid}: span occurs {found}x, expected {expected}: {old[:70]!r}\")\r\n            ok = False\r\n            continue\r\n        text = text.replace(old, new)\r\n    errs = structural_asserts(vid, text)\r\n    for e in errs:\r\n        print(f\"FAIL {vid}: {e}\")\r\n        ok = False\r\n    texts[vid] = text\r\n    records.append({\r\n        \"id\": vid,\r\n        \"role\": role,\r\n        \"description\": desc,\r\n        \"edits\": [{\"old\": o, \"new\": n, \"count\": c} for o, n, c in edits],\r\n        \"base\": parent or \"T1v0\",\r\n        \"prompt\": text,\r\n        \"sha256\": sha(text),\r\n        \"chars_delta\": len(text) - len(BASE),\r\n    })\r\n    if not errs:\r\n        print(f\"{vid}: OK  sha256={sha(text)[:16]}  delta={len(text)-len(BASE):+d}  base={parent or 'T1v0'}\")\r\n\r\nif not ok:\r\n    sys.exit(1)\r\n\r\n# cross-variant asserts\r\nby_id = {r[\"id\"]: r for r in records}\r\nassert by_id[\"BL-02c\"][\"prompt\"].count(\"a 100-day simple-moving-average cross on SPY.\") == 2, \"02c clauses not identical\"\r\nshas = [r[\"sha256\"] for r in records]\r\nassert len(set(shas)) == len(shas), \"duplicate variant text\"\r\neligible = [r[\"id\"] for r in records if r[\"role\"].startswith(\"eligible\")]\r\nassert len(eligible) == 12, f\"eligible set != 12: {eligible}\"\r\nassert by_id[\"ER-01c\"][\"sha256\"] == \"ab9d7e0391d81213ab24e4dc727a615909b21cda7a4a163a6d575d9f68658bc6\", \"ER-01c sha drift\"\r\n\r\n# refuse to write if the existing frozen file holds ids this run would drop\r\n_prev = OUT / \"variants-v5.json\"\r\nif _prev.exists():\r\n    _old = json.loads(_prev.read_text(encoding=\"utf-8\"))[\"variants\"]\r\n    _dropped = {x[\"id\"] for x in _old} - {r[\"id\"] for r in records}\r\n    if _dropped:\r\n        print(f\"REFUSING TO WRITE: would drop frozen ids {sorted(_dropped)}\")\r\n        sys.exit(2)\r\n    AMENDED = {\"BL-00\": \"2026-08-16 council R1 (terra-2 #25, sol-1 #33): strict reorder\"}\r\n    _changed = [x[\"id\"] for x in _old if by_id.get(x[\"id\"], {}).get(\"sha256\") != x[\"sha256\"] and x[\"id\"] not in AMENDED]\r\n    if _changed:\r\n        print(f\"REFUSING TO WRITE: frozen prompt text would change for {_changed} (a dated amendment is required)\")\r\n        sys.exit(3)\r\n\r\n(OUT / \"variants-v5.json\").write_text(json.dumps({\r\n    \"generated\": \"2026-08-15\",\r\n    \"pin\": \"PIN-v5-2026-08-15\",\r\n    \"donor\": \"T1v0\",\r\n    \"donor_sha256\": sha(BASE),\r\n    \"count\": len(records),\r\n    \"eligible_provisional\": eligible,\r\n    \"variants\": records,\r\n}, indent=2), encoding=\"utf-8\")\r\nprint(f\"\\nwrote {OUT / 'variants-v5.json'}  donor sha256={sha(BASE)[:16]}  n={len(records)}  eligible={len(eligible)}\")\r\n",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/prompts/gen_variants_v5.py",
      "sha256": "96d8574679540abf113f710cabf702ad7c540101b7b5bc9d7c7dfb8e1363710e"
    },
    {
      "id": "lb-instrument-gen-variants-o1",
      "version": "1",
      "kind": "atom",
      "role": "instrument",
      "title": "gen_variants_o1.py — Generate sentence-atom variants for the LEAN-Bench options arm.\"\"\"",
      "labels": [
        "Instrument",
        "Python",
        "Matching code",
        "Variant generator"
      ],
      "text": "#!/usr/bin/env python3\n\"\"\"Generate sentence-atom variants for the LEAN-Bench options arm.\"\"\"\n\nimport hashlib\nimport json\nimport re\nfrom pathlib import Path\n\n\nDONOR = Path(__file__).with_name(\"O1v0.txt\")\nOUTPUT_DIR = Path(__file__).with_name(\"variants-o1\")\nMANIFEST = Path(__file__).with_name(\"variants-o1.json\")\nDONOR_SHA = \"8220c41350874a3818b5aec80b812b0fb2cbf527496369dbe8fb9899dc86bdd9\"\n\n\n# (id, role, description, [(old, new, expected_count)])\nVARIANTS = [\n    (\n        \"O1p1\",\n        \"placebo\",\n        \"Reorder two independent data-subscription specifications without changing content.\",\n        [\n            (\n                \"Use New York time and minute-resolution, raw-price SPY equity data. \"\n                \"Subscribe to SPY options at minute resolution and keep the option universe \"\n                \"broad enough to contain the contracts specified below.\",\n                \"Subscribe to SPY options at minute resolution and keep the option universe \"\n                \"broad enough to contain the contracts specified below. \"\n                \"Use New York time and minute-resolution, raw-price SPY equity data.\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1c1\",\n        \"control\",\n        \"Delete the DTE definition, whose calendar-date meaning is recoverable from the adjacent expiry rule.\",\n        [\n            (\n                \"Days to expiration means the difference between the contract expiration \"\n                \"date and the current algorithm date, measured in calendar dates rather \"\n                \"than trading sessions or 24-hour periods. \",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1a1\",\n        \"anchor\",\n        \"Blank the repeatedly recoverable underlying symbol.\",\n        [\n            (\n                \"Backtest SPY from April 1, 2023 through June 30, 2026 with $100,000 initial cash.\",\n                \"Backtest ____ from April 1, 2023 through June 30, 2026 with $100,000 initial cash.\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1a2\",\n        \"anchor\",\n        \"Blank the implementation language, recoverable from the requested file suffix and framework register.\",\n        [\n            (\n                \"Implement a complete QuantConnect LEAN algorithm in Python using the QCAlgorithm framework.\",\n                \"Implement a complete QuantConnect LEAN algorithm in ____ using the QCAlgorithm framework.\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e1\",\n        \"eligible\",\n        \"Delete the strike-selection convention.\",\n        [\n            (\n                \"Within that expiration, consider only call contracts and select the lowest \"\n                \"strike that is greater than or equal to 101% of the current SPY price. \",\n                \"Within that expiration, consider only call contracts. \",\n                1,\n            ),\n            (\n                \"Thus the selected call is the first listed strike at least 1% out of the money; \"\n                \"break an equal-strike tie by the ascending string value of the contract Symbol.\",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e2\",\n        \"eligible\",\n        \"Delete the expiry and minimum-DTE selection convention.\",\n        [\n            (\n                \"Choose the nearest expiration whose calendar date is at least 7 calendar \"\n                \"days after the current algorithm date. \",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e3\",\n        \"eligible\",\n        \"Delete the option-type convention and its redundant grammatical traces.\",\n        [\n            (\n                \"Trade one long SPY call at a time. The option type is call, never put.\",\n                \"Trade one long SPY option at a time.\",\n                1,\n            ),\n            (\n                \"Within that expiration, consider only call contracts and select the lowest strike\",\n                \"Within that expiration, select the lowest strike\",\n                1,\n            ),\n            (\n                \"Thus the selected call is the first listed strike\",\n                \"Thus the selected contract is the first listed strike\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e4\",\n        \"eligible\",\n        \"Delete the position-size convention.\",\n        [\n            (\n                \"Buy exactly 1 contract. \",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e5\",\n        \"eligible\",\n        \"Delete the numerical profit-target threshold.\",\n        [\n            (\n                \"A 50% profit target is reached when that midpoint is at least 1.50 times \"\n                \"the filled entry price. \",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e6\",\n        \"eligible\",\n        \"Delete the exercise-or-assignment equity-position handling convention.\",\n        [\n            (\n                \"If exercise or assignment processing nevertheless creates a SPY equity \"\n                \"position, liquidate the entire SPY equity position with a market order \"\n                \"immediately and do not treat it as a strategy entry.\",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e7\",\n        \"eligible\",\n        \"Delete the no-match handling convention.\",\n        [\n            (\n                \"If the current Slice has no option chain, no expiration satisfies the rule, \"\n                \"or no contract at the selected expiration satisfies the type and strike rules, \"\n                \"skip that entry signal without throwing an exception or falling back to \"\n                \"another contract. A skipped signal is not queued for later; wait for a new \"\n                \"bullish crossover.\\n\\n\",\n                \"\",\n                1,\n            ),\n        ],\n    ),\n    (\n        \"O1e8\",\n        \"eligible\",\n        \"Delete the slow-average lookback parameter.\",\n        [\n            (\n                \"The slow average is a 20-bar simple moving average of five-minute closing prices.\",\n                \"The slow average is a simple moving average of five-minute closing prices.\",\n                1,\n            ),\n        ],\n    ),\n]\n\n\ndef sha256_bytes(data):\n    return hashlib.sha256(data).hexdigest()\n\n\ndef apply_edits(donor, variant_id, edits):\n    result = donor\n    for edit_number, (old, new, expected_count) in enumerate(edits, start=1):\n        actual_count = result.count(old)\n        assert actual_count == expected_count, (\n            f\"{variant_id} edit {edit_number}: expected {expected_count} exact \"\n            f\"occurrence(s), found {actual_count}: {old!r}\"\n        )\n        result = result.replace(old, new)\n        assert result.count(old) == 0, (\n            f\"{variant_id} edit {edit_number}: old span survived replacement\"\n        )\n\n    assert result != donor, f\"{variant_id}: edits did not change donor\"\n    return result\n\n\ndef assert_surface_integrity(variant_id, text):\n    assert text.endswith(\"\\n\"), f\"{variant_id}: missing final newline\"\n    assert \"\\r\" not in text, f\"{variant_id}: CR byte introduced\"\n    assert \"\\t\" not in text, f\"{variant_id}: tab introduced\"\n    assert \"\\n\\n\\n\" not in text, f\"{variant_id}: triple blank line introduced\"\n    assert \"  \" not in text, f\"{variant_id}: doubled space introduced\"\n    assert not re.search(r\"(?m)^\\s*(?:[-*+]|\\d+[.)])\\s*$\", text), (\n        f\"{variant_id}: orphan list marker\"\n    )\n    assert not re.search(r\"[,;:]\\s*(?:\\n\\n|\\Z)\", text), (\n        f\"{variant_id}: dangling punctuation\"\n    )\n    assert not re.search(r\"(?m)^\\s*[.,;:!?]\", text), (\n        f\"{variant_id}: orphan or dangling leading punctuation\"\n    )\n\n\ndef main():\n    donor_bytes = DONOR.read_bytes()\n    actual_donor_sha = sha256_bytes(donor_bytes)\n    assert actual_donor_sha == DONOR_SHA, (\n        f\"donor SHA mismatch: expected {DONOR_SHA}, got {actual_donor_sha}\"\n    )\n    assert b\"\\r\" not in donor_bytes, \"donor must use LF line endings\"\n    assert donor_bytes.endswith(b\"\\n\"), \"donor must end with one LF\"\n\n    donor = donor_bytes.decode(\"utf-8\")\n    ids = [variant_id for variant_id, _, _, _ in VARIANTS]\n    assert len(ids) == len(set(ids)), \"duplicate variant id\"\n\n    roles = [role for _, role, _, _ in VARIANTS]\n    assert roles.count(\"placebo\") == 1, \"expected exactly one placebo\"\n    assert roles.count(\"control\") == 1, \"expected exactly one control\"\n    assert roles.count(\"anchor\") == 2, \"expected exactly two anchors\"\n    assert 6 <= roles.count(\"eligible\") <= 8, \"expected 6-8 eligible variants\"\n    assert set(roles) == {\"placebo\", \"control\", \"anchor\", \"eligible\"}, (\n        \"unexpected variant role\"\n    )\n\n    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)\n    manifest = {\n        \"donor\": DONOR.name,\n        \"donor_sha256\": actual_donor_sha,\n        \"variants\": [],\n    }\n\n    for variant_id, role, description, edits in VARIANTS:\n        variant = apply_edits(donor, variant_id, edits)\n        assert_surface_integrity(variant_id, variant)\n\n        variant_bytes = variant.encode(\"utf-8\")\n        output_path = OUTPUT_DIR / f\"{variant_id}.txt\"\n        output_path.write_bytes(variant_bytes)\n\n        manifest[\"variants\"].append(\n            {\n                \"id\": variant_id,\n                \"role\": role,\n                \"description\": description,\n                \"path\": output_path.relative_to(MANIFEST.parent).as_posix(),\n                \"sha256\": sha256_bytes(variant_bytes),\n                \"edits\": [\n                    {\n                        \"old\": old,\n                        \"new\": new,\n                        \"expected_count\": expected_count,\n                    }\n                    for old, new, expected_count in edits\n                ],\n            }\n        )\n\n    manifest_text = json.dumps(\n        manifest,\n        indent=2,\n        ensure_ascii=False,\n        sort_keys=False,\n    ) + \"\\n\"\n    MANIFEST.write_text(manifest_text, encoding=\"utf-8\", newline=\"\\n\")\n\n    print(\n        f\"generated {len(VARIANTS)} variants from {DONOR.name} \"\n        f\"({actual_donor_sha})\"\n    )\n\n\nif __name__ == \"__main__\":\n    main()",
      "parameters": {},
      "semantics": {
        "kind": "program",
        "language": "python"
      },
      "source": "historical/LEAN-Bench/arm-options/gen_variants_o1.py",
      "sha256": "cf5da7d911241cb2f9bbc7619f16379813e36d948c32361ccb35f02f3213ad39"
    }
  ]
}
export function historicalSnippetLibrary() { return structuredClone(historicalSnippetImport) }
