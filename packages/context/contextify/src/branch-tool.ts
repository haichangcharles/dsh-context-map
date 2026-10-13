/** Preset-scoped model consumer for user-confirmed Contextify branches. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ContextifyError } from './index.ts'

/** Loader identity for the optional Contextify branch tool consumer. */
export const name = 'contextify-branch-tool'
/** The Host may omit Contextify, but every preset consumer needs its tool registry. */
export const inject = ['tools']

/** Model-facing branch tool availability for this preset. */
export interface Config {
  readonly enabled: boolean
}

/** Explicit capability gate, also usable by historical composition replay. */
export const Config: z<Config> = z.object({ enabled: z.boolean().default(true) })

/** Register the branch request only where the preset explicitly composes it.
 * @param ctx - Preset or explicitly configured embedding scope.
 * @param config - Whether this preset exposes the model-facing branch tool.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  ctx.inject(['contextify', 'tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(defineTool({
      name: 'request_context_branch',
      description: 'Request a user-confirmed native conversation branch for the current Q&A. '
        + 'Use this when the direct human explicitly asks to open, create, or move the current exchange '
        + 'to a new branch. This schedules a confirmation card after the final answer; it does not create '
        + 'the branch by itself, so do not claim that the branch already exists.',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: 'Short user-facing explanation of why this Q&A should become a separate branch.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true, enum: ['pending_user_confirmation'] },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => {
        if (exec.agent === undefined) {
          throw new ContextifyError('Branch requests require an active Agent', 'CONTEXTIFY_INVALID_TRANSITION')
        }
        toolCtx.contextify.requestExplicitBranch(exec.agent, args.reason)
        return Promise.resolve({ status: 'pending_user_confirmation' as const })
      },
    })))
  })
}
