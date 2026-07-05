import type { Migration, Operation, Plan, Snapshot } from '@pgdiff/core'

export type { Migration, Operation, Plan, Snapshot }

/** A side of the diff: a live database, or a snapshot captured earlier. */
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

  if (!response.ok) {
    // `??` would pass an empty `error` straight through; fall back on any falsy value.
    const reported = (payload as { error?: string }).error?.trim()
    throw new Error(reported || `${response.status} ${response.statusText}`.trim())
  }
  return payload as T
}

export function runDiff(request: DiffRequest): Promise<Migration> {
  return post('/api/diff', request)
}
