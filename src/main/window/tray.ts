import { join } from 'node:path'
import { app, Menu, Tray } from 'electron'

export interface TrayActions {
  open: () => void
  quit: () => void
}

/** The icon in the notification area while the app may run without its window (setting `runInTray`). */
export class AppTray {
  private tray: Tray | null = null

  constructor(private readonly actions: TrayActions) {}

  get visible(): boolean {
    return this.tray !== null
  }

  set(visible: boolean): void {
    if (visible === this.visible) return
    if (!visible) {
      this.tray?.destroy()
      this.tray = null
      return
    }
    const tray = new Tray(iconPath())
    tray.setToolTip('Claude Manager')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Claude Manager öffnen', click: () => this.actions.open() },
        { type: 'separator' },
        { label: 'Beenden', click: () => this.actions.quit() },
      ]),
    )
    tray.on('click', () => this.actions.open())
    this.tray = tray
  }

  dispose(): void {
    this.set(false)
  }
}

/** build/icon.ico (all sizes, Windows picks the one for the display scaling); the installer puts it in resources. */
function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico')
}
