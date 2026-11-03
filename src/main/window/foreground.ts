import type { BrowserWindow } from 'electron'
import { hwndOf } from './material'

/**
 * Windows only lets the app in front hand over the foreground: a window in the background that asks
 * for it gets its taskbar button flashed instead, e.g. after closing it through the taskbar, which is
 * in front then. For a question the user has to see, the window goes on top of the others and joins
 * the input of the app in front for a moment, which lets it take the focus.
 */
interface User32 {
  GetForegroundWindow: () => number
  GetWindowThreadProcessId: (hWnd: number, processId: number) => number
  GetCurrentThreadId: () => number
  AttachThreadInput: (idAttach: number, idAttachTo: number, attach: number) => number
  BringWindowToTop: (hWnd: number) => number
  SetForegroundWindow: (hWnd: number) => number
}

let user32: User32 | null | undefined

async function loadUser32(): Promise<User32 | null> {
  if (user32 !== undefined) return user32
  try {
    const { load } = await import('koffi')
    const user = load('user32.dll')
    const kernel = load('kernel32.dll')
    user32 = {
      GetForegroundWindow: user.func('intptr __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: user.func('uint32 __stdcall GetWindowThreadProcessId(intptr hWnd, intptr lpdwProcessId)'),
      GetCurrentThreadId: kernel.func('uint32 __stdcall GetCurrentThreadId()'),
      AttachThreadInput: user.func('int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)'),
      BringWindowToTop: user.func('int __stdcall BringWindowToTop(intptr hWnd)'),
      SetForegroundWindow: user.func('int __stdcall SetForegroundWindow(intptr hWnd)'),
    } as User32
  } catch (error) {
    console.warn('[window] koffi unavailable — the window may stay behind other apps', error)
    user32 = null
  }
  return user32
}

/** Puts the (visible) window in front of all others and gives it the focus, also from the background. */
export async function forceForeground(win: BrowserWindow): Promise<void> {
  if (process.platform !== 'win32' || win.isDestroyed() || win.isFocused()) return
  // Topmost for a moment: on top of the other windows, even if Windows refuses the focus below.
  win.setAlwaysOnTop(true)
  win.setAlwaysOnTop(false)
  const api = await loadUser32()
  if (!api || win.isDestroyed() || win.isFocused()) return
  try {
    const hwnd = hwndOf(win)
    const foreground = api.GetForegroundWindow()
    const own = api.GetCurrentThreadId()
    const other = foreground ? api.GetWindowThreadProcessId(foreground, 0) : 0
    const attached = other !== 0 && other !== own && api.AttachThreadInput(own, other, 1) !== 0
    try {
      api.BringWindowToTop(hwnd)
      api.SetForegroundWindow(hwnd)
    } finally {
      if (attached) api.AttachThreadInput(own, other, 0)
    }
  } catch (error) {
    console.warn('[window] could not come to the front', error)
  }
}
