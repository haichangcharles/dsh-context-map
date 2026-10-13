/** Context Steward draft-review copy, owned by the Contextify Client. */

/** Simplified Chinese dictionary and key-set authority. */
export const zh = {
  'action.reviewDraft': '检查草稿所需的 Context',
  'action.reviewingDraft': '正在检查 Context…',
  'action.draftReviewMode': '草稿检查模式',
  'action.localDraft': '本地检查草稿',
  'action.fastDraft': '快速检查草稿',
  'action.deepDraft': '深入检查草稿',
  'settings.deepLimit': '深入检查的模型调用上限',
  'settings.deepLimitHint': '每次深入检查最多调用 1 至 10 次模型，默认 3 次。',
  'settings.saveDeepLimit': '保存调用上限',
  'mode.local': '本地检查',
  'mode.localHint': '使用已确认的选择和分支规则，无需调用模型。',
  'mode.fast': '快速检查',
  'mode.fastHint': '调用一次模型，检查有限的候选 Context。',
  'mode.deep': '深入检查 Context Tree',
  'mode.deepHint': '使用 Agent 读取和检索完整的 Context Tree。',
  'action.moveDraftHere': '将草稿移到此分支',
  'policy.evidence': '最近的明确选择',
  'policy.emptyEvidence': '尚无已记录的明确选择。',
  'policy.reset': '重置已学习的偏好',
  'policy.resetHint': '停止使用重置前的选择来学习。保留原始记录和当前 Context Plan。',
  'policy.accept': '接受',
  'policy.reject': '拒绝',
  'policy.objective': '当时的任务',
  'policy.source': '记录来源',
  'policy.context': 'Context 项目',
  'policy.undone': '已撤销，不用于学习',
  'branch.mainline': '主线',
  'error.currentSession': '当前 Session 不可用',
  'error.emptyDraft': '请先写入草稿，再将其移到其他分支',
  'error.mapNotReady': 'Context Map 尚未准备就绪',
  'error.destinationChanged': '目标分支已变化或不可用',
  'error.draftTransfer': '草稿已变化，或目标分支无法接收它',
  'lifecycle.title': '分支任务状态建议',
  'lifecycle.hint': '这些建议只改变任务状态，不改变所选的 Context。',
  'lifecycle.keep': '保持当前状态',
  'lifecycle.open': '重新开启分支',
  'lifecycle.parked': '暂停分支',
  'lifecycle.completed': '完成分支',
} satisfies Record<string, string>

/** Typed Context Steward locale keys. */
export type StewardKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese source. */
export const en = {
  'action.reviewDraft': 'Review context for draft',
  'action.reviewingDraft': 'Reviewing context…',
  'action.draftReviewMode': 'Draft review mode',
  'action.localDraft': 'Local review for draft',
  'action.fastDraft': 'Fast review for draft',
  'action.deepDraft': 'Deep review for draft',
  'settings.deepLimit': 'Deep review model request limit',
  'settings.deepLimitHint': 'Allow 1–10 model requests per Deep review; the default is 3.',
  'settings.saveDeepLimit': 'Save request limit',
  'mode.local': 'Local review',
  'mode.localHint': 'Use confirmed choices and branch rules without a model call.',
  'mode.fast': 'Fast review',
  'mode.fastHint': 'Make one model call over a bounded set of likely candidates.',
  'mode.deep': 'Deep tree review',
  'mode.deepHint': 'Let the Agent read and search the complete Context Tree.',
  'action.moveDraftHere': 'Move draft here',
  'policy.evidence': 'Recent explicit choices',
  'policy.emptyEvidence': 'No recorded explicit choices yet.',
  'policy.reset': 'Reset learned preferences',
  'policy.resetHint': 'Stop learning from choices before this reset. Raw records and the current Context Plan stay available.',
  'policy.accept': 'Accepted',
  'policy.reject': 'Declined',
  'policy.objective': 'Task at the time',
  'policy.source': 'Record source',
  'policy.context': 'Context item',
  'policy.undone': 'Undone; excluded from learning',
  'branch.mainline': 'Mainline',
  'error.currentSession': 'The current Session is unavailable',
  'error.emptyDraft': 'Write a draft before moving to a branch',
  'error.mapNotReady': 'The Context Map is not ready',
  'error.destinationChanged': 'The destination branch changed or is unavailable',
  'error.draftTransfer': 'The draft changed or the destination cannot receive it',
  'lifecycle.title': 'Branch task state advice',
  'lifecycle.hint': 'These suggestions change task state only. Selected context stays the same.',
  'lifecycle.keep': 'Keep current state',
  'lifecycle.open': 'Reopen branch',
  'lifecycle.parked': 'Park branch',
  'lifecycle.completed': 'Complete branch',
} satisfies Record<StewardKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for explicit pre-send Context review. */
    contextifySteward: StewardKey
  }
}
