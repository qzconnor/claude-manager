<script setup lang="ts">
import {
  CircleArrowDownIcon,
  GaugeIcon,
  HistoryIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UsersIcon,
} from '@lucide/vue'
import { computed, type Component } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useUpdatesStore } from '@/stores/updates'

interface NavItem {
  name: string
  label: string
  icon: Component
}

const primary: NavItem[] = [
  { name: 'terminals', label: 'Terminals', icon: SquareTerminalIcon },
  { name: 'sessions', label: 'Sessions', icon: HistoryIcon },
  { name: 'dashboard', label: 'Usage-Dashboard', icon: GaugeIcon },
  { name: 'accounts', label: 'Accounts', icon: UsersIcon },
]
const secondary: NavItem[] = [{ name: 'settings', label: 'Einstellungen (Strg+,)', icon: SettingsIcon }]

const terminals = useTerminalsStore()
const ui = useUiStore()
const updates = useUpdatesStore()

/** A waiting update pulses, release notes still unread after an update get a dot. */
const updatesLabel = computed(() =>
  updates.hasUpdate
    ? `Version ${updates.state.next} ist verfügbar`
    : updates.unseen
      ? `Neu in Version ${updates.state.current}`
      : 'Updates und Versionshinweise',
)
</script>

<template>
  <nav class="flex w-13 shrink-0 flex-col items-center justify-between pt-1 pb-3" aria-label="Hauptnavigation">
    <div class="flex flex-col items-center gap-1">
      <RouterLink
        v-for="item in primary"
        :key="item.name"
        v-slot="{ href, navigate, isActive }"
        :to="{ name: item.name }"
        custom
      >
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              as="a"
              :href="href"
              :variant="isActive ? 'secondary' : 'ghost'"
              size="icon-lg"
              class="relative"
              :aria-label="item.label"
              :aria-current="isActive ? 'page' : undefined"
              @click="navigate"
            >
              <component :is="item.icon" class="size-5" />
              <Badge
                v-if="item.name === 'terminals' && terminals.runningCount > 0"
                class="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] tabular-nums"
              >
                {{ terminals.runningCount }}
              </Badge>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{{ item.label }}</TooltipContent>
        </Tooltip>
      </RouterLink>
    </div>

    <div class="flex flex-col items-center gap-1">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-lg" aria-label="Befehlspalette" @click="ui.paletteOpen = true">
            <SearchIcon class="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">Befehlspalette (Strg+Umschalt+P)</TooltipContent>
      </Tooltip>
      <RouterLink v-slot="{ href, navigate, isActive }" :to="{ name: 'updates' }" custom>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              as="a"
              :href="href"
              :variant="isActive ? 'secondary' : 'ghost'"
              size="icon-lg"
              class="relative"
              :aria-label="updatesLabel"
              :aria-current="isActive ? 'page' : undefined"
              @click="navigate"
            >
              <CircleArrowDownIcon v-if="updates.hasUpdate" class="size-5 text-success" />
              <SparklesIcon v-else class="size-5" />
              <span v-if="updates.hasUpdate" class="absolute top-1 right-1 flex size-2">
                <span class="absolute size-full animate-ping rounded-full bg-success opacity-75" />
                <span class="relative size-2 rounded-full bg-success" />
              </span>
              <span v-else-if="updates.unseen" class="absolute top-1 right-1 size-2 rounded-full bg-success" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{{ updatesLabel }}</TooltipContent>
        </Tooltip>
      </RouterLink>
      <RouterLink
        v-for="item in secondary"
        :key="item.name"
        v-slot="{ href, navigate, isActive }"
        :to="{ name: item.name }"
        custom
      >
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              as="a"
              :href="href"
              :variant="isActive ? 'secondary' : 'ghost'"
              size="icon-lg"
              :aria-label="item.label"
              :aria-current="isActive ? 'page' : undefined"
              @click="navigate"
            >
              <component :is="item.icon" class="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{{ item.label }}</TooltipContent>
        </Tooltip>
      </RouterLink>
    </div>
  </nav>
</template>
