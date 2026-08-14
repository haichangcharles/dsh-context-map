/** Browser assembly for the pinned Context Map details surface. */
import { createElement, useEffect } from 'react'
import type {
  ClientContext,
  SessionId,
  SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ContextPathId } from '@deepseek-ai/dsh-contextify/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  ContextMapPanel,
  type ContextMapPanelActions,
  type ContextMapRecord,
  type ContextMapView,
} from './ContextMapPanel.tsx'

export { ContextMapPanel } from './ContextMapPanel.tsx'
export type {
  ContextMapPanelActions,
  ContextMapPath,
  ContextMapRecord,
  ContextMapView,
} from './ContextMapPanel.tsx'

/** Services required by the Contextify Remote adapter and details surface. */
export const inject = ['slots', 'remote', 'remote.contextify', 'layout']

/** Convert the transport result into the component's ordinary promise contract. */
function valueOf<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/** Invisible root entry that reopens details whenever a non-blank Session takes ownership. */
function DetailsOpener({ open, useSessions }: {
  open: () => void
  useSessions: SnapshotSelectorHook<SessionListState>
}) {
  const sessionId = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  // AppFrame closes details in a layout effect when ownership changes. This
  // passive effect runs afterwards and restores the pinned Context Map.
  useEffect(() => {
    if (sessionId !== undefined) open()
  }, [open, sessionId])
  return null
}

/** Slot inject values are flattened into component props by the slot runtime. */
function ContextMapEntry(actions: ContextMapPanelActions) {
  return createElement(ContextMapPanel, { actions })
}

/** Register the Context Map as one session-scoped pinned details contribution. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.details.pinned', () => ctx.slots.register({
    name: 'conversation.details.pinned',
    id: 'contextify',
    order: 0,
    inject: (sessionId: SessionId): ContextMapPanelActions => ({
      load: async () => {
        const view: ContextMapView = valueOf(await ctx.remote.contextify.get(sessionId))
        const records: ContextMapRecord[] = []
        let afterSeq: number | undefined
        for (;;) {
          const page = valueOf(await ctx.remote.contextify.graphPage(sessionId, afterSeq, 500))
          records.push(...page.records)
          if (page.nextAfterSeq === undefined) break
          afterSeq = page.nextAfterSeq
        }
        return { view, records }
      },
      createBranch: async (seq, revision) => {
        valueOf(await ctx.remote.contextify.createBranch(sessionId, { revision }, seq, undefined))
      },
      selectPath: async (pathId, revision) => {
        valueOf(await ctx.remote.contextify.selectPath(sessionId, { revision }, pathId as ContextPathId))
      },
      returnToMainline: async (revision) => {
        valueOf(await ctx.remote.contextify.returnToMainline(sessionId, { revision }))
      },
      setNodeMode: async (seq, mode, revision) => {
        valueOf(await ctx.remote.contextify.setNodeMode(sessionId, { revision }, seq, mode))
      },
      close: () => { ctx.layout.closeDetails() },
    }),
  }, ContextMapEntry))

  // shell.overlay is rendered inside AppFrame after the layout action face is
  // attached, so this is the deterministic boot edge for reopening details.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'contextify-open-details',
    order: -100,
    inject: () => ({ open: () => { ctx.layout.openDetails() } }),
  }, DetailsOpener))
}
