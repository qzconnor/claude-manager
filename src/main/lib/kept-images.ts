/**
 * Copies of the images the user pastes into sessions (`[Image #N]`), kept from the paste until Claude
 * Code writes them to the transcript with the prompt (see `pasted-images.ts`). They are held as bytes,
 * not as base64, within one budget for all tabs: the oldest go first.
 */

export interface KeptImage {
  mediaType: string
  data: Buffer
}

/** The most images a tab keeps before they are sent. */
export const MAX_KEPT_IMAGES_PER_TAB = 20
/** All kept images of all tabs together (bytes): two of the largest the clipboard gives. */
export const MAX_KEPT_IMAGE_BYTES = 64 * 1024 * 1024

export class KeptImages {
  /** In the order they were kept, oldest first. */
  private readonly images = new Map<string, { tab: string; n: number; image: KeptImage }>()
  private total = 0

  constructor(
    private readonly maxBytes = MAX_KEPT_IMAGE_BYTES,
    private readonly maxPerTab = MAX_KEPT_IMAGES_PER_TAB,
  ) {}

  /** Bytes of all images kept. */
  get bytes(): number {
    return this.total
  }

  /** Keeps image `n` of tab `tab`; pasted and never sent, the oldest of the tab and of all tabs go. */
  keep(tab: string, n: number, image: KeptImage): void {
    this.delete(tab, n)
    if (image.data.length > this.maxBytes) return
    this.images.set(key(tab, n), { tab, n, image })
    this.total += image.data.length
    let ofTab = this.ids(tab).length
    for (const entry of this.images.values()) {
      if (ofTab <= this.maxPerTab) break
      if (entry.tab !== tab) continue
      this.delete(entry.tab, entry.n)
      ofTab--
    }
    for (const entry of this.images.values()) {
      if (this.total <= this.maxBytes) break
      this.delete(entry.tab, entry.n)
    }
  }

  /** Image `n` of tab `tab` as a data URL; null when it isn't kept (any more). */
  get(tab: string, n: number): string | null {
    const image = this.images.get(key(tab, n))?.image
    return image ? `data:${image.mediaType};base64,${image.data.toString('base64')}` : null
  }

  /** The numbers of the images kept for tab `tab`. */
  ids(tab: string): number[] {
    return [...this.images.values()].filter((entry) => entry.tab === tab).map((entry) => entry.n)
  }

  delete(tab: string, n: number): void {
    const k = key(tab, n)
    const entry = this.images.get(k)
    if (!entry) return
    this.images.delete(k)
    this.total -= entry.image.data.length
  }

  /** The tab is closed: its images go. */
  forget(tab: string): void {
    for (const entry of [...this.images.values()]) if (entry.tab === tab) this.delete(entry.tab, entry.n)
  }
}

const key = (tab: string, n: number) => `${tab}\n${n}`
