import {
  columnClause,
  createEnumStatement,
  createTableStatements,
  enumUsages,
  qualified,
  quoteIdent,
  quoteLiteral,
  rebuildEnumStatements,
  tableKey,
} from './ddl.js'
import { PHASE } from './phases.js'
import type {
  ChangeKind,
  Column,
  Constraint,
  Operation,
  Plan,
  Snapshot,
  Table,
} from './types.js'

export interface DiffOptions {
  /**
   * Emit `DROP TABLE` / `DROP COLUMN` operations. When false the plan keeps
   * objects that only exist in the source, which is the safe default for
   * production roll-outs.
   */
  allowDestructive?: boolean
}

class OperationBuilder {
  private seq = 0
  readonly operations: Operation[] = []
  readonly warnings: string[] = []

  add(op: Omit<Operation, 'id' | 'deps'> & { id?: string; deps?: string[] }): Operation {
    const operation: Operation = {
      ...op,
      id: op.id ?? `${op.kind}:${op.object}:${this.seq++}`,
      deps: op.deps ?? [],
    }
    this.operations.push(operation)
    return operation
  }
}

/** Compare two snapshots and produce an unordered set of operations. */
export function diffSnapshots(
  source: Snapshot,
  target: Snapshot,
  options: DiffOptions = {},
): Plan {
  const b = new OperationBuilder()

  diffSchemas(b, source, target)
  diffEnums(b, source, target)
  diffTables(b, source, target, options)

  return { operations: b.operations, warnings: b.warnings }
}

/* ------------------------------------------------------------------ schemas */

function schemasWithObjects(snapshot: Snapshot): Set<string> {
  const set = new Set<string>()
  for (const table of Object.values(snapshot.tables)) set.add(table.schema)
  for (const type of Object.values(snapshot.enums)) set.add(type.schema)
  return set
}

function diffSchemas(b: OperationBuilder, source: Snapshot, target: Snapshot): void {
  const before = schemasWithObjects(source)
  const after = schemasWithObjects(target)

  for (const schema of [...after].sort()) {
    if (before.has(schema) || schema === 'public') continue
    b.add({
      kind: 'create_schema',
      phase: PHASE.CREATE_SCHEMA,
      object: schema,
      summary: `create schema ${schema}`,
      up: [`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`],
      down: [`DROP SCHEMA IF EXISTS ${quoteIdent(schema)}`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }
}

/* -------------------------------------------------------------------- enums */

/**
 * Postgres can only append labels to an enum (`ALTER TYPE ... ADD VALUE`), and
 * even that cannot be used in the same transaction that reads the new label.
 * Anything else — dropping a label, reordering labels — needs the type rebuilt
 * and every dependent column swapped over.
 */
function diffEnums(b: OperationBuilder, source: Snapshot, target: Snapshot): void {
  for (const key of union(Object.keys(source.enums), Object.keys(target.enums))) {
    const before = source.enums[key]
    const after = target.enums[key]

    if (!before && after) {
      b.add({
        kind: 'create_enum',
        phase: PHASE.CREATE_ENUM,
        object: key,
        summary: `create enum ${key} (${after.values.join(', ')})`,
        up: [createEnumStatement(after)],
        down: [`DROP TYPE ${qualified(key)}`],
        destructive: false,
        lossy: false,
        transactional: true,
        warnings: [],
      })
      continue
    }

    if (before && !after) {
      b.add({
        kind: 'drop_enum',
        phase: PHASE.DROP_ENUM,
        object: key,
        summary: `drop enum ${key}`,
        up: [`DROP TYPE ${qualified(key)}`],
        down: [createEnumStatement(before)],
        destructive: true,
        lossy: false,
        transactional: true,
        warnings: [],
      })
      continue
    }

    if (!before || !after) continue
    if (sameValues(before.values, after.values)) continue

    // Labels the source already had, in the order the target keeps them. If that
    // matches the source exactly, nothing was removed or moved: pure appends.
    const retained = after.values.filter((v) => before.values.includes(v))
    const pureAddition = sameValues(retained, before.values)

    if (pureAddition) {
      const added = after.values.filter((v) => !before.values.includes(v))
      const up: string[] = []
      for (const value of added) {
        const index = after.values.indexOf(value)
        const anchor = index === 0 ? after.values[1] : after.values[index - 1]
        const position = index === 0 ? `BEFORE ${quoteLiteral(anchor)}` : `AFTER ${quoteLiteral(anchor)}`
        up.push(`ALTER TYPE ${qualified(key)} ADD VALUE ${quoteLiteral(value)} ${position}`)
      }
      b.add({
        kind: 'add_enum_value',
        phase: PHASE.ALTER_ENUM,
        object: key,
        summary: `add ${added.length} value(s) to enum ${key}: ${added.join(', ')}`,
        up,
        down: rebuildEnumStatements(key, before.values, enumUsages(source, key)),
        destructive: false,
        lossy: false,
        // ADD VALUE cannot be followed by a use of the new label in the same
        // transaction, so the whole migration is emitted unwrapped.
        transactional: false,
        warnings: [
          'ALTER TYPE ... ADD VALUE cannot run inside a transaction block that also uses the new label; this migration is emitted without BEGIN/COMMIT.',
          `Rolling back rewrites ${key}; rows still holding ${added.map((v) => `'${v}'`).join(', ')} will block the down migration.`,
        ],
      })
      continue
    }

    const removed = before.values.filter((v) => !after.values.includes(v))
    b.add({
      kind: 'rebuild_enum',
      phase: PHASE.ALTER_ENUM,
      object: key,
      summary:
        removed.length > 0
          ? `rebuild enum ${key} (removes ${removed.join(', ')})`
          : `rebuild enum ${key} (reorders labels)`,
      up: rebuildEnumStatements(key, after.values, enumUsages(source, key)),
      down: rebuildEnumStatements(key, before.values, enumUsages(source, key)),
      destructive: removed.length > 0,
      lossy: false,
      transactional: true,
      warnings:
        removed.length > 0
          ? [`Rows holding ${removed.map((v) => `'${v}'`).join(', ')} will fail the cast; migrate that data first.`]
          : [],
    })
  }
}

/* ------------------------------------------------------------------- tables */

function diffTables(
  b: OperationBuilder,
  source: Snapshot,
  target: Snapshot,
  options: DiffOptions,
): void {
  for (const key of union(Object.keys(source.tables), Object.keys(target.tables))) {
    const before = source.tables[key]
    const after = target.tables[key]

    if (!before && after) {
      createTable(b, after)
    } else if (before && !after) {
      dropTable(b, before, options)
    } else if (before && after) {
      alterTable(b, before, after, options)
    }
  }

  linkTableDependencies(b, source, target)
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
  const ids = new Set(b.operations.map((op) => op.id))
  const byId = new Map(b.operations.map((op) => [op.id, op]))

  for (const table of Object.values(target.tables)) {
    const op = byId.get(`create_table:${tableKey(table)}`)
    if (!op) continue
    for (const constraint of Object.values(table.constraints)) {
      if (constraint.kind !== 'f' || !constraint.references) continue
      const parent = `create_table:${constraint.references}`
      if (ids.has(parent) && parent !== op.id) op.deps.push(parent)
    }
  }

  for (const table of Object.values(source.tables)) {
    const childOp = byId.get(`drop_table:${tableKey(table)}`)
    if (!childOp) continue
    for (const constraint of Object.values(table.constraints)) {
      if (constraint.kind !== 'f' || !constraint.references) continue
      const parentOp = byId.get(`drop_table:${constraint.references}`)
      if (!parentOp || parentOp.id === childOp.id) continue
      parentOp.deps.push(childOp.id)
    }
  }
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
  for (const constraint of sorted(Object.values(table.constraints), (c) => c.name)) {
    if (constraint.kind !== 'f') continue
    addForeignKey(b, key, constraint)
  }
  for (const index of sorted(Object.values(table.indexes), (i) => i.name)) {
    createIndex(b, key, index.name, index.definition)
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
  for (const constraint of sorted(Object.values(table.constraints), (c) => c.name)) {
    if (constraint.kind !== 'f') continue
    dropForeignKey(b, key, constraint)
  }
  for (const index of sorted(Object.values(table.indexes), (i) => i.name)) {
    dropIndex(b, key, index.name, index.definition)
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
    b.add({
      kind: 'set_comment',
      phase: PHASE.COMMENT,
      object: key,
      summary: `set comment on ${key}`,
      up: [`COMMENT ON TABLE ${qualified(key)} IS ${after.comment === null ? 'NULL' : quoteLiteral(after.comment)}`],
      down: [`COMMENT ON TABLE ${qualified(key)} IS ${before.comment === null ? 'NULL' : quoteLiteral(before.comment)}`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }
}

/* ------------------------------------------------------------------ columns */

function diffColumns(
  b: OperationBuilder,
  key: string,
  beforeTable: Table,
  afterTable: Table,
  options: DiffOptions,
): void {
  for (const name of union(beforeTable.columnOrder, afterTable.columnOrder)) {
    const before = beforeTable.columns[name]
    const after = afterTable.columns[name]
    const col = `${qualified(key)}.${quoteIdent(name)}`

    if (!before && after) {
      const warnings: string[] = []
      if (after.notNull && after.default === null && !after.identity) {
        warnings.push(`Adding NOT NULL column ${col} without a default fails on a non-empty table.`)
      }
      b.add({
        kind: 'add_column',
        phase: PHASE.ADD_COLUMN,
        object: `${key}.${name}`,
        summary: `add column ${key}.${name} ${after.type}`,
        up: [
          `ALTER TABLE ${qualified(key)} ADD COLUMN ${columnClause(after)}`,
          ...(after.comment ? [`COMMENT ON COLUMN ${col} IS ${quoteLiteral(after.comment)}`] : []),
        ],
        down: [`ALTER TABLE ${qualified(key)} DROP COLUMN ${quoteIdent(name)}`],
        destructive: false,
        lossy: false,
        transactional: true,
        warnings,
      })
      continue
    }

    if (before && !after) {
      if (!options.allowDestructive) {
        b.warnings.push(`Skipped dropping column ${key}.${name} (destructive changes are disabled).`)
        continue
      }
      b.add({
        kind: 'drop_column',
        phase: PHASE.DROP_COLUMN,
        object: `${key}.${name}`,
        summary: `drop column ${key}.${name}`,
        up: [`ALTER TABLE ${qualified(key)} DROP COLUMN ${quoteIdent(name)}`],
        down: [
          `ALTER TABLE ${qualified(key)} ADD COLUMN ${columnClause(before)}`,
          ...(before.comment ? [`COMMENT ON COLUMN ${col} IS ${quoteLiteral(before.comment)}`] : []),
        ],
        destructive: true,
        lossy: true,
        transactional: true,
        warnings: [`Dropping ${key}.${name} destroys its values; the down migration restores the column empty.`],
      })
      continue
    }

    if (!before || !after) continue
    diffColumnAttributes(b, key, before, after)
  }
}

function diffColumnAttributes(b: OperationBuilder, key: string, before: Column, after: Column): void {
  const name = after.name
  const object = `${key}.${name}`
  const col = `${qualified(key)}.${quoteIdent(name)}`
  const alter = `ALTER TABLE ${qualified(key)} ALTER COLUMN ${quoteIdent(name)}`

  if (before.type !== after.type) {
    b.add({
      kind: 'alter_column_type',
      phase: PHASE.ALTER_COLUMN,
      object,
      summary: `alter ${object} type ${before.type} -> ${after.type}`,
      up: [`${alter} TYPE ${after.type} USING ${castExpression(name, before, after)}`],
      down: [`${alter} TYPE ${before.type} USING ${castExpression(name, after, before)}`],
      destructive: false,
      lossy: true,
      transactional: true,
      warnings: [`Type change on ${object} rewrites the table and may truncate or fail on existing values.`],
    })
  }

  if (before.default !== after.default) {
    const kind: ChangeKind = after.default === null ? 'drop_default' : 'set_default'
    b.add({
      kind,
      phase: PHASE.ALTER_COLUMN,
      object,
      summary: after.default === null ? `drop default on ${object}` : `set default on ${object}`,
      up: [after.default === null ? `${alter} DROP DEFAULT` : `${alter} SET DEFAULT ${after.default}`],
      down: [before.default === null ? `${alter} DROP DEFAULT` : `${alter} SET DEFAULT ${before.default}`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }

  if (before.notNull !== after.notNull) {
    b.add({
      kind: after.notNull ? 'set_not_null' : 'drop_not_null',
      phase: PHASE.ALTER_COLUMN,
      object,
      summary: `${after.notNull ? 'set' : 'drop'} NOT NULL on ${object}`,
      up: [`${alter} ${after.notNull ? 'SET' : 'DROP'} NOT NULL`],
      down: [`${alter} ${before.notNull ? 'SET' : 'DROP'} NOT NULL`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: after.notNull ? [`Existing NULLs in ${object} will block SET NOT NULL.`] : [],
    })
  }

  if (before.identity !== after.identity) {
    b.add({
      kind: after.identity ? 'add_identity' : 'drop_identity',
      phase: PHASE.ALTER_COLUMN,
      object,
      summary: `${after.identity ? 'add' : 'drop'} identity on ${object}`,
      up: [
        after.identity
          ? `${alter} ADD GENERATED ${after.identity} AS IDENTITY`
          : `${alter} DROP IDENTITY`,
      ],
      down: [
        before.identity
          ? `${alter} ADD GENERATED ${before.identity} AS IDENTITY`
          : `${alter} DROP IDENTITY`,
      ],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }

  if (before.comment !== after.comment) {
    b.add({
      kind: 'set_comment',
      phase: PHASE.COMMENT,
      object,
      summary: `set comment on ${object}`,
      up: [`COMMENT ON COLUMN ${col} IS ${after.comment === null ? 'NULL' : quoteLiteral(after.comment)}`],
      down: [`COMMENT ON COLUMN ${col} IS ${before.comment === null ? 'NULL' : quoteLiteral(before.comment)}`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }
}

/** Enums only cast through text, so route any enum-involved change that way. */
function castExpression(name: string, from: Column, to: Column): string {
  const ident = quoteIdent(name)
  const viaText = from.enumRef !== null || to.enumRef !== null
  const suffix = to.type.endsWith('[]') ? '[]' : ''
  return viaText ? `${ident}::text${suffix}::${to.type}` : `${ident}::${to.type}`
}

/* -------------------------------------------------------------- constraints */

function diffConstraints(b: OperationBuilder, key: string, before: Table, after: Table): void {
  for (const name of union(Object.keys(before.constraints), Object.keys(after.constraints))) {
    const from = before.constraints[name]
    const to = after.constraints[name]

    if (from && to && from.definition === to.definition) continue
    // A changed definition is a drop plus an add; the phases put the drop first.
    if (from) from.kind === 'f' ? dropForeignKey(b, key, from) : dropConstraint(b, key, from)
    if (to) to.kind === 'f' ? addForeignKey(b, key, to) : addConstraint(b, key, to)
  }
}

function addConstraint(b: OperationBuilder, key: string, constraint: Constraint): void {
  b.add({
    kind: 'add_constraint',
    phase: PHASE.ADD_CONSTRAINT,
    object: `${key}.${constraint.name}`,
    summary: `add constraint ${constraint.name} on ${key}`,
    up: [`ALTER TABLE ${qualified(key)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`],
    down: [`ALTER TABLE ${qualified(key)} DROP CONSTRAINT ${quoteIdent(constraint.name)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [`Existing rows must already satisfy ${constraint.name}.`],
  })
}

function dropConstraint(b: OperationBuilder, key: string, constraint: Constraint): void {
  b.add({
    kind: 'drop_constraint',
    phase: PHASE.DROP_CONSTRAINT,
    object: `${key}.${constraint.name}`,
    summary: `drop constraint ${constraint.name} on ${key}`,
    up: [`ALTER TABLE ${qualified(key)} DROP CONSTRAINT ${quoteIdent(constraint.name)}`],
    down: [`ALTER TABLE ${qualified(key)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

function addForeignKey(b: OperationBuilder, key: string, constraint: Constraint): void {
  b.add({
    kind: 'add_foreign_key',
    phase: PHASE.ADD_FK,
    object: `${key}.${constraint.name}`,
    summary: `add foreign key ${constraint.name} on ${key} -> ${constraint.references ?? '?'}`,
    up: [`ALTER TABLE ${qualified(key)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`],
    down: [`ALTER TABLE ${qualified(key)} DROP CONSTRAINT ${quoteIdent(constraint.name)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
    deps: constraint.references ? [`create_table:${constraint.references}`] : [],
  })
}

function dropForeignKey(b: OperationBuilder, key: string, constraint: Constraint): void {
  b.add({
    kind: 'drop_foreign_key',
    phase: PHASE.DROP_FK,
    object: `${key}.${constraint.name}`,
    summary: `drop foreign key ${constraint.name} on ${key}`,
    up: [`ALTER TABLE ${qualified(key)} DROP CONSTRAINT ${quoteIdent(constraint.name)}`],
    down: [`ALTER TABLE ${qualified(key)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

/* ------------------------------------------------------------------ indexes */

function diffIndexes(b: OperationBuilder, key: string, before: Table, after: Table): void {
  for (const name of union(Object.keys(before.indexes), Object.keys(after.indexes))) {
    const from = before.indexes[name]
    const to = after.indexes[name]
    if (from && to && from.definition === to.definition) continue
    if (from) dropIndex(b, key, name, from.definition)
    if (to) createIndex(b, key, name, to.definition)
  }
}

function createIndex(b: OperationBuilder, key: string, name: string, definition: string): void {
  const [schema] = key.split('.')
  b.add({
    kind: 'create_index',
    phase: PHASE.CREATE_INDEX,
    object: `${key}.${name}`,
    summary: `create index ${name} on ${key}`,
    up: [definition],
    down: [`DROP INDEX ${qualified(`${schema}.${name}`)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

function dropIndex(b: OperationBuilder, key: string, name: string, definition: string): void {
  const [schema] = key.split('.')
  b.add({
    kind: 'drop_index',
    phase: PHASE.DROP_INDEX,
    object: `${key}.${name}`,
    summary: `drop index ${name} on ${key}`,
    up: [`DROP INDEX ${qualified(`${schema}.${name}`)}`],
    down: [definition],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

/* ------------------------------------------------------------------- utils */

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort()
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sorted<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((x, y) => keyOf(x).localeCompare(keyOf(y)))
}
