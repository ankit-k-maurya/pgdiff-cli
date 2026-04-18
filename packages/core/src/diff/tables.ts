import { commentStatement, createTableStatements, qualified, tableKey } from '../ddl.js'
import { PHASE } from '../phases.js'
import type { Snapshot, Table } from '../types.js'
import { sortedByName, union, type DiffOptions, type OperationBuilder } from './builder.js'
import { diffColumns } from './columns.js'
import { addConstraintOrKey, diffConstraints, dropConstraintOrKey } from './constraints.js'
import { createIndex, diffIndexes, dropIndex } from './indexes.js'

export function diffTables(
  b: OperationBuilder,
  source: Snapshot,
  target: Snapshot,
  options: DiffOptions,
): void {
  for (const key of union(Object.keys(source.tables), Object.keys(target.tables))) {
    const before = source.tables[key]
    const after = target.tables[key]

    if (!before && after) createTable(b, after)
    else if (before && !after) dropTable(b, before, options)
    else if (before && after) alterTable(b, before, after, options)
  }

  linkTableDependencies(b, source, target)
}

function createTable(b: OperationBuilder, table: Table): void {
  const key = tableKey(table)
  b.add({
    id: `create_table:${key}`,
    kind: 'create_table',
    phase: PHASE.CREATE_TABLE,
    object: key,
    summary: `create table ${key}`,
    up: createTableStatements(table),
    down: [`DROP TABLE ${qualified(key)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })

  // Foreign keys and indexes are separate operations so they can be ordered
  // after every table in the batch exists.
  for (const constraint of sortedByName(Object.values(table.constraints))) {
    if (constraint.kind === 'f') addConstraintOrKey(b, key, constraint)
  }
  for (const index of sortedByName(Object.values(table.indexes))) {
    createIndex(b, key, index)
  }
}

function dropTable(b: OperationBuilder, table: Table, options: DiffOptions): void {
  const key = tableKey(table)
  if (!options.allowDestructive) {
    b.warnings.push(`Skipped dropping table ${key} (destructive changes are disabled).`)
    return
  }

  // Break references and indexes first; reversing the plan then recreates the
  // table before anything points back at it.
  for (const constraint of sortedByName(Object.values(table.constraints))) {
    if (constraint.kind === 'f') dropConstraintOrKey(b, key, constraint)
  }
  for (const index of sortedByName(Object.values(table.indexes))) {
    dropIndex(b, key, index)
  }

  b.add({
    id: `drop_table:${key}`,
    kind: 'drop_table',
    phase: PHASE.DROP_TABLE,
    object: key,
    summary: `drop table ${key}`,
    up: [`DROP TABLE ${qualified(key)}`],
    down: createTableStatements(table),
    destructive: true,
    lossy: true,
    transactional: true,
    warnings: [`Dropping ${key} destroys its rows; the down migration restores the structure only.`],
  })
}

function alterTable(b: OperationBuilder, before: Table, after: Table, options: DiffOptions): void {
  const key = tableKey(after)

  diffColumns(b, key, before, after, options)
  diffConstraints(b, key, before, after)
  diffIndexes(b, key, before, after)

  if (before.comment !== after.comment) {
    const target = `TABLE ${qualified(key)}`
    b.add({
      kind: 'set_comment',
      phase: PHASE.COMMENT,
      object: key,
      summary: `set comment on ${key}`,
      up: [commentStatement(target, after.comment)],
      down: [commentStatement(target, before.comment)],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }
}

/**
 * Record the foreign-key graph between tables that are created or dropped in
 * the same migration: parents are created before children, and children are
 * dropped before parents. Foreign keys are separate statements, so this is not
 * strictly required for correctness — it is what makes the emitted SQL read in
 * dependency order, and it keeps the plan valid if the constraints are ever
 * folded back into CREATE TABLE.
 */
function linkTableDependencies(b: OperationBuilder, source: Snapshot, target: Snapshot): void {
  const byId = new Map(b.operations.map((op) => [op.id, op]))

  for (const table of Object.values(target.tables)) {
    const child = byId.get(`create_table:${tableKey(table)}`)
    if (!child) continue
    for (const parentKey of referencedTables(table)) {
      const parent = byId.get(`create_table:${parentKey}`)
      if (parent && parent !== child) child.deps.push(parent.id)
    }
  }

  for (const table of Object.values(source.tables)) {
    const child = byId.get(`drop_table:${tableKey(table)}`)
    if (!child) continue
    for (const parentKey of referencedTables(table)) {
      const parent = byId.get(`drop_table:${parentKey}`)
      if (parent && parent !== child) parent.deps.push(child.id)
    }
  }
}

/** The tables this one points at through a foreign key. */
function referencedTables(table: Table): string[] {
  const keys: string[] = []
  for (const constraint of Object.values(table.constraints)) {
    if (constraint.kind === 'f' && constraint.references) keys.push(constraint.references)
  }
  return keys
}
