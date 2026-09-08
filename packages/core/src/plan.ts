import { PHASE_LABELS } from './phases.js'
import type { Migration, MigrationOptions, Operation, Plan } from './types.js'

/**
 * Order operations for the up migration: phase first, then a topological sort
 * over the dependency edges recorded inside each phase, then object name so the
 * output is stable across runs.
 */
export function orderOperations(operations: Operation[]): { ordered: Operation[]; warnings: string[] } {
  const warnings: string[] = []
  const byId = new Map(operations.map((op) => [op.id, op]))
  const phases = [...new Set(operations.map((op) => op.phase))].sort((a, b) => a - b)
  const ordered: Operation[] = []

  for (const phase of phases) {
    const group = operations
      .filter((op) => op.phase === phase)
      .sort((a, b) => a.object.localeCompare(b.object) || a.id.localeCompare(b.id))

    const inGroup = new Set(group.map((op) => op.id))
    for (const op of group) {
      for (const dep of op.deps) {
        const target = byId.get(dep)
        // A dependency in a later phase would never run in time; that is a bug
        // in the planner rather than something the caller can fix, so surface it.
        if (target && target.phase > op.phase) {
          warnings.push(`${op.id} depends on ${dep}, which is scheduled later; review the generated order.`)
        }
      }
    }

    const result = topoSort(group, (op) => op.deps.filter((dep) => inGroup.has(dep)))
    if (result.cycle.length > 0) {
      warnings.push(
        `Dependency cycle in "${PHASE_LABELS[phase] ?? phase}" between ${result.cycle.join(', ')}; ` +
          'emitted in name order — foreign keys are created as separate statements so this stays valid.',
      )
    }
    ordered.push(...result.ordered)
  }

  return { ordered, warnings }
}

/** Kahn's algorithm, preserving input order among ready nodes. */
function topoSort(
  nodes: Operation[],
  depsOf: (op: Operation) => string[],
): { ordered: Operation[]; cycle: string[] } {
  const remaining = new Map(nodes.map((op) => [op.id, new Set(depsOf(op))]))
  const ordered: Operation[] = []

  while (remaining.size > 0) {
    const ready = nodes.filter((op) => remaining.get(op.id)?.size === 0)
    if (ready.length === 0) {
      // Everything left is part of (or blocked by) a cycle. Emit it in input
      // order so the plan is still complete, and report the members.
      const cycle = [...remaining.keys()]
      for (const op of nodes) if (remaining.has(op.id)) ordered.push(op)
      return { ordered, cycle }
    }
    for (const op of ready) {
      ordered.push(op)
      remaining.delete(op.id)
    }
    for (const deps of remaining.values()) {
      for (const op of ready) deps.delete(op.id)
    }
  }

  return { ordered, cycle: [] }
}

/** Apply the ordering to a raw diff result. */
export function orderPlan(plan: Plan): Plan {
  const { ordered, warnings } = orderOperations(plan.operations)
  return { operations: ordered, warnings: [...plan.warnings, ...warnings] }
}

/**
 * Render SQL. `down` is the ordered plan reversed, with each operation
 * contributing its own inverse — that is what makes the pair reversible.
 */
export function renderMigration(plan: Plan, options: MigrationOptions = {}): Migration {
  const annotate = options.annotate !== false
  const canWrap = plan.operations.every((op) => op.transactional)
  const wrap = options.transaction !== false && canWrap

  const up = render(plan.operations, 'up', { annotate, wrap, canWrap })
  const down = render([...plan.operations].reverse(), 'down', { annotate, wrap, canWrap })
  return { up, down, plan }
}

function render(
  operations: Operation[],
  direction: 'up' | 'down',
  opts: { annotate: boolean; wrap: boolean; canWrap: boolean },
): string {
  const lines: string[] = []
  lines.push(`-- pgdiff ${direction} migration`)
  if (operations.length === 0) {
    lines.push('-- no changes')
    return lines.join('\n') + '\n'
  }
  if (!opts.canWrap) {
    lines.push('-- NOTE: not wrapped in a transaction (contains ALTER TYPE ... ADD VALUE)')
  }
  lines.push('')
  if (opts.wrap) lines.push('BEGIN;', '')

  let phase: number | null = null
  for (const op of operations) {
    if (opts.annotate) {
      // Phase headers only make sense reading forwards; the down migration is
      // annotated per operation instead.
      if (direction === 'up' && op.phase !== phase) {
        phase = op.phase
        lines.push(`-- ${(PHASE_LABELS[op.phase] ?? `phase ${op.phase}`).toUpperCase()}`)
      }
      lines.push(direction === 'up' ? `-- ${op.summary}` : `-- revert: ${op.summary}`)
      if (direction === 'up') {
        for (const warning of op.warnings) lines.push(`--   ! ${warning}`)
      }
    }
    for (const statement of op[direction]) lines.push(`${statement};`)
    lines.push('')
  }

  if (opts.wrap) lines.push('COMMIT;')
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
