/** Browser assembly for the native Session Context Map. */
import { useEffect } from 'react'
import type { ClientContext, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ContextMapPanel, type ContextMapPanelInjected } from './ContextMapPanel.tsx'
import { ContextMessageAction, type ContextMessageActionInjected } from './ContextMessageAction.tsx'
import { BranchSuggestionTail, type BranchSuggestionTailInjected } from './BranchSuggestionTail.tsx'
import { ContextifyController, type ContextifyTransport } from './controller.ts'
import { createContextMapStore } from './store.ts'
import { ContextifyPromptSettingsSection } from './ContextifyPromptSettings.tsx'
import type { ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'

export { ContextMapPanel } from './ContextMapPanel.tsx'
export type { ContextMapActions, ContextMapPanelInjected, ContextMapPanelProps } from './ContextMapPanel.tsx'
export { ContextifyController } from './controller.ts'
export type { ContextifyControllerSnapshot, ContextifyTransport } from './controller.ts'
export { createContextMapStore } from './store.ts'

/** Services required by the Contextify Remote adapter and details surface. */
export const inject = ['slots', 'remote', 'remote.contextify', 'layout', 'sessions', 'conversation']

/** Convert a generated transport result into the component's ordinary promise contract. */
function valueOf<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/**
 * Resolve the canonical native Session and completed-Turn boundary for a fork.
 * @param node - Canonical Context Map message node.
 * @returns Native Session fork input with title increment enabled.
 */
export function nativeBranchSource(node: ContextFamilyGraphNode): {
  sessionId: SessionId
  atSeq: number
  increaseTitle: true
} {
  if (node.branchAtSeq === null) throw new Error('Message has no completed Turn boundary')
  return { sessionId: node.owner.sessionId, atSeq: node.branchAtSeq, increaseTitle: true }
}

/** Invisible root entry that opens wide Sessions and restores the narrow reveal affordance. */
function DetailsOpener({ open, close, autoCollapseBreakpoint, useSessions }: {
  open: () => void
  close: () => void
  autoCollapseBreakpoint: number
  useSessions: SnapshotSelectorHook<SessionListState>
}) {
  const sessionId = useSessions((state) => {
    const current = state.current
    return current !== undefined && state.byId[current]?.blank === false ? current : undefined
  })
  useEffect(() => {
    if (sessionId === undefined) return
    const wide = window.matchMedia(`(min-width: ${String(autoCollapseBreakpoint)}px)`)
    const synchronize = (): void => {
      if (wide.matches) open()
      else close()
    }
    synchronize()
    wide.addEventListener('change', synchronize)
    return () => { wide.removeEventListener('change', synchronize) }
  }, [autoCollapseBreakpoint, close, open, sessionId])
  return null
}

/** Register the pinned map and one shared controller per native Session. */
export function apply(ctx: ClientContext): void {
  const remote = ctx.remote.contextify
  const controllers = new Map<SessionId, ContextifyController>()
  ctx.inject(['settingsScope', 'locale', 'connection'], (settingsCtx) => {
    const promptScope = settingsCtx.settingsScope.bind<ContextifyPromptSettings>({ namespace: 'contextify' })
    settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
      name: 'settings.section',
      id: 'contextify-prompts',
      order: 25,
      label: () => settingsCtx.locale.getSnapshot().active.startsWith('zh')
        ? 'Context Map 提示词'
        : 'Context Map prompts',
      inject: () => ({ scope: promptScope }),
    }, ContextifyPromptSettingsSection))
  })
  const controllerFor = (sessionId: SessionId): ContextifyController => {
    const existing = controllers.get(sessionId)
    if (existing !== undefined) return existing
    const transport: ContextifyTransport = {
      get: async () => valueOf(await remote.get(sessionId)),
      familyPage: async (after, limit) => valueOf(await remote.familyPage(sessionId, after, limit)),
      setNodeMode: async (ref, node, mode) => valueOf(await remote.setNodeMode(sessionId, ref, node, mode)),
      setNodeModes: async (ref, mutations, expectedGraphRevision) => valueOf(await remote.setNodeModes(
        sessionId, ref, mutations, expectedGraphRevision,
      )),
      reset: async ref => valueOf(await remote.reset(sessionId, ref)),
      undo: async ref => valueOf(await remote.undo(sessionId, ref)),
      redo: async ref => valueOf(await remote.redo(sessionId, ref)),
      recommend: async (base, objective, mode) => valueOf(
        await remote.recommend(sessionId, base, objective, mode),
      ),
      cancelRecommendation: async () => { valueOf(await remote.cancelRecommendation(sessionId)) },
      archiveNode: async (ref, node, reason, expectedGraphRevision) => valueOf(await remote.archiveNode(
        sessionId, ref, node, reason, expectedGraphRevision,
      )),
      restoreNode: async (ref, node) => valueOf(await remote.restoreNode(sessionId, ref, node)),
      prepareBranchSuggestion: async suggestionId => valueOf(
        await remote.prepareBranchSuggestion(sessionId, suggestionId),
      ),
      forkNativeBranch: preparation => ctx.sessions.fork({
        sessionId: preparation.sourceSessionId,
        beforeSeq: preparation.beforeSeq,
        increaseTitle: true,
      }),
      acceptBranchSuggestion: async (suggestionId, childSessionId) => valueOf(
        await remote.acceptBranchSuggestion(sessionId, suggestionId, childSessionId),
      ),
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
      locate: (nodeId) => {
        controller.focus(nodeId)
        ctx.conversation.openPinnedDetails(sessionId)
        ctx.layout.openDetails()
      },
    }
  }
  const branchSuggestionInjected = (sessionId: SessionId): BranchSuggestionTailInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { contextify: controller },
      moveBranchSuggestion: async (suggestionId) => {
        const result = await controller.acceptBranchSuggestion(suggestionId)
        ctx.sessions.open(result.childSessionId)
      },
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
          recommend: (mode, objective) => controller.recommend(mode, objective),
          cancelRecommendation: () => controller.cancelRecommendation(),
          applyRecommendations: () => controller.applyRecommendations(),
          clearRecommendation: () => { controller.clearRecommendation() },
          confirmArchive: candidate => controller.confirmArchive(candidate),
          archiveNode: node => controller.archiveNode(node),
          restoreNode: node => controller.restoreNode(node),
          branch: async (node: ContextFamilyGraphNode) => {
            const childId = await ctx.sessions.fork(nativeBranchSource(node))
            ctx.sessions.open(childId)
          },
          locate: (node) => { ctx.conversation.revealMessage(node.owner.sessionId, node.owner.seq) },
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
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: 10,
    select: owner => owner.seq,
    inject: branchSuggestionInjected,
  }, BranchSuggestionTail))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'contextify-open-details',
    order: -100,
    inject: () => ({
      open: () => { ctx.layout.openDetails() },
      close: () => { ctx.layout.closeDetails() },
      autoCollapseBreakpoint: ctx.layout.autoCollapseBreakpoint(),
    }),
  }, DetailsOpener))
}
