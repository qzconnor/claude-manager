import { execFile } from 'node:child_process'

let cached: Promise<string[]> | null = null

/** Installed font family names (Windows: via .NET, cached for the app lifetime). */
export function listFontFamilies(): Promise<string[]> {
  cached ??= load().catch(() => [])
  return cached
}

function load(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Add-Type -AssemblyName System.Drawing;' +
    '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return reject(error)
        const names = stdout
          .split(/\r?\n/)
          .map((n) => n.trim())
          .filter(Boolean)
        resolve([...new Set(names)].sort((a, b) => a.localeCompare(b)))
      },
    )
  })
}
