import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useFileTreeStore, type TreeTarget } from '@/stores/file-tree'
import { useTerminalsStore } from '@/stores/terminals'

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

  /** The tree of a tab is on screen: in one tab bar only on the terminals page. */
  function shown(target: TreeTarget | null | undefined): boolean {
    return !!target && fileTree.isOpen(target.id) && (terminals.grouped || onTerminals())
  }

  /** False without a tree (the tab works in no folder). From another page the tree opens and the terminals come back. */
  function toggle(target: TreeTarget | null | undefined = focusedTarget.value): boolean {
    if (!target) return false
    if (!terminals.grouped && !onTerminals()) {
      fileTree.setOpen(target.id, true)
      void router.push({ name: 'terminals' })
      return true
    }
    fileTree.toggle(target.id)
    return true
  }

  return { focusedTarget, shown, toggle }
}
