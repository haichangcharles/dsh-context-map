/** Stable native-details host for the Trajectory Inspector portal. */

import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import css from './TrajectoryInspectorSeat.module.css'

/** Derive one collision-free Inspector host id from its Session scope. */
export function trajectoryInspectorHostId(sessionId: SessionId): string {
  return `dsh-trajectory-inspector-${sessionId}`
}

/** Injected face supplied by the session-scoped slot registration. */
export interface TrajectoryInspectorSeatProps {
  hostId: string
}

/** Render the stable element that receives TrajectoryTable's native Inspector. */
export function TrajectoryInspectorSeat({ hostId }: TrajectoryInspectorSeatProps) {
  return <div id={hostId} className={css.root} data-trajectory-inspector-host="" />
}
