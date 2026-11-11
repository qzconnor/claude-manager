import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import { resetPatches } from './settings-reset'

describe('resetPatches', () => {
  it('resets only the settings of the card, and keeps how they were for undo', () => {
    const current = createDefaultSettings()
    current.claude.executablePath = 'C:\\tools\\claude.exe'
    current.claude.defaultArgs = ['--verbose']
    current.claude.browserToolsAllowed = false
    current.general.restoreTerminals = true
    const { patch, previous } = resetPatches(
      { claude: ['executablePath', 'defaultArgs'], general: ['restoreTerminals'] },
      current,
      createDefaultSettings(),
    )
    expect(patch).toEqual({ claude: { executablePath: '', defaultArgs: [] }, general: { restoreTerminals: false } })
    expect(previous).toEqual({ claude: { executablePath: 'C:\\tools\\claude.exe', defaultArgs: ['--verbose'] }, general: { restoreTerminals: true } })
  })

  it('copies the values, so a later change of the settings leaves them as they are', () => {
    const current = createDefaultSettings()
    current.claude.defaultArgs = ['--a']
    const { previous } = resetPatches({ claude: ['defaultArgs'] }, current, createDefaultSettings())
    current.claude.defaultArgs.push('--b')
    expect(previous).toEqual({ claude: { defaultArgs: ['--a'] } })
  })
})
