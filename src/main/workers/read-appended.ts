import { open } from 'node:fs/promises'

const NEWLINE = 0x0a

/**
 * The bytes after `offset` (the end of a line read before), or null when the file has to be read
 * again from the start: nothing was read yet, or it no longer continues the part read before.
 */
export async function readAppended(path: string, offset: number, size: number): Promise<Buffer | null> {
  if (offset === 0) return null
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(size - offset + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - 1)
    return bytesRead > 0 && buffer[0] === NEWLINE ? buffer.subarray(1, bytesRead) : null
  } finally {
    await handle.close()
  }
}
