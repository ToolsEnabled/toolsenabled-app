'use strict'

/* THE ORGANISATION THE PERSON EDITS, AND WHERE THE EDIT GOES.
 *
 * The agent page lets someone drag an agent onto a new manager, give it a
 * different role, and define roles of their own. Before this file, the first of
 * those wrote a field on an in-memory object that the next projection load
 * rebuilt from JSON, and the other two did not exist. The control looked like it
 * worked; it could not have worked, because nothing in the product could write
 * the declared organisation at all.
 *
 * IT WRITES THE ENGINE'S RECORD, NOT A SECOND ONE. Every rule about what a
 * legal organisation is -- one controller, one manager per agent, no management
 * cycle, no relationship naming an agent that does not exist, no role outside
 * the declared vocabulary -- lives in the payload's own src/lib/agent-org.js and
 * is applied by src/lib/agent-org-store.js. This file resolves those modules and
 * hands them arguments. It contains no opinion about organisations, because a
 * second opinion here is a second implementation, and the second one is always
 * the one that drifts.
 *
 * (This is the same shape, and the same reasoning, as shell/setup-record.cjs,
 * which delegates the permission level to src/lib/setup/machine-record.js
 * rather than keeping a shell-side copy of what a tier means.)
 *
 * NOTHING HERE THROWS. Every function returns {ok:true, ...} or {ok:false, code,
 * reason}. An IPC handler that throws gives the renderer an Error with a
 * stringified message and no code to branch on, and the page then has to decide
 * what a failure means by reading English. The codes below are what the page
 * turns into a sentence a person can act on.
 */

const path = require('node:path')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

/* Declared in tools/capability-manifest.json under `hostModules`, which is what
 * stages them into the payload. A copy of each path is unavoidable -- the
 * manifest is a build input and this is a runtime read -- so a miss is reported
 * as "the payload does not carry this" and names the manifest, rather than
 * surfacing a bare MODULE_NOT_FOUND that reads like a bug in this file. */
const ORG_STORE_MODULE = 'src/lib/agent-org-store.js'
const CUSTOM_ROLE_MODULE = 'src/lib/custom-role-store.js'
const DURABLE_MEMORY_MODULE = 'src/lib/durable-memory-file.js'
const AGENT_ORG_MODULE = 'src/lib/agent-org.js'
const AGENT_ROLES_MODULE = 'src/lib/agent-roles.js'
const BASELINE_ORG_FILE = 'config/agent-org.json'
const ROLE_CAPABILITY_FIELDS = Object.freeze([
  'orgRoot',
  'singleSeat',
  'mayClaimWork',
  'mayWakeReports',
  'requiresMutationContext',
  'mayUseMissionBridge',
  'mayReportMissionBridge',
  'mayMutateMissionBridge',
])

function failure(code, reason) {
  return { ok: false, code, reason }
}

function roleFunctionFields(request) {
  return {
    ...(Object.hasOwn(request, 'functions') ? { functions: request.functions } : {}),
    ...(Object.hasOwn(request, 'requiresDirectUserAuthorization')
      ? { requiresDirectUserAuthorization: request.requiresDirectUserAuthorization } : {}),
  }
}

/* A payload error carries a `code` from the engine (AGENT_ORG_CYCLE,
 * CUSTOM_ROLE_RESERVED_ID, ...). That code is the useful part and is passed
 * through unchanged: the page branches on it, and inventing a shell-side code
 * here would mean the page had two vocabularies for the same failure. */
function fromError(error, fallbackCode) {
  const code = error && typeof error.code === 'string' ? error.code : fallbackCode
  const reason = error && typeof error.message === 'string' ? error.message : 'The organisation could not be changed.'
  return { ok: false, code, reason }
}

function loadModules({ root = resolveCapabilityRoot(), load = require } = {}) {
  if (!root) {
    return failure(
      'ORG_PAYLOAD_ABSENT',
      'No capability payload is present, so this copy has no organisation to read or edit.',
    )
  }
  let orgStore
  let customRoleStore
  let durableMemory
  let agentOrg
  let agentRoles
  try {
    orgStore = load(path.join(root, ORG_STORE_MODULE))
    customRoleStore = load(path.join(root, CUSTOM_ROLE_MODULE))
    durableMemory = load(path.join(root, DURABLE_MEMORY_MODULE))
    agentOrg = load(path.join(root, AGENT_ORG_MODULE))
    agentRoles = load(path.join(root, AGENT_ROLES_MODULE))
  } catch (error) {
    return failure(
      'ORG_MODULES_ABSENT',
      `The capability payload does not carry its organisation modules (${error.message}). They are staged by tools/capability-manifest.json under hostModules.`,
    )
  }
  if (typeof orgStore?.createInstalledAgentOrgStores !== 'function'
    || typeof customRoleStore?.createCustomRoleStore !== 'function'
    || typeof durableMemory?.createDurableMemoryFile !== 'function'
    || typeof durableMemory?.resolveServicesRoot !== 'function'
    || !Array.isArray(agentOrg?.ROLES)
    || !Array.isArray(agentRoles?.ROLE_LIBRARY)) {
    return failure('ORG_MODULES_UNRECOGNIZED', 'The capability payload carries organisation modules this shell does not recognize.')
  }
  return { ok: true, root, orgStore, customRoleStore, durableMemory, agentOrg, agentRoles }
}

/* The engine owns the installed role-file compatibility decision, not merely
 * the directory. Repeating the filenames here previously let the shell save a
 * custom role the owner host could not read. Never fall back to that split. */
function composeStores(modules, { env = process.env } = {}) {
  const installed = modules.orgStore.createInstalledAgentOrgStores({
    baselineFile: path.join(modules.root, BASELINE_ORG_FILE),
    env,
  })
  return { customRoles: installed.roleStore, org: installed.orgStore, roleMemorySelection: installed.roleMemorySelection }
}

/* WHAT THE PAGE IS TOLD ABOUT A ROLE, AND WHY `capabilities` IS PART OF IT.
 *
 * src/lib/agent-roles.js carries, for every shipped role, both what the role is
 * asked to do (`mustNot`) and what the product mechanically guarantees
 * (`enforced`). Those are different claims. A surface that offers someone a role
 * in a menu is making the role's description into a promise, so the description
 * and the enforcement travel together to the page and the page shows both.
 *
 * `enforced` remains as a compatibility projection for the current UI, but it
 * is derived only from the stored capabilities. It is not a second policy. */
function exactRoleCapabilities(value, roleId) {
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === ROLE_CAPABILITY_FIELDS.length
    && ROLE_CAPABILITY_FIELDS.every((field) => Object.hasOwn(value, field) && typeof value[field] === 'boolean')
  if (valid) {
    return Object.freeze(Object.fromEntries(ROLE_CAPABILITY_FIELDS.map((field) => [field, value[field]])))
  }
  const error = new Error(`Role "${roleId}" has a malformed authoritative capabilities record.`)
  error.code = 'CUSTOM_ROLE_CAPABILITIES_INVALID'
  throw error
}

function roleCapabilities(definition) {
  if (Object.hasOwn(definition, 'capabilities')) {
    return exactRoleCapabilities(definition.capabilities, definition.id)
  }
  const error = new Error(`Role "${definition.id}" carries no authoritative capabilities record.`)
  error.code = 'CUSTOM_ROLE_CAPABILITIES_INVALID'
  throw error
}

function assertStructuralCapabilities(candidate, inherited, roleId) {
  if (!candidate) return
  if (candidate.orgRoot !== inherited.orgRoot || candidate.singleSeat !== inherited.singleSeat) {
    const error = new Error(`Role "${roleId}" cannot change orgRoot or singleSeat after creation because role and organisation writes are not atomic.`)
    error.code = 'CUSTOM_ROLE_STRUCTURE_READ_ONLY'
    throw error
  }
}

function describeRole(modules, stores, stored, suppliedRecord = null) {
  const library = new Map(modules.agentRoles.ROLE_LIBRARY.map((role) => [role.id, role]))
  const defaults = new Set(modules.agentOrg.ROLES)
  const record = suppliedRecord || stores.customRoles.getRoleRecord(stored.id)
  /* Definition and revision must come from ONE getRoleRecord() result. Reading
     the text from listRoles() and then the revision from a second lookup could
     bind old words to a new revision if an edit landed between the two. */
  const definition = record ? record.definition : stored
  const shipped = library.get(definition.id) || null
  const isDefault = defaults.has(definition.id)
  const base = definition.baseDefaultRole || null
  const capabilities = roleCapabilities(definition)
  return {
    id: definition.id,
    name: shipped ? shipped.name : definition.id,
    custom: !isDefault,
    baseDefaultRole: base,
    summary: shipped ? shipped.summary : null,
    owns: definition.rules.owns,
    mustNot: definition.rules.mustNot,
    handoff: definition.rules.handoff,
    rules: [...(shipped || library.get(base))?.rules || []],
    /* The role definition has its OWN revision. An org revision cannot detect
       somebody editing these words because the two records deliberately live
       in different stores. A start binds both revisions and the main process
       re-reads both before it spawns anything. */
    revision: record ? record.revision : null,
    capabilities,
    functions: definition.functions === undefined ? null : definition.functions,
    requiresDirectUserAuthorization: definition.requiresDirectUserAuthorization === true,
    enforced: {
      mayClaimWork: capabilities.mayClaimWork,
      singleSeat: capabilities.singleSeat,
    },
  }
}

function describeRoles(modules, stores) {
  return stores.customRoles.listRoles().map((stored) => describeRole(modules, stores, stored))
}

function projectOrg(read) {
  return {
    revision: read.org.revision,
    contentHash: read.org.contentHash,
    source: read.source,
    damaged: read.damaged,
    baselineDrift: read.baselineDrift,
    agents: read.org.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      role: agent.role,
      ...(agent.roleSelection === '' ? { roleSelection: '' } : {}),
      provider: agent.provider,
      enabled: agent.enabled,
      assignedPhase: agent.assignedPhase,
      phasePriority: [...agent.phasePriority],
    })),
    relationships: read.org.relationships.map((relation) => ({ ...relation })),
  }
}

function createAgentOrgRecord({ env = process.env, modules = loadModules() } = {}) {
  /* Resolved once per call rather than cached across calls. The store reads its
     files on demand, and a cached store would keep serving an organisation that
     another window had already changed. */
  function withStores(operation, fallbackCode) {
    if (!modules.ok) return modules
    let stores
    try {
      stores = composeStores(modules, { env })
    } catch (error) {
      return fromError(error, 'ORG_STORE_UNAVAILABLE')
    }
    try {
      return operation(stores)
    } catch (error) {
      return fromError(error, fallbackCode)
    }
  }

  return {
    /* Everything the page needs to draw the organisation AND its editing
       controls, in one call: the org, the role vocabulary that may be assigned,
       and what each role actually enforces. Split across three calls the page
       could render a role menu that disagreed with the org it was drawn over. */
    read() {
      return withStores((stores) => ({
        ok: true,
        org: projectOrg(stores.org.read()),
        roles: describeRoles(modules, stores),
        functionCatalog: modules.customRoleStore.functionCatalog?.() || [],
        ruleTextLimit: modules.customRoleStore.MAX_RULE_TEXT || 1500,
        overlayFile: stores.org.overlayFile,
        roleMemorySelection: stores.roleMemorySelection,
      }), 'ORG_READ_FAILED')
    },

    /* Resolve a renderer's ROLE IDENTITY, never renderer-authored directions.
     *
     * The renderer has to say which row the person picked, but it is not the
     * authority for what that row says. It therefore sends only the agent id,
     * role id and the two revisions from the mcOrg.read() snapshot it displayed.
     * This method re-reads the authoritative org and custom-role stores in one
     * operation, refuses a forged or stale assignment, and returns the same
     * bounded role projection read() exposes. The caller replaces the packet
     * with this result before the agent host sees it. */
    resolveRoleBinding(binding) {
      return withStores((stores) => {
        const expectedKeys = ['expectedOrgRevision', 'expectedRoleRevision', 'id']
        const hasAgentId = Object.hasOwn(binding || {}, 'agentId')
        const hasSelection = Object.hasOwn(binding || {}, 'selection')
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)
          || Object.keys(binding).length !== expectedKeys.length + (hasAgentId ? 1 : 0) + (hasSelection ? 1 : 0)
          || !expectedKeys.every((key) => Object.hasOwn(binding, key))
          || (hasSelection && (binding.selection !== '' || binding.id !== 'worker' || !hasAgentId))
          || (hasAgentId && (typeof binding.agentId !== 'string' || binding.agentId.length === 0))
          || typeof binding.id !== 'string' || binding.id.length === 0
          || !Number.isSafeInteger(binding.expectedOrgRevision) || binding.expectedOrgRevision < 0
          || !Number.isSafeInteger(binding.expectedRoleRevision) || binding.expectedRoleRevision < 0) {
          return failure('MC_AGENT_ROLE_BINDING_INVALID', 'The selected role did not carry a complete organisation snapshot. Read the Role library again, then retry the start.')
        }

        const orgRead = stores.org.read()
        if (orgRead.org.revision !== binding.expectedOrgRevision) {
          return failure('MC_AGENT_ROLE_STALE', 'The organisation changed after this role was selected. Read the Role library again, then retry the start.')
        }

        const agent = hasAgentId
          ? orgRead.org.agents.find((candidate) => candidate.id === binding.agentId) || null
          : null
        if (hasAgentId) {
          if (!agent) {
            return failure('MC_AGENT_ROLE_AGENT_UNKNOWN', 'That agent is no longer in the organisation. Reload the agent page, then retry the start.')
          }
          if (agent.enabled !== true) {
            return failure('MC_AGENT_ROLE_AGENT_DISABLED', 'That agent is disabled in the current organisation and was not started.')
          }
          if (agent.role !== binding.id) {
            return failure('MC_AGENT_ROLE_STALE', 'That agent has a different role now. Reload the agent page, then retry the start.')
          }
          if (hasSelection !== (agent.roleSelection === '')) {
            return failure('MC_AGENT_ROLE_STALE', 'The saved role choice changed. Reload the agent page, then retry the start.')
          }
        }

        let record
        try {
          record = stores.customRoles.getRoleRecord(binding.id)
        } catch (error) {
          if (error && error.code === 'CUSTOM_ROLE_INVALID') {
            return failure('MC_AGENT_ROLE_UNKNOWN', 'That role is not in the Role library. Pick a role from the current library, then retry the start.')
          }
          throw error
        }
        if (!record) {
          return failure('MC_AGENT_ROLE_UNKNOWN', 'That role is not in the Role library. Pick a role from the current library, then retry the start.')
        }
        if (record.revision !== binding.expectedRoleRevision) {
          return failure('MC_AGENT_ROLE_STALE', 'The role directions changed after this role was selected. Read the Role library again, then retry the start.')
        }
        return {
          ok: true,
          ...(agent ? { agent: Object.freeze({ id: agent.id }) } : {}),
          ...(agent ? {
            authority: Object.freeze({
              agentId: agent.id,
              provider: agent.provider,
              roleId: agent.role,
              expectedOrgRevision: binding.expectedOrgRevision,
              expectedRoleRevision: binding.expectedRoleRevision,
            }),
          } : {}),
          role: describeRole(modules, stores, record.definition, record),
          // The full role still enforces this exact seat's authority. The
          // explicit empty canvas selection contributes no role instructions.
          ...(agent?.roleSelection === '' ? { roleSelection: '' } : {}),
        }
      }, 'MC_AGENT_ROLE_UNAVAILABLE')
    },

    reparent({ agentId, parentId, expectedRevision } = {}) {
      return withStores((stores) => {
        stores.org.reparent(
          { agentId, parentId: parentId === undefined ? null : parentId },
          expectedRevision === undefined ? {} : { expectedRevision },
        )
        return { ok: true, org: projectOrg(stores.org.read()) }
      }, 'ORG_REPARENT_FAILED')
    },

    assignRole({ agentId, role, expectedRevision } = {}) {
      return withStores((stores) => {
        stores.org.assignRole({ agentId, role }, expectedRevision === undefined ? {} : { expectedRevision })
        return { ok: true, org: projectOrg(stores.org.read()) }
      }, 'ORG_ASSIGN_ROLE_FAILED')
    },

    /* ONE SEAT FOR ONE TREE NODE. The renderer binds a node to an organisation
       identity only when a seat exists whose id equals the node id and whose
       role equals the node's role (computers.js roleBindingForStart). Nothing
       declared such seats, so every tree agent ran anonymous and agent.spawn
       refused every caller (measured 2026-09-02). The engine store owns the
       rules (unchanged if present, refused by name on a differing role or a
       second root); this only shapes the call. */
    ensureSeat({ id, role, roleSelection, provider, displayName, managerId, expectedRevision, adoptProvider, nodeId } = {}) {
      return withStores((stores) => {
        const written = stores.org.ensureSeat({
          id,
          role,
          ...(roleSelection === undefined ? {} : { roleSelection }),
          ...(provider === undefined || provider === null ? {} : { provider }),
          ...(displayName === undefined || displayName === null ? {} : { displayName }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(adoptProvider === true ? { adoptProvider: true } : {}),
          ...(nodeId === undefined || nodeId === null ? {} : { nodeId }),
        }, expectedRevision === undefined ? {} : { expectedRevision })
        return { ok: true, unchanged: written.unchanged === true, org: projectOrg(stores.org.read()) }
      }, 'ORG_ENSURE_SEAT_FAILED')
    },

    /* THE COUNTERPART OF ensureSeat: releases a tree node's seat and every
       relationship naming it. Idempotent-absence and the refused-root rule
       both live in the engine store; this only shapes the call, exactly the
       way ensureSeat does. */
    releaseSeat({ id, expectedRevision } = {}) {
      return withStores((stores) => {
        const written = stores.org.releaseSeat(
          { id },
          expectedRevision === undefined ? {} : { expectedRevision },
        )
        return { ok: true, unchanged: written.unchanged === true, org: projectOrg(stores.org.read()) }
      }, 'ORG_RELEASE_SEAT_FAILED')
    },

    createRole(request = {}) {
      return withStores((stores) => {
        const { id, baseDefaultRole, rules } = request
        const hasCapabilities = Object.hasOwn(request, 'capabilities')
        const capabilities = hasCapabilities ? exactRoleCapabilities(request.capabilities, id) : null
        const base = baseDefaultRole || null
        stores.customRoles.createCustomRole({
          id,
          baseDefaultRole: base,
          rules,
          ...(hasCapabilities ? { capabilities } : {}),
          ...roleFunctionFields(request),
        })
        return { ok: true, roles: describeRoles(modules, stores) }
      }, 'ORG_CREATE_ROLE_FAILED')
    },

    /* Editing a DEFAULT role and editing a CUSTOM one are different operations
       in the engine -- a default is overridden and can be rolled back, a custom
       role is simply changed -- so the choice is made from the store's own
       record of which it is, not from anything the renderer asserts. */
    editRole(request = {}) {
      return withStores((stores) => {
        const { id, rules } = request
        const hasCapabilities = Object.hasOwn(request, 'capabilities')
        const capabilities = hasCapabilities ? exactRoleCapabilities(request.capabilities, id) : null
        const record = stores.customRoles.getRoleRecord(id)
        if (!record) return failure('CUSTOM_ROLE_NOT_FOUND', `There is no role "${id}".`)
        if (hasCapabilities) {
          const current = describeRole(modules, stores, record.definition, record).capabilities
          assertStructuralCapabilities(capabilities, current, id)
        }
        const isDefault = modules.agentOrg.ROLES.includes(id)
        if (isDefault) {
          stores.customRoles.editDefaultRole({ id, rules, expectedRevision: request.expectedRevision === undefined ? record.revision : request.expectedRevision, ...(hasCapabilities ? { capabilities } : {}), ...roleFunctionFields(request) })
        } else {
          stores.customRoles.editRole({ id, rules, expectedRevision: request.expectedRevision === undefined ? record.revision : request.expectedRevision, ...(hasCapabilities ? { capabilities } : {}), ...roleFunctionFields(request) })
        }
        return { ok: true, roles: describeRoles(modules, stores) }
      }, 'ORG_EDIT_ROLE_FAILED')
    },

    resetRole({ id, expectedRevision } = {}) {
      return withStores((stores) => {
        if (!modules.agentOrg.ROLES.includes(id)) {
          return failure('CUSTOM_ROLE_NOT_DEFAULT', `"${id}" is not a shipped role, so there is no shipped wording to restore.`)
        }
        const record = stores.customRoles.getRoleRecord(id)
        stores.customRoles.rollbackDefaultRole({ id, expectedRevision: expectedRevision === undefined ? (record ? record.revision : 0) : expectedRevision })
        return { ok: true, roles: describeRoles(modules, stores) }
      }, 'ORG_RESET_ROLE_FAILED')
    },

    exportOrg() {
      return withStores((stores) => ({ ok: true, document: stores.org.exportOrg() }), 'ORG_EXPORT_FAILED')
    },

    resetOrg() {
      return withStores((stores) => {
        stores.org.resetToBaseline()
        return { ok: true, org: projectOrg(stores.org.read()) }
      }, 'ORG_RESET_FAILED')
    },
  }
}

module.exports = {
  AGENT_ORG_MODULE,
  AGENT_ROLES_MODULE,
  BASELINE_ORG_FILE,
  CUSTOM_ROLE_MODULE,
  DURABLE_MEMORY_MODULE,
  ORG_STORE_MODULE,
  createAgentOrgRecord,
  loadModules,
}
