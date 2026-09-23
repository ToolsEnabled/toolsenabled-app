/* TWO WAYS A THEME TOKEN MAKES TEXT TOO FAINT TO READ, each pinned by the
 * measurement that found it.
 *
 * Both shipped, and both were invisible to every existing suite, because each
 * is a correct-looking declaration that only goes wrong once the cascade or the
 * theme resolves it. They were found by walking every route on every theme in a
 * real renderer, opening each page's dialogs and tabs, and computing the
 * composited contrast of every text run against what is actually painted behind
 * it (2026-09-11, 179 opened surfaces).
 *
 *   1. THE RING COLOUR USED AS SMALL TEXT. --c-<id> is the colour a role's
 *      circle is drawn in, chosen to sit against a surface rather than to be
 *      read on one, and --ui-accent is `var(--c-coordinator)` (src/styles.css).
 *      src/role-colors.js already publishes the answer: --role-text-<id>, the
 *      same hue toned to 4.5:1 against the LIVE theme. Using the first where
 *      the second belongs measured 3.52:1 on two tree-workspace labels and
 *      3.83-4.30:1 on the Settings saved-profile label.
 *
 *   2. A LATER RULE AT EQUAL SPECIFICITY STEALING `color` FROM A FILLED STATE.
 *      The research workflow's "All modules" chip is styled quiet -- pushed to
 *      the end, dashed edge, --ink-2 text -- and that colour also applied while
 *      it was the SELECTED tab, so it kept the pressed rule's --ink fill and
 *      took --ink-2 text back over it: 2.32:1 white, 1.63:1 black, 1.27:1 tan.
 *      The shape belonged to both states; only the colour belonged to one.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT. A first draft also failed any
 * bare `var(--ui-accent)`, on the belief that the token was undefined. It is
 * not -- src/styles.css:122 declares it and the ember/cobalt block overrides
 * it -- and the sixty-odd decorative reads of it across the app are correct.
 * Measuring the running renderer is what settled that; a static scan had
 * produced the opposite answer. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { colorContrast } from '../../src/role-colors.js'

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), 'utf8')
/* Comments carry prose about tokens; only declarations are the subject here. */
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '')

/* The accent those labels used to take, against every ground it can land on.
   Kept as data so the reason this rule exists is checkable, not just asserted:
   if a future palette makes the raw accent pass everywhere, this test says so
   instead of quietly outliving its cause. */
const ACCENT_ON_GROUND = [
  ['black', '#428ea7', ['#2e3136', '#212327']],
  ['white', '#287f9b', ['#ffffff', '#f4f7fa']],
  ['tan', '#277b96', ['#fbf1c7', '#f2e5bc']],
]

test('the raw coordinator accent really is too faint for small text', () => {
  const failures = []
  for (const [theme, accent, grounds] of ACCENT_ON_GROUND) {
    for (const ground of grounds) {
      if (colorContrast(accent, ground) < 4.5) failures.push(`${theme} ${accent} on ${ground}`)
    }
  }
  assert.ok(failures.length >= 5,
    'mutation `assume the raw accent is readable` survived: five of these six pairings measured under AA 4.5, '
    + `and that is why the two rules below take the toned token instead; got ${failures.length}`)
})

test('small text takes the toned role colour, never the raw ring colour', () => {
  /* Named individually rather than swept: --c-<id> is exactly right for a
     border, a ring or a wash, and these rules are only about text. */
  const sheets = [
    ['tree-workspace.css', ['.tree-edit-picker-select-all', '.tree-window-label']],
    ['settings-profile-settings.css', ['.working-profile-current-name', '.working-profile-state span']],
  ]
  for (const [sheet, selectors] of sheets) {
    const css = withoutComments(read(sheet))
    for (const selector of selectors) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rules = [...css.matchAll(new RegExp(`([^{}]*${escaped}[^{}]*)\\{([^{}]*)\\}`, 'g'))]
      assert.ok(rules.length > 0, `expected ${sheet} to still style ${selector}`)
      let coloured = false
      for (const [, , body] of rules) {
        const colour = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/)
        if (!colour) continue
        coloured = true
        assert.doesNotMatch(colour[1], /var\(\s*--(?:c-[a-z-]+|ui-accent|theme-accent)\b/,
          `mutation \`paint ${selector} in the raw accent\` survived: it measured under AA 4.5 against its ground; `
          + 'src/role-colors.js writes --role-text-<id> toned to 4.5:1 for exactly this')
        /* A neutral like --ink-3 is a perfectly good answer for a label that
           is not trying to be role-coloured -- .tree-window-label's resting
           rule is exactly that. The rule is only that a ROLE colour reaching
           text must be the toned one, and must carry a fallback, because
           --role-text-<id> is written at runtime by applyRoleColors() and a
           render before that runs needs a real colour to land on. */
        if (/var\(\s*--role-text-/.test(colour[1])) {
          assert.match(colour[1], /var\(\s*--role-text-[a-z-]+\s*,/,
            `mutation \`drop the fallback behind the toned token\` survived: ${selector} would have no colour at all `
            + 'until applyRoleColors() runs')
        }
      }
      assert.ok(coloured, `expected ${selector} to still choose a text colour of its own`)
    }
  }
})

test('the quiet chip stays quiet only while it is not the selected tab', () => {
  /* The regression that reopens this is a one-clause deletion: drop the :not()
     and the rule reaches the pressed state again, where it fights an --ink fill
     it does not own. */
  const css = withoutComments(read('research.css'))
  const rules = [...css.matchAll(/([^{}]*data-research-area="all"[^{}]*)\{([^{}]*)\}/g)]
  assert.ok(rules.length > 0, 'expected the All modules chip to still be styled')
  const colouring = rules.filter(([, , body]) => /(?:^|;)\s*color\s*:/.test(body))
  assert.ok(colouring.length > 0, 'expected the All modules chip to still choose a text colour')
  for (const [, selector] of colouring) {
    assert.match(selector, /:not\(\s*\[aria-pressed="true"\]\s*\)/,
      'mutation `let the quiet chip colour apply while it is pressed` survived: the pressed recipe fills with --ink '
      + 'and this rule follows it at equal specificity, so an unscoped colour here put --ink-2 text on an --ink fill '
      + '(2.32:1 white, 1.63:1 black, 1.27:1 tan)')
  }
})

test('the pressed workflow tab still supplies its own text colour', () => {
  /* The other half of the pairing: scoping the chip is only correct while the
     pressed rule really does set a colour for it to fall through to. */
  const css = withoutComments(read('research.css'))
  const pressed = [...css.matchAll(/\.research-workflow-nav button\[aria-pressed="true"\]\s*\{([^{}]*)\}/g)]
  assert.ok(pressed.length > 0, 'expected the pressed workflow tab rule to exist')
  assert.ok(pressed.some(([, body]) => /background\s*:\s*var\(--ink\)/.test(body) && /color\s*:\s*var\(--bg\)/.test(body)),
    'mutation `drop the pressed tab\'s own text colour` survived: the quiet chip now defers to this rule, '
    + 'so a pressed tab with a fill and no colour of its own would inherit the quiet one again')
})

test('the vault credentials panel colours its text from tokens the themes declare', () => {
  /* 3. A TOKEN NO SHEET DECLARES. src/vault-credentials-settings.css coloured its
     body and label text with `var(--ink2, #555)`. The product token is --ink-2;
     nothing declares --ink2, so the fallback grey was what EVERY theme painted:
     measured 2.11:1 on Black in a real renderer (2026-09-21), on the sentence
     that says whether the vault could be read. A fallback is for a missing
     stylesheet, not a substitute for the theme. */
  const panel = withoutComments(read('vault-credentials-settings.css'))
  const declared = withoutComments(read('styles.css')) + withoutComments(read('theme-refinements.css'))
  const used = [...panel.matchAll(/(?:^|[;{\s])color:\s*var\(\s*(--[a-z0-9-]+)/g)].map(match => match[1])
  assert.ok(used.length >= 3, 'the panel still colours its text from tokens')
  const undeclared = [...new Set(used)].filter(token => !new RegExp(`(?:^|[;{\\s])${token}\\s*:`).test(declared))
  assert.deepEqual(undeclared, [], `text colour tokens no sheet declares: ${undeclared.join(', ')}`)
})
