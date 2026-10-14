'use strict';

/* THE SHELL'S ONE DOOR TO THE PLUGIN HOST.
 *
 * WHY THIS IS A FILE AND NOT THREE MORE HANDLERS IN main.cjs. Everything the
 * owner's plugin screen shows is a security decision -- which capabilities a
 * package asked for, which it was given, and what its tools therefore count as.
 * A screen like that must be provable without a browser and without Electron, so
 * the reading and the deciding live here, behind an injectable host, and main.cjs
 * keeps only the three arrows that carry it. tools/test/plugin-catalogue.test.mjs
 * drives every branch below with a fake host.
 *
 * WHAT CROSSES, AND WHAT CANNOT. Outward: a plugin's content digest, a capability
 * name from a closed vocabulary, a tool name, and the word 'grant' or 'revoke'.
 * Inward: names, capability lists, effect classes and refusal sentences. No path
 * inside a package, no script, no file contents and nothing a plugin wrote crosses
 * as anything but text that is escaped where it is drawn.
 *
 * IT NEVER ACTIVATES ANYTHING. Listing a package inspects it: a digest, a
 * manifest, and what the grant store says. Activation -- which prepares
 * directories and registers tools -- happens at engine start, before the tool
 * registry is built, because src/lib/tool-pack-registry.js is frozen at module
 * load and a pack registered later would silently not exist. A screen that
 * activated a plugin when somebody opened it would be a screen that could not
 * work, so it does not try.
 */

const nodePath = require('node:path');

const CAPABILITY_VOCABULARY = Object.freeze([
  'storage', 'secrets', 'subprocess', 'network', 'auditLog', 'roles', 'settings', 'skin'
]);
const SHA256 = /^[0-9a-f]{64}$/;
const ACTOR = 'the person using this computer';

function failure(code, reason) {
  return { ok: false, code, reason };
}

/* The host and the grant store are resolved from the capability payload, the same
   way every other engine module the shell needs is (see the state-store require in
   main.cjs). Resolved lazily and cached per root: requiring the host is cheap, but
   a require at module load would run before the payload is known to be there. */
function makeLoader({ capabilityRoot, stateRoot }) {
  let cached = null;
  return () => {
    if (cached) return cached;
    const root = capabilityRoot();
    const host = require(nodePath.join(root, 'src', 'lib', 'plugin-host'));
    const grants = new host.PluginGrantStore({
      stateStore: require(nodePath.join(root, 'src', 'lib', 'state-store.js')).getStateStore(),
      audit: require(nodePath.join(root, 'src', 'lib', 'audit.js'))
    });
    cached = { host, grants, stateRoot };
    return cached;
  };
}

/* Per package, and never fatal: a package whose rows file is broken still gets its
   card, its capabilities and its tools. The failure is carried as `contributionsRefused`
   so the page can say which file and why. */
function contributionsFor(host, grants, entry) {
  if (!entry.inForce.length) {
    return { settings: [], limits: null, skin: {}, roles: [], contributionsRefused: [] };
  }
  try {
    const found = host.contributions(entry.root, { grants });
    return {
      settings: found.settings,
      limits: found.restrictions,
      skin: found.skin,
      roles: found.roles.map(role => role.id),
      contributionsRefused: found.refused,
    };
  } catch (error) {
    return {
      settings: [], limits: null, skin: {}, roles: [],
      contributionsRefused: [{
        what: 'all',
        code: error && error.code ? String(error.code) : 'PLUGIN_CONTRIBUTION_INVALID',
        message: error && error.message ? String(error.message) : String(error),
      }],
    };
  }
}

/* WHETHER AN ALLOWED PLUGIN IS ACTUALLY RUNNING IN THIS SESSION (1.0.50 release
   review F6). Plugins are brought up once, when the app starts (main.cjs), and a
   package can be allowed and still not start -- an interpreter this build cannot
   find, a tool name another plugin already uses, a role file the engine refuses.
   That used to reach only the console, and the card said "Allowed everything it
   asked for" with tools listed as asking every time they run, while none of them
   existed. `outcome` is what main.cjs got from bringing plugins up: { ok, status }
   or { ok: false, code, reason }. Null (not known) says nothing rather than guess.
   Matched by digest only: a refusal without one is a folder that has no card. */
function runningFor(entry, outcome) {
  if (!outcome || !entry.inForce.length) return null
  if (outcome.ok !== true) {
    return { state: 'not-running', reason: `No plugin was started when the app opened. ${String(outcome.reason || '')}`.trim() }
  }
  const status = outcome.status || {}
  const started = (status.activated || []).some(item => item && item.sha256 === entry.sha256)
  const refusals = (status.refused || []).filter(item => item && item.sha256 === entry.sha256)
    .map(item => ({ part: String(item.part || 'package'), message: String(item.message || item.code || '') }))
  if (started) return refusals.length ? { state: 'partly', parts: refusals } : { state: 'running' }
  const whole = refusals.find(item => item.part === 'package')
  if (whole) return { state: 'not-running', reason: whole.message }
  return { state: 'not-yet' }
}

function createPluginCatalogue({ load, log = () => {}, storedRoleIds = null, activation = null } = {}) {
  if (typeof load !== 'function') throw new TypeError('createPluginCatalogue needs a load() returning { host, grants }.');

  /* THE PERSON'S OWN ROLE IDS, so a plugin role one of them hides can be named.
     A role the person wrote with a plugin role's id wins (the engine's role
     projection), and the page used to go on counting the plugin's. Asked once per
     listing; a role file that will not read costs that one sentence, never the
     list. */
  function ownRoleIds() {
    if (typeof storedRoleIds !== 'function') return new Set();
    try {
      const ids = storedRoleIds();
      return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
    } catch (error) {
      log('plugin catalogue: the person\'s own role ids could not be read', { code: error && error.code ? String(error.code) : null });
      return new Set();
    }
  }

  /* Every read goes through here so that a broken payload, a missing plugin
     directory and a refused manifest all reach the screen as a SENTENCE rather
     than as an empty list. An empty list would say "you have no plugins", which is
     a different and wrong answer. */
  function guard(what, work) {
    try {
      return work();
    } catch (error) {
      const code = error && error.code ? String(error.code) : 'PLUGIN_HOST_UNAVAILABLE';
      log(`plugin catalogue: ${what} failed`, { code });
      return failure(code, error && error.message ? String(error.message) : String(error));
    }
  }

  return {
    list() {
      return guard('list', () => {
        const { host, grants } = load();
        // `create`: the page names this folder as where a plugin goes, so its read
        // makes the folder when it is missing (engine F13). A folder that cannot be
        // read is refused there, and guard() turns that into a sentence, never into
        // "No plugins added".
        const listing = host.listPackages({ grants, create: true });
        const own = ownRoleIds();
        let outcome = null;
        try { outcome = typeof activation === 'function' ? activation() : null; }
        catch { outcome = null; }
        const withShadows = (contributed) => ({
          ...contributed,
          shadowedRoles: contributed.roles.filter(id => own.has(id)),
        });
        return {
          ok: true,
          root: listing.root,
          /* The capability vocabulary travels WITH the listing rather than being
             restated in the renderer. A screen holding its own copy of this list
             drifts the moment a capability is added, and the way it drifts is by
             silently not drawing one -- which on a consent screen means a
             capability granted without being shown. */
          vocabulary: CAPABILITY_VOCABULARY,
          packages: listing.packages.map(entry => ({
            id: entry.id,
            sha256: entry.sha256,
            name: entry.name,
            displayName: entry.displayName,
            summary: entry.summary,
            requested: entry.requested,
            granted: entry.granted,
            inForce: entry.inForce,
            withheld: entry.withheld,
            effectFloor: entry.effectFloor,
            tools: entry.tools,
            roleCount: entry.roleCount,
            declaresSettings: entry.declaresSettings,
            declaresRestrictions: entry.declaresRestrictions,
            hasSkin: entry.hasSkin,
            grantedAt: entry.grantedAt,
            grantedBy: entry.grantedBy,
            revoked: entry.revoked,
            /* WHAT IT CONTRIBUTES, READ WITHOUT ACTIVATING IT. contributions() in
               the host reads the manifest, the rows file, the restrictions file and
               the skin tokens and returns them; it creates nothing and registers
               nothing. The screen needs this to draw a plugin's own switches and
               its self-imposed limits, and a screen that had to activate a plugin
               to show them would be a screen that could not run here at all -- the
               tool registry in this process is already built. A malformed file is
               reported per contribution rather than costing the package its
               tools. */
            ...withShadows(contributionsFor(host, grants, entry)),
            running: runningFor(entry, outcome)
          })),
          /* Named, not counted. A directory that fails to load is the case where
             a person believes a plugin is running and it is not. */
          refused: listing.refused
        };
      });
    },

    /* GRANT IS ABSOLUTE, NOT INCREMENTAL. The request carries the WHOLE set the
       owner wants in force, and it replaces what was there. An add/remove API
       would make "what is granted" depend on the order requests arrived in, and a
       consent screen must not have a history. */
    grant(request) {
      return guard('grant', () => {
        const { host, grants } = load();
        if (!request || typeof request !== 'object') return failure('PLUGIN_REQUEST_INVALID', 'No request.');
        const sha256 = String(request.sha256 || '');
        if (!SHA256.test(sha256)) return failure('PLUGIN_REQUEST_INVALID', 'A plugin is named by its content digest.');
        const wanted = Array.isArray(request.capabilities) ? request.capabilities.map(String) : null;
        if (!wanted) return failure('PLUGIN_REQUEST_INVALID', 'capabilities must be a list.');
        const unknown = wanted.filter(name => !CAPABILITY_VOCABULARY.includes(name));
        if (unknown.length) {
          return failure('PLUGIN_REQUEST_INVALID', `Not a capability this build offers: ${unknown.join(', ')}.`);
        }
        const waivers = Array.isArray(request.approvalWaivers) ? request.approvalWaivers.map(String) : [];

        /* The directory is found by re-reading the listing and matching the
           DIGEST. The renderer never sends a path: a path from a window is a path
           the host would then read, and the digest is both the identity and the
           lookup key, so there is nothing to spoof. */
        const listing = host.listPackages({ grants });
        const found = listing.packages.find(entry => entry.sha256 === sha256);
        if (!found) {
          return failure('PLUGIN_NOT_FOUND',
            'That plugin is not among the packages on this computer any more. If you changed its files it is now a '
            + 'different plugin, with its own entry and no capabilities.');
        }
        const { identity, manifest } = host.inspect(found.root);
        if (identity.sha256 !== sha256) {
          return failure('PLUGIN_CHANGED',
            'That plugin changed between the screen being drawn and this decision. Nothing was granted. Look at it '
            + 'again: what you were shown is not what is there now.');
        }
        const result = grants.grant({
          identity,
          manifest,
          capabilities: wanted,
          approvalWaivers: waivers,
          actor: typeof request.actor === 'string' && request.actor.trim() ? request.actor.trim() : ACTOR,
          /* The digests of the packages on this computer now. The grant store
             counts only these toward its limit of plugins allowed something at
             once: a version that is no longer here cannot run, and its record is
             never removed, so counting it locked out every new plugin after enough
             updates (1.0.50 release review F5). */
          present: listing.packages.map(entry => entry.sha256)
        });
        return {
          ok: true,
          sha256,
          capabilities: result.record.capabilities,
          approvalWaivers: result.record.approvalWaivers,
          audited: result.audited.recorded,
          /* THE ONE SENTENCE THIS SCREEN MUST NOT LEAVE OUT. A grant changes what
             the tool registry contains, and that is built once at engine start. */
          restartRequired: true
        };
      });
    },

    revoke(request) {
      return guard('revoke', () => {
        const { grants } = load();
        const sha256 = String((request && request.sha256) || '');
        if (!SHA256.test(sha256)) return failure('PLUGIN_REQUEST_INVALID', 'A plugin is named by its content digest.');
        const reason = request && typeof request.reason === 'string' && request.reason.trim()
          ? request.reason.trim().slice(0, 200) : null;
        const result = grants.revoke(sha256, {
          actor: typeof request.actor === 'string' && request.actor.trim() ? request.actor.trim() : ACTOR,
          reason
        });
        return {
          ok: true,
          sha256,
          removed: result.removed,
          alreadyRevoked: result.alreadyRevoked,
          withdrawn: result.withdrawn ? [...result.withdrawn] : [],
          restartRequired: result.removed
        };
      });
    }
  };
}

module.exports = { createPluginCatalogue, makeLoader, runningFor, CAPABILITY_VOCABULARY };
