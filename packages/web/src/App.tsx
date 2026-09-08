import { useState } from 'react'
import { runDiff, type Migration } from './api'
import { ConnectionPanel } from './components/ConnectionPanel'
import { PlanList } from './components/PlanList'
import { SqlView } from './components/SqlView'

type Tab = 'plan' | 'up' | 'down'

export function App() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [schemas, setSchemas] = useState('public')
  const [allowDestructive, setAllowDestructive] = useState(false)
  const [transaction, setTransaction] = useState(true)
  const [migration, setMigration] = useState<Migration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('plan')

  const ready = from.trim().length > 0 && to.trim().length > 0

  async function compare() {
    setBusy(true)
    setError(null)
    try {
      const result = await runDiff({
        from: { url: from.trim() },
        to: { url: to.trim() },
        schemas: schemas.split(',').map((s) => s.trim()).filter(Boolean),
        allowDestructive,
        transaction,
      })
      setMigration(result)
      setTab('plan')
    } catch (cause) {
      setMigration(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="masthead">
        <h1>pgdiff</h1>
        <p>Diff two live PostgreSQL schemas into a reversible migration.</p>
      </header>

      <div className="grid">
        <ConnectionPanel
          title="Source"
          hint="The schema you are migrating from — usually production."
          value={from}
          onChange={setFrom}
        />
        <ConnectionPanel
          title="Target"
          hint="The schema you are migrating to — usually a dev or shadow database."
          value={to}
          onChange={setTo}
        />
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Options</h2>
        <div className="row">
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="schemas">Schemas (comma separated)</label>
            <input
              id="schemas"
              type="text"
              value={schemas}
              onChange={(event) => setSchemas(event.target.value)}
            />
          </div>
        </div>
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={allowDestructive}
              onChange={(event) => setAllowDestructive(event.target.checked)}
            />
            Allow destructive changes (DROP TABLE / DROP COLUMN)
          </label>
        </div>
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={transaction}
              onChange={(event) => setTransaction(event.target.checked)}
            />
            Wrap in a transaction when every statement allows it
          </label>
        </div>
      </section>

      <div className="toolbar">
        <button className="primary" onClick={compare} disabled={!ready || busy}>
          {busy ? 'Comparing…' : 'Compare schemas'}
        </button>
        <span className="spacer" />
        {migration && (
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>
            {migration.plan.operations.length} operation(s)
          </span>
        )}
      </div>

      {error && <p className="notice error">{error}</p>}
      {migration?.plan.warnings.map((warning) => (
        <p className="notice warn" key={warning}>{warning}</p>
      ))}

      {migration && (
        <>
          <nav className="tabs">
            <button className={tab === 'plan' ? 'active' : ''} onClick={() => setTab('plan')}>Plan</button>
            <button className={tab === 'up' ? 'active' : ''} onClick={() => setTab('up')}>Up SQL</button>
            <button className={tab === 'down' ? 'active' : ''} onClick={() => setTab('down')}>Down SQL</button>
          </nav>
          {tab === 'plan' && <PlanList operations={migration.plan.operations} />}
          {tab === 'up' && <SqlView sql={migration.up} filename="migration.up.sql" />}
          {tab === 'down' && <SqlView sql={migration.down} filename="migration.down.sql" />}
        </>
      )}
    </div>
  )
}
