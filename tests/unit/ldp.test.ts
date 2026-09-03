import { describe, it, expect } from 'vitest'
import { serializeContainer, type ContainerEntry } from '../../src/ldp.js'

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

  it('emits an empty contains list when there are no entries', () => {
    const turtle = serializeContainer('/foo/', [])
    expect(turtle).toMatch(/<>\s+a\s+ldp:Container,\s+ldp:BasicContainer\s*;\s*\n\s*ldp:contains\s*\./)
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
