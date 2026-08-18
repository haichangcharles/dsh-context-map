/** Sidebar subview for restoring native Harness Sessions from the archive set. */
import { useEffect, useMemo, useState } from 'react'
import type { SessionId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import { deriveArchivedGroups } from './archived.ts'
import css from './ArchivedSessionsView.module.css'

interface ArchivedSessionsViewProps {
  useSessions: WorkspaceBrowserProps['useSessions']
  workspaces: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
  unarchiveSession: (sessionId: SessionId) => Promise<void>
  t: WorkspaceBrowserProps['t']
}

/** Archived rows have one action only: restore. They never open implicitly. */
export function ArchivedSessionsView({
  useSessions, workspaces, archivedSessionIds, unarchiveSession, t,
}: ArchivedSessionsViewProps) {
  const sessions = useSessions(state => state)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<ReadonlySet<SessionId>>(new Set())
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const archivedSet = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
  const groups = useMemo(
    () => deriveArchivedGroups(sessions, workspaces, archivedSessionIds, query),
    [sessions, workspaces, archivedSessionIds, query],
  )

  // Unary success keeps a row pending until the authoritative full-set
  // projection removes it. A remote restore clears the same transient state.
  useEffect(() => {
    setPending((current) => {
      if ([...current].every(id => archivedSet.has(id))) return current
      return new Set([...current].filter(id => archivedSet.has(id)))
    })
    setErrors((current) => {
      if (Object.keys(current).every(id => archivedSet.has(id as SessionId))) return current
      return Object.fromEntries(Object.entries(current).filter(([id]) => archivedSet.has(id as SessionId)))
    })
  }, [archivedSet])

  const restore = (sessionId: SessionId): void => {
    setPending(current => new Set(current).add(sessionId))
    setErrors(current => Object.fromEntries(
      Object.entries(current).filter(([id]) => id !== sessionId),
    ))
    unarchiveSession(sessionId).catch((reason: unknown) => {
      setPending((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      setErrors(current => ({
        ...current,
        [sessionId]: reason instanceof Error ? reason.message : String(reason),
      }))
    })
  }

  return (
    <div className={css.root}>
      <label className={css.search}>
        <span className={css.searchLabel}>{t('archive.search.aria')}</span>
        <input
          type="search"
          value={query}
          placeholder={t('archive.search.placeholder')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
      </label>
      <div className={css.list} role="list" aria-label={t('archive.list.aria')}>
        {groups.map(group => (
          <section key={group.key} className={css.group}>
            <h3 className={css.groupTitle}>{group.title ?? t('group.ungrouped')}</h3>
            {group.sessions.map(row => (
              <div key={row.id} className={css.row} role="listitem">
                <div className={css.rowCopy}>
                  <span className={css.title}>{row.title}</span>
                  {row.parentTitle !== undefined && (
                    <span className={css.parent}>{t('archive.branchOf', { name: row.parentTitle })}</span>
                  )}
                  {errors[row.id] !== undefined && (
                    <span className={css.error} role="alert">{errors[row.id]}</span>
                  )}
                </div>
                <button
                  type="button"
                  className={css.restore}
                  aria-label={t('archive.restore.aria', { name: row.title })}
                  disabled={pending.has(row.id)}
                  onClick={() => { restore(row.id) }}
                >
                  {pending.has(row.id) ? t('archive.restoring') : t('archive.restore')}
                </button>
              </div>
            ))}
          </section>
        ))}
        {groups.length === 0 && (
          <div className={css.empty}>{query.trim() === '' ? t('archive.empty') : t('archive.noMatches')}</div>
        )}
      </div>
    </div>
  )
}
