import { qualified, splitKey } from '../ddl.js'
import { PHASE } from '../phases.js'
import type { Index, Table } from '../types.js'
import { union, type OperationBuilder } from './builder.js'

export function diffIndexes(b: OperationBuilder, key: string, before: Table, after: Table): void {
  for (const name of union(Object.keys(before.indexes), Object.keys(after.indexes))) {
    const from = before.indexes[name]
    const to = after.indexes[name]
    if (from && to && from.definition === to.definition) continue
    if (from) dropIndex(b, key, from)
    if (to) createIndex(b, key, to)
  }
}

export function createIndex(b: OperationBuilder, key: string, index: Index): void {
  b.add({
    kind: 'create_index',
    phase: PHASE.CREATE_INDEX,
    object: `${key}.${index.name}`,
    summary: `create index ${index.name} on ${key}`,
    // `pg_get_indexdef` already produces a complete CREATE INDEX statement.
    up: [index.definition],
    down: [dropStatement(key, index)],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

export function dropIndex(b: OperationBuilder, key: string, index: Index): void {
  b.add({
    kind: 'drop_index',
    phase: PHASE.DROP_INDEX,
    object: `${key}.${index.name}`,
    summary: `drop index ${index.name} on ${key}`,
    up: [dropStatement(key, index)],
    down: [index.definition],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

/** An index lives in its table's schema, but is named independently of it. */
function dropStatement(tableKeyName: string, index: Index): string {
  const [schema] = splitKey(tableKeyName)
  return `DROP INDEX ${qualified(`${schema}.${index.name}`)}`
}
