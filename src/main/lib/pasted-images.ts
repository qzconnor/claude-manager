import { open } from 'node:fs/promises'
import { isPlainObject } from '@shared/utils'

/**
 * Images the user pasted into a session, `[Image #N]` in the prompt. Claude Code writes them to the
 * transcript once the prompt is sent: in the prompt's entry, numbered by `imagePasteIds`, or for a
 * prompt sent while Claude worked, in a `queued_command` attachment whose text names the numbers.
 * The numbers count per process, also across `/clear`; a resumed session starts at 1 again.
 */

/** A transcript line with pasted images: where it starts, and when it was sent (ms, 0 when unknown). */
export interface PastedImageAt {
  position: number
  time: number
}

/** What a transcript told about its pasted images so far; it is read on from `offset`. */
export interface PastedImageScan {
  /** Bytes read so far, up to the end of the last complete line. */
  offset: number
  /** By number, the lines with that image, in the order of the transcript. */
  images: Map<number, PastedImageAt[]>
}

export interface PastedImage {
  id: number
  mediaType: string
  /** base64 */
  data: string
}

export function newPastedImageScan(): PastedImageScan {
  return { offset: 0, images: new Map() }
}

/** The transcript is read in pieces of this size. */
const CHUNK_BYTES = 4 * 1024 * 1024
/** A longer line holds no pasted image Claude Code would accept; it is skipped. */
const MAX_LINE_BYTES = 64 * 1024 * 1024
const NEWLINE = 0x0a
/** Only lines with all of these are parsed. */
const IMAGE_MARK = Buffer.from('"type":"image"')
/** Lines with the user's own images have one of these: other images come from tools. */
const PROMPT_MARKS = [Buffer.from('"imagePasteIds"'), Buffer.from('"queued_command"')]
/** Image types Claude Code sends; anything else isn't shown. */
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_REF_RE = /\[Image #(\d+)\]/g

/** The images the user pasted into a prompt, by their number; null for any other entry. */
export function pastedImagesIn(entry: unknown): { time: number; images: PastedImage[] } | null {
  if (!isPlainObject(entry) || entry.isSidechain === true) return null
  let blocks: unknown[] | null = null
  let ids: unknown = null
  if (entry.type === 'user' && isPlainObject(entry.message) && Array.isArray(entry.message.content)) {
    blocks = entry.message.content
    ids = entry.imagePasteIds
  } else if (entry.type === 'attachment' && isPlainObject(entry.attachment) && entry.attachment.type === 'queued_command') {
    if (Array.isArray(entry.attachment.prompt)) blocks = entry.attachment.prompt
  }
  if (!blocks) return null
  const images = blocks.flatMap((block) => {
    if (!isPlainObject(block) || block.type !== 'image' || !isPlainObject(block.source)) return []
    const { type, media_type: mediaType, data } = block.source
    return type === 'base64' && typeof mediaType === 'string' && MEDIA_TYPES.has(mediaType) && typeof data === 'string' && data
      ? [{ mediaType, data }]
      : []
  })
  if (images.length === 0) return null
  // The images follow the numbers in ascending order, as Claude Code keeps the pasted contents.
  const numbers =
    Array.isArray(ids) && ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0)
      ? (ids as number[])
      : referencedNumbers(blocks)
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return {
    time: Number.isFinite(time) ? time : 0,
    images: images.slice(0, numbers.length).map((image, i) => ({ id: numbers[i]!, ...image })),
  }
}

/** The numbers the text of a prompt names (`[Image #N]`), each once, in ascending order. */
function referencedNumbers(blocks: unknown[]): number[] {
  const numbers = new Set<number>()
  for (const block of blocks) {
    if (!isPlainObject(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(IMAGE_REF_RE)) {
      const id = Number(match[1])
      if (Number.isSafeInteger(id) && id > 0) numbers.add(id)
    }
  }
  return [...numbers].sort((a, b) => a - b)
}

/** Reads what was added to the transcript since the last scan; a shorter file is read from the start. */
export async function scanPastedImages(file: string, scan: PastedImageScan): Promise<void> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size < scan.offset) Object.assign(scan, newPastedImageScan())
    if (size === scan.offset) return
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - scan.offset))
    /** Where the line being read starts, and what of it came in earlier pieces. */
    let lineStart = scan.offset
    let parts: Buffer[] = []
    let partsBytes = 0
    let tooLong = false
    let position = scan.offset
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (bytesRead === 0) break
      const data = buffer.subarray(0, bytesRead)
      let from = 0
      for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, from)) {
        if (!tooLong) {
          const piece = data.subarray(from, end)
          noteLine(scan, partsBytes ? Buffer.concat([...parts, piece]) : piece, lineStart)
        }
        parts = []
        partsBytes = 0
        tooLong = false
        from = end + 1
        lineStart = position + from
        scan.offset = lineStart
      }
      // The rest of the piece begins a line that goes on in the next one (or isn't written yet).
      if (!tooLong && from < bytesRead) {
        partsBytes += bytesRead - from
        if (partsBytes > MAX_LINE_BYTES) {
          tooLong = true
          parts = []
        } else parts.push(Buffer.from(data.subarray(from)))
      }
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}

function noteLine(scan: PastedImageScan, line: Buffer, position: number): void {
  if (line.indexOf(IMAGE_MARK) === -1 || !PROMPT_MARKS.some((mark) => line.indexOf(mark) !== -1)) return
  let entry: unknown
  try {
    entry = JSON.parse(line.toString('utf8'))
  } catch {
    return
  }
  const pasted = pastedImagesIn(entry)
  if (!pasted) return
  for (const { id } of pasted.images) {
    const lines = scan.images.get(id) ?? []
    // Two scans at once read the same lines.
    if ((lines.at(-1)?.position ?? -1) >= position) continue
    lines.push({ position, time: pasted.time })
    scan.images.set(id, lines)
  }
}

/**
 * The line that holds image `id` among the transcripts of one process, the current session's first:
 * the latest one sent since the process started (`since`, ms), otherwise the latest one before, from
 * the history of a resumed session.
 */
export function choosePastedImage<T extends { scan: PastedImageScan }>(
  transcripts: T[],
  id: number,
  since: number,
): { transcript: T; at: PastedImageAt } | null {
  let earlier: { transcript: T; at: PastedImageAt } | null = null
  for (const transcript of transcripts) {
    const lines = transcript.scan.images.get(id) ?? []
    for (let i = lines.length - 1; i >= 0; i--) {
      const at = lines[i]!
      if (at.time >= since) return { transcript, at }
      earlier ??= { transcript, at }
    }
  }
  return earlier
}

/** Image `id` of the transcript line at `at`, as a data URL; null when the line no longer holds it. */
export async function readPastedImage(file: string, at: PastedImageAt, id: number): Promise<string | null> {
  const line = await readLine(file, at.position)
  if (!line) return null
  let entry: unknown
  try {
    entry = JSON.parse(line.toString('utf8'))
  } catch {
    return null
  }
  const image = pastedImagesIn(entry)?.images.find((candidate) => candidate.id === id)
  return image ? `data:${image.mediaType};base64,${image.data}` : null
}

/** The complete line that starts at `position`; null when it ends nowhere (it is still being written). */
async function readLine(file: string, position: number): Promise<Buffer | null> {
  const handle = await open(file, 'r')
  try {
    const parts: Buffer[] = []
    let bytes = 0
    const buffer = Buffer.alloc(CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position + bytes)
      if (bytesRead === 0) return null
      const data = buffer.subarray(0, bytesRead)
      const end = data.indexOf(NEWLINE)
      if (end !== -1) return Buffer.concat([...parts, data.subarray(0, end)])
      parts.push(Buffer.from(data))
      bytes += bytesRead
      if (bytes > MAX_LINE_BYTES) return null
    }
  } finally {
    await handle.close()
  }
}
