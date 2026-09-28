import { localTargetWarning } from '../localTarget'

interface Props {
  title: string
  hint: string
  value: string
  onChange: (value: string) => void
}

export function ConnectionPanel({ title, hint, value, onChange }: Props) {
  const warning = localTargetWarning(value)

  return (
    <section className="panel">
      <h2>{title}</h2>
      <label htmlFor={`conn-${title}`}>{hint}</label>
      <input
        id={`conn-${title}`}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="postgresql://user:password@host:5432/database"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {warning && <p className="notice warn field-notice">{warning}</p>}
    </section>
  )
}
