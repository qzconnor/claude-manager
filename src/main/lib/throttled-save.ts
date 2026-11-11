/**
 * Saves a few seconds after a change, but at most once per interval. A cache that changes every few
 * seconds (a session at work writes its transcript all the time) is written once a minute instead of
 * after every change, and a long run of changes is still saved along the way, not only at its end.
 */
export class ThrottledSave {
  private timer: NodeJS.Timeout | null = null
  private lastAt = -Infinity

  constructor(
    private readonly save: () => void,
    /** After the first change, so a burst of changes is saved together. */
    private readonly delayMs: number,
    /** At least this long between two saves. */
    private readonly intervalMs: number,
  ) {}

  schedule(): void {
    if (this.timer) return
    const wait = Math.max(this.delayMs, this.lastAt + this.intervalMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.lastAt = Date.now()
      this.save()
    }, wait)
  }
}
