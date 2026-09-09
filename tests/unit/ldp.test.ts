import { describe, it, expect } from 'vitest'
import { Parser } from 'n3'
import {
  serializeContainer,
  formatContainerHtml,
  type AsCollectionOptions,
  type ContainerEntry
} from '../../src/ldp.js'

describe('serializeContainer', () => {
  it('emits the LDP BasicContainer type for the container itself', () => {
    const turtle = serializeContainer('/foo/', [])
    expect(turtle).toContain('@prefix ldp: <http://www.w3.org/ns/ldp#> .')
    expect(turtle).toContain('ldp:BasicContainer')
  })

  it('emits the LDP Container type alongside BasicContainer (Solid expects ldp:Container on the resource)', () => {
    const turtle = serializeContainer('/foo/', [])
    expect(turtle).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
  })

  it('omits ldp:contains for an empty container (valid Turtle)', () => {
    const turtle = serializeContainer('/foo/', [])
    expect(turtle).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*\./)
    expect(turtle).not.toMatch(/ldp:contains/)
  })

  it('parses as valid Turtle for empty containers (regression: solid client N3 parse error)', () => {
    const turtle = serializeContainer('/foo/', [])
    const parser = new Parser({ baseIRI: 'https://example.test/foo/' })
    expect(() => parser.parse(turtle)).not.toThrow()
    const quads = [...parser.parse(turtle)]
    expect(quads.length).toBeGreaterThan(0)
  })

  it('parses as valid Turtle for non-empty containers', () => {
    const entries: ContainerEntry[] = [
      { name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-1' },
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-2' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    const parser = new Parser({ baseIRI: 'https://example.test/foo/' })
    expect(() => parser.parse(turtle)).not.toThrow()
    const quads = [...parser.parse(turtle)]
    expect(quads.length).toBeGreaterThan(0)
  })

  it('lists children via ldp:contains for a non-empty container', () => {
    const entries: ContainerEntry[] = [
      { name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-bar' },
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-sub' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle).toMatch(/ldp:contains <bar\.txt>,\s*<sub\/>\s*\./)
  })

  it('types file children as ldp:Resource', () => {
    const entries: ContainerEntry[] = [
      { name: 'profile.ttl', path: 'alice/profile.ttl', type: 'file', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/alice/', entries)
    expect(turtle).toContain('<profile.ttl> a ldp:Resource .')
  })

  it('types directory children as ldp:BasicContainer and emits their URI with trailing slash', () => {
    const entries: ContainerEntry[] = [
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle).toContain('<sub/>')
    expect(turtle).toContain('ldp:BasicContainer')
  })

  it('types directory children as ldp:Container, ldp:BasicContainer (Solid sub-containers)', () => {
    const entries: ContainerEntry[] = [
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle).toMatch(/<sub\/>\s+a\s+ldp:Container,\s+ldp:BasicContainer/)
  })

  it('sorts children by path for deterministic output', () => {
    const entries: ContainerEntry[] = [
      { name: 'zeta', path: 'foo/zeta', type: 'file', sha: 'sha-z' },
      { name: 'alpha', path: 'foo/alpha', type: 'file', sha: 'sha-a' },
      { name: 'mu', path: 'foo/mu', type: 'file', sha: 'sha-m' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    const alphaIdx = turtle.indexOf('alpha')
    const muIdx = turtle.indexOf('mu')
    const zetaIdx = turtle.indexOf('zeta')
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(alphaIdx).toBeLessThan(muIdx)
    expect(muIdx).toBeLessThan(zetaIdx)
  })

  it('escapes Turtle-reserved characters in child names', () => {
    const entries: ContainerEntry[] = [
      { name: 'hello world.txt', path: 'foo/hello world.txt', type: 'file', sha: 'sha-1' },
      { name: 'with<bad>chars', path: 'foo/with<bad>chars', type: 'file', sha: 'sha-2' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle).not.toContain('hello world.txt>')
    expect(turtle).not.toContain('with<bad>chars>')
    expect(turtle).toMatch(/<hello%20world\.txt>/)
    expect(turtle).toMatch(/<with%3Cbad%3Echars>/)
  })

  it('strips the page prefix from child paths so children are relative to the container', () => {
    const entries: ContainerEntry[] = [
      { name: 'bar.txt', path: 'foo/bar.txt', type: 'file', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle).toContain('<bar.txt>')
    expect(turtle).not.toContain('<foo/bar.txt>')
  })

  it('strips the empty page prefix for the root container', () => {
    const entries: ContainerEntry[] = [
      { name: 'README.md', path: 'README.md', type: 'file', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/', entries)
    expect(turtle).toContain('<README.md>')
  })

  it('produces valid Turtle (basic structure check)', () => {
    const entries: ContainerEntry[] = [
      { name: 'a.txt', path: 'foo/a.txt', type: 'file', sha: 'sha-a' },
      { name: 'b', path: 'foo/b', type: 'dir', sha: 'sha-b' }
    ]
    const turtle = serializeContainer('/foo/', entries)
    expect(turtle.endsWith('\n')).toBe(true)
    expect(turtle).toMatch(/^@prefix ldp: <http:\/\/www\.w3\.org\/ns\/ldp#> \.\n/)
    expect(turtle).toMatch(/^<>\s+a\s+ldp:Container,\s+ldp:BasicContainer/m)
    expect(turtle).toContain('<a.txt> a ldp:Resource .')
    expect(turtle).toMatch(/<b\/>\s+a\s+ldp:Container,\s+ldp:BasicContainer \./)
  })
})

describe('formatContainerHtml', () => {
  it('emits a valid HTML5 document with the container title in the heading', () => {
    const html = formatContainerHtml('/foo/', 'Contents of foo', [
      { name: 'a.txt', path: 'foo/a.txt', type: 'file', sha: 'sha-a' }
    ])
    expect(html).toMatch(/<!doctype html>/i)
    expect(html).toMatch(/<html[^>]*>/)
    expect(html).toContain('<title>Contents of foo</title>')
    expect(html).toMatch(/<h1[^>]*>Contents of foo<\/h1>/)
  })

  it('emits a links list with one li per child for a non-empty container', () => {
    const html = formatContainerHtml('/foo/', 'Contents', [
      { name: 'a.txt', path: 'foo/a.txt', type: 'file', sha: 'sha-a' },
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-b' }
    ])
    expect(html).toMatch(/<a href="a\.txt">a\.txt<\/a>/)
    expect(html).toMatch(/<a href="sub\/?">sub\/<\/a>/)
  })

  it('marks directory children with a trailing slash in the link text', () => {
    const html = formatContainerHtml('/foo/', 'Contents', [
      { name: 'sub', path: 'foo/sub', type: 'dir', sha: 'sha-b' }
    ])
    expect(html).toMatch(/<a href="sub\/?">sub\/<\/a>/)
  })

  it('emits an empty-state message when there are no children', () => {
    const html = formatContainerHtml('/empty/', 'Contents of empty', [])
    expect(html).toMatch(/<p[^>]*>[\s\S]*Empty[\s\S]*<\/p>/i)
  })

  it('escapes HTML in child names to prevent injection', () => {
    const html = formatContainerHtml('/foo/', 'Contents', [
      { name: '<script>alert(1)</script>', path: 'foo/<script>alert(1)</script>', type: 'file', sha: 'sha-x' }
    ])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toMatch(/&lt;script&gt;/)
  })

  it('escapes HTML in the title', () => {
    const html = formatContainerHtml('/foo/', '<bad>&"</title>', [])
    expect(html).not.toContain('<bad>&"<\\/title>')
    expect(html).toMatch(/&lt;bad&gt;/)
  })

  it('includes a Content-Type hint or content metadata in a meta tag', () => {
    const html = formatContainerHtml('/foo/', 'Contents', [])
    expect(html).toMatch(/<meta[^>]*charset="utf-8"/)
  })

  it('escapes the href attribute for child names with special characters', () => {
    const html = formatContainerHtml('/foo/', 'Contents', [
      { name: 'a b.txt', path: 'foo/a b.txt', type: 'file', sha: 'sha-x' }
    ])
    expect(html).toMatch(/<a href="a%20b\.txt">a b\.txt<\/a>/)
  })
})

describe('serializeContainer with ActivityStreams options', () => {
  const sampleEntries: ContainerEntry[] = [
    { name: 'a.ttl', path: 'foo/a.ttl', type: 'file', sha: 'sha-a' },
    { name: 'b.ttl', path: 'foo/b.ttl', type: 'file', sha: 'sha-b' }
  ]

  it('leaves output unchanged when no `as` option is supplied', () => {
    const turtle = serializeContainer('/foo/', sampleEntries)
    expect(turtle).toContain('@prefix ldp: <http://www.w3.org/ns/ldp#> .')
    expect(turtle).not.toContain('activitystreams')
    expect(turtle).not.toContain('OrderedCollection')
    expect(turtle).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*;/)
  })

  it('types the resource as as:OrderedCollection when kind is "ordered_collection"', () => {
    const as: AsCollectionOptions = { kind: 'ordered_collection' }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:OrderedCollection')
    expect(turtle).not.toContain('as:OrderedCollectionPage')
    expect(turtle).toMatch(
      /<>\s+a\s+ldp:Container,\s+ldp:BasicContainer,\s+as:OrderedCollection/
    )
  })

  it('types the resource as as:OrderedCollectionPage when kind is "ordered_collection_page"', () => {
    const as: AsCollectionOptions = { kind: 'ordered_collection_page' }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:OrderedCollectionPage')
    expect(turtle).not.toMatch(/as:OrderedCollection\b/)
    expect(turtle).toMatch(
      /<>\s+a\s+ldp:Container,\s+ldp:BasicContainer,\s+as:OrderedCollectionPage/
    )
  })

  it('emits partOf, first, last, prev, next with the supplied IRIs', () => {
    const as: AsCollectionOptions = {
      kind: 'ordered_collection_page',
      partOf: 'https://example.test/changelog',
      first: 'https://example.test/changelog?page=1',
      last: 'https://example.test/changelog?page=9',
      prev: 'https://example.test/changelog?page=2',
      next: 'https://example.test/changelog?page=4'
    }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:partOf <https://example.test/changelog>')
    expect(turtle).toContain('as:first <https://example.test/changelog?page=1>')
    expect(turtle).toContain('as:last <https://example.test/changelog?page=9>')
    expect(turtle).toContain('as:prev <https://example.test/changelog?page=2>')
    expect(turtle).toContain('as:next <https://example.test/changelog?page=4>')
  })

  it('emits as:items with an abbreviated object list when items are supplied', () => {
    const as: AsCollectionOptions = {
      kind: 'ordered_collection_page',
      items: ['<#a>', '<#b>']
    }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:items <#a>, <#b>')
  })

  it('emits both as:items and other AS predicates when both are supplied', () => {
    const as: AsCollectionOptions = {
      kind: 'ordered_collection_page',
      partOf: 'https://example.test/changelog',
      items: ['<#a>', '<#b>']
    }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:partOf <https://example.test/changelog>')
    expect(turtle).toContain('as:items <#a>, <#b>')
  })

  it('emits as:items without any other AS predicates when only items are supplied', () => {
    const as: AsCollectionOptions = {
      kind: 'ordered_collection_page',
      items: ['<#only>']
    }
    const turtle = serializeContainer('/foo/', sampleEntries, as)
    expect(turtle).toContain('as:items <#only>')
    expect(turtle).not.toContain('as:partOf')
    expect(turtle).not.toContain('as:first')
    expect(turtle).not.toContain('as:last')
    expect(turtle).not.toContain('as:prev')
    expect(turtle).not.toContain('as:next')
  })
})

describe('serializeContainer with extras', () => {
  it('emits a single extra triple on the container subject for a non-empty container', () => {
    const entries: ContainerEntry[] = [
      { name: 'index.html', path: 'foo/index.html', type: 'file', sha: 'sha-1' }
    ]
    const turtle = serializeContainer('/foo/', entries, undefined, {
      'http://www.w3.org/ns/prov#wasGeneratedBy': '#activity'
    })
    expect(turtle).toMatch(
      /<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*;/
    )
    expect(turtle).toContain(
      '<http://www.w3.org/ns/prov#wasGeneratedBy> <#activity>'
    )
  })

  it('emits a single extra triple on the container subject for an empty container', () => {
    const turtle = serializeContainer('/foo/', [], undefined, {
      'http://www.w3.org/ns/prov#wasGeneratedBy': '#activity'
    })
    expect(turtle).not.toMatch(/ldp:contains/)
    expect(turtle).toMatch(
      /<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*;\s+<http:\/\/www\.w3\.org\/ns\/prov#wasGeneratedBy>\s+<#activity>\s*\./,
    )
  })

  it('emits multiple extra triples in the order they were declared', () => {
    const entries: ContainerEntry[] = [
      { name: 'a.txt', path: 'foo/a.txt', type: 'file', sha: 'sha-a' }
    ]
    const turtle = serializeContainer('/foo/', entries, undefined, {
      'http://www.w3.org/ns/prov#wasGeneratedBy': '#activity',
      'http://mementoweb.org/ns#original': '/foo/'
    })
    expect(turtle).toContain(
      '<http://www.w3.org/ns/prov#wasGeneratedBy> <#activity>'
    )
    expect(turtle).toContain(
      '<http://mementoweb.org/ns#original> </foo/>'
    )
    const wgbIdx = turtle.indexOf('prov#wasGeneratedBy')
    const origIdx = turtle.indexOf('mementoweb.org/ns#original')
    expect(wgbIdx).toBeGreaterThan(-1)
    expect(origIdx).toBeGreaterThan(wgbIdx)
  })

  it('emits multiple object IRIs as a comma-separated object list when the value is an array', () => {
    const turtle = serializeContainer('/foo/', [], undefined, {
      'http://example.org/p': ['a', 'b']
    })
    expect(turtle).toMatch(/<http:\/\/example\.org\/p>\s+<a>,\s+<b>\s*\./)
  })

  it('combines extras with the existing AS option without affecting AS predicates', () => {
    const as: AsCollectionOptions = {
      kind: 'ordered_collection_page',
      partOf: 'https://example.test/changelog'
    }
    const turtle = serializeContainer(
      '/foo/',
      [],
      as,
      {
        'http://www.w3.org/ns/prov#wasGeneratedBy': '#activity'
      },
    )
    expect(turtle).toContain('as:partOf <https://example.test/changelog>')
    expect(turtle).toContain(
      '<http://www.w3.org/ns/prov#wasGeneratedBy> <#activity>'
    )
  })

  it('parses as valid Turtle when extras are supplied', () => {
    const turtle = serializeContainer('/foo/', [], undefined, {
      'http://www.w3.org/ns/prov#wasGeneratedBy': '#activity',
      'http://mementoweb.org/ns#original': '/foo/'
    })
    const parser = new Parser({ baseIRI: 'https://example.test/foo/' })
    expect(() => parser.parse(turtle)).not.toThrow()
    const quads = [...parser.parse(turtle)]
    const wgb = quads.find(
      (q) =>
        q.predicate.value ===
        'http://www.w3.org/ns/prov#wasGeneratedBy'
    )
    expect(wgb?.object.value).toBe('https://example.test/foo/#activity')
    const orig = quads.find(
      (q) => q.predicate.value === 'http://mementoweb.org/ns#original'
    )
    expect(orig?.object.value).toBe('https://example.test/foo/')
  })

  it('omits a predicate entry whose value is an empty array', () => {
    const turtle = serializeContainer('/foo/', [], undefined, {
      'http://www.w3.org/ns/prov#wasGeneratedBy': [],
      'http://mementoweb.org/ns#original': '/foo/'
    })
    expect(turtle).not.toContain('prov#wasGeneratedBy')
    expect(turtle).toContain(
      '<http://mementoweb.org/ns#original> </foo/>'
    )
  })

  it('leaves output unchanged when extras is undefined or empty', () => {
    const turtle1 = serializeContainer('/foo/', [], undefined, undefined)
    const turtle2 = serializeContainer('/foo/', [], undefined, {})
    expect(turtle1).not.toContain('prov#')
    expect(turtle1).not.toContain('mementoweb.org')
    expect(turtle2).not.toContain('prov#')
    expect(turtle2).not.toContain('mementoweb.org')
  })
})
