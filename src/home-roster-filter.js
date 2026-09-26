// Filters the already scoped board. Tree selection and circle following stay independent.
export function filterRosterGroups(groups, { query = '', status = 'all' } = {}) {
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = line => {
    if (status !== 'all' && line.state !== status) return false
    const words = [line.name, line.task, line.detail, line.waiting, line.result, line.asked, ...(line.history || [])].filter(Boolean).join(' ').toLocaleLowerCase()
    return terms.every(term => words.includes(term))
  }
  const visible = groups.map(group => {
    const lines = group.lines.filter(matches), rest = group.rest.filter(matches)
    return { ...group, lines, rest, count: lines.length + rest.length }
  }).filter(group => group.count > 0)
  return { groups: visible, count: visible.reduce((n, group) => n + group.count, 0), active: terms.length > 0 || status !== 'all' }
}
