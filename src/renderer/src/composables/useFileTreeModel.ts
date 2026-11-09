import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter, type ShallowRef } from 'vue'
import { useFileTreeStore, type TreeModel } from '@/stores/file-tree'

/**
 * The tree of a folder, loaded and watched while the component lives; another folder (e.g. once a
 * session's worktree is known) lets go of the old one.
 */
export function useFileTreeModel(root: MaybeRefOrGetter<string>): ShallowRef<TreeModel> {
  const store = useFileTreeStore()
  let held = toValue(root)
  const model = shallowRef(store.hold(held))
  watch(
    () => toValue(root),
    (next) => {
      if (next === held) return
      model.value = store.hold(next)
      store.release(held)
      held = next
    },
  )
  onScopeDispose(() => store.release(held))
  return model
}
