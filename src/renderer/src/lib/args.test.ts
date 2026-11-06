import { describe, expect, it } from 'vitest'
import { formatArgs, parseArgs } from './args'

describe('parseArgs', () => {
  it('splits on any run of whitespace', () => {
    expect(parseArgs('  --model   opus\t--verbose\n-p ')).toEqual(['--model', 'opus', '--verbose', '-p'])
  })

  it('returns nothing for an empty or blank line', () => {
    expect(parseArgs('')).toEqual([])
    expect(parseArgs(' \t ')).toEqual([])
  })

  it('keeps quoted whitespace in one argument', () => {
    expect(parseArgs('--append-system-prompt "Sei kurz und knapp." --add-dir \'C:\\My Projects\'')).toEqual([
      '--append-system-prompt',
      'Sei kurz und knapp.',
      '--add-dir',
      'C:\\My Projects',
    ])
  })

  it('keeps the other kind of quote inside quotes', () => {
    expect(parseArgs(`"it's" 'say "hi"'`)).toEqual(["it's", 'say "hi"'])
  })

  it('keeps empty quoted arguments', () => {
    expect(parseArgs('a "" b \'\'')).toEqual(['a', '', 'b', ''])
  })

  it('joins quoted and unquoted parts without whitespace between them', () => {
    expect(parseArgs('--name="My Tab" x')).toEqual(['--name=My Tab', 'x'])
  })

  it('takes an unterminated quote up to the end', () => {
    expect(parseArgs('a "b c')).toEqual(['a', 'b c'])
  })

  it('leaves backslashes alone (Windows paths)', () => {
    expect(parseArgs('C:\\Users\\me\\file.txt')).toEqual(['C:\\Users\\me\\file.txt'])
  })
})

describe('formatArgs', () => {
  it('joins plain arguments with spaces', () => {
    expect(formatArgs(['--model', 'opus', '-p'])).toBe('--model opus -p')
    expect(formatArgs([])).toBe('')
  })

  it('quotes empty arguments and arguments with whitespace or quotes', () => {
    expect(formatArgs(['', 'a b', "it's", 'tab\there'])).toBe(`"" "a b" "it's" "tab\there"`)
  })

  it('round-trips through parseArgs', () => {
    const cases = [
      ['--model', 'opus'],
      ['--append-system-prompt', 'Sei kurz und knapp.'],
      ['', 'x', ''],
      ["it's", 'C:\\My Projects\\a b.txt', '/home/me/it’s here'],
      ['--append-system-prompt', 'Say "hi"'],
      ['"', "'", `it's "quoted"`, `"'"`],
    ]
    for (const args of cases) expect(parseArgs(formatArgs(args))).toEqual(args)
  })

  it('keeps double quotes by quoting with single quotes', () => {
    expect(formatArgs(['--append-system-prompt', 'Say "hi"'])).toBe(`--append-system-prompt 'Say "hi"'`)
  })

  it('keeps both kinds of quotes in one argument', () => {
    const formatted = formatArgs([`it's "x"`])
    expect(parseArgs(formatted)).toEqual([`it's "x"`])
    expect(parseArgs(`${formatted} --next`)).toEqual([`it's "x"`, '--next'])
  })
})
