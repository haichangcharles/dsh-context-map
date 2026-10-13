import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import './locales.ts'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

type OfficialBrandMarkProps = SidebarBrandMarkOwnerProps & PropsLocale<'contextMapBrand'>

/**
 * Render the DSH Context Map mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the product's conversation-graph mark.
 */
export function OfficialBrandMark({ size, t }: OfficialBrandMarkProps) {
  return (
    <svg
      role="img"
      aria-label={t('name')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <path d="M12 5v5m0 0-5 4m5-4 5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="4" r="2.5" fill="currentColor" />
      <circle cx="7" cy="16" r="2.5" fill="currentColor" />
      <circle cx="17" cy="16" r="2.5" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the DSH Context Map name without its independently slotted mark.
 * @returns the product name.
 */
export function OfficialBrandName({ t }: PropsLocale<'contextMapBrand'>) {
  return <span className={css.name}>{t('name')}</span>
}
