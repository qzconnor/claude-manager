<script setup lang="ts">
import { useElementBounding } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ChangesView from '@/components/files/ChangesView.vue'
import DiffView from '@/components/files/DiffView.vue'
import FileTreePanel from '@/components/files/FileTreePanel.vue'
import TerminalWorkspace from '@/components/terminal/TerminalWorkspace.vue'
import { separatorValue } from '@/lib/separator-keys'
import { cn } from '@/lib/utils'
import { useBrowsersStore } from '@/stores/browsers'
import { DEFAULT_DIFF_SHARE, MAX_DIFF_SHARE, MAX_TREE_SHARE, MIN_DIFF_SHARE, useFileTreeStore } from '@/stores/file-tree'
import { useSettingsStore } from '@/stores/settings'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NavRail from './NavRail.vue'
import TitleBar from './TitleBar.vue'

/**
 * The window with the tabs in one tab bar (title bar or sidebar), the pages beside the nav rail. The
 * file tree of the session with the keyboard takes the left or right edge of the terminals, and the
 * changes of a file clicked in it split the tab: they sit between the tree and the terminals.
 */
const route = useRoute()
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const fileTree = useFileTreeStore()
const settings = useSettingsStore()
const ui = useUiStore()
const onTerminals = computed(() => route.name === 'terminals')
/** On another page the terminals stay drawn, unseen, while Claude drives a browser (see TerminalWorkspace). */
const drawnUnseen = computed(() => !onTerminals.value && browsers.anyActive)

const main = ref<HTMLElement | null>(null)
const { left: mainLeft, width: mainWidth } = useElementBounding(main)

const treeSide = computed(() => settings.settings.appearance.fileTreeSide)
/** The tree of the session the window works in (for a browser, the session beside it). */
const target = computed(() => fileTree.targetOf(terminals.workingTerminal))
/** Its tree, if it is open. */
const tree = computed(() => {
  if (!target.value || !fileTree.isOpen(target.value.id)) return null
  const max = Math.floor(mainWidth.value * MAX_TREE_SHARE)
  return max > 0 ? { target: target.value, width: Math.min(fileTree.width, max), max } : null
})
/** The file whose changes the tab shows beside its terminals, and how wide they are (px). */
const split = computed(() => {
  const file = fileTree.splitDiffOf(target.value?.id)
  if (!target.value || !file) return null
  const rest = Math.max(0, mainWidth.value - (tree.value?.width ?? 0))
  return { target: target.value, file, width: Math.round(rest * fileTree.diffShare) }
})
/** The file of the tree whose changes are shown, selected in the tree. */
const current = computed(() => (split.value?.file.path && split.value.file.root === tree.value?.target.root ? split.value.file.path : null))

/** The terminals keep their size on other pages too, so they don't fit themselves anew for nothing. */
const workspaceStyle = computed(() => {
  const beside = (tree.value?.width ?? 0) + (split.value?.width ?? 0)
  // An explicit width: the workspace is `size-full`, which would keep it as wide as the page.
  return beside ? { [treeSide.value]: `${beside}px`, width: `calc(100% - ${beside}px)` } : undefined
})
/** The changes lie between the tree and the terminals. */
const diffStyle = computed(() => ({ [treeSide.value]: `${tree.value?.width ?? 0}px`, width: `${split.value?.width ?? 0}px` }))

// The line between the changes and the terminals is dragged to share the tab between them.
const resizingSplit = ref(false)
let endSplitResize: (() => void) | null = null
function onSplitResizeStart(event: PointerEvent) {
  if (event.button !== 0 || !main.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const bounds = main.value.getBoundingClientRect()
  const treeWidth = tree.value?.width ?? 0
  const rest = Math.max(1, bounds.width - treeWidth)
  resizingSplit.value = true
  document.documentElement.dataset.resizing = 'col'
  const move = (e: PointerEvent) => {
    const width = treeSide.value === 'left' ? e.clientX - bounds.left - treeWidth : bounds.right - treeWidth - e.clientX
    fileTree.setDiffShare(width / rest)
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    resizingSplit.value = false
    delete document.documentElement.dataset.resizing
    endSplitResize = null
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
  endSplitResize = end
}
onBeforeUnmount(() => endSplitResize?.())

/** The edge of the changes moved with the keyboard, 2 % a step; with the tree on the right they grow to the left. */
function onSplitResizeKey(event: KeyboardEvent) {
  const percent = separatorValue(event, true, {
    value: fileTree.diffShare * 100,
    min: MIN_DIFF_SHARE * 100,
    max: MAX_DIFF_SHARE * 100,
    step: 2,
    initial: DEFAULT_DIFF_SHARE * 100,
    reversed: treeSide.value === 'right',
  })
  if (percent === null) return
  event.preventDefault()
  fileTree.setDiffShare(percent / 100)
}

/**
 * The part of the page's top border below the selected tab in the title bar (px from the page's
 * left edge). It is left out, and the tab's own side borders carry on into the rest of the line.
 */
const borderGap = computed(() => {
  const edges = ui.selectedTabEdges
  return edges ? { start: edges.left - mainLeft.value + 1, end: edges.right - mainLeft.value - 1 } : null
})
/** A tab over the rounded corner squares it off, so the tab's left border runs straight down the page. */
const squareCorner = computed(() => borderGap.value !== null && borderGap.value.start < 24)
const frameMask = computed(() => {
  if (!borderGap.value) return undefined
  const { start, end } = borderGap.value
  // Layer 1 keeps everything below the top line, layer 2 the top line except for the gap.
  return {
    maskImage: `linear-gradient(#000, #000), linear-gradient(to right, #000 ${start}px, transparent ${start}px, transparent ${end}px, #000 ${end}px)`,
    maskPosition: '0 1px, 0 0',
    maskSize: '100% calc(100% - 1px), 100% 1px',
    maskRepeat: 'no-repeat',
  }
})

// The main process learns which terminals are on screen, those of the selected tab: their news
// counts as seen (notifications, unread dot).
watch(
  () => (onTerminals.value ? (terminals.activeTab?.panes.map((p) => p.id).join(',') ?? '') : ''),
  (ids) => window.api.terminals.viewing(ids ? ids.split(',') : []),
  { immediate: true },
)
</script>

<template>
  <div class="flex h-full flex-col">
    <TitleBar />
    <div class="flex min-h-0 flex-1">
      <NavRail />
      <!-- isolate keeps the pages' own z-indices below the frame. -->
      <main
        ref="main"
        :class="
          cn(
            'relative isolate min-w-0 flex-1 overflow-hidden bg-surface',
            squareCorner ? 'rounded-tl-none' : 'rounded-tl-xl',
          )
        "
      >
        <!-- Terminals stay mounted while other pages are shown so their state survives. -->
        <TerminalWorkspace
          v-show="onTerminals || drawnUnseen"
          :class="cn('absolute inset-0', drawnUnseen && 'pointer-events-none -z-10 opacity-0')"
          :style="workspaceStyle"
          :aria-hidden="drawnUnseen || undefined"
          :visible="onTerminals"
        />
        <!-- Keyed by the tab, which comes back to its own place in the tree. -->
        <FileTreePanel
          v-if="tree"
          v-show="onTerminals"
          :key="tree.target.id"
          class="absolute inset-y-0"
          :style="{ [treeSide]: 0, width: `${tree.width}px` }"
          :target="tree.target"
          :side="treeSide"
          :max-width="tree.max"
          :current="current"
        />
        <!-- The changes of a file of the tree, a split of the tab; keyed by the tab like the tree. -->
        <div
          v-if="split"
          v-show="onTerminals"
          :key="`diff-${split.target.id}`"
          :class="cn('absolute inset-y-0 flex', treeSide === 'left' ? 'border-r' : 'border-l')"
          :style="diffStyle"
        >
          <ChangesView
            v-if="split.file.path === ''"
            class="min-w-0 flex-1"
            :root="split.file.root"
            closable
            @close="fileTree.closeSplitDiff(split.target.id)"
          />
          <DiffView
            v-else
            class="min-w-0 flex-1"
            :root="split.file.root"
            :path="split.file.path"
            closable
            @close="fileTree.closeSplitDiff(split.target.id)"
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Breite der Änderungen ändern"
            tabindex="0"
            :aria-valuenow="Math.round(fileTree.diffShare * 100)"
            :aria-valuemin="MIN_DIFF_SHARE * 100"
            :aria-valuemax="MAX_DIFF_SHARE * 100"
            :class="cn('group/handle absolute inset-y-0 z-20 w-[9px] cursor-col-resize outline-none', treeSide === 'left' ? '-right-[5px]' : '-left-[5px]')"
            @pointerdown="onSplitResizeStart"
            @dblclick="fileTree.setDiffShare(DEFAULT_DIFF_SHARE)"
            @keydown="onSplitResizeKey"
          >
            <div
              :class="
                cn(
                  'absolute inset-y-0 left-[4px] w-px transition-colors group-hover/handle:bg-primary/60 group-focus-visible/handle:bg-primary',
                  resizingSplit && 'bg-primary/60',
                )
              "
            />
          </div>
        </div>
        <!-- No v-if on the child: the compiler would give every route the same key and
             KeepAlive would mix up the cached pages. The terminals route renders an empty view. -->
        <RouterView v-slot="{ Component }">
          <KeepAlive>
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
        <!-- The page's border, drawn on top so it can leave a gap below the selected tab. -->
        <div
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 z-100 rounded-[inherit] border-t border-l"
          :style="frameMask"
        />
      </main>
    </div>
  </div>
</template>
