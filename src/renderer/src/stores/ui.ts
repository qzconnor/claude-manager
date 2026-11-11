import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PaneDirection } from '@shared/panes'
import type { ThemeContent } from '@shared/themes/types'
import type { DialogOptions } from '@shared/types'
import type { SessionRef } from '@/composables/useSessionDetail'
import type { DropSide } from '@/lib/workspace'

export type ConfirmOptions = DialogOptions

/** Between two questions of the confirmation dialog: the first fades out (100 ms), the next one comes. */
const NEXT_CONFIRM_MS = 150

/** A tab dragged over the page: dropped now, it goes on `side` of the terminal `targetId`. */
export interface TabDock {
  tabId: string
  targetId: string
  side: PaneDirection
}

/** With the tabs in groups, a tab dragged over the window: dropped now, it goes into the group `groupId` or on `side` of it. */
export interface GroupDock {
  tabId: string
  groupId: string
  side: DropSide
}

/**
 * What `WorkspaceDialog` asks for: a new workspace (in `parent`), making an existing folder one, or
 * the prompt of a workspace.
 */
export type WorkspaceRequest =
  /** `move`: a folder that moves into the new workspace once it is made, with how many sessions the list shows in it. */
  | { mode: 'create'; parent?: string | null; move?: { path: string } }
  | { mode: 'adopt'; path: string }
  | { mode: 'edit'; path: string }

/** What `ThemeEditorDialog` edits: a theme of the user (`id`), or a new one that starts with the colors of `from`. */
export type ThemeEditorRequest = { mode: 'edit'; id: string } | { mode: 'create'; from: ThemeContent }

/** Transient UI state shared across components (dialogs, palette, search requests). */
export const useUiStore = defineStore('ui', () => {
  /**
   * The quick open (like VS Code's): what is typed decides what it searches. Without a prefix the
   * tabs and sessions, after `>` the commands, after `?` it lists the prefixes.
   */
  const paletteOpen = ref(false)
  const paletteQuery = ref('')

  /** Opens the quick open with `prefix` typed; asked again with the same prefix, it closes. */
  function openPalette(prefix = '') {
    if (paletteOpen.value && (prefix ? paletteQuery.value.startsWith(prefix) : !/^[>?]/.test(paletteQuery.value))) {
      paletteOpen.value = false
      return
    }
    paletteQuery.value = prefix
    paletteOpen.value = true
  }
  /** Incremented to ask the active terminal to open its search bar. */
  const searchRequest = ref(0)
  /** Incremented to put the keyboard into the search of the settings page. */
  const settingsSearchRequest = ref(0)
  /** Incremented to give the keyboard back to the active terminal, e.g. after a popup closed. */
  const focusTerminalRequest = ref(0)
  /** The command palette closes and gives the keyboard to the tab in front instead of the terminal. */
  const focusTabsRequest = ref(false)
  /** A session the sessions page should select, with the search that found it. */
  const sessionToShow = ref<(SessionRef & { query: string }) | null>(null)
  /**
   * A folder (or workspace) the sessions page should open and scroll to; `accountId`: the account
   * whose sessions it is about, so a hidden standard account shows.
   */
  const folderToShow = ref<{ accountId?: string; path: string | null; projectKey?: string } | null>(null)
  const workspaceRequest = ref<WorkspaceRequest | null>(null)
  /** Asks for the name of a new project in a workspace (`ProjectDialog`), then starts a session in it. */
  const projectRequest = ref<{ workspace: string; name: string } | null>(null)
  /** Asks for a session's name (`SessionRenameDialog`): `name` is the one it has, null without one. */
  const sessionRenameRequest = ref<{ sessionId: string; title: string; name: string | null } | null>(null)
  /** The tab of this terminal opens its name for editing, as from its menu (e.g. from the command palette). */
  const tabRenameRequest = ref<string | null>(null)
  /** Asks for a worktree name before a session starts in one (`WorktreeDialog`); `cwd` null asks for the folder too. */
  const worktreeRequest = ref<{ accountId: string; cwd: string | null } | null>(null)
  const themeEditorRequest = ref<ThemeEditorRequest | null>(null)
  /**
   * Left and right edge (viewport px) of the selected tab in the title bar, as far as it is visible.
   * The page below opens its top border there, so the tab merges into it.
   */
  const selectedTabEdges = ref<{ left: number; right: number } | null>(null)
  /** The tab under the mouse; with the tabs in groups, the tabs that go with it look hovered too. */
  const hoveredTab = ref<string | null>(null)
  /** Id of the tab being dragged to another position; hover cards stay closed meanwhile. */
  const draggingTab = ref<string | null>(null)
  /** Where the dragged tab lands if dropped on the page now; the page shows it. */
  const tabDock = ref<TabDock | null>(null)
  /** The same with the tabs in groups. */
  const groupDock = ref<GroupDock | null>(null)

  const confirmState = ref<(ConfirmOptions & { open: boolean }) | null>(null)
  /** The question shown, and those that wait for it: one never answers another one with No. */
  let shownConfirm: ((value: boolean) => void) | null = null
  const waitingConfirms: { options: ConfirmOptions; resolve: (value: boolean) => void }[] = []

  function showNextConfirm(): void {
    const next = waitingConfirms.shift()
    if (!next) return
    shownConfirm = next.resolve
    confirmState.value = { ...next.options, open: true }
  }

  /**
   * Asks in the confirmation dialog. While it asks something else (e.g. a question of the main process
   * comes while „Session löschen?“ is open), this one waits its turn.
   */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      waitingConfirms.push({ options, resolve })
      if (!shownConfirm) showNextConfirm()
    })
  }

  function settleConfirm(result: boolean): void {
    const resolve = shownConfirm
    if (!resolve) return
    shownConfirm = null
    if (confirmState.value) confirmState.value = { ...confirmState.value, open: false }
    resolve(result)
    // Once the dialog has gone, so the next one is seen to be another question.
    if (waitingConfirms.length > 0) setTimeout(() => shownConfirm ?? showNextConfirm(), NEXT_CONFIRM_MS)
  }

  return {
    paletteOpen,
    paletteQuery,
    openPalette,
    searchRequest,
    settingsSearchRequest,
    focusTerminalRequest,
    focusTabsRequest,
    sessionToShow,
    folderToShow,
    worktreeRequest,
    workspaceRequest,
    projectRequest,
    sessionRenameRequest,
    tabRenameRequest,
    themeEditorRequest,
    selectedTabEdges,
    hoveredTab,
    draggingTab,
    tabDock,
    groupDock,
    confirmState,
    confirm,
    settleConfirm,
  }
})
