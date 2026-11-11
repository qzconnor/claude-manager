import { describe, expect, it } from 'vitest'
import { pastedPaths, quotePath } from './shell-quote'

describe('quotePath', () => {
  it('leaves plain paths as they are', () => {
    expect(quotePath('C:\\Users\\me\\Bild_1.png', 'powershell')).toBe('C:\\Users\\me\\Bild_1.png')
    expect(quotePath('/home/me/Übung-2.txt', 'posix')).toBe('/home/me/Übung-2.txt')
  })

  it('quotes in PowerShell what it would expand or run, in single quotes', () => {
    expect(quotePath('C:\\tmp\\$(calc).txt', 'powershell')).toBe("'C:\\tmp\\$(calc).txt'")
    expect(quotePath('C:\\tmp\\a;calc', 'powershell')).toBe("'C:\\tmp\\a;calc'")
    expect(quotePath('C:\\tmp\\a`b', 'powershell')).toBe("'C:\\tmp\\a`b'")
    expect(quotePath('C:\\My Files\\a.txt', 'powershell')).toBe("'C:\\My Files\\a.txt'")
    expect(quotePath('C:\\tmp\\a,b.txt', 'powershell')).toBe("'C:\\tmp\\a,b.txt'")
  })

  it('doubles every quote PowerShell ends a string at, the typographic ones too', () => {
    expect(quotePath("C:\\tmp\\it's", 'powershell')).toBe("'C:\\tmp\\it''s'")
    expect(quotePath('C:\\tmp\\a\u2019; calc; \u2019', 'powershell')).toBe("'C:\\tmp\\a\u2019\u2019; calc; \u2019\u2019'")
  })

  it('quotes in a POSIX shell what it would expand or run', () => {
    expect(quotePath('/tmp/$(rm -rf ~)', 'posix')).toBe("'/tmp/$(rm -rf ~)'")
    expect(quotePath('/tmp/a`id`', 'posix')).toBe("'/tmp/a`id`'")
    expect(quotePath('/tmp/*.txt', 'posix')).toBe("'/tmp/*.txt'")
    expect(quotePath('/tmp/~a', 'posix')).toBe("'/tmp/~a'")
  })

  it('escapes quotes and backslashes outside the quotes, the same for bash and fish', () => {
    expect(quotePath("/tmp/it's", 'posix')).toBe("'/tmp/it'\\''s'")
    expect(quotePath('/tmp/a\\b', 'posix')).toBe("'/tmp/a'\\\\'b'")
  })

  it('puts a control character as a glob outside the quotes, so no escape sequence reaches the shell', () => {
    expect(quotePath('/tmp/a\x1b[201~\rb', 'posix')).toBe("'/tmp/a'?'[201~'?'b'")
  })

  it('never lets a path start an option', () => {
    expect(quotePath('-rf', 'posix')).toBe("'-rf'")
    expect(quotePath('-Force', 'powershell')).toBe("'-Force'")
  })
})

describe('pastedPaths', () => {
  it('quotes for the shell in a shell', () => {
    expect(pastedPaths(['C:\\a b\\x.png', 'C:\\y.png'], 'shell', 'powershell')).toBe("'C:\\a b\\x.png' C:\\y.png")
  })

  it('gives Claude Code the paths like Windows Terminal, without control characters', () => {
    expect(pastedPaths(['C:\\a b\\x.png', 'C:\\y.png'], 'session', 'powershell')).toBe('"C:\\a b\\x.png" C:\\y.png')
    expect(pastedPaths(['/tmp/a\x1bb'], 'session', 'posix')).toBe('/tmp/a?b')
  })
})
