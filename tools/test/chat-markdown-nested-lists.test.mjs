import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { markdownTree, directLists, items } from './helpers/chat-markdown-tree.mjs'
for(const indent of ['  ','    ','\t']) test(`nested bullets preserve hierarchy with indent ${JSON.stringify(indent)}`,()=>{
 const outer=directLists(markdownTree('- top\n'+indent+'- nested\n- back'))[0]
 assert.equal(items(outer).length,2)
 const nested=directLists(items(outer)[0])[0]
 assert.equal(nested.tagName,'UL')
 assert.equal(items(nested)[0].textContent,'nested')
 assert.equal(items(outer)[1].textContent,'back')
})
test('an ordered list keeps counting across a nested level',()=>{
 const outer=directLists(markdownTree('1. one\n    1. nested\n2. two'))[0]
 assert.equal(items(outer).length,2)
 assert.equal(directLists(items(outer)[0])[0].tagName,'OL')
})
test('a nested list can use numbers or tasks without changing its parent',()=>{
 const numbered=directLists(markdownTree('- top\n  1. first\n  2. second'))[0]
 assert.equal(directLists(items(numbered)[0])[0].tagName,'OL')
 const tasks=directLists(markdownTree('- release\n  - [ ] cut it\n  - [x] publish it'))[0]
 assert.equal(tasks.classList.contains('md-task-list'),false)
 const nested=directLists(items(tasks)[0])[0]
 assert.equal(nested.querySelectorAll('.md-task').length,2)
 assert.equal(nested.querySelectorAll('.is-complete').length,1)
})
test('returning to a shallower depth rejoins that list',()=>{
 const outer=directLists(markdownTree('- one\n  - a\n  - b\n- two'))[0]
 assert.equal(items(outer).length,2)
 assert.equal(items(directLists(items(outer)[0])[0]).length,2)
})
test('flat lists retain all items and ordinary bullets do not become tasks',()=>{
 for(const source of ['- one\n- two','1. one\n2. two','- [ ] first\n- ordinary follow-up']) {
  const list=directLists(markdownTree(source))[0]
  assert.equal(items(list).length,2)
  assert.equal(items(list)[1].classList.contains('md-task'),false)
 }
})
test('a rule, heading, or different marker ends the list',()=>{
 for(const [tail,tag] of [['---','HR'],['## After','H4'],['1. numbered','OL']]) assert.deepEqual(markdownTree('- one\n'+tail).children.map(n=>n.tagName),['UL',tag])
})
test('all surfaces share the compact nested-list spacing rule',()=>{
 const css=readFileSync(new URL('../../src/chat-content.css',import.meta.url),'utf8')
 assert.match(css,/\.chat-message-body \.md-list \.md-list\s*\{[^}]*margin-top:\s*\.4em;[^}]*margin-bottom:\s*\.2em;/)
})
