/** Browser assembly for the native Session Context Map. */
import { useEffect } from 'react'
import type { ClientContext, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ContextFamilyGraphNode,
  ContextFamilyGraphPage,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
  ContextifyView,
} from '@deepseek-ai/dsh-contextify/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ContextMapPanel, type ContextMapPanelInjected } from './ContextMapPanel.tsx'
import { ContextMessageAction, type ContextMessageActionInjected } from './ContextMessageAction.tsx'
import { ContextifyController, type ContextifyTransport } from './controller.ts'
import { createContextMapStore } from './store.ts'

export { ContextMapPanel } from './ContextMapPanel.tsx'
export type { ContextMapActions, ContextMapPanelInjected, ContextMapPanelProps } from './ContextMapPanel.tsx'
export { ContextifyController } from './controller.ts'
export type { ContextifyControllerSnapshot, ContextifyTransport } from './controller.ts'
export { createContextMapStore } from './store.ts'

/** Services required by the Contextify Remote adapter and details surface. */
export const inject = ['slots', 'remote', 'remote.contextify', 'layout', 'sessions']

interface ContextifyRemote {
  get: (sessionId: SessionId) => Promise<RemoteResult<ContextifyView>>
  familyPage: (
    sessionId: SessionId,
    after?: number,
    limit?: number,
  ) => Promise<RemoteResult<ContextFamilyGraphPage>>
  setNodeMode: (
    sessionId: SessionId,
    ref: ContextPlanRef,
    node: ContextMessageRef,
    mode: ContextNodeMutation['mode'],
  ) => Promise<RemoteResult<ContextifyView>>
  setNodeModes: (
    sessionId: SessionId,
    ref: ContextPlanRef,
    mutations: readonly ContextNodeMutation[],
  ) => Promise<RemoteResult<ContextifyView>>
  reset: (sessionId: SessionId, ref: ContextPlanRef) => Promise<RemoteResult<ContextifyView>>
  undo: (sessionId: SessionId, ref: ContextPlanRef) => Promise<RemoteResult<ContextifyView>>
  redo: (sessionId: SessionId, ref: ContextPlanRef) => Promise<RemoteResult<ContextifyView>>
}

/** Convert a generated transport result into the component's ordinary promise contract. */
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
  useEffect(() => {
    if (sessionId !== undefined) open()
  }, [open, sessionId])
  return null
}

/** Register the pinned map and one shared controller per native Session. */
export function apply(ctx: ClientContext): void {
  const remote = ctx.remote.contextify as unknown as ContextifyRemote
  const controllers = new Map<SessionId, ContextifyController>()
  const controllerFor = (sessionId: SessionId): ContextifyController => {
    const existing = controllers.get(sessionId)
    if (existing !== undefined) return existing
    const transport: ContextifyTransport = {
      get: async () => valueOf(await remote.get(sessionId)),
      familyPage: async (after, limit) => valueOf(await remote.familyPage(sessionId, after, limit)),
      setNodeMode: async (ref, node, mode) => valueOf(await remote.setNodeMode(sessionId, ref, node, mode)),
      setNodeModes: async (ref, mutations) => valueOf(await remote.setNodeModes(sessionId, ref, mutations)),
      reset: async ref => valueOf(await remote.reset(sessionId, ref)),
      undo: async ref => valueOf(await remote.undo(sessionId, ref)),
      redo: async ref => valueOf(await remote.redo(sessionId, ref)),
    }
    const controller = new ContextifyController(transport)
    controllers.set(sessionId, controller)
    return controller
  }
  const messageActionInjected = (sessionId: SessionId): ContextMessageActionInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { contextify: controller },
      setNodeMode: (node, mode) => controller.setNodeMode(node, mode),
      locate: (nodeId) => { controller.focus(nodeId); ctx.layout.openDetails() },
    }
  }

  ctx.slots.inject('conversation.details.pinned', () => ctx.slots.register({
    name: 'conversation.details.pinned',
    id: 'contextify',
    order: 0,
    store: createContextMapStore(),
    inject: (sessionId: SessionId): ContextMapPanelInjected => {
      const controller = controllerFor(sessionId)
      return {
        hooks: { contextify: controller },
        mapActions: {
          setNodeMode: (node, mode) => controller.setNodeMode(node, mode),
          setNodeModes: mutations => controller.setNodeModes(mutations),
          reset: () => controller.reset(),
          undo: () => controller.undo(),
          redo: () => controller.redo(),
          branch: async (node: ContextFamilyGraphNode) => {
            if (node.branchAtSeq === null) throw new Error('Message has no completed Turn boundary')
            const childId = await ctx.sessions.fork({
              sessionId: node.owner.sessionId,
              atSeq: node.branchAtSeq,
              increaseTitle: true,
            })
            ctx.sessions.open(childId)
          },
          navigate: (node) => { ctx.sessions.open(node.owner.sessionId) },
          locate: (nodeId) => { controller.focus(nodeId); ctx.layout.openDetails() },
          close: () => { ctx.layout.closeDetails() },
        },
      }
    },
  }, ContextMapPanel))

  ctx.slots.inject('conversation.chat.user-actions', () => ctx.slots.register({
    name: 'conversation.chat.user-actions',
    id: 'contextify',
    order: 20,
    inject: messageActionInjected,
  }, ContextMessageAction))
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'contextify',
    order: 20,
    inject: messageActionInjected,
  }, ContextMessageAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'contextify-open-details',
    order: -100,
    inject: () => ({ open: () => { ctx.layout.openDetails() } }),
  }, DetailsOpener))
}
