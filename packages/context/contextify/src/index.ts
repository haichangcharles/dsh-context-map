/** Durable context selection across one native Session fork family. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, HarnessError, type Message } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-context-compiler'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { projectSessionFamily } from './family.ts'
import {
  parseRecommendationDecisionText,
  validateRecommendation,
} from './recommendation.ts'
import { buildFastRecommendationInput } from './fast-recommendation.ts'
import {
  buildDeepRecommendationSnapshot,
  cleanupStaleDeepSnapshots,
  runDeepRecommendation,
} from './deep-recommendation.ts'
import {
  BRANCH_REVIEW_MAX_TOKENS,
  branchRelocationKey,
  branchSuggestionThreshold,
  buildBranchReviewInput,
  completedTurnCandidate,
  parseBranchDecisionText,
  type ContextBranchDecision,
} from './branch-review.ts'
import {
  CONTEXTIFY_SETTINGS_NAMESPACE,
  ContextifyPromptSettingsSchema,
} from './settings.ts'
import {
  compileContextify,
  createInitialContextPlan,
  currentContextPlan,
  normalizeContextPlanSnapshot,
  nextPlan,
  redoPlan,
  resetPlan,
  undoPlan,
} from './plan.ts'
import type {
  ContextFamilyGraph,
  ContextFamilyGraphNode,
  ContextFamilyGraphPage,
  ContextFamilyInspection,
  ContextBranchRelocationResult,
  ContextBranchRelocationPreparation,
  ContextBranchSuggestion,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
  ContextPlanSnapshot,
  ContextReplacementNode,
  ContextRecommendationBase,
  ContextRecommendationMode,
  ContextRecommendationProposal,
  ContextifyPromptSettings,
  ContextifyView,
} from './types.ts'
import {
  CONTEXTIFY_DEFAULT_PROMPTS,
  CONTEXTIFY_DEFAULT_SETTINGS,
  CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT,
  effectivePrompt,
} from './types.ts'

export * from './types.ts'
export * from './settings.ts'
export {
  compileContextify,
  createInitialContextPlan,
  currentContextPlan,
  normalizeContextPlanSnapshot,
  nextPlan,
  projectSessionFamily,
  redoPlan,
  resetPlan,
  undoPlan,
}

export const name = 'contextify'

/** Domain error preserved by Harness remote adapters. */
export class ContextifyError extends HarnessError {}

declare module '@deepseek-ai/cordis' {
  interface Context { contextify: ContextifyService }
}

interface LoadedFamily {
  readonly graph: ContextFamilyGraph
  readonly revision: string
  readonly inspections: ReadonlyMap<SessionId, ContextFamilyInspection>
  readonly knownSessionIds: ReadonlySet<SessionId>
}

interface RecommendationOperation {
  readonly mode: ContextRecommendationMode
  readonly controller: AbortController
}

interface BranchReviewResult {
  readonly decision: ContextBranchDecision
  readonly threshold: number
}

interface BranchReviewOperation {
  readonly turn: number
  readonly inputSeq: number
  readonly planRevision: number
  readonly controller: AbortController
  result?: Promise<BranchReviewResult | null>
  explicitReason?: string
}

function exactMessage(inspection: ContextFamilyInspection, seq: number): Message | null {
  const event = inspection.events[seq]
  if (event?.type === 'user/message' && event.surfaceOp === 'append') return event.data
  if (event?.type === 'assistant/message' && event.surfaceOp === 'append') return event.data.message
  return null
}

function importedMessage(message: Message): Message {
  if (message.content.some(block => block.type === 'tool-call' || block.type === 'tool-result')) {
    throw new ContextifyError(
      'tool exchanges cannot be imported without their native protocol context',
      'CONTEXTIFY_UNSUPPORTED_MESSAGE',
    )
  }
  const content = message.content.filter(block => block.type !== 'reasoning')
  if (content.length === 0) {
    throw new ContextifyError(
      'a reasoning-only message has no Context Map content to import',
      'CONTEXTIFY_UNSUPPORTED_MESSAGE',
    )
  }
  return structuredClone({ ...message, content })
}

function contentHash(message: Message): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

function familyRevision(inspections: ReadonlyMap<SessionId, ContextFamilyInspection>): string {
  const records = [...inspections.values()]
    .sort((left, right) => left.meta.id.localeCompare(right.meta.id))
    .map(({ meta, events }) => ({
      id: meta.id,
      parentSession: meta.parentSession ?? null,
      seedLength: meta.seedLength ?? 0,
      // Branch review metadata does not alter visible topology and therefore
      // must not invalidate a concurrently opened Context recommendation.
      eventCount: events.filter(event => event.type !== 'contextify/branch-review').length,
      lastSeq: events.findLast(event => event.type !== 'contextify/branch-review')?.seq ?? -1,
    }))
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

const CONTEXT_RECOMMENDATION_MAX_OBJECTIVE_CHARS = 4_000

function boundedObjective(value: string): string {
  return Array.from(value.trim()).slice(0, CONTEXT_RECOMMENDATION_MAX_OBJECTIVE_CHARS).join('')
}

function resolveNode(graph: ContextFamilyGraph, ref: ContextMessageRef): ContextFamilyGraphNode | undefined {
  return graph.nodes.find(node => node.owner.seq === ref.seq && node.sessionIds.includes(ref.sessionId))
}

function recommendationText(message: Message): string {
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'image') return ['[Image]']
    return []
  }).join('\n')
}

/** Durable Context Plan mutations and native Session-family graph reads. */
export class ContextifyService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'contextCompiler', 'llm']

  private readonly recommendations = new Map<SessionId, RecommendationOperation>()
  private readonly recommendationRoots = new Map<SessionId, SessionId>()
  private readonly branchReviews = new Map<SessionId, BranchReviewOperation>()
  private readonly relocatingBranches = new Set<SessionId>()
  private promptSettings: () => ContextifyPromptSettings = () => CONTEXTIFY_DEFAULT_SETTINGS
  private deepRecommendation = runDeepRecommendation

  constructor(ctx: Context) {
    super(ctx, 'contextify')
    void cleanupStaleDeepSnapshots().catch((cause: unknown) => {
      ctx.logger.warn(`Contextify Deep snapshot cleanup failed: ${String(cause)}`)
    })
    installSettingsSection(
      ctx,
      CONTEXTIFY_SETTINGS_NAMESPACE,
      ContextifyPromptSettingsSchema,
      CONTEXTIFY_DEFAULT_SETTINGS,
      {
        setSource: (source) => { this.promptSettings = source },
        onChange: () => {},
      },
    )
    ctx.effect(() => ctx.contextCompiler.register({
      id: name,
      version: 3,
      select: request => ({ eventSeqs: compileContextify(request).eventSeqs }),
    }))
    ctx.inject(['tools'], (toolCtx) => {
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
          this.requestExplicitBranch(exec.agent, args.reason)
          return Promise.resolve({ status: 'pending_user_confirmation' as const })
        },
      })))
    })
    ctx.on('agent/session-start', ({ agent }) => {
      const latest = agent.session.events.findLast(event => event.type === 'contextify/plan')
      const current = latest?.data as unknown
      const inherited = agent.session.header.parentSession !== undefined
        && latest !== undefined
        && latest.seq < (agent.session.header.seedLength ?? 0)
      if (latest === undefined || inherited || normalizeContextPlanSnapshot(current) === null) {
        const priorRevision = isRecordWithRevision(current) ? current.revision : 0
        agent.session.append('contextify/plan', createInitialContextPlan(
          priorRevision + 1,
        ))
      }
      ctx.contextCompiler.select(agent.session, name)
    })
    ctx.on('session/event', (session, event) => {
      if (session.header.origin === 'subagent') return
      if (this.relocatingBranches.has(session.id)) return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      if (event.type === 'user/message' && event.surfaceOp === 'append'
        && event.data.source.kind === 'user') {
        this.startBranchReview(agent, event.seq)
        return
      }
      if (event.type === 'request/header') {
        const operation = this.branchReviews.get(session.id)
        if (operation !== undefined) this.launchBranchReview(agent, operation)
        return
      }
      if (event.type !== 'turn/end') return
      const operation = this.branchReviews.get(session.id)
      if (operation === undefined || operation.turn !== event.data.turn) return
      if (event.data.reason.kind !== 'completed'
        || (!this.promptSettings().automaticBranchReview && operation.explicitReason === undefined)) {
        operation.controller.abort('Branch candidate Turn did not complete')
        this.branchReviews.delete(session.id)
        return
      }
      this.launchBranchReview(agent, operation)
      queueMicrotask(() => { void this.finalizeBranchReview(agent, event.seq, operation) })
    })
    ctx.on('session/disposed', (session) => {
      this.branchReviews.get(session.id)?.controller.abort('Session disposed')
      this.branchReviews.delete(session.id)
    })
  }

  /**
   * Read the active Session's current Context Plan.
   * @param agent - Live Agent whose Session owns the plan.
   * @returns A detached plan and compilation summary.
   */
  @Remote('get')
  get(agent: Agent): ContextifyView {
    this.assertLive(agent)
    return this.view(agent.session)
  }

  /**
   * Read one bounded page of the active Session's native fork family.
   * @param agent - Live Agent selecting the family root and active path.
   * @param after - Zero-based node offset; omitted starts at the first node.
   * @param limit - Maximum records from 1 through 500.
   * @returns Family metadata, all edges, and the requested canonical node page.
   */
  @Remote('familyPage')
  async familyPage(agent: Agent, after?: number, limit?: number): Promise<ContextFamilyGraphPage> {
    this.assertLive(agent)
    const offset = after ?? 0
    const pageLimit = limit ?? 250
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('family page offset must be non-negative')
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) {
      throw new RangeError('family page limit must be 1-500')
    }
    const family = await this.loadFamily(agent.session)
    const { graph } = family
    const decoratedNodes = this.decorateNodes(agent.session, graph.nodes, family.inspections)
    const records = decoratedNodes.slice(offset, offset + pageLimit)
    const next = offset + records.length
    return {
      asOfSeq: agent.session.seq - 1,
      revision: family.revision,
      rootSessionId: graph.rootSessionId,
      activeSessionId: graph.activeSessionId,
      sessions: graph.sessions,
      edges: graph.edges,
      records,
      totalNodeCount: decoratedNodes.length,
      ...(next < decoratedNodes.length ? { nextAfter: next } : {}),
    }
  }

  /**
   * Analyze one exact graph snapshot in manually selected Fast or Deep mode.
   * @param agent - Live idle Agent whose route and native Session family are reviewed.
   * @param base - Expected plan revision, graph watermark, and active Session identity.
   * @param objective - Optional review objective; the latest user input is the fallback.
   * @param mode - Fast bounded classifier (default) or isolated full-tree Harness child.
   * @returns An ephemeral, validated proposal that has not mutated the Context Plan.
   */
  @Remote('recommend')
  async recommend(
    agent: Agent,
    base: ContextRecommendationBase,
    objective?: string,
    mode?: ContextRecommendationMode,
  ): Promise<ContextRecommendationProposal> {
    this.assertLive(agent)
    this.assertRecommendationIdle(agent)
    const recommendationMode = mode ?? 'fast'
    const plan = currentContextPlan(agent.session)
    if (plan.revision !== base.planRevision) {
      throw new ContextifyError('the Context Plan changed before recommendation started', 'CONTEXTIFY_STALE_REVISION')
    }
    if (base.activeSessionId !== agent.id) {
      throw new ContextifyError('the Context Map changed before recommendation started', 'CONTEXTIFY_STALE_GRAPH')
    }
    const family = await this.loadFamily(agent.session)
    if (family.revision !== base.graphRevision) {
      throw new ContextifyError('the Context Map changed while it was being read', 'CONTEXTIFY_STALE_GRAPH')
    }
    const rootSessionId = family.graph.rootSessionId
    if (this.recommendations.has(rootSessionId)) {
      throw new ContextifyError('a Context Map recommendation is already running for this Session family', 'CONTEXTIFY_RECOMMENDATION_BUSY')
    }
    const operation: RecommendationOperation = { mode: recommendationMode, controller: new AbortController() }
    this.recommendations.set(rootSessionId, operation)
    for (const session of family.graph.sessions) this.recommendationRoots.set(session.id, rootSessionId)
    try {
      const replacementByNode = new Map(plan.replacements.map(item => [item.nodeId, item]))
      const contents = Object.fromEntries(family.graph.nodes.map((node) => {
        const replacement = replacementByNode.get(node.id)
        if (replacement !== undefined) {
          const event = agent.session.events[replacement.snapshotSeq]
          if (event?.type === 'context/compiler-snapshot') {
            return [node.id, recommendationText(event.data.message)]
          }
        }
        const inspection = family.inspections.get(node.owner.sessionId)
        const message = inspection === undefined ? null : exactMessage(inspection, node.owner.seq)
        return [node.id, message === null ? node.preview : recommendationText(message)]
      }))
      const effective = new Set(family.graph.nodes
        .filter(node => node.sessionIds.includes(agent.id))
        .map(node => node.id))
      for (const excluded of plan.excluded) effective.delete(excluded.nodeId)
      for (const included of plan.included) effective.add(included.nodeId)
      const fallbackObjective = [...agent.session.events].reverse().find(event =>
        event.type === 'user/message' && event.data.source.kind === 'user')
      const goal = boundedObjective(objective?.trim() || (fallbackObjective?.type === 'user/message'
        ? recommendationText(fallbackObjective.data)
        : 'Improve the next response context.'))

      let decision
      if (recommendationMode === 'deep') {
        decision = await this.deepRecommendation({
          parent: agent,
          snapshot: buildDeepRecommendationSnapshot({
            graph: family.graph,
            graphRevision: family.revision,
            plan,
            objective: goal,
            contents,
            effectiveIncludedNodeIds: [...effective],
          }),
          signal: operation.controller.signal,
        })
      } else {
        let input
        try {
          input = buildFastRecommendationInput({
            graph: family.graph,
            contents,
            objective: goal,
            effectiveIncludedNodeIds: [...effective],
            explicitIncludedNodeIds: plan.included.map(item => item.nodeId),
            explicitExcludedNodeIds: plan.excluded.map(item => item.nodeId),
          })
        } catch (cause) {
          throw new ContextifyError(
            cause instanceof Error ? cause.message : String(cause),
            'CONTEXTIFY_RECOMMENDATION_TOO_LARGE',
          )
        }
        const promptSettings = this.promptSettings()
        const contextPrompt = effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.context, promptSettings.context)
        const archivePrompt = effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.archive, promptSettings.archive)
        const system = [
          contextPrompt,
          archivePrompt,
          'Return JSON immediately without analysis or Markdown.',
          'Use exactly this shape: {"exclude":[{"nodeId":"...","reason":"..."}],"include":[{"nodeId":"...","reason":"..."}],"archive":[{"nodeId":"...","reason":"..."}]}.',
          'Use empty arrays when no action is needed. Never invent node IDs.',
        ].join('\n\n')
        const latestOutput = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
        if (latestOutput?.type !== 'assistant/message') {
          throw new ContextifyError('a model route is unavailable for Context recommendation', 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE')
        }
        const requestConfig = agent.session.requestHeader()?.config
        const provider = requestConfig?.provider ?? agent.options.provider ?? latestOutput.data.message.source.provider
        const model = requestConfig?.model ?? agent.options.model ?? latestOutput.data.message.source.model
        const modelInfo = await this.ctx.llm.resolveModelInfo(provider, model)
        const reasoningEffort = modelInfo.reasoning?.efforts.find(effort => String(effort.id) === 'off')?.id
          ?? requestConfig?.reasoningEffort
        const assembler = new BlockAssembler()
        for await (const chunk of this.ctx.llm.stream({
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          messages: [createUserMessage({
            content: [{
              type: 'text',
              text: `Objective:\n${goal}\n\nConversation graph JSON:\n${JSON.stringify(input)}`,
            }],
            source: { kind: 'plugin', plugin: name },
          })],
          system,
          temperature: 0,
          maxTokens: 640,
          signal: operation.controller.signal,
        })) assembler.push(chunk)
        const blocks = assembler.blocks()
        if (blocks.some(block => block.type === 'tool-call')) {
          throw new ContextifyError('the recommendation model attempted a tool call', 'CONTEXTIFY_INVALID_RECOMMENDATION')
        }
        try {
          decision = parseRecommendationDecisionText(blocks
            .flatMap(block => block.type === 'text' || block.type === 'reasoning' ? [block.text] : [])
            .join('\n'))
        } catch (cause) {
          throw new ContextifyError(
            cause instanceof Error ? cause.message : String(cause),
            'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE',
          )
        }
      }
      if (operation.controller.signal.aborted) {
        throw new ContextifyError('the Context recommendation was cancelled', 'CONTEXTIFY_RECOMMENDATION_CANCELLED')
      }
      this.assertLive(agent)
      this.assertRecommendationIdle(agent)
      if (currentContextPlan(agent.session).revision !== base.planRevision) {
        throw new ContextifyError('the Context Plan changed while recommendation was running', 'CONTEXTIFY_STALE_REVISION')
      }
      const currentFamily = await this.loadFamily(agent.session)
      if (currentFamily.revision !== base.graphRevision) {
        throw new ContextifyError('the Context Map changed while recommendation was running', 'CONTEXTIFY_STALE_GRAPH')
      }
      try {
        return validateRecommendation(decision, {
          mode: recommendationMode,
          base,
          graph: family.graph,
          effectiveIncludedNodeIds: [...effective],
          explicitIncludedNodeIds: plan.included.map(item => item.nodeId),
          explicitExcludedNodeIds: plan.excluded.map(item => item.nodeId),
        })
      } catch (cause) {
        throw new ContextifyError(
          cause instanceof Error ? cause.message : String(cause),
          'CONTEXTIFY_INVALID_RECOMMENDATION',
        )
      }
    } catch (cause) {
      if (operation.controller.signal.aborted) {
        throw new ContextifyError('the Context recommendation was cancelled', 'CONTEXTIFY_RECOMMENDATION_CANCELLED')
      }
      if (cause instanceof ContextifyError) throw cause
      throw new ContextifyError(
        cause instanceof Error ? cause.message : String(cause),
        'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE',
      )
    } finally {
      if (this.recommendations.get(rootSessionId) === operation) this.recommendations.delete(rootSessionId)
      for (const session of family.graph.sessions) {
        if (this.recommendationRoots.get(session.id) === rootSessionId) this.recommendationRoots.delete(session.id)
      }
    }
  }

  /**
   * Cancel only the recommendation owned by this native Session family.
   * @param agent - Live Agent identifying the family whose review is cancelled.
   */
  @Remote('cancelRecommendation')
  cancelRecommendation(agent: Agent): void {
    this.assertLive(agent)
    const rootSessionId = this.recommendationRoots.get(agent.id) ?? agent.id
    this.recommendations.get(rootSessionId)?.controller.abort('cancelled by user')
  }

  /** Start one direct classifier from the first human input without waiting for the main answer. */
  private startBranchReview(agent: Agent, inputSeq: number): void {
    const start = agent.session.events.slice(0, inputSeq).findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start') return
    const priorHuman = agent.session.events.slice(start.seq + 1, inputSeq).some(event =>
      event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user')
    if (priorHuman) return
    this.branchReviews.get(agent.id)?.controller.abort('A newer Branch candidate replaced this review')
    const controller = new AbortController()
    const operation: BranchReviewOperation = {
      turn: start.data.turn,
      inputSeq,
      planRevision: currentContextPlan(agent.session).revision,
      controller,
    }
    this.branchReviews.set(agent.id, operation)
    if (this.promptSettings().automaticBranchReview) this.launchBranchReview(agent, operation)
  }

  /** Convert one explicit model tool call into a post-Turn user confirmation. */
  private requestExplicitBranch(agent: Agent, reason: string): void {
    this.assertLive(agent)
    const explanation = Array.from(reason.trim()).slice(0, 400).join('')
    if (explanation.length === 0) {
      throw new ContextifyError('Branch request reason must be non-empty', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const operation = this.branchReviews.get(agent.id)
    if (operation === undefined) {
      throw new ContextifyError(
        'Branch requests are available only during the current direct human Turn',
        'CONTEXTIFY_INVALID_TRANSITION',
      )
    }
    operation.explicitReason = explanation
    operation.controller.abort('Explicit Branch request superseded automatic review')
  }

  /** Launch once a concrete Session request route is available. */
  private launchBranchReview(agent: Agent, operation: BranchReviewOperation): void {
    if (!this.promptSettings().automaticBranchReview || operation.explicitReason !== undefined
      || operation.result !== undefined || operation.controller.signal.aborted) return
    const config = agent.session.requestHeader()?.config
    const latestOutput = agent.session.events.findLast(event => event.type === 'assistant/message')
    const route = latestOutput?.type === 'assistant/message' ? latestOutput.data.message.source : undefined
    if (!(config?.provider ?? agent.options.provider ?? route?.provider)
      || !(config?.model ?? agent.options.model ?? route?.model)) return
    operation.result = this.classifyBranchInput(
      agent, operation.inputSeq, operation.controller.signal,
    ).catch((cause: unknown) => {
      if (!operation.controller.signal.aborted) {
        this.ctx.logger.warn(`Contextify Branch classifier failed: ${String(cause)}`)
      }
      return null
    })
  }

  /** Run one bounded, tool-free Branch decision over topology and the new input only. */
  private async classifyBranchInput(
    agent: Agent,
    inputSeq: number,
    signal: AbortSignal,
  ): Promise<BranchReviewResult | null> {
    const family = await this.loadFamily(agent.session)
    signal.throwIfAborted()
    const candidateNode = family.graph.nodes.find(node => node.owner.sessionId === agent.id
      && node.owner.seq === inputSeq)
    if (candidateNode === undefined) return null
    const contents = Object.fromEntries(family.graph.nodes.map((node) => {
      const inspection = family.inspections.get(node.owner.sessionId)
      const message = inspection === undefined ? null : exactMessage(inspection, node.owner.seq)
      return [node.id, message === null ? node.preview : recommendationText(message)]
    }))
    const packet = buildBranchReviewInput({ graph: family.graph, candidateNodeId: candidateNode.id, contents })
    const branchPrompt = effectivePrompt(CONTEXTIFY_DEFAULT_PROMPTS.branch, this.promptSettings().branch)
    const userText = [
      `Branch review packet JSON:\n${JSON.stringify(packet)}`,
      'Return only JSON: {"action":"keep|suggest_branch","confidence":0..1,"reason":"..."}.',
    ].join('\n\n')
    const assembler = new BlockAssembler()
    const requestConfig = agent.session.requestHeader()?.config
    const latestOutput = agent.session.events.findLast(event => event.type === 'assistant/message')
    const outputRoute = latestOutput?.type === 'assistant/message' ? latestOutput.data.message.source : undefined
    const provider = requestConfig?.provider ?? agent.options.provider ?? outputRoute?.provider
    const model = requestConfig?.model ?? agent.options.model ?? outputRoute?.model
    if (!provider || !model) return null
    const modelInfo = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    const reasoningEffort = modelInfo.reasoning?.efforts.find(effort => String(effort.id) === 'off')?.id
      ?? requestConfig?.reasoningEffort
    for await (const chunk of this.ctx.llm.stream({
      provider,
      model,
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort }),
      messages: [createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin', plugin: name },
      })],
      system: branchPrompt,
      maxTokens: BRANCH_REVIEW_MAX_TOKENS,
      signal,
    })) assembler.push(chunk)
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) return null
    const decision = parseBranchDecisionText(blocks
      .flatMap(block => block.type === 'text' || block.type === 'reasoning' ? [block.text] : [])
      .join('\n'))
    return Object.freeze({
      decision,
      threshold: branchSuggestionThreshold(packet.branchDepth, packet.activeBranchCount),
    })
  }

  /** Bind a pre-started classifier result to the exact completed Q&A, without blocking Chat. */
  private async finalizeBranchReview(
    agent: Agent,
    turnEndSeq: number,
    operation: BranchReviewOperation,
  ): Promise<void> {
    const explicitReason = operation.explicitReason
    const result = explicitReason === undefined && operation.result !== undefined
      ? await operation.result
      : null
    if (this.branchReviews.get(agent.id) !== operation) return
    this.branchReviews.delete(agent.id)
    if (this.ctx.agents.get(agent.id) !== agent
      || (explicitReason === undefined && !this.promptSettings().automaticBranchReview)
      || (explicitReason === undefined && operation.controller.signal.aborted)
      || currentContextPlan(agent.session).revision !== operation.planRevision
      || agent.session.events.some(event => event.type === 'contextify/branch-review'
        && event.data.turnEndSeq === turnEndSeq)) return
    const candidate = completedTurnCandidate(agent.session.events, turnEndSeq, agent.session.id)
    if (candidate === null || candidate.input.seq !== operation.inputSeq) return
    const family = await this.loadFamily(agent.session)
    if (this.branchReviews.has(agent.id)
      || agent.session.events.slice(turnEndSeq + 1).some(event =>
        event.type === 'turn/start' || event.type === 'turn/end'
        || event.type === 'user/message' || event.type === 'assistant/message'
        || event.type === 'tool/result')) return
    const decision = result?.decision
    const acceptedDecision = explicitReason !== undefined
      ? { confidence: 1, reason: explicitReason }
      : result !== null && decision !== undefined && decision.action === 'suggest_branch'
        && decision.confidence >= result.threshold
        ? decision
        : undefined
    const suggestion: ContextBranchSuggestion | null = candidate.boundaryBefore >= 0
      && acceptedDecision !== undefined
      ? Object.freeze({
        ...candidate,
        id: branchRelocationKey(agent.id, turnEndSeq),
        confidence: acceptedDecision.confidence,
        reason: acceptedDecision.reason,
        planRevision: operation.planRevision,
        graphRevision: family.revision,
      })
      : null
    agent.session.append('contextify/branch-review', { suggestion, turnEndSeq })
  }

  /**
   * Validate a suggestion and return the exact native Host fork boundary.
   * @param agent - Live idle Agent whose source Session owns the reviewed Turn.
   * @param suggestionId - Durable suggestion identity returned by `get`.
   * @returns The source Session and stable Turn start for native Host before-Turn fork.
   */
  @Remote('prepareBranchSuggestion')
  prepareBranchSuggestion(agent: Agent, suggestionId: string): ContextBranchRelocationPreparation {
    this.assertLive(agent)
    if (agent.status !== 'idle') {
      throw new ContextifyError('Branch relocation requires an idle Agent', 'CONTEXTIFY_AGENT_BUSY')
    }
    const review = agent.session.events.findLast(event => event.type === 'contextify/branch-review'
      && event.data.suggestion?.id === suggestionId)
    if (review?.type !== 'contextify/branch-review' || review.data.suggestion === null) {
      throw new ContextifyError('Branch suggestion is unavailable', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const suggestion = review.data.suggestion
    if (suggestion.boundaryBefore < 0) {
      throw new ContextifyError('the first conversation Turn has no preceding Branch boundary', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const laterConversation = agent.session.events.slice(suggestion.boundaryAfter + 1).some(event =>
      event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
    if (laterConversation) {
      throw new ContextifyError('the source conversation advanced after the Branch suggestion', 'CONTEXTIFY_STALE_GRAPH')
    }
    return { sourceSessionId: agent.id, beforeSeq: suggestion.boundaryBefore + 1 }
  }

  /**
   * Set or clear one message's explicit context mode.
   * @param agent - Live Agent whose Session receives durable events.
   * @param ref - Expected current plan revision.
   * @param node - Message location in one Session in the active family.
   * @param mode - Natural behavior or the meaningful on-path/off-path override.
   * @returns The view after the mutation commits.
   */
  @Remote('setNodeMode')
  async setNodeMode(
    agent: Agent,
    ref: ContextPlanRef,
    node: ContextMessageRef,
    mode: 'natural' | 'include' | 'exclude',
  ): Promise<ContextifyView> {
    return this.setNodeModes(agent, ref, [{ node, mode }])
  }

  /**
   * Apply several node-mode changes as one Context Plan revision.
   * @param agent - Live Agent whose Session receives durable events.
   * @param ref - Expected current plan revision.
   * @param mutations - Ordered message-mode replacements.
   * @param expectedGraphRevision - Optional family revision required by recommendation acceptance.
   * @returns The view after one complete plan commits.
   */
  @Remote('setNodeModes')
  async setNodeModes(
    agent: Agent,
    ref: ContextPlanRef,
    mutations: readonly ContextNodeMutation[],
    expectedGraphRevision?: string,
  ): Promise<ContextifyView> {
    const current = this.prepare(agent, ref)
    const family = await this.loadFamily(agent.session)
    if (expectedGraphRevision !== undefined && family.revision !== expectedGraphRevision) {
      throw new ContextifyError('the Context Map changed before recommendations were applied', 'CONTEXTIFY_STALE_GRAPH')
    }
    let excluded = [...current.excluded]
    let included = [...current.included]
    const pendingSnapshots: Array<{ nodeId: string; ref: ContextMessageRef; message: Message; position: number }> = []

    for (const mutation of mutations) {
      const node = resolveNode(family.graph, mutation.node)
      if (node === undefined) {
        const code = family.knownSessionIds.has(mutation.node.sessionId)
          ? 'CONTEXTIFY_CROSS_FAMILY'
          : 'CONTEXTIFY_INVALID_NODE'
        throw new ContextifyError('message is not part of the active Context Map', code)
      }
      excluded = excluded.filter(item => item.nodeId !== node.id)
      included = included.filter(item => item.nodeId !== node.id)
      const natural = node.sessionIds.includes(agent.session.id)
      if (mutation.mode === 'natural' || (natural && mutation.mode === 'include')
        || (!natural && mutation.mode === 'exclude')) continue
      if (natural) {
        if (node.activeEventSeq === null) throw new Error('active Context Map node is missing its local event')
        excluded.push({ nodeId: node.id, eventSeq: node.activeEventSeq })
        continue
      }
      const source = family.inspections.get(mutation.node.sessionId)
      const exact = source === undefined ? null : exactMessage(source, mutation.node.seq)
      if (exact === null) {
        throw new ContextifyError('message source is unavailable', 'CONTEXTIFY_INVALID_NODE')
      }
      const message = importedMessage(exact)
      const position = family.graph.nodes.filter(candidate =>
        candidate.sessionIds.includes(agent.session.id) && candidate.time <= node.time).length
      const replacement = current.replacements.find(item => item.nodeId === node.id)
      if (replacement !== undefined) {
        included.push({ nodeId: node.id, snapshotSeq: replacement.snapshotSeq, position })
        continue
      }
      pendingSnapshots.push({ nodeId: node.id, ref: mutation.node, message, position })
    }

    const firstSnapshotSeq = agent.session.seq
    const appendedIncludes = pendingSnapshots.map((snapshot, index) => ({
      nodeId: snapshot.nodeId,
      snapshotSeq: firstSnapshotSeq + index,
      position: snapshot.position,
    }))
    const plan = nextPlan(current, {
      excluded, included: [...included, ...appendedIncludes], replacements: current.replacements,
    })
    for (const snapshot of pendingSnapshots) {
      agent.session.append('context/compiler-snapshot', {
        id: snapshot.nodeId,
        message: snapshot.message,
        provenance: {
          provider: name,
          sourceId: snapshot.ref.sessionId,
          sourceSeq: snapshot.ref.seq,
          contentHash: contentHash(snapshot.message),
        },
      })
    }
    return this.commit(agent.session, plan)
  }

  /**
   * Archive one node's model-visible semantics with a reversible role-preserving placeholder.
   * @param agent - Live idle Agent whose Session receives the snapshot and plan events.
   * @param ref - Expected current Context Plan revision.
   * @param nodeRef - Native family message to retain structurally and replace semantically.
   * @param reason - Human-visible reason retained with the replacement overlay.
   * @param expectedGraphRevision - Optional family revision required by archive confirmation.
   * @returns The committed v3 Contextify view.
   */
  @Remote('archiveNode')
  async archiveNode(
    agent: Agent,
    ref: ContextPlanRef,
    nodeRef: ContextMessageRef,
    reason: string,
    expectedGraphRevision?: string,
  ): Promise<ContextifyView> {
    const current = this.prepare(agent, ref)
    const explanation = reason.trim()
    if (explanation.length < 1 || explanation.length > 1_000) {
      throw new ContextifyError('archive reason must be non-empty and bounded', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const family = await this.loadFamily(agent.session)
    if (expectedGraphRevision !== undefined && family.revision !== expectedGraphRevision) {
      throw new ContextifyError('the Context Map changed before archive was confirmed', 'CONTEXTIFY_STALE_GRAPH')
    }
    const node = resolveNode(family.graph, nodeRef)
    if (node === undefined) throw new ContextifyError('message is not part of the active Context Map', 'CONTEXTIFY_INVALID_NODE')
    if (current.replacements.some(item => item.nodeId === node.id)) {
      throw new ContextifyError('message is already archived', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const replacement = this.createPlaceholderReplacement(agent.session, family, node, explanation)
    return this.commit(agent.session, nextPlan(current, {
      excluded: current.excluded,
      included: current.included,
      replacements: [...current.replacements.filter(item => item.nodeId !== node.id), replacement],
    }))
  }

  /**
   * Move one suggested completed Q&A into a deterministic native child Branch.
   * @param agent - Live idle Agent whose source Session owns the reviewed Turn.
   * @param suggestionId - Durable suggestion identity returned by `get`.
   * @param childSessionId - Native Agent-backed child created from the prepared boundary.
   * @returns The native child Session created by, or recovered for, this relocation.
   */
  @Remote('acceptBranchSuggestion')
  async acceptBranchSuggestion(
    agent: Agent,
    suggestionId: string,
    childSessionId: SessionId,
  ): Promise<ContextBranchRelocationResult> {
    this.assertLive(agent)
    if (agent.status !== 'idle') throw new ContextifyError('Branch relocation requires an idle Agent', 'CONTEXTIFY_AGENT_BUSY')
    const review = agent.session.events.findLast(event => event.type === 'contextify/branch-review'
      && event.data.suggestion?.id === suggestionId)
    if (review?.type !== 'contextify/branch-review' || review.data.suggestion === null) {
      throw new ContextifyError('Branch suggestion is unavailable', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const suggestion = review.data.suggestion
    const key = branchRelocationKey(agent.id, suggestion.boundaryAfter)
    const laterConversation = agent.session.events.slice(suggestion.boundaryAfter + 1).some(event =>
      event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
    if (laterConversation) {
      throw new ContextifyError('the source conversation advanced after the Branch suggestion', 'CONTEXTIFY_STALE_GRAPH')
    }
    let plan = currentContextPlan(agent.session)
    const family = await this.loadFamily(agent.session)
    const nodes = [suggestion.input, suggestion.output].map(ref => resolveNode(family.graph, ref))
    if (nodes.some(node => node === undefined)) {
      throw new ContextifyError('the suggested Q&A is no longer available', 'CONTEXTIFY_INVALID_NODE')
    }
    const concrete = nodes as [ContextFamilyGraphNode, ContextFamilyGraphNode]
    const missing = concrete.filter(node => !plan.replacements.some(item => item.nodeId === node.id))
    if (missing.length > 0) {
      if (plan.revision !== suggestion.planRevision) {
        throw new ContextifyError('the Context Plan changed after the Branch suggestion', 'CONTEXTIFY_STALE_REVISION')
      }
    }
    const childAgent = this.ctx.agents.get(childSessionId)
    if (childAgent === undefined || this.ctx.sessions.get(childSessionId) !== childAgent.session) {
      throw new ContextifyError('Branch relocation requires a native Agent-backed child Session', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    if (childAgent.status !== 'idle') {
      throw new ContextifyError('the native Branch Agent must be idle', 'CONTEXTIFY_AGENT_BUSY')
    }
    const child = childAgent.session
    if (child.header.parentSession !== agent.id
      || child.header.seedLength !== suggestion.boundaryBefore + 1) {
      throw new ContextifyError('the native Branch does not match the suggested boundary', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    const inputEvent = agent.session.events[suggestion.input.seq]
    const outputEvent = agent.session.events[suggestion.output.seq]
    if (inputEvent?.type !== 'user/message' || outputEvent?.type !== 'assistant/message') {
      throw new ContextifyError('the suggested Q&A source is unavailable', 'CONTEXTIFY_INVALID_NODE')
    }
    const relocated = child.events.some(event => event.type === 'contextify/branch-relocation'
      && event.data.key === key)
    if (!relocated) {
      const advancedChild = child.events.slice(child.header.seedLength).some(event =>
        event.type === 'turn/start' || event.type === 'turn/end'
        || event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
      if (advancedChild) {
        throw new ContextifyError('the native Branch advanced before relocation completed', 'CONTEXTIFY_STALE_GRAPH')
      }
      this.relocatingBranches.add(child.id)
      try {
        child.append('turn/start', { turn: suggestion.turn })
        child.append('user/message', structuredClone(inputEvent.data), { surfaceOp: 'append' })
        child.append('assistant/message', structuredClone(outputEvent.data), { surfaceOp: 'append' })
        child.append('turn/end', { turn: suggestion.turn, reason: { kind: 'completed' } })
        child.append('contextify/branch-relocation', {
          key,
          sourceSessionId: agent.id,
          sourceTurnEndSeq: suggestion.boundaryAfter,
        })
      } finally {
        this.relocatingBranches.delete(child.id)
      }
    }
    if (missing.length > 0) {
      const replacements = missing.map(node => this.createPlaceholderReplacement(
        agent.session, family, node, 'Moved to a native Branch',
      ))
      plan = nextPlan(plan, {
        excluded: plan.excluded,
        included: plan.included,
        replacements: [...plan.replacements, ...replacements],
      })
      this.commit(agent.session, plan)
    }
    return { childSessionId: child.id }
  }

  /**
   * Restore a node's original semantics while preserving Include/Exclude state.
   * @param agent - Live idle Agent whose Session owns the replacement overlay.
   * @param ref - Expected current Context Plan revision.
   * @param nodeRef - Native family message whose replacement is removed.
   * @returns The committed Contextify view with original semantics restored.
   */
  @Remote('restoreNode')
  async restoreNode(agent: Agent, ref: ContextPlanRef, nodeRef: ContextMessageRef): Promise<ContextifyView> {
    const current = this.prepare(agent, ref)
    const family = await this.loadFamily(agent.session)
    const node = resolveNode(family.graph, nodeRef)
    if (node === undefined) throw new ContextifyError('message is not part of the active Context Map', 'CONTEXTIFY_INVALID_NODE')
    const nodeId = node.id
    const replacement = current.replacements.find(item => item.nodeId === nodeId)
    const replacements = current.replacements.filter(item => item.nodeId !== nodeId)
    if (replacement === undefined) {
      throw new ContextifyError('message does not have a placeholder replacement', 'CONTEXTIFY_INVALID_TRANSITION')
    }
    let included = current.included
    if (included.some(item => item.nodeId === nodeId && item.snapshotSeq === replacement.snapshotSeq)) {
      const source = family.inspections.get(node.owner.sessionId)
      const exact = source === undefined ? null : exactMessage(source, node.owner.seq)
      if (exact === null || exact.role !== node.role) {
        throw new ContextifyError('message source is unavailable', 'CONTEXTIFY_INVALID_NODE')
      }
      const message = importedMessage(exact)
      const snapshot = agent.session.append('context/compiler-snapshot', {
        id: node.id,
        message,
        provenance: {
          provider: name,
          sourceId: node.owner.sessionId,
          sourceSeq: node.owner.seq,
          contentHash: contentHash(message),
        },
      })
      included = included.map(item => item.nodeId === nodeId && item.snapshotSeq === replacement.snapshotSeq
        ? { ...item, snapshotSeq: snapshot.seq }
        : item)
    }
    return this.commit(agent.session, nextPlan(current, {
      excluded: current.excluded,
      included,
      replacements,
    }))
  }

  /**
   * Reset every explicit choice to Natural behavior.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed Natural view.
   */
  @Remote('reset')
  reset(agent: Agent, ref: ContextPlanRef): ContextifyView {
    return this.commit(agent.session, resetPlan(this.prepare(agent, ref)))
  }

  /**
   * Restore the prior Context Plan state as a new durable revision.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed prior-state view.
   */
  @Remote('undo')
  undo(agent: Agent, ref: ContextPlanRef): ContextifyView {
    const current = this.prepare(agent, ref)
    const plan = undoPlan(agent.session, current)
    if (plan === null) throw new ContextifyError('Context Plan has no earlier state', 'CONTEXTIFY_HISTORY_EMPTY')
    return this.commit(agent.session, plan)
  }

  /**
   * Restore the next Context Plan state as a new durable revision.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed next-state view.
   */
  @Remote('redo')
  redo(agent: Agent, ref: ContextPlanRef): ContextifyView {
    const current = this.prepare(agent, ref)
    const plan = redoPlan(agent.session, current)
    if (plan === null) throw new ContextifyError('Context Plan has no later state', 'CONTEXTIFY_HISTORY_EMPTY')
    return this.commit(agent.session, plan)
  }

  private createPlaceholderReplacement(
    session: Session,
    family: LoadedFamily,
    node: ContextFamilyGraphNode,
    reason: string,
  ): ContextReplacementNode {
    const source = family.inspections.get(node.owner.sessionId)
    const exact = source === undefined ? null : exactMessage(source, node.owner.seq)
    if (exact === null || exact.role !== node.role) {
      throw new ContextifyError('message source is unavailable', 'CONTEXTIFY_INVALID_NODE')
    }
    const message = importedMessage(exact)
    const placeholder: Message = structuredClone({
      ...message,
      content: [{ type: 'text', text: CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT }],
    })
    const snapshot = session.append('context/compiler-snapshot', {
      id: node.id,
      message: placeholder,
      provenance: {
        provider: 'contextify-placeholder',
        sourceId: node.owner.sessionId,
        sourceSeq: node.owner.seq,
        contentHash: contentHash(placeholder),
      },
    })
    return {
      nodeId: node.id,
      snapshotSeq: snapshot.seq,
      originalEventSeq: node.activeEventSeq,
      role: node.role,
      kind: 'placeholder',
      reason,
    }
  }

  private prepare(agent: Agent, ref: ContextPlanRef): ContextPlanSnapshot {
    this.assertLive(agent)
    if (agent.status !== 'idle') {
      throw new ContextifyError(
        'context can change after the current reply finishes',
        'CONTEXTIFY_AGENT_BUSY',
      )
    }
    const plan = currentContextPlan(agent.session)
    if (plan.revision !== ref.revision) {
      throw new ContextifyError(
        `stale plan revision ${String(ref.revision)}; current is ${String(plan.revision)}`,
        'CONTEXTIFY_STALE_REVISION',
      )
    }
    return plan
  }

  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new ContextifyError(`agent "${agent.id}" is not live`, 'CONTEXTIFY_AGENT_NOT_LIVE')
    }
  }

  private assertRecommendationIdle(agent: Agent): void {
    if (agent.status !== 'idle') {
      throw new ContextifyError('context recommendations require an idle Agent', 'CONTEXTIFY_AGENT_BUSY')
    }
  }

  private commit(session: Session, plan: ContextPlanSnapshot): ContextifyView {
    session.append('contextify/plan', plan)
    return this.view(session)
  }

  private view(session: Session): ContextifyView {
    const plan = currentContextPlan(session)
    const compilation = compileContextify({ session, turn: -1, step: -1 })
    const totalNodeCount = session.events.filter(event =>
      event.type === 'user/message'
      || (event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' || block.type === 'image'))).length
    const latestTurnEnd = session.events.findLast(event => event.type === 'turn/end')
    const reviewed = session.events.findLast(event => event.type === 'contextify/branch-review'
      && event.data.suggestion !== null)
    const branchSuggestion = reviewed?.type === 'contextify/branch-review'
      && reviewed.data.suggestion !== null
      && reviewed.data.turnEndSeq === latestTurnEnd?.seq
      && reviewed.data.suggestion.planRevision === plan.revision
      ? reviewed.data.suggestion
      : undefined
    return {
      plan: structuredClone(plan),
      graphAsOfSeq: session.seq - 1,
      selectedCount: compilation.messages.filter(message =>
        message.content.some(block => block.type === 'text' || block.type === 'image')).length,
      totalNodeCount,
      canUndo: plan.history.past.length > 0,
      canRedo: plan.history.future.length > 0,
      ...(branchSuggestion === undefined ? {} : { branchSuggestion: structuredClone(branchSuggestion) }),
    }
  }

  private decorateNodes(
    session: Session,
    nodes: readonly ContextFamilyGraphNode[],
    inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
  ): readonly ContextFamilyGraphNode[] {
    const replacements = new Map(currentContextPlan(session).replacements.map(item => [item.nodeId, item]))
    return Object.freeze(nodes.map((node) => {
      const replacement = replacements.get(node.id)
      if (replacement === undefined) return node
      const event = session.events[replacement.snapshotSeq]
      if (event?.type !== 'context/compiler-snapshot') return node
      const source = inspections.get(node.owner.sessionId)
      const original = source === undefined ? null : exactMessage(source, node.owner.seq)
      if (original === null) return node
      return Object.freeze({
        ...node,
        replacement: Object.freeze({
          preview: recommendationText(event.data.message).slice(0, 240),
          original: recommendationText(original),
          reason: replacement.reason,
          role: replacement.role,
          originalAvailable: true as const,
        }),
      })
    }))
  }

  private async loadFamily(active: Session): Promise<LoadedFamily> {
    const headers = new Map<SessionId, ContextFamilyInspection['meta']>()
    for (const header of await this.ctx.sessionPersistence.list()) {
      if (header.origin !== 'subagent') headers.set(header.id, header)
    }
    for (const session of this.ctx.sessions.list()) {
      if (session.header.origin !== 'subagent') headers.set(session.id, session.header)
    }
    const knownSessionIds = new Set(headers.keys())

    let rootId = active.id
    const seen = new Set<SessionId>()
    while (!seen.has(rootId)) {
      seen.add(rootId)
      const parent = headers.get(rootId)?.parentSession
      if (parent === undefined || !headers.has(parent)) break
      rootId = parent
    }
    const familyIds = new Set<SessionId>([rootId])
    let changed = true
    while (changed) {
      changed = false
      for (const header of headers.values()) {
        if (header.parentSession === undefined || !familyIds.has(header.parentSession)
          || familyIds.has(header.id)) continue
        familyIds.add(header.id)
        changed = true
      }
    }

    const inspections = new Map<SessionId, ContextFamilyInspection>()
    for (const id of familyIds) {
      const live = this.ctx.sessions.get(id)
      const inspection = live === undefined
        ? await this.ctx.sessionPersistence.inspect(id)
        : { meta: live.header, events: live.events }
      inspections.set(id, inspection)
    }
    const graph = projectSessionFamily({
      activeSessionId: active.id,
      sessions: [...inspections.values()],
    })
    return { graph, revision: familyRevision(inspections), inspections, knownSessionIds }
  }
}

function isRecordWithRevision(value: unknown): value is { readonly revision: number } {
  if (typeof value !== 'object' || value === null || !('revision' in value)) return false
  const revision = value.revision
  return typeof revision === 'number' && Number.isSafeInteger(revision)
    && revision >= 0 && revision < Number.MAX_SAFE_INTEGER
}

export default ContextifyService
