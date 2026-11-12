import { onBeforeUnmount, watch } from 'vue'
import { locate, matchSpans } from '@/lib/search'

/** The name the style sheet colors (`::highlight(search-match)` in main.css). */
const NAME = 'search-match'
/** Text in an option that is no label: shortcuts. */
const SKIPPED = '[data-slot=command-shortcut]'

/**
 * Colors where the search terms occur in the options (`role=option`) under `root`, like VS Code's
 * quick open. It goes through the CSS Custom Highlight API: the options keep the DOM Vue rendered,
 * and every option is covered without marking up its label. Painted again whenever the options
 * change, before the browser draws them.
 */
export function useMatchHighlight(root: () => HTMLElement | null | undefined, terms: () => string[]): void {
  function paint() {
    const el = root()
    const current = terms()
    if (!el || current.length === 0) {
      CSS.highlights.delete(NAME)
      return
    }
    const ranges: Range[] = []
    for (const option of el.querySelectorAll('[role=option]')) {
      // The label's text nodes as one text, to find terms across them.
      const nodes: Text[] = []
      const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      })
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
      const text = nodes.map((node) => node.data).join('')
      for (const [start, end] of matchSpans(text, current)) {
        const range = document.createRange()
        const from = locate(nodes, start, false)
        const to = locate(nodes, end, true)
        range.setStart(from.node, from.offset)
        range.setEnd(to.node, to.offset)
        ranges.push(range)
      }
    }
    CSS.highlights.set(NAME, new Highlight(...ranges))
  }

  // Mutations are delivered before the browser paints, so no frame shows the options unmarked.
  const observer = new MutationObserver(paint)
  watch(
    root,
    (el, _old, onCleanup) => {
      if (!el) {
        CSS.highlights.delete(NAME)
        return
      }
      observer.observe(el, { childList: true, subtree: true, characterData: true })
      paint()
      onCleanup(() => observer.disconnect())
    },
    { immediate: true, flush: 'post' },
  )
  watch(terms, paint, { flush: 'post' })
  onBeforeUnmount(() => {
    observer.disconnect()
    CSS.highlights.delete(NAME)
  })
}
