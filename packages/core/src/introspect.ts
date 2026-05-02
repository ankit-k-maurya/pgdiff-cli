import pg from 'pg'
import { enumKey, tableKey } from './ddl.js'
import type { Column, Constraint, ConstraintKind, EnumType, Index, Snapshot, Table } from './types.js'

export interface IntrospectOptions {
  /** Schemas to read. Defaults to `['public']`. */
  schemas?: string[]
  /** Statement timeout in ms applied to the introspection session. */
  statementTimeoutMs?: number
}

type ClientLike = Pick<pg.Client, 'query'>

const ENUM_SQL = `
  select n.nspname as schema,
         t.typname  as name,
         array(
           select e.enumlabel::text from pg_enum e
           where e.enumtypid = t.oid
           order by e.enumsortorder
         ) as values
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  where t.typtype = 'e' and n.nspname = any($1)
  order by 1, 2
`

const TABLE_SQL = `
  select c.oid::int as oid,
         n.nspname   as schema,
         c.relname   as name,
         obj_description(c.oid, 'pg_class') as comment
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p')
    and not c.relispartition
    and n.nspname = any($1)
  order by 2, 3
`

const COLUMN_SQL = `
  select a.attrelid::int as table_oid,
         a.attname       as name,
         a.attnum        as position,
         format_type(a.atttypid, a.atttypmod) as type,
         a.attnotnull    as not_null,
         pg_get_expr(d.adbin, d.adrelid) as default_expr,
         case a.attidentity when 'a' then 'ALWAYS' when 'd' then 'BY DEFAULT' else null end as identity,
         case
           when t.typtype = 'e'  then tn.nspname || '.' || t.typname
           when et.typtype = 'e' then etn.nspname || '.' || et.typname
         end as enum_ref,
         case when a.attcollation <> 0 and a.attcollation <> t.typcollation then co.collname end as collation,
         col_description(a.attrelid, a.attnum) as comment
  from pg_attribute a
  join pg_class c      on c.oid = a.attrelid
  join pg_namespace n  on n.oid = c.relnamespace
  join pg_type t       on t.oid = a.atttypid
  join pg_namespace tn on tn.oid = t.typnamespace
  left join pg_type et       on et.oid = t.typelem
  left join pg_namespace etn on etn.oid = et.typnamespace
  left join pg_collation co  on co.oid = a.attcollation
  left join pg_attrdef d     on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0
    and not a.attisdropped
    and c.relkind in ('r', 'p')
    and not c.relispartition
    and n.nspname = any($1)
  order by a.attrelid, a.attnum
`

const CONSTRAINT_SQL = `
  select c.conrelid::int as table_oid,
         c.conname       as name,
         c.contype       as kind,
         pg_get_constraintdef(c.oid) as definition,
         case when c.contype = 'f' then fn.nspname || '.' || fc.relname end as references_table
  from pg_constraint c
  join pg_class t          on t.oid = c.conrelid
  join pg_namespace n      on n.oid = t.relnamespace
  left join pg_class fc     on fc.oid = c.confrelid
  left join pg_namespace fn on fn.oid = fc.relnamespace
  where n.nspname = any($1)
    and c.contype in ('p', 'u', 'f', 'c')
    and c.coninhcount = 0
  order by 1, 2
`

const INDEX_SQL = `
  select i.indrelid::int as table_oid,
         ic.relname      as name,
         pg_get_indexdef(i.indexrelid) as definition,
         i.indisunique   as is_unique
  from pg_index i
  join pg_class ic     on ic.oid = i.indexrelid
  join pg_class tc     on tc.oid = i.indrelid
  join pg_namespace n  on n.oid = tc.relnamespace
  where n.nspname = any($1)
    and not i.indisprimary
    and not exists (
      select 1 from pg_constraint con
      where con.conindid = i.indexrelid and con.contype in ('p', 'u', 'x')
    )
  order by 1, 2
`

const SCHEMA_SQL = `
  select nspname from pg_namespace
  where nspname not like 'pg\\_%' and nspname <> 'information_schema'
  order by 1
`

/**
 * Run `read` with only pg_catalog on the search path.
 *
 * That is what makes `pg_get_constraintdef`, `pg_get_indexdef` and
 * `format_type` schema-qualify every name they emit, so the generated DDL
 * applies correctly whatever search_path it later runs under. The client may
 * belong to the caller, so the previous setting goes back afterwards.
 */
async function withCatalogSearchPath<T>(client: ClientLike, read: () => Promise<T>): Promise<T> {
  const previous = (await client.query('show search_path')).rows[0]?.search_path
  await client.query('set search_path = pg_catalog')
  try {
    return await read()
  } finally {
    if (previous !== undefined) await client.query(`set search_path = ${previous}`)
  }
}

/**
 * One round of catalog reads.
 *
 * Strictly one at a time: `pg` deprecates overlapping `query()` calls on a
 * single client, and a connection can only run one statement anyway.
 */
async function readCatalogs(client: ClientLike, schemas: string[]) {
  const read = async (sql: string) => (await client.query(sql, [schemas])).rows

  return {
    enums: await read(ENUM_SQL),
    tables: await read(TABLE_SQL),
    columns: await read(COLUMN_SQL),
    constraints: await read(CONSTRAINT_SQL),
    indexes: await read(INDEX_SQL),
  }
}

/** Read a snapshot using an already-open client. */
export async function snapshotFromClient(
  client: ClientLike,
  options: IntrospectOptions = {},
): Promise<Snapshot> {
  const schemas = options.schemas?.length ? options.schemas : ['public']
  const rows = await withCatalogSearchPath(client, () => readCatalogs(client, schemas))

  const snapshot: Snapshot = { schemas: [...schemas].sort(), enums: {}, tables: {} }

  for (const row of rows.enums) {
    const type: EnumType = { schema: row.schema, name: row.name, values: row.values }
    snapshot.enums[enumKey(type)] = type
  }

  /** oid -> table, so the child rows below can find the table they belong to. */
  const byOid = new Map<number, Table>()
  for (const row of rows.tables) {
    const table: Table = {
      schema: row.schema,
      name: row.name,
      columns: {},
      columnOrder: [],
      constraints: {},
      indexes: {},
      comment: row.comment ?? null,
    }
    snapshot.tables[tableKey(table)] = table
    byOid.set(row.oid, table)
  }

  for (const row of rows.columns) {
    const table = byOid.get(row.table_oid)
    if (!table) continue
    const column: Column = {
      name: row.name,
      position: row.position,
      type: row.type,
      notNull: row.not_null,
      default: row.default_expr ?? null,
      identity: row.identity ?? null,
      enumRef: row.enum_ref ?? null,
      collation: row.collation ?? null,
      comment: row.comment ?? null,
    }
    table.columns[column.name] = column
    table.columnOrder.push(column.name)
  }

  for (const row of rows.constraints) {
    const table = byOid.get(row.table_oid)
    if (!table) continue
    const constraint: Constraint = {
      name: row.name,
      kind: row.kind as ConstraintKind,
      definition: row.definition,
      references: row.references_table ?? null,
    }
    table.constraints[constraint.name] = constraint
  }

  for (const row of rows.indexes) {
    const table = byOid.get(row.table_oid)
    if (!table) continue
    const index: Index = {
      name: row.name,
      definition: row.definition,
      isUnique: row.is_unique,
    }
    table.indexes[index.name] = index
  }

  return snapshot
}

/** Connect, run `use`, disconnect — whatever happens in between. */
async function withClient<T>(
  connection: string | pg.ClientConfig,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const config: pg.ClientConfig =
    typeof connection === 'string' ? { connectionString: connection } : connection
  const client = new pg.Client(config)
  await client.connect()
  try {
    return await use(client)
  } finally {
    await client.end()
  }
}

/** Connect, read a snapshot, disconnect. */
export function introspect(
  connection: string | pg.ClientConfig,
  options: IntrospectOptions = {},
): Promise<Snapshot> {
  return withClient(connection, async (client) => {
    if (options.statementTimeoutMs) {
      await client.query(`set statement_timeout = ${Number(options.statementTimeoutMs)}`)
    }
    return snapshotFromClient(client, options)
  })
}

/** Every user schema in the database, for pickers and validation. */
export function listSchemas(connection: string | pg.ClientConfig): Promise<string[]> {
  return withClient(connection, async (client) => {
    const result = await client.query(SCHEMA_SQL)
    return result.rows.map((row: { nspname: string }) => row.nspname)
  })
}
