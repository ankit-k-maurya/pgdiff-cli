import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMigration, createPlan } from '../src/index.js'
import { snapshot } from './helpers.js'

const withEnum = (values: string[]) =>
  snapshot({
    enums: { 'public.mood': values },
    tables: {
      'public.posts': {
        columns: {
          id: 'integer',
          mood: { type: 'public.mood', enumRef: 'public.mood', default: "'ok'::public.mood" },
        },
      },
    },
  })

test('appending labels uses ALTER TYPE ... ADD VALUE and refuses a transaction', () => {
  const plan = createPlan(withEnum(['sad', 'ok']), withEnum(['sad', 'ok', 'great']))
  assert.equal(plan.operations.length, 1)

  const [op] = plan.operations
  assert.equal(op.kind, 'add_enum_value')
  assert.deepEqual(op.up, ["ALTER TYPE public.mood ADD VALUE 'great' AFTER 'ok'"])
  assert.equal(op.transactional, false)

  const { up } = createMigration(withEnum(['sad', 'ok']), withEnum(['sad', 'ok', 'great']))
  assert.doesNotMatch(up, /BEGIN;/)
  assert.match(up, /not wrapped in a transaction/)
})

test('a label inserted at the front is anchored with BEFORE', () => {
  const plan = createPlan(withEnum(['ok', 'great']), withEnum(['sad', 'ok', 'great']))
  assert.deepEqual(plan.operations[0].up, ["ALTER TYPE public.mood ADD VALUE 'sad' BEFORE 'ok'"])
})

test('rolling back an added label rebuilds the type and swaps dependent columns', () => {
  const plan = createPlan(withEnum(['sad', 'ok']), withEnum(['sad', 'ok', 'great']))
  assert.deepEqual(plan.operations[0].down, [
    'ALTER TYPE public.mood RENAME TO mood__pgdiff_old',
    "CREATE TYPE public.mood AS ENUM ('sad', 'ok')",
    'ALTER TABLE public.posts ALTER COLUMN mood DROP DEFAULT',
    'ALTER TABLE public.posts ALTER COLUMN mood TYPE public.mood USING mood::text::public.mood',
    "ALTER TABLE public.posts ALTER COLUMN mood SET DEFAULT 'ok'::public.mood",
    'DROP TYPE public.mood__pgdiff_old',
  ])
})

test('removing a label rebuilds the type in both directions and flags the data risk', () => {
  const plan = createPlan(withEnum(['sad', 'ok', 'great']), withEnum(['sad', 'ok']))
  const [op] = plan.operations

  assert.equal(op.kind, 'rebuild_enum')
  assert.equal(op.destructive, true)
  assert.match(op.warnings.join(' '), /Rows holding 'great' will fail the cast/)
  assert.match(op.up.join('\n'), /CREATE TYPE public\.mood AS ENUM \('sad', 'ok'\)/)
  assert.match(op.down.join('\n'), /CREATE TYPE public\.mood AS ENUM \('sad', 'ok', 'great'\)/)
  // Both directions rename the live type out of the way first.
  assert.equal(op.up[0], 'ALTER TYPE public.mood RENAME TO mood__pgdiff_old')
  assert.equal(op.down[0], 'ALTER TYPE public.mood RENAME TO mood__pgdiff_old')
})

test('reordering labels rebuilds without being marked destructive', () => {
  const plan = createPlan(withEnum(['sad', 'ok']), withEnum(['ok', 'sad']))
  assert.equal(plan.operations[0].kind, 'rebuild_enum')
  assert.equal(plan.operations[0].destructive, false)
})

test('a new enum is created before the table that uses it and dropped after', () => {
  const target = withEnum(['sad', 'ok'])
  const plan = createPlan(snapshot({}), target)
  const kinds = plan.operations.map((op) => op.kind)
  assert.ok(kinds.indexOf('create_enum') < kinds.indexOf('create_table'))

  const dropPlan = createPlan(target, snapshot({}), { allowDestructive: true })
  const dropKinds = dropPlan.operations.map((op) => op.kind)
  assert.ok(dropKinds.indexOf('drop_table') < dropKinds.indexOf('drop_enum'))
})

test('array columns of an enum are cast through text[] on rebuild', () => {
  const before = snapshot({
    enums: { 'public.tag': ['a', 'b'] },
    tables: { 'public.posts': { columns: { tags: { type: 'public.tag[]', enumRef: 'public.tag' } } } },
  })
  const after = snapshot({
    enums: { 'public.tag': ['a'] },
    tables: { 'public.posts': { columns: { tags: { type: 'public.tag[]', enumRef: 'public.tag' } } } },
  })

  const plan = createPlan(before, after)
  assert.match(
    plan.operations[0].up.join('\n'),
    /ALTER COLUMN tags TYPE public\.tag\[\] USING tags::text\[\]::public\.tag\[\]/,
  )
})
