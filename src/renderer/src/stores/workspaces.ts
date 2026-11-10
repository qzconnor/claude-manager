import { defineStore } from 'pinia'
import { ref } from 'vue'
import { folderKey } from '@shared/folders'
import type { Workspace, WorkspaceCreateInput } from '@shared/types'

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

  window.api.workspaces.onChanged(() => {
    if (loaded.value) void load()
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
  }
})
