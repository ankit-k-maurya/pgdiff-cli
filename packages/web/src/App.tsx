import { useState } from 'react'
import { ConnectionPanel } from './components/ConnectionPanel'
import { OptionsPanel } from './components/OptionsPanel'
import { PlanList } from './components/PlanList'
import { SqlView } from './components/SqlView'
import { useDiff } from './useDiff'

type Tab = 'plan' | 'up' | 'down'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'up', label: 'Up SQL' },
  { id: 'down', label: 'Down SQL' },
]

export function App() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [schemas, setSchemas] = useState('public')
  const [allowDestructive, setAllowDestructive] = useState(false)
  const [transaction, setTransaction] = useState(true)
  const [tab, setTab] = useState<Tab>('plan')

  const { migration, error, busy, compare } = useDiff()
  const ready = from.trim().length > 0 && to.trim().length > 0

  async function onCompare() {
    await compare({ from, to, schemas, allowDestructive, transaction })
    setTab('plan')
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

      <OptionsPanel
        schemas={schemas}
        onSchemasChange={setSchemas}
        allowDestructive={allowDestructive}
        onAllowDestructiveChange={setAllowDestructive}
        transaction={transaction}
        onTransactionChange={setTransaction}
      />

      <div className="toolbar">
        <button className="primary" onClick={onCompare} disabled={!ready || busy}>
          {busy ? 'Comparing…' : 'Compare schemas'}
        </button>
        <span className="spacer" />
        {migration && <span className="count">{migration.plan.operations.length} operation(s)</span>}
      </div>

      {error && <p className="notice error">{error}</p>}
      {migration?.plan.warnings.map((warning) => (
        <p className="notice warn" key={warning}>{warning}</p>
      ))}

      {migration && (
        <>
          <nav className="tabs">
            {TABS.map(({ id, label }) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === 'plan' && <PlanList operations={migration.plan.operations} />}
          {tab === 'up' && <SqlView sql={migration.up} filename="migration.up.sql" />}
          {tab === 'down' && <SqlView sql={migration.down} filename="migration.down.sql" />}
        </>
      )}
    </div>
  )
}
