/* A narrow source seam for nested view functions that cannot be imported in
 * plain Node. Locate one declaration by name, not by its current parameters.
 * V8 decides where the complete function ends: braces in parameters, comments,
 * strings and templates must not make a partial body look complete. This is
 * not a JavaScript module parser and deliberately refuses ambiguous names. */
export function declaredFunctionSource(source, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Invalid function name')
  const escaped = name.replace(/[$]/g, '\\$')
  const starts = [...source.matchAll(new RegExp(`^[\\t ]*(?:async\\s+)?function\\s+${escaped}\\s*\\(`, 'gm'))]
  if (starts.length !== 1) throw new Error(`Expected one declaration of ${name}, found ${starts.length}`)
  const at = starts[0].index
  for (let end = source.indexOf('}', at); end !== -1; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(at, end + 1).trimStart()
    try {
      // Compile only. Do not execute source or its default parameter values.
      new Function(`return (${candidate}\n)`)
      return candidate
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  throw new Error(`No complete function body for ${name}`)
}
