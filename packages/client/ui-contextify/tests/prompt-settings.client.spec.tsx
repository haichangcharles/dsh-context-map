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
