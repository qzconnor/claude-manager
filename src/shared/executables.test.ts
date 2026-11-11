import { describe, expect, it } from 'vitest'
import { runsWhenOpened } from './executables'

describe('runsWhenOpened', () => {
  it('knows what Windows runs when opened, whatever the case', () => {
    for (const name of ['setup.exe', 'Run.BAT', 'x.cmd', 'tool.js', 'a.vbs', 'b.hta', 'c.lnk', 'd.msi', 'e.ps1', 'f.reg', 'g.scr', 'h.url']) {
      expect(runsWhenOpened(name, 'win32'), name).toBe(true)
    }
  })

  it('sees through dots and spaces Windows drops at the end, and through folders', () => {
    expect(runsWhenOpened('setup.exe. . ', 'win32')).toBe(true)
    expect(runsWhenOpened('C:\\dl\\x.txt\\setup.exe', 'win32')).toBe(true)
    expect(runsWhenOpened('/tmp/a.exe/readme.txt', 'win32')).toBe(false)
  })

  it('leaves documents, images and code files that open in an editor alone', () => {
    for (const name of ['notes.txt', 'bild.png', 'report.pdf', 'main.ts', 'style.css', 'data.json', 'Makefile', '.env', 'archive.zip']) {
      expect(runsWhenOpened(name, 'win32'), name).toBe(false)
    }
  })

  it('knows what a Linux desktop starts', () => {
    expect(runsWhenOpened('app.AppImage', 'linux')).toBe(true)
    expect(runsWhenOpened('install.sh', 'linux')).toBe(true)
    expect(runsWhenOpened('x.desktop', 'linux')).toBe(true)
    expect(runsWhenOpened('tool.js', 'linux')).toBe(false)
    expect(runsWhenOpened('setup.exe. ', 'linux')).toBe(false)
  })
})
