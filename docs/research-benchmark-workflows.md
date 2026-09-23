# Frozen prompt workflows

Research → Benchmark builder → **Prompt workflow** defines the collection calls that produce one trial answer. This is separate from the trading Strategy/Template grammar. Both the browser replay control and the exported CLI execute `src/benchmark/workflow.mjs` through the shared study runner.

The workflow editor holds `{plan, assignments}`; `assignments` maps every condition ID to a workflow ID or `null`. **Start one-stage workflow** creates editable protocol text, without making provider calls or supplying responses. Unapplied edits prevent freezing and survive account draft save/import.

For a first workflow whose condition and accounting settings depend on one another:

1. Start the workflow draft and, if needed, start an Accounting draft before editing Protocol. Fill the workflow rationale, stages, assignments and exact accounting mappings.
2. Fill the Protocol conditions and budgets. A recorded workflow needs `mode: "envelope"` and its explicitly authored `workflowResponses` task/stage map. Supply your own recorded envelopes and reported action logs; the platform does not generate responses from the answer key.
3. Select **Apply workflow, protocol and accounting together**. The action validates those three complete groups against each other before applying any of them. Every assignment must match the new condition roster. Other pending editor groups must be applied first.
4. Inspect the applied specification, then Freeze to inspect its normal execution requirements. Applying a coherent design does not establish independent qualification or collection eligibility.

Invalid combined edits leave the current applied specification and all editor text intact. Success makes the preceding draft and raw text available through **Undo replacement** in this page; it does not restore measured evidence from before the edits. Individual Apply actions remain available when their dependencies are already applied.

To remove a workflow and its dependent accounting, set `plan` and all assignments to `null`, remove the affected adapters' `workflowResponses` properties, and remove envelope mode if removing the accounting plan. Set the Accounting plan to `null` and use the same combined action. An empty workflow map still declares workflow state; it does not replace removing the property. Reassignments must keep their saved stage maps consistent with the new workflow. No stage responses, assignments or mappings are renamed automatically.

The frozen specification stores `workflowPlan: {version: 1, workflows: [...]}` and each assigned condition's `workflowId`. A workflow declares:

| Field | Meaning |
| --- | --- |
| `id`, `purpose`, `rationale` | Its identity and whether the graph is a `treatment` or `orchestration`, with the intended comparison. |
| `entry` | The first stage ID. |
| `failurePolicy` | Version 1 requires `halt-study`. |
| `budgets.maxCalls` | At most 32 calls; must cover the longest route in the graph. |
| `budgets.maxRequestBytes` | Maximum UTF-8 bytes of each canonical public request. Oversized context is refused without truncation. |
| `budgets.maxResponseBytes` | Maximum cumulative canonical response bytes. A violating response is retained and halts subsequent calls. |
| `budgets.maxToolCalls` | Maximum total reported tool actions. |
| `budgets.maxOutputTokens` | Maximum total mapped output tokens, or explicit `null`. A numeric limit requires valid reported counts for every stage. |
| `stages` | One to 32 reachable stages in an acyclic graph. |

Each stage specifies exact `instructions: {system, developer, user}`; system and developer text may be explicit `null`. `includeTaskPrompt` and `includeTaskInput` control the compiled task prompt and separate input field. The compiled prompt can itself contain public input. There is no implicit conversation history. `parents` selects prior output projections, and `allowedTools` names tools already declared in that condition's `collection.tools`. A stage's `timeoutMs` fits within the parent attempt budget.

For example, a second stage can receive only the first stage's proposed answer:

```json
{
  "id": "revise",
  "instructions": {
    "system": null,
    "developer": "Use the disclosed task and proposed answer.",
    "user": "Return an object with the revised answer."
  },
  "includeTaskPrompt": true,
  "includeTaskInput": false,
  "parents": [{ "stageId": "draft", "path": ["answer"] }],
  "allowedTools": [],
  "timeoutMs": 30000,
  "next": { "branches": [], "otherwise": null },
  "resultPath": ["answer"]
}
```

The parent must occur on every route to its child. A missing selected path halts the workflow; no replacement context is invented. Paths are arrays of literal own property names or array indices; `[]` selects the complete output. Output strings are not automatically parsed as JSON.

A stage's `next.branches` is an ordered list of `{path, equals, to}` comparisons against that stage's output. The first matching JSON equality chooses `to`; otherwise `next.otherwise` applies. A stage ID continues the route. Explicit `null` terminates it and selects the current output at `resultPath`. Selection occurs before the grader sees the answer. Incorrect graded answers are retained and never retried for quality. Version 1 follows one sequential route, with no loops, parallel fan-out, heterogeneous per-stage models or improvised agent spawning.

## Adapter contract and evidence

Command, HTTPS and pinned module adapters receive the same public request shape. The workflow host supplies a structured JSON string in `prompt`, with `instruction`, `taskPrompt` and projected `parents`. The separate `input`, requested `model`, exact stage instructions and allowed tool definitions are retained. `workflow` metadata identifies the plan hash, stage, call number, timeout and remaining reported token/tool budgets. Expected values, reference grades, private interpretation sets and undeclared parent fields are excluded from this request. A local adapter still has its ordinary filesystem permissions; use an isolated adapter environment when required by the study design.

Every response has `output`, its mapped identity/completion/usage metadata, and an explicit reported action log:

```json
{
  "output": { "answer": "example" },
  "identity": { "provider": "fixture", "id": "example-system" },
  "completion": { "status": "complete" },
  "usage": { "outputTokens": 3 },
  "workflow": { "toolCalls": [] }
}
```

A tool action records `{id, name, arguments, result, status}`; status is `completed` or `failed`. IDs must be distinct within the stage. Disallowed actions, missing logs, invalid required metadata and resource overruns halt the workflow. Tool definitions and fresh context are requests to the external adapter. The host checks retained reports; it cannot authenticate hidden external tool use, internal model settings or provider context isolation. Already incurred external work cannot be undone by a budget violation.

Replay controls use `adapter.mode: "envelope"` and `adapter.workflowResponses[taskId][stageId]`. These are explicitly saved fixtures. Their model metadata, tokens, charges and tool actions do not establish new provider work. The fixture module at `tools/test/fixtures/research-benchmark-workflow.mjs` demonstrates a two-stage branch and an exact parent projection.

Generating a corpus, audit cases or LEAN combinations clears saved ordinary and workflow responses. It preserves the declared replay mode, workflow assignment, model settings and accounting plan. Supply responses for the new task IDs and stages before using recorded controls; an empty response map provides no result. Clearing responses does not remove a workflow or convert envelope metadata into ordinary output. Ordinary replay conditions keep their absent workflow configuration.

The journal writes `workflow-started` with the exact request before dispatch, then `workflow-finished` with the raw response/error, stage timing and mapped observations before another call or grading. The parent attempt retains the complete stage sequence and terminal selection. Validation reconstructs the requests, route, budgets, accounting and selected answer from the frozen graph. Changing a stage request or choosing a different final response invalidates the journal.

Any stage error, policy failure, cancellation or interruption halts the study even when the general protocol permits transport retries. Explicit crash recovery reserves the entire attempt timeout and closes the uncertain attempt as interrupted. It does not repeat a stage, resume the partial graph or infer missing timing. Inspect the retained evidence and repair apparatus in a new frozen project before reusing outputs. Owned command/module processes settle before the run releases ownership; an uncooperative browser Promise cannot keep the run active or later append stage evidence.

## Portable analysis and qualification

Exports pin the workflow runtime and regenerate `workflows/plan.json` and `workflows/contract.json`; the CLI checks their manifest membership and exact bytes. The report includes workflow design, stage disposition, selected answers, usage and cost tables, plus complete requests, responses and observations in `workflows.json`. Usage and reported charges count every started collection call, including intermediate and failed stages. Missing measurements leave full totals unavailable while preserving known stage subtotals. Currencies remain separate. Per-attempt allocation estimates are charged once; unit-price estimates apply to all reported quantities under the frozen rounding convention. Host attempt timing remains distinct from stage duration and reported provider generation time.

The native qualification fixture runs one synthetic operational task under correct and wrong quantity programs, each in three fresh LEAN containers after two prompt stages. Its verifier reconstructs native orders, checks the selected program and every retained artifact, rederives the report and verifies a sealed audit reference. These controls qualify the staged apparatus path; they provide no personal semantic approval, provider collection or evidence of workflow effectiveness.
