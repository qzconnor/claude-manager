// Compiles the `cm` command line launcher (src/launcher/cm.cs) to build/bin/cm.exe.
// Uses the C# compiler of the .NET Framework 4 that is part of every Windows 10/11 installation,
// so no SDK is needed. electron-builder copies the result next to the app (electron-builder.yml).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('build-launcher: cm.exe can only be built on Windows.')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!existsSync(csc)) {
  console.error(`build-launcher: C# compiler not found at ${csc}`)
  process.exit(1)
}

const source = join(root, 'src', 'launcher', 'cm.cs')
const output = join(root, 'build', 'bin', 'cm.exe')
mkdirSync(dirname(output), { recursive: true })

execFileSync(
  csc,
  [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/codepage:65001',
    `/win32icon:${join(root, 'build', 'icon.ico')}`,
    '/reference:System.Windows.Forms.dll',
    `/out:${output}`,
    source,
  ],
  { stdio: 'inherit' },
)
console.log(`build-launcher: ${output}`)
