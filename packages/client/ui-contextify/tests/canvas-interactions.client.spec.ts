import { describe, expect, it } from 'vitest'
import { effectiveContextIncluded, effectiveContextMode, intersects, reducePositionChanges } from '../src/client/canvas-interactions.ts'

describe('public Context Map canvas operations', () => {
  it('round-trips every active/included combination through the smallest override', () => {
    for (const active of [false, true]) {
      expect(effectiveContextIncluded(active, 'include')).toBe(true)
      expect(effectiveContextIncluded(active, 'exclude')).toBe(false)
      expect(effectiveContextIncluded(active, 'natural')).toBe(active)
      for (const included of [false, true]) {
        const mode = effectiveContextMode(active, included)
        expect(effectiveContextIncluded(active, mode)).toBe(included)
        expect(mode).toBe(included === active ? 'natural' : included ? 'include' : 'exclude')
      }
    }
  })

  it('includes touching rectangle boundaries and excludes separation along each axis', () => {
    const origin = { x: 10, y: 10, width: 20, height: 20 }
    expect(intersects(origin, { x: 30, y: 30, width: 1, height: 1 })).toBe(true)
    expect(intersects(origin, { x: 15, y: 15, width: 0, height: 0 })).toBe(true)
    for (const other of [
      { x: 31, y: 10, width: 1, height: 1 }, { x: 0, y: 10, width: 1, height: 1 },
      { x: 10, y: 31, width: 1, height: 1 }, { x: 10, y: 0, width: 1, height: 1 },
    ]) {
      expect(intersects(origin, other)).toBe(false)
      expect(intersects(other, origin)).toBe(false)
    }
  })

  it('keeps unrelated live drags and commits completed positions without mutating the previous state', () => {
    const original = { old: { x: 1, y: 2 }, retained: { x: 3, y: 4 } }
    const result = reducePositionChanges(original, [
      { id: 'new', position: { x: 5, y: 6 }, dragging: true },
      { id: 'old', position: { x: 7, y: 8 }, dragging: false },
      { id: 'new', position: { x: 9, y: 10 }, dragging: false },
    ])
    expect(result.transient).toEqual({ retained: { x: 3, y: 4 } })
    expect(result.committed).toEqual([
      { id: 'old', position: { x: 7, y: 8 } }, { id: 'new', position: { x: 9, y: 10 } },
    ])
    expect(original).toEqual({ old: { x: 1, y: 2 }, retained: { x: 3, y: 4 } })
    expect(reducePositionChanges(original, [])).toEqual({ transient: original, committed: [] })
  })
})
