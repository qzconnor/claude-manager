import { describe, expect, it } from 'vitest'
import { openSequenceStart, TrimmedModes } from './terminal-modes'

describe('openSequenceStart', () => {
  it('finds a sequence the text ends in the middle of', () => {
    expect(openSequenceStart('abc\x1b')).toBe(3)
    expect(openSequenceStart('abc\x1b[?20')).toBe(3)
    expect(openSequenceStart('abc\x1b(')).toBe(3)
    expect(openSequenceStart('abc\x1b]0;Titel')).toBe(3)
  })

  it('knows when the text ends between sequences', () => {
    expect(openSequenceStart('abc')).toBe(-1)
    expect(openSequenceStart('abc\x1b[?2004h')).toBe(-1)
    expect(openSequenceStart('abc\x1b[31mrot')).toBe(-1)
    expect(openSequenceStart('\x1b]0;Titel\x07')).toBe(-1)
    expect(openSequenceStart('\x1b=')).toBe(-1)
  })
})

describe('TrimmedModes', () => {
  it('brings back the modes set in trimmed output, in the order they last changed', () => {
    const modes = new TrimmedModes()
    modes.trim('\x1b[?2004h\x1b[?1000;1006hHallo\x1b[?25l')
    modes.trim('\x1b[?1000l\x1b[?31h')
    expect(modes.prefix()).toBe('\x1b[?2004h\x1b[?1006h\x1b[?25l\x1b[?1000l')
  })

  it('keeps the keypad mode', () => {
    const modes = new TrimmedModes()
    modes.trim('\x1b=')
    expect(modes.prefix()).toBe('\x1b=')
    modes.trim('\x1b>')
    expect(modes.prefix()).toBe('\x1b>')
  })

  it('has nothing to bring back without modes', () => {
    const modes = new TrimmedModes()
    modes.trim('Hallo \x1b[1mWelt\x1b[0m')
    expect(modes.prefix()).toBe('')
  })

  it('reads a mode cut in two between trimmed pieces', () => {
    const modes = new TrimmedModes()
    modes.trim('x\x1b[?20')
    modes.trim('04hy')
    expect(modes.prefix()).toBe('\x1b[?2004h')
  })

  it('gives back the start of a sequence whose rest is still kept', () => {
    const modes = new TrimmedModes()
    modes.trim('Hallo\x1b[?10')
    // The kept output starts with "49h": together a whole sequence again.
    expect(modes.prefix() + '49h').toBe('\x1b[?1049h')
  })

  it('drops an endless sequence', () => {
    const modes = new TrimmedModes()
    modes.trim('\x1b]0;' + 'x'.repeat(5000))
    expect(modes.prefix()).toBe('')
  })
})
