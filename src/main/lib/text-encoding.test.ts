import { describe, expect, it } from 'vitest'
import { decodeText, decodeUtf16, isUtf16 } from './text-encoding'

const latin1 = (text: string) => Buffer.from(text, 'latin1')

describe('decodeText', () => {
  it('reads UTF-8 as it is', () => {
    expect(decodeText(Buffer.from('Grüße\n€ und „Zitat“\n'))).toBe('Grüße\n€ und „Zitat“\n')
  })

  it('reads a file saved as Windows-1252 without replacement characters', () => {
    // Grüße, € and „ in Windows-1252.
    const bytes = Buffer.concat([latin1('Gr\xfc\xdfe\r\n'), Buffer.from([0x80, 0x20, 0x84, 0x0a])])
    expect(decodeText(bytes)).toBe('Grüße\r\n€ „\n')
  })

  it('reads each line by itself: a diff of a Latin-1 file has UTF-8 around it', () => {
    const patch = Buffer.concat([Buffer.from('@@ -1 +1 @@ Überschrift\n'), latin1('-Gr\xfc\xdfe\n'), Buffer.from('+Grüße\n')])
    expect(decodeText(patch)).toBe('@@ -1 +1 @@ Überschrift\n-Grüße\n+Grüße\n')
  })
})

describe('UTF-16', () => {
  it('is known by its byte order mark, in both byte orders', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße\r\n', 'utf16le')])
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Grüße\r\n', 'utf16le').swap16()])
    expect([isUtf16(le), isUtf16(be), isUtf16(Buffer.from('Grüße'))]).toEqual([true, true, false])
    expect(decodeUtf16(le)).toBe('Grüße\r\n')
    expect(decodeUtf16(be)).toBe('Grüße\r\n')
  })
})
