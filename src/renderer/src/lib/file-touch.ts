import { EyeIcon, GitCommitHorizontalIcon, PencilIcon, SearchIcon } from '@lucide/vue'
import type { Component } from 'vue'
import type { FileTouchKind } from '@shared/types'

/** What Claude does with a file, as the tree shows it: its symbol, in the colour of the kind. */
export const TOUCH_ICON: Record<FileTouchKind, Component> = {
  read: EyeIcon,
  search: SearchIcon,
  write: PencilIcon,
  commit: GitCommitHorizontalIcon,
}

/** The kind as done: "Claude hat die Datei gelesen". */
export const TOUCH_DONE: Record<FileTouchKind, string> = {
  read: 'gelesen',
  search: 'durchsucht',
  write: 'geschrieben',
  commit: 'committet',
}
