/**
 * Coarse ordering buckets.
 *
 * Almost all of Postgres' dependency rules are satisfied by running changes in
 * the right order of *kind*: types before the tables that use them, references
 * torn down before the objects they point at, references rebuilt only once every
 * table exists. Phases encode that; the topological sort inside `plan.ts` then
 * settles the order between operations that land in the same phase.
 *
 * A down migration is the up migration reversed, so every phase pairs with its
 * mirror image (CREATE_ENUM at 20 is undone after DROP at 40's mirror, and so on).
 */
export const PHASE = {
  CREATE_SCHEMA: 10,
  CREATE_ENUM: 20,
  ALTER_ENUM: 25,
  DROP_FK: 30,
  DROP_CONSTRAINT: 35,
  DROP_INDEX: 36,
  CREATE_TABLE: 40,
  ADD_COLUMN: 45,
  ALTER_COLUMN: 50,
  DROP_COLUMN: 55,
  CREATE_INDEX: 60,
  ADD_CONSTRAINT: 65,
  ADD_FK: 70,
  COMMENT: 75,
  DROP_TABLE: 80,
  DROP_ENUM: 90,
} as const

/** Keyed off PHASE itself so a renumbered phase cannot lose its label. */
export const PHASE_LABELS: Record<number, string> = {
  [PHASE.CREATE_SCHEMA]: 'create schemas',
  [PHASE.CREATE_ENUM]: 'create enum types',
  [PHASE.ALTER_ENUM]: 'alter enum types',
  [PHASE.DROP_FK]: 'drop foreign keys',
  [PHASE.DROP_CONSTRAINT]: 'drop constraints',
  [PHASE.DROP_INDEX]: 'drop indexes',
  [PHASE.CREATE_TABLE]: 'create tables',
  [PHASE.ADD_COLUMN]: 'add columns',
  [PHASE.ALTER_COLUMN]: 'alter columns',
  [PHASE.DROP_COLUMN]: 'drop columns',
  [PHASE.CREATE_INDEX]: 'create indexes',
  [PHASE.ADD_CONSTRAINT]: 'add constraints',
  [PHASE.ADD_FK]: 'add foreign keys',
  [PHASE.COMMENT]: 'comments',
  [PHASE.DROP_TABLE]: 'drop tables',
  [PHASE.DROP_ENUM]: 'drop enum types',
}

/** Display name for a phase, falling back to its number. */
export function phaseLabel(phase: number): string {
  return PHASE_LABELS[phase] ?? `phase ${phase}`
}
