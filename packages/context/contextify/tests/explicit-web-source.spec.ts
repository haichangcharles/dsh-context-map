import { describe, expect, it } from 'vitest'
import { explicitWebSourceExclusion } from '../src/explicit-web-source.ts'

const source = { nodeId: 'current:42', url: 'https://research.test/old-report',
  included: true, explicitlyIncluded: false }

describe('explicit Web-source correction', () => {
  it('proposes a reviewable Exclude for one exact source URL', () => {
    expect(explicitWebSourceExclusion('Ignore https://research.test/old-report. Use the newer report.',
      [source])).toEqual({ exclude: [{ nodeId: 'current:42',
      reason: 'You asked to exclude this exact Web source from the next request.' }],
    include: [], archive: [] })
  })

  it('abstains on ambiguous, absent, or manually included sources', () => {
    const objective = 'Do not use https://research.test/old-report for this answer.'
    expect(explicitWebSourceExclusion(objective, [source, { ...source, nodeId: 'current:43' }]))
      .toBeNull()
    expect(explicitWebSourceExclusion(objective, [{ ...source, included: false }])).toBeNull()
    expect(explicitWebSourceExclusion(objective, [{ ...source, explicitlyIncluded: true }])).toBeNull()
    expect(explicitWebSourceExclusion(objective, [{ ...source, url: 'https://research.test/other' }]))
      .toBeNull()
  })

  it('does not reinterpret a negated command or a URL mention as exclusion', () => {
    expect(explicitWebSourceExclusion('Do not ignore https://research.test/old-report.', [source]))
      .toBeNull()
    expect(explicitWebSourceExclusion('Summarize https://research.test/old-report.', [source]))
      .toBeNull()
    expect(explicitWebSourceExclusion(
      'Ignore https://research.test/old-report; exclude https://research.test/another', [source]))
      .toBeNull()
    expect(explicitWebSourceExclusion(
      'Ignore https://research.test/old-report. Ignore https://research.test/another.', [source]))
      .toBeNull()
  })

  it('accepts a direct Chinese exclusion command with the same source-bound rule', () => {
    expect(explicitWebSourceExclusion('不要用https://research.test/old-report。继续当前比较。', [source])
      ?.exclude.map(item => item.nodeId)).toEqual(['current:42'])
  })
})
