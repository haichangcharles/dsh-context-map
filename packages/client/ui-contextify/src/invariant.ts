import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-contextify'
export const name = 'client-ui-contextify-invariant'
export const inject = ['invariants']
// No runtime invariant: the slot registration is fiber-owned and the panel
// stores only replaceable Remote snapshots scoped to its React lifetime.
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
