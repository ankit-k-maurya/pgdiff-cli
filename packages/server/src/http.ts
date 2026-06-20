import type { Request, Response } from 'express'

/** An error whose message and status are safe to hand back to the caller. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

type Handler = (req: Request, res: Response) => Promise<void>

/** Turn a rejected promise into a JSON error rather than an unhandled rejection. */
export function asyncRoute(handler: Handler) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400
      // Never answer with a blank message: the UI would render an empty banner.
      const message = describeError(error).trim() || 'The request failed for an unknown reason.'
      res.status(status).json({ error: message })
    })
  }
}

/**
 * Node reports a failed connection to a name with several addresses (localhost
 * is both ::1 and 127.0.0.1) as an AggregateError whose own message is empty --
 * the reasons live in `.errors`. Reading `.message` alone hands the client "",
 * which it cannot show, so unwrap the causes.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...new Set(error.errors.map(describeError).filter(Boolean))]
    if (causes.length > 0) return error.message || causes.join('; ')
  }
  if (error instanceof Error) return error.message
  return String(error ?? '')
}

/** A non-empty string from an untrusted body, or a 400. */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `"${name}" is required`)
  }
  return value
}

/** A list of schema names, defaulting to `public` when absent or malformed. */
export function toSchemas(value: unknown): string[] {
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
    return value as string[]
  }
  return ['public']
}
