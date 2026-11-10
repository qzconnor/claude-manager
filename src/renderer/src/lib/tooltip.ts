import { reactive, type Directive } from 'vue'

/**
 * `v-tooltip="text"`: the app's tooltip instead of the browser's `title`, which looks foreign. One
 * tooltip is shown at a time, by `AppTooltip` with the same look as `<Tooltip>`; above the element,
 * `v-tooltip.bottom` (`.left`, `.right`) puts it on another side. Without text there is none.
 */

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

/** The tooltip shown right now: the element it belongs to (null: none), its text and side. */
export const tooltip = reactive<{ el: HTMLElement | null; text: string; side: TooltipSide; animated: boolean }>({
  el: null,
  text: '',
  side: 'top',
  animated: true,
})

/** As the TooltipProvider in App.vue. */
const DELAY_MS = 400
/** Right after a tooltip closed the next one comes at once, as reka's tooltips do. */
const SKIP_DELAY_MS = 300

interface State {
  text: string
  side: TooltipSide
  timer: number | undefined
  /** Shows the tooltip as when the pointer comes onto the element. */
  arm: () => void
  off: () => void
}
const states = new WeakMap<HTMLElement, State>()
let closedAt = 0
let suppressed = false

/** While something is dragged no tooltip comes (the dragged element keeps the pointer): it would only be in the way. */
export function suppressTooltips(on: boolean): void {
  suppressed = on
  if (on) hideTooltip()
}

function show(el: HTMLElement, animated: boolean): void {
  const state = states.get(el)
  if (suppressed || !state?.text) return
  tooltip.animated = animated && tooltip.el === null
  tooltip.el = el
  tooltip.text = state.text
  tooltip.side = state.side
}

/** Closes the tooltip; with `el` only if it is that element's. */
export function hideTooltip(el?: HTMLElement): void {
  if (!tooltip.el || (el && tooltip.el !== el)) return
  tooltip.el = null
  closedAt = Date.now()
}

/** The nearest element from `from` up that has a tooltip and holds `target`. */
function outer(from: HTMLElement, target: Element): HTMLElement | null {
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    if (states.has(node) && node.contains(target)) return node
  }
  return null
}

const SIDES: TooltipSide[] = ['top', 'right', 'bottom', 'left']
const sideOf = (modifiers: Partial<Record<string, boolean>>) => SIDES.find((side) => modifiers[side]) ?? 'top'

/** Screen readers get the text as the element's description, as they did the `title`; not twice, though. */
function describe(el: HTMLElement, text: string): void {
  if (text && text !== el.getAttribute('aria-label') && text !== el.textContent?.trim()) el.setAttribute('aria-description', text)
  else el.removeAttribute('aria-description')
}

export const vTooltip: Directive<HTMLElement, string | null | undefined> = {
  mounted(el, binding) {
    const clear = () => {
      window.clearTimeout(state.timer)
      state.timer = undefined
    }
    // While another one is open (e.g. that of the element around this one) or just closed, at once.
    const arm = () => {
      if (!state.text) return
      clear()
      if (tooltip.el || Date.now() - closedAt < SKIP_DELAY_MS) show(el, false)
      else state.timer = window.setTimeout(() => show(el, true), DELAY_MS)
    }
    const state: State = { text: binding.value ?? '', side: sideOf(binding.modifiers), timer: undefined, arm, off: () => {} }
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') arm()
    }
    // Back onto an element around this one with a tooltip of its own: that one's, as with `title`.
    const leave = (event: Event) => {
      clear()
      hideTooltip(el)
      const to = (event as PointerEvent).relatedTarget
      const around = to instanceof Element && el.parentElement ? outer(el.parentElement, to) : null
      if (around) states.get(around)?.arm()
    }
    // From the keyboard it comes at once, as reka's do; not when a click gave the focus.
    const focus = () => {
      if (el.matches(':focus-visible')) show(el, true)
    }
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('pointerdown', leave)
    el.addEventListener('focus', focus)
    el.addEventListener('blur', leave)
    state.off = () => {
      clear()
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('pointerdown', leave)
      el.removeEventListener('focus', focus)
      el.removeEventListener('blur', leave)
    }
    states.set(el, state)
    describe(el, state.text)
  },
  updated(el, binding) {
    const state = states.get(el)
    if (!state) return
    state.text = binding.value ?? ''
    state.side = sideOf(binding.modifiers)
    describe(el, state.text)
    if (tooltip.el !== el) return
    if (!state.text) hideTooltip(el)
    else {
      tooltip.text = state.text
      tooltip.side = state.side
    }
  },
  beforeUnmount(el) {
    states.get(el)?.off()
    states.delete(el)
    hideTooltip(el)
  },
}
