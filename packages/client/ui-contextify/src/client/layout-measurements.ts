/** Stable reconciliation of renderer-measured Context Map card bounds. */
import type { NodeChange } from '@xyflow/react'
import type { ContextMapNodeSizes, ContextMapNodeSize } from './layout.ts'

const MEASUREMENT_EPSILON = 1

function roundToHalfPixel(value: number): number {
  return Math.round(value * 2) / 2
}

function validSize(width: number, height: number): ContextMapNodeSize | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width: roundToHalfPixel(width), height: roundToHalfPixel(height) }
}

/**
 * Fold React Flow dimension notifications without publishing measurement noise.
 * @param current - Previously accepted normalized measurements.
 * @param changes - React Flow changes that may contain new rendered dimensions.
 * @returns The original table when equivalent, or a new table with meaningful measurements.
 */
export function reduceMeasuredSizes(
  current: ContextMapNodeSizes,
  changes: readonly NodeChange[],
): ContextMapNodeSizes {
  let next: Record<string, ContextMapNodeSize> | undefined
  for (const change of changes) {
    if (change.type !== 'dimensions' || change.dimensions === undefined) continue
    const size = validSize(change.dimensions.width, change.dimensions.height)
    if (size === undefined) continue
    const previous = (next ?? current)[change.id]
    if (previous !== undefined
      && Math.abs(previous.width - size.width) < MEASUREMENT_EPSILON
      && Math.abs(previous.height - size.height) < MEASUREMENT_EPSILON) continue
    next ??= { ...current }
    next[change.id] = size
  }
  return next ?? current
}

/**
 * Drop measurements for nodes removed by graph projection or archive filtering.
 * @param current - Previously accepted normalized measurements.
 * @param nodeIds - Canonical node IDs still visible in the current projection.
 * @returns The original table when unchanged, or a filtered measurement table.
 */
export function reconcileMeasuredSizes(
  current: ContextMapNodeSizes,
  nodeIds: readonly string[],
): ContextMapNodeSizes {
  const retained = new Set(nodeIds)
  if (Object.keys(current).every(id => retained.has(id))) return current
  return Object.fromEntries(Object.entries(current).filter(([id]) => retained.has(id)))
}
