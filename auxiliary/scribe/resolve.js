'use strict';
/**
 * Turning "let's say B but drop the second clause" into an action.
 *
 * This runs on every utterance while a proposal is on screen, which makes it
 * the most dangerous small function in the project: a false positive edits the
 * paper without being asked. So the governing rule is
 *
 *     WHEN IN DOUBT, RETURN none AND LET THE AGENT DECIDE.
 *
 * Returning `none` costs a round trip. Guessing wrong costs the human's trust
 * in every future proposal. The asymmetry is not close.
 *
 * The first version of this file was far too eager, and its own tests caught it
 * doing real damage. Three failures worth remembering, because each one is a
 * trap that any "just look for the option letter" approach walks straight into:
 *
 *   "add a sentence about the judge disagreement"  -> modify A
 *        The English article "a" is also an option id.
 *   "what did we actually do in the second study"  -> accept B
 *        "second" is an ordinary word long before it is an ordinal.
 *   "the last one"                                 -> A
 *        "one" read as the ordinal 1 rather than as a pronoun.
 *
 * Hence: single-letter ids that are real words need an explicit frame,
 * number-words only count when introduced, and questions never resolve.
 *
 * Four outcomes:
 *   accept  - take that option exactly, apply it now, no model call
 *   modify  - they want that option changed; hand the option AND the change to
 *             the agent. Never try to perform the modification here.
 *   dismiss - none of them
 *   none    - not about the proposal at all, pass it through untouched
 */

// Ordinals that are unambiguous on their own.
const STRONG_ORDINALS = {
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3,
};
// Number words that are only ordinals when introduced ("option one", "number two").
const WEAK_ORDINALS = { one: 0, two: 1, three: 2, four: 3 };
// Bare digits count, but only as standalone tokens.
const DIGITS = { 1: 0, 2: 1, 3: 2, 4: 3 };

// Single-letter ids that are also English words. These never match bare.
const WORD_LETTERS = new Set(['a', 'i', 'o']);

const MODIFIERS = [
  'but', 'except', 'without', 'minus', 'plus', 'though', 'however',
  'shorter', 'longer', 'tighter', 'looser', 'simpler', 'stronger', 'softer',
  'add', 'drop', 'remove', 'delete', 'cut', 'change', 'swap',
  'reword', 'rephrase', 'trim', 'expand', 'combine', 'merge', 'mix', 'make it',
];

// An explicit signal that the human is choosing, not just talking.
const ACCEPT_FRAMES = [
  "let's say", 'lets say', "let's go", 'lets go', "let's use", 'lets use',
  'go with', 'i like', 'i want', 'give me', 'that one', 'how about',
  'use', 'say', 'pick', 'take', 'choose', 'option', 'yes', 'yeah', 'yep', 'ok',
];

const DISMISS = [
  'none of those', 'none of them', 'none of these', 'neither', 'no thanks',
  'scrap that', 'scrap them', 'start over', 'try again', 'forget it',
  'none', 'nope', 'no thank you', 'something else', 'try something else',
];

// A question is a request for information, never a selection.
const QUESTION_STARTS = /^(what|why|how|when|where|who|which|whose|can|could|would|should|do|does|did|is|are|was|were|will|shall|may|might|am)\b/;
// A short negative reference is especially dangerous: without this guard,
// "not B" is shaped like the same two-word bare choice as "use B". Negated
// wording always goes to the agent instead of becoming an immediate edit.
const NEGATED_CHOICE = /(^|\s)(?:not|never|don['’]?t|dont)(?=\s|$)/;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")   // curly quotes to straight
    .replace(/^[\s'"`(\[]+|[\s'"`)\].,!?;:]+$/g, '') // strip wrapping punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (t, w) => new RegExp(`(^|\\s)${escapeRe(w)}(\\s|$)`).test(t);

/** Find the earliest option reference in the text, or null. */
function findReference(t, options) {
  const words = t.split(' ');
  const hits = [];

  options.forEach((o, i) => {
    const id = String(o.id).toLowerCase();
    // "option b" / "option 2" is always an explicit reference.
    const framed = new RegExp(`(^|\\s)(option|choice|number|#)\\s*${escapeRe(id)}(?=[\\s,.!?;:]|$)`);
    let m = framed.exec(t);
    if (m) { hits.push({ i, pos: m.index, on: `framed id "${id}"` }); return; }

    // A bare id is allowed, except for letters that are also English words,
    // which need either the frame above or a message short enough that the
    // reference is obviously the whole point.
    //
    // "A plus the caveat" is a real choice. "a lot of these numbers came from
    // the audit" is not, and "add a sentence about X" is not. What separates
    // them is position and length together: the article "a" leads plenty of
    // long sentences, so leading position alone is not enough.
    if (WORD_LETTERS.has(id)) {
      const leadsShortMessage = words[0] === id && words.length <= 4;
      if (words.length > 2 && !leadsShortMessage) return;
    }
    const bare = new RegExp(`(^|\\s)${escapeRe(id)}(?=[\\s,.!?;:]|$)`);
    m = bare.exec(t);
    if (m) hits.push({ i, pos: m.index, on: `id "${id}"` });
  });

  words.forEach((w, wi) => {
    const key = w.replace(/[^a-z0-9]/g, '');
    const pos = t.indexOf(w);
    if (Object.prototype.hasOwnProperty.call(STRONG_ORDINALS, key)) {
      hits.push({ i: STRONG_ORDINALS[key], pos, on: `ordinal "${key}"` });
    } else if (Object.prototype.hasOwnProperty.call(DIGITS, key)) {
      hits.push({ i: DIGITS[key], pos, on: `number "${key}"` });
    } else if (Object.prototype.hasOwnProperty.call(WEAK_ORDINALS, key)) {
      // "one" alone is a pronoun ("the last one"). Only count it when
      // introduced: "option one", "number two".
      const prev = wi > 0 ? words[wi - 1].replace(/[^a-z#]/g, '') : '';
      if (['option', 'choice', 'number', '#'].includes(prev)) {
        hits.push({ i: WEAK_ORDINALS[key], pos, on: `introduced number "${key}"` });
      }
    }
  });

  if (hasWord(t, 'last')) hits.push({ i: options.length - 1, pos: t.indexOf('last'), on: 'last' });

  const valid = hits.filter((h) => h.i >= 0 && h.i < options.length);
  if (!valid.length) return null;
  valid.sort((a, b) => a.pos - b.pos);   // earliest mention wins
  return valid[0];
}

/**
 * @param {string} text      what the human said
 * @param {object} proposal  {options:[{id,text}]}
 * @returns {{kind:string, optionId?:string, modification?:string, why?:string}}
 */
function resolveAcceptance(text, proposal) {
  const t = normalize(text);
  if (!t || !proposal || !Array.isArray(proposal.options) || !proposal.options.length) {
    return { kind: 'none', why: 'no open proposal' };
  }

  for (const d of DISMISS) {
    if (t === d || t.startsWith(d + ' ') || t.endsWith(' ' + d)) {
      return { kind: 'dismiss', why: `matched dismissal "${d}"` };
    }
  }

  // Questions ask, they do not choose. "why did you suggest a third option"
  // must never become an edit.
  if (QUESTION_STARTS.test(t) || /\?$/.test(String(text).trim())) {
    return { kind: 'none', why: 'reads as a question' };
  }
  if (NEGATED_CHOICE.test(t)) {
    return { kind: 'none', why: 'reads as a negated choice' };
  }

  const ref = findReference(t, proposal.options);
  if (!ref) return { kind: 'none', why: 'no option referenced' };

  const optionId = proposal.options[ref.i].id;
  const words = t.split(' ');

  if (MODIFIERS.some((m) => hasWord(t, m))) {
    return { kind: 'modify', optionId, modification: String(text).trim(),
             why: `referenced ${ref.on} with a change` };
  }

  // A bare reference only counts as a choice when the message is shaped like
  // one: either short enough to be nothing else, or explicitly framed.
  const framed = ACCEPT_FRAMES.some((v) => hasWord(t, v) || t.startsWith(v));
  if (words.length > 3 && !framed) {
    return { kind: 'none', why: 'referenced an option but does not read as a choice' };
  }
  if (words.length > 8) {
    return { kind: 'none', why: 'too long to be a bare choice' };
  }

  return { kind: 'accept', optionId, why: `matched ${ref.on}` };
}

module.exports = { resolveAcceptance, normalize };
