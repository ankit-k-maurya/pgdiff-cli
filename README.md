# pgdiff

Diff two live PostgreSQL schemas and emit a **reversible** pair of migrations — an `up`
that moves the source to the target, and a `down` that puts it back. The planner works
out dependency order for foreign keys and enum changes so the generated SQL applies in
one pass.

Ships as a monorepo: a diffing core, a CLI, an HTTP API, and a React UI.

```
packages/core     introspection, diff engine, migration planner  (TypeScript, pg)
packages/cli      `pgdiff` command line interface                (commander)
packages/server   HTTP API used by the UI                        (express)
packages/web      browser UI                                     (React + Vite)
```

## Quick start

```bash
npm install
npm run build

# two throwaway databases with the example schemas
docker compose up -d     # or, without Docker: npm run dev:db

npm run pgdiff -- \
  --from postgresql://pgdiff:pgdiff@localhost:5441/app \
  --to   postgresql://pgdiff:pgdiff@localhost:5442/app \
  --allow-destructive
```

For the UI, run the API and the dev server side by side:

```bash
npm run dev          # api on :4000, ui on :5173
```

After `npm run build` the API also serves the built UI, so `npm start -w @pgdiff/server`
alone is enough in production.

### Without Docker

`npm run dev:db` starts the same two databases on 5441/5442 from the `embedded-postgres`
binaries, seeded with the example schemas, keeping their data in `.dev-db/`. It runs in the
foreground and the clusters are its children, so leave it running and stop it with Ctrl-C.
Running it again while they are already up just reports that and exits, so it is safe to
repeat. Pass `--reset` (`npm run dev:db -- --reset`) to wipe the data directories and
re-seed — stop the running one first, since `--reset` cannot rebuild a cluster that is
still listening.

## How the ordering works

Postgres will not let you drop a table something still references, add a column of a type
that does not exist yet, or use an enum label in the same transaction that created it. The
planner handles this in two layers.

**Phases.** Every operation lands in an ordering bucket
([`packages/core/src/phases.ts`](packages/core/src/phases.ts)): create schemas → create
enums → alter enums → drop foreign keys → drop constraints and indexes → create tables →
add/alter/drop columns → create indexes → add constraints → add foreign keys → drop tables
→ drop enums. Foreign keys are always emitted as standalone `ALTER TABLE ... ADD
CONSTRAINT` statements rather than inline in `CREATE TABLE`, which is what lets mutually
referencing tables be created in any order.

**Topological sort inside a phase.** Tables created together are sorted parent-before-child
along the foreign-key graph, and tables dropped together are sorted child-before-parent. A
cycle is reported as a warning rather than a failure — the plan stays valid because the
constraints are separate statements.

**Reversal.** The down migration is the ordered plan run backwards, with each operation
contributing its own inverse. Because the phase order is a valid dependency order forwards,
its reverse is a valid dependency order backwards: tables come back before the foreign keys
that point at them, and enum types are recreated before the columns that use them.

## Enum changes

Enums are the awkward case, and pgdiff treats them explicitly:

| Change | Up | Down |
| --- | --- | --- |
| Label appended or inserted | `ALTER TYPE ... ADD VALUE 'x' AFTER 'y'` | full rebuild back to the old label list |
| Label removed | rebuild: rename the type aside, recreate it, cast every dependent column, drop the old type | rebuild the other way |
| Labels reordered | rebuild | rebuild |

Postgres has no `ALTER TYPE ... DROP VALUE`, so removals and reorders rebuild the type and
swap every dependent column onto it — including `enum[]` columns, which are cast through
`text[]`. Column defaults are dropped before the swap and restored afterwards, because a
default is still typed as the old enum and would block it.

`ALTER TYPE ... ADD VALUE` cannot be followed by a use of the new label in the same
transaction, so any migration containing one is emitted **without** `BEGIN`/`COMMIT` and
carries a note saying why.

## Safety

- `DROP TABLE` and `DROP COLUMN` are **off by default**. Pass `--allow-destructive` (or tick
  the box in the UI) to include them; skipped drops are reported as warnings.
- Operations are flagged `destructive` (running `up` can lose data) and `lossy` (`down`
  restores structure but not rows), and both flags surface in the SQL comments and the UI.
- Per-operation warnings call out the cases Postgres will reject on a non-empty table:
  `SET NOT NULL` with existing nulls, adding a `NOT NULL` column without a default, a rebuild
  that would strand rows on a removed enum label.

pgdiff never writes to your databases. It only reads the catalogs, and the SQL it produces
is yours to review and apply.

## CLI

```bash
# compare two databases, print up then down
pgdiff --from <url|snapshot.json> --to <url|snapshot.json>

# write timestamped files
pgdiff --from ... --to ... --out migrations --name add_shipments

# a schema other than public, or several
pgdiff --from ... --to ... --schema public billing

# machine-readable plan
pgdiff --from ... --to ... --json

# fail CI when a checked-in snapshot has drifted
pgdiff --from prod.json --to postgresql://... --exit-code

# capture a schema for later
pgdiff snapshot postgresql://... --out prod.json
```

Either side of a diff can be a live connection string or a snapshot JSON file, so you can
diff production against a file captured last week without connecting to both at once.

## API

The server is a thin wrapper over the core. It binds to `127.0.0.1` by default — it accepts
connection strings from its caller, so do not expose it to a network you do not trust.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | — | `{ ok, version }` |
| `POST /api/schemas` | `{ url }` | `{ schemas }` |
| `POST /api/introspect` | `{ url, schemas }` | `{ snapshot }` |
| `POST /api/diff` | `{ from, to, schemas, allowDestructive, transaction }` | `{ up, down, plan }` |

`from` and `to` are each either `{ url }` or `{ snapshot }`.

## Tests

```bash
npm test
```

The unit tests build snapshots in memory and assert on ordering, reversibility and the
generated SQL. There is also a round-trip test against real databases that applies the up
migration to the source, checks it now matches the target, applies the down migration, and
checks it matches where it started:

```bash
docker compose up -d     # or: npm run dev:db
PGDIFF_SOURCE_URL=postgresql://pgdiff:pgdiff@localhost:5441/app \
PGDIFF_TARGET_URL=postgresql://pgdiff:pgdiff@localhost:5442/app \
npm test
```

It modifies the source database, so point it at a throwaway.

## What it covers

Schemas, enum types, tables, columns (type, default, `NOT NULL`, identity, collation,
comments), primary keys, unique constraints, check constraints, foreign keys, and indexes.

Not covered: views, materialised views, functions, triggers, sequences owned outside a
column, row-level security, extensions, partitioning, and renames. A rename is
indistinguishable from a drop plus an add when comparing two catalogs, so pgdiff emits it
as one — check the plan before applying if you renamed something.
