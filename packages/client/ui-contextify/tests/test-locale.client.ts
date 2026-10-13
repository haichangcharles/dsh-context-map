/** Real locale fixture, including the shared common-key fallback. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn, zh as commonZh } from '../../locale/src/locales/index.ts'
import { en, zh } from '../src/client/locales.ts'

/** Construct the common registry before a feature plugin owns its namespace. */
export function stewardTestBaseLocale(ctx = new Context(), language: 'en' | 'zh' = 'en') {
  const locale = new LocaleRuntime(ctx)
  locale.register('common', { en: commonEn, zh: commonZh })
  locale.setLocale(language)
  return locale
}

/** Bind the same typed translation contract used by the slot runtime. */
export function stewardTestLocale(language: 'en' | 'zh' = 'en') {
  const locale = stewardTestBaseLocale(new Context(), language)
  locale.register('contextifySteward', { en, zh })
  return locale
}

/** Resolve feature and common keys through the real locale registry. */
export function stewardTestTranslator(language: 'en' | 'zh' = 'en') {
  return stewardTestLocale(language).bind('contextifySteward')
}
