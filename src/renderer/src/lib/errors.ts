import { toast } from 'vue-sonner'

/** Electron prefixes errors thrown in ipcMain handlers — strip that for display. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function toastError(error: unknown, title = 'Fehler'): void {
  toast.error(title, { description: errorMessage(error) })
}

/** Runs an async action and shows a toast if it fails. Returns `undefined` on failure. */
export async function attempt<T>(action: () => Promise<T>, title?: string): Promise<T | undefined> {
  try {
    return await action()
  } catch (error) {
    toastError(error, title)
    return undefined
  }
}
