// Presentation only. The installed engine owns values, validation and enforcement.
export const TOOL_SECTION = 'Tool use'
export const AGENT_SECTION = 'Agents & delegation'
export const RESEARCH_SECTION = 'Research'
export const LOCAL_MODELS_SECTION = 'Local models'
export const RULES_SECTION = 'Rules & approvals'
export const PRODUCT_SECTIONS = Object.freeze([
  TOOL_SECTION, AGENT_SECTION, RESEARCH_SECTION, LOCAL_MODELS_SECTION,
  RULES_SECTION, 'Data & Privacy', 'System',
])

export const PRODUCT_SECTION_NOTES = Object.freeze({
  [TOOL_SECTION]: 'Choose the tools assistants can use, when they ask you, and how tool calls are processed.',
  [AGENT_SECTION]: 'Control how assistants delegate work and how many agents your organisation can contain.',
  [RESEARCH_SECTION]: 'Allow research jobs on this computer, then choose which kinds of work they may run.',
  [LOCAL_MODELS_SECTION]: 'Choose your AI service and the models used by local agents and model tools.',
  [RULES_SECTION]: 'Decide how your instructions become standing rules and who approves requests and purchases.',
  'Data & Privacy': 'Choose how much activity history to retain on this computer.',
  System: 'Configure connections and external control of this installation.',
})

const entry = (title, summary, group, mode = 'advanced') => Object.freeze({ title, summary, group, mode })
export const PRODUCT_SETTING_PRESENTATION = Object.freeze({
  'agent.agent_api': entry('Available tool sets', 'Only restricts native tools. Enabled offers both tool sets. Disabled withholds ToolsEnabled tools. Changes apply to new assistant sessions.', 'Tool access', 'simple'),
  'agent.product_source_writes': entry('Let agents edit ToolsEnabled source in checkouts', 'With tool sets on Only, agents can only change files through ToolsEnabled, and its file tools refuse the product’s own code folders. Turn this on so they may edit ToolsEnabled source inside a checkout you made for them. The running installation stays protected.', 'Tool access', 'simple'),
  'agent.tool_approvals': entry('Confirm consequential tool calls', 'Ask for your approval before a tool performs an action that requires confirmation.', 'When to ask you', 'simple'),
  'agent.persistent_continuation': entry('Continue unfinished ledger work', 'Send follow-up turns for authorized tasks and workflow progress. Stop, account limits and permissions still apply.', 'Working habits', 'simple'),
  'agent.close_asks': entry('Let agents resolve asks', 'Allow assistants to answer or decline asks on the Ledger. Purchase approvals have their own setting below.', 'Ask approvals', 'simple'),
  'agent.blocked_question': entry('When an agent needs an answer', 'Choose how an assistant handles a question that is stopping its work.', 'When to ask you', 'simple'),
  'agent.blocked_question_per_node': entry('Let each agent choose how to ask', 'Allow an individual agent’s configured question policy to override the default.', 'When to ask you'),
  'agent.tool_summary': entry('Introduce available tools', 'Give each new assistant a short guide to the tools available at its permission level.', 'Tool discovery'),
  'agent.capability_recall': entry('Suggest relevant tools', 'Include a few relevant tool suggestions with your messages when there is a confident match.', 'Tool discovery'),
  'agent.message_delivery': entry('Agent message delivery', 'Instant delivers during an active turn when supported. Timer batches messages. End of turn waits for the current work to finish. Delivery never stops a turn; runtimes without live input keep messages queued until the next boundary.', 'Agent messages', 'simple'),
  'agent.message_queue_seconds': entry('Message queue timer', 'Seconds to collect messages before delivery when Timer is selected.', 'Agent messages', 'simple'),
  'agent.task_only_delegation': entry('Assign work only through tasks', 'Agents hand out work by filing Ledger tasks and report through task progress. Direct messages between agents are off while this is on.', 'Delegation', 'simple'),
  'agent.comms_enabled': entry('Let agents message each other', 'Agents can send each other direct messages. Turn this off to have them coordinate through Ledger tasks instead. Messages already sent are kept.', 'Agent messages', 'simple'),
  'agent.task_difficulty_enabled': entry('Grade task difficulty', 'Ask for Easy, Medium or Hard on each new task. One failed review raises Easy to Medium, and a second raises it to Hard. Tasks filed earlier stay ungraded.', 'Task grading', 'simple'),
  'agent.subagent_route': entry('Where delegated agents appear', 'Keep delegated work on your tree, run it separately, or let the assistant follow your prompt.', 'Delegation'),
  'fleet.tree_width': entry('Direct child slots per agent', 'Count every direct child, including idle, stopped and draft slots. Reuse a saved conversation or restart its same slot.', 'Reusable agent slots', 'simple'),
  'fleet.tree_depth': entry('Delegation depth', 'Levels below each root. Three permits four levels including the root; zero permits roots only. Existing descendants remain when you lower it.', 'Reusable agent slots', 'simple'),
  'fleet.max_declared_agents': entry('Maximum declared agents', 'Limit the size of your organisation. Zero removes this count limit; running capacity is governed by Resources.', 'Organisation size'),
  'fleet.concurrency_limits': entry('Running capacity', 'Resource headroom and account availability determine how many agents can run at once.', 'Organisation size'),
  'fleet.concurrent_shared_writes': entry('Concurrent writes to shared files', 'Allow assistants to save the same shared file at the same time.', 'Shared work', 'expert'),
  'tools.throughput': entry('Tool-call processing', 'Fast processes independent calls together. Strict processes each assistant’s calls one at a time.', 'Speed & activity records'),
  /* Owner direction 2026-09-20 (T781/T782): signed activity audit and ledger
     history verification are optional setups, off on a fresh copy, and
     opening Advanced turns neither on. The rows, their defaults and their
     enforcement are M10's (engine audit-activity.js, task continuation);
     these are the words beside them. */
  'audit.enabled': entry('Signed activity audit', 'Record operations in the signed activity ledger. Off is the default: ordinary work runs without it, and your saved audit data and activity preferences are kept. Opening Advanced does not turn this on.', 'Activity history'),
  'ledger.verify_history': entry('Verify ledger history before continuing', 'Require the complete ledger history to be verified before an assistant continues work on its own. Off is the default: current validated tasks are read without claiming their history is intact. Existing history is kept.', 'Activity history'),
  'audit.activity': entry('Tool activity audit', 'Which tool activity summaries the signed audit writes while it is on: successes and failures, failures only, or none. While Signed activity audit is off, the Basic default, this choice is kept and nothing is written. Summary write failures can leave gaps.', 'Activity history'),
  /* Owner direction 2026-09-20 (T782/T783): routine diagnostics are finite by
     default. The row, its choices and its service are M7's (engine
     diagnostic-retention.js); these are the words beside it. Its maintenance
     acts on a closed file when its age reaches the window OR the folder is
     above the storage target, oldest first, a few files per pass, and only
     while every managed file could be read; the words say exactly that. */
  'diagnostics.retention': entry('Diagnostic retention', 'How long routine product diagnostics are kept: app stall, memory, exit, native-decision, native agent log and startup failure records. The default is 7 days / 64 MiB. A closed file expires when it reaches that age. Above the storage target, the oldest closed files are removed sooner, a few at a time, until the folder is below the target. The target is eventual, not a hard limit. Files still being written, files you keep and unreadable files are never removed. One unreadable file pauses all cleanup, so the folder can remain above the target. A diagnostic that reaches its own output budget stops writing and says so; the work itself continues. Keep retains every file, with no storage limit. Archive keeps every file too: closed files that reach the default age or storage target are moved to the archive folder instead of removed. Your saved work, active recovery state and signed audit segments are never part of this cleanup. An unreadable choice stops cleanup instead of deleting.', 'Activity history'),
  'tools.audit_batch_window_ms': entry('Activity batching window', 'Wait briefly for nearby activity records so they can be saved together.', 'Speed & activity records'),
  'tools.audit_batch_size': entry('Maximum activity batch', 'Limit how many activity records are saved in one batch.', 'Speed & activity records'),
  'tools.credential_check_interval_seconds': entry('Refresh credential presence', 'Recheck whether required credentials are present. Changes to the encrypted Windows vault invalidate the cached result immediately.', 'Credential checks'),
  'agent.message_screening': entry('Check messages for credentials', 'Choose how strictly messages between assistants are screened for credentials and similar-looking code names.', 'Credential checks'),
  'capability.elevation_duration': entry('Temporary access duration', 'Set how long a temporary grant of additional access lasts before it expires.', 'Temporary access', 'expert'),
  'capability.elevation_survives_restart': entry('Keep temporary access after a restart', 'Let an unexpired grant remain available when the program starts again.', 'Temporary access', 'expert'),
  'audit.retention': entry('Searchable activity history', 'Choose how much activity history remains in the fast search index.', 'Activity history'),
  'tools.policy_enforcement': entry('Detailed tool-policy enforcement', 'Apply the configured per-tool policy in addition to ordinary permission and approval checks.', 'Detailed tool policy', 'expert'),
  'research.pipeline': entry('Enable research jobs', 'Let enabled projects queue research work on this computer.', 'Research jobs'),
  'research.runner_agent': entry('Launch assistants', 'Allow a research job to start an assistant through the normal launch path.', 'Allowed work'),
  'research.runner_process': entry('Run programs', 'Allow a research job to run the command declared by its experiment.', 'Allowed work'),
  'research.runner_http': entry('Call web services', 'Allow a research job to make the encrypted web requests declared by its experiment.', 'Allowed work'),
  'rules.require_read_each_turn': entry('Include all rules in every turn', 'Give assistants every current standing rule that applies to them before each turn. Stop the send with an explanation if the complete rules cannot be read or fit.', 'Standing rules', 'simple'),
  'rules.filing_from': entry('Who adds standing rules', 'Only you, on the Ledger page. Or you, on the Ledger page or by typing /Request in a chat. Or your assistants as well, from what you tell them. When assistants are left out they neither file rules nor ask you about them.', 'Standing rules', 'simple'),
  'rules.ask_when_unsure': entry('Ask before saving an uncertain rule', 'When your intent is unclear, ask you before adding a standing rule.', 'Standing rules'),
  'rules.agent_filed_needs_approval': entry('Review new rules before they apply', 'Keep rules filed by assistants pending until you approve them on the Ledger.', 'Standing rules'),
  'purchases.require_owner_approval': entry('Require your approval for purchases', 'Keep purchase approval with you. Turning this off requires a separate confirmation.', 'Purchase approvals', 'simple'),
  'app.outside_control': entry('Allow local programs to control the app', 'Let another program running under your account drive this app through its local control connection.', 'External control', 'expert'),
  'model.provider': entry('AI service', 'Choose the kind of service that hosts your local or compatible models.', 'Model connection'),
  'model.endpoint': entry('Service address', 'Enter the address of the AI service you want to use.', 'Model connection'),
  'model.name': entry('Shared default model', 'Use this model when an agent or tool has no separate model selected.', 'Default models'),
  'model.local_agent_name': entry('Default for local agents', 'Choose a separate default for new local agents, or use the shared default.', 'Default models'),
  'model.tool_name': entry('Default for model tools', 'Choose a separate default for tool calls that ask a model to answer.', 'Default models'),
  'model.local_gpu_policy': entry('GPU use', 'Choose whether a local model may fall back to the CPU.', 'Local performance'),
  'model.local_context_tokens': entry('Context window', 'Set how much context the local model can hold. Larger windows require more memory.', 'Local performance'),
  'model.local_thinking': entry('Thinking mode', 'Choose whether supported local models use a separate thinking phase.', 'Local performance'),
  'model.local_keep_alive_minutes': entry('Keep the model loaded', 'Keep an idle local model in memory so its next response can start sooner.', 'Local performance'),
})

export function productSettingPresentation(id) {
  return PRODUCT_SETTING_PRESENTATION[id] || {}
}

const PRESENTATION_ORDER = new Map(Object.keys(PRODUCT_SETTING_PRESENTATION).map((id, index) => [id, index]))
export function compareProductSettings(left, right) {
  return (PRESENTATION_ORDER.get(left.id) ?? 1000) - (PRESENTATION_ORDER.get(right.id) ?? 1000)
}

export function sectionOfRow(id) {
  if (id.startsWith('model.')) return LOCAL_MODELS_SECTION
  if (id.startsWith('research.')) return RESEARCH_SECTION
  if (id.startsWith('rules.') || id.startsWith('purchases.') || id === 'agent.close_asks') return RULES_SECTION
  if (id.startsWith('audit.') || id.startsWith('ledger.') || id.startsWith('diagnostics.')) return 'Data & Privacy'
  if (id.startsWith('app.')) return 'System'
  if (id.startsWith('fleet.') || ['agent.subagent_route', 'agent.task_difficulty_enabled', 'agent.task_only_delegation', 'agent.comms_enabled', 'agent.message_delivery', 'agent.message_queue_seconds'].includes(id)) return AGENT_SECTION
  return TOOL_SECTION
}

export function matchesSettingQuery(query, ...parts) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = parts.flat(Infinity).filter(Boolean).join(' ').toLowerCase()
  return words.every(word => haystack.includes(word))
}
