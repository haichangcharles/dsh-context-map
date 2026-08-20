// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CONTEXTIFY_DEFAULT_PROMPTS } from '@deepseek-ai/dsh-contextify/types'
import type { ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import { ContextifyPromptSettingsView } from '../src/client/ContextifyPromptSettings.tsx'
import {
  CONTEXTIFY_CLIENT_DEFAULT_PROMPTS,
  CONTEXTIFY_CLIENT_DEFAULT_SETTINGS,
} from '../src/client/prompt-defaults.ts'

afterEach(cleanup)

function scopeFixture() {
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
  }
  function Harness() {
    const current = useSyncExternalStore(
      listener => scope.subscribe(listener),
      () => scope.getSnapshot(),
    )
    return <ContextifyPromptSettingsView scope={scope} snapshot={current} />
  }
  return { Harness, set }
}

describe('ContextifyPromptSettingsView', () => {
  it('keeps its browser-safe default mirror equal to the Host authority', () => {
    expect(CONTEXTIFY_CLIENT_DEFAULT_PROMPTS).toEqual(CONTEXTIFY_DEFAULT_PROMPTS)
  })

  it('keeps defaults read-only, saves additions, and gates override editing', async () => {
    const fixture = scopeFixture()
    render(<fixture.Harness />)

    expect(screen.getByLabelText('Default Context prompt')).toHaveProperty('readOnly', true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Automatic Branch review/ }))
    expect(fixture.set).toHaveBeenCalledWith('automaticBranchReview', false)
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
