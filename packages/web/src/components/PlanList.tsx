import type { Operation } from '../api'
import { PHASE_LABELS } from '../phases'

const DROP_KINDS = new Set([
  'drop_schema', 'drop_enum', 'drop_table', 'drop_column', 'drop_constraint',
  'drop_foreign_key', 'drop_index', 'drop_default', 'drop_not_null', 'drop_identity',
])
const ADD_KINDS = new Set([
  'create_schema', 'create_enum', 'create_table', 'create_index', 'add_column',
  'add_constraint', 'add_foreign_key', 'add_enum_value', 'add_identity', 'set_default',
  'set_not_null',
])

function badgeClass(kind: string): string {
  if (DROP_KINDS.has(kind)) return 'badge drop'
  if (ADD_KINDS.has(kind)) return 'badge add'
  return 'badge alter'
}

export function PlanList({ operations }: { operations: Operation[] }) {
  if (operations.length === 0) {
    return <p className="notice empty">The two schemas already match — nothing to migrate.</p>
  }

  // Operations arrive in execution order, so grouping is just a running heading.
  const groups: Array<{ phase: number; items: Operation[] }> = []
  for (const op of operations) {
    const last = groups[groups.length - 1]
    if (last && last.phase === op.phase) last.items.push(op)
    else groups.push({ phase: op.phase, items: [op] })
  }

  return (
    <div>
      {groups.map((group) => (
        <div key={group.phase}>
          <h3 className="phase-heading">{PHASE_LABELS[group.phase] ?? `phase ${group.phase}`}</h3>
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
