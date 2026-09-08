import type { Column, EnumType, Snapshot, Table } from './types.js'

/** Words that must be quoted even though they look like plain identifiers. */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime',
  'localtimestamp', 'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning', 'right', 'select',
  'session_user', 'similar', 'some', 'symmetric', 'table', 'tablesample', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when', 'where', 'window',
  'with',
])

const PLAIN_IDENT = /^[a-z_][a-z0-9_$]*$/

export function quoteIdent(name: string): string {
  if (PLAIN_IDENT.test(name) && !RESERVED.has(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `schema.table` -> `schema.table` with each part quoted as needed. */
export function qualified(key: string): string {
  const idx = key.indexOf('.')
  if (idx === -1) return quoteIdent(key)
  return `${quoteIdent(key.slice(0, idx))}.${quoteIdent(key.slice(idx + 1))}`
}

export function tableKey(table: Pick<Table, 'schema' | 'name'>): string {
  return `${table.schema}.${table.name}`
}

export function enumKey(type: Pick<EnumType, 'schema' | 'name'>): string {
  return `${type.schema}.${type.name}`
}

/** The column clause used inside CREATE TABLE and ADD COLUMN. */
export function columnClause(column: Column): string {
  const parts = [quoteIdent(column.name), column.type]
  if (column.collation) parts.push(`COLLATE ${quoteIdent(column.collation)}`)
  if (column.identity) parts.push(`GENERATED ${column.identity} AS IDENTITY`)
  if (column.notNull) parts.push('NOT NULL')
  if (column.default !== null && !column.identity) parts.push(`DEFAULT ${column.default}`)
  return parts.join(' ')
}

export function createTableStatements(table: Table): string[] {
  const body: string[] = table.columnOrder.map((name) => columnClause(table.columns[name]))

  // Primary keys, uniques and checks read better inline; foreign keys are always
  // emitted separately so the planner can order them after every table exists.
  for (const constraint of Object.values(table.constraints)) {
    if (constraint.kind === 'f') continue
    body.push(`CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`)
  }

  const statements = [
    `CREATE TABLE ${qualified(tableKey(table))} (\n  ${body.join(',\n  ')}\n)`,
  ]

  if (table.comment) {
    statements.push(
      `COMMENT ON TABLE ${qualified(tableKey(table))} IS ${quoteLiteral(table.comment)}`,
    )
  }
  for (const name of table.columnOrder) {
    const column = table.columns[name]
    if (!column.comment) continue
    statements.push(
      `COMMENT ON COLUMN ${qualified(tableKey(table))}.${quoteIdent(name)} IS ${quoteLiteral(column.comment)}`,
    )
  }
  return statements
}

export function createEnumStatement(type: EnumType): string {
  const values = type.values.map(quoteLiteral).join(', ')
  return `CREATE TYPE ${qualified(enumKey(type))} AS ENUM (${values})`
}

export interface EnumUsage {
  table: string
  column: string
  /** True for `mood[]`-style columns, which need an array cast on rebuild. */
  isArray: boolean
  default: string | null
  notNull: boolean
}

/** Every column in the snapshot whose type is `key` (or an array of it). */
export function enumUsages(snapshot: Snapshot, key: string): EnumUsage[] {
  const usages: EnumUsage[] = []
  for (const table of Object.values(snapshot.tables)) {
    for (const name of table.columnOrder) {
      const column = table.columns[name]
      if (column.enumRef !== key) continue
      usages.push({
        table: tableKey(table),
        column: name,
        isArray: column.type.endsWith('[]'),
        default: column.default,
        notNull: column.notNull,
      })
    }
  }
  return usages
}

/**
 * Rewrite an enum type to an exact list of values.
 *
 * Postgres has no `ALTER TYPE ... DROP VALUE`, so removing or reordering labels
 * means building a new type and swapping every dependent column onto it. The old
 * type is renamed first so the new one can take its name, which keeps the change
 * invisible to anything referring to the type by name.
 */
export function rebuildEnumStatements(
  key: string,
  values: string[],
  usages: EnumUsage[],
): string[] {
  const [schema, name] = splitKey(key)
  const shadow = `${name}__pgdiff_old`
  const shadowKey = `${schema}.${shadow}`
  const statements: string[] = [
    `ALTER TYPE ${qualified(key)} RENAME TO ${quoteIdent(shadow)}`,
    createEnumStatement({ schema, name, values }),
  ]

  for (const usage of usages) {
    const target = usage.isArray ? `${qualified(key)}[]` : qualified(key)
    const cast = usage.isArray ? 'text[]' : 'text'
    // The default has to come off first: it is still typed as the old enum and
    // would block the type swap.
    if (usage.default !== null) {
      statements.push(`ALTER TABLE ${qualified(usage.table)} ALTER COLUMN ${quoteIdent(usage.column)} DROP DEFAULT`)
    }
    statements.push(
      `ALTER TABLE ${qualified(usage.table)} ALTER COLUMN ${quoteIdent(usage.column)} ` +
        `TYPE ${target} USING ${quoteIdent(usage.column)}::${cast}::${target}`,
    )
    if (usage.default !== null) {
      statements.push(
        `ALTER TABLE ${qualified(usage.table)} ALTER COLUMN ${quoteIdent(usage.column)} SET DEFAULT ${usage.default}`,
      )
    }
  }

  statements.push(`DROP TYPE ${qualified(shadowKey)}`)
  return statements
}

export function splitKey(key: string): [string, string] {
  const idx = key.indexOf('.')
  if (idx === -1) return ['public', key]
  return [key.slice(0, idx), key.slice(idx + 1)]
}
