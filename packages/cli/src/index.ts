#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { createMigration, type Migration, type Snapshot } from '@pgdiff/core'
import { introspect } from '@pgdiff/core/introspect'

const VERSION = '0.1.0'

interface DiffCommandOptions {
  from: string
  to: string
  schema: string[]
  allowDestructive: boolean
  transaction: boolean
  out?: string
  name: string
  json: boolean
  exitCode: boolean
}

interface SnapshotCommandOptions {
  schema: string[]
  out?: string
}

const program = new Command()

program
  .name('pgdiff')
  .description('Diff two live PostgreSQL schemas and emit reversible up/down migrations.')
  .version(VERSION)

program
  .command('snapshot')
  .description('Read a schema and write it to a JSON snapshot file.')
  .argument('<url>', 'postgres connection string')
  .option('-s, --schema <name...>', 'schemas to read', ['public'])
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .action(async (url: string, opts: SnapshotCommandOptions) => {
    const snapshot = await introspect(url, { schemas: opts.schema })
    const json = JSON.stringify(snapshot, null, 2) + '\n'

    if (!opts.out) {
      process.stdout.write(json)
      return
    }
    await writeFile(opts.out, json)
    note(`wrote ${opts.out}`)
  })

program
  .command('diff', { isDefault: true })
  .description('Diff two schemas. Each side is a connection string or a snapshot JSON file.')
  .requiredOption('-f, --from <source>', 'current schema (the migration starts here)')
  .requiredOption('-t, --to <target>', 'desired schema (the migration ends here)')
  .option('-s, --schema <name...>', 'schemas to compare', ['public'])
  .option('--allow-destructive', 'include DROP TABLE / DROP COLUMN operations', false)
  .option('--no-transaction', 'do not wrap statements in BEGIN/COMMIT')
  .option('-o, --out <dir>', 'write <timestamp>.up.sql and <timestamp>.down.sql into a directory')
  .option('--name <name>', 'basename for the generated files', 'migration')
  .option('--json', 'print the plan as JSON instead of SQL', false)
  .option('--exit-code', 'exit 1 when the schemas differ (useful in CI)', false)
  .action(async (opts: DiffCommandOptions) => {
    const [source, target] = await Promise.all([
      loadSnapshot(opts.from, opts.schema),
      loadSnapshot(opts.to, opts.schema),
    ])

    const migration = createMigration(source, target, {
      allowDestructive: opts.allowDestructive,
      transaction: opts.transaction,
    })

    await emit(migration, opts)

    // Warnings and the operation count go to stderr, so piping stdout to a file
    // still yields nothing but SQL (or JSON).
    for (const warning of migration.plan.warnings) note(`warning: ${warning}`)
    note(`${migration.plan.operations.length} operation(s)`)

    if (opts.exitCode && migration.plan.operations.length > 0) process.exitCode = 1
  })

/** JSON to stdout, a pair of files on disk, or both migrations to stdout. */
async function emit(migration: Migration, opts: DiffCommandOptions): Promise<void> {
  if (opts.json) {
    process.stdout.write(JSON.stringify(migration, null, 2) + '\n')
    return
  }

  if (opts.out) {
    await mkdir(opts.out, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const base = path.join(opts.out, `${stamp}_${opts.name}`)
    await writeFile(`${base}.up.sql`, migration.up)
    await writeFile(`${base}.down.sql`, migration.down)
    note(`wrote ${base}.up.sql`)
    note(`wrote ${base}.down.sql`)
    return
  }

  process.stdout.write(migration.up + '\n' + migration.down)
}

/** A side of the diff is either a live database or a snapshot written earlier. */
async function loadSnapshot(source: string, schemas: string[]): Promise<Snapshot> {
  if (/^postgres(ql)?:\/\//.test(source)) {
    return introspect(source, { schemas })
  }
  return JSON.parse(await readFile(source, 'utf8')) as Snapshot
}

function note(message: string): void {
  process.stderr.write(`${message}\n`)
}

program.parseAsync().catch((error: unknown) => {
  note(`pgdiff: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
