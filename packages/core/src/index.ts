/**
 * The planner: everything that turns two snapshots into a migration.
 *
 * Nothing reachable from here touches a database or imports `pg`, so this entry
 * point is safe to bundle for a browser. Reading a snapshot from a live server
 * lives behind the `@pgdiff/core/introspect` subpath instead.
 */
export * from './types.js'
export * from './phases.js'
export * from './ddl.js'
export * from './diff/index.js'
export * from './plan.js'

import { diffSnapshots, type DiffOptions } from './diff/index.js'
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
