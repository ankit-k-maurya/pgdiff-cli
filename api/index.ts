import app from '@pgdiff/server/app'

// vercel.json rewrites every /api/* request to this single function, and
// Express dispatches on the original path.
export default app
