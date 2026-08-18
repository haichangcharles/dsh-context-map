import { describe, expect, it } from 'vitest'
import type { NodeChange } from '@xyflow/react'
import {
  reconcileMeasuredSizes,
  reduceMeasuredSizes,
} from '../src/client/layout-measurements.ts'

const dimensions = (id: string, width: number, height: number): NodeChange => ({
  id,
  type: 'dimensions',
  dimensions: { width, height },
})

describe('Context Map layout measurements', () => {
  it('normalizes valid dimensions and ignores invalid bounds', () => {
    const measured = reduceMeasuredSizes({}, [
      dimensions('valid', 224.24, 116.26),
      dimensions('zero', 0, 20),
      dimensions('negative', 20, -1),
      { id: 'move', type: 'position', position: { x: 1, y: 2 } },
    ])

    expect(measured).toEqual({ valid: { width: 224, height: 116.5 } })
  })

  it('preserves identity for changes below the one-pixel threshold', () => {
    const current = { node: { width: 224, height: 116 } }

    expect(reduceMeasuredSizes(current, [dimensions('node', 224.7, 116.6)])).toBe(current)
  })

  it('publishes a new map for material dimension changes', () => {
    const current = { node: { width: 224, height: 116 } }

    expect(reduceMeasuredSizes(current, [dimensions('node', 224, 118.2)]))
      .toEqual({ node: { width: 224, height: 118 } })
  })

  it('removes measurements for graph nodes that no longer exist', () => {
    const current = {
      retained: { width: 224, height: 116 },
      removed: { width: 224, height: 200 },
    }

    expect(reconcileMeasuredSizes(current, ['retained']))
      .toEqual({ retained: { width: 224, height: 116 } })
    expect(reconcileMeasuredSizes(current, ['retained', 'removed'])).toBe(current)
  })
})
