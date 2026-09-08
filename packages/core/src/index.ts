export * from './types.js'
export * from './phases.js'
export * from './ddl.js'
export * from './diff.js'
export * from './plan.js'
export * from './introspect.js'

import { diffSnapshots, type DiffOptions } from './diff.js'
import { orderPlan, renderMigration } from './plan.js'
import type { Migration, MigrationOptions, Plan, Snapshot } from './types.js'

/** Diff two snapshots and return an ordered plan. */
export function createPlan(source: Snapshot, target: Snapshot, options: DiffOptions = {}): Plan {
  return orderPlan(diffSnapshots(source, target, options))
}

/** Diff two snapshots and render the up/down SQL pair. */
export function createMigration(
  source: Snapshot,
  target: Snapshot,
  options: DiffOptions & MigrationOptions = {},
): Migration {
  return renderMigration(createPlan(source, target, options), options)
}
