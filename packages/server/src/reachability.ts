import { HttpError } from './http.js'

/**
 * Whether this process is running somewhere that cannot see the caller's own
 * machine -- a serverless function, a container, any deployed host.
 *
 * `VERCEL` is set on every Vercel build and invocation. `PGDIFF_HOSTED` lets
 * any other deployment opt in, and `PGDIFF_ALLOW_LOCAL_TARGETS` lets a host
 * that genuinely does share a network with its databases opt back out.
 */
export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PGDIFF_ALLOW_LOCAL_TARGETS === '1') return false
  return env.VERCEL === '1' || env.PGDIFF_HOSTED === '1'
}

/**
 * The hostname a connection URL points at, lowercased and without the brackets
 * the URL parser keeps around IPv6 literals. `null` when the string is not a
 * URL we can read; the driver reports those better than we can.
 */
export function connectionHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/**
 * Addresses that only resolve to something useful from the machine that typed
 * them: loopback, link-local, and the RFC 1918 ranges behind a home or office
 * router. A deployed pgdiff reaches none of them.
 */
export function isLocalHost(host: string): boolean {
  if (host === '') return true // unix socket, e.g. ?host=/var/run/postgresql
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  return false
}

/**
 * Refuse a connection this server provably cannot make, before the driver
 * spends the request timing out against its own loopback interface.
 *
 * The raw failure is `connect ECONNREFUSED 127.0.0.1:5441`, which reads as a
 * bug in pgdiff rather than what it is: a database that is only reachable from
 * the reader's own machine.
 */
export function assertReachable(url: string, label: string): void {
  const host = connectionHost(url)
  if (host === null || !isHosted() || !isLocalHost(host)) return

  throw new HttpError(
    400,
    `The "${label}" database is at ${host || 'a local socket'}, which points at this ` +
      'server rather than at your computer. A deployed pgdiff cannot reach a database ' +
      'running on your machine. Use a connection URL this server can dial -- a hosted ' +
      'Postgres such as Neon, Supabase or RDS, or a tunnel to your local instance -- or ' +
      'run pgdiff locally with `npm run dev`, where localhost means your machine.',
  )
}
