import { columnClause, columnRef, commentStatement, qualified, quoteIdent } from '../ddl.js'
import { PHASE } from '../phases.js'
import type { ChangeKind, Column, Table } from '../types.js'
import { union, type DiffOptions, type OperationBuilder } from './builder.js'

export function diffColumns(
  b: OperationBuilder,
  key: string,
  beforeTable: Table,
  afterTable: Table,
  options: DiffOptions,
): void {
  for (const name of union(beforeTable.columnOrder, afterTable.columnOrder)) {
    const before = beforeTable.columns[name]
    const after = afterTable.columns[name]

    if (!before && after) addColumn(b, key, after)
    else if (before && !after) dropColumn(b, key, before, options)
    else if (before && after) diffColumnAttributes(b, key, before, after)
  }
}

function addColumn(b: OperationBuilder, key: string, column: Column): void {
  const object = `${key}.${column.name}`
  const ref = columnRef(key, column.name)

  b.add({
    kind: 'add_column',
    phase: PHASE.ADD_COLUMN,
    object,
    summary: `add column ${object} ${column.type}`,
    up: [
      `ALTER TABLE ${qualified(key)} ADD COLUMN ${columnClause(column)}`,
      ...(column.comment ? [commentStatement(`COLUMN ${ref}`, column.comment)] : []),
    ],
    down: [`ALTER TABLE ${qualified(key)} DROP COLUMN ${quoteIdent(column.name)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings:
      column.notNull && column.default === null && !column.identity
        ? [`Adding NOT NULL column ${ref} without a default fails on a non-empty table.`]
        : [],
  })
}

function dropColumn(b: OperationBuilder, key: string, column: Column, options: DiffOptions): void {
  const object = `${key}.${column.name}`
  if (!options.allowDestructive) {
    b.warnings.push(`Skipped dropping column ${object} (destructive changes are disabled).`)
    return
  }

  const ref = columnRef(key, column.name)
  b.add({
    kind: 'drop_column',
    phase: PHASE.DROP_COLUMN,
    object,
    summary: `drop column ${object}`,
    up: [`ALTER TABLE ${qualified(key)} DROP COLUMN ${quoteIdent(column.name)}`],
    down: [
      `ALTER TABLE ${qualified(key)} ADD COLUMN ${columnClause(column)}`,
      ...(column.comment ? [commentStatement(`COLUMN ${ref}`, column.comment)] : []),
    ],
    destructive: true,
    lossy: true,
    transactional: true,
    warnings: [`Dropping ${object} destroys its values; the down migration restores the column empty.`],
  })
}

/**
 * A column present on both sides can differ in several ways at once. Each
 * difference becomes its own operation rather than one combined `ALTER COLUMN`,
 * which is what keeps every step individually reversible.
 */
function diffColumnAttributes(b: OperationBuilder, key: string, before: Column, after: Column): void {
  const name = after.name
  const object = `${key}.${name}`
  const alter = `ALTER TABLE ${qualified(key)} ALTER COLUMN ${quoteIdent(name)}`

  /** The changes below differ only in kind, summary and their statement pair. */
  const change = (
    kind: ChangeKind,
    phase: number,
    summary: string,
    up: string,
    down: string,
    extra: { lossy?: boolean; warnings?: string[] } = {},
  ) =>
    b.add({
      kind,
      phase,
      object,
      summary,
      up: [up],
      down: [down],
      destructive: false,
      lossy: extra.lossy ?? false,
      transactional: true,
      warnings: extra.warnings ?? [],
    })

  if (before.type !== after.type) {
    change(
      'alter_column_type',
      PHASE.ALTER_COLUMN,
      `alter ${object} type ${before.type} -> ${after.type}`,
      `${alter} TYPE ${after.type} USING ${castExpression(name, before, after)}`,
      `${alter} TYPE ${before.type} USING ${castExpression(name, after, before)}`,
      {
        lossy: true,
        warnings: [`Type change on ${object} rewrites the table and may truncate or fail on existing values.`],
      },
    )
  }

  if (before.default !== after.default) {
    const setDefault = (value: string | null) =>
      value === null ? `${alter} DROP DEFAULT` : `${alter} SET DEFAULT ${value}`
    change(
      after.default === null ? 'drop_default' : 'set_default',
      PHASE.ALTER_COLUMN,
      `${after.default === null ? 'drop' : 'set'} default on ${object}`,
      setDefault(after.default),
      setDefault(before.default),
    )
  }

  if (before.notNull !== after.notNull) {
    change(
      after.notNull ? 'set_not_null' : 'drop_not_null',
      PHASE.ALTER_COLUMN,
      `${after.notNull ? 'set' : 'drop'} NOT NULL on ${object}`,
      `${alter} ${after.notNull ? 'SET' : 'DROP'} NOT NULL`,
      `${alter} ${before.notNull ? 'SET' : 'DROP'} NOT NULL`,
      { warnings: after.notNull ? [`Existing NULLs in ${object} will block SET NOT NULL.`] : [] },
    )
  }

  if (before.identity !== after.identity) {
    const setIdentity = (value: Column['identity']) =>
      value ? `${alter} ADD GENERATED ${value} AS IDENTITY` : `${alter} DROP IDENTITY`
    change(
      after.identity ? 'add_identity' : 'drop_identity',
      PHASE.ALTER_COLUMN,
      `${after.identity ? 'add' : 'drop'} identity on ${object}`,
      setIdentity(after.identity),
      setIdentity(before.identity),
    )
  }

  if (before.comment !== after.comment) {
    const target = `COLUMN ${columnRef(key, name)}`
    change(
      'set_comment',
      PHASE.COMMENT,
      `set comment on ${object}`,
      commentStatement(target, after.comment),
      commentStatement(target, before.comment),
    )
  }
}

/** Enums only cast through text, so route any enum-involved change that way. */
function castExpression(name: string, from: Column, to: Column): string {
  const ident = quoteIdent(name)
  const viaText = from.enumRef !== null || to.enumRef !== null
  const suffix = to.type.endsWith('[]') ? '[]' : ''
  return viaText ? `${ident}::text${suffix}::${to.type}` : `${ident}::${to.type}`
}
