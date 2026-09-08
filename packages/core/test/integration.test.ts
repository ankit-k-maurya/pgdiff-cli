import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'
import { createPlan, snapshotFromClient } from '../src/index.js'
import type { Operation, Snapshot } from '../src/types.js'

/**
 * End-to-end proof of reversibility against real databases.
 *
 * Set both URLs to run it — `docker compose up -d` provides them:
 *   PGDIFF_SOURCE_URL=postgresql://pgdiff:pgdiff@localhost:5441/app \
 *   PGDIFF_TARGET_URL=postgresql://pgdiff:pgdiff@localhost:5442/app \
 *   npm test
 *
 * The source database is modified in place, so point it at a throwaway.
 */
const SOURCE_URL = process.env.PGDIFF_SOURCE_URL
const TARGET_URL = process.env.PGDIFF_TARGET_URL

describe('live migration round trip', { skip: !SOURCE_URL || !TARGET_URL ? 'set PGDIFF_SOURCE_URL and PGDIFF_TARGET_URL' : false }, () => {
  let source: pg.Client
  let target: pg.Client

  before(async () => {
    source = new pg.Client({ connectionString: SOURCE_URL })
    target = new pg.Client({ connectionString: TARGET_URL })
    await Promise.all([source.connect(), target.connect()])
  })

  after(async () => {
    await Promise.all([source.end(), target.end()])
  })

  test('up reaches the target schema and down returns to the original', async () => {
    const original = await snapshotFromClient(source)
    const desired = await snapshotFromClient(target)

    const plan = createPlan(original, desired, { allowDestructive: true })
    assert.ok(plan.operations.length > 0, 'the fixtures should differ')

    await apply(source, plan.operations, 'up')
    assert.deepEqual(normalise(await snapshotFromClient(source)), normalise(desired))

    await apply(source, [...plan.operations].reverse(), 'down')
    assert.deepEqual(normalise(await snapshotFromClient(source)), normalise(original))
  })
})

/**
 * Statements are applied one at a time rather than as one script: the simple
 * query protocol would wrap the whole batch in an implicit transaction, which
 * `ALTER TYPE ... ADD VALUE` cannot tolerate.
 */
async function apply(client: pg.Client, operations: Operation[], direction: 'up' | 'down'): Promise<void> {
  for (const op of operations) {
    for (const statement of op[direction]) {
      try {
        await client.query(statement)
      } catch (cause) {
        throw new Error(`${op.id} failed on: ${statement}\n${(cause as Error).message}`)
      }
    }
  }
}

/** Column positions drift when columns are dropped and re-added; ignore them. */
function normalise(snapshot: Snapshot): Snapshot {
  const copy: Snapshot = JSON.parse(JSON.stringify(snapshot))
  for (const table of Object.values(copy.tables)) {
    table.columnOrder = [...table.columnOrder].sort()
    for (const column of Object.values(table.columns)) column.position = 0
  }
  return copy
}
