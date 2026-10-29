import type { BrowserWindow } from 'electron'
import type { WindowMaterial } from '@shared/types'

/**
 * Windows 11 system backdrops (acrylic / mica) turn into a flat color as soon as the window
 * loses focus, because DWM follows the window's activation state. Re-sending WM_NCACTIVATE
 * with wParam=TRUE right after the window was deactivated makes DWM keep painting the
 * backdrop as "active" — without actually activating the window or stealing focus.
 */
const WM_NCACTIVATE = 0x0086

type SendMessage = (hwnd: number, msg: number, wParam: number, lParam: number) => number

let sendMessage: SendMessage | null | undefined

async function loadSendMessage(): Promise<SendMessage | null> {
  if (sendMessage !== undefined) return sendMessage
  if (process.platform !== 'win32') return (sendMessage = null)
  try {
    const { load } = await import('koffi')
    const user32 = load('user32.dll')
    sendMessage = user32.func(
      'intptr __stdcall SendMessageW(intptr hWnd, uint Msg, uintptr wParam, intptr lParam)',
    ) as SendMessage
  } catch (error) {
    console.warn('[material] koffi unavailable — backdrop will fade when unfocused', error)
    sendMessage = null
  }
  return sendMessage
}

function hwndOf(win: BrowserWindow): number {
  const handle = win.getNativeWindowHandle()
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}

export class WindowMaterialController {
  private keepActive = false
  private material: WindowMaterial = 'none'
  private hooked = false

  constructor(private readonly win: BrowserWindow) {}

  async apply(material: WindowMaterial, keepActiveWhenInactive: boolean): Promise<void> {
    if (process.platform !== 'win32') return
    this.material = material
    this.keepActive = keepActiveWhenInactive && material !== 'none'
    this.win.setBackgroundMaterial(material)
    if (this.keepActive) {
      await loadSendMessage()
      this.hook()
      if (!this.win.isFocused()) this.forceActiveLook()
    } else if (!this.win.isFocused()) {
      // Drop a previously forced active look.
      this.sendNcActivate(false)
    }
  }

  private hook(): void {
    if (this.hooked) return
    this.hooked = true
    this.win.hookWindowMessage(WM_NCACTIVATE, (wParam: Buffer) => {
      if (!this.keepActive || this.material === 'none') return
      const active = wParam.length >= 4 && wParam.readUInt32LE(0) !== 0
      // Let Windows finish processing the deactivation first, then repaint as active.
      if (!active) setTimeout(() => this.forceActiveLook(), 0)
    })
    this.win.on('blur', () => {
      if (this.keepActive) setTimeout(() => this.forceActiveLook(), 0)
    })
  }

  private forceActiveLook(): void {
    if (this.win.isDestroyed() || this.win.isFocused() || this.win.isMinimized()) return
    this.sendNcActivate(true)
  }

  private sendNcActivate(active: boolean): void {
    if (!sendMessage || this.win.isDestroyed()) return
    try {
      // lParam -1: don't repaint the non-client area (we draw our own title bar).
      sendMessage(hwndOf(this.win), WM_NCACTIVATE, active ? 1 : 0, -1)
    } catch (error) {
      console.warn('[material] SendMessageW failed', error)
    }
  }
}
