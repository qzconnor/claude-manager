<script setup lang="ts">
import { BellIcon, BellOffIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { attempt } from '@/lib/errors'
import { useSettingsStore } from '@/stores/settings'

/** Notifications on and off with one click; the details are in the settings. */
const settings = useSettingsStore()
const on = computed(() => settings.settings.notifications.enabled)
const label = computed(() =>
  on.value ? 'Benachrichtigungen an · Klick schaltet sie aus' : 'Benachrichtigungen aus · Klick schaltet sie ein',
)

function toggle() {
  void attempt(
    () => settings.update({ notifications: { enabled: !on.value } }),
    'Benachrichtigungen konnten nicht umgeschaltet werden',
  )
}
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        :aria-label="label"
        :aria-pressed="on"
        class="app-no-drag flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        @click="toggle"
      >
        <BellIcon v-if="on" class="size-4" />
        <BellOffIcon v-else class="size-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>
