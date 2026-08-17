/**
 * Registry-backed selection of durable Session events for one model request.
 * @module @deepseek-ai/dsh-context-compiler
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {
  RequestContextCompilerDescriptor,
  Session,
} from '@deepseek-ai/dsh-session'

/** Stable identity of one context compiler contract. */
export interface ContextCompilerDescriptor {
  readonly id: string
  readonly version: number
}

/** Inputs available to a pure context selection. */
export interface ContextCompileRequest {
  readonly session: Session
  readonly turn: number
  readonly step: number
}

/** Durable event sequences selected by a compiler provider. */
export interface ContextSelection {
  readonly eventSeqs: readonly number[]
}

/** One log-only message copied into a Session for compiler selection. */
export interface ContextCompilerSnapshot {
  /** Provider-owned stable identity used to correlate the copied message. */
  readonly id: string
  /** Exact model-visible message reconstructed from this durable event. */
  readonly message: Message
  /** Optional provider-owned immutable origin used to audit copied content. */
  readonly provenance?: {
    readonly provider: string
    readonly sourceId: string
    readonly sourceSeq: number
    readonly contentHash: string
  }
}

/** Fully validated model input produced from selected durable events. */
export interface ContextCompilation extends ContextCompilerDescriptor {
  readonly eventSeqs: readonly number[]
  readonly messages: readonly Message[]
}

/** Pure provider registered under one stable descriptor. */
export interface ContextCompilerDefinition extends ContextCompilerDescriptor {
  readonly select: (request: ContextCompileRequest) => ContextSelection
}

/** Stable machine-readable context compiler failure codes. */
export type ContextCompilerErrorCode =
  | 'INVALID_SELECTION'
  | 'COMPILER_NOT_FOUND'
  | 'COMPILER_VERSION_MISMATCH'
  | 'DUPLICATE_COMPILER'

/** Failure raised at the compiler registry boundary. */
export class ContextCompilerError extends Error {
  constructor(
    message: string,
    readonly code: ContextCompilerErrorCode,
  ) {
    super(message)
    this.name = 'ContextCompilerError'
  }
}

/** Create one consistently coded provider-selection validation failure. */
function invalidSelection(message: string): ContextCompilerError {
  return new ContextCompilerError(`invalid context compiler selection: ${message}`, 'INVALID_SELECTION')
}

/** Snapshot and validate provider-owned event sequence output. */
function selectedEventSeqs(
  request: ContextCompileRequest,
  definition: ContextCompilerDefinition,
): number[] {
  const selection: unknown = definition.select(request)
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    throw invalidSelection('provider must return an object')
  }
  const values: unknown = (selection as { eventSeqs?: unknown }).eventSeqs
  if (!Array.isArray(values)) throw invalidSelection('eventSeqs must be an array')
  const eventSeqs: number[] = []
  const seen = new Set<number>()
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw invalidSelection(`event seq ${String(value)} must be a non-negative safe integer`)
    }
    if (seen.has(value)) throw invalidSelection(`event seq ${String(value)} is duplicated`)
    seen.add(value)
    eventSeqs.push(value)
  }
  return eventSeqs
}

const SURFACE_DESCRIPTOR = Object.freeze({
  id: 'surface',
  version: 1,
} satisfies ContextCompilerDescriptor satisfies RequestContextCompilerDescriptor)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Selects the context compiler for subsequent model requests. */
    'context/compiler': ContextCompilerDescriptor
    /** Model-visible message copied into this Session for compiler selection. */
    'context/compiler-snapshot': ContextCompilerSnapshot
  }
}

/** Resolve one validated selected event into its exact model message. */
function selectedMessage(session: Session, seq: number): Message {
  const event = session.events[seq]
  if (event === undefined) throw invalidSelection(`event seq ${String(seq)} does not exist`)
  if (event.type === 'context/compiler-snapshot') return event.data.message
  if (event.type !== 'user/message'
    && event.type !== 'assistant/message'
    && event.type !== 'tool/result') {
    throw invalidSelection(`event seq ${String(seq)} has non-message type "${event.type}"`)
  }
  const message = session.deriveEventMessage(event)
  if (message === null) throw invalidSelection(`event seq ${String(seq)} does not derive a message`)
  return message
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextCompiler: ContextCompilerRegistry
  }
}

/** Registry and validation boundary for request context compilers. */
export class ContextCompilerRegistry extends Service {
  private readonly definitions = new Map<string, ContextCompilerDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'contextCompiler')
    this.definitions.set(SURFACE_DESCRIPTOR.id, {
      ...SURFACE_DESCRIPTOR,
      select: ({ session }) => ({
        eventSeqs: session.surface.nodes.filter((seq) => {
          const event = session.events[seq]
          return event !== undefined && session.deriveEventMessage(event) !== null
        }),
      }),
    })
  }

  /**
   * Register one provider until the returned disposer is called.
   * @param definition - Stable provider identity and pure selection function.
   * @returns A disposer that removes this exact registration.
   */
  register(definition: ContextCompilerDefinition): () => void {
    if (definition.id.length === 0 || definition.id.trim() !== definition.id) {
      throw new TypeError('context compiler id must be non-empty and have no surrounding whitespace')
    }
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new TypeError('context compiler version must be a positive safe integer')
    }
    if (this.definitions.has(definition.id)) {
      throw new ContextCompilerError(
        `context compiler "${definition.id}" is already registered`,
        'DUPLICATE_COMPILER',
      )
    }
    const registered = Object.freeze({
      id: definition.id,
      version: definition.version,
      select: definition.select,
    })
    this.definitions.set(registered.id, registered)
    return () => {
      if (this.definitions.get(registered.id) === registered) {
        this.definitions.delete(registered.id)
      }
    }
  }

  /**
   * Durably select a registered provider for one Session.
   * @param session - Session whose future requests use the provider.
   * @param id - Registered provider id to select.
   * @returns The exact provider descriptor appended or already active.
   */
  select(session: Session, id: string): ContextCompilerDescriptor {
    const definition = this.definitions.get(id)
    if (definition === undefined) {
      throw new ContextCompilerError(`context compiler "${id}" is not registered`, 'COMPILER_NOT_FOUND')
    }
    const descriptor = Object.freeze({ id: definition.id, version: definition.version })
    const current = this.descriptor(session)
    if (current.id !== descriptor.id || current.version !== descriptor.version) {
      session.append('context/compiler', descriptor)
    }
    return descriptor
  }

  /**
   * Resolve the durable provider descriptor active for one Session.
   * @param session - Session whose compiler selection should be folded.
   * @returns The latest durable selection, or the built-in surface compiler.
   */
  descriptor(session: Session): ContextCompilerDescriptor {
    for (let index = session.events.length - 1; index >= 0; index--) {
      const event = session.events[index]
      if (event?.type === 'context/compiler') {
        return Object.freeze({ id: event.data.id, version: event.data.version })
      }
    }
    return SURFACE_DESCRIPTOR
  }

  /**
   * Compile the provider-selected durable Session events into messages.
   * @param request - Session and loop coordinates supplied to the provider.
   * @returns Frozen provider identity, event sequences, and derived messages.
   */
  compile(request: ContextCompileRequest): ContextCompilation {
    const descriptor = this.descriptor(request.session)
    const definition = this.definitions.get(descriptor.id)
    if (definition === undefined) {
      throw new ContextCompilerError(
        `context compiler "${descriptor.id}" is not registered`,
        'COMPILER_NOT_FOUND',
      )
    }
    if (definition.version !== descriptor.version) {
      throw new ContextCompilerError(
        `context compiler "${descriptor.id}" version mismatch: selected ${String(descriptor.version)}, registered ${String(definition.version)}`,
        'COMPILER_VERSION_MISMATCH',
      )
    }
    const eventSeqs = selectedEventSeqs(request, definition)
    const messages = eventSeqs.map(seq => selectedMessage(request.session, seq))
    return Object.freeze({
      ...descriptor,
      eventSeqs: Object.freeze(eventSeqs),
      messages: Object.freeze(messages),
    })
  }
}

export default ContextCompilerRegistry
