import { defineStore } from 'pinia'
import { ref } from 'vue'
import { toast } from 'vue-sonner'
import { folderKey } from '@shared/folders'
import type { FolderMoveResult, Workspace, WorkspaceCreateInput } from '@shared/types'
import { splitFolder } from '@/lib/recent-folders'

/** The workspaces: folders whose projects (subfolders) share a system prompt (`cm_prompts.md`). */
export const useWorkspacesStore = defineStore('workspaces', () => {
  const workspaces = ref<Workspace[]>([])
  const loaded = ref(false)
  /** Only the latest read counts: an older one still under way would undo a change made meanwhile, e.g. a new order. */
  let generation = 0
  let latest: Promise<void> = Promise.resolve()

  function load(): Promise<void> {
    const mine = ++generation
    const request = window.api.workspaces.list().then((next): Promise<void> | void => {
      // Overtaken: the caller waits for the newer read instead.
      if (mine !== generation) return latest
      workspaces.value = next
      loaded.value = true
    })
    latest = request
    return request
  }

  async function create(input: WorkspaceCreateInput): Promise<Workspace> {
    const workspace = await window.api.workspaces.create(input)
    await load()
    return workspace
  }

  async function adopt(path: string, prompt: string | null): Promise<Workspace> {
    const workspace = await window.api.workspaces.adopt(path, prompt)
    await load()
    return workspace
  }

  async function remove(path: string): Promise<void> {
    await window.api.workspaces.remove(path)
    await load()
  }

  /** Shows the new order at once and saves it; if that fails, the saved order comes back. */
  async function reorder(paths: string[]): Promise<void> {
    const rank = new Map(paths.map((path, i) => [folderKey(path), i]))
    const at = (w: Workspace) => rank.get(folderKey(w.path)) ?? paths.length
    workspaces.value = [...workspaces.value].sort((a, b) => at(a) - at(b))
    const saved = window.api.workspaces.reorder(paths)
    // Reads under way still have the old order: they make way for one after saving.
    generation++
    const reread = saved.catch(() => undefined).then(load)
    latest = reread
    await saved
    await reread
  }

  /** A new project folder in the workspace; resolves to its path once the list has it. */
  async function createProject(workspace: string, name: string): Promise<string> {
    const path = await window.api.workspaces.createProject(workspace, name)
    await load()
    return path
  }

  async function writePrompt(path: string, text: string): Promise<void> {
    await window.api.workspaces.writePrompt(path, text)
    await load()
  }

  /** Moves the folder into the folder `into` (a workspace); its sessions go along. */
  async function move(from: string, into: string): Promise<FolderMoveResult> {
    const result = await window.api.workspaces.move(from, into)
    await load()
    return result
  }

  /** The folder `from` is gone, it is `to` now: its sessions go there. Resolves to how many. */
  async function relocate(from: string, to: string): Promise<number> {
    const moved = await window.api.workspaces.relocate(from, to)
    await load()
    return moved
  }

  /** Folders of the session list that aren't there (any more), by `folderKey`. */
  const missing = ref<ReadonlySet<string>>(new Set())
  let checking = 0

  /** Finds out which of the folders aren't there; only the latest check counts. */
  async function checkFolders(paths: readonly string[]): Promise<void> {
    const mine = ++checking
    const gone = await window.api.app.missingFolders([...paths]).catch(() => null)
    if (gone === null || mine !== checking) return
    missing.value = new Set(gone.map(folderKey))
  }

  const isMissing = (path: string) => missing.value.has(folderKey(path))

  window.api.workspaces.onChanged(() => {
    if (loaded.value) void load()
  })
  // Moved in Explorer: the list shows it in its new place, and says so when sessions went along.
  window.api.workspaces.onMoved((moved) => {
    if (loaded.value) void load()
    if (moved.sessions === 0) return
    const name = splitFolder(moved.to).name
    const parent = splitFolder(splitFolder(moved.to).parent).name
    toast.info(`„${name}“ liegt jetzt in „${parent}“`, {
      description: `${moved.sessions === 1 ? 'Die Session ist' : `Die ${moved.sessions} Sessions sind`} mitgezogen und ${moved.sessions === 1 ? 'lässt' : 'lassen'} sich dort fortsetzen.`,
    })
  })

  return {
    workspaces,
    loaded,
    load,
    create,
    adopt,
    remove,
    reorder,
    createProject,
    readPrompt: (path: string) => window.api.workspaces.readPrompt(path),
    writePrompt,
    move,
    relocate,
    missing,
    checkFolders,
    isMissing,
  }
})
