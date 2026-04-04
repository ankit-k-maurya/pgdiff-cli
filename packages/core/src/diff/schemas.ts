import { quoteIdent } from '../ddl.js'
import { PHASE } from '../phases.js'
import type { Snapshot } from '../types.js'
import type { OperationBuilder } from './builder.js'

/** Schemas are implied by their contents: there is no bare schema list to diff. */
function schemasWithObjects(snapshot: Snapshot): Set<string> {
  const set = new Set<string>()
  for (const table of Object.values(snapshot.tables)) set.add(table.schema)
  for (const type of Object.values(snapshot.enums)) set.add(type.schema)
  return set
}

export function diffSchemas(b: OperationBuilder, source: Snapshot, target: Snapshot): void {
  const before = schemasWithObjects(source)
  const after = schemasWithObjects(target)

  for (const schema of [...after].sort()) {
    // `public` always exists, so creating it is never part of a migration.
    if (before.has(schema) || schema === 'public') continue
    b.add({
      kind: 'create_schema',
      phase: PHASE.CREATE_SCHEMA,
      object: schema,
      summary: `create schema ${schema}`,
      up: [`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`],
      down: [`DROP SCHEMA IF EXISTS ${quoteIdent(schema)}`],
      destructive: false,
      lossy: false,
      transactional: true,
      warnings: [],
    })
  }
}
