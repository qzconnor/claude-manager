import { describe, expect, it } from 'vitest'
import { claudeActivity, TitleReader } from './terminal-title'

const BEL = '\x07'
const ST = '\x1b\\'

describe('TitleReader', () => {
  it('reads OSC 0 and OSC 2 titles, terminated by BEL or ST', () => {
    const reader = new TitleReader()
    expect(reader.read(`before\x1b]0;✳ Claude Code${BEL}after`)).toBe('✳ Claude Code')
    expect(reader.read(`\x1b]2;make build${ST}`)).toBe('make build')
  })

  it('returns null when a chunk sets no title', () => {
    const reader = new TitleReader()
    expect(reader.read('plain \x1b[1mbold\x1b[0m text')).toBeNull()
    expect(reader.read('')).toBeNull()
  })

  it('ignores other OSC sequences such as the icon name, hyperlinks and colors', () => {
    const reader = new TitleReader()
    const data = `\x1b]1;icon${BEL}\x1b]8;;https://example.com${ST}link\x1b]8;;${ST}\x1b]11;?${BEL}`
    expect(reader.read(data)).toBeNull()
  })

  it('returns the last of several titles in one chunk', () => {
    const reader = new TitleReader()
    expect(reader.read(`\x1b]0;first${BEL}text\x1b]2;second${ST}\x1b]1;icon${BEL}`)).toBe('second')
  })

  it('takes whichever terminator comes first', () => {
    const reader = new TitleReader()
    expect(reader.read(`\x1b]0;a${ST}b${BEL}`)).toBe('a')
    expect(reader.read(`\x1b]0;c${BEL}d${ST}`)).toBe('c')
  })

  it('keeps an empty title as such', () => {
    expect(new TitleReader().read(`\x1b]0;${BEL}`)).toBe('')
  })

  it('reads a title split inside its text', () => {
    const reader = new TitleReader()
    expect(reader.read('out\x1b]0;◐ Refac')).toBeNull()
    expect(reader.read(`toring${BEL}more`)).toBe('◐ Refactoring')
  })

  it('reads a title split between ESC and ]', () => {
    const reader = new TitleReader()
    expect(reader.read('output\x1b')).toBeNull()
    expect(reader.read(`]2;title${BEL}`)).toBe('title')
  })

  it('reads a title whose ST is split between chunks', () => {
    const reader = new TitleReader()
    expect(reader.read('\x1b]0;title\x1b')).toBeNull()
    expect(reader.read('\\')).toBe('title')
  })

  it('reads a title split over several chunks', () => {
    const reader = new TitleReader()
    expect(reader.read('\x1b]')).toBeNull()
    expect(reader.read('0;')).toBeNull()
    expect(reader.read('a b')).toBeNull()
    expect(reader.read(`c${BEL}`)).toBe('a bc')
  })

  it('returns a complete title and keeps an unfinished one for the next chunk', () => {
    const reader = new TitleReader()
    expect(reader.read(`\x1b]0;one${BEL}\x1b]0;tw`)).toBe('one')
    expect(reader.read(`o${BEL}`)).toBe('two')
  })

  it('drops an unfinished sequence longer than a title can be', () => {
    const reader = new TitleReader()
    expect(reader.read(`\x1b]0;${'x'.repeat(5000)}`)).toBeNull()
    expect(reader.read(`rest${BEL}`)).toBeNull()
    expect(reader.read(`\x1b]0;next${BEL}`)).toBe('next')
  })

  it('does not carry over a lone ESC that the next chunk turns into another sequence', () => {
    const reader = new TitleReader()
    expect(reader.read('text\x1b')).toBeNull()
    expect(reader.read('[0m plain')).toBeNull()
    expect(reader.read(`\x1b]0;later${BEL}`)).toBe('later')
  })
})

describe('claudeActivity', () => {
  it.each([
    ['✳ Claude Code', 'idle'],
    ['✳ Fix login bug', 'idle'],
    ['◐ Fix login bug', 'busy'],
    ['◑ Fix login bug', 'busy'],
    ['⠂ Claude Code', 'busy'],
    ['⠐ Claude Code', 'busy'],
    ['⣿ Claude Code', 'busy'],
  ] as const)('%s is %s', (title, activity) => {
    expect(claudeActivity(title)).toBe(activity)
  })

  it.each(['Claude Code', 'pwsh', '✳Claude', '◐Task', '', ' ✳ Claude Code', 'C:\\Windows\\system32\\cmd.exe'])(
    'knows nothing about %j',
    (title) => {
      expect(claudeActivity(title)).toBeNull()
    },
  )
})
