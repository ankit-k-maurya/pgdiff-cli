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

export const PHASE_LABELS: Record<number, string> = {
  10: 'create schemas',
  20: 'create enum types',
  25: 'alter enum types',
  30: 'drop foreign keys',
  35: 'drop constraints',
  36: 'drop indexes',
  40: 'create tables',
  45: 'add columns',
  50: 'alter columns',
  55: 'drop columns',
  60: 'create indexes',
  65: 'add constraints',
  70: 'add foreign keys',
  75: 'comments',
  80: 'drop tables',
  90: 'drop enum types',
}
