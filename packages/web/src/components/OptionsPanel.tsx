interface Props {
  schemas: string
  onSchemasChange: (value: string) => void
  allowDestructive: boolean
  onAllowDestructiveChange: (value: boolean) => void
  transaction: boolean
  onTransactionChange: (value: boolean) => void
}

export function OptionsPanel({
  schemas,
  onSchemasChange,
  allowDestructive,
  onAllowDestructiveChange,
  transaction,
  onTransactionChange,
}: Props) {
  return (
    <section className="panel options">
      <h2>Options</h2>

      <div className="row">
        <div className="field">
          <label htmlFor="schemas">Schemas (comma separated)</label>
          <input
            id="schemas"
            type="text"
            value={schemas}
            onChange={(event) => onSchemasChange(event.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allowDestructive}
            onChange={(event) => onAllowDestructiveChange(event.target.checked)}
          />
          Allow destructive changes (DROP TABLE / DROP COLUMN)
        </label>
      </div>

      <div className="row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={transaction}
            onChange={(event) => onTransactionChange(event.target.checked)}
          />
          Wrap in a transaction when every statement allows it
        </label>
      </div>
    </section>
  )
}
