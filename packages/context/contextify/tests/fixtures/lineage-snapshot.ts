/** Authored source-withdrawal fixture in a real two-step headless turn. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { currentContextPlan, nextPlan, recordDelegationSlice } from '@deepseek-ai/dsh-contextify'

/** Loader fixture plugin name. */
export const name = 'lineage-snapshot'
/** Services required before registering the authored operation. */
export const inject = ['tools']

/** Register a fixed scope-edit tool and inspect the actual next model input.
 * @param ctx - Test-only Loader context containing native Sessions and tools.
 */
export function apply(ctx: Context): void {
  let edits = 0
  let requests = 0
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'create_scope_fixture', description: 'Set up the authored scope-withdrawal fixture.',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (_args, exec) => {
      assert(exec.agent, 'scope fixture requires its real agent')
      assert.equal(edits++, 0, 'scope fixture must run once')
      const session = exec.agent.session
      const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'synthetic-fixture' } })
      const valid = session.append('user/message', message('VALID_INDEPENDENT_SOURCE'), { surfaceOp: 'append' }).seq
      const revoked = session.append('user/message', message('REVOKED_ORIGINAL_SOURCE'), { surfaceOp: 'append' }).seq
      const child = SessionId('authored-source-worker')
      recordDelegationSlice(session, child, [revoked])
      const report = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'REVOKED_WORKER_CARRIER' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: child },
      }), { surfaceOp: 'append' }).seq
      session.append('user/message', message('REVOKED_SUMMARY_CARRIER'),
        { surfaceOp: 'append', sourceEventSeqs: [report] })
      const openTurn = session.snapshotEvents().findLast(event => event.type === 'turn/start')
      assert(openTurn?.type === 'turn/start')
      const compactionId = CompactionId('authored-scope-compaction')
      const content = [{ type: 'text' as const, text: 'VALID_COMPACT_CHECKPOINT' }]
      session.append('compaction/start', { compactionId, turn: openTurn.data.turn })
      session.append('compaction/summary', { compactionId, summary: content,
        shadowedRange: { start: valid, end: valid }, shadowedSeqs: [valid], shadowedTokenCount: 1,
        provider: 'synthetic-fixture', model: 'fixed',
      })
      session.append('user/message', createUserMessage({ content, source: compactCheckpointSource(compactionId) }),
        { surfaceOp: { op: 'replace', startSeq: valid, endSeq: valid }, sourceEventSeqs: [valid] })
      session.append('compaction/end', { compactionId, turn: openTurn.data.turn })
      session.append('contextify/plan', nextPlan(currentContextPlan(session), {
        excluded: [{ nodeId: 'revoked', eventSeq: revoked }], included: [], replacements: [],
      }))
      return Promise.resolve('Scope fixture installed; inspect the next request.')
    },
  })))
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert(requests <= 2, 'scope snapshot permits exactly two replay calls')
    if (requests === 2) {
      assert.equal(edits, 1, 'the real tool did not execute')
      const payload = JSON.stringify(options.messages)
      assert(payload.includes('VALID_COMPACT_CHECKPOINT'), 'valid compacted evidence was lost')
      assert(!payload.includes('REVOKED_'), 'withdrawn source or transitive carrier reached the model')
      assert(payload.includes('Reply with exactly the word: PONG.'), 'actual current input was lost')
    }
    return next()
  }, { global: true, prepend: true })
}
