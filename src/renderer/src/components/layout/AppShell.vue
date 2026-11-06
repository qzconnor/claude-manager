<script setup lang="ts">
import { useElementBounding } from '@vueuse/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TerminalWorkspace from '@/components/terminal/TerminalWorkspace.vue'
import { useAccountSwitch } from '@/composables/useAccountSwitch'
import { useTerminalAppearance } from '@/composables/useTerminalAppearance'
import { cn } from '@/lib/utils'
import { useBrowsersStore } from '@/stores/browsers'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import NavRail from './NavRail.vue'
import TitleBar from './TitleBar.vue'

const route = useRoute()
const router = useRouter()
const terminals = useTerminalsStore()
const browsers = useBrowsersStore()
const ui = useUiStore()
const onTerminals = computed(() => route.name === 'terminals')
/** On another page the terminals stay drawn, unseen, while Claude drives a browser (see TerminalWorkspace). */
const drawnUnseen = computed(() => !onTerminals.value && browsers.anyActive)

const main = ref<HTMLElement | null>(null)
const { left: mainLeft } = useElementBounding(main)

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

// Programs in the terminals hear when the theme turns dark or light (Claude Code's "Auto" theme).
const { dark: terminalDark } = useTerminalAppearance()
watch(terminalDark, (dark) => window.api.terminals.colorScheme(dark), { immediate: true })

// Terminals opened through the local API with `activate: true`, `cm` or a click on a notification.
const offActivate = window.api.terminals.onActivate((id) => {
  terminals.activate(id)
  if (route.name !== 'terminals') void router.push({ name: 'terminals' })
})
onBeforeUnmount(offActivate)

// A session at a limit went on with another account by itself (setting `claude.autoSwitch`).
const accountSwitch = useAccountSwitch()
const offAutoSwitch = window.api.terminals.onAutoSwitch((event) => accountSwitch.announceAutoSwitch(event))
onBeforeUnmount(offAutoSwitch)

// A click on the warning about a limit.
const offUsageShow = window.api.usage.onShow(() => void router.push({ name: 'dashboard' }))
onBeforeUnmount(offUsageShow)
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
          :aria-hidden="drawnUnseen || undefined"
          :visible="onTerminals"
        />
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
