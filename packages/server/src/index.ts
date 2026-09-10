import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import app from './app.js'

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 4000)

// In production the API also serves the built UI, so `npm start` is all it takes.
// On Vercel the UI is served as static output instead, so this never runs there.
const webDist = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'web/dist')
if (existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')))
}

app.listen(PORT, HOST, () => {
  process.stdout.write(`pgdiff api listening on http://${HOST}:${PORT}\n`)
})
