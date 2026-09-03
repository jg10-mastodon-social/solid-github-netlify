export interface ContainerEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule' | string
  sha: string
}

const LDP_NS = 'http://www.w3.org/ns/ldp#'

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

export function serializeContainer(containerUri: string, entries: ContainerEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const lines: string[] = [`@prefix ldp: <${LDP_NS}> .`, '']
  const children = sorted.map((e) => `<${turtleEscape(relativeChildPath(containerUri, e))}>`)
  if (children.length === 0) {
    lines.push(`<> a ${containerType()} ;`)
    lines.push('   ldp:contains .')
  } else {
    lines.push(`<> a ${containerType()} ;`)
    lines.push(`   ldp:contains ${children.join(', ')} .`)
  }
  lines.push('')
  for (const entry of sorted) {
    const child = `<${turtleEscape(relativeChildPath(containerUri, entry))}>`
    lines.push(`${child} a ${childType(entry)} .`)
  }
  return `${lines.join('\n')}\n`
}
