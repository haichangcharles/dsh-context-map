// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CONTEXTIFY_DEFAULT_PROMPTS, CONTEXTIFY_DEFAULT_SETTINGS } from '@deepseek-ai/dsh-contextify/types'
import type { ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import { stewardTestTranslator } from './test-locale.client.ts'
import { ContextifyPromptSettingsView } from '../src/client/ContextifyPromptSettings.tsx'
import {
  CONTEXTIFY_CLIENT_DEFAULT_PROMPTS,
  CONTEXTIFY_CLIENT_DEFAULT_SETTINGS,
} from '../src/client/prompt-defaults.ts'

afterEach(cleanup)

function scopeFixture(language: 'en' | 'zh' = 'en') {
  let snapshot: SettingsScopeSnapshot<ContextifyPromptSettings> = {
    status: 'ready', value: CONTEXTIFY_CLIENT_DEFAULT_SETTINGS, base: CONTEXTIFY_CLIENT_DEFAULT_SETTINGS,
    user: {}, revision: 1, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const set = vi.fn(async (field: string, value: unknown) => {
    snapshot = { ...snapshot, value: { ...snapshot.value!, [field]: value } }
    for (const listener of listeners) listener()
  })
  const scope: SettingsScope<ContextifyPromptSettings> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set,
    unset: vi.fn(async () => {}),
    mutate: vi.fn(async () => {}),
  }
  function Harness() {
    const current = useSyncExternalStore(
      listener => scope.subscribe(listener),
      () => scope.getSnapshot(),
    )
    return <ContextifyPromptSettingsView scope={scope} snapshot={current} t={stewardTestTranslator(language)} />
  }
  return { Harness, set }
}

describe('ContextifyPromptSettingsView', () => {
  it.each([
    { language: 'en', label: 'Fast Context reviewer', option: 'Goal model + exact task Context', hint: /at most one chat-model request and no Jev request/ },
    { language: 'zh', label: '快速 Context 决策模型', option: '目标模型＋完整任务 Context', hint: /至多一次聊天模型，不调用 Jev/ },
  ] as const)('offers an exact native reviewer in $language', async (scenario) => {
    const fixture = scopeFixture(scenario.language)
    render(<fixture.Harness />)
    expect(screen.getByRole('option', { name: scenario.option })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: scenario.label }), { target: { value: 'goal-model-native' } })
    await act(async () => {})
    expect(fixture.set).toHaveBeenCalledWith('fastDecisionProvider', 'goal-model-native')
    expect(screen.getByText(scenario.hint).textContent).toMatchSnapshot()
  })

  it('explains that the parent-model reviewer does not require Jev credentials', () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    expect(screen.getByText(/current chat model.*without Jev credentials/)).toBeTruthy()
    expect(screen.queryByText(/requires TYPESAFE_API_KEY/)).toBeNull()
  })

  it('selects goal-model and Jev review with an explicit extra-call explanation', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    expect(screen.getByRole('option', { name: 'Goal model + Jev Context' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Fast Context reviewer' }), { target: { value: 'goal-model-jev' } })
    await act(async () => {})
    expect(fixture.set).toHaveBeenCalledWith('fastDecisionProvider', 'goal-model-jev')
    expect(screen.getByText(/one chat-model request and at most one Jev request/).textContent).toMatchInlineSnapshot('"Draft review uses one chat-model request and at most one Jev request to choose a task, retain the requested history, and review sources under that choice. Uncertain tasks or retention scopes do not propose automatic routing. Both calls may incur charges; Jev credentials are required on the Host."')
  })
  it('explains task and history preservation in Chinese before confirmation', async () => {
    const fixture = scopeFixture('zh')
    render(<fixture.Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: '快速 Context 决策模型' }), { target: { value: 'goal-model-jev' } })
    await act(async () => {})
    expect(screen.getByText(/草稿检查先确定任务和要保留的历史/).textContent).toMatchInlineSnapshot('"草稿检查先确定任务和要保留的历史，再按该范围审核来源。任务或保留范围不明确时不建议自动切换。使用一次聊天模型及至多一次 Jev 调用，均可能收费，需在 Host 配置 Jev 凭据。"')
    expect(fixture.set).toHaveBeenCalledWith('fastDecisionProvider', 'goal-model-jev')
  })
  it('lets the user choose Jev and disable personal decision evidence', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Fast Context reviewer' }), { target: { value: 'jev' } })
    await act(async () => {})
    expect(fixture.set).toHaveBeenCalledWith('fastDecisionProvider', 'jev')
    fireEvent.click(screen.getByRole('checkbox', { name: /Learn from confirmed Context choices/ }))
    await act(async () => {})
    expect(fixture.set).toHaveBeenCalledWith('personalizationEnabled', false)
  })

  it.each([new Error('Setting write unavailable'), 'Setting write unavailable'])('preserves reviewer and personal settings after a failed write: %s', async (cause) => {
    const fixture = scopeFixture()
    fixture.set.mockRejectedValue(cause)
    render(<fixture.Harness />)
    const reviewer = screen.getByRole('combobox', { name: 'Fast Context reviewer' })
    fireEvent.change(reviewer, { target: { value: 'jev' } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Setting write unavailable')
    expect(reviewer).toHaveProperty('value', 'parent-model')
    const personal = screen.getByRole('checkbox', { name: /Learn from confirmed Context choices/ })
    fireEvent.click(personal)
    await act(async () => {})
    expect(fixture.set).toHaveBeenCalledWith('personalizationEnabled', false)
    expect(personal).toHaveProperty('checked', true)
    expect(personal).toHaveProperty('disabled', false)
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Setting write unavailable')
  })

  it('switches the reviewer back to the chat model and rejects an unknown DOM value', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    const reviewer = screen.getByRole('combobox', { name: 'Fast Context reviewer' })
    fireEvent.change(reviewer, { target: { value: 'jev' } })
    await act(async () => {})
    fireEvent.change(reviewer, { target: { value: 'parent-model' } })
    await act(async () => {})
    expect(reviewer).toHaveProperty('value', 'parent-model')
    expect(fixture.set).toHaveBeenLastCalledWith('fastDecisionProvider', 'parent-model')
    const before = fixture.set.mock.calls.length
    fireEvent.change(reviewer, { target: { value: 'unknown-reviewer' } })
    expect(fixture.set).toHaveBeenCalledTimes(before)
  })

  it('renders complete Chinese prompt labels rather than assembling English fragments', () => {
    const fixture = scopeFixture('zh')
    render(<fixture.Harness />)
    expect(screen.getByRole('button', { name: '保存归档指令' })).toBeTruthy()
    expect(screen.getByLabelText('追加分支指令')).toBeTruthy()
    expect(screen.getByLabelText('默认归档提示词')).toBeTruthy()
  })

  it('keeps its browser-safe default mirror equal to the Host authority', () => {
    expect(CONTEXTIFY_CLIENT_DEFAULT_PROMPTS).toEqual(CONTEXTIFY_DEFAULT_PROMPTS)
    expect(CONTEXTIFY_CLIENT_DEFAULT_SETTINGS).toEqual(CONTEXTIFY_DEFAULT_SETTINGS)
  })

  it('keeps defaults read-only, saves additions, and gates override editing', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)

    expect(screen.getByLabelText('Default Context prompt')).toHaveProperty('readOnly', true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Automatic Branch review/ }))
    expect(fixture.set).toHaveBeenCalledWith('automaticBranchReview', true)
    fireEvent.change(screen.getByLabelText('Additional Context instructions'), {
      target: { value: 'Prefer recent facts.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Context instructions' }))
    expect(fixture.set).toHaveBeenCalledWith('context', {
      additional: 'Prefer recent facts.', override: '',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Override default Context prompt' }))
    expect(screen.getByRole('dialog', { name: 'Confirm prompt override' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enable override' }))
    expect(screen.getByLabelText('Custom Context prompt')).toHaveProperty('readOnly', false)
  })

  it('persists a bounded Deep request limit and ignores invalid limits', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    const limit = screen.getByRole('spinbutton', { name: 'Deep review model request limit' })
    expect(limit).toHaveProperty('value', '3')
    fireEvent.change(limit, { target: { value: '2' } })
    expect(fixture.set).not.toHaveBeenCalledWith('deepMaxRequests', 2)
    fireEvent.click(screen.getByRole('button', { name: 'Save request limit' }))
    expect(fixture.set).toHaveBeenCalledWith('deepMaxRequests', 2)
    fireEvent.change(limit, { target: { value: '11' } })
    expect(fixture.set).not.toHaveBeenCalledWith('deepMaxRequests', 11)
    fireEvent.change(limit, { target: { value: '1.5' } })
    expect(fixture.set).not.toHaveBeenCalledWith('deepMaxRequests', 1.5)
  })

  it('restores the default base without discarding additional instructions', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)
    fireEvent.change(screen.getByLabelText('Additional Branch instructions'), {
      target: { value: 'Never branch parallel options.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Override default Branch prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable override' }))
    fireEvent.change(screen.getByLabelText('Custom Branch prompt'), { target: { value: 'Custom.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore default Branch prompt' }))

    expect(fixture.set).toHaveBeenLastCalledWith('branch', {
      additional: 'Never branch parallel options.', override: '',
    })
  })
})
