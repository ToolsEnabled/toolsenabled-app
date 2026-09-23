/* THE DEFECTS THAT ARE NOT IN ANY ONE STRING.
 *
 * tools/check-plain-language.mjs measures string literals, one at a time, per
 * file. It is a good gate and it exited 0 on both of the screens the owner
 * called unreadable, because neither defect is a property of a string:
 *
 *   ITEM 8, the Codex Cloud panel. Two adjacent <output> elements carrying two
 *   near-identical 47-word paragraphs. Each paragraph was fine. There were two
 *   of them because one refusal was published into two independent state slots,
 *   and the panel showed both.
 *
 *   ITEM 11, the R ledger. "This folder's work list could not be read" at the
 *   top, red dead forms in the middle, and a calm "this copy does not keep one,
 *   so there is nothing here to show" at the bottom. Three stories about one
 *   state, from a repair that was applied to one line and not to the chrome
 *   around it. Every sentence individually true.
 *
 *   AND, ON THE SAME PAGE: two fields that asked for "its number, as shown in
 *   the list" on a screen whose list was empty. A per-string check cannot know
 *   whether there is a list.
 *
 * So this measures a PANEL IN A STATE: every string that state puts on the
 * screen at once, plus whether the register that state shows has anything in
 * it. Three rules, each one written from a defect that shipped.
 *
 * IT HOLDS THE RULES AND NOT THE PRODUCT. The panels themselves are built in
 * ./composed-panels.mjs from the product's own modules. This file has no
 * imports from src/ and can therefore be driven by tools/test/composed-output.test.mjs
 * against hand-built panels -- which is the only way to prove a check can go
 * red, and a check that cannot fail is worthless.
 */

import { sentencesOf, wordsOf } from './user-visible-strings.mjs'

export const COMPOSED_RULES = Object.freeze([
  'same-sentence-twice',
  'two-stories',
  'points-at-an-absent-list',
])

/* SIX WORDS. Below that, a repeated sentence is a shared idiom -- "Nothing was
   sent.", "Try it again." -- and repeating one of those in two places on a
   panel is ordinary English rather than a duplicated message. At six and above
   it is the same paragraph twice, which is what the owner was looking at. */
const DUPLICATE_MIN_WORDS = 6

/* A slot that reports something did not work. The vocabulary is the same one
   tools/check-plain-language.mjs uses for its dead-end rule, plus the two
   phrases this product writes for a read that answered nothing. */
const FAILURE_TEXT = /\b(could not|cannot|unavailable|unable|refused|failed|failure|not answering|did not answer|is off|are off|went wrong|malformed|unreachable)\b/i
const FAILURE_TONES = Object.freeze(new Set(['refused', 'unavailable', 'bad', 'error']))

/* A slot that reports there is simply nothing, which is an ANSWER. The two are
   opposite facts about the same read and a person shown both at once has no way
   to know which one is true of their computer. */
const EMPTY_TEXT = /\b(nothing here to show|nothing to show|there is nothing|nothing yet|none yet|no .{0,40}\byet\b|does not keep one|is quiet|there are none)\b/i

/* A field or a sentence that sends the reader to a list. Each alternative is
   here because a real string on this tree matches it. */
const POINTS_AT_A_LIST = /\b(as shown in the (?:list|table|register)|in the (?:list|table|register) above|from the (?:list|table|register) above|the (?:list|table|register) (?:above|below)|listed above|shown above|chosen above)\b/i

const normalise = text => String(text ?? '').replace(/\s+/g, ' ').trim()

/* What a slot is ABOUT. Declared per slot where a panel talks about more than
   one thing; otherwise the panel itself, so nothing goes unmeasured by
   forgetting to declare. */
const subjectOf = (slot, panel) => String(slot?.subject || panel?.panel || 'this panel')
const sentenceKey = text => normalise(text).toLowerCase().replace(/[.!?…,;:·]+$/g, '').trim()

/** Does this slot report a failure? */
export function readsAsFailure(slot) {
  if (FAILURE_TONES.has(String(slot?.tone || ''))) return true
  return FAILURE_TEXT.test(String(slot?.text || ''))
}

/** Does this slot report that there is nothing, which is not the same thing? */
export function readsAsEmpty(slot) {
  const text = String(slot?.text || '')
  if (!EMPTY_TEXT.test(text)) return false
  /* A sentence can say both -- "could not be read, so there is nothing here" --
     and that is one story, not two. Only a slot that says ONLY "there is
     nothing" is an empty-state slot. */
  return !FAILURE_TEXT.test(text)
}

/**
 * Every finding in ONE panel in ONE state.
 *
 * @param panel {{ panel, state, why, slots: [{name, tone, text}], list: {name, itemCount}|null }}
 */
export function findingsInPanel(panel) {
  const found = []
  const slots = (panel?.slots || []).filter(slot => normalise(slot?.text).length > 0)

  /* ---- 1. the same sentence rendered twice in one panel ---- */
  const seen = new Map()
  for (const slot of slots) {
    for (const sentence of sentencesOf(slot.text)) {
      if (wordsOf(sentence).length < DUPLICATE_MIN_WORDS) continue
      const key = sentenceKey(sentence)
      if (!key) continue
      const first = seen.get(key)
      if (first && first !== slot.name) {
        found.push({
          rule: 'same-sentence-twice',
          detail: `“${first}” and “${slot.name}” both show this sentence, so the panel says it twice. Publish the condition into one slot and leave the other empty.`,
          excerpt: normalise(sentence),
        })
      } else if (!first) {
        seen.set(key, slot.name)
      }
    }
  }

  /* ---- 2. an empty state and a failure state, at the same time ----
   *
   * TWO SHAPES, AND THE SECOND IS THE ONE THAT SHIPPED. The obvious shape is
   * two slots disagreeing. The subtler one is a SINGLE slot whose words say
   * "there is nothing here" while the state it is drawn in says the read
   * failed -- which is precisely what a repair applied to the paragraph and
   * not to the chrome around it produces. */
  for (const slot of slots) {
    if (!FAILURE_TONES.has(String(slot.tone || ''))) continue
    if (!readsAsEmpty(slot)) continue
    found.push({
      rule: 'two-stories',
      detail: `“${slot.name}” is painted as a failure, and its own words say there is simply nothing to show. Those are opposite facts; pick the one that is true and paint it that way.`,
      excerpt: normalise(slot.text),
    })
  }
  /* SCOPED TO ONE SUBJECT, and the scoping is not a loophole. "There are no
     requests" and "that folder's work list could not be read" are two true
     statements about two different things, and a panel is allowed to make both.
     What it may not do is say both about the SAME thing, which is exactly the
     shape that shipped: one paragraph about the request register saying there
     is nothing, inside chrome about the request register saying it could not be
     read. A slot with no declared subject belongs to the panel, so an
     undeclared panel is still measured as a whole. */
  const empties = slots.filter(slot => readsAsEmpty(slot) && !FAILURE_TONES.has(String(slot.tone || '')))
  for (const empty of empties) {
    const clash = slots.find(slot => slot.name !== empty.name
      && subjectOf(slot, panel) === subjectOf(empty, panel)
      && readsAsFailure(slot))
    if (!clash) continue
    found.push({
      rule: 'two-stories',
      detail: `“${empty.name}” says there is nothing to show while “${clash.name}” says it could not be read, and both are about ${subjectOf(empty, panel)}. Those are opposite facts; pick the one that is true and say only that.`,
      excerpt: `${normalise(empty.text)}  ||  ${normalise(clash.text)}`,
    })
    break
  }

  /* ---- 3. a field that points at a list this state does not have ---- */
  const listIsAbsent = !panel?.list || Number(panel.list.itemCount) === 0
  if (listIsAbsent) {
    for (const slot of slots) {
      if (!POINTS_AT_A_LIST.test(slot.text)) continue
      found.push({
        rule: 'points-at-an-absent-list',
        detail: panel?.list
          ? `“${slot.name}” sends the reader to “${panel.list.name}”, which has nothing in it in this state. Say what the field is, or turn the control off with the reason.`
          : `“${slot.name}” sends the reader to a list this panel does not show. Say what the field is, or turn the control off with the reason.`,
        excerpt: normalise(slot.text),
      })
    }
  }

  return found
}

/** Identity is panel + state + rule + the text, never a line number. */
export function identityOf(finding) {
  return `${finding.panel}\t${finding.state}\t${finding.rule}\t${normalise(finding.excerpt)}`
}
