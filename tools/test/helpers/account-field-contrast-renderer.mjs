/* The signed-out Account page form and the first-run Account step, in the
   page containers they are drawn in, measured per theme: each empty field's
   border against the background behind the field. */
import '../../../src/styles.css'
import '../../../src/settings.css'
import '../../../src/fleet-profile-settings.css'
import '../../../src/setup.css'
import { formMarkup, setupAccountStepMarkup } from '../../../src/account-markup.js'

const signedOut = { available: true, signedIn: false, accountCount: 0, canPersistSession: true }
const parse = value => {
  const match = /rgba?\(([^)]+)\)/.exec(value || '')
  if (!match) return null
  const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number)
  return { r, g, b, a }
}
const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
})
/* The colour actually behind an element: every ancestor's background,
   composited from the root down. */
function backdrop(element) {
  const chain = []
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) chain.unshift(parse(getComputedStyle(node).backgroundColor))
  return chain.reduce((below, layer) => layer && layer.a > 0 ? over(layer, below) : below, { r: 255, g: 255, b: 255, a: 1 })
}
const luminance = ({ r, g, b }) => [r, g, b].map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

window.accountFieldContrast = {
  measure({ theme, surface }) {
    document.documentElement.dataset.theme = theme
    document.body.innerHTML = `<main class="view-pad setup-page"><div class="settings-shell setup-shell"><section class="settings-section setup-section" ${surface === 'account' ? 'data-account-section' : ''}></section></div></main>`
    const section = document.querySelector('.setup-section')
    section.innerHTML = surface === 'account'
      ? formMarkup({ mode: 'create', state: signedOut })
      : setupAccountStepMarkup({ accountState: signedOut, mode: 'create', actions: '<div class="setup-actions"></div>' })
    const fields = [...section.querySelectorAll('input.fleet-profile-input:not([hidden])')]
    return {
      theme: document.documentElement.dataset.theme,
      fields: fields.map(field => {
        const style = getComputedStyle(field)
        const behind = backdrop(field.parentElement)
        const edges = ['Top', 'Right', 'Bottom', 'Left'].map(side => ({
          side, width: parseFloat(style[`border${side}Width`]), style: style[`border${side}Style`], color: style[`border${side}Color`],
        })).filter(edge => edge.width > 0 && edge.style !== 'none')
        const best = edges.map(edge => {
          const color = parse(edge.color)
          return color ? contrast(over(color, behind), behind) : 0
        })
        return { name: field.name || field.dataset.setupAccountField, edges: edges.map(edge => edge.side), ratio: Math.max(0, ...best), height: field.getBoundingClientRect().height }
      }),
    }
  },
}
