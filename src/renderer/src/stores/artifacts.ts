import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Artifact, ArtifactList, SessionRef } from '@shared/types'

const key = (...parts: (string | boolean)[]) => parts.join('\n')

/**
 * The artifacts of the accounts' logins for the page „Artefakte“: their lists, thumbnails and the
 * sessions they were made in, kept while the app runs so the page shows them at once when it opens again.
 */
export const useArtifactsStore = defineStore('artifacts', () => {
  const lists = ref<Record<string, ArtifactList>>({})
  const loading = ref<Record<string, boolean>>({})
  /** Thumbnails as `data:` URLs by account, artifact and dark or light; null without one. */
  const thumbnails = ref<Record<string, string | null>>({})
  const pendingThumbnails = new Set<string>()
  /** The session an artifact was made in, by account and artifact; null when none mentions it. */
  const sessions = ref<Record<string, SessionRef | null>>({})
  let sessionRun = 0

  async function load(accountId: string): Promise<void> {
    if (loading.value[accountId]) return
    loading.value[accountId] = true
    try {
      const list = await window.api.artifacts.list(accountId)
      // The links of the thumbnails change with every list.
      for (const k of Object.keys(thumbnails.value)) if (k.startsWith(key(accountId, ''))) delete thumbnails.value[k]
      lists.value[accountId] = list
      void findSessions(accountId, list.artifacts)
    } finally {
      loading.value[accountId] = false
    }
  }

  /** Asks for an artifact's thumbnail once; `thumbnailOf` has it when it arrives. */
  function requestThumbnail(accountId: string, id: string, dark: boolean): void {
    const k = key(accountId, id, dark)
    if (k in thumbnails.value || pendingThumbnails.has(k)) return
    pendingThumbnails.add(k)
    window.api.artifacts
      .thumbnail(accountId, id, dark)
      .then(
        (url) => (thumbnails.value[k] = url),
        () => (thumbnails.value[k] = null),
      )
      .finally(() => pendingThumbnails.delete(k))
  }

  /** The thumbnail; undefined while it hasn't arrived (yet), null without one. */
  function thumbnailOf(accountId: string, id: string, dark: boolean): string | null | undefined {
    return thumbnails.value[key(accountId, id, dark)]
  }

  function sessionOf(accountId: string, id: string): SessionRef | null | undefined {
    return sessions.value[key(accountId, id)]
  }

  /**
   * The sessions whose conversation mentions an artifact's link: Claude names it once it published
   * one. One search after the other, through the sessions' full-text index.
   */
  async function findSessions(accountId: string, artifacts: Artifact[]): Promise<void> {
    const run = ++sessionRun
    for (const artifact of artifacts) {
      if (run !== sessionRun) return
      const k = key(accountId, artifact.id)
      if (sessions.value[k]) continue
      try {
        const [hit] = await window.api.sessions.search(`artifact/${artifact.id}`)
        sessions.value[k] = hit ? { accountId: hit.accountId, sessionId: hit.sessionId } : null
      } catch {
        sessions.value[k] = null
      }
    }
  }

  function update(accountId: string, id: string, patch: Partial<Artifact>): void {
    const list = lists.value[accountId]
    if (!list) return
    list.artifacts = list.artifacts.map((artifact) => (artifact.id === id ? { ...artifact, ...patch } : artifact))
  }

  async function rename(accountId: string, id: string, title: string): Promise<void> {
    await window.api.artifacts.rename(accountId, id, title)
    update(accountId, id, { title: title.replace(/\s+/g, ' ').trim() })
  }

  /** Deletes it for good; also when it was gone already, it leaves the list. */
  async function remove(accountId: string, id: string): Promise<'deleted' | 'gone'> {
    const result = await window.api.artifacts.remove(accountId, id)
    const list = lists.value[accountId]
    if (list) list.artifacts = list.artifacts.filter((artifact) => artifact.id !== id)
    return result
  }

  /** Pins it at once and takes that back if claude.ai refuses. */
  async function setPinned(accountId: string, id: string, pinned: boolean): Promise<void> {
    update(accountId, id, { pinned })
    try {
      await window.api.artifacts.setPinned(accountId, id, pinned)
    } catch (error) {
      update(accountId, id, { pinned: !pinned })
      throw error
    }
  }

  return { lists, loading, load, requestThumbnail, thumbnailOf, sessionOf, rename, remove, setPinned }
})
