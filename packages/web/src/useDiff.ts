import { useCallback, useState } from 'react'
import { runDiff, type Migration } from './api'

/** The form the user fills in, before it is turned into a request. */
export interface DiffForm {
  from: string
  to: string
  /** Comma-separated, as typed. */
  schemas: string
  allowDestructive: boolean
  transaction: boolean
}

/**
 * Owns one comparison: its result, its error and whether it is in flight.
 *
 * Keeping this out of the component leaves `App` to do nothing but hold the
 * form and lay the page out.
 */
export function useDiff() {
  const [migration, setMigration] = useState<Migration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const compare = useCallback(async (form: DiffForm) => {
    setBusy(true)
    setError(null)
    try {
      setMigration(
        await runDiff({
          from: { url: form.from.trim() },
          to: { url: form.to.trim() },
          schemas: parseSchemas(form.schemas),
          allowDestructive: form.allowDestructive,
          transaction: form.transaction,
        }),
      )
    } catch (cause) {
      setMigration(null)
      // An empty message would render as a blank banner, which reads as nothing
      // having happened at all.
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message.trim() || 'The comparison failed for an unknown reason.')
    } finally {
      setBusy(false)
    }
  }, [])

  return { migration, error, busy, compare }
}

function parseSchemas(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}
