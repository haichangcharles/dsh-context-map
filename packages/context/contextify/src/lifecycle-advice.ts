/** Explicit task lifecycle intent over native Session branches. */
import type { ContextFamilyGraph, ContextWorkStateAdvice } from './types.ts'

/** Propose one lifecycle change only for an explicit current-task instruction.
 * @param graph - Frozen family graph with current branch work states.
 * @param objective - Exact reviewed unsent draft.
 * @returns At most one review-only proposal; context inclusion is unaffected.
 */
export function contextLifecycleAdvice(graph: ContextFamilyGraph, objective: string): readonly ContextWorkStateAdvice[] {
  const text = objective.trim().toLocaleLowerCase()
  const state = /^(?:park|pause|defer) (?:this|the current) (?:task|branch)\b|^(?:暂缓|暂停|搁置)(?:当前|这个)(?:任务|分支)/.test(text)
    ? 'parked' : /^(?:complete|finish|close) (?:this|the current) (?:task|branch)\b|^(?:完成|结束)(?:当前|这个)(?:任务|分支)/.test(text)
      ? 'completed' : /^(?:reopen|restart) (?:this|the current) (?:task|branch)\b|^重新(?:打开|开始)(?:当前|这个)(?:任务|分支)/.test(text)
        ? 'open' : undefined
  const active = graph.sessions.find(session => session.id === graph.activeSessionId)
  if (state === undefined || active === undefined || active.workState === state) return []
  return Object.freeze([Object.freeze({ sessionId: active.id, state,
    reason: 'The draft explicitly requests this task lifecycle change; selected context stays unchanged.' })])
}
