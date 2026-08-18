import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { deriveArchivedGroups } from '../src/client/archived.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId
const summary = (id: string, title = id, parentId?: string): SessionSummary => ({
  id: sid(id), displayTitle: title, running: false, blank: false, updatedAt: 1,
  ...(parentId === undefined ? {} : { parentId: sid(parentId) }),
})
const sessions = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined, currentAddress: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), title, path: `/w/${id}`, sessionIds: sessionIds.map(sid),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('deriveArchivedGroups', () => {
  it('uses current Workspace order, reverse archive order, and current parent labels', () => {
    const list = sessions(
      summary('parent', 'Root'), summary('a', 'Alpha', 'parent'), summary('b', 'Beta'),
      summary('loose', 'Loose'),
    )
    const groups = deriveArchivedGroups(
      list,
      [workspace('first', ['b', 'a'], 'First'), workspace('empty', [], 'Empty')],
      [sid('a'), sid('loose'), sid('b')],
      '',
    )

    expect(groups).toEqual([
      {
        key: 'first', title: 'First',
        sessions: [
          { id: 'b', title: 'Beta', parentTitle: undefined },
          { id: 'a', title: 'Alpha', parentTitle: 'Root' },
        ],
      },
      {
        key: 'ungrouped', title: undefined,
        sessions: [{ id: 'loose', title: 'Loose', parentTitle: undefined }],
      },
    ])
  })

  it('filters titles, ids, Workspace names, and keeps missing summaries restorable', () => {
    const list = sessions(summary('owned', 'Ordinary'))
    const workspaces = [workspace('research', ['owned', 'missing'], 'Needle Workspace')]
    const archived = [sid('owned'), sid('missing')]

    expect(deriveArchivedGroups(list, workspaces, archived, 'needle')[0]?.sessions.map(row => row.id))
      .toEqual(['missing', 'owned'])
    expect(deriveArchivedGroups(list, workspaces, archived, 'missing')[0]?.sessions)
      .toEqual([{ id: 'missing', title: 'missing', parentTitle: undefined }])
    expect(deriveArchivedGroups(list, workspaces, archived, 'nothing')).toEqual([])
  })
})
