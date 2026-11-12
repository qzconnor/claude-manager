import { describe, expect, it } from 'vitest'
import type { Artifact } from '@shared/types'
import { filterArtifacts, pinnedFirst } from './artifacts'

function artifact(id: string, patch: Partial<Artifact> = {}): Artifact {
  return {
    id,
    url: `https://claude.ai/code/artifact/${id}`,
    title: id,
    description: null,
    label: null,
    kind: 'page',
    mine: true,
    renamable: true,
    ownerEmail: null,
    external: false,
    audience: 'owner',
    createdAt: null,
    updatedAt: null,
    lastViewedAt: null,
    views: null,
    pinned: false,
    ...patch,
  }
}

describe('filterArtifacts', () => {
  const list = [
    artifact('a', { title: 'Umsatz Übersicht', mine: true, pinned: true }),
    artifact('b', { title: 'Rezepte', description: 'Für die Woche', mine: false, ownerEmail: 'kollegin@example.com' }),
    artifact('c', { title: 'Plan', label: 'Entwurf zwei', mine: true }),
  ]

  it('keeps own, shared or pinned ones', () => {
    expect(filterArtifacts(list, 'all', '').map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(filterArtifacts(list, 'mine', '').map((a) => a.id)).toEqual(['a', 'c'])
    expect(filterArtifacts(list, 'shared', '').map((a) => a.id)).toEqual(['b'])
    expect(filterArtifacts(list, 'pinned', '').map((a) => a.id)).toEqual(['a'])
  })

  it('finds every word in title, description, version and owner, without case or accents', () => {
    expect(filterArtifacts(list, 'all', 'ubersicht').map((a) => a.id)).toEqual(['a'])
    expect(filterArtifacts(list, 'all', 'woche rezepte').map((a) => a.id)).toEqual(['b'])
    expect(filterArtifacts(list, 'all', 'entwurf').map((a) => a.id)).toEqual(['c'])
    expect(filterArtifacts(list, 'all', 'kollegin').map((a) => a.id)).toEqual(['b'])
    expect(filterArtifacts(list, 'all', 'woche plan')).toEqual([])
  })

  it('combines the filter and the words', () => {
    expect(filterArtifacts(list, 'mine', 'rezepte')).toEqual([])
  })
})

describe('pinnedFirst', () => {
  it('puts pinned ones first and keeps the order otherwise', () => {
    const list = [artifact('a'), artifact('b', { pinned: true }), artifact('c'), artifact('d', { pinned: true })]
    expect(pinnedFirst(list).map((a) => a.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})
