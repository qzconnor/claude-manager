import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { ReleaseNote, UpdateState } from '@shared/types'
import { attempt, errorMessage } from '@/lib/errors'
import { router } from '@/router'
import { useTerminalsStore } from './terminals'
import { useUiStore } from './ui'

export const useUpdatesStore = defineStore('updates', () => {
  const state = ref<UpdateState>({
    status: 'unsupported',
    current: '',
    next: null,
    progress: 0,
    checkedAt: null,
    error: null,
  })
  const releases = ref<ReleaseNote[] | null>(null)
  const releasesLoading = ref(false)
  const releasesError = ref<string | null>(null)
  /** Version whose notes were looked at – if the installed one differs, the app was updated. */
  const seenVersion = useLocalStorage<string | null>('claude-manager.seenVersion', null)

  /** A newer version is offered (also while downloading, or after a failed download). */
  const hasUpdate = computed(
    () =>
      ['available', 'downloading', 'downloaded'].includes(state.value.status) ||
      (state.value.status === 'error' && state.value.next !== null),
  )
  /** Updated since the notes were last opened – "what's new" is still to be seen. */
  const unseen = computed(() => !!state.value.current && !!seenVersion.value && seenVersion.value !== state.value.current)

  const show = () => void router.push({ name: 'updates' })

  let announced: string | null = null

  function apply(next: UpdateState): void {
    const before = state.value.status
    state.value = next
    if (next.status === 'available' && next.next && announced !== next.next) {
      announced = next.next
      toast(`Update auf ${next.next} verfügbar`, {
        description: 'Es lässt sich direkt in der App installieren.',
        duration: 12_000,
        action: { label: 'Ansehen', onClick: show },
      })
    }
    if (next.status === 'downloaded' && before !== 'downloaded') {
      toast.success('Update ist bereit', {
        description: `Version ${next.next} wird beim nächsten Start installiert.`,
        duration: 15_000,
        action: { label: 'Jetzt neu starten', onClick: () => void install() },
      })
    }
  }

  async function load(): Promise<void> {
    window.api.updates.onChanged(apply)
    window.api.updates.onShow(show)
    apply(await window.api.updates.state())

    // A fresh install has nothing new to announce.
    if (seenVersion.value === null) seenVersion.value = state.value.current
    else if (unseen.value) {
      toast.success(`Claude Manager ist jetzt auf Version ${state.value.current}`, {
        duration: 12_000,
        action: { label: 'Was ist neu?', onClick: show },
      })
    }
  }

  function markSeen(): void {
    seenVersion.value = state.value.current
  }

  /** Loads the notes again – the main process keeps them for a few minutes, so this is cheap. */
  async function loadReleases(): Promise<void> {
    releasesLoading.value = true
    try {
      releases.value = await window.api.updates.releases()
      releasesError.value = null
    } catch (error) {
      // Notes shown already stay; the error only matters without them.
      if (!releases.value?.length) releasesError.value = errorMessage(error)
    } finally {
      releasesLoading.value = false
    }
  }

  const check = () => attempt(() => window.api.updates.check(), 'Update-Suche fehlgeschlagen')
  const download = () => attempt(() => window.api.updates.download(), 'Download fehlgeschlagen')

  /** The installer closes the app, so running terminals are asked about before it starts. */
  async function install(): Promise<void> {
    const running = useTerminalsStore().runningCount
    if (running > 0) {
      const confirmed = await useUiStore().confirm({
        title: 'Neu starten und installieren?',
        description:
          running === 1
            ? 'Es läuft noch 1 Terminal. Es wird dabei geschlossen, Claude-Code-Sessions lassen sich danach über „Sessions“ fortsetzen.'
            : `Es laufen noch ${running} Terminals. Sie werden dabei geschlossen, Claude-Code-Sessions lassen sich danach über „Sessions“ fortsetzen.`,
        confirmText: 'Neu starten',
        destructive: true,
      })
      if (!confirmed) return
    }
    await attempt(() => window.api.updates.install(), 'Update konnte nicht installiert werden')
  }

  return {
    state,
    releases,
    releasesLoading,
    releasesError,
    hasUpdate,
    unseen,
    load,
    markSeen,
    loadReleases,
    check,
    download,
    install,
  }
})
