/**
 * The small amount of Hebrew-aware text handling every consistency check
 * shares (M16 / PRD-v2 §10).
 *
 * WHY NORMALISATION IS THE WHOLE GAME HERE
 * ----------------------------------------
 * Every check in this directory answers the same shape of question: "are these
 * two pieces of the owner's text talking about the same thing?" A check is only
 * as trustworthy as its answer to that, so the normalisation below is
 * deliberately narrow — it removes the differences that are certainly
 * meaningless (niqqud, which apostrophe was typed, the definite article) and
 * nothing else. It does NOT stem, it does not strip plural endings, and it does
 * not touch prefixed prepositions, because every one of those merges words that
 * a reader would call different, and a merge is how a linter starts crying wolf.
 */

/** Combining marks — vowel points and cantillation. Invisible to the meaning. */
const NIQQUD = /[\u0591-\u05C7]/gu

/**
 * Every character used in practice for the Hebrew geresh and gershayim, plus
 * the Latin quotes that stand in for them on a keyboard. Removed rather than
 * unified: a name is written with a geresh here and an apostrophe there, and
 * neither spelling is more correct than the other.
 */
const QUOTE_MARKS = /['"`\u00B4\u05F3\u05F4\u2018\u2019\u201C\u201D]/gu

/** Anything that is not a letter or a digit, at the edges of a token. */
const EDGE_NOISE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu

/** Hyphen-like characters, which join words as often as they separate them. */
const HYPHENS = /[-\u2010\u2011\u2012\u2013\u2014\u05BE]/gu

/** Trims punctuation, brackets and quotes from both ends of one token. */
export function stripEdges(token: string): string {
  return token.replace(EDGE_NOISE, '')
}

/**
 * One word, reduced to what it means.
 *
 * The definite article is dropped only from words long enough that removing a
 * letter still leaves a word — "הספא" and "ספא" are the same place, but "הר"
 * and "ר" are not, and a three-letter floor is the cheapest way to keep that
 * true. Words that merely begin with ה and are not definite ("הורים") are
 * damaged by this, which is acceptable because the result is only ever compared
 * against another string put through the same function.
 */
export function normaliseWord(word: string): string {
  const bare = stripEdges(word).replace(NIQQUD, '').replace(QUOTE_MARKS, '').toLowerCase()
  return bare.length >= 4 && bare.startsWith('ה') ? bare.slice(1) : bare
}

/** Splits on whitespace and on hyphens, dropping anything left with no content. */
export function words(text: string): string[] {
  return text
    .replace(HYPHENS, ' ')
    .split(/\s+/u)
    .map((token) => stripEdges(token))
    .filter((token) => token.length > 0)
}

/** A whole phrase reduced for comparison: word-normalised, single-spaced. */
export function normalisePhrase(phrase: string): string {
  return words(phrase)
    .map((word) => normaliseWord(word))
    .filter((word) => word.length > 0)
    .join(' ')
}

/**
 * The same phrase with its punctuation tidied but its spelling untouched.
 *
 * This is what "written differently" is measured against: two occurrences whose
 * surfaces match here are the same text and only differed by a comma, so
 * reporting them would be noise.
 */
export function surfacePhrase(phrase: string): string {
  return words(phrase).join(' ')
}

export function hasLetter(text: string): boolean {
  return /\p{L}/u.test(text)
}

/**
 * A short window of the owner's own words around one token, so a person reading
 * a finding can judge it without opening the studio. Never reformatted — the
 * quote has to be findable with a search.
 */
export function quoteAround(tokens: readonly string[], index: number, radius = 4): string {
  const from = Math.max(0, index - radius)
  const to = Math.min(tokens.length, index + radius + 1)
  const body = tokens.slice(from, to).join(' ')
  return `${from > 0 ? '…' : ''}${body}${to < tokens.length ? '…' : ''}`
}
