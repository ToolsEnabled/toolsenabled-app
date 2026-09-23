/* WHAT A PERSON ACTUALLY READS, PULLED OUT OF THE SOURCE.
 *
 * WHY THIS IS A MODULE AND NOT A REGEX IN A CHECKER.
 *
 * Every copy rule this repository has wanted to enforce -- no bare identifier in
 * front of a person (B6), no unexplained mechanism name on the home screen, no
 * price literal on the subscription page -- has run into the same wall: a naive
 * text scan over a .js file measures the wrong thing. It reads comments, which in
 * this codebase QUOTE the sentences they replaced, so the scan finds the defect
 * in the note explaining that the defect was removed. It reads identifiers,
 * selectors and class names, which look like violations and are not. And it reads
 * lines, when what a person sees is a STRING.
 *
 * tools/test/refusal-copy.test.mjs solved the first half of that -- a comment
 * stripper that knows a `//` inside a string and a `/*` inside a template literal
 * are not comments, and that a `/` after `(` is a regex while a `/` after an
 * identifier is division. That stripper is the hard, proven part and it is moved
 * here VERBATIM rather than rewritten, so there is one of it and the suite that
 * already exercises it goes on exercising it.
 *
 * WHAT IS NEW HERE is the second half: turning stripped source into the list of
 * things a person reads. That means
 *
 *   - every string literal, with the line it is on;
 *   - a template literal split into its STATIC chunks, because `${...}` is a
 *     value and the words around it are the copy;
 *   - HTML tags removed from those chunks, because this codebase builds its
 *     screens out of template literals and the prose is what sits between the
 *     tags; and
 *   - everything that is plainly not prose thrown away: selectors, routes,
 *     class lists, event names, CSS declarations, bare identifiers.
 *
 * THE THROWING-AWAY IS THE PART THAT DECIDES WHETHER THIS IS USEFUL. A scanner
 * that reports `settings-row` as a sentence is a scanner somebody switches off in
 * a week. So `isProse()` is deliberately conservative and every rejection reason
 * has a name, and `describeRejections()` exists so a caller can show what was
 * skipped rather than leaving the coverage to be taken on trust. An empty
 * extraction is a FAULT to its callers, never a clean sweep -- the same rule
 * tools/check-suites-discovered.mjs applies to the test runner.
 *
 * IT IS DELIBERATELY NOT AN AST PARSE. `node --test` runs these suites with no
 * dependencies, this repo ships none for tooling, and the character walker below
 * is already the thing whose edge cases have been measured against this actual
 * tree. A parser would be more correct in general and less proven here.
 */

/* ---------------------------------------------------------------
   Comments, blanked. Moved verbatim from tools/test/refusal-copy.test.mjs,
   which keeps its own test of the behaviour and now exercises this copy.
   --------------------------------------------------------------- */

/**
 * Replace every comment with spaces, preserving line structure so reported line
 * numbers are the file's own.
 *
 * Three states, and leaving any one of them out has been measured to break it:
 * a `//` inside a string is not a comment, a `/*` inside a template literal is
 * not a comment, and a `/` that opens a regular expression is not division. A
 * scanner that mistakes `.replace(/[&<>"']/g, ...)` for a string sees the `"`
 * inside it and treats the rest of the file as string content.
 */
export function withoutComments(source) {
  let out = ''
  let index = 0
  let quote = null          // ' " or ` while inside a string
  let comment = null        // 'line' or 'block'
  let regex = false         // inside a /regex/ literal
  const regexMayStart = () => {
    const before = out.replace(/\s+$/, '')
    if (before.length === 0) return true
    if (/[([{,;:=!&|?+\-*%~^<>]$/.test(before)) return true
    return /\b(return|typeof|case|in|of|do|else|instanceof|new|delete|void|throw)$/.test(before)
  }
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (regex) {
      out += character
      if (character === '\\') { out += source[index + 1] ?? ''; index += 2; continue }
      if (character === '[') {
        // a character class: a `/` inside it is literal, so run to its close
        while (index + 1 < source.length && source[index + 1] !== ']') {
          index += 1
          out += source[index]
          if (source[index] === '\\') { index += 1; out += source[index] ?? '' }
        }
        index += 1
        out += source[index] ?? ''
        index += 1
        continue
      }
      if (character === '/' || character === '\n') regex = false
      index += 1
      continue
    }
    if (comment === 'line') {
      if (character === '\n') { comment = null; out += character } else out += ' '
      index += 1
      continue
    }
    if (comment === 'block') {
      if (character === '*' && next === '/') { comment = null; out += '  '; index += 2; continue }
      out += character === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (quote) {
      out += character
      if (character === '\\') { out += source[index + 1] ?? ''; index += 2; continue }
      if (character === quote) quote = null
      index += 1
      continue
    }
    if (character === '/' && next === '/') { comment = 'line'; out += '  '; index += 2; continue }
    if (character === '/' && next === '*') { comment = 'block'; out += '  '; index += 2; continue }
    if (character === '/' && regexMayStart()) { regex = true; out += character; index += 1; continue }
    if (character === '\'' || character === '"' || character === '`') { quote = character; out += character; index += 1; continue }
    out += character
    index += 1
  }
  return out
}

/* ---------------------------------------------------------------
   String literals, with their static chunks.
   --------------------------------------------------------------- */

/* A `${` inside a template literal opens an EXPRESSION, and an expression can
   contain another template literal, an object literal, a nested `}`... This
   product's views nest three deep in places (a ternary inside a map inside a
   markup template), so the walker carries a stack rather than a boolean. The
   depth counter only counts braces seen at the CURRENT expression level; a
   string or a nested template pushes its own frame and its braces are that
   frame's problem. */

/**
 * Every string literal in `source`, in source order.
 *
 * @param source  JavaScript, already stripped of comments by withoutComments().
 * @returns [{ quote, line, chunks: [{ line, text }] }]
 *          `chunks` is one entry for a plain string and one per STATIC run for a
 *          template literal. `text` is the literal's own characters with escape
 *          sequences left as written -- unescaping is the caller's business,
 *          because a rule about what a person reads wants `\n` to be whitespace
 *          and a rule about identifiers does not care.
 */
export function extractStringLiterals(source) {
  const literals = []
  let index = 0
  let line = 1
  /* Each frame is either a string being read or an expression being skipped. */
  const stack = []
  const top = () => (stack.length ? stack[stack.length - 1] : null)

  /* THE THIRD STATE, AND LEAVING IT OUT BROKE THE FIRST VERSION OF THIS WALKER.
     Every view in this product opens with an escaper --
     `.replace(/"/g, '&quot;')` -- and a walker that does not know `/"/g` is a
     regular expression sees that `"` as the start of a string and reads the rest
     of the file as string content. Measured: src/write-surfaces.js and
     src/views/setup.js both came back "unterminated" until this landed. The
     may-start test is the same one withoutComments() above uses; `tail` is the
     recent OUTPUT-side context it tests against, kept short because only the
     last token matters. */
  let tail = ''
  const emit = (character) => {
    tail = (tail + character).slice(-24)
  }
  const regexMayStart = () => {
    const before = tail.replace(/\s+$/, '')
    if (before.length === 0) return true
    if (/[([{,;:=!&|?+\-*%~^<>]$/.test(before)) return true
    return /\b(return|typeof|case|in|of|do|else|instanceof|new|delete|void|throw)$/.test(before)
  }

  const openString = (quote) => {
    stack.push({ kind: 'string', quote, startLine: line, chunks: [{ line, text: '' }] })
  }
  const finishString = () => {
    const finished = stack.pop()
    /* A nested literal is copy in its own right -- a ternary inside a template
       produces two real sentences -- so it is recorded separately rather than
       folded into the template that contains it. */
    literals.push({ quote: finished.quote, line: finished.startLine, chunks: finished.chunks })
  }

  const appendToCurrentChunk = (text) => {
    const frame = top()
    if (!frame || frame.kind !== 'string') return
    frame.chunks[frame.chunks.length - 1].text += text
  }

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    const frame = top()

    if (character === '\n') {
      line += 1
      if (frame && frame.kind === 'string') appendToCurrentChunk('\n')
      else emit('\n')
      index += 1
      continue
    }

    if (frame && frame.kind === 'string') {
      if (character === '\\') {
        appendToCurrentChunk(character + (source[index + 1] ?? ''))
        if (source[index + 1] === '\n') line += 1
        index += 2
        continue
      }
      if (character === frame.quote) {
        finishString()
        /* A closed string is a completed value, so a `/` after it is division. */
        emit('x')
        index += 1
        continue
      }
      if (frame.quote === '`' && character === '$' && next === '{') {
        stack.push({ kind: 'expression', depth: 0 })
        tail = '('
        index += 2
        continue
      }
      appendToCurrentChunk(character)
      index += 1
      continue
    }

    /* Inside an expression, or at the top level: the same three-state walk. */
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (character === '/' && regexMayStart()) {
      index += 1
      let inClass = false
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') { index += 2; continue }
        if (inner === '\n') break
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        else if (inner === '/' && !inClass) { index += 1; break }
        index += 1
      }
      emit('x')
      continue
    }

    if (frame && frame.kind === 'expression') {
      if (character === '{') { frame.depth += 1; emit(character); index += 1; continue }
      if (character === '}') {
        if (frame.depth === 0) {
          stack.pop()
          /* Back inside the template: the value is gone and a NEW static chunk
             begins, on this line, because the words after a value are their own
             sentence fragment. */
          const parent = top()
          if (parent && parent.kind === 'string') parent.chunks.push({ line, text: '' })
          index += 1
          continue
        }
        frame.depth -= 1
        emit(character)
        index += 1
        continue
      }
    }

    if (character === '\'' || character === '"' || character === '`') { openString(character); index += 1; continue }
    emit(character)
    index += 1
  }
  /* An unterminated literal means the walk lost its place. Reporting the chunks
     it collected anyway would be reporting a reading it cannot trust, so it says
     so instead -- the doctrine tools/test-ratchet.mjs applies to its own counts. */
  if (stack.length > 0) {
    const error = new Error(`the string walker did not finish: ${stack.length} literal(s) left open, the outermost from line ${stack[0].startLine ?? '?'}`)
    error.code = 'WALKER_UNTERMINATED'
    throw error
  }
  return literals
}

/* ---------------------------------------------------------------
   From a chunk to prose.
   --------------------------------------------------------------- */

const ENTITIES = Object.freeze({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&mdash;': '—', '&ndash;': '–', '&ldquo;': '“', '&rdquo;': '”',
  '&lsquo;': '‘', '&rsquo;': '’', '&hellip;': '…', '&nbsp;': ' ',
})

function unescapeSource(raw) {
  return String(raw ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\r/g, '')
    .replace(/\\(['"`\\$])/g, '$1')
}

function decodeEntities(text) {
  return text.replace(/&[a-z]+;|&#\d+;/gi, match => ENTITIES[match.toLowerCase()] ?? ' ')
}

/**
 * Strip the markup a chunk contains, carrying the tag state ACROSS chunks.
 *
 * WHY THE STATE HAS TO CROSS CHUNKS. This product's views build screens as
 * template literals and interpolate values INSIDE attributes:
 *
 *     `<article data-choice="${esc(choice.tier)}" aria-current="${current}">`
 *
 * split into chunks, that is `<article data-choice="` then `" aria-current="`
 * then `">`. Not one of those three is a complete tag, so a regex for
 * `<[^>]*>` clears none of them and all three arrive at the rules as "prose" --
 * which is how a copy scanner comes to report `aria-current=` as a sentence and
 * gets switched off in a week. A one-character state machine handles it exactly.
 *
 * An HTML comment falls out of the same machine: `<!-- ... -->` opens on `<` and
 * closes on the `>` of `-->`, so its words never reach the rules. That is
 * correct -- a note to the next programmer is not something a person reads.
 */
export function textOfChunk(raw, { inTag = false, separateBlocks = false } = {}) {
  const source = unescapeSource(raw)
  let out = ''
  let tag = inTag
  const boundaries = [0]
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (tag) {
      if (character === '>') tag = false
      continue
    }
    /* A less-than sign is also ordinary copy (for example, "fewer than < 10").
       Only enter tag state when the characters after it can actually begin an
       HTML tag, comment, or declaration. Treating every `<` as markup discarded
       the rest of a user's sentence and could make the copy checks miss it. */
    const beginsTag = character === '<'
      && (/[A-Za-z!?]/.test(source[index + 1] ?? '')
        || (source[index + 1] === '/' && /[A-Za-z]/.test(source[index + 2] ?? '')))
    if (beginsTag) {
      // Adjacent controls and paragraphs are separate pieces of copy. Inline
      // emphasis stays in the same sentence and cannot evade its word bound.
      if (separateBlocks && /^<\/?(?:article|aside|blockquote|br|button|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|label|li|main|nav|ol|option|p|pre|section|select|summary|table|tbody|td|th|thead|tr|ul)(?=[\s/>]|$)/i.test(source.slice(index))) {
        boundaries.push(out.length)
      }
      tag = true; out += ' '; continue
    }
    out += character
  }
  const normalize = text => decodeEntities(text).replace(/\s+/g, ' ').trim()
  const result = { text: normalize(out), inTag: tag }
  if (separateBlocks) {
    boundaries.push(out.length)
    result.parts = boundaries.slice(1).map((end, index) => normalize(out.slice(boundaries[index], end)))
      .filter(Boolean)
  }
  return result
}

/* WHY EACH REJECTION EXISTS. Every one of these was a real hit on this tree the
   first time the extractor was pointed at it, and every one of them is a thing
   nobody reads. They are named rather than folded into one regex so
   `describeRejections()` can report what a scan skipped and why -- a scanner
   whose skips are invisible is a scanner that can quietly stop measuring.
 *
 * ORDER IS PART OF THE MEANING, AND GETTING IT WRONG COSTS THE SUMMARY.
 * `single-token` is the broadest test here -- anything with no whitespace that
 * is not a capitalised word -- so it swallows a bare identifier, a lone
 * interpunct and an acronym, and every one of those reasons would be reported as
 * "single-token" while its own branch sat permanently unreachable. That is a
 * dead rejection the coverage summary goes on printing as though it were doing
 * something, which is the same defect as a test that asserts nothing. So the
 * SPECIFIC reasons come first and the broad one is last, and the suite asserts
 * each one by name against an example that really reaches it. */
const REJECTIONS = Object.freeze([
  Object.freeze({ id: 'empty', test: text => text.length === 0 }),
  /* Punctuation, separators and single characters. */
  Object.freeze({ id: 'punctuation', test: text => !/[A-Za-z]/.test(text) }),
  /* A route, a selector, an attribute name, a custom property: no spaces and a
     shape that only ever appears in code. */
  Object.freeze({ id: 'route-or-selector', test: text => /^[#.[]/.test(text) || /^(data-|aria-|--|\/|\.\/|https?:)/.test(text) }),
  /* SCREAMING_SNAKE on its own is a code being passed around, not shown. The
     rules care about a code EMBEDDED in a sentence; a bare one here is the value
     being looked up. */
  Object.freeze({ id: 'bare-identifier', test: text => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text) }),
  /* No lower-case letter anywhere: an identifier, an acronym list, a constant. */
  Object.freeze({ id: 'no-lowercase', test: text => !/[a-z]/.test(text) }),
  /* A CLASS LIST. Several tokens, all lower case, at least one hyphenated, no
     sentence punctuation: `ctl-btn danger`, `projection-state is-loading`,
     `fleet-profile-status is-serious`. Copy in this product is capitalised or
     punctuated or both, so nothing a person reads looks like this. The hyphen is
     what makes the test safe -- "sign in with google" has none, and would be
     kept. */
  Object.freeze({
    id: 'class-list',
    test: text => !/[A-Z.!?…,;:]/.test(text) && /-/.test(text)
      && text.split(/\s+/).every(token => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(token)),
  }),
  /* CSS. A declaration block or a single property: colons and semicolons and no
     sentence in sight. */
  Object.freeze({
    id: 'css',
    test: text => /^[a-z-]+\s*:\s*[^.!?]*$/.test(text) && /[:;()]/.test(text) && !/[.!?]/.test(text),
  }),
  /* A run of markup attributes left over after the tags came out, e.g. a chunk
     that was only ` class="x" data-y="` around a value. */
  Object.freeze({ id: 'attribute-residue', test: text => /^[a-z-]+="?$/.test(text) || /^"?\s*[a-z-]+="?$/.test(text) }),
  /* A SEARCH INDEX, NOT A SENTENCE. src/setup-profile-settings.js keeps a
     haystack of the words a person might type into the settings filter --
     thirty-three of them, all lower case, joined by spaces, with no punctuation
     anywhere. It is never rendered. The three conditions together are what makes
     this safe to skip: prose of that length always has a comma or a full stop in
     it somewhere, and always has a capital letter. */
  Object.freeze({
    id: 'search-index',
    test: text => !/[.,;:!?—–"'’“()]/.test(text) && !/[A-Z]/.test(text) && text.split(/\s+/).length >= 12,
  }),
  /* One token with no space in it, and the LAST test for the reason above. A
     class name, an event name, an id, a state word used as a value. A LABEL is
     one token too -- "Continue", "Retry", "Approve" -- and the two are told apart
     by the capital: this codebase writes its labels capitalised and its values
     lower case, so `'finished'`, `'helper'` and `'coordinator'` (all real values
     in src/views/agent.js) drop out and every button label stays. */
  Object.freeze({
    id: 'single-token',
    test: text => !/\s/.test(text) && !/^[A-Z][a-z]+$/.test(text),
  }),
])

/** Why this text is not prose, or null when it is. */
export function rejectionFor(text) {
  for (const rejection of REJECTIONS) {
    if (rejection.test(text)) return rejection.id
  }
  return null
}

export function isProse(text) {
  return rejectionFor(text) === null
}

/* Developer-facing strings, which a customer never sees and which must not be
   rewritten into customer prose. A thrown Error is read in a console by whoever
   is holding the repository. The test is on the SOURCE LINE rather than on the
   text, because the text of a developer message and the text of a customer
   message are indistinguishable -- what separates them is where they go. */
const DEVELOPER_SITE = /\b(throw\s+new\s+\w*Error|new\s+(Type|Range|Syntax|Reference)?Error\s*\(|console\.(log|warn|error|info|debug)\s*\(|assert\w*\s*\()/

/* Shader source is program text, including its own comments. Classify it
   before HTML stripping can consume comparison operators. Require GLSL typed
   declarations or a return expression using a symbol declared by such source
   in this same file; mentioning a shader, uniform or identifier in prose does
   not qualify. This is a content classification, like CSS, not a file
   exemption: neighbouring UI copy and nested template values stay visible. */
const GLSL_DECLARATION = /^(?:(?:uniform|varying|attribute|const|in|out|highp|mediump|lowp)\s+)*(?:void|bool|int|float|[biu]?vec[234]|mat[234](?:x[234])?|sampler(?:2D|Cube))\s+([A-Za-z_]\w*)\s*(?:[=;[(])/
function shaderSymbols(literals) {
  const names = new Set()
  for (const literal of literals) for (const chunk of literal.chunks) {
    const code = withoutComments(chunk.text).trim()
    const declaration = GLSL_DECLARATION.exec(code)
    if (declaration) names.add(declaration[1])
  }
  return names
}
function isShaderSource(text, symbols) {
  const code = withoutComments(text).trim()
  if (GLSL_DECLARATION.test(code)) return true
  // A GLSL return fragment may begin with a helper function rather than a type.
  // The semicolon and known shader symbol distinguish it from a prose label.
  return /^return\s+[A-Za-z_]\w*\s*\([^;]*\)\s*;\s*$/.test(code)
    && [...code.matchAll(/[A-Za-z_]\w*/g)].some(match => symbols.has(match[0]))
}

/**
 * Every piece of prose a person can read in one file.
 *
 * @param source   the file's text, comments and all.
 * @returns { visible, skipped }
 *   visible  [{ line, text, sourceLine }]  what a person reads, and the line of
 *            source it came from. `sourceLine` is carried because some rules are
 *            about the string's ROLE and not its words: a sentence handed to
 *            refusalSentence() as its `fallback` is composed with a remedy
 *            before anybody reads it, and a rule that judged it alone would be
 *            judging half a message. Nothing else may use it to excuse a string.
 *   skipped  [{ line, text, reason }]      what was thrown away and why
 */
export function visibleTextFrom(source) {
  const stripped = withoutComments(source)
  const lines = stripped.split('\n')
  const literals = extractStringLiterals(stripped)
  const shaders = shaderSymbols(literals)
  const visible = []
  const skipped = []
  for (const literal of literals) {
    /* Tag state is per LITERAL, because a template's chunks are one document cut
       into pieces by its values. It resets at each literal: a new string starts
       outside a tag whatever the previous one was doing. */
    let inTag = false
    for (const chunk of literal.chunks) {
      if (isShaderSource(chunk.text, shaders)) {
        skipped.push({ line: chunk.line, text: chunk.text, reason: 'shader-source' })
        continue
      }
      const stripped = textOfChunk(chunk.text, { inTag, separateBlocks: true })
      inTag = stripped.inTag
      const sourceLine = lines[chunk.line - 1] ?? ''
      for (const text of stripped.parts.length ? stripped.parts : ['']) {
        if (DEVELOPER_SITE.test(sourceLine)) {
          skipped.push({ line: chunk.line, text, reason: 'developer-message' })
          continue
        }
        const reason = rejectionFor(text)
        if (reason) skipped.push({ line: chunk.line, text, reason })
        else visible.push({ line: chunk.line, text, sourceLine: sourceLine.trim() })
      }
    }
  }
  return { visible, skipped }
}

/** A count per rejection reason, so a caller can print what it did not measure. */
export function describeRejections(skipped) {
  const counts = new Map()
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
}

/* ---------------------------------------------------------------
   Sentences.
   --------------------------------------------------------------- */

/* Abbreviations whose full stop is not the end of a sentence. Short list on
   purpose: a long one starts swallowing real sentence ends. */
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|Mr|Mrs|Ms|Dr|vs|No)\.$/i

/**
 * Split prose into sentences, the way a reader does.
 *
 * A version number, a file name and an ellipsis are not sentence ends, and a
 * splitter that thinks they are reports a "sentence" of two words and misses the
 * forty-word one it was sitting inside.
 */
export function sentencesOf(text) {
  const out = []
  let current = ''
  const characters = [...String(text ?? '')]
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    current += character
    if (!'.!?…'.includes(character)) continue
    const after = characters[index + 1]
    /* `1.0.6`, `codex.exe`, `e.g.` -- a full stop with no space after it is
       inside a token, not between two sentences. */
    if (character === '.' && after && after !== ' ' && after !== '\n') continue
    if (ABBREVIATIONS.test(current.trim())) continue
    /* An ellipsis is a state, not an end: "Saving…" is one sentence. */
    if (character === '…' && !after) { /* still an end */ }
    const trimmed = current.trim()
    if (trimmed) out.push(trimmed)
    current = ''
  }
  const tail = current.trim()
  if (tail) out.push(tail)
  return out
}

/** Words a reader counts: anything with a letter or a digit in it. */
export function wordsOf(sentence) {
  return String(sentence ?? '')
    .split(/\s+/)
    .filter(word => /[A-Za-z0-9]/.test(word))
}
