<script setup lang="ts">
import { GaugeIcon, HistoryIcon, SearchIcon, SettingsIcon, SquareTerminalIcon, UsersIcon } from '@lucide/vue'
import type { Component } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'

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
