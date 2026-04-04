import type { Operation } from '../types.js'

export interface DiffOptions {
  /**
   * Emit `DROP TABLE` / `DROP COLUMN` operations. When false the plan keeps
   * objects that only exist in the source, which is the safe default for
   * production roll-outs.
   */
  allowDestructive?: boolean
}

/**
 * Collects the operations a diff produces.
 *
 * Every `add` fills in the boilerplate an Operation needs but a caller should
 * not have to repeat: a unique id, and an empty dependency list. Ids matter —
 * tables use a predictable one (`create_table:public.users`) so foreign keys
 * can name their parent before it has been built.
 */
export class OperationBuilder {
  private seq = 0
  readonly operations: Operation[] = []
  readonly warnings: string[] = []

  add(op: Omit<Operation, 'id' | 'deps'> & { id?: string; deps?: string[] }): Operation {
    const operation: Operation = {
      ...op,
      id: op.id ?? `${op.kind}:${op.object}:${this.seq++}`,
      deps: op.deps ?? [],
    }
    this.operations.push(operation)
    return operation
  }
}

/** Sorted union of two key lists, so both sides of a diff are walked together. */
export function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort()
}

export function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Stable name order, so the same schemas always diff to the same plan. */
export function sortedByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((x, y) => x.name.localeCompare(y.name))
}
