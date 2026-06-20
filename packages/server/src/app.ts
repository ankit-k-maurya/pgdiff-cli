import cors from 'cors'
import express from 'express'
import { createMigration, type Snapshot } from '@pgdiff/core'
import { introspect, listSchemas } from '@pgdiff/core/introspect'
import { asyncRoute, HttpError, requireString, toSchemas } from './http.js'

export const VERSION = '0.1.0'

/**
 * The API surface on its own, with no listener attached, so it can either be
 * served by `index.ts` locally or exported as a serverless function.
 *
 * Every route is a thin translation between JSON and the core library; the
 * plumbing that keeps them thin lives in `http.ts`.
 */
const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: VERSION })
})

/** List the schemas in a database so the UI can offer them. */
app.post('/api/schemas', asyncRoute(async (req, res) => {
  const url = requireString(req.body?.url, 'url')
  res.json({ schemas: await listSchemas(url) })
}))

app.post('/api/introspect', asyncRoute(async (req, res) => {
  const url = requireString(req.body?.url, 'url')
  res.json({ snapshot: await introspect(url, { schemas: toSchemas(req.body?.schemas) }) })
}))

app.post('/api/diff', asyncRoute(async (req, res) => {
  const schemas = toSchemas(req.body?.schemas)
  const [source, target] = await Promise.all([
    resolveSide(req.body?.from, schemas, 'from'),
    resolveSide(req.body?.to, schemas, 'to'),
  ])

  res.json(
    createMigration(source, target, {
      allowDestructive: Boolean(req.body?.allowDestructive),
      transaction: req.body?.transaction !== false,
    }),
  )
}))

/** A side is either `{ url }` for a live database or `{ snapshot }` for JSON. */
function resolveSide(side: unknown, schemas: string[], label: string): Promise<Snapshot> {
  const body = (side ?? {}) as { url?: unknown; snapshot?: unknown }

  if (body.snapshot) return Promise.resolve(body.snapshot as Snapshot)
  if (typeof body.url === 'string') return introspect(body.url, { schemas })
  throw new HttpError(400, `"${label}" must be { url } or { snapshot }`)
}

export default app
