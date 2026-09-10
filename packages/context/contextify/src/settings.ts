/** Profile-owned prompts for Context Map review agents. */
import z from '@deepseek-ai/schemastery'
import {
  CONTEXTIFY_PROMPT_MAX_CHARS,
  type ContextifyPromptSection,
  type ContextifyPromptSettings,
} from './types.ts'
/** Profile settings namespace shared by Host and Web settings surfaces. */
export const CONTEXTIFY_SETTINGS_NAMESPACE = 'contextify'

const promptSection = z.object({
  additional: z.string().max(CONTEXTIFY_PROMPT_MAX_CHARS).default(''),
  override: z.string().max(CONTEXTIFY_PROMPT_MAX_CHARS).default(''),
}).default({ additional: '', override: '' }) as z<ContextifyPromptSection>

/** Runtime schema and defaults for the Contextify Profile namespace. */
export const ContextifyPromptSettingsSchema: z<ContextifyPromptSettings> = z.object({
  context: promptSection,
  archive: promptSection,
  branch: promptSection,
  automaticBranchReview: z.boolean().default(true),
})
