/** Shared immutable Client-safe prompt contract, without the Host service runtime. */
export {
  CONTEXTIFY_DEFAULT_PROMPTS as CONTEXTIFY_CLIENT_DEFAULT_PROMPTS,
  CONTEXTIFY_DEFAULT_SETTINGS as CONTEXTIFY_CLIENT_DEFAULT_SETTINGS,
  effectivePrompt as effectiveClientPrompt,
} from '@deepseek-ai/dsh-contextify/types'
