import { describe, expect, it } from 'vitest'
import { jaccardOverlap, lexicalTokens } from '../src/lexical-tokens.ts'

describe('Context lexical features', () => {
  it('shares Chinese word pieces across different sentence orders', () => {
    expect(jaccardOverlap('比较相机的续航', '相机续航比较')).toBeGreaterThan(0.2)
    expect(jaccardOverlap('比较相机的续航', '酒店取消政策')).toBe(0)
  })

  it('keeps Latin words and normalizes full-width text', () => {
    expect(lexicalTokens('Ｗｅｂ Agent compares cameras')).toEqual(new Set(['web', 'agent', 'compares', 'cameras']))
    expect(jaccardOverlap('warranty coverage comparison', 'compare warranty options')).toBeGreaterThan(0)
  })
})
