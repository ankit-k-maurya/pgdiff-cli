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

/**
 * Pull a human-readable message out of an error body.
 *
 * Our own API answers with `{ error: string }`, but anything sitting in front
 * of it may not. Vercel's deployment-protection challenge, for instance,
 * answers 401 with `{ error: { code, message } }` -- calling `.trim()` on that
 * object throws and buries the status code that actually explains the failure.
 */
function describeError(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { error } = payload as { error?: unknown }

  if (typeof error === 'string') return error.trim() || undefined
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string') return message.trim() || undefined
  }
  return undefined
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    // A rejected `fetch` never saw an HTTP status: the browser refused or lost
    // the request. On a protected Vercel deployment that is the login
    // redirect; elsewhere it is an offline tab, a blocking extension, or DNS.
    throw new Error(
      'Could not reach the pgdiff API. If this deployment is behind Vercel ' +
        'Authentication, sign in or disable deployment protection; otherwise ' +
        'check your connection.',
      { cause },
    )
  }

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `The pgdiff API refused the request (${response.status}). This deployment ` +
          'is behind access protection, so the browser never reached pgdiff itself.',
      )
    }
    // `??` would pass an empty `error` straight through; fall back on any falsy value.
    throw new Error(describeError(payload) || `${response.status} ${response.statusText}`.trim())
  }
  return payload as T
}

export function runDiff(request: DiffRequest): Promise<Migration> {
  return post('/api/diff', request)
}
