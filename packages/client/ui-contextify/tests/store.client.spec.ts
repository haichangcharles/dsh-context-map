// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createContextMapStore } from '../src/client/store.ts'

afterEach(() => { localStorage.clear() })

describe('Context Map view store reconciliation', () => {
  it('keeps graph presentation choices independent and clears explicit overrides', () => {
    const store = createContextMapStore().create()
    expect(store.getSnapshot()).toEqual({ layout: 'tree', selectedNodeIds: [], positionOverrides: {} })
    store.actions.setLayout('timeline')
    store.actions.setNodeSelected('visible', true)
    store.actions.setNodeSelected('visible', true)
    expect(store.getSnapshot().selectedNodeIds).toEqual(['visible'])
    store.actions.setNodeSelected('visible', false)
    expect(store.getSnapshot().selectedNodeIds).toEqual([])
    store.actions.setNodeSelected('other', true)
    store.actions.setPosition('other', { x: 1, y: 2 })
    store.actions.setPosition('other', { x: 10, y: 20 })
    expect(store.getSnapshot().positionOverrides).toEqual({ other: { x: 10, y: 20 } })
    store.actions.clearSelection()
    store.actions.clearPositions()
    expect(store.getSnapshot()).toEqual({ layout: 'timeline', selectedNodeIds: [], positionOverrides: {} })
  })

  it('drops hidden canvas selection but preserves archived family positions for restore', () => {
    const store = createContextMapStore().create()
    store.actions.setNodeSelected('visible', true)
    store.actions.setNodeSelected('archived', true)
    store.actions.setNodeSelected('deleted', true)
    store.actions.setPosition('visible', { x: 10, y: 20 })
    store.actions.setPosition('archived', { x: 30, y: 40 })
    store.actions.setPosition('deleted', { x: 50, y: 60 })

    store.actions.reconcileNodeIds(['visible'], ['visible', 'archived'])

    expect(store.getSnapshot().selectedNodeIds).toEqual(['visible'])
    expect(store.getSnapshot().positionOverrides).toEqual({
      visible: { x: 10, y: 20 },
      archived: { x: 30, y: 40 },
    })
    store.actions.reconcileNodeIds(['visible', 'archived'], ['visible', 'archived'])
    expect(store.getSnapshot().positionOverrides.archived).toEqual({ x: 30, y: 40 })
  })
})
