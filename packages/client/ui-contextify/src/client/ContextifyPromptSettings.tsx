/** Profile prompt dashboard for Context, Archive, and Branch review agents. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import './locales.ts'
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

function label(kind: PromptKind, t: PropsLocale<'contextifySteward'>['t']): string {
  return t(`settings.kind.${kind}`)
}

export interface ContextifyPromptSettingsViewProps extends PropsLocale<'contextifySteward'> {
  readonly scope: SettingsScope<ContextifyPromptSettings>
  readonly snapshot: SettingsScopeSnapshot<ContextifyPromptSettings>
}

/** Slot-facing wrapper over the native settings scope. */
export function ContextifyPromptSettingsSection({ scope, t }: PropsLocale<'contextifySteward'> & {
  readonly scope?: SettingsScope<ContextifyPromptSettings>
}) {
  if (scope === undefined) return null
  return <ConnectedPromptSettings scope={scope} t={t} />
}

function ConnectedPromptSettings({ scope, t }: PropsLocale<'contextifySteward'> & { readonly scope: SettingsScope<ContextifyPromptSettings> }) {
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  return <ContextifyPromptSettingsView scope={scope} snapshot={snapshot} t={t} />
}

/** Render package defaults as immutable reference and Profile changes as explicit layers. */
export function ContextifyPromptSettingsView({ scope, snapshot, t }: ContextifyPromptSettingsViewProps) {
  const reviewerHints = {
    'parent-model': 'settings.parentReviewerHint',
    jev: 'settings.jevHint',
    'goal-model-jev': 'settings.goalJevHint',
    'goal-model-native': 'settings.goalNativeHint',
  } as const
  const settings = snapshot.value ?? CONTEXTIFY_CLIENT_DEFAULT_SETTINGS
  const [drafts, setDrafts] = useState<ContextifyPromptSettings>(settings)
  const [confirming, setConfirming] = useState<PromptKind | null>(null)
  const [overrideEnabled, setOverrideEnabled] = useState<ReadonlySet<PromptKind>>(
    () => new Set(kinds.filter(kind => settings[kind].override.trim().length > 0)),
  )
  const [deepLimitDraft, setDeepLimitDraft] = useState(String(settings.deepMaxRequests))
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [pending, setPending] = useState<PromptKind | null>(null)

  useEffect(() => { setDrafts(settings); setDeepLimitDraft(String(settings.deepMaxRequests)) }, [settings])
  const deepLimit = Number(deepLimitDraft)
  const validDeepLimit = deepLimitDraft.trim().length > 0
    && Number.isInteger(deepLimit) && deepLimit >= 1 && deepLimit <= 10

  const update = (kind: PromptKind, patch: Partial<ContextifyPromptSection>): void => {
    setDrafts(current => ({ ...current, [kind]: { ...current[kind], ...patch } }))
  }
  const save = async (kind: PromptKind, section: ContextifyPromptSection): Promise<void> => {
    setPending(kind)
    try { await scope.set(kind, section) } finally { setPending(null) }
  }
  const saveDecisionSetting = (field: 'fastDecisionProvider' | 'personalizationEnabled', value: ContextifyPromptSettings['fastDecisionProvider'] | boolean): void => {
    setPending('context')
    setSettingsError(null)
    void scope.set(field, value).catch((cause: unknown) => {
      setSettingsError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setPending(null) })
  }

  if (snapshot.status === 'loading') return <div className={css.state}>{t('copy.loadingContextMapPrompts')}</div>
  if (snapshot.status !== 'ready') {
    return <div className={css.state}>{t('copy.promptSettingsAreUnavailableInThisDeployment')}</div>
  }

  return <section className={css.root} aria-label={t('copy.contextMapPromptSettings')}>
    <header>
      <h2>{t('copy.contextMapPrompts')}</h2>
      <p>{t('copy.packageDefaultsStayVisibleAndReadOnlyAdd')}</p>
    </header>
    <label className={css.card}>
      <span>{t('settings.fastReviewer')}</span>
      <select aria-label={t('settings.fastReviewer')} value={settings.fastDecisionProvider}
        disabled={!snapshot.writable || pending !== null} onChange={(event) => {
          if (event.target.value === 'parent-model' || event.target.value === 'jev' || event.target.value === 'goal-model-jev' || event.target.value === 'goal-model-native') saveDecisionSetting('fastDecisionProvider', event.target.value)
        }}>
        <option value="parent-model">{t('settings.parentReviewer')}</option>
        <option value="jev">{t('settings.jevReviewer')}</option>
        <option value="goal-model-jev">{t('settings.goalJevReviewer')}</option>
        <option value="goal-model-native">{t('settings.goalNativeReviewer')}</option>
      </select>
      <small>{t(reviewerHints[settings.fastDecisionProvider])}</small>
    </label>
    <label className={css.card}>
      <span>{t('settings.personalization')}</span>
      <input type="checkbox" aria-label={t('settings.personalization')} checked={settings.personalizationEnabled}
        disabled={!snapshot.writable || pending !== null}
        onChange={(event) => { saveDecisionSetting('personalizationEnabled', event.target.checked) }} />
      <small>{t('settings.personalizationHint')}</small>
    </label>
    <label className={css.card}>
      <span>{t('copy.automaticBranchReview')}</span>
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
      <small>{t('copy.offByDefaultWhenEnabledOneInvisibleAuxiliary')}</small>
    </label>
    <label className={css.card}>
      <span>{t('settings.deepLimit')}</span>
      <input type="number" aria-label={t('settings.deepLimit')} min={1} max={10} step={1} value={deepLimitDraft}
        disabled={!snapshot.writable || pending !== null}
        onChange={(event) => { setDeepLimitDraft(event.target.value) }} />
      <small>{t('settings.deepLimitHint')}</small>
    </label>
    <div className={css.actions}>
      <button type="button" disabled={!snapshot.writable || pending !== null || !validDeepLimit}
        onClick={() => {
          setPending('context')
          setSettingsError(null)
          void scope.set('deepMaxRequests', deepLimit).catch((cause: unknown) => {
            setSettingsError(cause instanceof Error ? cause.message : String(cause))
            setDeepLimitDraft(String(settings.deepMaxRequests))
          }).finally(() => { setPending(null) })
        }}>{t('settings.saveDeepLimit')}</button>
    </div>
    {settingsError !== null && <p role="alert">{settingsError}</p>}
    {kinds.map((kind) => {
      const title = label(kind, t)
      const draft = drafts[kind]
      const enabled = overrideEnabled.has(kind)
      return <article className={css.card} key={kind}>
        <h3>{title}</h3>
        <label>{t('copy.defaultPrompt')}<textarea aria-label={t('copy.defaultPrompt2', { p0: title })} value={CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind]} readOnly />
        </label>
        <label>{t('copy.additionalInstructions')}<textarea
          aria-label={t('copy.additionalInstructions2', { p0: title })}
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
          >{t('settings.saveInstructions', { kind: title })}</button>
          {!enabled && <button type="button" onClick={() => { setConfirming(kind) }}>{t('settings.overrideDefault', { kind: title })}</button>}
        </div>
        {enabled && <div className={css.override}>
          <label>{t('copy.customBasePrompt')}<textarea
            aria-label={t('copy.customPrompt', { p0: title })}
            value={draft.override || CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind]}
            maxLength={16_000}
            onChange={(event) => { update(kind, { override: event.target.value }) }}
          />
          </label>
          <div className={css.actions}>
            <button type="button" disabled={!snapshot.writable || pending === kind} onClick={() => { void save(kind, draft) }}>{t('settings.saveCustom', { kind: title })}</button>
            <button type="button" disabled={!snapshot.writable || pending === kind} onClick={() => {
              update(kind, { override: '' })
              setOverrideEnabled(current => new Set([...current].filter(value => value !== kind)))
              void save(kind, { ...draft, override: '' })
            }}>{t('settings.restoreDefault', { kind: title })}</button>
          </div>
        </div>}
        <details>
          <summary>{t('copy.effectivePromptPreview')}</summary>
          <pre>{effectiveClientPrompt(CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[kind], draft)}</pre>
        </details>
      </article>
    })}
    {confirming !== null && <div className={css.dialogBackdrop}>
      <div role="dialog" aria-label={t('copy.confirmPromptOverride')} className={css.dialog}>
        <h3>{t('copy.overridePackageDefault')}</h3>
        <p>{t('settings.overrideExplanation', { kind: label(confirming, t) })}</p>
        <div className={css.actions}>
          <button type="button" onClick={() => { setConfirming(null) }}>{t('copy.cancel')}</button>
          <button type="button" onClick={() => {
            setOverrideEnabled(current => new Set([...current, confirming]))
            update(confirming, { override: CONTEXTIFY_CLIENT_DEFAULT_PROMPTS[confirming] })
            setConfirming(null)
          }}>{t('copy.enableOverride')}</button>
        </div>
      </div>
    </div>}
  </section>
}
