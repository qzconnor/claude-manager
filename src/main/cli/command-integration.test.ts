import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { parseDefaultValue } from './command-integration'

describe('parseDefaultValue', () => {
  it('reads the default value of reg query, whatever the language calls it', () => {
    const german = '\r\nHKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\cm.exe\r\n    (Standard)    REG_SZ    C:\Tools\Other Program\cm.exe\r\n\r\n'
    expect(parseDefaultValue(german)).toBe('C:\Tools\Other Program\cm.exe')
    expect(parseDefaultValue(german.replace('(Standard)', '(Default)'))).toBe('C:\Tools\Other Program\cm.exe')
  })

  it('takes off quotes and fills in variables', () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\Users\me\AppData\Local')
    const output = '\r\nHKEY_CURRENT_USER\...\cm.exe\r\n    (Default)    REG_EXPAND_SZ    "%LOCALAPPDATA%\cm\cm.exe"\r\n'
    expect(parseDefaultValue(output)).toBe('C:\Users\me\AppData\Local\cm\cm.exe')
    vi.unstubAllEnvs()
  })

  it('finds nothing without a value', () => {
    expect(parseDefaultValue('\r\nHKEY_CURRENT_USER\...\cm.exe\r\n    (Standard)    REG_SZ    \r\n')).toBeNull()
    expect(parseDefaultValue('')).toBeNull()
  })
})
