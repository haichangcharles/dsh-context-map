import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'

function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('ContextCompilerRegistry', () => {
  it('compiles the default surface into the same frozen messages as Session.deriveMessages', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const session = Session.create(SessionId('surface-default'))
    appendUser(session, 'one')
    appendUser(session, 'two')

    const compilation = ctx.contextCompiler.compile({ session, turn: 1, step: 1 })

    expect(compilation).toEqual({
      id: 'surface',
      version: 1,
      eventSeqs: [0, 1],
      messages: session.deriveMessages(),
    })
    expect(Object.isFrozen(compilation)).toBe(true)
    expect(Object.isFrozen(compilation.eventSeqs)).toBe(true)
    expect(Object.isFrozen(compilation.messages)).toBe(true)
    expect(compilation.messages[0]).toBe(session.deriveMessages()[0])
  })

  it('registers, durably selects, and compiles a provider in its chosen order', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const session = Session.create(SessionId('custom-provider'))
    appendUser(session, 'one')
    appendUser(session, 'two')
    ctx.contextCompiler.register({
      id: 'reverse',
      version: 2,
      select: () => ({ eventSeqs: [1, 0] }),
    })

    expect(ctx.contextCompiler.select(session, 'reverse')).toEqual({ id: 'reverse', version: 2 })
    expect(session.snapshotEvents().at(-1)).toMatchObject({
      type: 'context/compiler',
      data: { id: 'reverse', version: 2 },
    })
    const seqAfterSelection = session.seq
    expect(ctx.contextCompiler.select(session, 'reverse')).toEqual({ id: 'reverse', version: 2 })
    expect(session.seq).toBe(seqAfterSelection)
    expect(ctx.contextCompiler.descriptor(session)).toEqual({ id: 'reverse', version: 2 })

    const compilation = ctx.contextCompiler.compile({ session, turn: 1, step: 1 })
    expect(compilation.eventSeqs).toEqual([1, 0])
    expect(compilation.messages).toEqual(session.deriveMessages().toReversed())
  })

  it('compiles a durable snapshot without adding it to the Session surface', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const session = Session.create(SessionId('snapshot-selection'))
    const snapshot = session.append('context/compiler-snapshot', {
      id: 'sibling:7',
      message: createUserMessage({
        content: [{ type: 'text', text: 'imported sibling fact' }],
        source: { kind: 'plugin', plugin: 'contextify' },
      }),
    })
    ctx.contextCompiler.register({
      id: 'snapshot-provider',
      version: 1,
      select: () => ({ eventSeqs: [snapshot.seq] }),
    })
    ctx.contextCompiler.select(session, 'snapshot-provider')

    expect(session.surface.nodes).toEqual([])
    expect(ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toMatchObject({
      eventSeqs: [snapshot.seq],
      messages: [{ content: [{ type: 'text', text: 'imported sibling fact' }] }],
    })
  })

  it('rejects reserved, duplicate, blank, and invalid-version registrations', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const valid = { id: 'custom', version: 1, select: () => ({ eventSeqs: [] }) }
    ctx.contextCompiler.register(valid)

    for (const definition of [valid, { ...valid, id: 'surface' }]) {
      expect(() => ctx.contextCompiler.register(definition)).toThrow(expect.objectContaining({
        code: 'DUPLICATE_COMPILER',
      }))
    }
    expect(() => ctx.contextCompiler.register({ ...valid, id: '' })).toThrow(/id/)
    expect(() => ctx.contextCompiler.register({ ...valid, id: ' padded ' })).toThrow(/id/)
    expect(() => ctx.contextCompiler.register({ ...valid, id: 'zero', version: 0 })).toThrow(/version/)
    expect(() => ctx.contextCompiler.register({ ...valid, id: 'fraction', version: 1.5 })).toThrow(/version/)
  })

  it('rejects invalid, duplicate, missing, and non-message selected event sequences', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const session = Session.create(SessionId('invalid-selection'))
    appendUser(session, 'visible')
    session.append('todo/write', { todos: [] })
    const cases: Array<[string, readonly number[]]> = [
      ['negative', [-1]],
      ['fraction', [0.5]],
      ['duplicate', [0, 0]],
      ['missing', [99]],
      ['non-message', [1]],
    ]

    for (const [id, eventSeqs] of cases) {
      ctx.contextCompiler.register({ id, version: 1, select: () => ({ eventSeqs }) })
      ctx.contextCompiler.select(session, id)
      expect(() => ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toThrow(expect.objectContaining({
        code: 'INVALID_SELECTION',
      }))
    }
  })

  it('fails loudly when the selected provider is disposed or its version changes', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    const session = Session.create(SessionId('stale-provider'))
    const dispose = ctx.contextCompiler.register({
      id: 'temporary',
      version: 1,
      select: () => ({ eventSeqs: [] }),
    })
    ctx.contextCompiler.select(session, 'temporary')
    dispose()
    expect(() => ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toThrow(expect.objectContaining({
      code: 'COMPILER_NOT_FOUND',
    }))

    ctx.contextCompiler.register({
      id: 'temporary',
      version: 2,
      select: () => ({ eventSeqs: [] }),
    })
    expect(() => ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toThrow(expect.objectContaining({
      code: 'COMPILER_VERSION_MISMATCH',
    }))
  })
})
