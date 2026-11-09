import { describe, expect, it } from 'vitest'
import { folderKey, inFolder } from './folders'

describe('folderKey', () => {
  it('compares Windows folders without regard to case, slash and a trailing separator', () => {
    expect(folderKey('F:\\Code\\')).toBe(folderKey('f:/code'))
    expect(folderKey('C:\\')).toBe('c:\\')
    expect(folderKey('/home/Dev/')).toBe('/home/Dev')
  })
})

describe('inFolder', () => {
  it('is true for the folder itself and what lies in it', () => {
    expect(inFolder('C:\\dev\\app', 'c:/dev/app/')).toBe(true)
    expect(inFolder('c:/dev/app/src', 'C:\\dev\\app')).toBe(true)
    expect(inFolder('C:\\dev', 'C:\\')).toBe(true)
    expect(inFolder('/home/dev/app/src', '/home/dev/app')).toBe(true)
    expect(inFolder('/home/dev', '/')).toBe(true)
  })

  it('is false for neighbours with the same beginning and for no folder', () => {
    expect(inFolder('C:\\dev\\app-old', 'C:\\dev\\app')).toBe(false)
    expect(inFolder('/home/dev/App', '/home/dev/app')).toBe(false)
    expect(inFolder('C:\\dev', 'C:\\dev\\app')).toBe(false)
    expect(inFolder('C:\\dev', ' ')).toBe(false)
  })
})
