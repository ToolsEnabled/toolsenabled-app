/* Graph mechanics projected from authoritative role capabilities and declared
   management topology. Role ids and visual palette aliases are deliberately
   absent from this module. */

export function roleGraphPosture(agents, edges, { hasAuthoritativeRoles = true } = {}) {
  const declaredSupervisors = new Set((Array.isArray(edges) ? edges : [])
    .filter(edge => edge?.type === 'manages' && edge?.sourceKind === 'declared')
    .map(edge => edge.from))
  return new Map((Array.isArray(agents) ? agents : []).map((agent) => {
    const supervisor = declaredSupervisors.has(agent.id)
    const presentationRoot = agent.orgRoot === true
      || (!hasAuthoritativeRoles && !agent.parentId && supervisor)
    return [agent.id, Object.freeze({
      tierRank: presentationRoot ? 0 : supervisor ? 1 : 2,
      cullable: !presentationRoot && !supervisor,
    })]
  }))
}
