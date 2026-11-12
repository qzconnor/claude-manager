import { getCurrentInstance, onActivated, onDeactivated, readonly, ref, type EffectScope, type Ref } from 'vue'

/**
 * Lets a page kept by `KeepAlive` rest while it is hidden: it doesn't render, and its watchers and
 * those of its composables don't run. What changed meanwhile is done once when it shows again.
 * Children have their own effects: they rest only if they call this too.
 *
 * @returns Whether the page is shown, for listeners outside Vue's effects.
 */
export function usePauseWhileHidden(): Readonly<Ref<boolean>> {
  // The scope holding the component's rendering and watchers. Vue keeps it out of its public types,
  // but `pause()`/`resume()` (Vue 3.5) are made for this: changes while paused run on `resume()`.
  const scope = (getCurrentInstance() as { scope?: EffectScope } | null)?.scope
  const shown = ref(true)
  onDeactivated(() => {
    shown.value = false
    scope?.pause()
  })
  onActivated(() => {
    scope?.resume()
    shown.value = true
  })
  return readonly(shown)
}
