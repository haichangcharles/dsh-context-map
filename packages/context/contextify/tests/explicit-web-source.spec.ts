import { describe, expect, it } from 'vitest'
import { explicitWebSourceExclusion, explicitWebSourceInclusion } from '../src/explicit-web-source.ts'

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

  it('proposes a reviewed Include for one unselected, source-bound URL', () => {
    const offPath = { ...source, nodeId: 'sibling:42', included: false }
    expect(explicitWebSourceInclusion('Use https://research.test/old-report for this answer.',
      [offPath])).toEqual({ exclude: [], include: [{ nodeId: 'sibling:42',
      reason: 'You asked to include this exact Web source in the next request.' }], archive: [] })
    expect(explicitWebSourceInclusion('使用https://research.test/old-report。', [offPath])
      ?.include.map(item => item.nodeId)).toEqual(['sibling:42'])
  })

  it('does not restore a direct Exclude or choose between duplicate URLs', () => {
    const offPath = { ...source, included: false }
    const objective = 'Include https://research.test/old-report.'
    expect(explicitWebSourceInclusion(objective, [{ ...offPath, explicitlyExcluded: true }]))
      .toBeNull()
    expect(explicitWebSourceInclusion(objective, [offPath, { ...offPath, nodeId: 'sibling:43' }]))
      .toBeNull()
    expect(explicitWebSourceInclusion(objective, [source])).toBeNull()
    expect(explicitWebSourceInclusion('Do not include https://research.test/old-report.', [offPath]))
      .toBeNull()
    expect(explicitWebSourceInclusion('Summarize https://research.test/old-report.', [offPath]))
      .toBeNull()
    expect(explicitWebSourceInclusion('Include https://research.test/old-report; '
      + 'ignore https://research.test/other.', [offPath])).toBeNull()
    expect(explicitWebSourceExclusion('Ignore https://research.test/old-report; '
      + 'include https://research.test/other.', [source])).toBeNull()
  })
})
