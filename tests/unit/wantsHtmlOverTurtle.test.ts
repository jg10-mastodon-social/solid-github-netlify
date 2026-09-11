import { describe, it, expect } from 'vitest'
import { wantsHtmlOverTurtle, parseAcceptHeader } from '../../src/wantsHtmlOverTurtle.js'

describe('parseAcceptHeader', () => {
  it('parses a single media type with default q=1', () => {
    expect(parseAcceptHeader('text/html')).toEqual([
      { type: 'text/html', q: 1, order: 0 }
    ])
  })

  it('parses multiple media types with their order', () => {
    const result = parseAcceptHeader('text/html, text/turtle')
    expect(result).toEqual([
      { type: 'text/html', q: 1, order: 0 },
      { type: 'text/turtle', q: 1, order: 1 }
    ])
  })

  it('parses q-values', () => {
    const result = parseAcceptHeader('text/html;q=0.5, text/turtle;q=0.9')
    expect(result).toEqual([
      { type: 'text/html', q: 0.5, order: 0 },
      { type: 'text/turtle', q: 0.9, order: 1 }
    ])
  })

  it('clamps q to [0, 1]', () => {
    const result = parseAcceptHeader('text/html;q=2.0, text/turtle;q=-0.3')
    expect(result[0].q).toBe(1)
    expect(result[1].q).toBe(0)
  })

  it('preserves media type case-insensitively', () => {
    expect(parseAcceptHeader('TEXT/HTML')[0].type).toBe('text/html')
  })
})

describe('wantsHtmlOverTurtle', () => {
  it('returns false when Accept header is missing (default to Turtle)', () => {
    expect(wantsHtmlOverTurtle(null)).toBe(false)
  })

  it('returns false for an empty Accept header', () => {
    expect(wantsHtmlOverTurtle('')).toBe(false)
  })

  it('returns true when only text/html is requested', () => {
    expect(wantsHtmlOverTurtle('text/html')).toBe(true)
  })

  it('returns true when application/xhtml+xml is requested', () => {
    expect(wantsHtmlOverTurtle('application/xhtml+xml')).toBe(true)
  })

  it('returns false when only text/turtle is requested', () => {
    expect(wantsHtmlOverTurtle('text/turtle')).toBe(false)
  })

  it('returns false when only text/n3 is requested', () => {
    expect(wantsHtmlOverTurtle('text/n3')).toBe(false)
  })

  it('returns true when text/html is listed before text/turtle', () => {
    expect(wantsHtmlOverTurtle('text/html, text/turtle')).toBe(true)
  })

  it('returns false when text/turtle is listed before text/html', () => {
    expect(wantsHtmlOverTurtle('text/turtle, text/html')).toBe(false)
  })

  it('returns true when html q-value is higher than turtle q-value', () => {
    expect(wantsHtmlOverTurtle('text/html;q=0.9, text/turtle;q=0.5')).toBe(true)
  })

  it('returns false when turtle q-value is higher than html q-value', () => {
    expect(wantsHtmlOverTurtle('text/html;q=0.5, text/turtle;q=0.9')).toBe(false)
  })

  it('returns false for an Accept header with no HTML or Turtle family types', () => {
    expect(wantsHtmlOverTurtle('application/json')).toBe(false)
  })

  it('returns false for */* (no explicit HTML preference)', () => {
    expect(wantsHtmlOverTurtle('*/*')).toBe(false)
  })

  it('matches a typical browser Accept header as HTML-preferring', () => {
    expect(
      wantsHtmlOverTurtle(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      )
    ).toBe(true)
  })

  it('matches a typical Solid client Accept header as Turtle-preferring', () => {
    expect(wantsHtmlOverTurtle('text/turtle;q=1.0, application/ld+json;q=0.9, */*;q=0.8')).toBe(
      false
    )
  })

  it('treats xhtml listed before turtle as HTML-preferring', () => {
    expect(
      wantsHtmlOverTurtle('application/xhtml+xml, text/turtle;q=0.5')
    ).toBe(true)
  })
})
