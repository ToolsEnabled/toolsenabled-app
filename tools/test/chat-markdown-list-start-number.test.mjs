import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownTree, directLists, items, startAt } from './helpers/chat-markdown-tree.mjs'
for (const [source, start, count] of [
 ['5. step five\n6. step six',5,2], ['1. first\n2. second',1,2],
 ['7. seven\n1. eight\n1. nine',7,3], ['5. step five\n\n6. step six\n\n7. step seven',5,3],
 ['0. zero\n1. one',0,2], ['12. twelve',12,1],
]) test(`numbered items preserve the initial count ${start}: ${JSON.stringify(source)}`, () => {
 const lists=directLists(markdownTree(source))
 assert.equal(lists.length,1)
 assert.equal(startAt(lists[0]),start)
 assert.equal(items(lists[0]).length,count)
 if(start===1) assert.equal(lists[0].getAttribute('start'),null)
 assert.doesNotMatch(items(lists[0])[0].textContent,/^\d+\. /)
})
test('nested lists keep their own starting number',()=>{
 const outer=directLists(markdownTree('3. third\n   4. fourth-a\n   5. fourth-b\n4. fourth'))[0]
 assert.equal(startAt(outer),3)
 assert.equal(items(outer).length,2)
 const nested=directLists(items(outer)[0])[0]
 assert.equal(startAt(nested),4)
 assert.equal(items(nested).length,2)
})
test('switching to a numbered list preserves its new starting number',()=>{
 const lists=directLists(markdownTree('- bullet\n\n9. numbered'))
 assert.deepEqual(lists.map(list=>list.tagName),['UL','OL'])
 assert.equal(startAt(lists[1]),9)
 assert.equal(lists[0].getAttribute('start'),null)
})
