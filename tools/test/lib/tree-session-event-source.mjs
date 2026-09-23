import { parseAst } from 'rollup/parseAst'

// Find complete production callbacks, including the dispatcher shared by live
// events and recovered history. No fixed character windows or callback copies.
export function treeSessionEventSource(source) {
  const dispatchers = [], subscribers = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier'
      && node.left.name === 'handleAgentEvent') dispatchers.push(node.right)
    if (node.type === 'CallExpression'
      && source.slice(node.callee.start, node.callee.end) === 'window.mcAgent.onEvent') subscribers.push(node.arguments[0])
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  if (dispatchers.length !== 1 || subscribers.length !== 1) {
    throw new Error(`Expected one tree event dispatcher and subscriber; found ${dispatchers.length} and ${subscribers.length}`)
  }
  const dispatcherNode = dispatchers[0], subscriberNode = subscribers[0]
  return {
    dispatcherNode,
    dispatcher: source.slice(dispatcherNode.start, dispatcherNode.end),
    subscriber: source.slice(subscriberNode.start, subscriberNode.end),
  }
}
