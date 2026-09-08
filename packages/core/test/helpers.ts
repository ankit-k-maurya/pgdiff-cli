import type { Column, Constraint, ConstraintKind, Snapshot, Table } from '../src/types.js'

export type ColumnSpec =
  | string
  | { type: string; notNull?: boolean; default?: string; enumRef?: string; identity?: 'ALWAYS' | 'BY DEFAULT' }

export interface TableSpec {
  columns: Record<string, ColumnSpec>
  constraints?: Record<string, { kind: ConstraintKind; definition: string; references?: string }>
  indexes?: Record<string, { definition: string; unique?: boolean }>
  comment?: string
}

export interface SnapshotSpec {
  enums?: Record<string, string[]>
  tables?: Record<string, TableSpec>
}

/** Terse snapshot builder so the tests read as schema definitions. */
export function snapshot(spec: SnapshotSpec): Snapshot {
  const result: Snapshot = { schemas: ['public'], enums: {}, tables: {} }

  for (const [key, values] of Object.entries(spec.enums ?? {})) {
    const [schema, name] = split(key)
    result.enums[key] = { schema, name, values }
  }

  for (const [key, table] of Object.entries(spec.tables ?? {})) {
    const [schema, name] = split(key)
    const built: Table = {
      schema,
      name,
      columns: {},
      columnOrder: [],
      constraints: {},
      indexes: {},
      comment: table.comment ?? null,
    }

    let position = 1
    for (const [columnName, columnSpec] of Object.entries(table.columns)) {
      const spec2 = typeof columnSpec === 'string' ? { type: columnSpec } : columnSpec
      const column: Column = {
        name: columnName,
        position: position++,
        type: spec2.type,
        notNull: spec2.notNull ?? false,
        default: spec2.default ?? null,
        identity: spec2.identity ?? null,
        enumRef: spec2.enumRef ?? null,
        collation: null,
        comment: null,
      }
      built.columns[columnName] = column
      built.columnOrder.push(columnName)
    }

    for (const [constraintName, constraint] of Object.entries(table.constraints ?? {})) {
      const built2: Constraint = {
        name: constraintName,
        kind: constraint.kind,
        definition: constraint.definition,
        references: constraint.references ?? null,
      }
      built.constraints[constraintName] = built2
    }

    for (const [indexName, index] of Object.entries(table.indexes ?? {})) {
      built.indexes[indexName] = {
        name: indexName,
        definition: index.definition,
        isUnique: index.unique ?? false,
      }
    }

    result.tables[key] = built
  }

  return result
}

function split(key: string): [string, string] {
  const idx = key.indexOf('.')
  return idx === -1 ? ['public', key] : [key.slice(0, idx), key.slice(idx + 1)]
}

/** Index of the first operation matching a predicate, or -1. */
export function indexOfKind(operations: { kind: string; object: string }[], kind: string, object?: string): number {
  return operations.findIndex((op) => op.kind === kind && (object === undefined || op.object === object))
}
