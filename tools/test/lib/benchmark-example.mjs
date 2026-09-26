import assert from 'node:assert/strict'

// Tests of a populated builder opt into their fixture through the same action
// as an author. Production projects now start empty; saved drafts stay intact.
export async function useArithmeticExample(view, { examples = false } = {}) {
  const field = name => view.el.querySelector(`[data-bench-${name}]`)
  const idle = async () => {
    for (let i = 0; i < 300; i++) {
      if (view.el.getAttribute('aria-busy') === 'false') return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('example selection did not settle')
  }
  if (!field('task').querySelectorAll('option').length) {
    field('starter').value = 'generic'; field('use-starter').click(); await idle()
    if (examples) {
      field('load-examples').click(); await idle()
      field('bundle').value = '0'; field('bundle').dispatch('change'); await idle()
    }
  }
}
