type AcceptEntry = { type: string; q: number; order: number }

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const TURTLE_TYPES = new Set(['text/turtle', 'text/n3'])

export function parseAcceptHeader(header: string): AcceptEntry[] {
  return header.split(',').map((part, idx) => {
    const segments = part.trim().split(';').map((s) => s.trim())
    const type = segments[0].toLowerCase()
    let q = 1.0
    for (const seg of segments.slice(1)) {
      const [k, v] = seg.split('=')
      if (k.toLowerCase() === 'q') {
        const n = parseFloat(v)
        if (Number.isFinite(n)) q = Math.max(0, Math.min(1, n))
      }
    }
    return { type, q, order: idx }
  })
}

function bestMatch(parsed: AcceptEntry[], family: Set<string>): AcceptEntry | null {
  let best: AcceptEntry | null = null
  for (const e of parsed) {
    if (!family.has(e.type)) continue
    if (
      best === null ||
      e.q > best.q ||
      (e.q === best.q && e.order < best.order)
    ) {
      best = e
    }
  }
  return best
}

export function wantsHtmlOverTurtle(acceptHeader: string | null): boolean {
  if (!acceptHeader) return false
  const parsed = parseAcceptHeader(acceptHeader)
  const html = bestMatch(parsed, HTML_TYPES)
  const turtle = bestMatch(parsed, TURTLE_TYPES)
  if (!html && !turtle) return false
  if (!html) return false
  if (!turtle) return true
  return html.q > turtle.q || (html.q === turtle.q && html.order < turtle.order)
}
