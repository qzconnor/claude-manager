import { describe, expect, it } from 'vitest'
import { releaseLines, splitChanges, splitNoteItems, splitReleaseNotes, withoutReleaseLines, type NoteType } from './release-notes'

const BODY = `## Versionshinweise

- Workspaces mit gemeinsamem Prompt (\`cm_prompts.md\`)
- Session-Übersicht als Baum Workspace › Projekt › Session, auch für
  Ordner ohne Sessions
- fix: Die Titelleiste überdeckt die Suche nicht mehr (#12)
- refactor: Dienst aufgeteilt
<!-- Ein Punkt pro Zeile. -->

## Was

- **Workspaces:** Ordner, deren Unterordner Projekte sind.
  - Neuer Workspace über den Knopf neben der Suche.`

describe('releaseLines', () => {
  it('reads the changes under the heading, one per bullet, with wrapped lines and types', () => {
    expect(releaseLines(BODY)).toEqual([
      { type: null, text: 'Workspaces mit gemeinsamem Prompt (`cm_prompts.md`)' },
      { type: null, text: 'Session-Übersicht als Baum Workspace › Projekt › Session, auch für Ordner ohne Sessions' },
      { type: 'fix', text: 'Die Titelleiste überdeckt die Suche nicht mehr (#12)' },
      { type: 'refactor', text: 'Dienst aufgeteilt' },
    ])
  })

  it('has none without the heading, and takes capitalized words for text', () => {
    expect(releaseLines('## Was\n\n- Etwas')).toEqual([])
    expect(releaseLines(null)).toEqual([])
    expect(releaseLines('### Versionshinweise:\r\n- Test: Tests laufen schneller')).toEqual([{ type: null, text: 'Test: Tests laufen schneller' }])
  })
})

describe('withoutReleaseLines', () => {
  it('leaves the description without the list the notes show', () => {
    expect(withoutReleaseLines(BODY)).toMatch(/^## Was\n\n- \*\*Workspaces:\*\*/)
    expect(withoutReleaseLines('## Was\n\nText')).toBe('## Was\n\nText')
  })
})

describe('splitChanges', () => {
  it('splits at `; `, each change starting upper case, but not after an entity', () => {
    expect(splitChanges('Workspaces; die Titelleiste zeigt den Kontext; „Projekt hier anlegen…“')).toEqual([
      'Workspaces',
      'Die Titelleiste zeigt den Kontext',
      '„Projekt hier anlegen…“',
    ])
    expect(splitChanges('Drag &amp; Drop')).toEqual(['Drag &amp; Drop'])
  })
})

const TYPES: NoteType[] = [
  { type: 'feat', section: 'Neue Funktionen' },
  { type: 'fix', section: 'Fehlerbehebungen' },
  { type: 'refactor', hidden: true },
]
const LINKS = {
  host: 'https://github.com',
  owner: 'qzconnor',
  repository: 'claude-manager',
}
const pr = (n: number) => ` ([#${n}](https://github.com/qzconnor/claude-manager/issues/${n}))`

describe('splitReleaseNotes', () => {
  it('makes each listed change an entry, in the section of its type, with the link of the pull request', () => {
    const context = splitReleaseNotes(
      {
        ...LINKS,
        commitGroups: [
          {
            title: 'Neue Funktionen' as string | false,
            commits: [
              { subject: `Workspaces${pr(66)}`, body: BODY, hash: 'c95f641' },
              { subject: `Schneller Start${pr(67)}`, body: null, hash: 'abc1234' },
            ],
          },
        ],
      },
      TYPES,
    )
    expect(context.commitGroups.map((g) => [g.title, g.commits.map((c) => c.subject)])).toEqual([
      [
        'Neue Funktionen',
        [
          `Workspaces mit gemeinsamem Prompt (\`cm_prompts.md\`)${pr(66)}`,
          `Session-Übersicht als Baum Workspace › Projekt › Session, auch für Ordner ohne Sessions${pr(66)}`,
          `Schneller Start${pr(67)}`,
        ],
      ],
      ['Fehlerbehebungen', [`Die Titelleiste überdeckt die Suche nicht mehr ([#12](https://github.com/qzconnor/claude-manager/issues/12))${pr(66)}`]],
    ])
    expect(context.commitGroups[0]?.commits[0]).toMatchObject({ hash: 'c95f641' })
  })

  it('splits a title that names several changes', () => {
    const context = splitReleaseNotes(
      { ...LINKS, commitGroups: [{ title: 'Neue Funktionen' as string | false, commits: [{ subject: `Workspaces; die Titelleiste zeigt den Kontext${pr(66)}` }] }] },
      TYPES,
    )
    expect(context.commitGroups[0]?.commits.map((c) => c.subject)).toEqual([`Workspaces${pr(66)}`, `Die Titelleiste zeigt den Kontext${pr(66)}`])
  })
})

describe('splitNoteItems', () => {
  // As GitHub renders the notes of 1.51.0.
  const links =
    ' (<a href="https://github.com/qzconnor/claude-manager/issues/66" data-hovercard-type="pull_request">#66</a>)' +
    ' (<a href="https://github.com/qzconnor/claude-manager/commit/c95f641"><tt>c95f641</tt></a>)'

  it('makes one item of each change, each with the links', () => {
    const html = `<h3>Neue Funktionen</h3>\n<ul>\n<li>Workspaces mit gemeinsamem Prompt (<code>a; b</code>); die Titelleiste zeigt den Kontext${links}</li>\n<li>Nur eins${links}</li>\n</ul>`
    expect(splitNoteItems(html)).toBe(
      `<h3>Neue Funktionen</h3>\n<ul>\n<li>Workspaces mit gemeinsamem Prompt (<code>a; b</code>)${links}</li>\n<li>Die Titelleiste zeigt den Kontext${links}</li>\n<li>Nur eins${links}</li>\n</ul>`,
    )
  })

  it('leaves items with one change and nested lists as they are', () => {
    const html = '<ul><li>Drag &amp; Drop</li><li>Oben<ul><li>a; b</li></ul></li></ul>'
    expect(splitNoteItems(html)).toBe('<ul><li>Drag &amp; Drop</li><li>Oben<ul><li>a</li>\n<li>B</li></ul></li></ul>')
  })
})
