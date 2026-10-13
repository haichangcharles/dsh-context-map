/** Event-cursor reset for confirmed Context policy evidence, independent of wall-clock time. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyInspection } from './types.ts'

/** Merge explicit Profile reset cursors from owned logs.
 * @param inspections - Known native Session inspections.
 * @returns The maximum discarded event cursor for each Session.
 */
export function contextPolicyWatermarks(inspections: readonly ContextFamilyInspection[]): ReadonlyMap<SessionId, number> {
  const cursors = new Map<SessionId, number>()
  for (const inspection of inspections) {
    for (const event of inspection.events.slice(inspection.inheritedEventCount)) {
      if (event.type !== 'contextify/policy-reset' || event.data.uiOrigin !== 'contextify-client') continue
      for (const cursor of event.data.cursors) {
        cursors.set(cursor.sessionId, Math.max(cursors.get(cursor.sessionId) ?? -1, cursor.seq))
      }
    }
  }
  return cursors
}

/** Keep structural logs while discarding pre-reset preference events from a projection.
 * @param inspections - Native logs whose canonical messages and Plans remain unchanged.
 * @param watermarks - Discarded owned-event cursors across this Profile.
 * @returns Copies suitable for preference extraction; raw Session logs are untouched.
 */
export function currentPolicyInspections(
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
  watermarks: ReadonlyMap<SessionId, number>,
): ReadonlyMap<SessionId, ContextFamilyInspection> {
  const preferenceTypes = new Set(['contextify/node-choice', 'contextify/recommendation-reviewed',
    'contextify/recommendation-dismissed', 'contextify/branch-choice', 'contextify/route-choice',
    'contextify/manual-branch', 'contextify/manual-route', 'contextify/work-state-choice'])
  return new Map([...inspections].map(([id, inspection]) => {
    const cursor = watermarks.get(id) ?? -1
    // Preserve inherited indices: filtering the prefix would change ownership.
    const prefix = inspection.events.slice(0, inspection.inheritedEventCount)
    const owned = inspection.events.slice(inspection.inheritedEventCount).filter(event =>
      event.seq > cursor || !preferenceTypes.has(event.type))
    return [id, { ...inspection, events: [...prefix, ...owned] }]
  }))
}
