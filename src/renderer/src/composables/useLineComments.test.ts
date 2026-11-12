import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef } from 'vue'
import type { DiffLine } from '@/lib/file-diff'

vi.mock('@/stores/terminals', () => ({ useTerminalsStore: () => ({ terminals: [], focusedAt: () => 0 }) }))

const hunk: DiffLine = { kind: 'hunk', text: '@@', old: null, new: null }
const ctx = (old: number, now: number): DiffLine => ({ kind: 'context', text: 'x', old, new: now })
const del = (old: number): DiffLine => ({ kind: 'del', text: 'alt', old, new: null })
const add = (now: number): DiffLine => ({ kind: 'add', text: 'neu', old: null, new: now })

// 0 head, 1 ctx 1, 2 del 2, 3 add 2, 4 add 3, 5 ctx 3/4
const LINES = [hunk, ctx(1, 1), del(2), add(2), add(3), ctx(3, 4)]

/** Picking with the pointer: a press, moves over lines, and the release, as the window gets them. */
const events = new EventTarget()
const press = (shiftKey = false) => ({ shiftKey }) as PointerEvent

async function setup() {
  const { useLineComments } = await import('./useLineComments')
  const { useReviewStore } = await import('@/stores/review')
  const root = ref('C:\\repo')
  const lines = shallowRef<DiffLine[]>(LINES)
  const under = ref<{ path: string; index: number } | null>(null)
  const scope = effectScope()
  const comments = scope.run(() =>
    useLineComments({ root: () => root.value, linesOf: (path) => (path === 'a.ts' ? lines.value : null), placeAt: () => under.value }),
  )!
  return { comments, review: useReviewStore(), root, lines, under, scope }
}

function moveTo(under: { value: { path: string; index: number } | null }, index: number, path = 'a.ts') {
  under.value = { path, index }
  events.dispatchEvent(new Event('pointermove'))
}

beforeEach(() => {
  vi.stubGlobal('window', events)
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('picking lines', () => {
  it('picks the lines pressed and dragged over, without a head at the end, and writes a comment on them', async () => {
    const { comments, under, review } = await setup()
    comments.pick('a.ts', 4, press())
    moveTo(under, 0)
    expect(comments.selection.value).toEqual({ path: 'a.ts', first: 1, last: 4 })
    // Over another file nothing changes.
    moveTo(under, 3, 'b.ts')
    expect(comments.selection.value).toEqual({ path: 'a.ts', first: 1, last: 4 })
    events.dispatchEvent(new Event('pointerup'))

    expect(comments.picking.value).toBeNull()
    expect(comments.draft.value).toEqual({ path: 'a.ts', from: { side: 'new', line: 1 }, to: { side: 'new', line: 3 }, text: '', id: null })
    expect(comments.draftLabel.value).toBe('Zeilen 1–3')
    expect(comments.marksOf('a.ts', 2)).toMatchObject({ selected: true, commented: false })
    expect(comments.marksOf('a.ts', 5).selected).toBe(false)
    expect(comments.canSave.value).toBe(false)

    comments.draft.value!.text = '  Bitte so.  '
    expect(comments.canSave.value).toBe(true)
    comments.save()
    expect(comments.draft.value).toBeNull()
    const [saved] = review.of('C:\\repo')
    expect(saved).toMatchObject({ path: 'a.ts', ref: { start: 1, end: 3, removed: null }, text: 'Bitte so.' })

    // Its lines show it, its first one with its mark.
    expect(comments.marksOf('a.ts', 1)).toEqual({ selected: false, commented: true, comment: saved, tooltip: 'Bitte so.' })
    expect(comments.marksOf('a.ts', 3)).toEqual({ selected: false, commented: true, comment: null, tooltip: null })
    expect(comments.marksOf('a.ts', 5)).toEqual({ selected: false, commented: false, comment: null, tooltip: null })
  })

  it('widens the lines of the comment being written with Umschalt, keeping its words', async () => {
    const { comments, under } = await setup()
    comments.pick('a.ts', 3, press())
    events.dispatchEvent(new Event('pointerup'))
    comments.draft.value!.text = 'Hier'

    comments.pick('a.ts', 5, press(true))
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draft.value).toMatchObject({ from: { side: 'new', line: 2 }, to: { side: 'new', line: 4 }, text: 'Hier' })

    // Upwards from its last line.
    comments.pick('a.ts', 2, press(true))
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draft.value).toMatchObject({ from: { side: 'old', line: 2 }, to: { side: 'new', line: 4 } })
    expect(comments.draftLabel.value).toBe('Zeilen 2–4')

    // Without Umschalt other lines, the words stay.
    comments.pick('a.ts', 1, press())
    moveTo(under, 1)
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draft.value).toMatchObject({ from: { side: 'new', line: 1 }, to: { side: 'new', line: 1 }, text: 'Hier' })
  })

  it('points removed lines alone to where they were', async () => {
    const { comments, review } = await setup()
    comments.pick('a.ts', 2, press())
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draftLabel.value).toBe('Entfernte Zeile 2')
    comments.draft.value!.text = 'Warum weg?'
    comments.save()
    expect(review.of('C:\\repo')[0]).toMatchObject({ from: { side: 'old', line: 2 }, ref: { start: 2, end: 2, removed: { start: 2, end: 2 } } })
  })

  it('lets a press on a head alone, or a cancelled one, pick nothing', async () => {
    const { comments } = await setup()
    comments.pick('a.ts', 0, press())
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draft.value).toBeNull()

    comments.pick('a.ts', 1, press())
    events.dispatchEvent(new Event('pointercancel'))
    expect(comments.selection.value).toBeNull()
    events.dispatchEvent(new Event('pointerup'))
    expect(comments.draft.value).toBeNull()
  })
})

describe('changing a comment', () => {
  it('opens it with its words, keeps changes and moves it to lines picked with Umschalt', async () => {
    const { comments, review } = await setup()
    const saved = review.add({
      root: 'C:\\repo',
      path: 'a.ts',
      from: { side: 'new', line: 2 },
      to: { side: 'new', line: 2 },
      ref: { start: 2, end: 2, removed: null },
      text: 'Alt',
    })
    comments.edit(saved)
    expect(comments.draft.value).toEqual({ path: 'a.ts', from: saved.from, to: saved.to, text: 'Alt', id: saved.id })
    comments.pick('a.ts', 5, press(true))
    events.dispatchEvent(new Event('pointerup'))
    comments.draft.value!.text = 'Neu'
    comments.save()
    expect(review.of('C:\\repo')).toEqual([{ ...saved, to: { side: 'new', line: 4 }, ref: { start: 2, end: 4, removed: null }, text: 'Neu' }])
  })

  it('keeps where it pointed when its lines are gone, while a new one can only wait', async () => {
    const { comments, review, lines } = await setup()
    const saved = review.add({
      root: 'C:\\repo',
      path: 'a.ts',
      from: { side: 'new', line: 2 },
      to: { side: 'new', line: 2 },
      ref: { start: 2, end: 2, removed: null },
      text: 'Alt',
    })
    comments.edit(saved)
    lines.value = [hunk, ctx(1, 1)]
    expect(comments.draftLabel.value).toBe('Zeile 2')
    comments.draft.value!.text = 'Trotzdem'
    comments.save()
    expect(review.get(saved.id)?.text).toBe('Trotzdem')
    expect(comments.marksOf('a.ts', 1).commented).toBe(false)

    comments.pick('a.ts', 1, press())
    events.dispatchEvent(new Event('pointerup'))
    comments.draft.value!.text = 'Neu'
    lines.value = [hunk]
    expect(comments.draftLabel.value).toBe('Die Zeilen gibt es so nicht mehr')
    expect(comments.canSave.value).toBe(false)
    comments.save()
    expect(review.of('C:\\repo')).toHaveLength(1)
  })

  it('deletes it, and lets go of a draft in another folder', async () => {
    const { comments, review, root } = await setup()
    const saved = review.add({
      root: 'C:\\repo',
      path: 'a.ts',
      from: { side: 'new', line: 1 },
      to: { side: 'new', line: 1 },
      ref: { start: 1, end: 1, removed: null },
      text: 'Weg',
    })
    comments.edit(saved)
    comments.remove()
    expect(review.of('C:\\repo')).toEqual([])
    expect(comments.draft.value).toBeNull()

    comments.pick('a.ts', 1, press())
    events.dispatchEvent(new Event('pointerup'))
    root.value = 'C:\\other'
    await nextTick()
    expect(comments.draft.value).toBeNull()
  })

  it('stops following the pointer when it ends', async () => {
    const { comments, scope, under } = await setup()
    comments.pick('a.ts', 1, press())
    scope.stop()
    moveTo(under, 4)
    expect(comments.selection.value).toEqual({ path: 'a.ts', first: 1, last: 1 })
  })
})
