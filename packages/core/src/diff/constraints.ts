import { qualified, quoteIdent } from '../ddl.js'
import { PHASE } from '../phases.js'
import type { Constraint, Table } from '../types.js'
import { union, type OperationBuilder } from './builder.js'

export function diffConstraints(b: OperationBuilder, key: string, before: Table, after: Table): void {
  for (const name of union(Object.keys(before.constraints), Object.keys(after.constraints))) {
    const from = before.constraints[name]
    const to = after.constraints[name]

    if (from && to && from.definition === to.definition) continue
    // A changed definition is a drop plus an add; the phases put the drop first.
    if (from) dropConstraintOrKey(b, key, from)
    if (to) addConstraintOrKey(b, key, to)
  }
}

/**
 * Foreign keys are the same DDL as any other constraint but land in their own
 * phases, so they are torn down before the tables they point at and rebuilt only
 * once every table exists.
 */
export function addConstraintOrKey(b: OperationBuilder, key: string, constraint: Constraint): void {
  const isForeignKey = constraint.kind === 'f'
  b.add({
    kind: isForeignKey ? 'add_foreign_key' : 'add_constraint',
    phase: isForeignKey ? PHASE.ADD_FK : PHASE.ADD_CONSTRAINT,
    object: `${key}.${constraint.name}`,
    summary: isForeignKey
      ? `add foreign key ${constraint.name} on ${key} -> ${constraint.references ?? '?'}`
      : `add constraint ${constraint.name} on ${key}`,
    up: [addStatement(key, constraint)],
    down: [dropStatement(key, constraint)],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: isForeignKey ? [] : [`Existing rows must already satisfy ${constraint.name}.`],
    deps: isForeignKey && constraint.references ? [`create_table:${constraint.references}`] : [],
  })
}

export function dropConstraintOrKey(b: OperationBuilder, key: string, constraint: Constraint): void {
  const isForeignKey = constraint.kind === 'f'
  b.add({
    kind: isForeignKey ? 'drop_foreign_key' : 'drop_constraint',
    phase: isForeignKey ? PHASE.DROP_FK : PHASE.DROP_CONSTRAINT,
    object: `${key}.${constraint.name}`,
    summary: isForeignKey
      ? `drop foreign key ${constraint.name} on ${key}`
      : `drop constraint ${constraint.name} on ${key}`,
    up: [dropStatement(key, constraint)],
    down: [addStatement(key, constraint)],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

function addStatement(key: string, constraint: Constraint): string {
  return `ALTER TABLE ${qualified(key)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`
}

function dropStatement(key: string, constraint: Constraint): string {
  return `ALTER TABLE ${qualified(key)} DROP CONSTRAINT ${quoteIdent(constraint.name)}`
}
