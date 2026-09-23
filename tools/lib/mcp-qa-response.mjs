function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rpcResult(answer, method) {
  if (!plainObject(answer)) throw new Error(`${method} returned no JSON-RPC response object`)
  if (answer.__timeout) throw new Error(`${method} timed out`)
  if (answer.__transportError) throw new Error(`${method} transport failed: ${String(answer.__transportError).slice(0, 500)}`)
  if (answer.jsonrpc !== '2.0') throw new Error(`${method} returned a non-JSON-RPC-2.0 envelope`)
  if (Object.hasOwn(answer, 'error')) {
    const code = plainObject(answer.error) ? answer.error.code : '<malformed>'
    const message = plainObject(answer.error) ? answer.error.message : answer.error
    throw new Error(`${method} returned JSON-RPC error ${code ?? '<missing>'}: ${String(message ?? '').slice(0, 500)}`)
  }
  if (!Object.hasOwn(answer, 'result') || !plainObject(answer.result)) {
    throw new Error(`${method} returned a malformed JSON-RPC result`)
  }
  return answer.result
}

export function validateInitializeResponse(answer, expectedProtocolVersion) {
  if (typeof expectedProtocolVersion !== 'string' || expectedProtocolVersion.length === 0) {
    throw new TypeError('initialize validation requires the exact requested protocol version')
  }
  const result = rpcResult(answer, 'initialize')
  if (result.protocolVersion !== expectedProtocolVersion ||
      !plainObject(result.capabilities) || !plainObject(result.serverInfo) ||
      typeof result.serverInfo.name !== 'string' || result.serverInfo.name.length === 0 ||
      typeof result.serverInfo.version !== 'string' || result.serverInfo.version.length === 0) {
    throw new Error(`initialize did not return the exact requested ${expectedProtocolVersion} protocolVersion/capabilities/serverInfo result`)
  }
  return result
}

export function validateToolsListResponse(answer, { requireNonEmpty = true } = {}) {
  const result = rpcResult(answer, 'tools/list')
  if (!Array.isArray(result.tools)) throw new Error('tools/list must return a tools array')
  if (requireNonEmpty && result.tools.length === 0) throw new Error('tools/list must return a nonempty tools array')
  const names = new Set()
  for (const tool of result.tools) {
    if (!plainObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error('tools/list returned a tool without a nonempty name')
    }
    if (names.has(tool.name)) throw new Error(`tools/list returned duplicate tool name ${tool.name}`)
    names.add(tool.name)
  }
  return result.tools
}
