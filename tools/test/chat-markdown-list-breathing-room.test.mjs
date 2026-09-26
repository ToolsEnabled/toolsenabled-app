import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownTree, directLists, items } from './helpers/chat-markdown-tree.mjs'
for(const [source, count] of [['1. first\n\n2. second\n\n3. third',3], ['- one\n\n- two',2], ['- one\n\n\n\n- two',2], ['- one\n\n',1]]) {
 test(`blank lines preserve one list: ${JSON.stringify(source)}`,()=>{
  const lists=directLists(markdownTree(source))
  assert.equal(lists.length,1)
  assert.equal(items(lists[0]).length,count)
 })
}
test('an indented item after a blank line remains a child',()=>{
 const outer=directLists(markdownTree('- top\n\n  - nested\n\n- back'))[0]
 assert.equal(items(outer).length,2)
 assert.equal(directLists(items(outer)[0]).length,1)
 assert.equal(items(directLists(items(outer)[0])[0])[0].textContent,'nested')
})
test('an indented continuation paragraph remains inside its numbered step',()=>{
 const outer=directLists(markdownTree('1. First.\n\n   More detail for the first step.\n\n2. Second.'))[0]
 assert.equal(items(outer).length,2)
 assert.equal(items(outer)[0].querySelectorAll('p').length,2)
 assert.match(items(outer)[0].textContent,/More detail/)
})
test('unindented prose, headings, and fences after a blank line end a list',()=>{
 for(const [tail,tag] of [['A paragraph.','P'],['## After','H4'],['```\ncode\n```','FIGURE']]){
  const host=markdownTree('- one\n\n'+tail)
  assert.deepEqual(host.children.map(child=>child.tagName),['UL',tag])
 }
})
test('a marker change starts a second list across a blank line',()=>{
 assert.deepEqual(directLists(markdownTree('- bullet\n\n1. numbered')).map(list=>list.tagName),['UL','OL'])
})
