<script setup lang="ts">
import { ExternalLinkIcon, GlobeIcon, LoaderCircleIcon, PanelBottomIcon, PanelRightIcon, PlusIcon, RotateCwIcon, XIcon } from '@lucide/vue'
import { computed, onBeforeUnmount } from 'vue'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { useLauncher } from '@/composables/useLauncher'
import { attempt } from '@/lib/errors'
import { openMenuBelow, tabKeyAction } from '@/lib/tab-keys'
import { cn } from '@/lib/utils'
import { BROWSER_TAB } from '@/lib/workspace'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import BrowserFavicon from './BrowserFavicon.vue'

/**
 * The browser tab in the tab bar of its group: the sessions' browser, named after the page it shows
 * (of the session being worked in). Closing it keeps the pages; they come back with it.
 */
const props = defineProps<{ groupId: string; selected: boolean; focused: boolean; joined: Record<string, string> }>()
const emit = defineEmits<{ select: [id: string] }>()

const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const launcher = useLauncher()
const ui = useUiStore()

const session = computed(() => terminals.browserSession)
const page = computed(() => terminals.browserPage)
const loading = computed(() => (page.value ? browsers.get(page.value.id)?.state.loading === true : false))
const alone = computed(() => (terminals.groups.find((g) => g.id === props.groupId)?.tabs.length ?? 0) < 2)
const external = computed(() => !!page.value?.url && /^https?:/i.test(page.value.url))
/** The page with its address, and whose browser it is. */
const tooltip = computed(() =>
  [page.value?.title, external.value ? page.value?.url : null, session.value ? `Browser von „${session.value.title}“` : 'Browser']
    .filter(Boolean)
    .join('\n'),
)
/** The mouse is over the session the tab shows: it looks hovered too. */
const linkedHover = computed(() => !!ui.hoveredTab && ui.hoveredTab !== BROWSER_TAB && terminals.linked(ui.hoveredTab).includes(BROWSER_TAB))

function onPointerLeave() {
  if (ui.hoveredTab === BROWSER_TAB) ui.hoveredTab = null
}
onBeforeUnmount(onPointerLeave)

/** The keys of the tab with the keyboard (see `tabKeyAction`). */
function onTabKey(event: KeyboardEvent) {
  const action = tabKeyAction(event)
  if (action !== 'select' && action !== 'close' && action !== 'menu') return
  event.preventDefault()
  if (action === 'menu') openMenuBelow(event.currentTarget as HTMLElement)
  else if (action === 'select') emit('select', BROWSER_TAB)
  else terminals.closeBrowserTab()
}

function onMouseDown(event: MouseEvent) {
  if (event.button !== 1) return
  event.preventDefault()
  terminals.closeBrowserTab()
}

function openExternal() {
  const url = page.value?.url
  if (url && external.value) void attempt(() => window.api.app.openExternal(url), 'Seite konnte nicht geöffnet werden')
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        role="tab"
        :tabindex="selected ? 0 : -1"
        :data-terminal-id="BROWSER_TAB"
        :data-linked-hover="linkedHover || undefined"
        :aria-selected="selected"
        v-tooltip="tooltip"
        :class="
          cn(
            'app-no-drag group/tab relative flex h-full max-w-72 min-w-28 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border pr-1 pl-3 text-xs transition-colors data-docking:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
            selected
              ? cn('border-border border-b-transparent', focused ? 'text-foreground' : 'text-muted-foreground')
              : 'border-transparent border-b-border text-muted-foreground hover:bg-accent/60 hover:text-foreground data-dragging:bg-surface-strong data-dragging:text-foreground data-dragging:shadow-md data-linked-hover:bg-accent/60 data-linked-hover:text-foreground',
          )
        "
        :style="selected ? joined : undefined"
        @click="emit('select', BROWSER_TAB)"
        @mousedown="onMouseDown"
        @keydown="onTabKey"
        @pointerenter="ui.hoveredTab = BROWSER_TAB"
        @pointerleave="onPointerLeave"
      >
        <span class="flex size-3.5 shrink-0 items-center justify-center">
          <LoaderCircleIcon v-if="loading" role="status" aria-label="Seite lädt" class="size-3.5 animate-spin" />
          <BrowserFavicon v-else-if="page" :terminal-id="page.id" class="size-3.5" />
          <GlobeIcon v-else class="size-3.5" />
        </span>
        <!-- The title of the page shown: the session is the one being worked in anyway. Too long for the tab, it gives way. -->
        <span class="flex min-w-0 flex-1 items-baseline gap-1">
          <span class="shrink-0">Browser</span>
          <span v-if="page" class="min-w-0 truncate text-muted-foreground">· {{ page.title }}</span>
        </span>
        <button
          type="button"
          aria-label="Browser schließen"
          v-tooltip="'Browser schließen (die Seiten bleiben offen)'"
          :class="
            cn(
              'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/tab:opacity-100 group-data-linked-hover/tab:opacity-100 hover:bg-accent hover:text-foreground',
              selected && 'opacity-100',
            )
          "
          @click.stop="terminals.closeBrowserTab()"
          @dblclick.stop
        >
          <XIcon class="size-3.5" />
        </button>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-72">
      <ContextMenuItem :disabled="!session" @select="session && launcher.newPage(session.id)">
        <PlusIcon />
        Neue Seite
      </ContextMenuItem>
      <ContextMenuItem :disabled="!page" @select="page && browsers.get(page.id)?.reload()">
        <RotateCwIcon />
        Neu laden
      </ContextMenuItem>
      <ContextMenuItem :disabled="!external" @select="openExternal">
        <ExternalLinkIcon />
        Im Standardbrowser öffnen
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(BROWSER_TAB, groupId, 'right')">
        <PanelRightIcon />
        In Gruppe rechts verschieben
      </ContextMenuItem>
      <ContextMenuItem :disabled="alone" @select="terminals.dropTab(BROWSER_TAB, groupId, 'down')">
        <PanelBottomIcon />
        In Gruppe unten verschieben
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="terminals.closeBrowserTab()">
        <XIcon />
        Schließen
        <ContextMenuShortcut v-if="focused">Strg+Umschalt+W</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
