import { GaugeIcon, HistoryIcon, SettingsIcon, ShapesIcon, UsersIcon } from '@lucide/vue'
import type { Component } from 'vue'
import type { PageName } from './workspace'

/** The app's pages, which open as tabs: their label and symbol. */
export const PAGE_INFO: Record<PageName, { label: string; icon: Component; shortcut?: string }> = {
  sessions: { label: 'Sessions', icon: HistoryIcon },
  artifacts: { label: 'Artefakte', icon: ShapesIcon },
  dashboard: { label: 'Usage', icon: GaugeIcon },
  accounts: { label: 'Accounts', icon: UsersIcon },
  settings: { label: 'Einstellungen', icon: SettingsIcon, shortcut: 'Strg+,' },
}
