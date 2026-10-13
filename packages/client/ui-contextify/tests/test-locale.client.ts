/** Real locale fixture, including the shared common-key fallback. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn, zh as commonZh } from '../../locale/src/locales/index.ts'
import { en, zh } from '../src/client/locales.ts'

/** Bind the same typed translation contract used by the slot runtime. */
export function stewardTestTranslator() {
  const locale = new LocaleRuntime(new Context())
  locale.register('common', { en: commonEn, zh: commonZh })
  locale.register('contextifySteward', { en, zh })
  locale.setLocale('en')
  return locale.bind('contextifySteward')
}
