import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientConfig } from '../src/introspect.js'

const sslOf = (url: string) => clientConfig(url).ssl

test('a managed Postgres URL without sslmode still gets TLS', () => {
  // Neon, Supabase and RDS all refuse a cleartext connection. `pg` would dial
  // one, because it only enables TLS when the URL says so.
  for (const url of [
    'postgresql://u:p@ep-cool-lab-123.us-east-2.aws.neon.tech/app',
    'postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres',
    'postgres://admin:p@shop.abc123.us-east-1.rds.amazonaws.com:5432/shop',
  ]) {
    assert.deepEqual(sslOf(url), { rejectUnauthorized: false }, url)
  }
})

test('an explicit sslmode is left to the driver', () => {
  // `pg` already maps these, and overriding would silently downgrade a URL
  // that deliberately asked to verify the certificate.
  assert.equal(sslOf('postgresql://u:p@ep-x.aws.neon.tech/app?sslmode=verify-full'), undefined)
  assert.equal(sslOf('postgresql://u:p@ep-x.aws.neon.tech/app?sslmode=require'), undefined)
  assert.equal(sslOf('postgresql://u:p@ep-x.aws.neon.tech/app?sslmode=disable'), undefined)
})

test('loopback stays in cleartext', () => {
  // A local server started by `npm run dev:db` has no certificate at all.
  for (const url of [
    'postgresql://pgdiff:pgdiff@localhost:5441/app',
    'postgresql://pgdiff:pgdiff@127.0.0.1:5442/app',
    'postgresql://pgdiff:pgdiff@[::1]:5442/app',
    'postgresql://pgdiff:pgdiff@db.localhost:5442/app',
  ]) {
    assert.equal(sslOf(url), undefined, url)
  }
})

test('a config object and an unparseable string pass through untouched', () => {
  const config = { host: 'ep-x.aws.neon.tech', database: 'app' }
  assert.equal(clientConfig(config), config)
  assert.deepEqual(clientConfig('not a url'), { connectionString: 'not a url' })
  // `pg` will throw on this, but we don't want to.
})
