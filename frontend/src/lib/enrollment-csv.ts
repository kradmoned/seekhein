export type CsvPreview = { emails: string[]; duplicates: number; errors: string[] }

/** Reads a UTF-8 CSV with an email header, including quoted fields and CRLF. */
export function enrollmentCsv(source: string): CsvPreview {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false, closed = false
  const input = source.replace(/^\uFEFF/, '')
  for (let i = 0; i <= input.length; i++) {
    const char = input[i]
    if (quoted) {
      if (char === undefined) throw Error('The CSV has an unclosed quoted field.')
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closed = true }
      } else field += char
      continue
    }
    if (char === '"') {
      if (field || closed) throw Error('The CSV contains a misplaced quote.')
      quoted = true
    } else if (char === ',' || char === '\r' || char === '\n' || char === undefined) {
      row.push(field); field = ''; closed = false
      if (char !== ',') {
        if (row.some(value => value.trim())) rows.push(row)
        row = []
        if (char === '\r' && input[i + 1] === '\n') i++
      }
    } else {
      if (closed) { if (char.trim()) throw Error('Unexpected text after a quoted field.'); continue }
      field += char
    }
  }
  if (!rows.length) throw Error('The CSV is empty.')
  const headers = rows.shift()!.map(value => value.trim().toLowerCase())
  const column = headers.indexOf('email')
  if (column === -1 || headers.filter(value => value === 'email').length !== 1) throw Error('Include exactly one column named email in the first row.')
  if (!rows.length) throw Error('Add at least one student email below the header.')
  if (rows.length > 200) throw Error('Import up to 200 students at a time. Split this CSV into smaller files.')
  const emails: string[] = [], errors: string[] = [], seen = new Set<string>()
  let duplicates = 0
  rows.forEach((row, index) => {
    const email = (row[column] ?? '').trim()
    if (row.length !== headers.length || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email) || email.length > 254) {
      errors.push(`Data row ${index + 1}: enter a valid email and match the header’s column count.`)
      return
    }
    const key = email.toLowerCase()
    if (seen.has(key)) duplicates++
    else { seen.add(key); emails.push(email) }
  })
  return { emails, duplicates, errors }
}
