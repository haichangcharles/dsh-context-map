/** Deterministic multilingual lexical features for bounded Context routing. */

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

/**
 * Split alphabetic words and CJK bigrams without a model or locale dependency.
 * @param value - User objective or graph message content.
 * @returns Normalized unique terms for lexical comparison.
 */
export function lexicalTokens(value: string): ReadonlySet<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const result = new Set<string>()
  for (const word of normalized.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (Array.from(word).length > 1) result.add(word)
  }
  for (const run of normalized.match(CJK_RUN) ?? []) {
    const characters = Array.from(run)
    if (characters.length === 1) result.add(run)
    for (let index = 0; index + 1 < characters.length; index += 1) {
      result.add(characters.slice(index, index + 2).join(''))
    }
  }
  return result
}

/**
 * Compare two pieces of text using the same normalized terms as Fast routing.
 * @param left - First objective or message.
 * @param right - Second objective or message.
 * @returns Jaccard overlap in the closed interval from zero to one.
 */
export function jaccardOverlap(left: string, right: string): number {
  const a = lexicalTokens(left)
  const b = lexicalTokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}
