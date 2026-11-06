import { BellIcon, BotIcon, InfoIcon, PaletteIcon, PlugIcon, SparklesIcon, SquareTerminalIcon } from '@lucide/vue'
import type { Component } from 'vue'
import type { SettingsTab } from '@/router'

/** Icon of each tab of the settings, also in the command palette. */
export const SETTINGS_TAB_ICONS: Record<SettingsTab, Component> = {
  appearance: PaletteIcon,
  terminal: SquareTerminalIcon,
  claude: BotIcon,
  notifications: BellIcon,
  api: PlugIcon,
  updates: SparklesIcon,
  about: InfoIcon,
}
