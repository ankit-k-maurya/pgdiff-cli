import type { Migration, Operation, Plan, Snapshot } from '@pgdiff/core'

export type { Migration, Operation, Plan, Snapshot }

export interface Side {
  url?: string
  snapshot?: Snapshot
}

export interface DiffRequest {
  from: Side
  to: Side
  schemas: string[]
  allowDestructive: boolean
  transaction: boolean
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((payload as { error?: string }).error ?? response.statusText)
  return payload as T
}

export function fetchSchemas(url: string): Promise<{ schemas: string[] }> {
  return post('/api/schemas', { url })
}

export function runDiff(request: DiffRequest): Promise<Migration> {
  return post('/api/diff', request)
}
