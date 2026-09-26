// A curated view of existing installation policies, with no writer or preset.
import { matchesSettingQuery } from './product-settings-layout.js'

export const ENTERPRISE_SECTION = 'Business controls'
export const ENTERPRISE_CONTROLS = Object.freeze({
  'agent.tool_approvals': Object.freeze({ group: 'Approvals', scope: 'Applies to consequential ToolsEnabled API calls on this installation. Provider-native approvals are separate.' }),
  'purchases.require_owner_approval': Object.freeze({ group: 'Approvals', scope: 'Keeps ToolsEnabled purchase asks with the owner. Turning this off still requires its separate confirmation.' }),
  'audit.activity': Object.freeze({ group: 'Audit processing', scope: 'Full selects success and failure summaries, Essential keeps failures, and Off omits both. It applies only while Signed activity audit is on. With that off, the choice is kept for later and new operations do not request audit records. Work already underway may finish recording. Summary recording is best effort; reported write failures can leave gaps even in Full.' }),
  'tools.throughput': Object.freeze({ group: 'Audit processing', scope: 'Fast batches independent calls; Strict processes each assistant’s calls sequentially. While Signed activity audit is on, both retain the required security audit and Tool activity audit selects completion summaries. With Signed activity audit off, neither mode requests audit records for new operations. Work already underway may finish recording.' }),
  'tools.audit_batch_window_ms': Object.freeze({ group: 'Audit processing', scope: 'In Fast mode, sets the collection delay for API activity batches. Saving records can take longer. This is not a history-retention period.' }),
  'tools.audit_batch_size': Object.freeze({ group: 'Audit processing', scope: 'In Fast mode, bounds the number of API activity records saved together. Selected summaries remain separate records for their calls.' }),
  'fleet.max_declared_agents': Object.freeze({ group: 'Agent capacity', scope: 'Limits declared agents in this installation’s organisation record. This is not a running-agent or company-wide quota; zero removes the count limit. A deployment override takes precedence.' }),
})
export const ENTERPRISE_SETTING_IDS = Object.freeze(Object.keys(ENTERPRISE_CONTROLS))

export function enterpriseIntroMarkup() {
  return `<div class="settings-enterprise-intro" data-enterprise-overview>
    <p class="settings-category-description">Business policies for this ToolsEnabled installation. Opening Enterprise changes the view only. Review each choice, then Save settings to apply edits.</p>
    <p class="settings-desc">These controls cover ToolsEnabled API activity and app-managed work. Other computers and independent command-line sessions keep their own policies. Provider-native activity is outside the ToolsEnabled API audit.</p>
  </div>`
}

export function enterpriseRelatedMarkup() {
  return `<div data-enterprise-related>
    <h3 class="settings-subsection-title">Access, resources &amp; audit identity</h3>
    <nav class="settings-enterprise-links" aria-label="Related business controls">
      <a href="#/settings?category=setup"><strong>Access &amp; working folders</strong><span>Review this computer’s recorded permission level and workspace boundaries.</span></a>
      <a href="#/settings?category=app-permissions"><strong>Role &amp; function rules</strong><span>Review permission profiles in Expert, within the existing role and access ceilings.</span></a>
      <a href="#/settings?category=resources"><strong>Launch resource limits</strong><span>Adjust CPU, memory and parallel starts for work managed by this app.</span></a>
      <a href="#/settings?category=data-privacy"><strong>Audit identity &amp; history</strong><span>Inspect signing health in Expert. Identity maintenance keeps its separate confirmation.</span></a>
    </nav>
  </div>`
}

export function enterpriseMatches(query) {
  return matchesSettingQuery(query, 'enterprise business controls business policies')
}

export function enterpriseSearchMarkup() {
  return `<section class="settings-section settings-enterprise-result">
    <h2 class="settings-section-title">Business controls</h2>
    <p class="settings-desc">Approvals, audit processing and declared-agent capacity for this installation.</p>
    <button type="button" class="ctl-btn" data-settings-show-mode="enterprise">Show Enterprise settings</button>
  </section>`
}
