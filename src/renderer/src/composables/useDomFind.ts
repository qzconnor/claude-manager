import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { findSpans, locate } from '@/lib/search'

/** The names the style sheet colors (`::highlight(find-match)` and `find-current` in main.css). */
const MATCH = 'find-match'
const CURRENT = 'find-current'
/** What isn't text of the content: buttons, the find bar itself. */
const SKIPPED = 'button, [data-find-skip]'

/**
 * Find in a part of the window (Ctrl+F), like a browser's: every place the text occurs in `root` is
 * marked, the current one stronger, and `step` goes from one to the next and scrolls it into view.
 * Each `block` (e.g. a message) is searched as one text, also across the elements inside it.
 * Marked through the CSS Custom Highlight API, so the DOM stays as Vue rendered it; marked again
 * whenever it changes (more messages, a call opened).
 */
export function useDomFind(root: () => HTMLElement | null | undefined, block: string) {
  const query = ref('')
  const ranges = shallowRef<Range[]>([])
  /** 1-based; 0 without a current match. */
  const active = ref(0)

  function collect(): Range[] {
    const el = root()
    if (!el || !query.value) return []
    const found: Range[] = []
    for (const part of el.querySelectorAll<HTMLElement>(block)) {
      const nodes: Text[] = []
      const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
      const text = nodes.map((node) => node.data).join('')
      for (const [start, end] of findSpans(text, query.value)) {
        const range = document.createRange()
        const from = locate(nodes, start, false)
        const to = locate(nodes, end, true)
        range.setStart(from.node, from.offset)
        range.setEnd(to.node, to.offset)
        found.push(range)
      }
    }
    return found
  }

  function paint() {
    const all = ranges.value
    if (all.length === 0) {
      CSS.highlights.delete(MATCH)
      CSS.highlights.delete(CURRENT)
      return
    }
    const current = all[active.value - 1]
    CSS.highlights.set(MATCH, new Highlight(...all.filter((r) => r !== current)))
    if (current) CSS.highlights.set(CURRENT, new Highlight(current))
    else CSS.highlights.delete(CURRENT)
  }

  /** The scrolling box around the content. */
  function viewport(): HTMLElement | null {
    let el = root()?.parentElement ?? null
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement
    return el
  }

  /** Scrolls the current match into the upper third of the view, unless it is well inside it. */
  function reveal() {
    const range = ranges.value[active.value - 1]
    const box = viewport()
    if (!range || !box) return
    const rect = range.getBoundingClientRect()
    const view = box.getBoundingClientRect()
    const margin = Math.min(64, view.height / 4)
    if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) return
    box.scrollTop += rect.top - view.top - view.height / 3
  }

  /** The first match from the top of the view down, else the first one. */
  function firstInView(): number {
    const box = viewport()
    if (!box) return ranges.value.length ? 1 : 0
    const top = box.getBoundingClientRect().top
    const index = ranges.value.findIndex((range) => range.getBoundingClientRect().bottom >= top)
    return index === -1 ? (ranges.value.length ? 1 : 0) : index + 1
  }

  /** Searches anew for `text` (from the view on), or for the same text the next or previous match. */
  function search(text: string, forward = true, again = false) {
    if (again && text === query.value && ranges.value.length) return step(forward)
    query.value = text
    ranges.value = collect()
    active.value = firstInView()
    paint()
    reveal()
  }

  function step(forward: boolean) {
    const total = ranges.value.length
    if (total === 0) return
    active.value = forward ? (active.value % total) + 1 : ((active.value - 2 + total) % total) + 1
    paint()
    reveal()
  }

  function clear() {
    query.value = ''
    ranges.value = []
    active.value = 0
    paint()
  }

  // The content changes (more messages, a call opened): the matches again, the current one kept by its place.
  let frame = 0
  const observer = new MutationObserver(() => {
    if (!query.value || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const before = ranges.value[active.value - 1]
      const next = collect()
      const at = before ? next.findIndex((r) => r.compareBoundaryPoints(Range.START_TO_START, before) >= 0) : -1
      ranges.value = next
      active.value = next.length === 0 ? 0 : at === -1 ? Math.min(active.value, next.length) || 1 : at + 1
      paint()
    })
  })
  watch(
    root,
    (el, _old, onCleanup) => {
      if (!el) return
      observer.observe(el, { childList: true, subtree: true, characterData: true })
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )
  onBeforeUnmount(() => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    CSS.highlights.delete(MATCH)
    CSS.highlights.delete(CURRENT)
  })

  /** For the find bar: which match is the current one, of how many; null before a search. */
  const matches = computed(() => (query.value ? { active: active.value, total: ranges.value.length } : null))

  return { query, matches, search, step, clear }
}
