import { computed, onScopeDispose, ref, watch } from 'vue'
import type { DiffLine } from '@/lib/file-diff'
import { lineRefOf, pointOf, refLabel, spanOf, spanOfComment, type LinePoint, type ReviewComment } from '@/lib/review-comments'
import { useReviewStore } from '@/stores/review'

/** A line of a file in the changes shown: its index in the file's lines. */
export interface LinePlace {
  path: string
  index: number
}

/** A comment being written (`id` null) or changed, and the lines it is on. */
export interface LineDraft {
  path: string
  from: LinePoint
  to: LinePoint
  text: string
  id: string | null
}

/** How a line shows the comments: picked for one, on lines of one, and the one starting there. */
export interface LineMarks {
  selected: boolean
  commented: boolean
  /** The comment starting on the line (its text in the tooltip of its mark), the first of several. */
  comment: ReviewComment | null
  tooltip: string | null
}

const NO_MARKS: LineMarks = { selected: false, commented: false, comment: null, tooltip: null }

/**
 * Comments on lines of changes, as in a review of a pull request: a press on a line's number picks it,
 * dragging or Umschalt+click picks more, then the comment is written below the changes and kept with
 * the others of the folder (see `useReviewStore`). `linesOf`: a file's lines as they show now (null
 * when not drawn); `placeAt`: the line under the pointer while picking.
 */
export function useLineComments(options: {
  root: () => string
  linesOf: (path: string) => readonly DiffLine[] | null
  placeAt: (event: PointerEvent) => LinePlace | null
}) {
  const review = useReviewStore()
  /** Lines being picked: the one pressed, the one the pointer is on, and whether they widen the draft's. */
  const picking = ref<{ path: string; anchor: number; head: number; extend: boolean } | null>(null)
  const draft = ref<LineDraft | null>(null)

  const draftSpan = computed(() => {
    const d = draft.value
    const lines = d ? options.linesOf(d.path) : null
    return d && lines ? spanOfComment(lines, d) : null
  })

  /** The lines picked, or those of the comment being written. */
  const selection = computed(() => {
    const p = picking.value
    if (p) {
      const lines = options.linesOf(p.path)
      const span = lines ? spanOf(lines, p.anchor, p.head) : null
      return span ? { path: p.path, ...span } : null
    }
    return draft.value && draftSpan.value ? { path: draft.value.path, ...draftSpan.value } : null
  })

  /** The comments of the folder by file, with the lines they are on now; those whose lines are gone have none. */
  const spans = computed(() => {
    const byPath = new Map<string, { first: number; last: number; comment: ReviewComment }[]>()
    for (const comment of review.of(options.root())) {
      const lines = options.linesOf(comment.path)
      const span = lines ? spanOfComment(lines, comment) : null
      if (span) byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), { ...span, comment }])
    }
    return byPath
  })

  function marksOf(path: string, index: number): LineMarks {
    const sel = selection.value
    const selected = !!sel && sel.path === path && index >= sel.first && index <= sel.last
    const list = spans.value.get(path)
    if (!list && !selected) return NO_MARKS
    let commented = false
    let comment: ReviewComment | null = null
    const texts: string[] = []
    for (const span of list ?? []) {
      if (index < span.first || index > span.last) continue
      commented = true
      if (span.first !== index) continue
      comment ??= span.comment
      texts.push(span.comment.text)
    }
    return { selected, commented, comment, tooltip: texts.length ? texts.join('\n\n') : null }
  }

  let stop: (() => void) | null = null
  onScopeDispose(() => stop?.())

  /** A press on a line's number: picks it, with Umschalt the lines up to it for the comment being written. */
  function pick(path: string, index: number, event: PointerEvent): void {
    stop?.()
    const current = event.shiftKey && draft.value?.path === path ? draftSpan.value : null
    const anchor = current ? (index < current.first ? current.last : current.first) : index
    picking.value = { path, anchor, head: index, extend: !!current }
    const move = (e: PointerEvent) => {
      const at = options.placeAt(e)
      if (picking.value && at?.path === picking.value.path) picking.value = { ...picking.value, head: at.index }
    }
    const up = () => {
      stop?.()
      finish()
    }
    const cancelled = () => {
      stop?.()
      picking.value = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelled)
    stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelled)
      stop = null
    }
  }

  /** The lines picked get the comment: widened, the one being written; else a new one, with what was written so far. */
  function finish(): void {
    const p = picking.value
    picking.value = null
    const lines = p ? options.linesOf(p.path) : null
    const span = p && lines ? spanOf(lines, p.anchor, p.head) : null
    if (!p || !lines || !span) return
    const from = pointOf(lines[span.first])!
    const to = pointOf(lines[span.last])!
    const d = draft.value
    draft.value = p.extend && d ? { ...d, from, to } : { path: p.path, from, to, text: d && !d.id ? d.text : '', id: null }
  }

  function edit(comment: ReviewComment): void {
    stop?.()
    picking.value = null
    draft.value = { path: comment.path, from: comment.from, to: comment.to, text: comment.text, id: comment.id }
  }

  /** Where the comment being written points: its lines now; changed lines of one written before keep where it pointed. */
  const draftRef = computed(() => {
    const d = draft.value
    const span = draftSpan.value
    const lines = d && span ? options.linesOf(d.path) : null
    if (d && span && lines) return lineRefOf(lines, span.first, span.last)
    return d?.id ? (review.get(d.id)?.ref ?? null) : null
  })

  /** What the comment being written is on, e.g. „Zeilen 12–18“. */
  const draftLabel = computed(() => (draftRef.value ? refLabel(draftRef.value) : 'Die Zeilen gibt es so nicht mehr'))
  const canSave = computed(() => !!draftRef.value && !!draft.value?.text.trim())

  function save(): void {
    const d = draft.value
    const ref = draftRef.value
    const text = d?.text.trim()
    if (!d || !ref || !text) return
    if (d.id && review.get(d.id)) review.update(d.id, { from: d.from, to: d.to, ref, text })
    else review.add({ root: options.root(), path: d.path, from: d.from, to: d.to, ref, text })
    draft.value = null
  }

  function cancel(): void {
    stop?.()
    picking.value = null
    draft.value = null
  }

  function remove(): void {
    if (draft.value?.id) review.remove(draft.value.id)
    draft.value = null
  }

  watch(options.root, cancel)

  return { draft, picking, selection, marksOf, pick, edit, save, cancel, remove, draftLabel, canSave }
}
