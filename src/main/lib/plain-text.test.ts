import { describe, expect, it } from 'vitest'
import { oneLine, plainText } from './plain-text'

describe('plainText', () => {
  it('turns Markdown into one line of text', () => {
    expect(
      plainText('# Fertig\n\n- **Tests** laufen\n- Siehe [Doku](https://example.com) und `npm test`\n> Hinweis\n1. __eins__'),
    ).toBe('Fertig Tests laufen Siehe Doku und npm test Hinweis eins')
  })

  it('leaves out code blocks, also an unclosed one', () => {
    expect(plainText('Vorher\n```ts\nconst a = 1\n```\nNachher')).toBe('Vorher Nachher')
    expect(plainText('Text\n```\nnot closed')).toBe('Text')
  })

  it('keeps the alt text of images', () => {
    expect(plainText('![Diagramm](img.png)')).toBe('Diagramm')
  })

  it('is null without text', () => {
    expect(plainText(null)).toBeNull()
    expect(plainText('')).toBeNull()
    expect(plainText('```\ncode only\n```')).toBeNull()
  })
})

describe('oneLine', () => {
  it('puts text on one line and cuts it with an ellipsis', () => {
    expect(oneLine('  eins\n\n zwei\tdrei ', 20)).toBe('eins zwei drei')
    expect(oneLine('abcdefghij', 5)).toBe('abcd…')
    expect(oneLine('abcde', 5)).toBe('abcde')
  })

  it('is null without text', () => {
    expect(oneLine(null, 5)).toBeNull()
    expect(oneLine(' \n ', 5)).toBeNull()
  })
})
