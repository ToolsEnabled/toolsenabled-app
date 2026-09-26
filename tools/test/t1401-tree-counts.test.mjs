import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { Element, installDomStandIn } from './lib/dom-stand-in.mjs'

test('T1401 graph count copy is singular for one agent and plural otherwise', t => {
  const { document, restore } = installDomStandIn()
  t.after(restore)

  const runtimeNode = new Element('div', document)
  const runtime = new Element('div', document)
  runtime.className = 'node-runtime'
  runtimeNode.appendChild(runtime)
  const runtimeSubject = Object.create(StaticTreeGraph.prototype)
  runtimeSubject._renderRuntime({
    agent: { name: '1 agent', treeScope: { group: true, summary: { total: 1 } } },
    el: runtimeNode,
  })
  assert.equal(runtime.querySelector('.rl').textContent, 'agent')

  const box = document.createElement('div')
  box.innerHTML = `<div class="tree-box-heading"><div class="node-labels"><span class="node-name"><span class="nn-t"></span></span><span class="node-role"></span></div><div class="tree-box-actions"><button class="tree-box-chat"></button><button class="tree-box-add-agent"></button></div></div><div class="tree-box-status-row"><span class="tree-box-status"></span><div class="node-runtime"></div><span class="tree-box-context-indicators"></span><button class="tree-box-branch"></button></div><div class="tree-box-latest-action"></div><div class="tree-box-context"><div class="tree-box-thinking"></div><p></p></div>`
  const query = box.querySelector.bind(box)
  box.querySelector = selector => selector === '.tree-box-context > p'
    ? query('.tree-box-context').querySelector('p')
    : query(selector)
  const boxSubject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    cardSize: 'medium',
    previewFitter: { watch() {} },
    _scopeModel: () => ({ summary: () => ({ total: 1 }), groups: new Map() }),
    _screenContext: () => ({ current: '', task: '', tool: '', chat: '', previous: '', unavailable: '', thinking: '', scope: '' }),
    _canExtend: () => false,
  })
  boxSubject._renderBoxPreview({
    id: 'root',
    agent: { id: 'root', name: 'Controller', role: 'controller', state: 'draft', treeScope: { group: false } },
    el: box,
  })
  const branch = box.querySelector('.tree-box-branch')
  assert.equal(branch.textContent, '1 agent  ›')
  assert.equal(branch.title, '1 agent in this branch')
})
