import type { Plan, Snapshot } from '../types.js'
import { OperationBuilder, type DiffOptions } from './builder.js'
import { diffSchemas } from './schemas.js'
import { diffTables } from './tables.js'

export type { DiffOptions } from './builder.js'

/**
 * Compare two snapshots and produce an unordered set of operations.
 *
 * Each object kind is diffed on its own; nothing here decides execution order.
 * Operations carry the phase and dependency edges that `orderPlan` sorts by,
 * which keeps "what changed" separate from "in what order it must run".
 */
export function diffSnapshots(
  source: Snapshot,
  target: Snapshot,
  options: DiffOptions = {},
): Plan {
  const b = new OperationBuilder()

  diffSchemas(b, source, target)
  diffTables(b, source, target, options)

  return { operations: b.operations, warnings: b.warnings }
}
