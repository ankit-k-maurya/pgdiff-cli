import cors from 'cors'
import express, { type Request, type Response } from 'express'
import { createMigration, introspect, listSchemas, type Snapshot } from '@pgdiff/core'

/**
 * The API surface on its own, with no listener attached, so it can either be
 * served by `index.ts` locally or exported as a serverless function.
 */
const app = express()
app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0' })
})

/** List the schemas in a database so the UI can offer them. */
app.post('/api/schemas', asyncRoute(async (req, res) => {
  const url = requireString(req.body?.url, 'url')
  res.json({ schemas: await listSchemas(url) })
}))

app.post('/api/introspect', asyncRoute(async (req, res) => {
  const url = requireString(req.body?.url, 'url')
  const schemas = toSchemas(req.body?.schemas)
  res.json({ snapshot: await introspect(url, { schemas }) })
}))

app.post('/api/diff', asyncRoute(async (req, res) => {
  const schemas = toSchemas(req.body?.schemas)
  const [source, target] = await Promise.all([
    resolveSide(req.body?.from, schemas, 'from'),
    resolveSide(req.body?.to, schemas, 'to'),
  ])

  const migration = createMigration(source, target, {
    allowDestructive: Boolean(req.body?.allowDestructive),
    transaction: req.body?.transaction !== false,
  })
  res.json(migration)
}))

/** A side is either `{ url }` for a live database or `{ snapshot }` for JSON. */
async function resolveSide(side: unknown, schemas: string[], label: string): Promise<Snapshot> {
  if (side && typeof side === 'object' && 'snapshot' in side && side.snapshot) {
    return side.snapshot as Snapshot
  }
  if (side && typeof side === 'object' && 'url' in side && typeof side.url === 'string') {
    return introspect(side.url, { schemas })
  }
  throw new HttpError(400, `"${label}" must be { url } or { snapshot }`)
}

function toSchemas(value: unknown): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length > 0) {
    return value as string[]
  }
  return ['public']
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `"${name}" is required`)
  }
  return value
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

type Handler = (req: Request, res: Response) => Promise<void>

/** Turn a rejected promise into a JSON error rather than an unhandled rejection. */
function asyncRoute(handler: Handler) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400
      const message = error instanceof Error ? error.message : String(error)
      res.status(status).json({ error: message })
    })
  }
}

export default app
