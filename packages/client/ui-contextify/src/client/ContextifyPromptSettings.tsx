/** Profile prompt dashboard for Context, Archive, and Branch review agents. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ContextifyPromptSection, ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import {
  CONTEXTIFY_CLIENT_DEFAULT_PROMPTS,
  CONTEXTIFY_CLIENT_DEFAULT_SETTINGS,
  effectiveClientPrompt,
} from './prompt-defaults.ts'
import css from './ContextifyPromptSettings.module.css'

type PromptKind = 'context' | 'archive' | 'branch'
const kinds: readonly PromptKind[] = ['context', 'archive', 'branch']

function label(kind: PromptKind): string {
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`
}

export interface ContextifyPromptSettingsViewProps {
  readonly scope: SettingsScope<ContextifyPromptSettings>
  readonly snapshot: SettingsScopeSnapshot<ContextifyPromptSettings>
}

/** Slot-facing wrapper over the native settings scope. */
export function ContextifyPromptSettingsSection({ scope }: {
  readonly scope?: SettingsScope<ContextifyPromptSettings>
}) {
  if (scope === undefined) return null
  return <ConnectedPromptSettings scope={scope} />
}

function ConnectedPromptSettings({ scope }: { readonly scope: SettingsScope<ContextifyPromptSettings> }) {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  return <ContextifyPromptSettingsView scope={scope} snapshot={snapshot} />
}

/** Render package defaults as immutable reference and Profile changes as explicit layers. */
export function ContextifyPromptSettingsView({ scope, snapshot }: ContextifyPromptSettingsViewProps) {
  const settings = snapshot.value ?? CONTEXTIFY_CLIENT_DEFAULT_SETTINGS
  const [drafts, setDrafts] = useState<ContextifyPromptSettings>(settings)
  const [confirming, setConfirming] = useState<PromptKind | null>(null)
  const [overrideEnabled, setOverrideEnabled] = useState<ReadonlySet<PromptKind>>(
    () => new Set(kinds.filter(kind => settings[kind].override.trim().length > 0)),
  )
  const [pending, setPending] = useState<PromptKind | null>(null)

  useEffect(() => { setDrafts(settings) }, [settings])

  const update = (kind: PromptKind, patch: Partial<ContextifyPromptSection>): void => {
    setDrafts(current => ({ ...current, [kind]: { ...current[kind], ...patch } }))
  }
  const save = async (kind: PromptKind, section: ContextifyPromptSection): Promise<void> => {
    setPending(kind)
    try { await scope.set(kind, section) } finally { setPending(null) }
  }

  if (snapshot.status === 'loading') return <div className={css.state}>Loading Context Map prompts…</div>
  if (snapshot.status !== 'ready') {
    return <div className={css.state}>Prompt settings are unavailable in this deployment.</div>
  }

  return <section className={css.root} aria-label="Context Map prompt settings">
    <header>
      <h2>Context Map prompts</h2>
      <p>Package defaults stay visible and read-only. Add Profile rules, or explicitly override a base prompt.</p>
    </header>
    <label className={css.card}>
      <span>Automatic Branch review</span>
      <input
        type="checkbox"
        checked={drafts.automaticBranchReview}
        disabled={!snapshot.writable || pending !== null}
        onChange={(event) => {
          const next = { ...drafts, automaticBranchReview: event.target.checked }
          setDrafts(next)
          setPending('branch')
          void scope.set('automaticBranchReview', event.target.checked)
            .finally(() => { setPending(null) })
        }}
      />
      <small>Off by default. When enabled, one invisible auxiliary model call reviews each completed Turn.</small>
    </label>
    {kinds.map((kind) => {
      const title = label(kind)
      const draft = drafts[kind]
      const enabled = overrideEnabled.has(kind)
      return <article className={css.card} key={kind}>
        <h3>{title}</h3>
        <label>Default prompt
          <textarea aria-label={`Default ${title} prompt`} value={CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind]} readOnly />
        </label>
        <label>Additional instructions
          <textarea
            aria-label={`Additional ${title} instructions`}
            value={draft.additional}
            maxLength={16_000}
            onChange={(event) => { update(kind, { additional: event.target.value }) }}
          />
        </label>
        <div className={css.actions}>
          <button
            type="button"
            disabled={!snapshot.writable || pending === kind}
            onClick={() => { void save(kind, draft) }}
          >Save {title} instructions</button>
          {!enabled && <button type="button" onClick={() => { setConfirming(kind) }}>Override default {title} prompt</button>}
        </div>
        {enabled && <div className={css.override}>
          <label>Custom base prompt
            <textarea
              aria-label={`Custom ${title} prompt`}
              value={draft.override || CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind]}
              maxLength={16_000}
              onChange={(event) => { update(kind, { override: event.target.value }) }}
            />
          </label>
          <div className={css.actions}>
            <button type="button" disabled={!snapshot.writable || pending === kind} onClick={() => { void save(kind, draft) }}>Save custom {title} prompt</button>
            <button type="button" disabled={!snapshot.writable || pending === kind} onClick={() => {
              update(kind, { override: '' })
              setOverrideEnabled(current => new Set([...current].filter(value => value !== kind)))
              void save(kind, { ...draft, override: '' })
            }}>Restore default {title} prompt</button>
          </div>
        </div>}
        <details>
          <summary>Effective prompt preview</summary>
          <pre>{effectiveClientPrompt(CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind], draft)}</pre>
        </details>
      </article>
    })}
    {confirming !== null && <div className={css.dialogBackdrop}>
      <div role="dialog" aria-label="Confirm prompt override" className={css.dialog}>
        <h3>Override package default?</h3>
        <p>This replaces the maintained base prompt for {label(confirming)} reviews. Additional instructions remain appended.</p>
        <div className={css.actions}>
          <button type="button" onClick={() => { setConfirming(null) }}>Cancel</button>
          <button type="button" onClick={() => {
            setOverrideEnabled(current => new Set([...current, confirming]))
            update(confirming, { override: CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[confirming] })
            setConfirming(null)
          }}>Enable override</button>
        </div>
      </div>
    </div>}
  </section>
}
