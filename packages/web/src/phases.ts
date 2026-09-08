/**
 * Display labels for the planner's ordering phases.
 *
 * Kept as a local copy rather than imported from `@pgdiff/core`: that package's
 * entry point pulls in `pg`, which has no place in a browser bundle.
 */
export const PHASE_LABELS: Record<number, string> = {
  10: 'create schemas',
  20: 'create enum types',
  25: 'alter enum types',
  30: 'drop foreign keys',
  35: 'drop constraints',
  36: 'drop indexes',
  40: 'create tables',
  45: 'add columns',
  50: 'alter columns',
  55: 'drop columns',
  60: 'create indexes',
  65: 'add constraints',
  70: 'add foreign keys',
  75: 'comments',
  80: 'drop tables',
  90: 'drop enum types',
}
