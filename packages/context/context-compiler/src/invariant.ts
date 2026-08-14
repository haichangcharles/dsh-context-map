/** Package-owned invariant companion for the context compiler registry. @module @deepseek-ai/dsh-context-compiler/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-compiler'

/** Cordis companion plugin name. */
export const name = 'context-compiler-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
/** Request reconstruction is checked by the Agent Loop companion. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
