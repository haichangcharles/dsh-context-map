/** Package-owned invariant companion for Contextify. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-contextify'

export const name = 'contextify-invariant'
export const inject = ['invariants']
// No runtime invariant: the compiler re-folds and validates every durable
// plan, route, and selected message before each model request.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
