import type { ContextNodeMode } from './ContextMapNode.tsx'

/** Point in canvas-local screen coordinates. */
export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

/** Rectangle in canvas-local screen coordinates. */
export interface CanvasRect extends CanvasPoint {
  readonly width: number
  readonly height: number
}

/** React Flow position signal narrowed to the fields the viewing layer owns. */
export interface CanvasPositionChange {
  readonly id: string
  readonly position: CanvasPoint
  readonly dragging: boolean
}

/** Final coordinate ready for the persisted viewing store. */
export interface CommittedCanvasPosition {
  readonly id: string
  readonly position: CanvasPoint
}

/**
 * Resolve whether a graph message enters the effective model context.
 *
 * @param active - Whether the message belongs to the active Session path.
 * @param mode - The persisted Harness Context Plan mode.
 * @returns `true` when the message should enter the next model request.
 */
export function effectiveContextIncluded(active: boolean, mode: ContextNodeMode): boolean {
  if (mode === 'include') return true
  if (mode === 'exclude') return false
  return active
}

/**
 * Translate a checkbox result back to the smallest native Harness override.
 *
 * Selecting the automatic path-derived result removes any manual override.
 *
 * @param active - Whether the message belongs to the active Session path.
 * @param included - The effective result requested by the user.
 * @returns `natural` for the automatic result, otherwise `include` or `exclude`.
 */
export function modeForEffectiveContext(active: boolean, included: boolean): ContextNodeMode {
  if (included === active) return 'natural'
  return included ? 'include' : 'exclude'
}

/**
 * Determine whether two closed rectangles overlap, including a shared boundary.
 *
 * @param a - The first rectangle.
 * @param b - The second rectangle.
 * @returns `true` when the rectangles overlap.
 */
export function intersects(a: CanvasRect, b: CanvasRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y
}

/**
 * Apply live drag coordinates and separate final coordinates for persistence.
 *
 * @param current - Current transient positions keyed by graph node ID.
 * @param changes - React Flow position changes received in this frame.
 * @returns Updated transient coordinates and completed positions to persist.
 */
export function reducePositionChanges(
  current: Readonly<Record<string, CanvasPoint>>,
  changes: readonly CanvasPositionChange[],
): { transient: Record<string, CanvasPoint>; committed: CommittedCanvasPosition[] } {
  let transient = { ...current }
  const committed: CommittedCanvasPosition[] = []
  for (const change of changes) {
    if (change.dragging) {
      transient[change.id] = change.position
      continue
    }
    transient = Object.fromEntries(Object.entries(transient).filter(([id]) => id !== change.id))
    committed.push({ id: change.id, position: change.position })
  }
  return { transient, committed }
}
