import { useState } from 'react'

interface Props {
  sql: string
  filename: string
}

export function SqlView({ sql, filename }: Props) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function download() {
    const url = URL.createObjectURL(new Blob([sql], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={download}>Download {filename}</button>
      </div>
      <pre className="sql">
        {sql.split('\n').map((line, index) => (
          <span key={index} className={lineClass(line)}>
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}

function lineClass(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('--   !') || trimmed.startsWith('-- NOTE')) return 'warn'
  return trimmed.startsWith('--') ? 'comment' : ''
}
