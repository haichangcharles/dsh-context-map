// @vitest-environment jsdom
/**
 * Public assembled path: WorkspaceBrowser → injected IWorkspaces restore →
 * authoritative archivedSessionIds projection. Restore must not open or
 * otherwise change the selected Session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

describe('session archive restore through the assembled browser', () => {
  it('restores through the runtime projection without opening the Session', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', {
      hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const archivedId = 'archived' as SessionId
    const currentId = 'current' as SessionId
    await runtime.sessions.add({
      id: archivedId,
      summary: { title: '归档分支', displayTitle: '归档分支', cwd: '/w/alpha' },
    })
    await runtime.sessions.add({
      id: currentId,
      summary: { title: '当前会话', displayTitle: '当前会话', cwd: '/w/alpha' },
    })
    runtime.sessions.open(currentId)
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha',
        sessionIds: [currentId, archivedId],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
      draft.archivedSessionIds = [archivedId]
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    fireEvent.click(await view.findByRole('button', { name: '查看已归档会话（1）' }))
    fireEvent.click(view.getByRole('button', { name: '恢复“归档分支”' }))
    await waitFor(() => {
      expect(runtime.workspaces.calls).toContainEqual({ method: 'unarchiveSession', args: [archivedId] })
      expect(runtime.workspaces.list.getSnapshot().archivedSessionIds).toEqual([])
      expect(view.queryByText('归档分支')).toBeNull()
    })
    expect(runtime.sessions.list.getSnapshot().current).toBe(currentId)
    await runtime.dispose()
  })
})
