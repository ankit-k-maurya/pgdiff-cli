/**
 * Snapshot model.
 *
 * A snapshot is a plain-JSON description of everything pgdiff knows how to
 * compare. It is deliberately serialisable: you can introspect a database once,
 * store the snapshot, and diff against it later without a live connection.
 */

export interface Snapshot {
  /** Schemas that were introspected, in name order. */
  schemas: string[]
  /** Keyed by `schema.name`. */
  enums: Record<string, EnumType>
  /** Keyed by `schema.name`. */
  tables: Record<string, Table>
}

export interface EnumType {
  schema: string
  name: string
  /** Labels in sort order — order is part of the type's identity in Postgres. */
  values: string[]
}

export interface Table {
  schema: string
  name: string
  /** Keyed by column name. */
  columns: Record<string, Column>
  /** Column names in attnum order. */
  columnOrder: string[]
  /** Keyed by constraint name. */
  constraints: Record<string, Constraint>
  /** Keyed by index name; excludes indexes owned by a constraint. */
  indexes: Record<string, Index>
  comment: string | null
}

export interface Column {
  name: string
  position: number
  /** `format_type` output, e.g. `character varying(20)`, `public.mood`. */
  type: string
  notNull: boolean
  /** Raw expression from `pg_get_expr`, or null. */
  default: string | null
  identity: 'ALWAYS' | 'BY DEFAULT' | null
  /** `schema.name` of the enum backing this column, when it has one. */
  enumRef: string | null
  collation: string | null
  comment: string | null
}

export type ConstraintKind = 'p' | 'u' | 'f' | 'c'

export interface Constraint {
  name: string
  kind: ConstraintKind
  /** `pg_get_constraintdef` output — used verbatim in generated DDL. */
  definition: string
  /** For foreign keys: the `schema.name` this constraint points at. */
  references: string | null
}

export interface Index {
  name: string
  /** `pg_get_indexdef` output. */
  definition: string
  isUnique: boolean
}

/** Every kind of change pgdiff can plan. */
export type ChangeKind =
  | 'create_schema'
  | 'drop_schema'
  | 'create_enum'
  | 'drop_enum'
  | 'add_enum_value'
  | 'rebuild_enum'
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column_type'
  | 'set_not_null'
  | 'drop_not_null'
  | 'set_default'
  | 'drop_default'
  | 'add_identity'
  | 'drop_identity'
  | 'add_constraint'
  | 'drop_constraint'
  | 'add_foreign_key'
  | 'drop_foreign_key'
  | 'create_index'
  | 'drop_index'
  | 'set_comment'

/**
 * A single planned change. `up` moves source -> target, `down` moves back.
 * Ordering is decided by `phase` first, then by dependency edges inside a phase.
 */
export interface Operation {
  id: string
  kind: ChangeKind
  /** Coarse ordering bucket — see PHASES in plan.ts. */
  phase: number
  /** Qualified name of the object the change is about, for display. */
  object: string
  /** One-line human summary. */
  summary: string
  up: string[]
  down: string[]
  /** True when running `up` can destroy data. */
  destructive: boolean
  /** True when `down` restores structure but cannot restore data. */
  lossy: boolean
  /** False when the statement cannot run inside a transaction block. */
  transactional: boolean
  warnings: string[]
  /** Ids of operations in the same phase that must run before this one. */
  deps: string[]
}

export interface Plan {
  operations: Operation[]
  warnings: string[]
}

export interface MigrationOptions {
  /** Wrap statements in BEGIN/COMMIT where every statement allows it. */
  transaction?: boolean
  /** Emit `-- comment` headers above each operation. */
  annotate?: boolean
}

export interface Migration {
  up: string
  down: string
  plan: Plan
}
