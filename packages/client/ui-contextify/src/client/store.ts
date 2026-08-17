/** Persisted graph-only viewing state for the pinned Context Map. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Supported deterministic graph arrangements. */
export type ContextMapLayout = 'tree' | 'mindmap' | 'timeline'

/** User-owned position override produced by dragging one graph node. */
export interface ContextMapPosition {
  readonly x: number
  readonly y: number
}

/** State that changes presentation without changing model input. */
export interface ContextMapViewState {
  layout: ContextMapLayout
  selectedNodeIds: string[]
  positionOverrides: Record<string, ContextMapPosition>
}

type ContextMapViewActions = {
  setLayout: (draft: ContextMapViewState, layout: ContextMapLayout) => void
  setNodeSelected: (draft: ContextMapViewState, nodeId: string, selected: boolean) => void
  clearSelection: (draft: ContextMapViewState) => void
  setPosition: (draft: ContextMapViewState, nodeId: string, position: ContextMapPosition) => void
  clearPositions: (draft: ContextMapViewState) => void
  retainNodeIds: (draft: ContextMapViewState, nodeIds: readonly string[]) => void
}

/**
 * Create the Context Map view store used by one session-scoped panel.
 * @returns A persistent store handle bound by the slot runtime.
 */
export function createContextMapStore(): EngineStoreHandle<ContextMapViewState, ContextMapViewActions> {
  return defineStore({
    init: (): ContextMapViewState => ({
      layout: 'tree',
      selectedNodeIds: [],
      positionOverrides: {},
    }),
    persist: 'dsh.context-map.view.v1',
    actions: {
      setLayout: (draft, layout) => { draft.layout = layout },
      setNodeSelected: (draft, nodeId, selected) => {
        const ids = new Set(draft.selectedNodeIds)
        if (selected) ids.add(nodeId)
        else ids.delete(nodeId)
        draft.selectedNodeIds = [...ids]
      },
      clearSelection: (draft) => { draft.selectedNodeIds = [] },
      setPosition: (draft, nodeId, position) => {
        draft.positionOverrides = { ...draft.positionOverrides, [nodeId]: position }
      },
      clearPositions: (draft) => { draft.positionOverrides = {} },
      retainNodeIds: (draft, nodeIds) => {
        const retained = new Set(nodeIds)
        draft.selectedNodeIds = draft.selectedNodeIds.filter(id => retained.has(id))
        draft.positionOverrides = Object.fromEntries(
          Object.entries(draft.positionOverrides).filter(([id]) => retained.has(id)),
        )
      },
    },
  })
}
