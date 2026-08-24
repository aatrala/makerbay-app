import { describe, expect, it } from 'vitest'
import { contactsToCsv, normalizeEmail, normalizePhone, parseCsv } from './contacts'
import type { ContactRow } from './types'

describe('normalizeEmail', () => {
  it('trims and lowercases, so one person stays one person', () => {
    expect(normalizeEmail('  Jane.Cooper@Example.COM ')).toBe('jane.cooper@example.com')
  })

  it('rejects anything without an @', () => {
    expect(normalizeEmail('not an email')).toBeUndefined()
    expect(normalizeEmail('')).toBeUndefined()
    expect(normalizeEmail(undefined)).toBeUndefined()
  })
})

describe('normalizePhone', () => {
  it('strips formatting but keeps a leading plus', () => {
    expect(normalizePhone('+61 (400) 111-222')).toBe('+61400111222')
  })

  it('keeps local numbers without inventing a country code', () => {
    expect(normalizePhone('0400 999 888')).toBe('0400999888')
  })

  it('treats too-few digits as a typo rather than a number', () => {
    expect(normalizePhone('12345')).toBeUndefined()
  })

  it('rejects empty input', () => {
    expect(normalizePhone('')).toBeUndefined()
    expect(normalizePhone(undefined)).toBeUndefined()
  })
})

describe('parseCsv', () => {
  it('reads a plain file', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('handles CRLF as well as LF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('name,note\n"Smith, Jane",hello')).toEqual([
      ['name', 'note'],
      ['Smith, Jane', 'hello'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"She said ""hi"""')).toEqual([['a'], ['She said "hi"']])
  })

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a\n"line one\nline two"')).toEqual([['a'], ['line one\nline two']])
  })

  it('strips a UTF-8 BOM, which Excel writes by default', () => {
    expect(parseCsv('﻿name\nJane')).toEqual([['name'], ['Jane']])
  })

  it('drops rows that are entirely empty', () => {
    expect(parseCsv('a\n1\n\n,,\n2')).toEqual([['a'], ['1'], ['2']])
  })
})

const contact = (over: Partial<ContactRow> = {}): ContactRow => ({
  tenantId: 't', contactId: 'c', status: 'new',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

describe('contactsToCsv', () => {
  it('writes a header and one row per contact', () => {
    const csv = contactsToCsv([contact({ name: 'Jane', email: 'jane@example.com' })])
    const [header, row] = csv.trim().split('\r\n')
    expect(header).toBe('name,email,phone,status,tags,note,source,createdAt')
    expect(row).toContain('Jane,jane@example.com')
  })

  it('quotes fields containing a comma', () => {
    const csv = contactsToCsv([contact({ name: 'Smith, Jane' })])
    expect(csv).toContain('"Smith, Jane"')
  })

  it('escapes embedded quotes', () => {
    const csv = contactsToCsv([contact({ note: 'said "hi"' })])
    expect(csv).toContain('"said ""hi"""')
  })

  it('neutralises formula injection', () => {
    // A cell starting with = would execute when the export is opened in Excel.
    const csv = contactsToCsv([contact({ name: '=HYPERLINK("http://evil","click")' })])
    expect(csv).toContain("'=HYPERLINK")
  })

  it('guards the other formula-leading characters too', () => {
    for (const lead of ['+', '-', '@']) {
      expect(contactsToCsv([contact({ note: `${lead}cmd` })])).toContain(`'${lead}cmd`)
    }
  })

  it('renders a missing field as empty, not "undefined"', () => {
    const csv = contactsToCsv([contact({ name: 'Jane' })])
    expect(csv).not.toContain('undefined')
  })

  it('joins tags with a space so the cell stays one field', () => {
    const csv = contactsToCsv([contact({ tags: ['repeat', 'commercial'] })])
    expect(csv).toContain('repeat commercial')
  })
})
