import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm/brand'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { projectSessionFamily } from '../src/family.ts'

function inspect(session: Session): SessionInspection {
  return { meta: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
}

function appendUserTurn(session: Session, turn: number, text: string): number {
  session.append('turn/start', { turn })
  const message = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return message.seq
}

describe('projectSessionFamily', () => {
  it('projects only human inputs and visible model outputs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('human-conversation'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '你好' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context. Hidden from the map.' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<system-reminder>Hidden skill catalog</system-reminder>' }],
      source: { kind: 'plugin', plugin: 'skill-catalog', form: 'catalog' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '你好！' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const graph = projectSessionFamily({
      activeSessionId: session.id,
      sessions: [inspect(session)],
    })

    expect(graph.nodes.map(node => [node.role, node.preview])).toEqual([
      ['user', '你好'],
      ['assistant', '你好！'],
    ])
  })

  it('keeps only the completed final assistant output from a multi-step turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('final-output-only'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'BAI资本是什么' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '我先搜索，请再确认一些过程问题。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('search'),
        content: [{ type: 'text', text: 'intermediate search result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'BAI资本是一家专注亚洲市场的投资机构。' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })

    const openGraph = projectSessionFamily({
      activeSessionId: session.id,
      sessions: [inspect(session)],
    })
    expect(openGraph.nodes.map(node => node.preview)).toEqual(['BAI资本是什么'])

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [],
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '失败前的过程文本' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } },
    })

    const graph = projectSessionFamily({
      activeSessionId: session.id,
      sessions: [inspect(session)],
    })
    expect(graph.nodes.map(node => [node.role, node.preview])).toEqual([
      ['user', 'BAI资本是什么'],
      ['assistant', 'BAI资本是一家专注亚洲市场的投资机构。'],
      ['user', '继续'],
    ])
  })

  it('deduplicates inherited messages and projects native fork edges', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = ctx.sessions.create(SessionId('root'))
    root.append('turn/start', { turn: 1 })
    root.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'root question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const rootAnswer = root.append('assistant/message', { stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'text', text: 'root answer' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    root.append('assistant/message', { stream: [],
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'reasoning only' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    root.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: CallId('call-hidden'),
        content: [{ type: 'text', text: 'tool output' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const rootBoundary = root.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq

    const childA = ctx.sessions.fork(root, rootBoundary, SessionId('child-a'))
    const childAMessage = appendUserTurn(childA, 2, 'child A question')
    const childB = ctx.sessions.fork(root, rootBoundary, SessionId('child-b'))
    appendUserTurn(childB, 2, 'child B question')
    const samePointBranch = ctx.sessions.fork(childA, rootBoundary, SessionId('same-point-branch'))
    appendUserTurn(samePointBranch, 2, 'same point question')
    const grandchild = ctx.sessions.fork(childA, childA.snapshotEvents().at(-1)!.seq, SessionId('grandchild'))
    appendUserTurn(grandchild, 3, 'grandchild question')
    const emptyChild = ctx.sessions.fork(root, rootBoundary, SessionId('empty-child'))

    const graph = projectSessionFamily({
      activeSessionId: childA.id,
      sessions: [
        inspect(root), inspect(childA), inspect(childB), inspect(samePointBranch),
        inspect(grandchild), inspect(emptyChild),
      ],
    })

    expect(graph.rootSessionId).toBe(root.id)
    expect(graph.nodes.map(node => node.preview)).toEqual([
      'root question',
      'root answer',
      'child A question',
      'grandchild question',
      'child B question',
      'same point question',
    ])
    expect(graph.nodes.filter(node => node.preview === 'root answer')).toHaveLength(1)
    expect(graph.nodes.find(node => node.preview === 'root question')?.branchAtSeq).toBe(rootBoundary)
    expect(graph.nodes.find(node => node.preview === 'root answer')?.branchAtSeq).toBe(rootBoundary)
    expect(graph.nodes.some(node => node.preview.includes('reasoning'))).toBe(false)
    expect(graph.nodes.some(node => node.preview.includes('tool output'))).toBe(false)
    const rootAnswerId = `${root.id}:${rootAnswer.seq}`
    expect(graph.edges.filter(edge => edge.source === rootAnswerId).map(edge => edge.target).sort()).toEqual([
      `${childA.id}:${childAMessage}`,
      `${childB.id}:${childAMessage}`,
      `${samePointBranch.id}:${childAMessage}`,
    ])
    expect(graph.sessions.find(item => item.id === emptyChild.id)?.tipNodeId).toBe(rootAnswerId)
    expect(graph.nodes.find(node => node.id === `${childA.id}:${childAMessage}`)?.activeEventSeq)
      .toBe(childAMessage)
    expect(graph.nodes.find(node => node.id === `${childB.id}:${childAMessage}`)?.activeEventSeq)
      .toBeNull()
    expect(graph.sessions.find(item => item.id === samePointBranch.id)).toMatchObject({
      parentSessionId: root.id,
      depth: 1,
    })
    expect(graph.sessions.find(item => item.id === grandchild.id)).toMatchObject({
      parentSessionId: childA.id,
      depth: 2,
    })
  })
})
