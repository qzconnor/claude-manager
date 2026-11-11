import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useFileTreeStore, type TreeTarget } from '@/stores/file-tree'
import { useTerminalsStore, type GroupView } from '@/stores/terminals'

/**
 * Opening and closing the file tree of a tab, the same way from its button, the keyboard and the
 * command palette. In groups a tree belongs to the tab a group shows (for a file's changes the tree it
 * came from); in one tab bar to the terminal the window works in, and it is part of the terminals page.
 */
export function useFileTreeToggle() {
  const fileTree = useFileTreeStore()
  const terminals = useTerminalsStore()
  const router = useRouter()

  const onTerminals = () => router.currentRoute.value.name === 'terminals'

  /** The tree the keyboard means: that of the focused group, or of the terminal the window works in. */
  const focusedTarget = computed(() =>
    terminals.grouped ? fileTree.targetOfGroup(terminals.activeGroup) : fileTree.targetOf(terminals.workingTerminal),
  )
  /** The group the keyboard is in, with the tabs in groups. */
  const focusedGroup = computed(() => (terminals.grouped ? terminals.activeGroup : null))

  /**
   * The tree of a tab is on screen: in a group (`group`, whose tree `target` is) beside the tab it shows,
   * in one tab bar only on the terminals page.
   */
  function shown(target: TreeTarget | null | undefined, group: GroupView | null = null): boolean {
    if (!target || !fileTree.isOpen(target.id)) return false
    if (!terminals.grouped) return onTerminals()
    return !group || fileTree.shownIn(target, group)
  }

  /**
   * False without a tree (the tab works in no folder). In a group (`group`, whose tree `target` is) beside
   * the tab it shows; from another page the tree opens and the terminals come back.
   */
  function toggle(target: TreeTarget | null | undefined = focusedTarget.value, group: GroupView | null = focusedGroup.value): boolean {
    if (!target) return false
    if (!terminals.grouped && !onTerminals()) {
      fileTree.setOpen(target.id, true)
      void router.push({ name: 'terminals' })
      return true
    }
    if (terminals.grouped && group) fileTree.toggleIn(target, group)
    else fileTree.toggle(target.id)
    return true
  }

  return { focusedTarget, focusedGroup, shown, toggle }
}
