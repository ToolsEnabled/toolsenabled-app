import { canonical, catalogMap, invariant, object } from './benchmark/prompts.mjs'

export function parseSnippetLabels(value) {
  const labels = Array.isArray(value) ? value : String(value || '').split(/[,\n]/)
  invariant(labels.every(label => typeof label === 'string'), 'Snippet labels must be text.')
  const seen = new Set(), result = []
  for (const value of labels) {
    const label = value.trim()
    if (!label) continue
    invariant(label.length <= 64 && !/[\u0000-\u001f,]/.test(label), 'Use labels of at most 64 characters, without commas or line breaks.')
    const key = label.toLocaleLowerCase()
    if (!seen.has(key)) { seen.add(key); result.push(label) }
  }
  invariant(result.length <= 32, 'Use at most 32 labels per snippet.')
  return result
}

export const snippetTitle = bundle => bundle.title?.trim() || bundle.id.replace(/[-_]+/g, ' ').replace(/^./, letter => letter.toUpperCase())
export const snippetLabels = bundle => parseSnippetLabels(bundle.labels || [])
export const snippetChoice = bundle => `${snippetTitle(bundle)}${snippetLabels(bundle).length ? ' · ' + snippetLabels(bundle).join(', ') : ''} (${bundle.id})`

export function snippetMetadata(title, labels) {
  invariant(typeof title === 'string' && title.trim() && title.trim().length <= 160, 'Give the snippet a name of at most 160 characters.')
  return { title: title.trim(), labels: parseSnippetLabels(labels) }
}

export function filterSnippets(catalog, { search = '', label = '', unlabelled = false } = {}) {
  const query = search.trim().toLocaleLowerCase(), category = label.toLocaleLowerCase()
  return catalog.map((bundle, index) => ({ bundle, index })).filter(({ bundle }) => {
    const labels = snippetLabels(bundle)
    if (unlabelled && labels.length || category && !labels.some(value => value.toLocaleLowerCase() === category)) return false
    return !query || [snippetTitle(bundle), bundle.id, bundle.text, ...labels].some(value => String(value).toLocaleLowerCase().includes(query))
  })
}

function validateMetadata(bundle) {
  if (bundle.title !== undefined) snippetMetadata(bundle.title, bundle.labels || [])
  if (bundle.labels !== undefined) {
    invariant(Array.isArray(bundle.labels), 'Snippet labels must be an array of text values.')
    parseSnippetLabels(bundle.labels)
  }
}

export function exportSnippetLibrary(catalog) {
  catalogMap(catalog)
  catalog.forEach(validateMetadata)
  return { format: 'benchmark-snippet-library', version: 1, catalog: catalog.map(bundle => {
    const { review, ...contents } = bundle
    return JSON.parse(canonical(contents))
  }) }
}

export function importSnippetLibrary(value, existing) {
  invariant(object(value) && value.format === 'benchmark-snippet-library' && value.version === 1, 'Choose a version 1 snippet library exported from Research.')
  catalogMap(value.catalog)
  const next = JSON.parse(canonical(existing)), seen = new Map(next.map(bundle => [bundle.id, bundle]))
  for (const bundle of exportSnippetLibrary(value.catalog).catalog) {
    if (seen.has(bundle.id)) {
      const { review, ...prior } = seen.get(bundle.id)
      invariant(canonical(prior) === canonical(bundle), `A different snippet already uses identifier ${bundle.id}. Rename it before importing; existing work has been kept.`)
      continue
    }
    next.push(bundle); seen.set(bundle.id, bundle)
  }
  catalogMap(next)
  for (const bundle of next) for (const dependency of bundle.dependencies || []) invariant(seen.has(dependency), `${bundle.id} needs missing dependency ${dependency}.`)
  return next
}
