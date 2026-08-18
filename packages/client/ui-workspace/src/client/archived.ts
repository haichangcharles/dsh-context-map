/** Pure projection for the sidebar's archived-session subview. */
import type { SessionId, SessionListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** Stable key for archived Sessions whose current Workspace account is absent. */
export const ARCHIVED_UNGROUPED_KEY = 'ungrouped'

/** One restorable Session row. */
export interface ArchivedSessionRow {
  id: SessionId
  title: string
  parentTitle: string | undefined
}

/** One current Workspace group; ungrouped intentionally has no title. */
export interface ArchivedSessionGroup {
  key: string
  title: string | undefined
  sessions: ArchivedSessionRow[]
}

/**
 * Group archived stable ids by the current Workspace registry projection.
 * Workspace order is authoritative; within each group the latest archive is
 * first. Missing summaries remain addressable by id so restore is never
 * blocked by a temporarily incomplete Session list.
 * @param list - Current native Session summary projection.
 * @param workspaces - Current authoritative Workspace accounting order.
 * @param archivedSessionIds - Stable archived ids in archive order.
 * @param query - Local case-insensitive title/id filter.
 * @returns Visible archived rows grouped by their current Workspace account.
 */
export function deriveArchivedGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  query: string,
): ArchivedSessionGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const ownerBySession = new Map<SessionId, WorkspaceView>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!ownerBySession.has(sessionId)) ownerBySession.set(sessionId, workspace)
    }
  }
  const rowsByGroup = new Map<string, ArchivedSessionRow[]>()
  for (const sessionId of [...archivedSessionIds].reverse()) {
    const session = list.byId[sessionId]
    const workspace = ownerBySession.get(sessionId)
    const title = session?.displayTitle ?? sessionId
    const parentTitle = session?.parentId === undefined
      ? undefined
      : list.byId[session.parentId]?.displayTitle
    const matches = normalizedQuery === '' || [title, sessionId, workspace?.title, parentTitle]
      .some(value => value?.toLocaleLowerCase().includes(normalizedQuery) === true)
    if (!matches) continue
    const key = workspace?.workspaceId as string | undefined ?? ARCHIVED_UNGROUPED_KEY
    const rows = rowsByGroup.get(key) ?? []
    rows.push({ id: sessionId, title, parentTitle })
    rowsByGroup.set(key, rows)
  }
  const groups: ArchivedSessionGroup[] = []
  for (const workspace of workspaces) {
    const sessions = rowsByGroup.get(workspace.workspaceId)
    if (sessions !== undefined) groups.push({ key: workspace.workspaceId, title: workspace.title, sessions })
  }
  const ungrouped = rowsByGroup.get(ARCHIVED_UNGROUPED_KEY)
  if (ungrouped !== undefined) groups.push({ key: ARCHIVED_UNGROUPED_KEY, title: undefined, sessions: ungrouped })
  return groups
}
