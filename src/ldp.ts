export interface ContainerEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule' | string
  sha: string
}

export interface AsCollectionOptions {
  kind: 'ordered_collection' | 'ordered_collection_page'
  partOf?: string
  first?: string
  last?: string
  prev?: string
  next?: string
  items?: string[]
}

const LDP_NS = 'http://www.w3.org/ns/ldp#'
const AS_NS = 'https://www.w3.org/ns/activitystreams#'

function turtleEscape(value: string): string {
  let out = value
  out = out.replace(/\\/g, '\\\\')
  out = out.replace(/ /g, '%20')
  out = out.replace(/"/g, '%22')
  out = out.replace(/</g, '%3C')
  out = out.replace(/>/g, '%3E')
  out = out.replace(/\(/g, '%28')
  out = out.replace(/\)/g, '%29')
  out = out.replace(/\[/g, '%5B')
  out = out.replace(/\]/g, '%5D')
  out = out.replace(/\t/g, '%09')
  out = out.replace(/\n/g, '%0A')
  out = out.replace(/\r/g, '%0D')
  return out
}

function relativeChildPath(containerUri: string, entry: ContainerEntry): string {
  const normalized = containerUri.replace(/^\/+|\/+$/g, '')
  const stripped =
    normalized && entry.path === normalized
      ? ''
      : normalized && entry.path.startsWith(`${normalized}/`)
        ? entry.path.slice(normalized.length + 1)
        : entry.path
  return entry.type === 'dir' ? `${stripped}/` : stripped
}

function childType(entry: ContainerEntry): string {
  return entry.type === 'dir' ? 'ldp:Container, ldp:BasicContainer' : 'ldp:Resource'
}

function containerType(): string {
  return 'ldp:Container, ldp:BasicContainer'
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function hrefEscape(value: string): string {
  return encodeURIComponent(value)
}

function formatChildHref(containerUri: string, entry: ContainerEntry): string {
  const relative = relativeChildPath(containerUri, entry)
  if (entry.type === 'dir') {
    return relative.replace(/\/+$/, '') + '/'
  }
  return relative
}

function hrefEncode(value: string): string {
  return value
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

function formatChildLabel(entry: ContainerEntry): string {
  if (entry.type === 'dir') {
    const trimmed = entry.name.replace(/\/+$/, '')
    return `${trimmed}/`
  }
  return entry.name
}

export function formatContainerHtml(
  containerUri: string,
  title: string,
  entries: ContainerEntry[]
): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const safeTitle = htmlEscape(title)

  const body: string[] = []
  body.push('<!doctype html>')
  body.push('<html lang="en">')
  body.push('<head>')
  body.push('<meta charset="utf-8">')
  body.push(`<title>${safeTitle}</title>`)
  body.push('</head>')
  body.push('<body>')
  body.push(`<h1>${safeTitle}</h1>`)

  if (sorted.length === 0) {
    body.push('<p>(Empty container)</p>')
  } else {
    body.push('<ul>')
    for (const entry of sorted) {
      const href = hrefEncode(formatChildHref(containerUri, entry))
      const label = htmlEscape(formatChildLabel(entry))
      body.push(`<li><a href="${href}">${label}</a></li>`)
    }
    body.push('</ul>')
  }

  body.push('</body>')
  body.push('</html>')
  return body.join('\n') + '\n'
}

export type Extras = Record<string, string | string[]>

export function serializeContainer(
  containerUri: string,
  entries: ContainerEntry[],
  as?: AsCollectionOptions,
  extras?: Extras
): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const lines: string[] = [`@prefix ldp: <${LDP_NS}> .`]
  if (as) lines.push(`@prefix as: <${AS_NS}> .`)
  lines.push('')

  const children = sorted.map((e) => `<${turtleEscape(relativeChildPath(containerUri, e))}>`)

  const asTypeName =
    as?.kind === 'ordered_collection' ? 'OrderedCollection' : 'OrderedCollectionPage'
  const typeList = as
    ? `ldp:Container, ldp:BasicContainer, as:${asTypeName}`
    : containerType()

  const tail: string[] = []
  if (children.length > 0) tail.push(`   ldp:contains ${children.join(', ')}`)
  if (as) {
    if (as.partOf) tail.push(`   as:partOf <${as.partOf}>`)
    if (as.first) tail.push(`   as:first <${as.first}>`)
    if (as.last) tail.push(`   as:last <${as.last}>`)
    if (as.prev) tail.push(`   as:prev <${as.prev}>`)
    if (as.next) tail.push(`   as:next <${as.next}>`)
    if (as.items && as.items.length > 0) tail.push(`   as:items ${as.items.join(', ')}`)
  }
  if (extras) {
    for (const [predicate, value] of Object.entries(extras)) {
      const values = Array.isArray(value) ? value : [value]
      const filtered = values.filter((v) => v.length > 0)
      if (filtered.length === 0) continue
      const objs = filtered.map((v) => `<${v}>`).join(', ')
      tail.push(`   <${predicate}> ${objs}`)
    }
  }

  if (tail.length === 0) {
    lines.push(`<> a ${typeList} .`)
  } else {
    lines.push(`<> a ${typeList} ;`)
    for (let i = 0; i < tail.length; i++) {
      lines.push(`${tail[i]}${i === tail.length - 1 ? ' .' : ' ;'}`)
    }
  }
  lines.push('')
  for (const entry of sorted) {
    const child = `<${turtleEscape(relativeChildPath(containerUri, entry))}>`
    lines.push(`${child} a ${childType(entry)} .`)
  }
  return `${lines.join('\n')}\n`
}
