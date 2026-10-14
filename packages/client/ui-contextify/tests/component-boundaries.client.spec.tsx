// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextFamilyGraphNode, ContextFamilyGraph, ContextRecommendationProposal } from '@deepseek-ai/dsh-contextify/types'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import { ContextMapMenu } from '../src/client/ContextMapMenu.tsx'
import { ContextMapNode, type ContextMapNodeData } from '../src/client/ContextMapNode.tsx'
import { ContextMessageAction } from '../src/client/ContextMessageAction.tsx'
import { ContextRecommendationReview, type ContextRecommendationReviewProps } from '../src/client/ContextRecommendationReview.tsx'
import { ContextifyPromptSettingsSection, ContextifyPromptSettingsView } from '../src/client/ContextifyPromptSettings.tsx'
import { DraftContextReview } from '../src/client/DraftContextReview.tsx'
import { BranchSuggestionTail } from '../src/client/BranchSuggestionTail.tsx'
import { BranchSuggestionCard } from '../src/client/BranchSuggestionCard.tsx'
import type { ContextifyControllerSnapshot } from '../src/client/controller.ts'
import { CONTEXTIFY_CLIENT_DEFAULT_SETTINGS as defaults, CONTEXTIFY_CLIENT_DEFAULT_PROMPTS as prompts } from '../src/client/prompt-defaults.ts'
import { apply } from '../src/index.ts'
import { stewardTestTranslator } from './test-locale.client.ts'

// React Flow owns Handle positioning; these tests exercise the public card DOM.
vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(), Handle: () => null,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const t = stewardTestTranslator()
const sid = (value: string) => value as SessionId
const root = sid('root')
const node = (patch: Partial<ContextFamilyGraphNode> = {}): ContextFamilyGraphNode => ({
  id: 'root:1', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'planning evidence',
  time: 1, branchAtSeq: 2, sessionIds: [root], activeEventSeq: 1, ...patch,
})
const graph: ContextFamilyGraph = { rootSessionId: root, activeSessionId: root,
  sessions: [{ id: root, depth: 0, seedLength: 0, tipNodeId: 'root:1' }], nodes: [node()], edges: [] }
const plan = { kind: 'contextify/plan' as const, version: 3 as const, revision: 1, stateRevision: 1,
  history: { past: [], future: [] }, excluded: [], included: [], replacements: [] }
const snapshot: ContextifyControllerSnapshot = { phase: 'ready', pending: false, recommendation: { phase: 'idle' }, graph,
  view: { plan, graphAsOfSeq: 2, selectedCount: 1, totalNodeCount: 1, canUndo: false, canRedo: false } }
function hook(value: ContextifyControllerSnapshot): SnapshotSelectorHook<ContextifyControllerSnapshot> {
  return selector => selector(value)
}
const suggestion = { id: 'suggestion', sourceSessionId: root, turn: 1, boundaryBefore: 0, boundaryAfter: 3,
  input: { sessionId: root, seq: 1 }, output: { sessionId: root, seq: 2 }, inputPreview: 'side task',
  outputPreview: 'side answer', confidence: 0.9, reason: 'Separate objective', planRevision: 1, graphRevision: 'g1' }
function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function menu(record = node(), overrides: Partial<ComponentProps<typeof ContextMapMenu>> = {}) {
  const props = { record, point: { x: 12, y: 34 }, mode: 'include' as const, pending: false, close: vi.fn(),
    locate: vi.fn(), branch: vi.fn(async () => {}), restoreAutomatic: vi.fn(), archive: vi.fn(),
    focusExcerpt: vi.fn(), showOriginal: vi.fn(), restoreOriginal: vi.fn(), reportError: vi.fn(), t, ...overrides }
  const outer = { pointer: vi.fn(), click: vi.fn(), context: vi.fn() }
  const view = render(<div onPointerDown={outer.pointer} onClick={outer.click} onContextMenu={outer.context}>
    <ContextMapMenu {...props} /></div>)
  return { ...view, props, outer }
}

describe('public Context component boundaries', () => {
  it('keeps the browser Loader seat side-effect free', () => { expect(() => { apply() }).not.toThrow() })
  it('closes pointer menus and reports synchronous and asynchronous failures', async () => {
    const failure = new Error('Locate unavailable')
    const h = menu(node(), { locate: () => { throw failure }, branch: async () => { throw 'fork failed' } })
    const popup = screen.getByRole('menu')
    fireEvent.pointerDown(popup)
    fireEvent.contextMenu(popup)
    expect(h.outer.pointer).not.toHaveBeenCalled()
    expect(h.outer.context).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate in Chat' }))
    expect(h.props.reportError).toHaveBeenCalledWith(failure)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from Here' }))
    await waitFor(() => { expect(h.props.reportError).toHaveBeenCalledWith('fork failed') })
    expect(h.props.close).toHaveBeenCalledTimes(2)
    expect(h.outer.click).not.toHaveBeenCalled()
  })
  it('routes archive, excerpt and automatic actions to the exact selected record', () => {
    const h = menu()
    for (const name of ['Archive node', t('copy.keepTextExcerpt'), 'Restore automatic']) {
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    expect(h.props.archive).toHaveBeenCalledWith(h.props.record)
    expect(h.props.focusExcerpt).toHaveBeenCalledWith(h.props.record)
    expect(h.props.restoreAutomatic).toHaveBeenCalledWith(h.props.record)
    expect(h.props.close).toHaveBeenCalledTimes(3)
  })
  it('offers original restoration for overlays and rejects unsupported native actions', () => {
    const replacement = { kind: 'excerpt' as const, preview: 'selected excerpt', original: 'full text', reason: 'focus', role: 'user' as const, originalAvailable: true as const }
    const h = menu(node({ replacement }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show original' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore node' }))
    expect(h.props.showOriginal).toHaveBeenCalledWith(h.props.record)
    expect(h.props.restoreOriginal).toHaveBeenCalledWith(h.props.record)
    expect(screen.queryByRole('menuitem', { name: 'Archive node' })).toBeNull()
    h.unmount()
    menu(node({ sourceKind: 'worker', branchAtSeq: null, activeEventSeq: null }), { mode: 'natural', pending: true })
    expect(screen.getByRole('menuitem', { name: 'Branch from Here' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('menuitem', { name: 'Restore automatic' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: t('copy.keepTextExcerpt') })).toBeNull()
  })
  it('renders native, imported, tool and overlay nodes and isolates their direct controls', () => {
    const data: ContextMapNodeData = { record: node({ preview: '' }), t, mode: 'natural', included: false, pending: false,
      sessionLabel: 'Mainline', active: false, focused: false, searchMatch: false,
      onActivate: vi.fn(), onIncludedChange: vi.fn(), onContextMenu: vi.fn() }
    const outside = vi.fn()
    const draw = (value: ContextMapNodeData, selected = false) => <div onClick={outside} onPointerDown={outside} onContextMenu={outside}>
      <ContextMapNode id="node" data={value} selected={selected} type="contextify" dragging={false}
        isConnectable={false} selectable={true} deletable={false} draggable={false} zIndex={0}
        positionAbsoluteX={0} positionAbsoluteY={0} /></div>
    const h = render(draw(data))
    const checkbox = screen.getByRole('checkbox')
    fireEvent.pointerDown(checkbox)
    fireEvent.click(checkbox)
    expect(data.onIncludedChange).toHaveBeenCalledWith(data.record, true)
    expect(outside).not.toHaveBeenCalled()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 120 })
    fireEvent(screen.getByRole('article'), event)
    expect(event.defaultPrevented).toBe(true)
    expect(data.onContextMenu).toHaveBeenCalledWith(data.record, { x: 90, y: 120 })
    const roles = ['worker', 'web', 'chat'] as const
    for (const sourceKind of roles) h.rerender(draw({ ...data, record: node({ sourceKind, role: 'tool' }), included: true, pending: true, active: true, focused: true, searchMatch: true, recommendation: 'include' }, true))
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('article').getAttribute('data-selected')).toBe('true')
    for (const recommendation of ['exclude', 'archive'] as const) h.rerender(draw({ ...data, recommendation }))
    const replacement = { kind: 'placeholder' as const, preview: '', original: 'original', reason: 'obsolete', role: 'user' as const, originalAvailable: true as const }
    h.rerender(draw({ ...data, record: node({ replacement }) }))
    expect(screen.getByRole('article').getAttribute('data-replacement')).toBe('placeholder')
    expect(screen.getByRole('checkbox').getAttribute('aria-label')).toBe(t('copy.includeEmptyPlaceholderInContext', { p0: 'user' }))
    h.rerender(draw({ ...data, record: node({ replacement: { ...replacement, kind: 'excerpt', preview: 'focused text' } }) }))
    expect(screen.getByRole('article').getAttribute('aria-label')).toContain('focused text')
  })
  it('uses the durable Include and Exclude modes and survives failed Chat mutations', async () => {
    const change = vi.fn(async () => { throw new Error('offline') })
    const locate = vi.fn()
    const draw = (value: ContextifyControllerSnapshot, seq = 1) => <ContextMessageAction seq={seq}
      useContextify={hook(value)} setNodeMode={change} locate={locate} t={t} />
    const h = render(draw({ ...snapshot, view: { ...snapshot.view!, plan: { ...plan, included: [{ nodeId: 'root:1', snapshotSeq: 2, position: 0 }] } } }))
    expect(screen.getByRole('button', { name: 'include context for planning evidence' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'exclude context for planning evidence' }))
    await act(async () => {})
    expect(change).toHaveBeenCalledWith(node().owner, 'exclude')
    fireEvent.click(screen.getByRole('button', { name: 'Locate planning evidence in Context Map' }))
    expect(locate).toHaveBeenCalledWith('root:1')
    h.rerender(draw({ ...snapshot, pending: true, view: { ...snapshot.view!, plan: { ...plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }] } } }))
    expect(screen.getAllByRole('button').slice(0, 3).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
    h.rerender(draw({ phase: 'loading', pending: false, recommendation: { phase: 'idle' } }))
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('moves the matching tail and dismisses only after Keep has been persisted', async () => {
    const keep = vi.fn(async () => {})
    const move = vi.fn(async () => {})
    const props = { t, matched: 2,
      useContextify: hook({ ...snapshot, view: { ...snapshot.view!, branchSuggestion: suggestion } }),
      keepBranchSuggestion: keep, moveBranchSuggestion: move }
    const h = render(<BranchSuggestionTail {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Move to new branch' }))
    await waitFor(() => { expect(move).toHaveBeenCalledWith('suggestion') })
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    await waitFor(() => { expect(screen.queryByRole('complementary')).toBeNull() })
    expect(keep).toHaveBeenCalledWith('suggestion')
    h.rerender(<BranchSuggestionTail {...props} useContextify={hook(snapshot)} />)
    expect(screen.queryByRole('complementary')).toBeNull()
  })
  it('displays non-Error branch failures and blocks pending actions', async () => {
    const keep = vi.fn(async () => { throw 'choice rejected' })
    const move = vi.fn(async () => {})
    const h = render(<BranchSuggestionCard suggestion={suggestion} t={t} pending={false} keep={keep} move={move} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'choice rejected')
    h.rerender(<BranchSuggestionCard suggestion={suggestion} t={t} pending keep={keep} move={move} />)
    expect(screen.getByRole('button', { name: 'Move to new branch' })).toHaveProperty('disabled', true)
  })
})

const draftInput = { draft: 'Continue planning', draftRev: 1, phase: 'plain' as const, attachmentIds: [], occurrences: [], queue: [] }
describe('draft review public asynchronous boundaries', () => {
  it('supports Local and Deep menu choices, Escape, and other menu keys', async () => {
    const review = vi.fn(async () => {})
    render(<DraftContextReview input={draftInput} review={review} discard={vi.fn()} openMap={vi.fn()} t={t} />)
    for (const mode of ['Local', 'Deep']) {
      fireEvent.click(screen.getByRole('button', { name: 'Draft review mode' }))
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Draft review mode' }))
      fireEvent.click(screen.getByRole('menuitem', { name: `${mode} review for draft` }))
      await act(async () => {})
      expect(review).toHaveBeenLastCalledWith('Continue planning', mode.toLowerCase())
    }
  })
  it.each([new Error('model unavailable'), 'model rejected'])('shows a bounded review error: %s', async (cause) => {
    render(<DraftContextReview input={draftInput} review={async () => { throw cause }} discard={vi.fn()} openMap={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', cause instanceof Error ? cause.message : cause)
  })
  it.each(['resolve', 'reject'] as const)('does not publish an asynchronous %s after unmount', async (outcome) => {
    const task = deferred()
    const openMap = vi.fn()
    const discard = vi.fn()
    const h = render(<DraftContextReview input={draftInput} review={() => task.promise} discard={discard} openMap={openMap} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    expect(screen.getByRole('button', { name: t('action.reviewingDraft') })).toHaveProperty('disabled', true)
    h.unmount()
    await act(async () => { if (outcome === 'resolve') task.resolve(); else task.reject(new Error('offline')) })
    expect(openMap).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  })
  it('coalesces queued duplicate DOM clicks before pending controls render', async () => {
    const task = deferred()
    const review = vi.fn(() => task.promise)
    render(<DraftContextReview input={draftInput} review={review} discard={vi.fn()} openMap={vi.fn()} t={t} />)
    const button = screen.getByRole('button', { name: 'Review context for draft' })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(review).toHaveBeenCalledOnce()
    await act(async () => { task.resolve() })
  })
  it('rejects changed text even with unchanged revision and hides a claimed composer', async () => {
    const task = deferred()
    const discard = vi.fn()
    const props = { review: () => task.promise, discard, openMap: vi.fn(), t }
    const h = render(<DraftContextReview {...props} input={draftInput} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    h.rerender(<DraftContextReview {...props} input={{ ...draftInput, draft: 'A different objective' }} />)
    await act(async () => { task.resolve() })
    expect(discard).toHaveBeenCalledOnce()
    h.rerender(<DraftContextReview {...props} input={{ ...draftInput, phase: 'claimed' }} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

function settingsFixture(patch: Partial<SettingsScopeSnapshot<ContextifyPromptSettings>> = {}) {
  let current: SettingsScopeSnapshot<ContextifyPromptSettings> = { status: 'ready', value: defaults, base: defaults, user: {}, revision: 1, writable: true, mode: 'host', ...patch }
  const listeners = new Set<() => void>()
  const set = vi.fn(async () => {})
  const scope: SettingsScope<ContextifyPromptSettings> = { getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set, unset: vi.fn(async () => {}), mutate: vi.fn(async () => {}) }
  const update = (next: Partial<SettingsScopeSnapshot<ContextifyPromptSettings>>) => {
    act(() => { current = { ...current, ...next }; for (const listener of listeners) listener() })
  }
  return { scope, set, update, get current() { return current }, listeners }
}
describe('prompt settings public scope lifecycle', () => {
  it('connects and disconnects the supplied scope and handles loading/unavailable/default states', () => {
    const fixture = settingsFixture({ status: 'loading', value: undefined })
    const h = render(<ContextifyPromptSettingsSection t={t} />)
    expect(h.container.textContent).toBe('')
    h.rerender(<ContextifyPromptSettingsSection t={t} scope={fixture.scope} />)
    expect(h.container.textContent).toContain('Loading Context Map prompts')
    expect(fixture.listeners.size).toBe(1)
    fixture.update({ status: 'unavailable' })
    expect(h.container.textContent).toContain('unavailable')
    fixture.update({ status: 'ready', writable: false })
    expect(screen.getByRole('button', { name: 'Save request limit' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled', true)
    h.unmount()
    expect(fixture.listeners.size).toBe(0)
  })
  it.each([new Error('write failed'), 'write rejected'])('recovers a failed budget save: %s', async (cause) => {
    const fixture = settingsFixture()
    fixture.set.mockRejectedValueOnce(cause)
    render(<ContextifyPromptSettingsView scope={fixture.scope} snapshot={fixture.current} t={t} />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save request limit' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', cause instanceof Error ? cause.message : cause)
    expect(screen.getByRole('spinbutton')).toHaveProperty('value', '3')
  })
  it('saves custom text, falls back to the default when emptied, and cancels override confirmation', async () => {
    const fixture = settingsFixture({ value: { ...defaults, context: { additional: '', override: 'Custom initial' } } })
    render(<ContextifyPromptSettingsView scope={fixture.scope} snapshot={fixture.current} t={t} />)
    fireEvent.change(screen.getByLabelText('Custom Context prompt'), { target: { value: '' } })
    expect(screen.getByLabelText('Custom Context prompt')).toHaveProperty('value', prompts.context)
    fireEvent.change(screen.getByLabelText('Custom Context prompt'), { target: { value: 'Custom selected' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save custom Context prompt' }))
    await waitFor(() => { expect(fixture.set).toHaveBeenCalledWith('context', { additional: '', override: 'Custom selected' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Override default Archive prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('Custom Archive prompt')).toBeNull()
  })
})

function proposal(patch: Partial<ContextRecommendationProposal> = {}): ContextRecommendationProposal {
  return { mode: 'local', base: { planRevision: 1, graphRevision: 'g1', activeSessionId: root },
    currentNodeIds: ['root:1'], proposedNodeIds: ['extra'], addedNodeIds: ['extra'], removedNodeIds: ['root:1'],
    selection: [{ nodeId: 'extra', action: 'include', confidence: 'high', reason: 'Relevant' },
      { nodeId: 'root:1', action: 'exclude', confidence: 'medium', reason: 'Obsolete' }], archive: [], ...patch }
}
function reviewSheet(value = proposal(), overrides: Partial<ContextRecommendationReviewProps> = {}) {
  const props: ContextRecommendationReviewProps = { state: { phase: 'ready', proposal: value }, graph, pending: false,
    acceptRoute: vi.fn(async () => {}), rejectRoute: vi.fn(async () => {}), present: vi.fn(async () => {}),
    apply: vi.fn(async () => {}), confirmArchive: vi.fn(async () => {}), dismiss: vi.fn(async () => {}),
    reportError: vi.fn(), reviewWorkState: vi.fn(async () => {}), t, ...overrides }
  return { ...render(<ContextRecommendationReview {...props} />), props }
}
describe('Context recommendation review public decisions', () => {
  it('tracks partial and reversed choices and applies only the final declined IDs', async () => {
    const h = reviewSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current context for extra' }))
    expect(screen.getByRole('button', { name: 'Apply selected changes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current context for planning evidence' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep current context' }))
    expect(h.props.apply).toHaveBeenCalledWith(['extra', 'root:1'])
    fireEvent.click(screen.getByRole('button', { name: 'Use proposed change for extra' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close recommendation review' }))
    expect(h.props.dismiss).toHaveBeenCalledWith(['root:1'])
  })
  it.each(['branch', 'return', 'navigate'] as const)('routes only explicit %s confirmation and records Stay separately', async (action) => {
    const value = proposal({ route: { action, base: proposal().base, objective: 'Continue plan', reason: 'Related destination', targetSessionId: sid('child') } })
    const h = reviewSheet(value)
    const caption = action === 'branch' ? 'Start a new branch' : action === 'return' ? 'Return with draft' : 'Move draft to branch'
    fireEvent.click(screen.getByRole('button', { name: caption }))
    expect(h.props.acceptRoute).toHaveBeenCalledWith(value.route)
    fireEvent.click(screen.getByRole('button', { name: 'Stay in this branch' }))
    await waitFor(() => { expect(screen.queryByRole('region', { name: 'Draft route recommendation' })).toBeNull() })
    expect(h.props.rejectRoute).toHaveBeenCalledWith(value.route)
  })
  it('reviews independent lifecycle decisions with branch labels and durable success boundaries', async () => {
    const child = sid('child')
    const unknown = sid('retained-branch')
    const value = proposal({ workStates: [{ sessionId: root, state: 'completed', reason: 'Done' },
      { sessionId: child, state: 'parked', reason: 'Later' }, { sessionId: unknown, state: 'open', reason: 'Resume' }] })
    const h = reviewSheet(value, { graph: { ...graph, nodes: [...graph.nodes, node({ id: 'child:1', owner: { sessionId: child, seq: 1 }, preview: 'child task' })],
      sessions: [...graph.sessions, { id: child, depth: 1, seedLength: 1, parentSessionId: root, tipNodeId: 'child:1' }] } })
    expect(screen.getByText('Mainline')).toBeTruthy()
    expect(screen.getByText('child task')).toBeTruthy()
    expect(screen.getByText('retained-branch')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('lifecycle.completed') }))
    await waitFor(() => { expect(h.props.reviewWorkState).toHaveBeenCalledWith(value, root, 'accept') })
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep current state' })[0]!)
    await waitFor(() => { expect(h.props.reviewWorkState).toHaveBeenCalledWith(value, child, 'reject') })
    fireEvent.click(screen.getByRole('button', { name: t('lifecycle.open') }))
    await waitFor(() => { expect(h.props.reviewWorkState).toHaveBeenCalledWith(value, unknown, 'accept') })
    expect(h.props.apply).not.toHaveBeenCalled()
  })
  it('reviews archive pivots, missing-node previews, cancellation and Keep without implicit mutation', async () => {
    const value = proposal({ selection: [], archive: [{ nodeId: 'missing', category: 'obsolete', reason: 'Superseded', evidenceNodeIds: ['root:1', 'missing-evidence'] },
      { nodeId: 'root:1', category: 'redundant', reason: 'Repeated', evidenceNodeIds: [] }] })
    const h = reviewSheet(value, { graph: { ...graph, edges: [
      { id: 'one', source: 'root:1', target: 'extra', sessionIds: [root] }, { id: 'two', source: 'root:1', target: 'other', sessionIds: [root] }] } })
    expect(screen.getByText(/missing-evidence/)).toBeTruthy()
    expect(screen.getByText(/branch pivot/)).toBeTruthy()
    const article = screen.getByText('missing', { selector: 'strong' }).closest('article')!
    fireEvent.click(within(article).getByRole('button', { name: 'Review archive' }))
    expect(within(article).getByText(t('copy.unavailable'))).toBeTruthy()
    fireEvent.click(within(article).getByRole('button', { name: 'Cancel' }))
    expect(within(article).queryByText(t('copy.unavailable'))).toBeNull()
    fireEvent.click(within(article).getByRole('button', { name: 'Review archive' }))
    fireEvent.click(within(article).getByRole('button', { name: 'Archive node' }))
    expect(h.props.confirmArchive).toHaveBeenCalledWith(value.archive[0])
    fireEvent.click(within(article).getByRole('button', { name: 'Keep original' }))
    expect(screen.queryByText('missing', { selector: 'strong' })).toBeNull()
  })
  it('presents only visible current proposals, retries a failed visibility write and ignores superseded errors', async () => {
    let visibility = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
    const old = deferred()
    const present = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(undefined)
    const h = reviewSheet(proposal(), { present })
    expect(present).not.toHaveBeenCalled()
    visibility = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(present).toHaveBeenCalledTimes(1)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(present).toHaveBeenCalledTimes(1)
    const next = proposal({ mode: 'deep' })
    h.rerender(<ContextRecommendationReview {...h.props} state={{ phase: 'ready', proposal: next }} />)
    await act(async () => { old.reject(new Error('old unavailable')) })
    expect(h.props.reportError).toHaveBeenCalledOnce()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(present).toHaveBeenCalledTimes(2)
    h.unmount()
    const fail = vi.fn().mockRejectedValueOnce(new Error('present failed')).mockResolvedValue(undefined)
    const fresh = reviewSheet(proposal({ mode: 'fast' }), { present: fail })
    await waitFor(() => { expect(fresh.props.reportError).toHaveBeenCalledOnce() })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fail).toHaveBeenCalledTimes(2)
  })
  it('reports rejected public actions and disables stale plans without presenting them', async () => {
    const cause = new Error('stale write')
    const h = reviewSheet(proposal(), { apply: async () => { throw cause } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed context' }))
    await waitFor(() => { expect(h.props.reportError).toHaveBeenCalledWith(cause) })
    const stale = proposal({ workStates: [{ sessionId: root, state: 'parked', reason: 'Later' }] })
    h.rerender(<ContextRecommendationReview {...h.props} state={{ phase: 'stale', proposal: stale }} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('button', { name: t('lifecycle.parked') })).toHaveProperty('disabled', true)
    h.rerender(<ContextRecommendationReview {...h.props} state={{ phase: 'running', mode: 'deep' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    h.rerender(<ContextRecommendationReview {...h.props} state={{ phase: 'error', mode: 'fast', error: 'failure' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    h.rerender(<ContextRecommendationReview {...h.props} state={{ phase: 'idle' }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
