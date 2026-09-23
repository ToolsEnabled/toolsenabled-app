/* Installed before the views load, the way the preload installs its bridges:
   src/setup-state.js and src/views/setup.js read mcSetup while their module
   graph evaluates. The bridge records what it was handed and never reaches a
   real machine; the widest level is refused without its confirmed consent,
   as the shell does (shell/tier-consent.cjs). */
const machine = { tier: 'guided', writes: [] }
window.riskGateMachine = machine
window.mcSetup = {
  bootstrap: { ok: true, available: true, configured: true, tier: 'guided' },
  chooseTier: async (tier, consent) => {
    if (tier === 'unrestricted' && consent?.confirmed !== true) return { ok: false, code: 'SETUP_UNRESTRICTED_UNCONFIRMED', reason: 'refused by the fixture shell' }
    machine.tier = tier
    machine.writes.push(tier)
    return { ok: true, tier, recorded: { ok: true, sequence: machine.writes.length } }
  },
  tierConsent: async () => ({ ok: true, recorded: false }),
  setEditorImportPolicy: async () => ({ ok: true }),
  workspaceState: async () => ({ ok: true, available: true, roots: ['/work/fixture'], chosen: true }),
}
window.mcSettings = { set: async (id, value) => ({ ok: true, id, value }) }
window.mcProviders = { accountPolicy: async () => ({ ok: true }) }
try { localStorage.clear() } catch { /* a fresh window has nothing to clear */ }
