// A speech-only, bounded Markdown presentation filter. Never use this to
// interpret user commands or Accessibility consent previews. Written messages
// stay untouched. Formatting-heavy lines wait for their newline/end so links,
// emphasis and fences split across agent deltas cannot leak into TTS.
const LIMIT = 4096
const DECORATION = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\u200d\ufe0e\ufe0f\u20e3\u{e0020}-\u{e007f}✓✗]/gu
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function plain(text, lineStart) {
  let value = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ENTITIES[entity.slice(1, -1)])
  if (lineStart) {
    if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|[| :\-]+)\s*$/.test(value)) return ''
    value = value.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')
      .replace(/^\s*>+\s?/, '')
      .replace(/^\s*(?:[-+*•]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
  }
  return value
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/<https?:\/\/[^>\s]+>/gi, 'link')
    .replace(/<\/?[a-z][^>\n]*>/gi, '')
    .replace(/https?:\/\/[^\s)<>]+/gi, url => 'link' + (url.match(/[.,;!?]+$/)?.[0] || ''))
    .replace(/\b\d+(?:\.\d+)?\s*\*\s*[-+]?\d+(?:\.\d+)?\b/g, expression => expression.replace('*', ' times '))
    .replace(/[0-9#*]\ufe0f?\u20e3/g, '')
    .replace(DECORATION, '')
    .replace(/[`*]|~~/g, '')
    .replace(/(?<=\w)_(?=\w)/g, ' ')
    .replace(/_/g, '')
    .replace(/\|/g, ', ')
    .replace(/[\t ]+/g, ' ')
}

export function createSpeechText() {
  let buffer = '', lineStart = true, fence = null, skippingLine = false
  function line(text, newline) {
    if (skippingLine) { if (newline) skippingLine = false; return '' }
    if (fence) {
      if (lineStart && new RegExp('^ {0,3}' + fence.character + '{' + fence.length + ',}\\s*$').test(text)) fence = null
      return ''
    }
    const opening = lineStart && text.match(/^ {0,3}(`{3,}|~{3,})/)
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length }
      return 'Code block is in the written reply. '
    }
    const result = plain(text, lineStart)
    if (!newline || !result.trim()) return result
    return result.trimEnd() + (/[.!?:;]$/.test(result.trimEnd()) ? ' ' : '. ')
  }
  return Object.freeze({
    write(text, final = false) {
      buffer += text
      let output = ''
      while (buffer) {
        const end = buffer.indexOf('\n')
        if (end >= 0 && end <= LIMIT) {
          output += line(buffer.slice(0, end).replace(/\r$/, ''), true)
          buffer = buffer.slice(end + 1); lineStart = true
        } else if (!fence && !skippingLine
            && !/[`*_~\[\]<>#|]|https?:/i.test(buffer)
            && !(lineStart && /^\s*(?:[-+•>]|\d+[.)])(?:\s|$)/.test(buffer))
            && (/[.!?](?:\s|$)$/.test(buffer) || buffer.length >= 220)) {
          output += plain(buffer, lineStart); buffer = ''; lineStart = false
        } else if (buffer.length > LIMIT) {
          // Do not leak a half link/fence or retain an unbounded formatted line.
          if (!fence && !skippingLine) output += 'Long section is in the written reply. '
          skippingLine = true; buffer = buffer.slice(LIMIT); lineStart = false
        } else if (final) {
          output += line(buffer, false); buffer = ''
        } else break
      }
      return output
    },
  })
}
