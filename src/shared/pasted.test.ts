import { describe, expect, it } from 'vitest'
import { promptParts, unwrapPasted } from './pasted'

const pasted = (id: string, text: string) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`

describe('promptParts', () => {
  it('splits a prompt in what was typed and what was pasted, in order', () => {
    const prompt = `kannst du das aufnehmen?\n\n${pasted('63cd', 'Zeile 1\nZeile 2')}\n\nund das hier\n${pasted('a1', 'x')}\n`
    expect(promptParts(prompt)).toEqual([
      { kind: 'text', text: 'kannst du das aufnehmen?' },
      { kind: 'pasted', id: '63cd', text: 'Zeile 1\nZeile 2' },
      { kind: 'text', text: 'und das hier' },
      { kind: 'pasted', id: 'a1', text: 'x' },
    ])
  })

  it('takes the closing tag without an id of older versions and Windows line ends', () => {
    expect(promptParts('<pasted_content id="b2">\r\nA\r\nB\r\n</pasted_content>')).toEqual([{ kind: 'pasted', id: 'b2', text: 'A\r\nB' }])
  })

  it('keeps pasted text as it is: blank lines, indentation, markup', () => {
    const text = '  <div>\n\n    *not markdown*\n  </div>'
    expect(promptParts(pasted('c', text))).toEqual([{ kind: 'pasted', id: 'c', text }])
  })

  it('leaves a prompt without pasted text, and an unclosed tag, as text', () => {
    expect(promptParts('  Fix it  ')).toEqual([{ kind: 'text', text: 'Fix it' }])
    expect(promptParts('<pasted_content id="x">\nno end')).toEqual([{ kind: 'text', text: '<pasted_content id="x">\nno end' }])
    expect(promptParts('')).toEqual([])
  })
})

describe('unwrapPasted', () => {
  it('turns pasted text into plain text for titles and the search', () => {
    expect(unwrapPasted(`Schau:\n${pasted('63cd', 'Gucke dir die App an')}`)).toBe('Schau:\nGucke dir die App an')
  })
})
