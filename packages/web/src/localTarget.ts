/**
 * Whether the page itself is being served from the reader's own machine.
 *
 * When it is, `localhost` in a connection URL means the same machine the API
 * runs on and everything works. When the app is deployed, it does not.
 */
function servedLocally(hostname = window.location.hostname): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost') ||
    /^127\./.test(hostname)
  )
}

/** Addresses that only resolve from the machine that typed them. */
function pointsAtCaller(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false // not a URL yet; let the reader keep typing
  }
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

/**
 * A warning to show under a connection field, or `null` when the URL is fine.
 *
 * The deployed API would answer this with a 400 anyway; saying it here saves a
 * round trip and puts the explanation next to the field that caused it.
 */
export function localTargetWarning(url: string): string | null {
  const trimmed = url.trim()
  if (trimmed === '' || servedLocally() || !pointsAtCaller(trimmed)) return null
  return (
    'This address points at your own machine, which the deployed pgdiff cannot ' +
    'reach. Use a database this site can dial, or run pgdiff locally.'
  )
}
