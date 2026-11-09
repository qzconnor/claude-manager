import type { IBuffer, IBufferCell, IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

const IMAGE_REF = '[Image #'
const IMAGE_REF_RE = /\[Image #(\d+)\]/g

/** An `[Image #N]` in a row of the terminal and the columns it takes (from 0, `end` included). */
export interface ImageRef {
  id: number
  start: number
  end: number
}

/** The `[Image #N]` with which Claude Code shows pasted images, in one row of the terminal. */
export function imageRefs(line: IBufferLine): ImageRef[] {
  if (!line.translateToString(true).includes(IMAGE_REF)) return []
  // The column of each character: wide characters before it (e.g. emoji) take two columns.
  let text = ''
  const columns: number[] = []
  let cell: IBufferCell | undefined
  for (let x = 0; x < line.length; x++) {
    cell = line.getCell(x, cell)
    if (!cell) break
    // The second half of a wide character.
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) columns.push(x)
    text += chars
  }
  const refs: ImageRef[] = []
  for (const match of text.matchAll(IMAGE_REF_RE)) {
    const id = Number(match[1])
    if (!Number.isSafeInteger(id) || id < 1) continue
    refs.push({ id, start: columns[match.index]!, end: columns[match.index + match[0].length - 1]! })
  }
  return refs
}

/** How often each `[Image #N]` shows in the rows from `start` to before `end`. */
export function countImageRefs(buffer: IBuffer, start: number, end: number): Map<number, number> {
  const counts = new Map<number, number>()
  for (let y = Math.max(0, start); y < Math.min(end, buffer.length); y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    for (const { id } of imageRefs(line)) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/**
 * The image that came: an `[Image #N]` that shows once more than before. Claude Code counts the
 * numbers up, so of several the highest is the new one. Null while none came.
 */
export function addedImageRef(before: ReadonlyMap<number, number>, after: ReadonlyMap<number, number>): number | null {
  let added: number | null = null
  for (const [id, count] of after) {
    if (count > (before.get(id) ?? 0) && (added === null || id > added)) added = id
  }
  return added
}

export interface PastedImageLinkOptions {
  /**
   * The numbers of the images there is something to show for; right away when they are known, so a
   * row drawn anew gets its link back in the same frame.
   */
  ids(): ReadonlySet<number> | Promise<ReadonlySet<number>>
  hover(id: number, event: MouseEvent): void
  leave(id: number): void
  open(id: number): void
}

/** Turns the `[Image #N]` of images there is something to show for into links: hovering shows the image, a click opens it. */
export function pastedImageLinks(term: Terminal, options: PastedImageLinkOptions): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      const refs = line ? imageRefs(line) : []
      if (refs.length === 0) {
        callback(undefined)
        return
      }
      const answer = (ids: ReadonlySet<number>) => {
        const links = refs
          .filter((ref) => ids.has(ref.id))
          .map(
            (ref): ILink => ({
              range: { start: { x: ref.start + 1, y }, end: { x: ref.end + 1, y } },
              text: `[Image #${ref.id}]`,
              decorations: { pointerCursor: true, underline: true },
              activate: () => options.open(ref.id),
              hover: (event) => options.hover(ref.id, event),
              leave: () => options.leave(ref.id),
            }),
          )
        callback(links.length ? links : undefined)
      }
      const ids = options.ids()
      if (ids instanceof Promise) ids.then(answer, () => callback(undefined))
      else answer(ids)
    },
  }
}
