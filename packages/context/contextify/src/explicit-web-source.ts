/** Conservative, training-free handling of a user's exact Web-source correction. */
import type { ContextRecommendationDecision } from './recommendation.ts'

/** A graph-eligible Web observation with a native-call URL and current selection state. */
export interface VerifiedWebSource {
  readonly nodeId: string
  /** URL read from the bound web_fetch tool call, never from page text. */
  readonly url: string
  readonly included: boolean
  readonly explicitlyIncluded: boolean
  readonly explicitlyExcluded?: boolean
  readonly reviewableExcluded?: boolean
}

const ENGLISH_EXCLUDE = new RegExp(
  String.raw`(?:^|[\n;。！？])\s*(?:please\s+)?`
    + String.raw`(?:ignore|exclude|disregard|do not use|don't use|stop using)\s+`
    + String.raw`(?:the\s+)?(?:web\s+)?(?:source|page|result|article)?\s*(?:at\s+)?`
    + String.raw`(https?:\/\/[^\s<>"';；，。！？]+)`,
  'giu',
)
const CHINESE_EXCLUDE = new RegExp(
  String.raw`(?:^|[\n;。！？])\s*(?:请)?(?:不要使用|不要用|忽略|排除)\s*`
    + String.raw`(?:这个|该)?\s*(?:网页|来源|页面)?\s*[:：在]?\s*`
    + String.raw`(https?:\/\/[^\s<>"';；，。！？]+)`,
  'gu',
)
const ENGLISH_INCLUDE = new RegExp(
  String.raw`(?:^|[\n;。！？])\s*(?:please\s+)?`
    + String.raw`(?:include|use|reuse|restore|bring back)\s+`
    + String.raw`(?:the\s+)?(?:web\s+)?(?:source|page|result|article)?\s*(?:at\s+)?`
    + String.raw`(https?:\/\/[^\s<>"';；，。！？]+)`,
  'giu',
)
const CHINESE_INCLUDE = new RegExp(
  String.raw`(?:^|[\n;。！？])\s*(?:请)?(?:使用|重新使用|纳入|加入)\s*`
    + String.raw`(?:这个|该)?\s*(?:网页|来源|页面)?\s*[:：在]?\s*`
    + String.raw`(https?:\/\/[^\s<>"';；，。！？]+)`,
  'gu',
)
const ENGLISH_COMMAND_HEAD = /(?:^|[\s.;。！？])(?:please\s+)?(?:ignore|exclude|disregard|do not use|don't use|stop using)\b/giu
const CHINESE_COMMAND_HEAD = /(?:^|[\s.;。！？])(?:请)?(?:不要使用|不要用|忽略|排除)/gu

function normalizedHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value.replace(/[.,!?;:)\]）。，！？；：]+$/u, ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch { return null }
}

function singleSelectionCommand(objective: string): boolean {
  // A mixed Include/Exclude instruction cannot be represented by one exact
  // shortcut. Let the ordinary reviewer inspect the complete draft instead.
  return [
    ...objective.matchAll(ENGLISH_COMMAND_HEAD), ...objective.matchAll(CHINESE_COMMAND_HEAD),
    ...objective.matchAll(ENGLISH_INCLUDE), ...objective.matchAll(CHINESE_INCLUDE),
  ].length === 1
}

/**
 * Offer one reversible Exclude only for an unambiguous user command and a
 * uniquely bound, currently selected Web result. Ambiguity falls back to the
 * ordinary DSH reviewer rather than silently editing the Context Plan.
 * @param objective - Explicit user source-selection command.
 * @param sources - Web results whose URLs are bound to native fetch calls.
 * @returns One review-only Exclude, or null when the command or source is ambiguous.
 */
export function explicitWebSourceExclusion(
  objective: string,
  sources: readonly VerifiedWebSource[],
): ContextRecommendationDecision | null {
  const references = [...objective.matchAll(ENGLISH_EXCLUDE), ...objective.matchAll(CHINESE_EXCLUDE)]
  if (references.length !== 1) return null
  // A second instruction may be separated by a period consumed as URL
  // punctuation by the first match. Abstain rather than applying only half.
  if (!singleSelectionCommand(objective)) return null
  const target = normalizedHttpUrl(references[0]?.[1] ?? '')
  if (target === null) return null
  const matches = sources.filter(source => normalizedHttpUrl(source.url) === target)
  if (matches.length !== 1 || !matches[0]?.included || matches[0].explicitlyIncluded) return null
  return Object.freeze({
    exclude: Object.freeze([{ nodeId: matches[0].nodeId,
      reason: 'You asked to exclude this exact Web source from the next request.' }]),
    include: Object.freeze([]), archive: Object.freeze([]),
  })
}

/** Offer a reviewed Include of one exact, previously fetched Web source.
 * @param objective - Explicit user source-selection command.
 * @param sources - Web results whose URLs are bound to native fetch calls.
 * @returns One review-only Include, or null when the command or source is ineligible.
 */
export function explicitWebSourceInclusion(
  objective: string,
  sources: readonly VerifiedWebSource[],
): ContextRecommendationDecision | null {
  const references = [...objective.matchAll(ENGLISH_INCLUDE), ...objective.matchAll(CHINESE_INCLUDE)]
  if (references.length !== 1 || !singleSelectionCommand(objective)) return null
  const target = normalizedHttpUrl(references[0]?.[1] ?? '')
  if (target === null) return null
  const matches = sources.filter(source => normalizedHttpUrl(source.url) === target)
  const source = matches[0]
  if (matches.length !== 1 || source === undefined || source.included
    || (source.explicitlyExcluded && !source.reviewableExcluded)) return null
  return Object.freeze({
    exclude: Object.freeze([]),
    include: Object.freeze([{ nodeId: source.nodeId,
      reason: 'You asked to include this exact Web source in the next request.' }]),
    archive: Object.freeze([]),
  })
}
