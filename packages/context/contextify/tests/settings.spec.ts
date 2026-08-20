import { describe, expect, it } from 'vitest'
import {
  CONTEXTIFY_DEFAULT_PROMPTS,
  CONTEXTIFY_DEFAULT_SETTINGS,
  effectivePrompt,
} from '../src/types.ts'
import { ContextifyPromptSettingsSchema } from '../src/settings.ts'

describe('Contextify prompt settings', () => {
  it('uses the package default and appends Profile instructions', () => {
    expect(effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.context, {
      additional: 'Prefer recent facts.', override: '',
    })).toBe(`${CONTEXTIFY_DEFAULT_PROMPTS.context}\n\nAdditional profile instructions:\nPrefer recent facts.`)
  })

  it('uses an explicit override while preserving appended instructions', () => {
    expect(effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.context, {
      additional: 'Short.', override: 'Custom base.',
    })).toBe('Custom base.\n\nAdditional profile instructions:\nShort.')
  })

  it('restores package defaults when Profile fields are empty', () => {
    const parse = ContextifyPromptSettingsSchema as unknown as (input: unknown) => typeof CONTEXTIFY_DEFAULT_SETTINGS
    expect(parse({})).toEqual(CONTEXTIFY_DEFAULT_SETTINGS)
    expect(effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.context, { additional: '', override: '' }))
      .toBe(CONTEXTIFY_DEFAULT_PROMPTS.context)
    expect(CONTEXTIFY_DEFAULT_SETTINGS.automaticBranchReview).toBe(true)
    expect(parse({ automaticBranchReview: false }).automaticBranchReview).toBe(false)
  })
})
