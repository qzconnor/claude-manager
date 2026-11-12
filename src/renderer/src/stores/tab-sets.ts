import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import type { TabSet, TabSetInput } from '@shared/types'
import { toastError } from '@/lib/errors'
import { router } from '@/router'
import { useTerminalsStore } from './terminals'

/** Tabs saved under a name (sessions, shells, browsers, split tabs), to open them all again with one click. */
export const useTabSetsStore = defineStore('tabSets', () => {
  const terminals = useTerminalsStore()
  const sets = ref<TabSet[]>([])
  /** The set whose tabs are opening. */
  const opening = ref<string | null>(null)

  async function load(): Promise<void> {
    sets.value = await window.api.tabSets.list()
  }

  function get(id: string): TabSet | undefined {
    return sets.value.find((s) => s.id === id)
  }

  /** Makes a set, or replaces the one with `input.id`. */
  async function save(input: TabSetInput): Promise<TabSet> {
    // Like Electron's IPC: structured-cloned, which fails on Vue's reactive proxies.
    const saved = await window.api.tabSets.save(JSON.parse(JSON.stringify(input)) as TabSetInput)
    const at = sets.value.findIndex((s) => s.id === saved.id)
    sets.value = at < 0 ? [...sets.value, saved] : sets.value.map((s) => (s.id === saved.id ? saved : s))
    return saved
  }

  /** Deletes the set; the toast can bring it back. */
  async function remove(id: string): Promise<void> {
    const set = get(id)
    try {
      await window.api.tabSets.remove(id)
    } catch (error) {
      toastError(error, 'Tab-Set konnte nicht gelöscht werden')
      return
    }
    sets.value = sets.value.filter((s) => s.id !== id)
    if (!set) return
    toast(`Tab-Set „${set.name}“ gelöscht`, {
      action: {
        label: 'Rückgängig',
        onClick: () => void save({ name: set.name, tabs: set.tabs }).catch((error) => toastError(error, 'Tab-Set kam nicht zurück')),
      },
    })
  }

  /**
   * Opens the tabs of the set after the open ones and shows the first; tells which didn't open and why.
   * A session that runs in a tab already is that tab.
   */
  async function open(id: string): Promise<void> {
    const set = get(id)
    if (!set || opening.value === id) return
    opening.value = id
    try {
      const result = await window.api.tabSets.open(id)
      if (result.firstId) {
        if (router.currentRoute.value.name !== 'terminals') await router.push({ name: 'terminals' })
        terminals.activate(result.firstId)
      }
      const failed = result.failed
      if (failed.length) {
        const total = set.tabs.length
        toast.warning(
          failed.length === total
            ? `„${set.name}“ hat keinen Tab geöffnet`
            : `${failed.length} von ${total} Tabs aus „${set.name}“ nicht geöffnet`,
          { description: failed.map((f) => `${f.title}: ${f.reason}`).join(' '), duration: 10_000 },
        )
      }
    } catch (error) {
      toastError(error, 'Tab-Set konnte nicht geöffnet werden')
    } finally {
      opening.value = null
    }
  }

  window.api.tabSets.onChanged((next) => {
    sets.value = next
  })
  load().catch(() => undefined)

  return { sets, opening, load, get, save, remove, open }
})
