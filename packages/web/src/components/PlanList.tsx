import { phaseLabel } from '@pgdiff/core'
import type { Operation } from '../api'

/**
 * Operation kinds are named `create_*` / `add_*` / `drop_*` / everything else,
 * so the badge colour follows the name rather than a list that has to be kept
 * in step with the core's ChangeKind union.
 */
function badgeClass(kind: string): string {
  if (kind.startsWith('drop_')) return 'badge drop'
  if (kind.startsWith('create_') || kind.startsWith('add_')) return 'badge add'
  return 'badge alter'
}

/** Operations arrive in execution order, so grouping is just a running heading. */
function groupByPhase(operations: Operation[]): Array<{ phase: number; items: Operation[] }> {
  const groups: Array<{ phase: number; items: Operation[] }> = []
  for (const op of operations) {
    const last = groups[groups.length - 1]
    if (last && last.phase === op.phase) last.items.push(op)
    else groups.push({ phase: op.phase, items: [op] })
  }
  return groups
}

export function PlanList({ operations }: { operations: Operation[] }) {
  if (operations.length === 0) {
    return <p className="notice empty">The two schemas already match — nothing to migrate.</p>
  }

  return (
    <div>
      {groupByPhase(operations).map((group) => (
        <div key={group.phase}>
          <h3 className="phase-heading">{phaseLabel(group.phase)}</h3>
          <ul className="ops">
            {group.items.map((op) => (
              <li key={op.id}>
                <span className={badgeClass(op.kind)}>{op.kind}</span>
                <div className="op-body">
                  <div className="op-summary">{op.summary}</div>
                  {op.warnings.map((warning) => (
                    <div className="op-warning" key={warning}>! {warning}</div>
                  ))}
                </div>
                {op.lossy && <span className="badge drop">lossy</span>}
                {!op.transactional && <span className="badge alter">no txn</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
