import type { Artifact } from '@shared/types'
import { searchTerms } from '@shared/utils'
import { containsTerms, searchText } from './search'

export type ArtifactFilter = 'all' | 'mine' | 'shared' | 'pinned'

/** The artifacts of a filter whose title, description, version or owner contain every word of `query`. */
export function filterArtifacts(artifacts: readonly Artifact[], filter: ArtifactFilter, query: string): Artifact[] {
  const terms = searchTerms(query)
  return artifacts.filter((artifact) => {
    if (filter === 'mine' && !artifact.mine) return false
    if (filter === 'shared' && artifact.mine) return false
    if (filter === 'pinned' && !artifact.pinned) return false
    return terms.length === 0 || containsTerms(searchText(artifact.title, artifact.description, artifact.label, artifact.ownerEmail), terms)
  })
}

/** Pinned ones first, otherwise in the order of the list (most recently viewed first). */
export function pinnedFirst(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts.filter((a) => a.pinned), ...artifacts.filter((a) => !a.pinned)]
}
