/** Context Steward draft-review copy, owned by the Contextify Client. */

/** Simplified Chinese dictionary and key-set authority. */
export const zh = {
  'action.reviewDraft': '检查草稿所需的 Context',
  'action.reviewingDraft': '正在检查 Context…',
} satisfies Record<string, string>

/** Typed Context Steward locale keys. */
export type StewardKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese source. */
export const en = {
  'action.reviewDraft': 'Review context for draft',
  'action.reviewingDraft': 'Reviewing context…',
} satisfies Record<StewardKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for explicit pre-send Context review. */
    contextifySteward: StewardKey
  }
}
