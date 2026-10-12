import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
/** Browser assembly for the native Session Context Map. */
import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ContextFamilyGraphNode, ContextRouteAdvice } from '@deepseek-ai/dsh-contextify/types'
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
import { DraftContextReview, type DraftContextReviewInjected } from './DraftContextReview.tsx'
import { en as stewardEn, zh as stewardZh } from './steward-locales.ts'
import type { ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'

export { ContextMapPanel } from './ContextMapPanel.tsx'
export type { ContextMapActions, ContextMapPanelInjected, ContextMapPanelProps } from './ContextMapPanel.tsx'
export { ContextifyController } from './controller.ts'
export type { ContextifyControllerSnapshot, ContextifyTransport } from './controller.ts'
export { createContextMapStore } from './store.ts'

/** Services required by the Contextify Remote adapter and details surface. */
export const inject = ['slots', 'remote', 'remote.contextify', 'layout', 'sessions', 'conversation', 'sidebarRight', 'sidebarRightTabs']

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

/** Open the Context Map when the user enters a nonempty Session. */
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
  const remote = ctx.remote.contextify
  const controllers = new Map<SessionId, ContextifyController>()
  ctx.inject(['locale'], localeCtx => localeCtx.effect(() =>
    localeCtx.locale.register('contextifySteward', { zh: stewardZh, en: stewardEn }),
  'ui-contextify: Steward copy'))
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
      setNodeMode: async (ref, node, mode) => valueOf(await remote.setNodeMode(
        sessionId, ref, node, mode, 'contextify-client',
      )),
      setNodeModes: async (ref, mutations, expectedGraphRevision, reviewedDeclinedNodeIds) => valueOf(await remote.setNodeModes(
        sessionId, ref, mutations, expectedGraphRevision, 'contextify-client', reviewedDeclinedNodeIds,
      )),
      reset: async ref => valueOf(await remote.reset(sessionId, ref)),
      undo: async ref => valueOf(await remote.undo(sessionId, ref)),
      redo: async ref => valueOf(await remote.redo(sessionId, ref)),
      recommend: async (base, objective, mode, draftBound) => valueOf(
        await remote.recommend(sessionId, base, objective, mode, draftBound),
      ),
      cancelRecommendation: async () => { valueOf(await remote.cancelRecommendation(sessionId)) },
      presentRecommendation: async (proposal) => { valueOf(await remote.presentRecommendation(
        sessionId, proposal, 'contextify-client',
      )) },
      dismissRecommendation: async (proposal, declinedNodeIds) => { valueOf(await remote.dismissRecommendation(
        sessionId, proposal, 'contextify-client', declinedNodeIds,
      )) },
      archiveNode: async (ref, node, reason, expectedGraphRevision) => valueOf(await remote.archiveNode(
        sessionId, ref, node, reason, expectedGraphRevision,
      )),
      getNodeText: async node => valueOf(await remote.getNodeText(sessionId, node)),
      focusNodeExcerpt: async (ref, node, start, end, reason) => valueOf(await remote.focusNodeExcerpt(
        sessionId, ref, node, start, end, reason, 'contextify-client',
      )),
      restoreNode: async (ref, node) => valueOf(await remote.restoreNode(sessionId, ref, node)),
      prepareBranchSuggestion: async suggestionId => valueOf(
        await remote.prepareBranchSuggestion(sessionId, suggestionId),
      ),
      keepBranchSuggestion: async (suggestionId) => { valueOf(
        await remote.keepBranchSuggestion(sessionId, suggestionId, 'contextify-client'),
      ) },
      forkNativeBranch: preparation => ctx.sessions.fork({
        sessionId: preparation.sourceSessionId,
        beforeSeq: preparation.beforeSeq,
        increaseTitle: true,
      }),
      acceptBranchSuggestion: async (suggestionId, childSessionId) => valueOf(
        await remote.acceptBranchSuggestion(sessionId, suggestionId, childSessionId, 'contextify-client'),
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
        ctx.sidebarRight.openTab('context-map')
      },
    }
  }
  const branchSuggestionInjected = (sessionId: SessionId): BranchSuggestionTailInjected => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { contextify: controller },
      keepBranchSuggestion: suggestionId => controller.keepBranchSuggestion(suggestionId),
      moveBranchSuggestion: async (suggestionId) => {
        const sourceScope = ctx.sessions.scope(sessionId)
        if (sourceScope === undefined) throw new Error('The current Session is unavailable')
        const { draft, draftRev } = ctx.conversation.input.for(sourceScope).state.getSnapshot()
        const result = await controller.acceptBranchSuggestion(suggestionId)
        if (!ctx.conversation.moveDraft(sessionId, result.childSessionId, { draft, draftRev })) {
          throw new Error('The draft changed or the new branch cannot receive it')
        }
        ctx.sessions.open(result.childSessionId)
      },
    }
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'context-map', kind: 'context-map', priority: 'builtin', title: () => 'Context Map',
    guide: [{ order: 10, title: () => 'Context Map', description: () => 'Inspect branches and control conversation context' }],
  }))
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'context-map',
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
          applyRecommendations: declinedNodeIds => controller.applyRecommendations(declinedNodeIds),
          clearRecommendation: () => { controller.clearRecommendation() },
          rejectRoute: async (route: ContextRouteAdvice) => {
            const sourceScope = ctx.sessions.scope(sessionId)
            if (sourceScope === undefined
              || ctx.conversation.input.for(sourceScope).state.getSnapshot().draft.trim() !== route.objective) {
              throw new Error('The draft changed after Context review')
            }
            valueOf(await remote.reviewRoute(sessionId, route, 'reject', undefined, 'contextify-client'))
          },
          acceptRoute: async (route: ContextRouteAdvice) => {
            if (route.base.activeSessionId !== sessionId) throw new Error('The draft route is stale')
            const page = valueOf(await remote.familyPage(sessionId, undefined, 1))
            const view = valueOf(await remote.get(sessionId))
            if (page.revision !== route.base.graphRevision
              || view.plan.revision !== route.base.planRevision
              || page.activeSessionId !== sessionId) throw new Error('The draft route is stale')
            const sourceScope = ctx.sessions.scope(sessionId)
            if (sourceScope === undefined) throw new Error('The current Session is unavailable')
            const { draft, draftRev, phase } = ctx.conversation.input.for(sourceScope).state.getSnapshot()
            if (phase !== 'plain' || draft.trim() !== route.objective) {
              throw new Error('The draft changed after Context review')
            }
            let targetId: SessionId
            if (route.action === 'branch') {
              const graph = controller.getSnapshot().graph
              if (controller.getSnapshot().graphRevision !== page.revision || graph === undefined) {
                throw new Error('The draft route is stale')
              }
              const pivot = graph.nodes.filter(node => node.sessionIds.includes(sessionId)
                && node.branchAtSeq !== null).at(-1)
              if (pivot?.branchAtSeq === null || pivot === undefined) {
                throw new Error('This Session has no completed Turn to branch from')
              }
              targetId = await ctx.sessions.fork({ sessionId, atSeq: pivot.branchAtSeq, increaseTitle: true })
            } else {
              const target = route.targetSessionId
              if (target === undefined || !page.sessions.some(session => session.id === target)) {
                throw new Error('The destination Session is unavailable')
              }
              targetId = target
            }
            if (!ctx.conversation.moveDraft(sessionId, targetId, { draft, draftRev })) {
              throw new Error('The draft changed or the destination cannot receive it')
            }
            try {
              valueOf(await remote.reviewRoute(sessionId, route, 'accept', targetId, 'contextify-client'))
            } finally {
              ctx.sessions.open(targetId)
            }
          },
          presentRecommendation: proposal => controller.presentRecommendation(proposal),
          dismissRecommendation: declinedNodeIds => controller.dismissRecommendation(declinedNodeIds),
          confirmArchive: candidate => controller.confirmArchive(candidate),
          archiveNode: node => controller.archiveNode(node),
          getNodeText: node => controller.getNodeText(node),
          focusNodeExcerpt: (node, start, end) => controller.focusNodeExcerpt(node, start, end),
          restoreNode: node => controller.restoreNode(node),
          branch: async (node: ContextFamilyGraphNode) => {
            const sourceScope = ctx.sessions.scope(sessionId)
            if (sourceScope === undefined) throw new Error('The current Session is unavailable')
            const { draft, draftRev } = ctx.conversation.input.for(sourceScope).state.getSnapshot()
            const childId = await ctx.sessions.fork(nativeBranchSource(node))
            if (!ctx.conversation.moveDraft(sessionId, childId, { draft, draftRev })) {
              throw new Error('The draft changed or the new branch cannot receive it')
            }
            try {
              valueOf(await remote.recordManualBranch(sessionId, childId, 'contextify-client'))
            } finally {
              ctx.sessions.open(childId)
            }
          },
          locate: (node) => { ctx.conversation.revealMessage(node.owner.sessionId, node.owner.seq) },
          close: () => { if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded() },
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

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'contextify-draft-review',
    order: 30,
    locale: 'contextifySteward',
    inject: (sessionId: SessionId): DraftContextReviewInjected => {
      const controller = controllerFor(sessionId)
      return {
        review: objective => controller.recommend('fast', objective, true),
        discard: () => { controller.clearRecommendation() },
        openMap: () => { ctx.sidebarRight.openTab('context-map') },
      }
    },
  }, DraftContextReview))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'contextify-open-details',
    order: -100,
    inject: () => ({
      open: () => { ctx.sidebarRight.openTab('context-map') },
    }),
  }, DetailsOpener))
}
