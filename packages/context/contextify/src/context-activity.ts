import type { ContextPolicyObservation } from './types.ts'

/**
 * A deliberately narrow task-mode cue from the user's current objective.
 * It is a routing feature, not a claim about the user's stable identity. When
 * an objective only mentions an activity in passing, we leave it unclassified
 * and let the policy back off to global evidence.
 */
export function contextActivityFromObjective(
  objective: string,
): ContextPolicyObservation['activity'] | undefined {
  const text = objective.trim().toLocaleLowerCase()
    .replace(/^(?:new (?:topic|task|thread|branch)|separate (?:topic|task))\s*[:：]\s*|^(?:另起(?:一个)?(?:话题|任务|分支)|新(?:话题|任务))\s*[:：]\s*/u, '')
    .replace(/^(?:please|let's|help me|continue|resume|now)\s+|^(?:请|帮我|继续|现在)/u, '')
  const cues = [
    { activity: 'planning' as const,
      pattern: /^(?:plan|planning|schedule|outline|map out)\b|^(?:规划|计划|安排)/u },
    { activity: 'writing' as const,
      pattern: /^(?:write|writing|draft|drafting|revise|edit|polish)\b|^(?:写|撰写|起草|修改|润色)/u },
    { activity: 'brainstorming' as const,
      pattern: /^(?:brainstorm|ideate|generate ideas)\b|^(?:头脑风暴|发散|想点子)/u },
  ]
  return cues.find(cue => cue.pattern.test(text))?.activity
}
