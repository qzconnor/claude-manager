<script setup lang="ts">
import { GaugeIcon, HistoryIcon, SettingsIcon, SquareTerminalIcon, UsersIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import type { ThemeContent } from '@shared/themes/types'
import { useSettingsStore } from '@/stores/settings'
import { themeTokens } from '@/themes/apply'

/**
 * A small window of the app in the colors of `theme`: its design tokens are set on the preview,
 * so everything in it is colored like the app would be (opaque, as without window material).
 */
const props = defineProps<{ theme: ThemeContent }>()
const settings = useSettingsStore()

const tokens = computed(() => themeTokens(props.theme, settings.settings.appearance, false))
const t = computed(() => props.theme.terminal)
const tint = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`

const normal = computed(() => [t.value.black, t.value.red, t.value.green, t.value.yellow, t.value.blue, t.value.magenta, t.value.cyan, t.value.white])
const bright = computed(() => [
  t.value.brightBlack,
  t.value.brightRed,
  t.value.brightGreen,
  t.value.brightYellow,
  t.value.brightBlue,
  t.value.brightMagenta,
  t.value.brightCyan,
  t.value.brightWhite,
])

/** Claude Code's own orange, the same in every theme. */
const CLAUDE = '#d97757'
const NAV = [SquareTerminalIcon, HistoryIcon, GaugeIcon, UsersIcon]
</script>

<template>
  <div class="flex flex-col gap-3 text-foreground" :style="tokens" :data-preview-mode="theme.mode">
    <!-- The app: title bar with tabs, navigation, a card of the settings and a menu. -->
    <div class="overflow-hidden rounded-lg border text-xs shadow-sm" style="background: var(--background)">
      <div class="flex h-8 items-center gap-1 border-b px-2" style="background: var(--sidebar)">
        <span class="mr-1 size-3 shrink-0 rounded-full bg-primary" />
        <div class="flex h-6 items-center gap-1.5 rounded-md bg-surface-strong px-2">
          <span class="size-1.5 rounded-full bg-success" />
          claude-manager
          <XIcon class="size-3 text-muted-foreground" />
        </div>
        <div class="flex h-6 items-center gap-1.5 px-2 text-muted-foreground">
          <span class="size-1.5 rounded-full bg-warning" />
          website
        </div>
        <div class="flex h-6 min-w-0 items-center gap-1.5 px-2 text-muted-foreground">
          <span class="size-1.5 shrink-0 rounded-full bg-primary" />
          <span class="truncate">api</span>
        </div>
        <svg class="ml-auto size-4 shrink-0 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" fill="none" class="stroke-muted" stroke-width="3" />
          <circle cx="10" cy="10" r="7" fill="none" class="stroke-usage-medium" stroke-width="3" stroke-dasharray="30 44" stroke-linecap="round" />
        </svg>
      </div>

      <div class="flex h-60">
        <div class="flex w-9 shrink-0 flex-col items-center gap-1 border-r py-2" style="background: var(--sidebar)">
          <span
            v-for="(icon, i) in NAV"
            :key="i"
            :class="['flex size-7 items-center justify-center rounded-md', i === 0 ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground']"
          >
            <component :is="icon" class="size-4" />
          </span>
          <span class="mt-auto flex size-7 items-center justify-center text-muted-foreground"><SettingsIcon class="size-4" /></span>
        </div>

        <div class="relative min-w-0 flex-1 p-2.5">
          <div class="rounded-lg border bg-card p-3 text-card-foreground">
            <div class="text-[13px] font-medium">Darstellung</div>
            <div class="text-[11px] text-muted-foreground">Farben für App und Terminal.</div>
            <div class="mt-2.5 flex items-center gap-2">
              <div class="flex h-7 min-w-0 flex-1 items-center rounded-md border border-input px-2 text-muted-foreground ring-3 ring-ring/50">
                Suchen…
              </div>
              <span class="flex h-[18px] w-8 shrink-0 items-center rounded-full bg-primary p-0.5">
                <span class="ml-auto size-3.5 rounded-full" style="background: var(--background)" />
              </span>
              <span class="flex h-[18px] w-8 shrink-0 items-center rounded-full bg-input p-0.5">
                <span class="size-3.5 rounded-full" style="background: var(--background)" />
              </span>
            </div>
            <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span class="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground">Speichern</span>
              <span class="rounded-md border bg-background px-2.5 py-1">Abbrechen</span>
              <span class="rounded-md bg-destructive/15 px-2.5 py-1 text-destructive">Löschen</span>
            </div>
            <!-- Narrower than the card: the menu below covers its right end. -->
            <div class="mt-3 grid w-[55%] grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-[11px] text-muted-foreground">
              <span>5 Std.</span>
              <span class="h-1.5 overflow-hidden rounded-full bg-muted"><span class="block h-full w-[35%] rounded-full bg-usage-low" /></span>
              <span>Woche</span>
              <span class="h-1.5 overflow-hidden rounded-full bg-muted"><span class="block h-full w-[68%] rounded-full bg-usage-medium" /></span>
              <span>Opus</span>
              <span class="h-1.5 overflow-hidden rounded-full bg-muted"><span class="block h-full w-[91%] rounded-full bg-usage-high" /></span>
            </div>
          </div>

          <div class="absolute right-2.5 bottom-2.5 w-32 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <div class="rounded-md px-2 py-1">Umbenennen</div>
            <div class="rounded-md bg-accent px-2 py-1 text-accent-foreground">Teilen</div>
            <div class="rounded-md px-2 py-1 text-destructive">Schließen</div>
          </div>
        </div>
      </div>
    </div>

    <!-- The terminal: Claude Code's output with its exchanged backgrounds, a shell prompt, the 16 colors. -->
    <div
      class="overflow-hidden rounded-lg border p-2.5 font-mono text-[11px] leading-normal whitespace-pre"
      :style="{ background: t.background, color: t.foreground }"
    >
      <div><b :style="{ color: CLAUDE }">✻</b> <b>Welcome to Claude Code!</b></div>
      <div class="opacity-60">  /help for help, /status for your setup</div>
      <div class="-mx-2.5 my-1 px-2.5" :style="{ background: tint(t.foreground, 7) }"><span :style="{ color: t.brightBlack }">❯</span> Refactor the session list</div>
      <div><span :style="{ color: t.green }">●</span> <b>Read</b>(src/views/SessionsView.vue)</div>
      <div>  ⎿  Read <b>142</b> lines</div>
      <div><span :style="{ color: t.yellow }">●</span> <b>Update</b>(src/lib/format.ts)</div>
      <div class="-mx-2.5 px-2.5" :style="{ background: tint(t.red, 15) }">  <span :style="{ color: t.red }">-</span> const old = <span :style="{ background: tint(t.red, 30) }">'legacy'</span></div>
      <div class="-mx-2.5 px-2.5" :style="{ background: tint(t.green, 15) }">  <span :style="{ color: t.green }">+</span> export function <span :style="{ background: tint(t.green, 30) }">formatTokens</span>(n)</div>
      <div class="mt-1"><span :style="{ color: t.blue }">~/projekte/app</span> <span :style="{ color: t.magenta }">main</span> <span :style="{ color: t.cyan }">✓</span> <span :style="{ background: t.selectionBackground }">npm run</span> tes<span :style="{ background: t.cursor, color: t.cursorAccent }">t</span></div>
      <div class="mt-1.5 flex gap-0.5">
        <span v-for="(color, i) in normal" :key="i" class="h-3 flex-1 rounded-[2px]" :style="{ background: color }" />
      </div>
      <div class="mt-0.5 flex gap-0.5">
        <span v-for="(color, i) in bright" :key="i" class="h-3 flex-1 rounded-[2px]" :style="{ background: color }" />
      </div>
    </div>
  </div>
</template>
