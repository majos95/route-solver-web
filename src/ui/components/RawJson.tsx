interface Props {
  label: string
  data: unknown
  defaultOpen?: boolean
}

export function RawJson({ label, data, defaultOpen = false }: Props) {
  return (
    <details className="raw-json" open={defaultOpen}>
      <summary className="raw-json-summary">{label}</summary>
      <pre className="raw-json-body">
        <code>{JSON.stringify(data, null, 2)}</code>
      </pre>
    </details>
  )
}
