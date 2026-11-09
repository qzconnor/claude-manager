import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shellFiles, shellTokens } from './shell-files'

const cwd = resolve('/work')
const at = (...parts: string[]) => resolve(cwd, ...parts)
const bash = (command: string) => shellFiles(command, cwd, false, false)
const pwsh = (command: string) => shellFiles(command, cwd, true, false)

describe('shellTokens', () => {
  it('splits words and operators, with quotes and escapes', () => {
    expect(shellTokens(`cat "a b.txt" 'c d' e\\ f && wc -l x|sort`)).toEqual([
      { word: 'cat' },
      { word: 'a b.txt' },
      { word: 'c d' },
      { word: 'e f' },
      { op: '&&' },
      { word: 'wc' },
      { word: '-l' },
      { word: 'x' },
      { op: '|' },
      { word: 'sort' },
    ])
  })

  it('takes redirections apart from file descriptors, leaves out comments and heredoc bodies', () => {
    expect(shellTokens('make 2>&1 >out.log # build\ncat <<EOF\ncat secret.txt\nEOF')).toEqual([
      { word: 'make' },
      { op: '>&' },
      { word: '1' },
      { op: '>' },
      { word: 'out.log' },
      { op: ';' },
      { word: 'cat' },
      { op: '<<' },
      { word: 'EOF' },
    ])
  })

  it("reads PowerShell's quotes, backtick escapes and here-strings", () => {
    expect(shellTokens("Get-Content 'it''s.txt' \"a`\"b\"\n$x = @'\nGet-Content hidden.txt\n'@", true)).toEqual([
      { word: 'Get-Content' },
      { word: "it's.txt" },
      { word: 'a"b' },
      { op: ';' },
      { word: '$x' },
      { word: '=' },
      { word: '@' },
    ])
  })
})

describe('shellFiles', () => {
  it('tells the files a command reads, after any cd', () => {
    // A number taken for a path drops out later: it is no file.
    expect(bash('cat src/a.ts && head -n 20 b.ts | tail -5').reads).toEqual([at('src/a.ts'), at('20'), at('b.ts')])
    expect(bash('cd src && cat a.ts').reads).toEqual([at('src/a.ts')])
    expect(bash('sed -n 1,20p README.md').reads).toEqual([at('1,20p'), at('README.md')])
    expect(bash('wc -l < input.txt').reads).toEqual([at('input.txt')])
  })

  it('tells searches and writes', () => {
    expect(bash('grep -rn "needle" src/a.ts lib').searches).toEqual([at('needle'), at('src/a.ts'), at('lib')])
    expect(bash("sed -i 's/a/b/' x.ts").writes).toEqual([at('s/a/b/'), at('x.ts')])
    expect(bash('echo hi > out.txt 2>/dev/null; echo more >> log.txt').writes).toEqual([at('out.txt'), at('log.txt')])
    expect(bash('npm test | tee result.txt').writes).toEqual([at('result.txt')])
    expect(bash('cp -r a.ts b.ts dest/c.ts')).toMatchObject({ reads: [at('a.ts'), at('b.ts')], writes: [at('dest/c.ts')] })
  })

  it('looks past prefixes and shell words, and at git commands that read files', () => {
    expect(bash('FOO=1 sudo cat a.ts').reads).toEqual([at('a.ts')])
    expect(bash('if grep -q x a.ts; then cat b.ts; fi')).toMatchObject({ searches: [at('x'), at('a.ts')], reads: [at('b.ts')] })
    expect(bash('git diff HEAD -- src/a.ts').reads).toEqual([at('HEAD'), at('src/a.ts')])
    expect(bash('git -C repo grep foo').searches).toEqual([at('foo')])
    expect(bash('git status')).toEqual({ reads: [], searches: [], writes: [] })
  })

  it('leaves out what is no path', () => {
    expect(bash('cat $FILE *.ts https://example.com/a ~/notes.md -').reads).toEqual([resolve(homedir(), 'notes.md')])
    expect(bash('find . -name "*.ts" | xargs cat')).toEqual({ reads: [], searches: [], writes: [] })
    expect(bash("python - <<'EOF'\nopen('x.txt').read()\nEOF")).toEqual({ reads: [], searches: [], writes: [] })
  })

  it('reads PowerShell cmdlets and their path parameters', () => {
    expect(pwsh('Get-Content -Path src/a.ts -TotalCount 5').reads).toEqual([at('src/a.ts'), at('5')])
    expect(pwsh('Set-Content -LiteralPath out.txt -Value hi; Select-String -Pattern x b.ts')).toMatchObject({
      writes: [at('out.txt'), at('hi')],
      searches: [at('x'), at('b.ts')],
    })
    expect(pwsh('Set-Location src; gc a.ts 2>$null').reads).toEqual([at('src/a.ts')])
  })

  it.runIf(process.platform === 'win32')('turns the drives of Git Bash into Windows paths', () => {
    expect(shellFiles('cat /c/Users/x/a.ts', 'F:\\work', false, true).reads).toEqual(['C:\\Users\\x\\a.ts'])
  })
})
