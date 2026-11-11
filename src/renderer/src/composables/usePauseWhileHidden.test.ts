import { createRenderer, defineComponent, h, KeepAlive, nextTick, ref, watch } from '@vue/runtime-core'
import { describe, expect, it } from 'vitest'
import { usePauseWhileHidden } from './usePauseWhileHidden'

/** A renderer without a DOM, enough for KeepAlive to move a page in and out. */
type Node = { tag: string; text: string; children: Node[]; parent: Node | null }
const node = (tag: string, text = ''): Node => ({ tag, text, children: [], parent: null })
const { render } = createRenderer<Node, Node>({
  createElement: (tag) => node(tag),
  createText: (text) => node('#text', text),
  createComment: (text) => node('#comment', text),
  setText: (n, text) => (n.text = text),
  setElementText: (n, text) => {
    n.children = []
    n.text = text
  },
  insert: (child, parent, anchor) => {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(at === -1 ? parent.children.length : at, 0, child)
    child.parent = parent
  },
  remove: (child) => {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  },
  parentNode: (n) => n.parent,
  nextSibling: (n) => (n.parent ? (n.parent.children[n.parent.children.indexOf(n) + 1] ?? null) : null),
  patchProp: () => {},
})

const textOf = (n: Node): string => n.text + n.children.map(textOf).join('')

describe('usePauseWhileHidden', () => {
  it('neither renders nor watches while hidden, and catches up once shown', async () => {
    const count = ref(0)
    const page = ref<'list' | 'other'>('list')
    let renders = 0
    const seen: number[] = []
    let shown: Readonly<{ value: boolean }> = { value: false }
    const List = defineComponent({
      setup() {
        shown = usePauseWhileHidden()
        watch(count, (value) => seen.push(value))
        return () => {
          renders++
          return h('div', `count ${count.value}`)
        }
      },
    })
    const Other = defineComponent({ render: () => h('div', 'other') })
    const root = node('root')
    render(h(defineComponent({ render: () => h(KeepAlive, null, [page.value === 'list' ? h(List) : h(Other)]) })), root)
    await nextTick()
    expect(shown.value).toBe(true)

    count.value = 1
    await nextTick()
    expect([renders, seen]).toEqual([2, [1]])

    page.value = 'other'
    await nextTick()
    expect(shown.value).toBe(false)
    count.value = 2
    await nextTick()
    count.value = 3
    await nextTick()
    // Hidden: no rendering, no watcher.
    expect([renders, seen]).toEqual([2, [1]])

    page.value = 'list'
    await nextTick()
    // Shown again: once, with the latest value.
    expect(shown.value).toBe(true)
    expect([renders, seen]).toEqual([3, [1, 3]])
    expect(textOf(root)).toBe('count 3')
  })
})
