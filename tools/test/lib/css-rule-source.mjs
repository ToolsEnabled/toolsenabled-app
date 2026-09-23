// Split only outside attributes, quoted strings, and functional selectors.
// A comma in :is() or a space in :not() does not start a new selector/subject.
function splitOutside(text, separator) {
  const parts = []
  let start = 0, depth = 0, quote = null
  for (let i = 0; i < text.length; i++) {
    const character = text[i]
    if (character === '\\') { i++; continue }
    if (quote) { if (character === quote) quote = null; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
    else if (!depth && separator.test(character)) { parts.push(text.slice(start, i).trim()); start = i + 1 }
  }
  return [...parts, text.slice(start).trim()].filter(Boolean)
}

export const cssSelectors = text => splitOutside(text, /,/)
export const selectorSubject = selector => splitOutside(selector, /[\s>+~]/).at(-1) || ''

export function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => !match[1].trim().startsWith('@'))
    .map(match => ({ selector: match[1].trim(), body: match[2] }))
}
