// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextMapPanel, type ContextMapPanelActions } from '../src/client/ContextMapPanel.tsx'

afterEach(cleanup)

describe('ContextMapPanel', () => {
  it('loads the durable graph and exposes branch and three-state context controls', async () => {
    const actions: ContextMapPanelActions = {
      load: vi.fn(() => Promise.resolve({
        view: {
          plan: {
            kind: 'contextify/plan', version: 1, revision: 2,
            mainlinePathId: 'root', activePathId: 'branch-1',
            paths: [
              { id: 'root', parentPathId: null, anchorSeq: null, label: 'Main', status: 'active' as const },
              { id: 'branch-1', parentPathId: 'root', anchorSeq: 4, label: 'Alternative', status: 'active' as const },
            ],
            overrides: [],
          },
          graphAsOfSeq: 9, activeTipSeq: 8, selectedCount: 2, totalNodeCount: 3,
        },
        records: [
          { seq: 4, parentSeq: null, pathId: 'root', turn: 1, role: 'user' as const, sourceKind: 'user', locked: false, preview: 'root requirement' },
          { seq: 6, parentSeq: 4, pathId: 'root', turn: 1, role: 'assistant' as const, sourceKind: 'model', locked: false, preview: 'old draft' },
          { seq: 8, parentSeq: 4, pathId: 'branch-1', turn: 2, role: 'user' as const, sourceKind: 'user', locked: false, preview: 'branch follow-up' },
        ],
      })),
      createBranch: vi.fn(() => Promise.resolve()),
      selectPath: vi.fn(() => Promise.resolve()),
      returnToMainline: vi.fn(() => Promise.resolve()),
      setNodeMode: vi.fn(() => Promise.resolve()),
      close: vi.fn(),
    }

    render(<ContextMapPanel actions={actions} />)
    expect(await screen.findByText('root requirement')).toBeTruthy()
    expect(screen.getByText('branch follow-up')).toBeTruthy()
    expect(screen.getByText('2 / 3 selected')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Exclude root requirement' }))
    await waitFor(() => { expect(actions.setNodeMode).toHaveBeenCalledWith(4, 'exclude', 2) })
    fireEvent.click(screen.getByRole('button', { name: 'Branch from root requirement' }))
    await waitFor(() => { expect(actions.createBranch).toHaveBeenCalledWith(4, 2) })
    fireEvent.click(screen.getByRole('button', { name: 'Return to mainline' }))
    await waitFor(() => { expect(actions.returnToMainline).toHaveBeenCalledWith(2) })
    fireEvent.click(screen.getByRole('button', { name: 'Close Context Map' }))
    expect(actions.close).toHaveBeenCalledOnce()
  })
})
