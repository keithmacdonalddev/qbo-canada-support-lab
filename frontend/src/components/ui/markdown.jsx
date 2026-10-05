// Renders the small Markdown subset the assistant writes: headings, bold,
// italics, inline code, bullet and numbered lists, tables and paragraphs.
// Everything becomes React elements (no HTML injection), so model text stays inert.

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g

function inline(text, keyPrefix) {
  return String(text).split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key} className="font-semibold">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key} className="rounded bg-[var(--sunken)] px-1 py-px font-mono text-[0.92em]">{part.slice(1, -1)}</code>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>
    return part
  })
}

const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
const isTableRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)

function blocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { out.push({ type: 'heading', text: heading[2] }); i += 1; continue }
    if (line.trim().startsWith('|') && isTableRule(lines[i + 1] || '')) {
      const head = cells(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i += 1 }
      out.push({ type: 'table', head, rows })
      continue
    }
    const listMatch = (l) => /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(l)
    if (listMatch(line)) {
      const ordered = /^\s*\d/.test(line)
      const items = []
      while (i < lines.length && listMatch(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        const m = listMatch(lines[i])
        items.push({ marker: m[1], text: m[2] })
        i += 1
      }
      out.push({ type: ordered ? 'ol' : 'ul', items })
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !listMatch(lines[i]) && !lines[i].trim().startsWith('|')) {
      para.push(lines[i])
      i += 1
    }
    if (para.length) out.push({ type: 'p', lines: para })
    else { out.push({ type: 'p', lines: [line] }); i += 1 }
  }
  return out
}

export function Markdown({ text }) {
  return (
    <div className="flex flex-col gap-2.5">
      {blocks(text).map((b, n) => {
        const k = `b${n}`
        if (b.type === 'heading') return <h3 key={k} className="mt-1 text-[14px] font-semibold">{inline(b.text, k)}</h3>
        if (b.type === 'ul' || b.type === 'ol') {
          const List = b.type
          return (
            <List key={k} className={b.type === 'ul' ? 'list-disc pl-5' : 'list-decimal pl-7'}>
              {b.items.map((item, j) => (
                <li key={j} value={b.type === 'ol' ? parseInt(item.marker, 10) || undefined : undefined}>{inline(item.text, `${k}-${j}`)}</li>
              ))}
            </List>
          )
        }
        if (b.type === 'table') {
          return (
            <div key={k} className="overflow-x-auto rounded-[8px] border border-[var(--line)]">
              <table className="w-full border-collapse text-[12.5px]">
                <thead className="bg-[var(--surface-muted)] text-left">
                  <tr>{b.head.map((h, j) => <th key={j} className="border-b border-[var(--line)] px-2.5 py-1.5 font-medium">{inline(h, `${k}-h${j}`)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r} className="border-b border-[var(--line)] last:border-0 align-top">
                      {row.map((c, j) => <td key={j} className="px-2.5 py-1.5">{inline(c, `${k}-${r}-${j}`)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return (
          <p key={k}>
            {b.lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l, `${k}-${j}`)}</span>)}
          </p>
        )
      })}
    </div>
  )
}
