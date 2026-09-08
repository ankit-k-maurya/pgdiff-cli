import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMigration, createPlan } from '../src/index.js'
import { indexOfKind, snapshot } from './helpers.js'

const empty = snapshot({})

test('identical schemas produce no operations', () => {
  const schema = snapshot({
    tables: { 'public.users': { columns: { id: 'integer', email: 'text' } } },
  })
  const plan = createPlan(schema, schema)
  assert.equal(plan.operations.length, 0)
})

test('new tables are created before the foreign keys that reference them', () => {
  const target = snapshot({
    tables: {
      'public.orders': {
        columns: { id: 'integer', customer_id: 'integer' },
        constraints: {
          orders_pkey: { kind: 'p', definition: 'PRIMARY KEY (id)' },
          orders_customer_fkey: {
            kind: 'f',
            definition: 'FOREIGN KEY (customer_id) REFERENCES public.customers(id)',
            references: 'public.customers',
          },
        },
      },
      'public.customers': {
        columns: { id: 'integer', name: 'text' },
        constraints: { customers_pkey: { kind: 'p', definition: 'PRIMARY KEY (id)' } },
      },
    },
  })

  const plan = createPlan(empty, target)
  const customers = indexOfKind(plan.operations, 'create_table', 'public.customers')
  const orders = indexOfKind(plan.operations, 'create_table', 'public.orders')
  const fk = indexOfKind(plan.operations, 'add_foreign_key')

  assert.ok(customers >= 0 && orders >= 0 && fk >= 0)
  assert.ok(customers < orders, 'parent table is created before the child')
  assert.ok(orders < fk, 'foreign key is added after both tables exist')

  // Primary keys stay inline in CREATE TABLE; foreign keys do not.
  const createOrders = plan.operations[orders].up.join('\n')
  assert.match(createOrders, /CONSTRAINT orders_pkey PRIMARY KEY \(id\)/)
  assert.doesNotMatch(createOrders, /FOREIGN KEY/)
})

test('dropping a referenced table drops the foreign key first and reverses cleanly', () => {
  const source = snapshot({
    tables: {
      'public.orders': {
        columns: { id: 'integer', customer_id: 'integer' },
        constraints: {
          orders_customer_fkey: {
            kind: 'f',
            definition: 'FOREIGN KEY (customer_id) REFERENCES public.customers(id)',
            references: 'public.customers',
          },
        },
      },
      'public.customers': { columns: { id: 'integer' } },
    },
  })

  const plan = createPlan(source, empty, { allowDestructive: true })
  const dropFk = indexOfKind(plan.operations, 'drop_foreign_key')
  const dropOrders = indexOfKind(plan.operations, 'drop_table', 'public.orders')
  const dropCustomers = indexOfKind(plan.operations, 'drop_table', 'public.customers')

  assert.ok(dropFk < dropOrders, 'foreign key goes before the tables')
  assert.ok(dropOrders < dropCustomers, 'referencing table is dropped before the table it points at')

  // The down migration must rebuild in the opposite order.
  const { down } = createMigration(source, empty, { allowDestructive: true })
  const customersAt = down.indexOf('CREATE TABLE public.customers')
  const ordersAt = down.indexOf('CREATE TABLE public.orders')
  const fkAt = down.indexOf('ADD CONSTRAINT orders_customer_fkey')
  assert.ok(customersAt > -1 && ordersAt > -1 && fkAt > -1)
  assert.ok(ordersAt < fkAt, 'tables come back before the foreign key does')
  assert.ok(customersAt < fkAt)
})

test('destructive changes are skipped unless allowed', () => {
  const source = snapshot({
    tables: { 'public.users': { columns: { id: 'integer', legacy: 'text' } } },
  })
  const target = snapshot({ tables: { 'public.users': { columns: { id: 'integer' } } } })

  const guarded = createPlan(source, target)
  assert.equal(indexOfKind(guarded.operations, 'drop_column'), -1)
  assert.equal(guarded.warnings.length, 1)
  assert.match(guarded.warnings[0], /Skipped dropping column public\.users\.legacy/)

  const allowed = createPlan(source, target, { allowDestructive: true })
  assert.ok(indexOfKind(allowed.operations, 'drop_column') >= 0)
})

test('adding a column round-trips against the reverse diff', () => {
  const source = snapshot({ tables: { 'public.users': { columns: { id: 'integer' } } } })
  const target = snapshot({
    tables: { 'public.users': { columns: { id: 'integer', email: { type: 'text', notNull: true, default: "''::text" } } } },
  })

  const forward = createPlan(source, target)
  const backward = createPlan(target, source, { allowDestructive: true })

  assert.deepEqual(
    forward.operations.flatMap((op) => op.down),
    backward.operations.flatMap((op) => op.up),
  )
})

test('column type changes are sequenced around the indexes that cover them', () => {
  const source = snapshot({
    tables: {
      'public.users': {
        columns: { id: 'integer', email: 'character varying(64)' },
        indexes: { users_email_idx: { definition: 'CREATE INDEX users_email_idx ON public.users USING btree (email)' } },
      },
    },
  })
  const target = snapshot({
    tables: {
      'public.users': {
        columns: { id: 'integer', email: 'text' },
        indexes: { users_email_idx: { definition: 'CREATE INDEX users_email_idx ON public.users USING btree (email)' } },
      },
    },
  })

  const plan = createPlan(source, target)
  const kinds = plan.operations.map((op) => op.kind)
  assert.deepEqual(kinds, ['alter_column_type'])
  assert.match(plan.operations[0].up[0], /ALTER COLUMN email TYPE text USING email::text/)
})

test('reserved identifiers are quoted', () => {
  const target = snapshot({
    tables: { 'public.order': { columns: { select: 'text', ok: 'text' } } },
  })
  const { up } = createMigration(empty, target)
  assert.match(up, /CREATE TABLE public\."order"/)
  assert.match(up, /"select" text/)
  assert.match(up, /\n {2}ok text/)
})
