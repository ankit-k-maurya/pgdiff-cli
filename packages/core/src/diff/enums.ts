import {
  createEnumStatement,
  enumUsages,
  qualified,
  quoteLiteral,
  rebuildEnumStatements,
  type EnumUsage,
} from '../ddl.js'
import { PHASE } from '../phases.js'
import type { EnumType, Snapshot } from '../types.js'
import { sameValues, union, type OperationBuilder } from './builder.js'

/**
 * Postgres can only append labels to an enum (`ALTER TYPE ... ADD VALUE`), and
 * even that cannot be used in the same transaction that reads the new label.
 * Anything else — dropping a label, reordering labels — needs the type rebuilt
 * and every dependent column swapped over.
 */
export function diffEnums(b: OperationBuilder, source: Snapshot, target: Snapshot): void {
  for (const key of union(Object.keys(source.enums), Object.keys(target.enums))) {
    const before = source.enums[key]
    const after = target.enums[key]

    if (!before && after) createEnum(b, key, after)
    else if (before && !after) dropEnum(b, key, before)
    else if (before && after && !sameValues(before.values, after.values)) {
      alterEnum(b, source, key, before.values, after.values)
    }
  }
}

function createEnum(b: OperationBuilder, key: string, type: EnumType): void {
  b.add({
    kind: 'create_enum',
    phase: PHASE.CREATE_ENUM,
    object: key,
    summary: `create enum ${key} (${type.values.join(', ')})`,
    up: [createEnumStatement(type)],
    down: [`DROP TYPE ${qualified(key)}`],
    destructive: false,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

function dropEnum(b: OperationBuilder, key: string, type: EnumType): void {
  b.add({
    kind: 'drop_enum',
    phase: PHASE.DROP_ENUM,
    object: key,
    summary: `drop enum ${key}`,
    up: [`DROP TYPE ${qualified(key)}`],
    down: [createEnumStatement(type)],
    destructive: true,
    lossy: false,
    transactional: true,
    warnings: [],
  })
}

function alterEnum(
  b: OperationBuilder,
  source: Snapshot,
  key: string,
  before: string[],
  after: string[],
): void {
  // Labels the source already had, in the order the target keeps them. If that
  // matches the source exactly, nothing was removed or moved: pure appends.
  const retained = after.filter((v) => before.includes(v))
  const usages = enumUsages(source, key)

  if (sameValues(retained, before)) {
    addEnumValues(b, key, before, after, usages)
    return
  }

  const removed = before.filter((v) => !after.includes(v))
  b.add({
    kind: 'rebuild_enum',
    phase: PHASE.ALTER_ENUM,
    object: key,
    summary:
      removed.length > 0
        ? `rebuild enum ${key} (removes ${removed.join(', ')})`
        : `rebuild enum ${key} (reorders labels)`,
    up: rebuildEnumStatements(key, after, usages),
    down: rebuildEnumStatements(key, before, usages),
    destructive: removed.length > 0,
    lossy: false,
    transactional: true,
    warnings:
      removed.length > 0
        ? [`Rows holding ${quoteList(removed)} will fail the cast; migrate that data first.`]
        : [],
  })
}

function addEnumValues(
  b: OperationBuilder,
  key: string,
  before: string[],
  after: string[],
  usages: EnumUsage[],
): void {
  const added = after.filter((v) => !before.includes(v))

  // Each label is placed relative to its neighbour in the target order, so the
  // resulting sort order matches the target exactly rather than just appending.
  const up = added.map((value) => {
    const index = after.indexOf(value)
    const anchor = index === 0 ? after[1] : after[index - 1]
    const position = index === 0 ? 'BEFORE' : 'AFTER'
    return `ALTER TYPE ${qualified(key)} ADD VALUE ${quoteLiteral(value)} ${position} ${quoteLiteral(anchor)}`
  })

  b.add({
    kind: 'add_enum_value',
    phase: PHASE.ALTER_ENUM,
    object: key,
    summary: `add ${added.length} value(s) to enum ${key}: ${added.join(', ')}`,
    up,
    // There is no DROP VALUE, so the only way back is a full rebuild.
    down: rebuildEnumStatements(key, before, usages),
    destructive: false,
    lossy: false,
    // ADD VALUE cannot be followed by a use of the new label in the same
    // transaction, so the whole migration is emitted unwrapped.
    transactional: false,
    warnings: [
      'ALTER TYPE ... ADD VALUE cannot run inside a transaction block that also uses the new label; this migration is emitted without BEGIN/COMMIT.',
      `Rolling back rewrites ${key}; rows still holding ${quoteList(added)} will block the down migration.`,
    ],
  })
}

function quoteList(values: string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}
